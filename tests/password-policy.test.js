import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPassword } from '../js/password-policy.js';
import { COMMON } from '../js/common-passwords.js';

const LEN = 'At least 8 characters';
const NUM = 'At least one number';
const SYM = 'At least one symbol (like ! ? # or a space)';
const COM = 'Too common — pick something less guessable';
const EML = "Don't use your email name in it";

// 'short1!' was this fixture until R19: 'short' is a common base word now.
test('a 7-character password fails length only', () => {
  assert.deepEqual(checkPassword('kwzq1!x', 'a@x.de').problems, [LEN]);
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

// --- sweep W2 observations (TEST M10/M11, Task 9 deferred NFKC) -----------

test('W2: exactly 8 characters is accepted; 7 is not', () => {
  assert.deepEqual(checkPassword('qz7!kwrm', 'a@x.de'), { ok: true, problems: [] });
  assert.deepEqual(checkPassword('qz7!kwr', 'a@x.de').problems, [LEN]);
});

test('W2: length counts characters, not UTF-16 units (an astral character is one)', () => {
  const seven = '😀😀😀😀😀1!';            // 7 characters, 12 UTF-16 units
  assert.equal(seven.length, 12);
  assert.deepEqual(checkPassword(seven, 'a@x.de').problems, [LEN]);
  assert.equal(checkPassword(`${seven}x`, 'a@x.de').ok, true);
});

// keys.js derives from password.normalize('NFKC'), so the policy must judge
// the same string: a fullwidth 'Ｐassword1！' IS 'Password1!' to the KDF.
test('W2: the blocklist and the email check see the NFKC form (fullwidth characters)', () => {
  assert.deepEqual(checkPassword('Ｐassword1！', 'a@x.de').problems, [COM]);
  assert.deepEqual(checkPassword('ａｌｅｘ.j2026!', 'alex.j@x.de').problems, [EML]);
  assert.deepEqual(checkPassword('alex.j2026!', 'ａｌｅｘ.j@x.de').problems, [EML], 'the email is normalized too');
});

test('W2: the blocklist is not accidentally emptied (size floor)', () => {
  assert.ok(COMMON.size >= 3600, `COMMON has ${COMMON.size} entries`);
});

// --- sweep W3, controller ruling R19 (SEC #3): base words -------------------
//
// The exact-match blocklist stops 'Password1!' but not 'Summer2024!': a
// common word dressed with a number and a symbol. checkPassword reduces the
// password to its base (baseWord) and refuses one on js/common-bases.js.

const BASE = 'Too close to a common password — add something unusual';

test('R19: a common word dressed with digits and a symbol is refused', async () => {
  for (const pw of ['Summer2024!', 'Football1!', 'Monkey123!', 'Abcd1234!', 'Plaenicke1!']) {
    assert.deepEqual(checkPassword(pw, 'a@x.de').problems, [BASE], pw);
  }
});

test('R19: simple leetspeak inside the word is undone (p@ssw0rd-style)', async () => {
  const { baseWord } = await import('../js/password-policy.js');
  assert.equal(baseWord('M0nk3y123!'), 'monkey');
  assert.equal(baseWord('$umm3r2024!'), 'ummer', 'a leading non-letter run is dropped whole, as at the end');
  assert.equal(baseWord('Fo0tb@ll!7'), 'football');
  assert.equal(baseWord('correct horse 7'), 'correcthorse');
  assert.deepEqual(checkPassword('M0nk3y123!', 'a@x.de').problems, [BASE]);
});

test('R19: passphrases and random passwords still pass', () => {
  assert.deepEqual(checkPassword('correct horse 7', 'a@x.de'), { ok: true, problems: [] });
  assert.deepEqual(checkPassword('vT8#qLm2!xRw', 'a@x.de'), { ok: true, problems: [] });
});

test('R19: an exact blocklist hit says Too common once, not both', () => {
  assert.deepEqual(checkPassword('Password1!', 'a@x.de').problems, [COM]);
});

test('R19: the base list is lowercase letters only, at least 4 long, includes plaenicke and lmu, and is not emptied', async () => {
  const { COMMON_BASES } = await import('../js/common-bases.js');
  assert.ok(COMMON_BASES.size >= 5000, `COMMON_BASES has ${COMMON_BASES.size}`);
  assert.ok(COMMON_BASES.has('plaenicke') && COMMON_BASES.has('lmu'));
  for (const b of COMMON_BASES) {
    if (b === 'lmu') continue; // supplementary, by ruling
    assert.match(b, /^\p{Ll}{4,}$/u, b);
  }
});

test('R19: a 3-letter base (lmu, supplementary) is refused too', () => {
  assert.deepEqual(checkPassword('Lmu2026!!', 'a@x.de').problems, [BASE]);
});
