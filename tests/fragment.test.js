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

// Sweep W3-I6: a damaged link used to be dropped silently (null), so the
// tester tapped a link and nothing happened. It now opens the form, says the
// link is damaged, and carries no code.
test('empty code is a malformed intent, and the hash is still stripped', () => {
  for (const [h, kind] of [['#invite=', 'invite'], ['#recover=', 'recover']]) {
    const e = env(h);
    assert.deepEqual(readBootIntent(e), { kind, code: null, malformed: true });
    assert.deepEqual(e.calls, [[null, '', '/plaenicke/?x=1']]);
  }
});

test('non-base64url code is a malformed intent, and the hash is still stripped', () => {
  for (const h of ['#invite=ab+c', '#invite=a/b', '#recover=a=b', '#invite=ab c', '#invite=ab&x=1', '#invite=a=']) {
    const e = env(h);
    const got = readBootIntent(e);
    assert.equal(got.malformed, true, h);
    assert.equal(got.code, null, h);
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

// Sweep W2-I7 (SEC #10): the boot fragment carries an invite or a recovery
// code. app.js read it near the END of module evaluation, so anything above
// that threw (a missing element, a storage error) left the code in the URL —
// in history, and on screen. It must be the first statement app.js runs
// after its imports. Checked on the source: app.js is evaluated once per
// test process, so a behavioural test of an early throw cannot re-run it.
import { readFileSync } from 'node:fs';
test('W2-I7: app.js reads (and strips) the boot fragment before any other statement', () => {
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  // Drop the import declarations (single- and multi-line), then blank lines.
  const body = src.replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '').split('\n').filter((l) => l.trim() !== '');
  assert.match(body[0], /^const bootIntent = readBootIntent\(\{ location: window\.location, history: window\.history \}\);$/,
    `first statement after the imports: ${body[0]}`);
  assert.equal(src.match(/readBootIntent\(/g).length, 1, 'read exactly once');
});
