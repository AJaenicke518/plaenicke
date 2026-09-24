import { test } from 'node:test';
import assert from 'node:assert/strict';

// scrolllock.js — the ONE page scroll lock shared by the item sheet and the
// Settings panel (sweep F, UI O2). Each kept its own and put back what it
// found, so closing them in the "wrong" order left the page unlocked under an
// open sheet, or locked with nothing open.
globalThis.document = { body: { style: { overflow: '' } } };
const { lock } = await import('../js/scrolllock.js');
const body = () => globalThis.document.body.style;

test('one holder locks the page and its release puts back what was there', () => {
  body().overflow = 'clip';
  const release = lock();
  assert.equal(body().overflow, 'hidden');
  release();
  assert.equal(body().overflow, 'clip');
  body().overflow = '';
});

test('the page stays locked until every holder has released, in either order', () => {
  for (const firstOut of [0, 1]) {
    body().overflow = '';
    const holders = [lock(), lock()];
    assert.equal(body().overflow, 'hidden');
    holders[firstOut]();
    assert.equal(body().overflow, 'hidden', 'one holder is still open');
    holders[1 - firstOut]();
    assert.equal(body().overflow, '');
  }
});

// A release is a holder's own: running it twice must not release a lock that
// another holder still has.
test('a release runs once; a second call does not unlock another holder', () => {
  body().overflow = '';
  const a = lock();
  const b = lock();
  a();
  a();
  assert.equal(body().overflow, 'hidden', 'b still holds the lock');
  b();
  assert.equal(body().overflow, '');
});
