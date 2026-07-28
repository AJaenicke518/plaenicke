import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeItem, sortItemsByDate } from '../js/items.js';

test('makeItem builds an item with type and tags, trims title', () => {
  const it = makeItem(
    { title: '  First draft  ', date: '2026-05-15', type: 'milestone',
      project: 'Physics paper', subject: 'Physics', category: 'School' },
    { id: 'a', createdAt: '2026-07-18' });
  assert.deepEqual(it, {
    id: 'a', title: 'First draft', date: '2026-05-15', time: null, endTime: null, createdAt: '2026-07-18',
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

test('makeItem stores time and endTime, defaulting both to null', () => {
  const timed = makeItem({ title: 'Dentist', date: '2026-08-04', time: '14:00', endTime: '15:00' },
    { id: 'd', createdAt: 'x' });
  assert.equal(timed.time, '14:00');
  assert.equal(timed.endTime, '15:00');
  const plain = makeItem({ title: 'Buy milk', date: '2026-08-04' }, { id: 'e', createdAt: 'x' });
  assert.equal(plain.time, null);
  assert.equal(plain.endTime, null);
});

test('makeItem rejects malformed times', () => {
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '2pm' }, { id: 'f', createdAt: 'x' }),
    /Time must be HH:MM/);
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '14:00', endTime: '25:00' }, { id: 'g', createdAt: 'x' }),
    /End time must be HH:MM/);
});

test('makeItem rejects endTime without time, and end not after start', () => {
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', endTime: '15:00' }, { id: 'h', createdAt: 'x' }),
    /End time requires a start time/);
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '15:00', endTime: '15:00' }, { id: 'i', createdAt: 'x' }),
    /End time must be after start time/);
});

test('sortItemsByDate: same date puts untimed first, then timed by time', () => {
  const input = [
    { id: 't2', title: 'B', date: '2026-08-04', time: '15:00', endTime: null, createdAt: 'x' },
    { id: 't1', title: 'A', date: '2026-08-04', time: '09:00', endTime: null, createdAt: 'x' },
    { id: 'u1', title: 'C', date: '2026-08-04', createdAt: 'x' },
  ];
  assert.deepEqual(sortItemsByDate(input).map(i => i.id), ['u1', 't1', 't2']);
});
