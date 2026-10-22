import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionOf, daysBetween, dayWord, relativeLabel, isPastEvent, NEXT_DAYS,
} from '../js/today.js';

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
