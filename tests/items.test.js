import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeItem, sortItemsByDate } from '../js/items.js';

test('makeItem builds an item and trims the title', () => {
  const it = makeItem('  Bio midterm  ', '2026-07-02', { id: 'a', createdAt: '2026-07-01' });
  assert.deepEqual(it, { id: 'a', title: 'Bio midterm', date: '2026-07-02', createdAt: '2026-07-01' });
});

test('makeItem rejects an empty title', () => {
  assert.throws(() => makeItem('   ', '2026-07-02', { id: 'a', createdAt: '2026-07-01' }),
    /Title is required/);
});

test('sortItemsByDate orders soonest first without mutating input', () => {
  const input = [
    { id: '1', title: 'B', date: '2026-07-10', createdAt: '2026-07-01' },
    { id: '2', title: 'A', date: '2026-07-02', createdAt: '2026-07-01' },
  ];
  const sorted = sortItemsByDate(input);
  assert.deepEqual(sorted.map(i => i.id), ['2', '1']);
  assert.equal(input[0].id, '1'); // original unchanged
});
