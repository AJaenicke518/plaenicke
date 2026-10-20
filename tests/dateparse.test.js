import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toISO, nowISO } from '../js/dateparse.js';

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
