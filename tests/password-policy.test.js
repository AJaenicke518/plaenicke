import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPassword } from '../js/password-policy.js';
import { COMMON } from '../js/common-passwords.js';

const LEN = 'At least 8 characters';
const NUM = 'At least one number';
const SYM = 'At least one symbol (like ! ? # or a space)';
const COM = 'Too common — pick something less guessable';
const EML = "Don't use your email name in it";

test('short1! fails length only', () => {
  assert.deepEqual(checkPassword('short1!', 'a@x.de').problems, [LEN]);
});
test('longpassword! has no number', () => {
  assert.deepEqual(checkPassword('longpassword!', 'a@x.de').problems, [NUM]);
});
test('longpassword1 has no symbol', () => {
  assert.deepEqual(checkPassword('longpassword1', 'a@x.de').problems, [SYM]);
});
test('Password1! is on the blocklist', () => {
  assert.ok(COMMON.has('password1!'), 'list lacks password1!');
  assert.deepEqual(checkPassword('Password1!', 'a@x.de').problems, [COM]);
});
test('blocklist entries are lowercase and pass composition', () => {
  for (const w of COMMON) {
    assert.equal(w, w.toLowerCase());
    assert.ok(w.length >= 8 && /\p{N}/u.test(w) && /[^\p{L}\p{N}]/u.test(w), w);
  }
});
test('email local part is rejected', () => {
  assert.deepEqual(checkPassword('alex.j2026!', 'alex.j@x.de').problems, [EML]);
  assert.deepEqual(checkPassword('xxALEX.J2026!', 'Alex.J@x.de').problems, [EML]);
});
test('short email local part (<3) is ignored', () => {
  assert.equal(checkPassword('ab-horse-staple7', 'ab@x.de').ok, true);
});
test('correct horse 7 is ok', () => {
  assert.deepEqual(checkPassword('correct horse 7', 'a@x.de'), { ok: true, problems: [] });
});
test('64-character password is ok', () => {
  const pw = 'aB3!' .repeat(16);
  assert.equal(pw.length, 64);
  assert.equal(checkPassword(pw, 'a@x.de').ok, true);
});
test('empty string lists all its problems', () => {
  assert.deepEqual(checkPassword('', 'a@x.de').problems, [LEN, NUM, SYM]);
});
test('missing email does not throw', () => {
  assert.equal(checkPassword('correct horse 7').ok, true);
});
