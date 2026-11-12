import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atRest, checkKey, AtRestError } from '../src/seal.js';
import { makeD1 } from './fake-d1.js';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'; // 32 bytes base64url
const env = (k = KEY) => ({ AT_REST_KEY: k, DB: makeD1() });

test('mac is deterministic hex and differs per input', async () => {
  const a = await atRest(env());
  assert.equal(await a.mac('x'), await a.mac('x'));
  assert.notEqual(await a.mac('x'), await a.mac('y'));
  assert.match(await a.mac('x'), /^[0-9a-f]{64}$/);
});

test('seal round-trips and carries the k1: prefix', async () => {
  const a = await atRest(env());
  const s = await a.seal('wrapped_dek_pw_sealed', 3, 'hello');
  assert.ok(s.startsWith('k1:'));
  assert.equal(await a.unseal('wrapped_dek_pw_sealed', 3, s), 'hello');
});

test('a sealed value moved to another account or column does not unseal', async () => {
  const a = await atRest(env());
  const s = await a.seal('wrapped_dek_pw_sealed', 3, 'hello');
  await assert.rejects(a.unseal('wrapped_dek_pw_sealed', 4, s));
  await assert.rejects(a.unseal('wrapped_dek_rec_sealed', 3, s));
});

test('missing or malformed key throws not_configured', async () => {
  await assert.rejects(atRest({}), (e) => e instanceof AtRestError && e.code === 'not_configured');
  await assert.rejects(atRest({ AT_REST_KEY: 'short' }), (e) => e.code === 'not_configured');
});

test('checkKey writes on first use and detects a changed key', async () => {
  const e = env();
  await checkKey(e);
  await checkKey(e); // same key: fine
  const other = { AT_REST_KEY: 'HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4', DB: e.DB };
  await assert.rejects(checkKey(other), (err) => err.code === 'at_rest_key_mismatch');
});

test('checkKey reads first and writes only on a miss (no D1 write per request)', async () => {
  const e = env();
  let writes = 0;
  const realPrepare = e.DB.prepare;
  e.DB.prepare = (sql) => { if (/^\s*INSERT/i.test(sql)) writes += 1; return realPrepare(sql); };
  await checkKey(e); await checkKey(e); await checkKey(e);
  assert.equal(writes, 1);
});

// --- sweep W1 (Task 2 deferred, I5, TEST M1) --------------------------------

const isBadSeal = (e) => e instanceof AtRestError && e.code === 'bad_seal';

test('unseal failures are all AtRestError bad_seal: wrong account/column, tampered, bad base64, short, no prefix', async () => {
  const a = await atRest(env());
  const s = await a.seal('wrapped_dek_pw_sealed', 3, 'hello');
  await assert.rejects(a.unseal('wrapped_dek_pw_sealed', 4, s), isBadSeal);
  await assert.rejects(a.unseal('wrapped_dek_rec_sealed', 3, s), isBadSeal);
  const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
  await assert.rejects(a.unseal('wrapped_dek_pw_sealed', 3, flipped), isBadSeal);
  await assert.rejects(a.unseal('wrapped_dek_pw_sealed', 3, 'k1:!!!not base64'), isBadSeal);
  await assert.rejects(a.unseal('wrapped_dek_pw_sealed', 3, 'k1:AAAA'), isBadSeal);
  await assert.rejects(a.unseal('wrapped_dek_pw_sealed', 3, s.slice(3)), isBadSeal);
  await assert.rejects(a.unseal('wrapped_dek_pw_sealed', 3, null), isBadSeal);
});

test('mac and seal refuse non-strings instead of coercing them', async () => {
  const a = await atRest(env());
  for (const v of [undefined, null, 5, {}, ['x']]) {
    await assert.rejects(a.mac(v), TypeError);
    await assert.rejects(a.seal('wrapped_dek_pw_sealed', 3, v), TypeError);
  }
});

test('atRest is memoized per key string', async () => {
  const a1 = await atRest({ AT_REST_KEY: KEY });
  const a2 = await atRest({ AT_REST_KEY: KEY });
  assert.equal(a1, a2);
  const b = await atRest({ AT_REST_KEY: 'HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4' });
  assert.notEqual(a1, b);
});

test('checkKey without env.DB is not_configured', async () => {
  await assert.rejects(checkKey({ AT_REST_KEY: KEY }), (e) => e instanceof AtRestError && e.code === 'not_configured');
});

test('checkKey on a fresh isolate cache (new DB wrapper) with the row present issues zero INSERTs', async () => {
  const e = env();
  await checkKey(e); // writes the row
  let writes = 0;
  const fresh = {
    AT_REST_KEY: KEY,
    DB: { prepare: (sql) => { if (/^\s*INSERT/i.test(sql)) writes += 1; return e.DB.prepare(sql); } },
  };
  await checkKey(fresh);
  await checkKey(fresh);
  assert.equal(writes, 0);
});
