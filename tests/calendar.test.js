import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthGrid, groupItemsByDate } from '../js/calendar.js';

test('July 2026 grid starts on the right weekday', () => {
  // July 1 2026 is a Wednesday (index 3): three leading blanks.
  const weeks = buildMonthGrid(2026, 6);
  assert.equal(weeks[0][0], null);
  assert.equal(weeks[0][1], null);
  assert.equal(weeks[0][2], null);
  assert.deepEqual(weeks[0][3], { day: 1, date: '2026-07-01' });
});

test('grid weeks are all length 7', () => {
  const weeks = buildMonthGrid(2026, 6);
  for (const w of weeks) assert.equal(w.length, 7);
});

test('grid contains all 31 days of July', () => {
  const days = buildMonthGrid(2026, 6).flat().filter(Boolean).map(c => c.day);
  assert.equal(days.length, 31);
  assert.equal(days[30], 31);
});

test('groupItemsByDate buckets by date', () => {
  const items = [
    { id: '1', title: 'A', date: '2026-07-02', createdAt: 'x' },
    { id: '2', title: 'B', date: '2026-07-02', createdAt: 'x' },
    { id: '3', title: 'C', date: '2026-07-05', createdAt: 'x' },
  ];
  const grouped = groupItemsByDate(items);
  assert.equal(grouped['2026-07-02'].length, 2);
  assert.equal(grouped['2026-07-05'].length, 1);
});
