import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toISO, nowISO, localStamp } from '../js/dateparse.js';

process.env.TZ = 'America/Los_Angeles';

test('toISO formats a local date', () => {
  assert.equal(toISO(new Date(2026, 6, 2)), '2026-07-02');
});

// nowISO is the shared helper (regression for the "-2" -> full-precision UTC
// timestamp fix): it must produce a full-precision UTC instant, never a
// day-only calendar date like toISO — the three timestamp paths (item
// updatedAt, feed updatedAt, tombstone deletedAt) all depend on this shape
// so sync's last-write-wins comparisons stay apples-to-apples.
test('nowISO returns a full-precision UTC instant, not a day-only date', () => {
  const iso = nowISO();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(iso, new Date(iso).toISOString(), 'must round-trip through Date exactly');
});

test('nowISO differs in shape from toISO for the same instant', () => {
  const d = new Date('2026-08-01T22:05:00.000Z');
  assert.notEqual(toISO(d), d.toISOString());
});

// Daily fixes 2026-10-27, item 2: a new record's createdAt. LOCAL wall-clock
// time, so its first ten characters are toISO's local date — every record
// written before this (date-only) still compares correctly as a string.
test('localStamp is the local date and time to the millisecond, prefixed by toISO', () => {
  const d = new Date(2026, 9, 27, 9, 5, 3, 7);
  assert.equal(localStamp(d), '2026-10-27T09:05:03.007');
  assert.equal(localStamp(d).slice(0, 10), toISO(d));
  // 23:59 local is the next day in UTC; the stamp must stay on the local day.
  const late = new Date(2026, 9, 27, 23, 59, 59, 999);
  assert.equal(localStamp(late), '2026-10-27T23:59:59.999');
  assert.notEqual(late.toISOString().slice(0, 10), '2026-10-27', 'fixture check: UTC is already tomorrow');
});
