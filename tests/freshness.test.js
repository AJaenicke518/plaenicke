import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { followToday, formatDayLabel, describeLaunches } from '../js/freshness.js';

const FRESHNESS_URL = new URL('../js/freshness.js', import.meta.url).href;

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
//
// Run in CHILD processes (sweep review #10): switching process.env.TZ inside
// this process is not a reliable test, because Intl formatters built at module
// load and cached Date state keep the zone they started with. Each child starts
// in its zone. Kiritimati is UTC+14 and Honolulu UTC-10, so a date read as a
// local midnight shifts a day in one direction or the other.
function inZone(tz, body) {
  const code = `import * as f from ${JSON.stringify(FRESHNESS_URL)};
const out = await (async () => { ${body} })();
process.stdout.write(JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, out }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const { tz: seen, out } = JSON.parse(r.stdout);
  assert.equal(seen, tz, 'fixture check: the child runs in the requested zone');
  return out;
}

test('formatDayLabel is independent of the device timezone', () => {
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Honolulu']) {
    assert.equal(inZone(tz, `return f.formatDayLabel('2026-09-30', '2026-09-23');`), 'Wed, Sep 30', tz);
  }
});

// --- describeLaunches: the Phase 0 baseline --------------------------------
//
// Sweep D2: the metric is DAYS, not opens. Ten resumes in one evening are one
// day of use. A day is the device's LOCAL calendar date, and the window is the
// last 7 local dates (today and the six before), not a rolling 168 hours.
// Built from local-time Dates so the expectations hold in any zone.

const at = (d, h, m = 0) => new Date(2026, 8, d, h, m).toISOString(); // September 2026, local time
const NOW = new Date(2026, 8, 23, 15, 0); // Wed Sep 23, 3:00 PM local

test('describeLaunches counts distinct local days in the last 7, and says when it was last opened', () => {
  const launches = [
    at(10, 8), // 13 days ago
    at(16, 23), // the day before the window, though under 168 hours ago
    at(17, 8), // today - 6: inside
    at(22, 8),
    at(23, 8),
    at(23, 9), // a second open on the same day is not a second day
  ];
  assert.equal(describeLaunches(launches, NOW), 'Opened on 3 of the last 7 days. Last opened Today, 9:00 AM.');
});

test('describeLaunches names the last open even when it was days ago', () => {
  assert.equal(describeLaunches([at(22, 20, 5)], NOW), 'Opened on 1 of the last 7 days. Last opened Yesterday, 8:05 PM.');
  assert.equal(describeLaunches([at(10, 8)], NOW), 'Not opened in the last 7 days. Last opened Thu, Sep 10, 8:00 AM.');
});

test('describeLaunches uses the latest open, whatever order the log holds', () => {
  assert.equal(describeLaunches([at(23, 9), at(22, 8)], NOW), 'Opened on 2 of the last 7 days. Last opened Today, 9:00 AM.');
});

test('describeLaunches says so plainly when there are none', () => {
  assert.equal(describeLaunches([], NOW), 'Not opened in the last 7 days.');
});

// Across the end of US daylight saving (Sun Nov 1 2026, New York), run in a
// child for the reason given above. Case A kills counting by UTC date (the two
// Nov 1 opens fall on two UTC dates, and the Oct 26 evening open on an in-window
// UTC date) and a rolling 168-hour window (which takes in Oct 26). Case B kills
// a window measured as 6 x 24 hours back from local midnight: across the
// 25-hour Nov 1 that lands at 01:00 on Oct 27 and drops a 00:30 open.
test('describeLaunches counts local days correctly across a DST change', () => {
  const out = inZone('America/New_York', `
    const now = new Date('2026-11-02T13:00:00.000Z'); // Mon Nov 2, 8:00 AM EST
    return [
      f.describeLaunches([
        '2026-10-27T02:00:00.000Z', // Mon Oct 26, 10:00 PM EDT: outside
        '2026-11-01T04:30:00.000Z', // Sun Nov 1, 12:30 AM EDT
        '2026-11-02T04:30:00.000Z', // Sun Nov 1, 11:30 PM EST: the same day
        '2026-11-02T12:00:00.000Z', // Mon Nov 2, 7:00 AM EST
      ], now),
      f.describeLaunches([
        '2026-10-27T04:30:00.000Z', // Tue Oct 27, 12:30 AM EDT: today - 6, inside
        '2026-11-02T12:00:00.000Z',
      ], now),
    ];`);
  assert.deepEqual(out, [
    'Opened on 2 of the last 7 days. Last opened Today, 7:00 AM.',
    'Opened on 2 of the last 7 days. Last opened Today, 7:00 AM.',
  ]);
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
