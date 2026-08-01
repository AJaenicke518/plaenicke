import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './fake-d1.js';
import {
  sha256Hex, bearerToken, authenticateDevice, isAdmin, mintDevice, revokeDevice,
} from '../src/auth.js';

const NOW = '2026-08-01T12:00:00.000Z';
const req = (headers = {}) => new Request('https://worker.example/data', { headers });

test('sha256Hex is stable and hex', async () => {
  assert.match(await sha256Hex('abc'), /^[0-9a-f]{64}$/);
  assert.equal(await sha256Hex('abc'), await sha256Hex('abc'));
  assert.notEqual(await sha256Hex('abc'), await sha256Hex('abd'));
});

test('bearerToken parses the header and rejects other schemes', () => {
  assert.equal(bearerToken(req({ authorization: 'Bearer tok123' })), 'tok123');
  assert.equal(bearerToken(req({ authorization: 'Basic tok123' })), null);
  assert.equal(bearerToken(req()), null);
});

test('mintDevice stores only the hash and returns the token once', async () => {
  const env = { DB: makeD1() };
  const token = await mintDevice(env, 'laptop', NOW);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const row = await env.DB.prepare('SELECT token_hash, name FROM devices').first();
  assert.equal(row.name, 'laptop');
  assert.equal(row.token_hash, await sha256Hex(token));
  assert.notEqual(row.token_hash, token);
});

test('authenticateDevice accepts a minted token and rejects others', async () => {
  const env = { DB: makeD1() };
  const token = await mintDevice(env, 'phone', NOW);
  assert.equal(await authenticateDevice(req({ authorization: `Bearer ${token}` }), env, NOW),
    await sha256Hex(token));
  assert.equal(await authenticateDevice(req({ authorization: 'Bearer wrong' }), env, NOW), null);
  assert.equal(await authenticateDevice(req(), env, NOW), null);
});

test('authenticateDevice records last_seen_at', async () => {
  const env = { DB: makeD1() };
  const token = await mintDevice(env, 'phone', NOW);
  await authenticateDevice(req({ authorization: `Bearer ${token}` }), env, '2026-08-02T00:00:00.000Z');
  const row = await env.DB.prepare('SELECT last_seen_at FROM devices').first();
  assert.equal(row.last_seen_at, '2026-08-02T00:00:00.000Z');
});

test('revokeDevice removes the row and the token stops working', async () => {
  const env = { DB: makeD1() };
  const token = await mintDevice(env, 'old', NOW);
  const hash = await sha256Hex(token);
  assert.equal(await revokeDevice(env, hash), true);
  assert.equal(await revokeDevice(env, hash), false);
  assert.equal(await authenticateDevice(req({ authorization: `Bearer ${token}` }), env, NOW), null);
});

test('isAdmin requires an exactly matching secret and fails closed when unset', () => {
  assert.equal(isAdmin(req({ authorization: 'Bearer s3cret' }), { ADMIN_SECRET: 's3cret' }), true);
  assert.equal(isAdmin(req({ authorization: 'Bearer wrong' }), { ADMIN_SECRET: 's3cret' }), false);
  assert.equal(isAdmin(req({ authorization: 'Bearer s3cret' }), {}), false);
  assert.equal(isAdmin(req({ authorization: 'Bearer s3cret' }), { ADMIN_SECRET: '' }), false);
  assert.equal(isAdmin(req(), { ADMIN_SECRET: 's3cret' }), false);
});
