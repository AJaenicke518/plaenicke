import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './fake-d1.js';
import {
  SMART_ADD_DAILY_CAP, utcDay, nextUtcMidnight, takeSmartAddSlot, recordTokens,
} from '../src/usage.js';

test('the cap is 50', () => assert.equal(SMART_ADD_DAILY_CAP, 50));

test('utcDay takes the date part of an ISO instant', () => {
  assert.equal(utcDay('2026-11-11T23:59:59.999Z'), '2026-11-11');
  assert.equal(utcDay('2026-11-12T00:00:00.000Z'), '2026-11-12');
});

test('nextUtcMidnight is 00:00Z of the following day, across month and year ends', () => {
  assert.equal(nextUtcMidnight('2026-11-11'), '2026-11-12T00:00:00.000Z');
  assert.equal(nextUtcMidnight('2026-11-30'), '2026-12-01T00:00:00.000Z');
  assert.equal(nextUtcMidnight('2026-12-31'), '2027-01-01T00:00:00.000Z');
});

test('takeSmartAddSlot counts 1..50 then refuses, per account and day', async () => {
  const env = { DB: makeD1() };
  await env.DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (2, 'b@x.de', 't')").run();
  for (let i = 1; i <= 50; i += 1) {
    assert.deepEqual(await takeSmartAddSlot(env, 1, '2026-11-11'), { ok: true, calls: i });
  }
  assert.deepEqual(await takeSmartAddSlot(env, 1, '2026-11-11'), { ok: false });
  assert.deepEqual(await takeSmartAddSlot(env, 1, '2026-11-11'), { ok: false });
  assert.deepEqual(await takeSmartAddSlot(env, 2, '2026-11-11'), { ok: true, calls: 1 });
  assert.deepEqual(await takeSmartAddSlot(env, 1, '2026-11-12'), { ok: true, calls: 1 });
  const row = await env.DB.prepare('SELECT calls FROM usage WHERE account_id = 1 AND day = ?').bind('2026-11-11').first();
  assert.equal(row.calls, 50);
});

test('recordTokens adds to the (account, day) row and tolerates repeats', async () => {
  const env = { DB: makeD1() };
  await takeSmartAddSlot(env, 1, '2026-11-11');
  await recordTokens(env, 1, '2026-11-11', 900, 120);
  await recordTokens(env, 1, '2026-11-11', 10, 5);
  const row = await env.DB.prepare('SELECT calls, in_tok, out_tok FROM usage WHERE account_id = 1').first();
  assert.deepEqual(row, { calls: 1, in_tok: 910, out_tok: 125 });
});

test('55 parallel slot takers (each statement yields a macrotask) get exactly 50 slots', async () => {
  const env = { DB: makeD1({ yieldPerStatement: true }) };
  const res = await Promise.all(Array.from({ length: 55 }, () => takeSmartAddSlot(env, 1, '2026-11-11')));
  assert.equal(res.filter((r) => r.ok).length, 50);
  assert.equal(res.filter((r) => !r.ok).length, 5);
});
