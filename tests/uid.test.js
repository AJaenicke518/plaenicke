import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../js/uid.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('uid returns a bare uuid with no prefix', () => {
  assert.match(uid(), UUID_RE);
});

test('uid prefixes when asked', () => {
  const id = uid('feed');
  assert.ok(id.startsWith('feed-'));
  assert.match(id.slice('feed-'.length), UUID_RE);
});

test('uid does not collide across many calls', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) seen.add(uid());
  assert.equal(seen.size, 5000);
});
