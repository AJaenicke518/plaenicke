import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_KDF_ITERS, KDF_ITERS, newSalt, derivePasswordKeys, newRecoveryCode, deriveRecoveryKeys,
  wrapDek, unwrapDek, dekCheck, _masterKeyForTest,
} from '../js/keys.js';
import { bytesToBase64url, base64urlToBytes, generateEncKey } from '../js/crypto.js';

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const LOW = { minKdfIters: 1 };
const salt = () => bytesToBase64url(newSalt());

test('constants', () => {
  assert.equal(MIN_KDF_ITERS, 600000);
  assert.equal(KDF_ITERS, 600000);
  assert.equal(newSalt().length, 16);
});

test('PBKDF2-HMAC-SHA-256 known answer through the module path', async () => {
  // python3 -c "import hashlib;print(hashlib.pbkdf2_hmac('sha256',b'password',b'salt',1,32).hex())"
  const mk = await _masterKeyForTest('password', new TextEncoder().encode('salt'), 1);
  assert.equal(hex(new Uint8Array(mk)), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
});

test('HKDF-SHA-256 RFC 5869 test case 1 via WebCrypto', async () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: fromHex('000102030405060708090a0b0c'), info: fromHex('f0f1f2f3f4f5f6f7f8f9'),
  }, k, 256);
  assert.equal(hex(new Uint8Array(bits)), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf');
});

test('rejects iterations below the floor', async () => {
  await assert.rejects(derivePasswordKeys('pw', salt(), 599999), { message: 'kdf_iters_too_low' });
});

test('rejects a salt that is not 16 bytes', async () => {
  await assert.rejects(derivePasswordKeys('pw', bytesToBase64url(new Uint8Array(15)), 1, LOW), { message: 'bad_salt' });
});

test('deterministic; password and salt both matter', async () => {
  const s = salt();
  const a = await derivePasswordKeys('pw', s, 1, LOW);
  const b = await derivePasswordKeys('pw', s, 1, LOW);
  const c = await derivePasswordKeys('pw2', s, 1, LOW);
  const d = await derivePasswordKeys('pw', salt(), 1, LOW);
  assert.equal(base64urlToBytes(a.authKey).length, 32);
  assert.equal(a.authKey, b.authKey);
  assert.notEqual(a.authKey, c.authKey);
  assert.notEqual(a.authKey, d.authKey);
});

test('wrap keys are non-extractable', async () => {
  const { wrapKey } = await derivePasswordKeys('pw', salt(), 1, LOW);
  await assert.rejects(crypto.subtle.exportKey('raw', wrapKey));
  const rec = await deriveRecoveryKeys(newRecoveryCode());
  await assert.rejects(crypto.subtle.exportKey('raw', rec.wrapKey));
});

test('wrap round trip, AAD kind binding, wrong key', async () => {
  const s = salt();
  const k = (await derivePasswordKeys('pw', s, 1, LOW)).wrapKey;
  const other = (await derivePasswordKeys('other', s, 1, LOW)).wrapKey;
  const dek = generateEncKey();
  const wrapped = await wrapDek(k, dek, 'pw');
  assert.equal(atob(wrapped).length, 60);
  assert.match(wrapped, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(await unwrapDek(k, wrapped, 'pw'), dek);
  await assert.rejects(unwrapDek(k, wrapped, 'rec'), { message: 'unwrap_failed' });
  await assert.rejects(unwrapDek(other, wrapped, 'pw'), { message: 'unwrap_failed' });
  await assert.rejects(unwrapDek(k, 'AAAA', 'pw'), { message: 'unwrap_failed' });
  await assert.rejects(wrapDek(k, dek, 'bogus'));
});

test('recovery code: 22 chars, 16 bytes, distinct; keys derive and wrap', async () => {
  const seen = new Set();
  for (let i = 0; i < 100; i += 1) {
    const c = newRecoveryCode();
    assert.match(c, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(base64urlToBytes(c).length, 16);
    seen.add(c);
  }
  assert.equal(seen.size, 100);
  const code = newRecoveryCode();
  const a = await deriveRecoveryKeys(code);
  const b = await deriveRecoveryKeys(code);
  assert.equal(a.recAuthKey, b.recAuthKey);
  assert.equal(base64urlToBytes(a.recAuthKey).length, 32);
  const dek = generateEncKey();
  assert.deepEqual(await unwrapDek(b.wrapKey, await wrapDek(a.wrapKey, dek, 'rec'), 'rec'), dek);
  await assert.rejects(deriveRecoveryKeys('short'), { message: 'bad_recovery_code' });
  await assert.rejects(deriveRecoveryKeys(bytesToBase64url(new Uint8Array(15))), { message: 'bad_recovery_code' });
});

test('recAuthKey differs from authKey derived from same bytes (info separation)', async () => {
  const code = newRecoveryCode();
  const { recAuthKey } = await deriveRecoveryKeys(code);
  const pw = await derivePasswordKeys(code, salt(), 1, LOW);
  assert.notEqual(recAuthKey, pw.authKey);
});

test('dekCheck: 64 hex, stable, differs per DEK', async () => {
  const a = generateEncKey();
  const b = generateEncKey();
  const h = await dekCheck(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await dekCheck(a));
  assert.notEqual(h, await dekCheck(b));
});

test('NFKC: ligature and plain letters derive the same authKey', async () => {
  const s = salt();
  const a = await derivePasswordKeys('ﬁ', s, 1, LOW);
  const b = await derivePasswordKeys('fi', s, 1, LOW);
  assert.equal(a.authKey, b.authKey);
});

test('real 600k iteration smoke test', async () => {
  const r = await derivePasswordKeys('pw', salt(), KDF_ITERS);
  assert.equal(base64urlToBytes(r.authKey).length, 32);
});

// Golden vectors computed independently of js/keys.js. Source (python3, hashlib/hmac only):
// import hashlib, hmac, base64
// def hkdf(ikm, info, salt=b'\x00'*32, n=32):
//     prk = hmac.new(salt, ikm, hashlib.sha256).digest()
//     out=b'';t=b'';i=1
//     while len(out)<n:
//         t=hmac.new(prk,t+info+bytes([i]),hashlib.sha256).digest();out+=t;i+=1
//     return out[:n]
// b64u=lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
// salt=bytes(range(1,17))
// m=hashlib.pbkdf2_hmac('sha256','correct horse 7'.encode(),salt,1000,32)
// print('salt',b64u(salt))
// print('auth',b64u(hkdf(m,b'plaenicke/v1/auth')))
// print('wrap',hkdf(m,b'plaenicke/v1/wrap').hex())
// rc=bytes(range(0xa0,0xb0))
// print('rc',b64u(rc))
// print('recauth',b64u(hkdf(rc,b'plaenicke/v1/rec-auth')))
// print('recwrap',hkdf(rc,b'plaenicke/v1/rec-wrap').hex())
//
const GOLD_SALT = 'AQIDBAUGBwgJCgsMDQ4PEA';
const GOLD_AUTH = '9noINOUGm3xAW5A1nDS83dkRjTkHn1M11IyRbJUMWXI';
const GOLD_WRAP = 'be987b0a9f8c883358261f16a8f295350c9368b32c891e813a96232c4ef611b9';
const GOLD_CODE = 'oKGio6SlpqeoqaqrrK2urw';
const GOLD_RECAUTH = 'pHNP1LuBJWp_1oYgqkBa4NAgVDYyGJPuKznSTXjrkas';
const GOLD_RECWRAP = 'e4d3c91538e408fff690b5a763eb3236fe67128614d066d593b490ec4913fac7';

async function independentWrap(rawHex, dek, aad) {
  const key = await crypto.subtle.importKey('raw', fromHex(rawHex), 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).fill(7);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, dek));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return btoa(String.fromCharCode(...out));
}

test('golden: password authKey and wrapKey match independent derivation', async () => {
  const { authKey, wrapKey } = await derivePasswordKeys('correct horse 7', GOLD_SALT, 1000, { minKdfIters: 1000 });
  assert.equal(authKey, GOLD_AUTH);
  const dek = new Uint8Array(32).fill(9);
  const wrapped = await independentWrap(GOLD_WRAP, dek, 'plaenicke/v1/dek-pw');
  assert.deepEqual(await unwrapDek(wrapKey, wrapped, 'pw'), dek);
});

test('golden: recovery recAuthKey and wrapKey match independent derivation', async () => {
  assert.equal(bytesToBase64url(Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)), GOLD_CODE);
  const { recAuthKey, wrapKey } = await deriveRecoveryKeys(GOLD_CODE);
  assert.equal(recAuthKey, GOLD_RECAUTH);
  const dek = new Uint8Array(32).fill(9);
  const wrapped = await independentWrap(GOLD_RECWRAP, dek, 'plaenicke/v1/dek-rec');
  assert.deepEqual(await unwrapDek(wrapKey, wrapped, 'rec'), dek);
  await assert.rejects(unwrapDek(wrapKey, wrapped, 'pw'), { message: 'unwrap_failed' });
});
