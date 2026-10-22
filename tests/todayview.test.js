import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument, allText, findAll, fire } from './fake-dom.js';
import { buildToday } from '../js/today.js';
import { renderTodayView } from '../js/todayview.js';

// todayview.js draws buildToday's result. Presentation only: the checkbox
// reports up through onToggleDone and the title through onOpen; app.js
// writes. The shared fake DOM is enough: nothing here looks anything up by id.
globalThis.document = makeFakeDocument();

const TODAY = '2026-10-21';
const at = (hh, mm) => hh * 60 + mm;
const own = (id, o = {}) => ({
  id, title: `t-${id}`, date: TODAY, time: null, endTime: null, type: 'task',
  createdAt: '2026-10-01', updatedAt: '2026-10-01T00:00:00.000Z',
  project: null, subject: null, category: null, done: false, notes: null, ...o,
});
const inst = (uid, date, o = {}) => {
  const time = o.time || null;
  return {
    id: `feedR:${uid}:${date}:${time}`, uid, title: `i-${uid}`, date, time, endTime: null,
    createdAt: `${date}T${time || '00:00'}`, feedId: 'feedR', feedColor: 'var(--feed-palette-2)', external: true,
    recurring: false, guessedSeries: false, spanKey: `feedR:${uid}`, ...o,
  };
};

function draw(items, instances = [], now = at(9, 18), handlers = {}) {
  const host = document.createElement('div');
  const calls = { open: [], toggle: [] };
  const out = renderTodayView(host, buildToday(items, instances, TODAY, now, () => []), {
    onOpen: (it) => calls.open.push(it.id),
    onToggleDone: (id, done) => calls.toggle.push([id, done]),
    ...handlers,
  });
  return { host, calls, out };
}
const byClass = (root, cls) => {
  const found = [];
  const walk = (n) => { for (const c of n.children) { if (c._classes.has(cls)) found.push(c); walk(c); } };
  walk(root);
  return found;
};
const rowOf = (host, title) => byClass(host, 'today-row').find((li) => allText(li).includes(title));

const DAY = [
  own('late', { type: 'due', date: '2026-10-18', title: 'Essay' }),
  own('start', { type: 'start', date: '2026-10-20', title: 'Start reading' }),
  own('bank', { type: 'task', time: '09:00', title: 'Call bank' }),
  own('ticked', { type: 'task', title: 'Water plants', done: true }),
  own('dinner', { type: 'event', date: '2026-10-23', time: '19:00', title: 'Dinner' }),
];
const DAY_FEED = [
  inst('gym', TODAY, { time: '08:00', endTime: '09:00', title: 'Gym' }),
  inst('lec', TODAY, { time: '10:00', endTime: '11:15', title: 'PHYS 2100', recurring: true }),
  inst('lab', TODAY, { time: '14:00', endTime: '16:50', title: 'Physics lab', recurring: true, guessedSeries: true }),
  inst('fair', TODAY, { title: 'Career fair' }),
  inst('club', '2026-10-22', { time: '08:00', title: 'Club meeting' }),
];

test('Today: the four sections in order, each under its label; an empty one is not drawn', () => {
  const { host } = draw(DAY, DAY_FEED);
  const sections = byClass(host, 'today-section');
  assert.deepEqual(sections.map((s) => byClass(s, 'today-label')[0].textContent),
    ['Overdue', 'To do today', "Today's events", 'Next 7 days']);
  assert.deepEqual(byClass(sections[3], 'today-day').map((h) => h.textContent), ['Tomorrow', 'Fri']);
  const { host: light } = draw([own('only', { type: 'task' })]);
  assert.deepEqual(byClass(light, 'today-label').map((h) => h.textContent), ['To do today']);
  assert.equal(byClass(light, 'today-empty').length, 0, 'no empty line when something is due');
});

test('Today: the empty line is drawn first, and only when buildToday gives one', () => {
  const { host } = draw([own('fri', { type: 'event', date: '2026-10-23', title: 'Stats quiz' })]);
  assert.equal(host.children[0]._classes.has('today-empty'), true);
  assert.equal(host.children[0].textContent, 'Nothing due today. Next: Stats quiz · Fri.');
  assert.deepEqual(byClass(host, 'today-label').map((h) => h.textContent), ['Next 7 days']);
});

test('Today: each title is a button that opens its item and carries its id', () => {
  const { host, calls } = draw(DAY, DAY_FEED);
  const openers = byClass(host, 'today-open');
  assert.equal(openers.length, 10, 'fixture check: one per row');
  for (const b of openers) {
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.type, 'button');
    assert.ok(b._classes.has('item-open'), 'focusOpener finds it by .item-open');
  }
  const essay = byClass(rowOf(host, 'Essay'), 'today-open')[0];
  assert.equal(essay.getAttribute('data-item-id'), 'late');
  fire(essay, 'click');
  assert.deepEqual(calls.open, ['late']);
});

// The punchlist's carry-over (1): press.js presses the nearest
// `button, [data-press]` above the touch. A checkbox inside a pressable row
// would press the whole row on a tick. So the pressable part is the open
// button, and the checkbox is its sibling, outside it.
test('Today: the open button is the pressable part; nothing above a checkbox is, so a tick never presses the row', () => {
  const { host } = draw(DAY, DAY_FEED);
  for (const b of byClass(host, 'today-open')) assert.notEqual(b.getAttribute('data-press'), null);
  const boxes = findAll(host, 'INPUT');
  assert.equal(boxes.length, 4, 'fixture check: Overdue and To do today rows have one each');
  for (const box of boxes) {
    for (let n = box; n && n !== host; n = n.parentNode) {
      assert.equal(n.getAttribute('data-press'), null, `${n.tagName}.${n.className} is pressable above a checkbox`);
      assert.notEqual(n.tagName, 'BUTTON', 'a checkbox inside a button presses the button');
    }
  }
});

test('Today: a tick reports what the box now holds', () => {
  const { host, calls } = draw(DAY, DAY_FEED);
  const bank = findAll(rowOf(host, 'Call bank'), 'INPUT')[0];
  assert.equal(bank.type, 'checkbox');
  assert.equal(bank.getAttribute('aria-label'), 'Mark "Call bank" done');
  bank.checked = true;
  fire(bank, 'change');
  const ticked = findAll(rowOf(host, 'Water plants'), 'INPUT')[0];
  assert.equal(ticked.checked, true, 'a ticked to-do shows ticked');
  ticked.checked = false;
  fire(ticked, 'change');
  // Final review A11d: twice with no re-render, so the box ends equal to
  // item.done — a report derived from item.done instead of the box would
  // repeat itself here.
  bank.checked = false;
  fire(bank, 'change');
  assert.deepEqual(calls.toggle, [['bank', true], ['ticked', false], ['bank', false]]);
});

// Final review A10: the label says what a tap will do.
test('Today: a ticked box is labelled "not done", an unticked one "done"', () => {
  const { host } = draw(DAY, DAY_FEED);
  assert.equal(findAll(rowOf(host, 'Water plants'), 'INPUT')[0].getAttribute('aria-label'), 'Mark "Water plants" not done');
  assert.equal(findAll(rowOf(host, 'Call bank'), 'INPUT')[0].getAttribute('aria-label'), 'Mark "Call bank" done');
});

// Final review A8: a 20px box alone is a small target, and a near miss landed
// on the open button. Each box sits in a <label class="today-tick">, sized in
// styles.css to 44x44: the label is the box's hit area. It is a child of the
// row, beside the open button — not pressable, not inside the button.
test('Today: each checkbox is wrapped in its own today-tick label, a sibling of the open button', () => {
  const { host } = draw(DAY, DAY_FEED);
  const boxes = findAll(host, 'INPUT');
  assert.equal(boxes.length, 4, 'fixture check');
  for (const box of boxes) {
    const label = box.parentNode;
    assert.equal(label.tagName, 'LABEL');
    assert.ok(label._classes.has('today-tick'));
    assert.deepEqual(label.children, [box], 'the label holds the box only');
    assert.equal(label.getAttribute('data-press'), null);
    assert.ok(label.parentNode._classes.has('today-row'), 'a direct child of the row');
    assert.ok(label.parentNode.children.some((c) => c._classes.has('today-open')), 'beside the open button');
  }
});

// Final review A11e: a to-do due today at a time shows that time.
test('Today: a to-do due today shows its time', () => {
  const { host } = draw(DAY, DAY_FEED);
  assert.deepEqual(byClass(rowOf(host, 'Call bank'), 'today-time').map((n) => n.textContent), ['9:00 AM']);
});

test('Today: only Overdue and To do today rows have a checkbox', () => {
  const { host } = draw(DAY, DAY_FEED);
  const [overdue, todo, events, next] = byClass(host, 'today-section');
  assert.equal(findAll(overdue, 'INPUT').length, 2);
  assert.equal(findAll(todo, 'INPUT').length, 2);
  assert.equal(findAll(events, 'INPUT').length, 0);
  assert.equal(findAll(next, 'INPUT').length, 0);
});

test('Today: a ticked to-do keeps its row, marked done, so the tick can be undone until tomorrow', () => {
  const { host } = draw(DAY, DAY_FEED);
  const row = rowOf(host, 'Water plants');
  assert.ok(row._classes.has('done'));
  assert.ok(row._classes.has('type-task'));
});

test('Today: an overdue age is red for a deadline and orange for a start', () => {
  const { host } = draw(DAY, DAY_FEED);
  const essayAge = byClass(rowOf(host, 'Essay'), 'today-age')[0];
  assert.equal(essayAge.textContent, '3d');
  assert.ok(essayAge._classes.has('deadline'));
  const startAge = byClass(rowOf(host, 'Start reading'), 'today-age')[0];
  assert.equal(startAge.textContent, '1d');
  assert.ok(startAge._classes.has('start'));
});

test('Today: the next event\'s "in N" is one node, handed back for the 60 s tick', () => {
  const { host, out } = draw(DAY, DAY_FEED, at(9, 18));
  const rels = byClass(host, 'today-rel');
  assert.equal(rels.length, 1);
  assert.equal(rels[0].textContent, 'in 42 min');
  assert.ok(allText(rowOf(host, 'PHYS 2100')).includes('in 42 min'));
  assert.equal(out.relative.node, rels[0]);
  assert.equal(out.relative.item.uid, 'lec');
  const none = draw(DAY, DAY_FEED, at(23, 0));
  assert.equal(byClass(none.host, 'today-rel').length, 0);
  assert.equal(none.out.relative, null);
});

// Final review A2: an event over 12 h away has relative '' — its label is
// drawn, empty, and handed back, so the 60 s tick can fill it in later.
test('Today: an empty "in N" label is still drawn and handed back', () => {
  const { host, out } = draw([], [inst('talk', TODAY, { time: '20:30', endTime: '21:30', title: 'Talk' })], at(8, 0));
  const rels = byClass(host, 'today-rel');
  assert.equal(rels.length, 1);
  assert.equal(rels[0].textContent, '');
  assert.ok(rowOf(host, 'Talk').children.some((c) => c === rels[0] || byClass(c, 'today-rel').includes(rels[0])),
    'inside the Talk row');
  assert.equal(out.relative.node, rels[0]);
  assert.equal(out.relative.item.uid, 'talk');
});

test('Today: a finished event is greyed; one still to come is not', () => {
  const { host } = draw(DAY, DAY_FEED, at(9, 18));
  assert.ok(rowOf(host, 'Gym')._classes.has('past'));
  assert.ok(!rowOf(host, 'PHYS 2100')._classes.has('past'));
  assert.ok(!rowOf(host, 'Career fair')._classes.has('past'), 'an all-day event is never greyed');
});

test('Today: a guessed series says so; a rule series does not', () => {
  const { host } = draw(DAY, DAY_FEED);
  assert.deepEqual(byClass(rowOf(host, 'Physics lab'), 'today-guess').map((s) => s.textContent), ['Repeats weekly (guessed)']);
  assert.equal(byClass(rowOf(host, 'PHYS 2100'), 'today-guess').length, 0);
});

test('Today: an event shows its time or "All day"; a feed row takes its calendar\'s colour', () => {
  const { host } = draw(DAY, DAY_FEED);
  assert.equal(byClass(rowOf(host, 'PHYS 2100'), 'today-time')[0].textContent, '10:00–11:15 AM');
  assert.equal(byClass(rowOf(host, 'Career fair'), 'today-time')[0].textContent, 'All day');
  assert.equal(byClass(rowOf(host, 'Club meeting'), 'today-time')[0].textContent, '8:00 AM');
  const fair = rowOf(host, 'Career fair');
  assert.ok(fair._classes.has('type-external'));
  assert.equal(fair.style['--feed-color'], 'var(--feed-palette-2)');
});

test('Today: a re-render replaces the rows rather than adding to them', () => {
  const host = document.createElement('div');
  const handlers = { onOpen() {}, onToggleDone() {} };
  renderTodayView(host, buildToday(DAY, DAY_FEED, TODAY, at(9, 0), () => []), handlers);
  renderTodayView(host, buildToday(DAY, DAY_FEED, TODAY, at(9, 0), () => []), handlers);
  assert.equal(byClass(host, 'today-row').length, 10);
});

test('renderTodayView refuses to draw rows that would do nothing on tap', () => {
  const host = document.createElement('div');
  const model = buildToday(DAY, [], TODAY, at(9, 0), () => []);
  assert.throws(() => renderTodayView(host, model, { onToggleDone() {} }), /onOpen/);
  assert.throws(() => renderTodayView(host, model, { onOpen() {} }), /onToggleDone/);
});

test('Today: an overdue to-do ticked today keeps its row, drawn checked and marked done', () => {
  const { host } = draw([own('lateDone', {
    type: 'due', date: '2026-10-18', title: 'Old essay', done: true, updatedAt: `${TODAY}T08:00:00.000Z`,
  })]);
  const overdue = byClass(host, 'today-section')[0];
  assert.equal(byClass(overdue, 'today-label')[0].textContent, 'Overdue');
  const row = rowOf(overdue, 'Old essay');
  assert.ok(row._classes.has('done'));
  assert.equal(findAll(row, 'INPUT')[0].checked, true);
});
