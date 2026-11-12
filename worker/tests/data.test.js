import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './fake-d1.js';
import { handleGetData, handlePutData, MAX_BLOB_BYTES } from '../src/data.js';

const NOW = '2026-08-01T12:00:00.000Z';
const put = (body) => new Request('https://worker.example/data', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('GET returns the seeded empty state', async () => {
  const env = { DB: makeD1() };
  const res = await handleGetData(env, 1);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 0, blob: '' });
});

test('PUT at the current version succeeds and bumps to version + 1', async () => {
  const env = { DB: makeD1() };
  const res = await handlePutData(put({ version: 0, blob: 'cipher-a' }), env, NOW, 1);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 1 });
  assert.deepEqual(await (await handleGetData(env, 1)).json(), { version: 1, blob: 'cipher-a' });
});

test('PUT at a stale version is rejected and returns current server state', async () => {
  const env = { DB: makeD1() };
  await handlePutData(put({ version: 0, blob: 'from-laptop' }), env, NOW, 1);

  const res = await handlePutData(put({ version: 0, blob: 'from-phone' }), env, NOW, 1);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'version_conflict');
  assert.equal(body.version, 1);
  assert.equal(body.blob, 'from-laptop');

  // The losing write must not have landed.
  assert.equal((await (await handleGetData(env, 1)).json()).blob, 'from-laptop');
});

test('the client can merge and retry at the returned version', async () => {
  const env = { DB: makeD1() };
  await handlePutData(put({ version: 0, blob: 'a' }), env, NOW, 1);
  const conflict = await (await handlePutData(put({ version: 0, blob: 'b' }), env, NOW, 1)).json();
  const res = await handlePutData(put({ version: conflict.version, blob: 'merged' }), env, NOW, 1);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 2 });
});

test('PUT rejects malformed bodies', async () => {
  const env = { DB: makeD1() };
  assert.equal((await handlePutData(put('not json'), env, NOW, 1)).status, 400);
  assert.equal((await handlePutData(put({ blob: 'x' }), env, NOW, 1)).status, 400);
  assert.equal((await handlePutData(put({ version: 0 }), env, NOW, 1)).status, 400);
  assert.equal((await handlePutData(put({ version: '0', blob: 'x' }), env, NOW, 1)).status, 400);
  assert.equal((await handlePutData(put({ version: 1.5, blob: 'x' }), env, NOW, 1)).status, 400);
});

test('PUT rejects an oversized blob without writing it', async () => {
  const env = { DB: makeD1() };
  const res = await handlePutData(put({ version: 0, blob: 'x'.repeat(MAX_BLOB_BYTES + 1) }), env, NOW, 1);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'blob_too_large');
  assert.equal((await (await handleGetData(env, 1)).json()).version, 0);
});

// Boundary: a blob of exactly the cap is legal. Without this, flipping the
// `>` to `>=` — rejecting a maximum-size blob the client is entitled to
// send — survives the whole suite.
test('PUT accepts a blob of exactly the cap', async () => {
  const env = { DB: makeD1() };
  const res = await handlePutData(put({ version: 0, blob: 'x'.repeat(MAX_BLOB_BYTES) }), env, NOW, 1);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 1 });
});

// The cap is BYTES, not UTF-16 code units. 400,000 CJK characters is well
// under a 1,000,000-character cap but 1.2 MB of UTF-8 — measuring `.length`
// would let it through to an unhandled D1 row-size rejection.
test('the cap counts UTF-8 bytes, not characters', async () => {
  const env = { DB: makeD1() };
  const blob = '中'.repeat(400_000); // 3 bytes each = 1,200,000 bytes
  assert.ok(blob.length < MAX_BLOB_BYTES, 'blob must be under the cap as characters');
  const res = await handlePutData(put({ version: 0, blob }), env, NOW, 1);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'blob_too_large');
  assert.equal((await (await handleGetData(env, 1)).json()).version, 0);
});

test('an error response never echoes the submitted blob', async () => {
  const env = { DB: makeD1() };
  const secret = 'https://calendar.google.com/private-abc123/basic.ics';
  const res = await handlePutData(put({ version: 99, blob: secret }), env, NOW, 1);
  assert.equal(res.status, 409);
  assert.ok(!(await res.text()).includes('private-abc123'));
});

// Mutation-check addition: the prescribed "malformed bodies" test never
// exercises a negative version. Without the `version < 0` guard this falls
// through to the CAS UPDATE, which just never matches a row (versions never
// go negative) and reports 409 instead of 400 — nothing catastrophic, but the
// guard is part of the implementation's contract and deserves its own test.
test('PUT rejects a negative version as bad_request, not a CAS conflict', async () => {
  const env = { DB: makeD1() };
  const res = await handlePutData(put({ version: -1, blob: 'x' }), env, NOW, 1);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
});

// --- Task 3: per-account data ------------------------------------------

async function withAccount2(blob = 'B', version = 3) {
  const DB = makeD1();
  await DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (2, 'b@x.de', 't')").run();
  await DB.prepare('INSERT INTO data (id, version, blob, updated_at) VALUES (2, ?, ?, ?)').bind(version, blob, 't').run();
  return { DB };
}

test('GET reads only the given account\'s row', async () => {
  const env = await withAccount2();
  assert.deepEqual(await (await handleGetData(env, 2)).json(), { version: 3, blob: 'B' });
  assert.deepEqual(await (await handleGetData(env, 1)).json(), { version: 0, blob: '' });
});

test('a PUT CAS on account 2 does not touch account 1', async () => {
  const env = await withAccount2();
  const res = await handlePutData(put({ version: 3, blob: 'B2' }), env, NOW, 2);
  assert.deepEqual(await res.json(), { version: 4 });
  assert.deepEqual(await (await handleGetData(env, 1)).json(), { version: 0, blob: '' });
  assert.deepEqual(await (await handleGetData(env, 2)).json(), { version: 4, blob: 'B2' });
  // Account 1's version (0) must not satisfy a CAS against account 2.
  const stale = await handlePutData(put({ version: 0, blob: 'x' }), env, NOW, 2);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).blob, 'B2');
});

test('GET for an account with no data row is 500 not_initialised, with no empty fallback', async () => {
  const DB = makeD1();
  await DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (2, 'b@x.de', 't')").run();
  const res = await handleGetData({ DB }, 2);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'not_initialised' });
  const putRes = await handlePutData(put({ version: 0, blob: 'x' }), { DB }, NOW, 2);
  assert.equal(putRes.status, 500);
  assert.equal((await putRes.json()).error, 'not_initialised');
});
