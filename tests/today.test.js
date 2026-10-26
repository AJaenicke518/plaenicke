import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionOf, daysBetween, dayWord, relativeLabel, isPastEvent, buildToday, upcomingRows, NEXT_DAYS, LOOKAHEAD_DAYS,
  tally,
} from '../js/today.js';
import { readFileSync } from 'node:fs';
import { parseICS } from '../js/ics.js';
import { instancesForRange, feedShape } from '../js/feeds.js';
import { addDays } from '../js/timegrid.js';

// The "ticked today" tests turn UTC instants into local days, and the
// daysBetween mutant needs a DST zone: pin Alex's zone instead of trusting the
// machine's. node --test runs each file in its own process, and Node re-reads
// TZ when it is assigned, so this reaches today.js's Date calls and no other
// test file.
process.env.TZ = 'America/Los_Angeles';

// today.js is pure: every input is passed in, so every boundary is a plain
// value here. TODAY is a Wednesday.
const TODAY = '2026-10-21';

const own = (id, o = {}) => ({
  id, title: `t-${id}`, date: TODAY, time: null, endTime: null, type: 'task',
  createdAt: '2026-10-01', updatedAt: '2026-10-01T00:00:00.000Z',
  project: null, subject: null, category: null, done: false, notes: null, ...o,
});

// --- sectionOf: each own item belongs to one section, or none ---------------

test('sectionOf: a to-do is overdue the day after its date, due today on it, and next within 7 days', () => {
  assert.equal(sectionOf(own('a', { date: '2026-10-20' }), TODAY), 'overdue');
  assert.equal(sectionOf(own('a', { date: TODAY }), TODAY), 'todo');
  assert.equal(sectionOf(own('a', { date: '2026-10-22' }), TODAY), 'next');
  assert.equal(sectionOf(own('a', { date: '2026-10-28' }), TODAY), 'next', 'today + 7 is still in Next 7 days');
  assert.equal(sectionOf(own('a', { date: '2026-10-29' }), TODAY), null, 'today + 8 is not');
  assert.equal(NEXT_DAYS, 7);
});

test('sectionOf: every to-do type past its date is overdue — start included; nothing else is', () => {
  for (const type of ['due', 'milestone', 'task', 'start']) {
    assert.equal(sectionOf(own('a', { type, date: '2026-10-19' }), TODAY), 'overdue', type);
  }
  for (const type of ['event', 'general', 'idea']) {
    assert.equal(sectionOf(own('a', { type, date: '2026-10-19' }), TODAY), null, `${type}: past events are never overdue`);
  }
  assert.equal(sectionOf(own('a', { type: 'due', date: '2026-10-19', done: true }), TODAY), null,
    'ticked on an earlier day (own() writes updatedAt 1 Oct): gone from Overdue');
});

// Amendment 2026-10-22, Alex: "it should stay struck through until tomorrow".
// No field says when an item was ticked; a tick bumps updatedAt, so "ticked
// today" is "updatedAt is on today's LOCAL date". 03:00Z on the 22nd is 20:00
// on the 21st in America/Los_Angeles (pinned at the top of this file), which
// pins local over UTC.
test('sectionOf: a to-do ticked today after its date stays in Overdue until tomorrow', () => {
  const ticked = (updatedAt) => own('a', { type: 'due', date: '2026-10-19', done: true, updatedAt });
  assert.equal(sectionOf(ticked('2026-10-21T19:00:00.000Z'), TODAY), 'overdue', 'ticked at noon today');
  assert.equal(sectionOf(ticked('2026-10-22T03:00:00.000Z'), TODAY), 'overdue', 'ticked at 20:00 today, already the 22nd in UTC');
  assert.equal(sectionOf(ticked('2026-10-21T06:00:00.000Z'), TODAY), null, '23:00 yesterday local, though the 21st in UTC');
  assert.equal(sectionOf(ticked('2026-10-20T19:00:00.000Z'), TODAY), null, 'ticked yesterday');
  for (const updatedAt of [undefined, null, '', 'soon']) {
    assert.equal(sectionOf(ticked(updatedAt), TODAY), null, `no readable updatedAt: ${JSON.stringify(updatedAt)}`);
  }
  assert.equal(sectionOf(ticked(new Date(2026, 9, 21, 12).getTime()), TODAY), null,
    'a numeric updatedAt is no readable string, so no evidence, even when it is today\'s epoch ms');
  assert.equal(sectionOf(own('e', { type: 'event', date: '2026-10-19', done: true, updatedAt: '2026-10-21T19:00:00.000Z' }), TODAY),
    null, 'a past event is never overdue, ticked or not');
});

test('sectionOf: a to-do ticked today stays in To do today; a ticked future one leaves Next 7 days', () => {
  assert.equal(sectionOf(own('a', { done: true }), TODAY), 'todo', 'struck through until tomorrow');
  assert.equal(sectionOf(own('a', { done: true, date: '2026-10-23' }), TODAY), null);
});

test('sectionOf: events and general items go under Today\'s events today and Next 7 days after', () => {
  assert.equal(sectionOf(own('a', { type: 'event' }), TODAY), 'events');
  assert.equal(sectionOf(own('a', { type: 'general' }), TODAY), 'events');
  assert.equal(sectionOf(own('a', { type: 'event', date: '2026-10-24' }), TODAY), 'next');
});

test('sectionOf: an idea is never on Today, whatever its date', () => {
  for (const date of ['2026-10-01', TODAY, '2026-10-23']) {
    assert.equal(sectionOf(own('a', { type: 'idea', date }), TODAY), null, date);
  }
});

// deserializeItems tolerates `date: null` (CLAUDE.md), and '' is what a cleared
// date box yields. Neither has a day, and '' sorts before every real date, so
// without the check it would read as overdue.
test('sectionOf: a record with no readable date belongs to no section', () => {
  for (const date of [null, '', 'soon', '2026-1-2']) {
    assert.equal(sectionOf(own('a', { type: 'due', date }), TODAY), null, JSON.stringify(date));
  }
});

// --- dates ------------------------------------------------------------------

test('daysBetween counts calendar days, so a DST change or months between cannot skew it', () => {
  assert.equal(daysBetween('2026-10-30', '2026-11-03'), 4, 'across the 1 Nov 2026 change');
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2, 'across the 8 Mar 2026 change');
  assert.equal(daysBetween('2026-07-01', TODAY), 112);
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
});

test('dayWord: Tomorrow, then the weekday up to a week out, then the date', () => {
  assert.equal(dayWord('2026-10-22', TODAY), 'Tomorrow');
  assert.equal(dayWord('2026-10-23', TODAY), 'Fri');
  assert.equal(dayWord('2026-10-28', TODAY), 'Wed', 'today + 7');
  assert.equal(dayWord('2026-10-29', TODAY), 'Thu, Oct 29');
  assert.equal(dayWord('2027-01-04', TODAY), 'Mon, Jan 4, 2027');
});

// --- the next event's relative time (spec § 2.3, question 6) -----------------

const at = (hh, mm) => hh * 60 + mm;
const ev = (time, endTime = null) => own('e', { type: 'event', time, endTime });

test('relativeLabel: minutes under an hour, hours and minutes up to 12 h, "now" during it', () => {
  const tenToEleven = ev('10:00', '11:00');
  const cases = [
    [at(9, 18), 'in 42 min'],
    [at(9, 59), 'in 1 min'],
    [at(9, 0), 'in 1 h'],
    [at(7, 50), 'in 2 h 10 min'],
    [at(10, 0), 'now'],
    [at(10, 59), 'now'],
    [at(11, 0), null],
  ];
  for (const [now, want] of cases) assert.equal(relativeLabel(tenToEleven, now), want, `at ${now}`);
});

test('relativeLabel: exactly 12 h ahead is shown, a minute more is not', () => {
  assert.equal(relativeLabel(ev('22:00', '23:00'), at(10, 0)), 'in 12 h');
  assert.equal(relativeLabel(ev('22:00', '23:00'), at(9, 59)), null);
});

test('relativeLabel: an event with no end is "now" only in its start minute; an untimed one never has one', () => {
  assert.equal(relativeLabel(ev('10:00'), at(10, 0)), 'now');
  assert.equal(relativeLabel(ev('10:00'), at(10, 1)), null);
  assert.equal(relativeLabel(ev(null), at(10, 0)), null);
});

test('isPastEvent: over once its end has passed (its start, with no end); untimed never', () => {
  assert.equal(isPastEvent(ev('10:00', '11:00'), at(10, 59)), false);
  assert.equal(isPastEvent(ev('10:00', '11:00'), at(11, 0)), true);
  assert.equal(isPastEvent(ev('10:00'), at(10, 0)), false);
  assert.equal(isPastEvent(ev('10:00'), at(10, 1)), true);
  assert.equal(isPastEvent(ev(null), at(23, 59)), false);
});

// --- buildToday (spec § 2.3) --------------------------------------------------
//
// Fixtures: own items as makeItem stores them, feed instances as
// instancesForRange stamps them (recurring/guessedSeries included).

const inst = (uid, date, o = {}) => {
  const time = o.time || null;
  return {
    id: `feedR:${uid}:${date}:${time}`, uid, title: `i-${uid}`, date, time, endTime: null,
    createdAt: `${date}T${time || '00:00'}`, feedId: 'feedR', feedColor: '#00f', external: true,
    recurring: false, guessedSeries: false, spanKey: `feedR:${uid}`, ...o,
  };
};
const none = () => [];
const ids = (rows) => rows.map((r) => r.item.id);
const allRowIds = (t) => [
  ...ids(t.overdue), ...ids(t.todo), ...ids(t.events), ...t.next.flatMap((d) => ids(d.rows)),
];

test('buildToday: the four sections, each in the order the spec gives', () => {
  const items = [
    own('essay', { type: 'due', date: '2026-10-15', title: 'Essay' }),
    own('reading', { type: 'start', date: '2026-10-18', title: 'Start reading' }),
    own('chore', { type: 'task', date: '2026-10-01', title: 'Old chore' }),
    own('ticked', { type: 'task', title: 'Done one', done: true }),
    own('bank', { type: 'task', time: '09:00', title: 'Call bank' }),
    own('form', { type: 'due', title: 'Submit form' }),
    own('dentist', { type: 'event', time: '14:00', endTime: '15:00', title: 'Dentist' }),
    own('bday', { type: 'general', title: 'Birthday' }),
    own('dinner', { type: 'event', date: '2026-10-23', time: '19:00', title: 'Dinner' }),
    own('prep', { type: 'due', date: '2026-10-22', title: 'Quiz prep' }),
  ];
  const instances = [
    inst('club', '2026-10-22', { time: '08:00', title: 'Club meeting' }),
    inst('phys', TODAY, { time: '10:00', endTime: '11:15', title: 'PHYS 2100', recurring: true }),
    inst('phys', '2026-10-23', { time: '10:00', endTime: '11:15', title: 'PHYS 2100', recurring: true }),
  ];
  const t = buildToday(items, instances, TODAY, at(8, 0), none);
  assert.deepEqual(ids(t.overdue), ['chore', 'essay', 'reading'], 'oldest first');
  assert.deepEqual(ids(t.todo), ['form', 'bank', 'ticked'], 'by time, untimed first, done last');
  assert.deepEqual(ids(t.events), ['bday', 'feedR:phys:2026-10-21:10:00', 'dentist'], 'untimed first');
  assert.deepEqual(t.next.map((d) => [d.date, d.label, ids(d.rows)]), [
    ['2026-10-22', 'Tomorrow', ['prep', 'feedR:club:2026-10-22:08:00']],
    ['2026-10-23', 'Fri', ['dinner']],
  ], 'a repeating class is never under Next 7 days');
  assert.equal(t.emptyLine, null);
});

test('buildToday: an overdue age is in days, red for a deadline and orange for a start', () => {
  const t = buildToday([
    own('d', { type: 'due', date: '2026-10-19' }),
    own('m', { type: 'milestone', date: '2026-10-19' }),
    own('k', { type: 'task', date: '2026-10-20' }),
    own('s', { type: 'start', date: '2026-10-20' }),
  ], [], TODAY, at(8, 0), none);
  assert.deepEqual(t.overdue.map((r) => [r.item.id, r.age, r.tone]), [
    ['d', '2d', 'deadline'], ['m', '2d', 'deadline'], ['k', '1d', 'deadline'], ['s', '1d', 'start'],
  ]);
});

test('buildToday: a to-do ticked today stays in Overdue, after the undone ones, with its age and tone', () => {
  const t = buildToday([
    own('tick', { type: 'start', date: '2026-10-10', done: true, updatedAt: '2026-10-21T19:00:00.000Z' }),
    own('late', { type: 'due', date: '2026-10-19' }),
    own('older', { type: 'task', date: '2026-10-12' }),
    own('gone', { type: 'due', date: '2026-10-11', done: true, updatedAt: '2026-10-20T19:00:00.000Z' }),
  ], [], TODAY, at(8, 0), none);
  assert.deepEqual(t.overdue.map((r) => [r.item.id, r.age, r.tone]), [
    ['older', '9d', 'deadline'], ['late', '2d', 'deadline'], ['tick', '11d', 'start'],
  ], 'undone oldest first, then ticked; ticked yesterday is gone');
  assert.equal(t.emptyLine, null);
});

test('buildToday: an overdue item from months ago is still overdue, with its whole age', () => {
  const t = buildToday([own('old', { type: 'due', date: '2026-06-01', title: 'Lab report' })], [], TODAY, at(8, 0), none);
  assert.deepEqual(t.overdue.map((r) => [r.item.title, r.age]), [['Lab report', '142d']], 'no age limit (question 9)');
});

test('buildToday: no caps and no "+N more" — every row is returned in every section', () => {
  const items = [];
  for (let i = 0; i < 30; i += 1) {
    items.push(own(`o${i}`, { type: 'due', date: '2026-09-01' }));
    items.push(own(`t${i}`, { type: 'task' }));
    items.push(own(`n${i}`, { type: 'event', date: '2026-10-25' }));
  }
  const instances = Array.from({ length: 30 }, (_, i) => inst(`one-${i}`, '2026-10-26'));
  const t = buildToday(items, instances, TODAY, at(8, 0), none);
  assert.equal(t.overdue.length, 30);
  assert.equal(t.todo.length, 30);
  assert.deepEqual(t.next.map((d) => d.rows.length), [30, 30]);
  assert.equal('more' in t, false);
});

test('buildToday: a repeating series shows on its own day only — rule or guessed', () => {
  const instances = [
    inst('lec', TODAY, { time: '10:00', recurring: true }),
    inst('lec', '2026-10-22', { time: '10:00', recurring: true }),
    inst('lab', '2026-10-23', { time: '14:00', recurring: true, guessedSeries: true }),
    inst('lab', TODAY, { time: '14:00', recurring: true, guessedSeries: true }),
    // A seminar that does not meet today: nothing on today hides it.
    inst('sem', '2026-10-22', { time: '16:00', recurring: true }),
    inst('sem', '2026-10-27', { time: '16:00', recurring: true }),
  ];
  const t = buildToday([], instances, TODAY, at(8, 0), none);
  assert.deepEqual(ids(t.events), ['feedR:lec:2026-10-21:10:00', 'feedR:lab:2026-10-21:14:00']);
  assert.deepEqual(t.next, []);
});

test('buildToday: a one-off over several days is shown once — today if it covers today, else on its first day', () => {
  const instances = [
    inst('trip', TODAY), inst('trip', '2026-10-22'), inst('trip', '2026-10-23'),
    inst('conf', '2026-10-24'), inst('conf', '2026-10-25'), inst('conf', '2026-10-26'),
    inst('late', '2026-10-22', { time: '23:00', endTime: '23:59' }),
    inst('late', '2026-10-23', { time: '00:00', endTime: '01:00' }),
  ];
  const t = buildToday([], instances, TODAY, at(8, 0), none);
  assert.deepEqual(ids(t.events), ['feedR:trip:2026-10-21:null']);
  assert.deepEqual(t.next.map((d) => [d.date, ids(d.rows)]), [
    ['2026-10-22', ['feedR:late:2026-10-22:23:00']],
    ['2026-10-24', ['feedR:conf:2026-10-24:null']],
  ]);
});

test('buildToday: Next 7 days stops at today + 7 and hides empty days', () => {
  const items = [
    own('plus3', { type: 'event', date: '2026-10-24' }),
    own('plus7', { type: 'event', date: '2026-10-28' }),
    own('plus8', { type: 'event', date: '2026-10-29' }),
  ];
  const t = buildToday(items, [inst('late', '2026-10-29')], TODAY, at(8, 0), none);
  assert.deepEqual(t.next.map((d) => [d.label, ids(d.rows)]), [['Sat', ['plus3']], ['Wed', ['plus7']]]);
});

test('buildToday: only the next timed event says "in N"; finished ones are greyed', () => {
  const instances = [
    inst('allday', TODAY, { title: 'Fair' }),
    inst('gym', TODAY, { time: '08:00', endTime: '09:00' }),
    inst('lec', TODAY, { time: '09:00', endTime: '10:00' }),
    inst('lunch', TODAY, { time: '11:00' }),
  ];
  const at930 = buildToday([], instances, TODAY, at(9, 30), none);
  assert.deepEqual(at930.events.map((r) => [r.item.uid, r.past, r.relative]), [
    ['allday', false, null], ['gym', true, null], ['lec', false, 'now'], ['lunch', false, null],
  ]);
  const at1030 = buildToday([], instances, TODAY, at(10, 30), none);
  assert.deepEqual(at1030.events.map((r) => [r.item.uid, r.past, r.relative]), [
    ['allday', false, null], ['gym', true, null], ['lec', true, null], ['lunch', false, 'in 30 min'],
  ]);
  const late = buildToday([], instances, TODAY, at(22, 0), none);
  assert.deepEqual(late.events.map((r) => r.relative), [null, null, null, null], 'nothing left today');
});

// Final review A2 (2026-10-22): the next timed event's row always carries a
// `relative` string — '' while it is over 12 h away — so the page draws its
// label and the 60 s tick can fill it in once it comes within 12 h. Every
// other row's is null.
test('buildToday: the next event over 12 h away still gets a relative label, empty; no other row does', () => {
  const instances = [
    inst('allday', TODAY, { title: 'Fair' }),
    inst('gym', TODAY, { time: '07:00', endTime: '07:30' }),
    inst('talk', TODAY, { time: '20:30', endTime: '21:30' }),
    inst('late', TODAY, { time: '22:00' }),
  ];
  const t = buildToday([], instances, TODAY, at(8, 0), none);
  assert.deepEqual(t.events.map((r) => [r.item.uid, r.relative]), [
    ['allday', null], ['gym', null], ['talk', ''], ['late', null],
  ]);
});

test('buildToday: own events take part in "next" and in greying too', () => {
  const t = buildToday([own('call', { type: 'event', time: '09:45', endTime: '10:00' })],
    [inst('lec', TODAY, { time: '11:00', endTime: '12:00' })], TODAY, at(9, 3), none);
  assert.deepEqual(t.events.map((r) => [r.item.id, r.relative]), [['call', 'in 42 min'], ['feedR:lec:2026-10-21:11:00', null]]);
});

test('buildToday: with nothing overdue, due or on today, one line names the next thing', () => {
  const calls = [];
  const lookahead = () => { calls.push(1); return [inst('phys', '2026-10-23', { recurring: true }), inst('club', '2026-10-29', { title: 'Club' })]; };
  const t = buildToday([own('quiz', { type: 'event', date: '2026-10-30', title: 'Stats quiz' })], [], TODAY, at(8, 0), lookahead);
  // Final review A5 (2026-10-22): the "Next" line names the first upcoming
  // thing, a repeating class included (it stays out of Next 7 days itself).
  assert.equal(t.emptyLine, 'Nothing due today. Next: i-phys · Fri.', 'the earliest of the three; a repeating class counts');
  assert.equal(calls.length, 1);
  const own2 = buildToday([own('quiz', { type: 'event', date: '2026-10-23', title: 'Stats quiz' })], [], TODAY, at(8, 0), lookahead);
  assert.equal(own2.emptyLine, 'Nothing due today. Next: Stats quiz · Fri.');
});

// Changed in stage 3 Commit 2 (Coming up, Alex 2026-10-22): the look-ahead
// used to run only when the first three sections were empty, for the "Next"
// line. It now also feeds `later` (today + 8 .. today + 30), which is built on
// every render, so it runs once per buildToday, whatever today holds — and
// still only once when the empty line needs it too.
test('buildToday: the 30-day look-ahead runs exactly once per build, busy day or empty', () => {
  let calls = 0;
  const lookahead = () => { calls += 1; return []; };
  buildToday([own('t', { type: 'task' })], [], TODAY, at(8, 0), lookahead);
  assert.equal(calls, 1, 'a to-do today: it runs, for later');
  buildToday([own('o', { type: 'due', date: '2026-10-01' })], [], TODAY, at(8, 0), lookahead);
  buildToday([], [inst('e', TODAY)], TODAY, at(8, 0), lookahead);
  assert.equal(calls, 3);
  buildToday([], [inst('later', '2026-10-24')], TODAY, at(8, 0), lookahead);
  assert.equal(calls, 4, 'an empty day needs it twice (later and the "Next" line) and calls it once');
});

test('buildToday: the "Next" line skips done items, ideas and anything past 30 days', () => {
  const items = [
    own('done', { type: 'task', date: '2026-10-22', done: true }),
    own('idea', { type: 'idea', date: '2026-10-22' }),
    own('far', { type: 'event', date: '2027-03-01', title: 'Spring trip' }),
  ];
  const t = buildToday(items, [], TODAY, at(8, 0), () => [inst('x', '2026-11-21', { title: 'Too far' })]);
  assert.equal(t.emptyLine, 'Nothing due today. Next: Spring trip · Mon, Mar 1, 2027.', 'an own item at any distance counts');
  const nothing = buildToday([], [], TODAY, at(8, 0), () => [inst('x', '2026-11-21')]);
  assert.equal(nothing.emptyLine, 'Nothing coming up.');
});

test('buildToday: every item appears at most once', () => {
  const items = [
    own('a', { type: 'due', date: '2026-10-01' }), own('b', { type: 'task' }), own('c', { type: 'task', done: true }),
    own('d', { type: 'event' }), own('e', { type: 'event', date: '2026-10-22' }), own('f', { type: 'start', date: '2026-10-25' }),
    own('g', { type: 'idea' }),
  ];
  const instances = [
    inst('trip', TODAY), inst('trip', '2026-10-22'), inst('conf', '2026-10-24'), inst('conf', '2026-10-25'),
    inst('lec', TODAY, { time: '10:00', recurring: true }), inst('lec', '2026-10-23', { time: '10:00', recurring: true }),
    inst('one', '2026-10-27'),
  ];
  const all = allRowIds(buildToday(items, instances, TODAY, at(8, 0), none));
  assert.equal(new Set(all).size, all.length, `duplicates in ${all}`);
  assert.equal(all.length, 10, 'fixture check: a-f, trip, lec, conf and one; the idea g is never on Today');
});

test('buildToday: a day with only classes shows them, draws nothing else, and says nothing about "due"', () => {
  const instances = [
    inst('math', TODAY, { time: '09:00', endTime: '09:50', recurring: true }),
    inst('phys', TODAY, { time: '10:00', endTime: '11:15', recurring: true }),
    inst('math', '2026-10-23', { time: '09:00', endTime: '09:50', recurring: true }),
  ];
  // The look-ahead used to throw here, to pin "not called when today has
  // something"; it now always runs (for `later`; stage 3 Commit 2), so it
  // returns nothing instead.
  const t = buildToday([], instances, TODAY, at(8, 0), none);
  assert.deepEqual(t.overdue, []);
  assert.deepEqual(t.todo, []);
  assert.equal(t.events.length, 2);
  assert.deepEqual(t.next, []);
  assert.equal(t.emptyLine, null);
});

test('buildToday: refuses input it cannot place, loudly', () => {
  assert.throws(() => buildToday([], [], '2026-10-21T00:00', at(8, 0), none), /todayISO/);
  for (const bad of [-1, 1440, 1.5, '480']) {
    assert.throws(() => buildToday([], [], TODAY, bad, none), /nowMinutes/, String(bad));
  }
  assert.throws(() => buildToday([], [], TODAY, at(8, 0)), /lookahead/);
  const unstamped = inst('x', TODAY);
  delete unstamped.recurring;
  assert.throws(() => buildToday([], [unstamped], TODAY, at(8, 0), none), /recurring/,
    'an instance instancesForRange did not stamp cannot be placed');
  const noSpan = inst('x', TODAY);
  delete noSpan.spanKey;
  assert.throws(() => buildToday([], [noSpan], TODAY, at(8, 0), none), /spanKey/);
  const emptySpan = inst('x', TODAY, { spanKey: '' });
  assert.throws(() => buildToday([], [emptySpan], TODAY, at(8, 0), none), /spanKey/);
  // The look-ahead's instances are held to the same rule (empty day, so it runs).
  const lookNoRecurring = inst('y', '2026-10-25');
  delete lookNoRecurring.recurring;
  assert.throws(() => buildToday([], [], TODAY, at(8, 0), () => [lookNoRecurring]), /recurring/);
  const lookNoSpan = inst('y', '2026-10-25');
  delete lookNoSpan.spanKey;
  assert.throws(() => buildToday([], [], TODAY, at(8, 0), () => [lookNoSpan]), /spanKey/);
});

// --- Review Focus: a real class calendar, end to end ---------------------------
//
// ICS text -> parseICS -> instancesForRange -> buildToday, in Alex's zone,
// across the 1 Nov 2026 DST change. The class repeats by RRULE (LMU Classes is
// rule-shaped, stage 1 result); one meeting is moved (an override), one is
// cancelled (EXDATE), and the calendar also carries a "no class" one-off on a
// class day, an exam and a three-day all-day break.

const CLASS_ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:phys2100@google.com', 'SUMMARY:PHYS 2100',
  'DTSTART;TZID=America/Los_Angeles:20260825T100000', 'DTEND;TZID=America/Los_Angeles:20260825T111500',
  'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261211T000000Z',
  'EXDATE;TZID=America/Los_Angeles:20261105T100000',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:phys2100@google.com', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261029T100000',
  'SUMMARY:PHYS 2100 (room change)',
  'DTSTART;TZID=America/Los_Angeles:20261029T130000', 'DTEND;TZID=America/Los_Angeles:20261029T141500',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:noclass-1103@google.com', 'SUMMARY:No class — PHYS 2100',
  'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:exam@google.com', 'SUMMARY:MATH 234 Standards Exam',
  'DTSTART;TZID=America/Los_Angeles:20261102T090000', 'DTEND;TZID=America/Los_Angeles:20261102T100000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:fallbreak@google.com', 'SUMMARY:Fall break',
  'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261102', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const CLASS_FEED = { id: 'lmu', url: 'https://calendar.google.com/calendar/ical/secret-token/basic.ics', name: 'LMU Classes', color: '#00f', hidden: false };
const LA = 'America/Los_Angeles';

function todayFromIcs(todayISO, nowMin, ownItems = []) {
  const { events, skipped } = parseICS(CLASS_ICS);
  assert.deepEqual(skipped, [], 'fixture check: every VEVENT parsed');
  const cache = { lmu: { fetchedAt: '2026-10-20T00:00:00.000Z', events, skipped } };
  return buildToday(
    ownItems,
    instancesForRange([CLASS_FEED], cache, todayISO, addDays(todayISO, NEXT_DAYS), LA),
    todayISO, nowMin,
    () => instancesForRange([CLASS_FEED], cache, addDays(todayISO, 1), addDays(todayISO, 30), LA),
  );
}
const titles = (rows) => rows.map((r) => `${r.item.title}${r.item.time ? ` ${r.item.time}` : ''}`);

test('Review Focus: a moved class shows at its new time today, and no class is ever under Next 7 days', () => {
  const t = todayFromIcs('2026-10-29', at(8, 0)); // Thursday; DST ends Sunday 1 Nov
  assert.deepEqual(titles(t.events), ['PHYS 2100 (room change) 13:00'], 'the 10:00 slot it replaced is gone');
  assert.equal(t.events[0].item.recurring, true, 'an override belongs to its series');
  assert.deepEqual(t.next.map((d) => [d.label, titles(d.rows)]), [
    ['Tomorrow', ['Fall break']],
    ['Mon', ['MATH 234 Standards Exam 09:00']],
    ['Tue', ['No class — PHYS 2100']],
  ], 'the break once, on its first day; the Tue and Thu classes never');
});

test('Review Focus: on a day with no class, the coming week\'s classes still stay out of Next 7 days', () => {
  const t = todayFromIcs('2026-10-30', at(8, 0)); // Friday
  assert.deepEqual(titles(t.events), ['Fall break']);
  assert.deepEqual(t.next.map((d) => [d.label, titles(d.rows)]), [
    ['Mon', ['MATH 234 Standards Exam 09:00']],
    ['Tue', ['No class — PHYS 2100']],
  ], 'Tue 3 Nov\'s class is not here, and the break is not repeated on Sat and Sun');
});

test('Review Focus: after the DST change the class keeps its 10:00, and a "no class" day shows both', () => {
  const t = todayFromIcs('2026-11-03', at(9, 0)); // Tuesday, after the change
  assert.deepEqual(titles(t.events), ['No class — PHYS 2100', 'PHYS 2100 10:00'],
    'the calendar has no EXDATE for 3 Nov, so the class is still on it: Today shows what the feed says');
  assert.equal(t.events[1].relative, 'in 1 h');
  assert.deepEqual(t.next.map((d) => d.label), [], 'Thursday 5 Nov is cancelled (EXDATE) and classes are never here anyway');
});

test('Review Focus: a cancelled class (EXDATE) is simply not on its day', () => {
  const t = todayFromIcs('2026-11-05', at(8, 0));
  assert.deepEqual(t.events, []);
  assert.equal(t.emptyLine, 'Nothing due today. Next: PHYS 2100 · Tue.',
    'the next class names the next thing (final review A5): Tue 10 Nov, after the cancelled Thu 5 Nov');
});

test('Review Focus: the DST week moves neither the Next 7 days edge nor an overdue age', () => {
  const t = todayFromIcs('2026-10-29', at(8, 0), [
    own('edge', { type: 'event', date: '2026-11-05', title: 'Edge' }),
    own('past-edge', { type: 'event', date: '2026-11-06', title: 'Past the edge' }),
    own('due', { type: 'due', date: '2026-10-25', title: 'Problem set' }),
  ]);
  assert.deepEqual(t.next.at(-1).rows.map((r) => r.item.title), ['Edge'], 'today + 7 is 5 Nov, DST or not');
  assert.equal(t.next.flatMap((d) => d.rows).some((r) => r.item.title === 'Past the edge'), false);
  const later = todayFromIcs('2026-11-03', at(9, 0), [own('due', { type: 'due', date: '2026-10-25', title: 'Problem set' })]);
  assert.deepEqual(later.overdue.map((r) => r.age), ['9d'], '25 Oct to 3 Nov, across the 25-hour day');
});

test('Review Focus: no Today row carries the calendar link', () => {
  const t = todayFromIcs('2026-10-29', at(8, 0));
  const json = JSON.stringify(t);
  assert.ok(t.events.length > 0, 'fixture check');
  assert.equal(json.includes('secret-token'), false);
});

// --- spanKey: different events sharing a uid are not one occurrence ----------

const vevent = (uid, summary, extra) => ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${summary}`, ...extra, 'END:VEVENT'];
const ldt = (day, hhmm) => `DTSTART;TZID=America/Los_Angeles:${day}T${hhmm}00`;
function todayFromText(vevents, todayISO = '2026-10-21') {
  const { events, skipped } = parseICS(['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevents.flat(), 'END:VCALENDAR'].join('\r\n'));
  assert.deepEqual(skipped, [], 'fixture check: every VEVENT parsed');
  const cache = { lmu: { fetchedAt: '2026-10-20T00:00:00.000Z', events, skipped } };
  return buildToday([], instancesForRange([CLASS_FEED], cache, todayISO, addDays(todayISO, NEXT_DAYS), LA),
    todayISO, at(8, 0), () => instancesForRange([CLASS_FEED], cache, addDays(todayISO, 1), addDays(todayISO, 30), LA));
}

test('spanKey: master-less overrides sharing a uid are separate events — each shows', () => {
  const override = (day, summary) => vevent('m@x', summary, [
    `RECURRENCE-ID;TZID=America/Los_Angeles:${day}T090000`, ldt(day, '0900'), `DTEND;TZID=America/Los_Angeles:${day}T100000`,
  ]);
  const t = todayFromText([
    override('20261021', 'Meet Today'), override('20261022', 'Meet Tomorrow'), override('20261026', 'Meet Monday'),
  ]);
  assert.deepEqual(titles(t.events), ['Meet Today 09:00']);
  assert.deepEqual(t.next.map((d) => [d.label, titles(d.rows)]), [
    ['Tomorrow', ['Meet Tomorrow 09:00']],
    ['Mon', ['Meet Monday 09:00']],
  ]);
});

test('spanKey: two one-offs with the same UID on different days both show under Next 7 days', () => {
  const one = (day, summary) => vevent('dup@x', summary, [ldt(day, '1400'), `DTEND;TZID=America/Los_Angeles:${day}T150000`]);
  const t = todayFromText([one('20261023', 'First'), one('20261026', 'Second')]);
  assert.deepEqual(t.next.map((d) => [d.label, titles(d.rows)]), [
    ['Fri', ['First 14:00']],
    ['Mon', ['Second 14:00']],
  ]);
});

test('spanKey: a multi-day all-day one-off from real ICS still shows once', () => {
  const t = todayFromText([vevent('trip@x', 'Trip', ['DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261026'])]);
  assert.deepEqual(t.next.map((d) => [d.label, titles(d.rows)]), [['Fri', ['Trip']]]);
});

// Final review A1 (2026-10-22): a no-RRULE feed whose master-less overrides
// share UID:S1 — three on Thursdays at the same time (a guessed group) and one
// moved to a Tuesday. A uid is guessed only when EVERY event with it is in a
// guessed group, so the moved one is no part of a series: it shows under Next
// 7 days with no "guessed" flag, and feedShape counts all four as single.
test('A1: a uid with an event outside every guessed group is not guessed — the moved one shows', () => {
  const seminar = (day, from, to) => vevent('S1', 'Seminar', [
    `RECURRENCE-ID:${day}T${from}00Z`, `DTSTART:${day}T${from}00Z`, `DTEND:${day}T${to}00Z`,
  ]);
  const vevents = [
    seminar('20261008', '1700', '1800'), seminar('20261015', '1700', '1800'),
    seminar('20261022', '1700', '1800'), seminar('20261027', '2000', '2100'),
  ];
  const { events } = parseICS(['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevents.flat(), 'END:VCALENDAR'].join('\r\n'));
  const t = todayFromText(vevents);
  const rows = t.next.flatMap((d) => d.rows.map((r) => [d.label, r.item.title, r.item.time, r.item.guessedSeries]));
  assert.deepEqual(rows, [
    ['Tomorrow', 'Seminar', '10:00', false],
    ['Tue', 'Seminar', '13:00', false],
  ]);
  const shape = feedShape(events, LA);
  assert.equal(shape.method, 'heuristic', 'fixture check: no RRULE');
  assert.equal(shape.inGuessedSeries, 0);
  assert.equal(shape.guessedSeries, 0);
  assert.equal(shape.single, 4);
});

// Final review A5 (2026-10-22), the reviewer's case: a day with nothing of
// one's own and only a weekly class ahead names that class, not "Nothing
// coming up." The class still stays out of Next 7 days.
test('A5: with only a weekly class starting tomorrow, the "Next" line names it', () => {
  const t = todayFromText([vevent('gym@x', 'Gym', [
    ldt('20261022', '0700'), 'DTEND;TZID=America/Los_Angeles:20261022T080000', 'RRULE:FREQ=WEEKLY',
  ])]);
  assert.deepEqual(t.next, [], 'a repeating series is never under Next 7 days');
  assert.equal(t.emptyLine, 'Nothing due today. Next: Gym · Tomorrow.');
});

// --- upcomingRows and Coming up (stage 3 Commit 2, Alex 2026-10-22) ---------
//
// upcomingRows holds the one rule for "the rows of a run of coming days":
// Next 7 days, Today's Coming up (`later`) and the Week page's list all use it.

const dayRows = (days) => days.map((d) => [d.date, d.label, ids(d.rows)]);

test('upcomingRows: own items in range, not done, never ideas; the range is inclusive at both ends', () => {
  const items = [
    own('before', { type: 'event', date: '2026-11-01' }),
    own('first', { type: 'event', date: '2026-11-02' }),
    own('task', { type: 'task', date: '2026-11-05', time: '09:00' }),
    own('done', { type: 'due', date: '2026-11-05', done: true }),
    own('idea', { type: 'idea', date: '2026-11-05' }),
    own('nodate', { type: 'event', date: '' }),
    own('last', { type: 'due', date: '2026-11-10' }),
    own('after', { type: 'event', date: '2026-11-11' }),
  ];
  assert.deepEqual(dayRows(upcomingRows(items, [], '2026-11-02', '2026-11-10', TODAY)), [
    ['2026-11-02', 'Mon, Nov 2', ['first']],
    ['2026-11-05', 'Thu, Nov 5', ['task']],
    ['2026-11-10', 'Tue, Nov 10', ['last']],
  ]);
});

test('upcomingRows: a repeating instance is never a row; a one-off is, labelled by dayWord, in date order', () => {
  const instances = [
    inst('lec', '2026-11-03', { time: '10:00', recurring: true }),
    inst('lab', '2026-11-04', { time: '14:00', recurring: true, guessedSeries: true }),
    inst('quiz', '2026-11-04', { time: '09:25' }),
    inst('exam', '2026-11-03', { time: '10:50' }),
  ];
  const items = [own('reg', { type: 'task', date: '2026-11-04' })];
  assert.deepEqual(dayRows(upcomingRows(items, instances, '2026-10-30', '2026-11-20', TODAY)), [
    ['2026-11-03', 'Tue, Nov 3', ['feedR:exam:2026-11-03:10:50']],
    ['2026-11-04', 'Wed, Nov 4', ['reg', 'feedR:quiz:2026-11-04:09:25']],
  ]);
  assert.deepEqual(dayRows(upcomingRows([], [inst('x', '2026-10-22'), inst('y', '2026-10-24')], '2026-10-22', '2026-10-28', TODAY)), [
    ['2026-10-22', 'Tomorrow', ['feedR:x:2026-10-22:null']],
    ['2026-10-24', 'Sat', ['feedR:y:2026-10-24:null']],
  ], 'the same day words as Next 7 days');
});

test('upcomingRows: a multi-day one-off shows once, on its first day in range; one that began earlier is not shown again', () => {
  const instances = [
    // Began before the range (shown there already): every copy dropped.
    inst('break', '2026-10-30'), inst('break', '2026-10-31'), inst('break', '2026-11-01'),
    // Starts inside the range: once, on its first day.
    inst('trip', '2026-11-03'), inst('trip', '2026-11-04'), inst('trip', '2026-11-05'),
  ];
  assert.deepEqual(dayRows(upcomingRows([], instances, '2026-10-31', '2026-11-10', TODAY)), [
    ['2026-11-03', 'Tue, Nov 3', ['feedR:trip:2026-11-03:null']],
  ]);
  assert.deepEqual(dayRows(upcomingRows([], instances, '2026-10-30', '2026-11-10', TODAY)).map((d) => d[2]), [
    ['feedR:break:2026-10-30:null'], ['feedR:trip:2026-11-03:null'],
  ], 'with its first day in range, the break shows on it');
});

test('upcomingRows: once per spanKey, not per uid — two events sharing a uid each show', () => {
  const instances = [
    inst('dup', '2026-11-03', { spanKey: 'feedR:dup:a' }),
    inst('dup', '2026-11-06', { spanKey: 'feedR:dup:b' }),
    inst('span', '2026-11-04', { spanKey: 'feedR:span' }),
    inst('span', '2026-11-05', { spanKey: 'feedR:span' }),
  ];
  assert.deepEqual(dayRows(upcomingRows([], instances, '2026-11-01', '2026-11-10', TODAY)).map((d) => d[2]), [
    ['feedR:dup:2026-11-03:null'], ['feedR:span:2026-11-04:null'], ['feedR:dup:2026-11-06:null'],
  ]);
});

test('upcomingRows: refuses input it cannot place, loudly', () => {
  assert.throws(() => upcomingRows([], [], '2026-11-01', '2026-11-10'), /todayISO/);
  assert.throws(() => upcomingRows([], [], 'soon', '2026-11-10', TODAY), /range/);
  assert.throws(() => upcomingRows([], [], '2026-11-10', '2026-11-01', TODAY), /range/, 'an inverted range');
  const unstamped = inst('x', '2026-11-03');
  delete unstamped.recurring;
  assert.throws(() => upcomingRows([], [unstamped], '2026-11-01', '2026-11-10', TODAY), /recurring/);
});

// One copy of the rule: Next 7 days IS upcomingRows over (today, today + 7],
// with today's instances in the input (they seed the "already shown" set).
test('buildToday: Next 7 days is upcomingRows over today + 1 .. today + 7, row for row', () => {
  const items = [
    own('a', { type: 'due', date: TODAY }), own('b', { type: 'event', date: '2026-10-22', time: '09:00' }),
    own('c', { type: 'task', date: '2026-10-25', done: true }), own('d', { type: 'idea', date: '2026-10-23' }),
    own('e', { type: 'start', date: '2026-10-28' }), own('f', { type: 'event', date: '2026-10-29' }),
  ];
  const instances = [
    inst('trip', TODAY), inst('trip', '2026-10-22'), inst('conf', '2026-10-24'), inst('conf', '2026-10-25'),
    inst('lec', '2026-10-23', { time: '10:00', recurring: true }), inst('one', '2026-10-27', { time: '08:00' }),
  ];
  const t = buildToday(items, instances, TODAY, at(8, 0), none);
  assert.ok(t.next.length >= 3, 'fixture check');
  assert.deepEqual(t.next, upcomingRows(items, instances, '2026-10-22', '2026-10-28', TODAY));
});

test('buildToday: later is upcomingRows over today + 8 .. today + 30, from the look-ahead', () => {
  assert.equal(LOOKAHEAD_DAYS, 30);
  const items = [
    own('p7', { type: 'event', date: '2026-10-28' }), own('p8', { type: 'event', date: '2026-10-29' }),
    own('p30', { type: 'due', date: '2026-11-20' }), own('p31', { type: 'event', date: '2026-11-21' }),
    own('done', { type: 'task', date: '2026-11-02', done: true }), own('idea', { type: 'idea', date: '2026-11-02' }),
  ];
  const ahead = [
    inst('i7', '2026-10-28'), inst('i8', '2026-10-29', { time: '09:25' }), inst('i30', '2026-11-20'),
    inst('i31', '2026-11-21'), inst('cls', '2026-11-03', { time: '10:00', recurring: true }),
  ];
  const t = buildToday(items, [], TODAY, at(8, 0), () => ahead);
  assert.deepEqual(dayRows(t.later), [
    ['2026-10-29', 'Thu, Oct 29', ['p8', 'feedR:i8:2026-10-29:09:25']],
    ['2026-11-20', 'Fri, Nov 20', ['p30', 'feedR:i30:2026-11-20:null']],
  ], '+7 is Next 7 days\' (not later), +8 and +30 are in, +31 is out; done, ideas and classes never');
  assert.deepEqual(dayRows(t.next), [['2026-10-28', 'Wed', ['p7']]], 'fixture check: +7 is under Next 7 days');
  assert.deepEqual(t.later, upcomingRows(items, ahead, '2026-10-29', '2026-11-20', TODAY));
});

test('buildToday: later never repeats what Today or Next 7 days already shows', () => {
  // A one-off from +6 to +9 is under Next 7 days on +6; one covering today to
  // +9 is under Today's events. The look-ahead holds every copy from +1.
  const span = (uid, from, n) => Array.from({ length: n }, (_, i) => inst(uid, addDays(from, i)));
  const instances = [...span('week', TODAY, 8), ...span('trip', '2026-10-27', 2)];
  const ahead = [...span('week', '2026-10-22', 9), ...span('trip', '2026-10-27', 4), inst('new', '2026-11-02')];
  const t = buildToday([], instances, TODAY, at(8, 0), () => ahead);
  assert.deepEqual(ids(t.events), ['feedR:week:2026-10-21:null'], 'fixture check');
  assert.deepEqual(t.next.map((d) => ids(d.rows)), [['feedR:trip:2026-10-27:null']], 'fixture check');
  assert.deepEqual(dayRows(t.later), [['2026-11-02', 'Mon, Nov 2', ['feedR:new:2026-11-02:null']]]);
  const all = [...allRowIds(t), ...t.later.flatMap((d) => ids(d.rows))].map((id) => id.split(':')[1]);
  assert.equal(new Set(all).size, all.length, `an event twice in ${all}`);
});

test('buildToday: later is empty when nothing is past the first week', () => {
  const t = buildToday([own('soon', { type: 'event', date: '2026-10-23' })], [], TODAY, at(8, 0), none);
  assert.deepEqual(t.later, []);
});

// There is ONE copy of the row rule. A behaviour test cannot tell a faithful
// second copy from a call, so this reads the source: buildToday builds both
// day lists through upcomingRows and keeps no "seen" set or repeating-
// instance filter of its own.
test('buildToday holds no copy of the Next 7 days rule: both day lists come from upcomingRows', () => {
  const src = readFileSync(new URL('../js/today.js', import.meta.url), 'utf8');
  const body = src.match(/export function buildToday\([\s\S]*?\n}\n/);
  assert.ok(body, 'fixture check: buildToday found');
  assert.equal((body[0].match(/upcomingRows\(/g) || []).length, 2, 'next and later, each from upcomingRows');
  assert.doesNotMatch(body[0], /\.recurring|\bseen\b|spanKey|dayWord\(item/, 'no second copy of the rule');
});

// --- tally: Today's "N DONE · M LEFT" (rewards concept 2, Alex 2026-10-26) --
//
// Controller rulings, 2026-10-26: it counts only the rows in Overdue and To do
// today, so it matches the struck rows on screen (a to-do finished early,
// dated later, is in neither); it is hidden (null) until the first tick of
// the day; and it says "all done" (left 0) only when both sections are fully
// ticked. TICKED is a local-today instant: 2026-10-21 08:00 in Los Angeles.
const TICKED = '2026-10-21T15:00:00.000Z';
const tallyOf = (items) => tally(buildToday(items, [], TODAY, at(10, 0), none));

test('tally: nothing ticked yet gives null, so the count stays hidden', () => {
  assert.equal(tallyOf([own('a'), own('b', { type: 'due', date: '2026-10-19' })]), null);
  assert.equal(tallyOf([]), null, 'an empty day too');
});

test('tally: two ticked of five in Overdue and To do today gives 2 done, 3 left', () => {
  const items = [
    own('o1', { type: 'due', date: '2026-10-19' }),
    own('o2', { type: 'start', date: '2026-10-20' }),
    own('o3', { type: 'task', date: '2026-10-20', done: true, updatedAt: TICKED }),
    own('t1', { type: 'due', time: '23:59' }),
    own('t2', { type: 'task', done: true, updatedAt: TICKED }),
    own('ev', { type: 'event', time: '09:00' }),
  ];
  assert.deepEqual(tallyOf(items), { done: 2, left: 3 }, 'events are not counted');
});

test('tally: an overdue to-do ticked today counts as done', () => {
  assert.deepEqual(tallyOf([own('o', { type: 'due', date: '2026-10-15', done: true, updatedAt: TICKED })]),
    { done: 1, left: 0 });
});

test('tally: an item ticked yesterday, or a to-do finished early with a later date, counts in neither', () => {
  const items = [
    own('t', { type: 'task' }),
    own('old', { type: 'due', date: '2026-10-19', done: true, updatedAt: '2026-10-20T15:00:00.000Z' }),
    own('early', { type: 'task', date: '2026-10-24', done: true, updatedAt: TICKED }),
    own('t2', { type: 'task', done: true, updatedAt: TICKED }),
  ];
  assert.deepEqual(tallyOf(items), { done: 1, left: 1 });
});

// The rulings meet here (devil's advocate I1, plan review 2026-10-26): a
// to-do dated today and ticked on an earlier day is a struck row in To do
// today (sectionOf), so it counts as done, and the count can show before the
// first tick of today. "Match the struck rows on screen" is the rule kept;
// the report puts the conflict to Alex.
test('tally: a to-do dated today, ticked on an earlier day, is a struck row and counts as done', () => {
  const items = [
    own('early', { type: 'task', done: true, updatedAt: '2026-10-19T15:00:00.000Z' }),
    own('t', { type: 'task' }),
  ];
  assert.deepEqual(tallyOf(items), { done: 1, left: 1 });
});

test('tally: everything ticked but one overdue item is never "all done"', () => {
  const items = [
    own('o', { type: 'due', date: '2026-10-19' }),
    own('t1', { type: 'task', done: true, updatedAt: TICKED }),
    own('t2', { type: 'due', done: true, updatedAt: TICKED }),
  ];
  assert.deepEqual(tallyOf(items), { done: 2, left: 1 });
});
