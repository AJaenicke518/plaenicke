import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFlow } from '../js/smartadd.js';

test('single confident item → direct', () => {
  assert.equal(decideFlow({ items: [{}], needsReview: false }), 'direct');
});

test('single item but needsReview → preview', () => {
  assert.equal(decideFlow({ items: [{}], needsReview: true }), 'preview');
});

test('multiple items → preview', () => {
  assert.equal(decideFlow({ items: [{}, {}], needsReview: false }), 'preview');
});

test('no items → empty', () => {
  assert.equal(decideFlow({ items: [], needsReview: false }), 'empty');
});
