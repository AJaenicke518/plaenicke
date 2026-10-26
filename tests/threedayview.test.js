// The 3-day view (option A, Alex 2026-10-26): three columns of Day's hour
// grid, an "All day" strip above, a heading per day that opens Day.
process.env.TZ = 'America/Los_Angeles';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, findAll, allText } from './fake-dom.js';
import { renderThreeDayView } from '../js/threedayview.js';

// The shared fake, plus a scrollTop that RECORDS THE TREE STATE when it is
// assigned (as tests/dayview.test.js does): in a browser, assigning scrollTop
// to an element not yet in the document is a silent no-op, and the grid would
// open at midnight instead of 07:00.
class ScrollElement extends FakeElement {
  constructor(tag) { super(tag); this._scrollTop = 0; this.scrollWrites = []; }

  get scrollTop() { return this._scrollTop; }

  set scrollTop(v) {
    let root = this;
    while (root.parentNode) root = root.parentNode;
    this.scrollWrites.push({ value: v, inDocument: root === host, after: [...(this.parentNode?.children ?? [])] });
    this._scrollTop = v;
  }
}

// `host` stands in for the document: the container is appended under it, so
// "in the document" means "reachable from host".
let host;
globalThis.document = { createElement: (tag) => new ScrollElement(tag) };
function container() {
  host = new ScrollElement('body');
  const c = new ScrollElement('div');
  host.appendChild(c);
  return c;
}

const START = '2026-10-26'; // a Monday
const TODAY = '2026-10-26';
const own = (id, date, time, endTime = null, o = {}) => ({
  id, title: `t-${id}`, date, time, endTime, type: 'event', createdAt: '2026-10-01', ...o,
});
const byDate = (items) => {
  const m = {};
  for (const it of items) (m[it.date] ||= []).push(it);
  return m;
};
const noop = { onOpen() {}, onSelectDay() {} };
const byClass = (root, cls) => {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (c._classes.has(cls)) out.push(c); walk(c); } };
  walk(root);
  return out;
};
const one = (root, cls) => {
  const found = byClass(root, cls);
  assert.equal(found.length, 1, `fixture check: exactly one .${cls}`);
  return found[0];
};
const openButtons = (root) => findAll(root, 'BUTTON').filter((b) => b._classes.has('item-open'));

test('renderThreeDayView refuses to render without onOpen or onSelectDay', () => {
  assert.throws(() => renderThreeDayView(container(), START, {}, TODAY, { onSelectDay() {} }), /onOpen/);
  assert.throws(() => renderThreeDayView(container(), START, {}, TODAY, { onOpen() {} }), /onSelectDay/);
});

test('three headings, from the start day: weekday over the day number, named for Day view', () => {
  const c = container();
  renderThreeDayView(c, START, {}, TODAY, noop);
  const heads = byClass(c, 'tday-head');
  assert.equal(heads.length, 3);
  assert.deepEqual(heads.map((h) => allText(h).trim().split(/\s+/)), [['Mon', '26'], ['Tue', '27'], ['Wed', '28']]);
  assert.deepEqual(heads.map((h) => h.getAttribute('aria-label')),
    ['Open Mon, Oct 26 in Day view', 'Open Tue, Oct 27 in Day view', 'Open Wed, Oct 28 in Day view']);
  for (const h of heads) {
    assert.equal(h.tagName, 'BUTTON');
    assert.equal(h.type, 'button');
  }
});

test('only today\'s heading is marked today', () => {
  const c = container();
  renderThreeDayView(c, '2026-10-25', {}, TODAY, noop);
  assert.deepEqual(byClass(c, 'tday-head').map((h) => h._classes.has('today')), [false, true, false]);
  const c2 = container();
  renderThreeDayView(c2, '2026-10-29', {}, TODAY, noop);
  assert.deepEqual(byClass(c2, 'tday-head').map((h) => h._classes.has('today')), [false, false, false]);
});

test('the window crosses a month end', () => {
  const c = container();
  renderThreeDayView(c, '2026-10-31', {}, TODAY, noop);
  assert.deepEqual(byClass(c, 'tday-head').map((h) => h.getAttribute('aria-label')),
    ['Open Sat, Oct 31 in Day view', 'Open Sun, Nov 1 in Day view', 'Open Mon, Nov 2 in Day view']);
});

test('tapping a heading reports that day', () => {
  const c = container();
  const picked = [];
  renderThreeDayView(c, START, {}, TODAY, { onOpen() {}, onSelectDay: (d) => picked.push(d) });
  byClass(c, 'tday-head')[2].click();
  byClass(c, 'tday-head')[0].click();
  assert.deepEqual(picked, ['2026-10-28', '2026-10-26']);
});

test('a timed item is a block in its own day\'s column, placed by its minutes at 48px an hour', () => {
  const c = container();
  const a = own('a', '2026-10-27', '09:55', '11:35');
  renderThreeDayView(c, START, byDate([a]), TODAY, noop);
  const cols = byClass(c, 'tday-col');
  assert.equal(cols.length, 3);
  assert.deepEqual(cols.map((col) => byClass(col, 'tday-block').length), [0, 1, 0]);
  const block = one(cols[1], 'tday-block');
  assert.ok(block._classes.has('day-block'), 'a block with an end time draws like Day\'s .day-block');
  assert.ok(block._classes.has('type-event'));
  assert.equal(block.style.top, `${(9 * 60 + 55) / 60 * 48}px`);
  assert.equal(block.style.height, `${100 / 60 * 48 - 2}px`);
  assert.equal(block.style.left, '0%');
  assert.equal(block.style.width, 'calc(100% - 2px)');
});

test('a block shows its start time without AM/PM over its title, and its name carries the full time', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('a', START, '13:45', '15:25'), own('p', START, '17:00')]), TODAY, noop);
  const [ranged, pinned] = openButtons(one(c, 'tday-grid'));
  assert.deepEqual(ranged.children.map((s) => [s.className, s.textContent]),
    [['tday-time', '1:45'], ['tday-title', 't-a']]);
  assert.equal(ranged.getAttribute('aria-label'), '1:45–3:25 PM t-a');
  assert.deepEqual(pinned.children.map((s) => s.textContent), ['5:00', 't-p']);
  assert.equal(pinned.getAttribute('aria-label'), '5:00 PM t-p');
});

test('an item with no end time is a pin, 30 minutes tall', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('p', START, '17:00')]), TODAY, noop);
  const pin = one(c, 'tday-block');
  assert.ok(pin._classes.has('day-pin'));
  assert.ok(!pin._classes.has('day-block'));
  assert.equal(pin.style.height, `${0.5 * 48 - 2}px`);
});

test('two items at the same time share their column half and half', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('a', START, '09:25', '10:15'), own('b', START, '09:25', '09:45')]), TODAY, noop);
  const blocks = byClass(c, 'tday-block');
  assert.deepEqual(blocks.map((b) => [b.style.left, b.style.width]).sort(),
    [['0%', 'calc(50% - 2px)'], ['50%', 'calc(50% - 2px)']]);
});

test('a feed block takes its calendar\'s colour', () => {
  const c = container();
  const ext = { ...own('x', START, '10:50', '12:05'), external: true, feedId: 'f', feedColor: 'var(--feed-palette-2)' };
  renderThreeDayView(c, START, byDate([ext]), TODAY, noop);
  const block = one(c, 'tday-block');
  assert.ok(block._classes.has('type-external'));
  assert.equal(block.style['--feed-color'], 'var(--feed-palette-2)');
});

test('a done to-do keeps its type and is marked done', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('d', START, '08:00', null, { type: 'task', done: true })]), TODAY, noop);
  const block = one(c, 'tday-block');
  assert.ok(block._classes.has('type-task'));
  assert.ok(block._classes.has('done'));
});

test('tapping a block opens THAT item; blocks carry their item id and no delete control', () => {
  const c = container();
  const opened = [];
  // Two in one column, so "the first item of the column" is a wrong answer.
  const a = own('a', START, '09:00', '10:00');
  const b = own('b', START, '13:00', '14:00');
  const z = own('z', '2026-10-28', '13:00', '14:00');
  renderThreeDayView(c, START, byDate([a, b, z]), TODAY, { onOpen: (it) => opened.push(it), onSelectDay() {} });
  const buttons = openButtons(one(c, 'tday-grid'));
  assert.deepEqual(buttons.map((x) => x.getAttribute('data-item-id')), ['a', 'b', 'z']);
  buttons[1].click();
  buttons[2].click();
  assert.deepEqual(opened, [b, z]);
  for (const block of byClass(c, 'tday-block')) {
    assert.deepEqual(block.children.map((x) => x.className), ['item-open'], 'the open button is the block\'s only child');
  }
  assert.equal(byClass(c, 'day-del').length, 0);
});

test('untimed items sit in the All-day strip, in their own day\'s cell, and open their sheet', () => {
  const c = container();
  const opened = [];
  const reg = own('r', '2026-10-27', null, null, { type: 'task' });
  renderThreeDayView(c, START, byDate([reg, own('t', '2026-10-27', '09:00', '10:00')]), TODAY,
    { onOpen: (it) => opened.push(it), onSelectDay() {} });
  const strip = one(c, 'tday-allday');
  assert.match(allText(strip), /All day/);
  const cells = byClass(strip, 'tday-cell');
  assert.equal(cells.length, 3);
  assert.deepEqual(cells.map((cell) => allText(cell).trim()), ['', 't-r', '']);
  const chip = openButtons(cells[1])[0];
  assert.ok(chip._classes.has('tday-chip'));
  assert.ok(chip._classes.has('type-task'));
  assert.equal(chip.getAttribute('data-item-id'), 'r');
  chip.click();
  assert.deepEqual(opened, [reg]);
  assert.equal(byClass(one(c, 'tday-grid'), 'tday-chip').length, 0, 'the untimed item is not also in the grid');
});

test('with nothing untimed in the three days, there is no All-day strip', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('t', START, '09:00', '10:00'), own('later', '2026-10-29', null)]), TODAY, noop);
  assert.equal(byClass(c, 'tday-allday').length, 0);
  assert.deepEqual(c.children.map((x) => x.className), ['tday-heads', 'tday-grid']);
});

test('items outside the three days are not drawn', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('before', '2026-10-25', '09:00'), own('after', '2026-10-29', '09:00')]), TODAY, noop);
  assert.equal(openButtons(c).length, 0);
});

test('the grid has 24 hour labels and an hour line per hour in each column', () => {
  const c = container();
  renderThreeDayView(c, START, {}, TODAY, noop);
  const hours = one(c, 'tday-hours');
  assert.equal(hours.children.length, 24);
  assert.equal(hours.children[0].textContent, '12 AM');
  assert.equal(hours.children[13].textContent, '1 PM');
  for (const col of byClass(c, 'tday-col')) {
    assert.equal(col.style.height, `${24 * 48}px`);
    assert.equal(byClass(col, 'hour-line').length, 24);
  }
});

test('order: headings, the All-day strip, then the grid', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('u', START, null)]), TODAY, noop);
  assert.deepEqual(c.children.map((x) => x.className), ['tday-heads', 'tday-allday', 'tday-grid']);
});

test('the grid scrolls to 7 AM, written once, after the grid is in the document and last of all', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('u', START, null)]), TODAY, noop);
  const grid = one(c, 'tday-grid');
  assert.equal(grid.scrollWrites.length, 1);
  const [w] = grid.scrollWrites;
  assert.equal(w.value, 7 * 48);
  assert.equal(w.inDocument, true, 'a scrollTop written to a detached grid is a silent no-op in a browser');
  assert.deepEqual(w.after.map((x) => x.className), ['tday-heads', 'tday-allday', 'tday-grid'],
    'every part is in place when the scroll is written');
});

test('a re-render with autoScroll off keeps the grid where the user scrolled it', () => {
  const c = container();
  renderThreeDayView(c, START, {}, TODAY, noop);
  one(c, 'tday-grid').scrollTop = 333;
  renderThreeDayView(c, START, {}, TODAY, { ...noop, autoScroll: false });
  const grid = one(c, 'tday-grid');
  assert.deepEqual(grid.scrollWrites.map((w) => w.value), [333]);
});

test('a re-render replaces the previous drawing', () => {
  const c = container();
  renderThreeDayView(c, START, byDate([own('a', START, '09:00')]), TODAY, noop);
  renderThreeDayView(c, START, {}, TODAY, noop);
  assert.equal(openButtons(c).length, 0);
  assert.equal(byClass(c, 'tday-grid').length, 1);
});
