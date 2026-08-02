import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64url, base64urlToBytes, generateEncKey, composeLinkCode,
  parseLinkCode, composeForNewDevice, encryptBlob, decryptBlob, IV_BYTES, KEY_BYTES,
} from '../js/crypto.js';

// Exactly the encoding worker/src/auth.js uses. If ours differs by one
// character the Bearer token never matches the stored hash.
function workerStyleToken(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const allBytes = () => Uint8Array.from({ length: 256 }, (_, i) => i);

test('bytesToBase64url matches the Worker encoding for all 256 byte values', () => {
  assert.equal(bytesToBase64url(allBytes()), workerStyleToken(allBytes()));
});

test('base64url round-trips every byte value without loss', () => {
  assert.deepEqual([...base64urlToBytes(bytesToBase64url(allBytes()))], [...allBytes()]);
});

test('base64urlToBytes rejects non-base64url input', () => {
  assert.throws(() => base64urlToBytes('has spaces'));
  assert.throws(() => base64urlToBytes('plus+slash/'));
  assert.throws(() => base64urlToBytes(''));
});

test('generateEncKey returns 32 fresh bytes', () => {
  const a = generateEncKey(), b = generateEncKey();
  assert.equal(a.length, KEY_BYTES);
  assert.notDeepEqual([...a], [...b]);
});

test('a composed link code parses back to the EXACT token string the Worker hashed', () => {
  const token = workerStyleToken(generateEncKey());
  const encKey = generateEncKey();
  const code = composeLinkCode(token, encKey);
  assert.equal(code.length, 86);
  const parsed = parseLinkCode(code);
  assert.equal(parsed.authToken, token);
  assert.deepEqual([...parsed.encKey], [...encKey]);
});

test('parseLinkCode rejects a bare token, a truncated code, and junk', () => {
  const token = workerStyleToken(generateEncKey());
  assert.throws(() => parseLinkCode(token));
  assert.throws(() => parseLinkCode(token + 'AA'));
  assert.throws(() => parseLinkCode('!!!'));
  assert.throws(() => parseLinkCode(''));
});

// The single most dangerous mistake in the linking flow: composing a code for
// a second device with a NEW key means that device can never read the account
// and there is no diagnostic for it.
test('composeForNewDevice reuses the EXISTING key, never a fresh one', () => {
  const encKey = generateEncKey();
  const link = { authToken: workerStyleToken(generateEncKey()), encKey };
  const newToken = workerStyleToken(generateEncKey());
  const parsed = parseLinkCode(composeForNewDevice(newToken, link));
  assert.equal(parsed.authToken, newToken, 'must carry the NEW token');
  assert.deepEqual([...parsed.encKey], [...encKey], 'must carry the EXISTING key');
});

test('encrypt then decrypt round-trips an object', async () => {
  const key = generateEncKey();
  const obj = { schemaVersion: 1, items: [{ id: 'a', title: 'x' }], feeds: [], tombstones: [] };
  assert.deepEqual(await decryptBlob(key, await encryptBlob(key, obj)), obj);
});

// A CONSTANT iv and a COUNTER-derived iv are both catastrophic, and a
// distinctness check over N samples only catches the constant. Spy on the
// entropy source instead: the IV must come from getRandomValues, every time.
test('the IV is drawn from crypto.getRandomValues on every encryption', async () => {
  const key = generateEncKey();
  const real = crypto.getRandomValues.bind(crypto);
  const sizes = [];
  crypto.getRandomValues = (arr) => { sizes.push(arr.length); return real(arr); };
  try {
    await encryptBlob(key, { schemaVersion: 1 });
    await encryptBlob(key, { schemaVersion: 1 });
  } finally {
    crypto.getRandomValues = real;
  }
  assert.deepEqual(sizes, [IV_BYTES, IV_BYTES],
    'each encryption must request exactly one fresh IV from the CSPRNG');
});

test('identical plaintext never produces identical ciphertext', async () => {
  const key = generateEncKey();
  const obj = { schemaVersion: 1, items: [], feeds: [], tombstones: [] };
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    const iv = atob(await encryptBlob(key, obj)).slice(0, IV_BYTES);
    assert.ok(!seen.has(iv), 'IV reused — AES-GCM confidentiality is void');
    seen.add(iv);
  }
});

test('decrypting with the wrong key throws rather than returning garbage', async () => {
  const blob = await encryptBlob(generateEncKey(), { schemaVersion: 1 });
  await assert.rejects(() => decryptBlob(generateEncKey(), blob));
});

test('a tampered ciphertext is rejected by the auth tag', async () => {
  const key = generateEncKey();
  const bytes = Uint8Array.from(atob(await encryptBlob(key, { schemaVersion: 1 })), c => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff;
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  await assert.rejects(() => decryptBlob(key, btoa(bin)));
});

test('decryptBlob rejects malformed input', async () => {
  const key = generateEncKey();
  await assert.rejects(() => decryptBlob(key, 'not base64 at all !!!'));
  await assert.rejects(() => decryptBlob(key, btoa('short')));
});
