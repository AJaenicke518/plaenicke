import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './fake-d1.js';
import { handleGetData, handlePutData, MAX_BLOB_CHARS } from '../src/data.js';

const NOW = '2026-08-01T12:00:00.000Z';
const put = (body) => new Request('https://worker.example/data', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('GET returns the seeded empty state', async () => {
  const env = { DB: makeD1() };
  const res = await handleGetData(env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 0, blob: '' });
});

test('PUT at the current version succeeds and bumps to version + 1', async () => {
  const env = { DB: makeD1() };
  const res = await handlePutData(put({ version: 0, blob: 'cipher-a' }), env, NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 1 });
  assert.deepEqual(await (await handleGetData(env)).json(), { version: 1, blob: 'cipher-a' });
});

test('PUT at a stale version is rejected and returns current server state', async () => {
  const env = { DB: makeD1() };
  await handlePutData(put({ version: 0, blob: 'from-laptop' }), env, NOW);

  const res = await handlePutData(put({ version: 0, blob: 'from-phone' }), env, NOW);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'version_conflict');
  assert.equal(body.version, 1);
  assert.equal(body.blob, 'from-laptop');

  // The losing write must not have landed.
  assert.equal((await (await handleGetData(env)).json()).blob, 'from-laptop');
});

test('the client can merge and retry at the returned version', async () => {
  const env = { DB: makeD1() };
  await handlePutData(put({ version: 0, blob: 'a' }), env, NOW);
  const conflict = await (await handlePutData(put({ version: 0, blob: 'b' }), env, NOW)).json();
  const res = await handlePutData(put({ version: conflict.version, blob: 'merged' }), env, NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 2 });
});

test('PUT rejects malformed bodies', async () => {
  const env = { DB: makeD1() };
  assert.equal((await handlePutData(put('not json'), env, NOW)).status, 400);
  assert.equal((await handlePutData(put({ blob: 'x' }), env, NOW)).status, 400);
  assert.equal((await handlePutData(put({ version: 0 }), env, NOW)).status, 400);
  assert.equal((await handlePutData(put({ version: '0', blob: 'x' }), env, NOW)).status, 400);
  assert.equal((await handlePutData(put({ version: 1.5, blob: 'x' }), env, NOW)).status, 400);
});

test('PUT rejects an oversized blob without writing it', async () => {
  const env = { DB: makeD1() };
  const res = await handlePutData(put({ version: 0, blob: 'x'.repeat(MAX_BLOB_CHARS + 1) }), env, NOW);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'blob_too_large');
  assert.equal((await (await handleGetData(env)).json()).version, 0);
});

test('an error response never echoes the submitted blob', async () => {
  const env = { DB: makeD1() };
  const secret = 'https://calendar.google.com/private-abc123/basic.ics';
  const res = await handlePutData(put({ version: 99, blob: secret }), env, NOW);
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
  const res = await handlePutData(put({ version: -1, blob: 'x' }), env, NOW);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
});
