import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument, allText, findAll } from './fake-dom.js';
import { buildWeekList, renderWeekList } from '../js/weeklist.js';

// Dates only, but weekday names come from Intl: pin Alex's zone like
// today.test.js. node --test runs each file in its own process.
process.env.TZ = 'America/Los_Angeles';

// The Week page's list under the grid (stage 3 Commit 3, Alex 2026-10-22:
// "a list of events coming up for that week in the open space below the
// week"; design B2). buildWeekList is pure; renderWeekList draws and never
// writes. The shared fake DOM is enough: nothing here looks anything up by id.
globalThis.document = makeFakeDocument();

// TODAY is Thursday 2026-10-22; its week starts Sunday 2026-10-18.
const TODAY = '2026-10-22';
const THIS_WEEK = '2026-10-18';
const own = (id, o = {}) => ({
  id, title: `t-${id}`, date: TODAY, time: null, endTime: null, type: 'event',
  createdAt: '2026-10-01', updatedAt: '2026-10-01T00:00:00.000Z',
  project: null, subject: null, category: null, done: false, notes: null, ...o,
});
const inst = (uid, date, o = {}) => {
  const time = o.time || null;
  return {
    id: `feedW:${uid}:${date}:${time}`, uid, title: `i-${uid}`, date, time, endTime: null,
    createdAt: `${date}T${time || '00:00'}`, feedId: 'feedW', feedColor: 'var(--feed-palette-2)', external: true,
    recurring: false, guessedSeries: false, spanKey: `feedW:${uid}`, ...o,
  };
};

// A fake instancesForRange: records the range it was asked for and returns
// the given instances inside it, as the real one does.
function rangeFeed(all) {
  const asked = [];
  const fn = (from, to) => { asked.push([from, to]); return all.filter((i) => i.date >= from && i.date <= to); };
  return { fn, asked };
}
const titlesOf = (list) => list.days.flatMap((d) => d.rows.map((r) => r.item.title));

// --- buildWeekList: the range, the heading and the filter -------------------

test('buildWeekList: the current week runs from today to Saturday, headed "Rest of this week"', () => {
  const feed = rangeFeed([]);
  const list = buildWeekList([
    own('wed', { date: '2026-10-21', title: 'Wed thing' }),
    own('thu', { date: '2026-10-22', title: 'Thu thing' }),
    own('sat', { date: '2026-10-24', title: 'Sat thing' }),
    own('sun', { date: '2026-10-25', title: 'Next Sun thing' }),
  ], feed.fn, THIS_WEEK, TODAY);
  assert.deepEqual(feed.asked, [['2026-10-22', '2026-10-24']], 'instances are asked for today .. Saturday, once');
  assert.equal(list.heading, 'Rest of this week');
  assert.deepEqual(titlesOf(list), ['Thu thing', 'Sat thing'], 'days before today and after Saturday are left out');
  assert.deepEqual(list.days.map((d) => d.date), ['2026-10-22', '2026-10-24']);
});

test('buildWeekList: on the week\'s Sunday the current week is all seven days', () => {
  const feed = rangeFeed([]);
  const list = buildWeekList([own('sun', { date: THIS_WEEK, title: 'Sun thing' })], feed.fn, THIS_WEEK, THIS_WEEK);
  assert.deepEqual(feed.asked, [[THIS_WEEK, '2026-10-24']]);
  assert.equal(list.heading, 'Rest of this week');
  assert.deepEqual(titlesOf(list), ['Sun thing']);
});

test('buildWeekList: a future week shows all seven days, headed "This week"', () => {
  const feed = rangeFeed([]);
  const list = buildWeekList([
    own('sun', { date: '2026-10-25', title: 'Sun' }), own('sat', { date: '2026-10-31', title: 'Sat' }),
    own('after', { date: '2026-11-01', title: 'After' }),
  ], feed.fn, '2026-10-25', TODAY);
  assert.deepEqual(feed.asked, [['2026-10-25', '2026-10-31']]);
  assert.equal(list.heading, 'This week');
  assert.deepEqual(titlesOf(list), ['Sun', 'Sat']);
});

test('buildWeekList: a past week shows all seven days as a plain record, headed "This week"', () => {
  const feed = rangeFeed([inst('quiz', '2026-10-16', { time: '09:00', title: 'Old quiz' })]);
  const list = buildWeekList([
    own('mon', { date: '2026-10-12', title: 'Old Mon' }), own('before', { date: '2026-10-10', title: 'Before' }),
  ], feed.fn, '2026-10-11', TODAY);
  assert.deepEqual(feed.asked, [['2026-10-11', '2026-10-17']]);
  assert.equal(list.heading, 'This week');
  assert.deepEqual(titlesOf(list), ['Old Mon', 'Old quiz']);
});

test('buildWeekList: weekly-repeating instances, done items and ideas are left out', () => {
  const feed = rangeFeed([
    inst('class', '2026-10-23', { time: '08:00', title: 'Weekly class', recurring: true }),
    inst('quiz', '2026-10-23', { time: '10:50', title: 'Friday quiz' }),
  ]);
  const list = buildWeekList([
    own('done', { date: '2026-10-23', type: 'task', done: true, title: 'Done task' }),
    own('idea', { date: '2026-10-23', type: 'idea', title: 'An idea' }),
    own('open', { date: '2026-10-23', type: 'due', title: 'Problem set' }),
  ], feed.fn, THIS_WEEK, TODAY);
  assert.deepEqual(titlesOf(list), ['Problem set', 'Friday quiz']);
});

// The Week list is its own page (controller ruling, 2026-10-22): it does not
// drop what Today also shows. A multi-day one-off covering today is listed
// once, on its first day in range — today.
test('buildWeekList: a multi-day event that covers today is listed once, on today', () => {
  const feed = rangeFeed(['2026-10-21', '2026-10-22', '2026-10-23'].map((d) => inst('trip', d, { title: 'Trip' })));
  const list = buildWeekList([], feed.fn, THIS_WEEK, TODAY);
  assert.deepEqual(list.days.map((d) => [d.date, d.rows.map((r) => r.item.title)]), [['2026-10-22', ['Trip']]]);
});

test('buildWeekList: an unreadable week start or today throws', () => {
  const feed = rangeFeed([]);
  assert.throws(() => buildWeekList([], feed.fn, '', TODAY), /^Error: buildWeekList requires weekStartISO$/);
  assert.throws(() => buildWeekList([], feed.fn, THIS_WEEK, undefined), /^Error: buildWeekList requires todayISO$/);
  assert.throws(() => buildWeekList([], null, THIS_WEEK, TODAY), /^Error: buildWeekList requires instancesFor$/);
});

// --- renderWeekList: B2 -----------------------------------------------------

function draw(list) {
  const host = document.createElement('section');
  const calls = { open: [], day: [] };
  renderWeekList(host, list, { onOpen: (it) => calls.open.push(it.id), onSelectDay: (d) => calls.day.push(d) });
  return { host, calls };
}
const byClass = (root, cls) => {
  const found = [];
  const walk = (n) => { for (const c of n.children) { if (c._classes.has(cls)) found.push(c); walk(c); } };
  walk(root);
  return found;
};
const FRI = [
  inst('phys', '2026-10-23', { time: '09:25', title: 'PHYS 2100 Reassessment' }),
  own('pset', { date: '2026-10-23', type: 'due', time: '17:00', title: 'CHEM 1210 Problem set 8' }),
  own('allday', { date: '2026-10-23', title: 'Fall break' }),
];
// Own items as items, the feed instance as an instance.
const fri = () => buildWeekList(FRI.slice(1), () => [FRI[0]], THIS_WEEK, TODAY);

test('renderWeekList: the heading, then each day as a narrow left column ("Fri" over "23") beside its rows', () => {
  const { host } = draw(fri());
  const heading = host.children[0];
  assert.equal(heading.tagName, 'H3');
  assert.ok(heading._classes.has('today-label'));
  assert.equal(heading.textContent, 'Rest of this week');
  const days = byClass(host, 'wlist-day');
  assert.equal(days.length, 1);
  const label = days[0].children[0];
  assert.equal(label.tagName, 'BUTTON');
  assert.equal(label.type, 'button');
  assert.ok(label._classes.has('wlist-label'));
  assert.equal(label.textContent, 'Fri');
  assert.equal(label.children[0].tagName, 'B');
  assert.equal(label.children[0].textContent, '23');
  assert.equal(label.getAttribute('aria-label'), 'Open Fri, Oct 23 in Day view');
  const ul = days[0].children[1];
  assert.equal(ul.tagName, 'UL');
  assert.ok(ul._classes.has('today-list'));
});

test('renderWeekList: each row begins with its time ("All day" when untimed), then the title', () => {
  const { host } = draw(fri());
  const rows = byClass(host, 'today-row');
  assert.deepEqual(rows.map((li) => {
    const open = li.children[0];
    return [open.children[0].textContent, open.children[1].textContent];
  }), [['All day', 'Fall break'], ['9:25 AM', 'PHYS 2100 Reassessment'], ['5:00 PM', 'CHEM 1210 Problem set 8']]);
  for (const li of rows) {
    const open = li.children[0];
    assert.ok(open.children[0]._classes.has('today-time'));
    assert.ok(open.children[0]._classes.has('wlist-time'));
    assert.ok(open.children[1]._classes.has('today-text'));
  }
});

test('renderWeekList: a feed row takes its feed colour; an own row its type class', () => {
  const { host } = draw(fri());
  const rows = byClass(host, 'today-row');
  const phys = rows.find((li) => allText(li).includes('PHYS'));
  assert.equal(phys.style['--feed-color'], 'var(--feed-palette-2)');
  const pset = rows.find((li) => allText(li).includes('CHEM'));
  assert.ok(pset._classes.has('type-due'));
  assert.equal(pset.style['--feed-color'], undefined);
});

test('renderWeekList: a row opens its item; a day label opens that day', () => {
  const { host, calls } = draw(fri());
  const open = byClass(host, 'today-row').find((li) => allText(li).includes('CHEM')).children[0];
  assert.equal(open.tagName, 'BUTTON');
  assert.ok(open._classes.has('item-open') && open._classes.has('today-open') && open._classes.has('wlist-open'));
  assert.equal(open.getAttribute('data-press'), '');
  assert.equal(open.getAttribute('data-item-id'), 'pset', 'how app.js\'s focusOpener finds it again');
  open.click();
  assert.deepEqual(calls.open, ['pset']);
  byClass(host, 'wlist-label')[0].click();
  assert.deepEqual(calls.day, ['2026-10-23']);
});

test('renderWeekList: with nothing to list, the heading and "Nothing else this week."', () => {
  const { host } = draw({ heading: 'This week', days: [] });
  assert.equal(host.children.length, 2);
  assert.equal(host.children[0].textContent, 'This week');
  assert.equal(host.children[1].tagName, 'P');
  assert.ok(host.children[1]._classes.has('today-empty'));
  assert.equal(host.children[1].textContent, 'Nothing else this week.');
});

test('renderWeekList: a re-render replaces what was drawn', () => {
  const host = document.createElement('section');
  const h = { onOpen() {}, onSelectDay() {} };
  renderWeekList(host, fri(), h);
  renderWeekList(host, { heading: 'This week', days: [] }, h);
  assert.equal(host.children.length, 2);
  assert.equal(findAll(host, 'LI').length, 0);
});

test('renderWeekList: onOpen and onSelectDay are required', () => {
  const host = document.createElement('section');
  const list = { heading: 'This week', days: [] };
  assert.throws(() => renderWeekList(host, list, { onSelectDay() {} }), /onOpen/);
  assert.throws(() => renderWeekList(host, list, { onOpen() {} }), /onSelectDay/);
});
