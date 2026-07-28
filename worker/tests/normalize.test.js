import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeJson } from '../src/normalize.js';

const GOOD = {
  needsReview: false,
  items: [{ title: 'First draft', date: '2026-05-15', type: 'milestone',
    project: 'Physics paper', subject: 'Physics', category: 'School' }],
};

test('passes a well-formed single item through', () => {
  const r = normalizeClaudeJson(GOOD);
  assert.equal(r.needsReview, false);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, 'milestone');
});

test('drops items missing a valid ISO date and flags review', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'ok', date: '2026-05-15', type: 'due', project: null, subject: null, category: null },
    { title: 'bad', date: 'next week', type: 'due', project: null, subject: null, category: null },
  ]});
  assert.equal(r.items.length, 1);
  assert.equal(r.needsReview, true);
});

test('clamps an unknown type to event and unknown category to null', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'x', date: '2026-05-15', type: 'submit', project: null, subject: null, category: 'Gym' },
  ]});
  assert.equal(r.items[0].type, 'event');
  assert.equal(r.items[0].category, null);
});

test('returns empty list for garbage input', () => {
  assert.deepEqual(normalizeClaudeJson(null), { items: [], needsReview: true });
  assert.deepEqual(normalizeClaudeJson({ items: 'nope' }), { items: [], needsReview: true });
});

test('passes valid time and endTime through', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'Dentist', date: '2026-08-04', time: '14:00', endTime: '15:00',
      type: 'event', project: null, subject: null, category: null },
  ]});
  assert.equal(r.items[0].time, '14:00');
  assert.equal(r.items[0].endTime, '15:00');
});

test('nulls malformed times without dropping the item', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'x', date: '2026-08-04', time: '2pm', endTime: '99:99',
      type: 'event', project: null, subject: null, category: null },
  ]});
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].time, null);
  assert.equal(r.items[0].endTime, null);
});

test('nulls endTime when it is missing a start or not after it', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'no-start', date: '2026-08-04', time: null, endTime: '15:00',
      type: 'event', project: null, subject: null, category: null },
    { title: 'backwards', date: '2026-08-04', time: '15:00', endTime: '14:00',
      type: 'event', project: null, subject: null, category: null },
  ]});
  assert.equal(r.items[0].endTime, null);
  assert.equal(r.items[1].time, '15:00');
  assert.equal(r.items[1].endTime, null);
});

test('items with no time fields at all normalize to nulls', () => {
  const r = normalizeClaudeJson(GOOD);
  assert.equal(r.items[0].time, null);
  assert.equal(r.items[0].endTime, null);
});
