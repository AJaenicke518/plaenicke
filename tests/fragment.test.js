import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBootIntent } from '../js/fragment.js';

function env(hash, pathname = '/plaenicke/', search = '?x=1') {
  const calls = [];
  return {
    calls,
    location: { hash, pathname, search },
    history: { replaceState: (...a) => calls.push(a) },
  };
}

test('#invite=ABC returns the invite intent and strips the hash', () => {
  const e = env('#invite=ABC');
  assert.deepEqual(readBootIntent(e), { kind: 'invite', code: 'ABC' });
  assert.deepEqual(e.calls, [[null, '', '/plaenicke/?x=1']]);
});

test('#recover=X returns the recover intent and strips the hash', () => {
  const e = env('#recover=X_-9');
  assert.deepEqual(readBootIntent(e), { kind: 'recover', code: 'X_-9' });
  assert.equal(e.calls.length, 1);
});

test('#other returns null and does not touch history', () => {
  const e = env('#other');
  assert.equal(readBootIntent(e), null);
  assert.equal(e.calls.length, 0);
});

test('no hash returns null and does not touch history', () => {
  const e = env('');
  assert.equal(readBootIntent(e), null);
  assert.equal(e.calls.length, 0);
});

test('empty code returns null but still strips the hash', () => {
  for (const h of ['#invite=', '#recover=']) {
    const e = env(h);
    assert.equal(readBootIntent(e), null);
    assert.deepEqual(e.calls, [[null, '', '/plaenicke/?x=1']]);
  }
});

test('non-base64url code returns null but still strips the hash', () => {
  for (const h of ['#invite=ab+c', '#invite=a/b', '#recover=a=b', '#invite=ab c', '#invite=ab&x=1', '#invite=a=']) {
    const e = env(h);
    assert.equal(readBootIntent(e), null, h);
    assert.equal(e.calls.length, 1, h);
  }
});

test('near-miss keys are not intents', () => {
  for (const h of ['#invitex=ABC', '#Invite=ABC', '#invite', '#recover']) {
    const e = env(h);
    assert.equal(readBootIntent(e), null, h);
    assert.equal(e.calls.length, 0, h);
  }
});
