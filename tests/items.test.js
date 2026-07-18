import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeItem, sortItemsByDate } from '../js/items.js';

test('makeItem builds an item with type and tags, trims title', () => {
  const it = makeItem(
    { title: '  First draft  ', date: '2026-05-15', type: 'milestone',
      project: 'Physics paper', subject: 'Physics', category: 'School' },
    { id: 'a', createdAt: '2026-07-18' });
  assert.deepEqual(it, {
    id: 'a', title: 'First draft', date: '2026-05-15', createdAt: '2026-07-18',
    type: 'milestone', project: 'Physics paper', subject: 'Physics', category: 'School',
  });
});

test('makeItem defaults type to general and tags to null', () => {
  const it = makeItem({ title: 'Buy milk', date: '2026-05-15' }, { id: 'b', createdAt: '2026-07-18' });
  assert.equal(it.type, 'general');
  assert.equal(it.project, null);
  assert.equal(it.category, null);
});

test('makeItem rejects an empty title', () => {
  assert.throws(() => makeItem({ title: '  ', date: '2026-05-15' }, { id: 'c', createdAt: 'x' }),
    /Title is required/);
});

test('makeItem rejects a missing date', () => {
  assert.throws(() => makeItem({ title: 'x', date: '' }, { id: 'c', createdAt: 'x' }),
    /Date is required/);
});

test('sortItemsByDate orders soonest first without mutating input', () => {
  const input = [
    { id: '1', title: 'B', date: '2026-07-10', createdAt: 'x' },
    { id: '2', title: 'A', date: '2026-07-02', createdAt: 'x' },
  ];
  assert.deepEqual(sortItemsByDate(input).map(i => i.id), ['2', '1']);
  assert.equal(input[0].id, '1');
});
