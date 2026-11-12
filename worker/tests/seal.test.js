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
