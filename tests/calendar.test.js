import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthGrid, groupItemsByDate, monthCellSummary, chronoFirst } from '../js/calendar.js';

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

test('monthCellSummary passes small days through with no overflow', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(monthCellSummary(items), { chips: items, more: 0 });
});

test('monthCellSummary caps at maxChips and counts the rest', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const s = monthCellSummary(items);
  assert.deepEqual(s.chips.map(i => i.id), ['a', 'b']);
  assert.equal(s.more, 2);
});

test('chronoFirst puts timed items before untimed items', () => {
  const untimed = { id: 'u1', title: 'Chore' };
  const timed = { id: 't1', title: 'Meeting', time: '09:00' };
  const result = chronoFirst([untimed, timed]);
  assert.deepEqual(result.map(i => i.id), ['t1', 'u1']);
});

test('chronoFirst sorts timed items by time ascending', () => {
  const late = { id: 'late', title: 'Dinner', time: '19:00' };
  const early = { id: 'early', title: 'Standup', time: '09:00' };
  const mid = { id: 'mid', title: 'Lunch', time: '12:30' };
  const result = chronoFirst([late, early, mid]);
  assert.deepEqual(result.map(i => i.id), ['early', 'mid', 'late']);
});

test('chronoFirst preserves relative order among untimed items', () => {
  const u1 = { id: 'u1', title: 'First chore' };
  const u2 = { id: 'u2', title: 'Second chore' };
  const u3 = { id: 'u3', title: 'Third chore' };
  const result = chronoFirst([u1, u2, u3]);
  assert.deepEqual(result.map(i => i.id), ['u1', 'u2', 'u3']);
});

test('chronoFirst passes through an empty array', () => {
  assert.deepEqual(chronoFirst([]), []);
});

test('chronoFirst passes through an all-untimed array unchanged (relative order)', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(chronoFirst(items).map(i => i.id), ['a', 'b', 'c']);
});

test('chronoFirst returns a new array, not the same reference', () => {
  const items = [{ id: 'a', time: '10:00' }];
  const result = chronoFirst(items);
  assert.notEqual(result, items);
});
