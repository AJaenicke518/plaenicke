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
