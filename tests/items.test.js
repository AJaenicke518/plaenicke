import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeItem, sortItemsByDate } from '../js/items.js';

test('makeItem builds an item with type and tags, trims title', () => {
  const it = makeItem(
    { title: '  First draft  ', date: '2026-05-15', type: 'milestone',
      project: 'Physics paper', subject: 'Physics', category: 'School' },
    { id: 'a', createdAt: '2026-07-18' });
  assert.deepEqual(it, {
    id: 'a', title: 'First draft', date: '2026-05-15', time: null, endTime: null,
    createdAt: '2026-07-18', updatedAt: '2026-07-18',
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

// --- sortItemsByDate: mixed own/external, order-independence -----------------
// Task 6's EventInstance contract always stamps createdAt (date + time-or-
// 00:00), so a merged own++external array is total under this comparator
// regardless of input order — the same permutation must always produce the
// same sorted output. A comparator hole (e.g. one branch not handling an
// external item's fields) would show up as different orderings for different
// permutations of the identical set.

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

test('sortItemsByDate: mixed own/external array sorts identically regardless of input order', () => {
  const own1 = { id: 'own1', title: 'Homework', date: '2026-08-04', time: null, endTime: null, createdAt: '2026-07-01T00:00' };
  const own2 = { id: 'own2', title: 'Chore', date: '2026-08-04', time: '10:00', endTime: null, createdAt: '2026-07-02T00:00' };
  const ext1 = {
    id: 'feedA:e1:2026-08-04:09:00', title: 'Standup', date: '2026-08-04', time: '09:00', endTime: '09:15',
    createdAt: '2026-08-04T09:00', feedId: 'feedA', feedColor: '#f00', external: true,
  };
  const ext2 = {
    id: 'feedA:e2:2026-08-03:null', title: 'All-day trip', date: '2026-08-03', time: null, endTime: null,
    createdAt: '2026-08-03T00:00', feedId: 'feedA', feedColor: '#f00', external: true,
  };
  const set = [own1, own2, ext1, ext2];

  const orderings = permutations(set).map((perm) => sortItemsByDate(perm).map((i) => i.id));
  const [first, ...rest] = orderings;
  for (const ordering of rest) assert.deepEqual(ordering, first);

  // And it's the expected order: date first, then untimed-before-timed, then time.
  assert.deepEqual(first, [ext2.id, own1.id, ext1.id, own2.id]);
});

test('makeItem defaults updatedAt to createdAt', () => {
  const it = makeItem({ title: 'x', date: '2026-05-15' }, { id: 'c', createdAt: '2026-07-18' });
  assert.equal(it.updatedAt, '2026-07-18');
});

test('makeItem honours an explicit updatedAt', () => {
  const it = makeItem({ title: 'x', date: '2026-05-15' },
    { id: 'd', createdAt: '2026-07-18', updatedAt: '2026-07-20' });
  assert.equal(it.updatedAt, '2026-07-20');
});

// Regression for the day-resolution updatedAt bug: app.js's item-construction
// path now passes a full-precision UTC instant (dateparse.js's nowISO()) as
// meta.updatedAt, not app.js's old createdAt fallback (a local YYYY-MM-DD
// date via toISO). makeItem must preserve that full precision verbatim
// rather than truncating it — a day-only updatedAt is what let a tombstone's
// deletedAt lose to a same-day edit's updatedAt and resurrect a deleted item.
test('makeItem preserves a full-precision UTC updatedAt distinct from a day-only createdAt', () => {
  const it = makeItem({ title: 'x', date: '2026-05-15' },
    { id: 'j', createdAt: '2026-08-01', updatedAt: '2026-08-01T22:05:00.000Z' });
  assert.equal(it.updatedAt, '2026-08-01T22:05:00.000Z');
  assert.match(it.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.notEqual(it.updatedAt, it.createdAt);
});
