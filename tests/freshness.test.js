import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followToday, formatDayLabel, describeLaunches } from '../js/freshness.js';

// --- followToday: a view that was showing "today" moves with the clock ------
//
// iOS resumes a home-screen PWA rather than reloading it, and app.js computes
// its day/week/month cursors once at module load. Opened at 23:00 and resumed
// at 08:00, the Day view would otherwise still show yesterday.

test('followToday moves a view that was showing the old today to the new today', () => {
  assert.equal(followToday('2026-09-22', '2026-09-22', '2026-09-23'), '2026-09-23');
});

test('followToday leaves a view the user navigated elsewhere exactly where it is', () => {
  assert.equal(followToday('2026-10-01', '2026-09-22', '2026-09-23'), '2026-10-01');
});

test('followToday is a no-op when the day has not changed', () => {
  assert.equal(followToday('2026-09-23', '2026-09-23', '2026-09-23'), '2026-09-23');
});

// --- formatDayLabel: human dates instead of raw ISO -------------------------

const TODAY = '2026-09-23'; // a Wednesday

test('formatDayLabel names today, tomorrow and yesterday', () => {
  assert.equal(formatDayLabel('2026-09-23', TODAY), 'Today');
  assert.equal(formatDayLabel('2026-09-24', TODAY), 'Tomorrow');
  assert.equal(formatDayLabel('2026-09-22', TODAY), 'Yesterday');
});

test('formatDayLabel gives weekday, month and day within the current year', () => {
  assert.equal(formatDayLabel('2026-09-30', TODAY), 'Wed, Sep 30');
  assert.equal(formatDayLabel('2026-01-05', TODAY), 'Mon, Jan 5');
});

test('formatDayLabel adds the year only when it differs from today\'s', () => {
  assert.equal(formatDayLabel('2027-01-04', TODAY), 'Mon, Jan 4, 2027');
});

// Tomorrow across a month and a year boundary — the relative names must come
// from calendar arithmetic, not from comparing day-of-month numbers.
test('formatDayLabel computes tomorrow across a year boundary', () => {
  assert.equal(formatDayLabel('2027-01-01', '2026-12-31'), 'Tomorrow');
});

// The weekday must not shift with the device's timezone. A date string is a
// civil date; parsing it as a local-midnight instant and formatting in another
// zone is how "Wed" becomes "Tue".
test('formatDayLabel is independent of the process timezone', () => {
  const prior = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    assert.equal(formatDayLabel('2026-09-30', TODAY), 'Wed, Sep 30');
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(formatDayLabel('2026-09-30', TODAY), 'Wed, Sep 30');
  } finally {
    if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior;
  }
});

// --- describeLaunches: the Phase 0 baseline --------------------------------

const NOW = new Date('2026-09-23T15:00:00.000Z');

test('describeLaunches counts opens in the last 7 days and ignores older ones', () => {
  const launches = [
    '2026-09-10T08:00:00.000Z', // 13 days ago — outside the window
    '2026-09-17T08:00:00.000Z', // 6 days ago
    '2026-09-22T08:00:00.000Z',
    '2026-09-23T08:00:00.000Z',
  ];
  assert.equal(describeLaunches(launches, NOW), 'Opened 3 times in the last 7 days.');
});

test('describeLaunches uses the singular for one open', () => {
  assert.equal(describeLaunches(['2026-09-23T08:00:00.000Z'], NOW), 'Opened once in the last 7 days.');
});

test('describeLaunches says so plainly when there are none', () => {
  assert.equal(describeLaunches([], NOW), 'Not opened in the last 7 days.');
});

// Sweep (dates) Critical: deserializeItems DELIBERATELY tolerates date: null
// (CLAUDE.md), and '' is the third date state. formatDayLabel threw on both,
// and it runs inside render() at module load — one such record synced in would
// crash every cold start before sync could run to repair it.
test('formatDayLabel never throws on a date it cannot read', () => {
  for (const bad of [null, undefined, '', 'garbage', '2026-13-45x', 42]) {
    assert.doesNotThrow(() => formatDayLabel(bad, TODAY), `threw on ${JSON.stringify(bad)}`);
  }
  assert.equal(formatDayLabel(null, TODAY), 'No date');
  assert.equal(formatDayLabel('', TODAY), 'No date');
  assert.equal(formatDayLabel('garbage', TODAY), 'Unreadable date');
});
