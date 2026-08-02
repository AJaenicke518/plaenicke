import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';

test('the double implements the full surface the app uses', () => {
  const ls = installFakeLocalStorage();
  assert.equal(globalThis.localStorage, ls);
  assert.equal(ls.getItem('nope'), null);
  ls.setItem('a', '1');
  assert.equal(ls.getItem('a'), '1');
  assert.equal(ls.length, 1);
  assert.equal(ls.key(0), 'a');
  ls.removeItem('a');
  assert.equal(ls.getItem('a'), null);
  ls.setItem('b', '2');
  ls.clear();
  assert.equal(ls.length, 0);
});

test('setItem coerces to string like the real API', () => {
  const ls = installFakeLocalStorage();
  ls.setItem('n', 5);
  assert.strictEqual(ls.getItem('n'), '5');
});

test('installing again gives a clean store', () => {
  installFakeLocalStorage().setItem('a', '1');
  assert.equal(installFakeLocalStorage().getItem('a'), null);
});
