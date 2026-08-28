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

// =========================================================================
// V6 — the FOURTH copy of the type list.
//
// Found in production on 2026-08-28, after the V6 Worker deploy: every
// to-do and idea still came back as `event`. The prompt was right, the
// schema was right, and normalizeClaudeJson silently rewrote the model's
// correct answer on its way out — `TYPES.includes(it.type) ? it.type :
// 'event'` is a coercing allowlist, so an unlisted type is not rejected
// loudly, it is REPLACED. The V6 review passes pinned js/preview.js
// against this schema and never looked here.
// =========================================================================

test('preserves task — the model classifying a to-do must survive normalize', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'Look into utilities for housing', date: '2026-08-28', type: 'task',
      project: null, subject: null, category: null },
  ]});
  assert.equal(r.items[0].type, 'task',
    "coerced to 'event' means the item never reaches the To-do page");
});

test('preserves idea', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'Snooze a task to next week', date: '2026-08-28', type: 'idea',
      project: null, subject: null, category: null },
  ]});
  assert.equal(r.items[0].type, 'idea');
});

// The drift guard. prompt.test.js already pins the schema's enum; nothing
// tied normalize's allowlist to it, which is exactly how these two got out
// of step. Any future type added to one and not the other fails here.
test('normalize accepts precisely the types the schema can return', async () => {
  const { buildRequestBody } = await import('../src/prompt.js');
  const schemaTypes = buildRequestBody('x', '2026-08-28')
    .output_config.format.schema.properties.items.items.properties.type.enum;

  for (const t of schemaTypes) {
    const r = normalizeClaudeJson({ needsReview: false, items: [
      { title: 't', date: '2026-08-28', type: t, project: null, subject: null, category: null },
    ]});
    assert.equal(r.items[0].type, t,
      `the schema lets the model return '${t}' but normalize rewrites it to '${r.items[0].type}'`);
  }
});
