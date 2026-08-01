import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './fake-d1.js';

test('the double applies the migration and seeds exactly one data row', async () => {
  const db = makeD1();
  const row = await db.prepare('SELECT id, version, blob FROM data WHERE id = 1').first();
  assert.deepEqual(row, { id: 1, version: 0, blob: '' });
});

test('run() reports changes, so compare-and-swap is detectable', async () => {
  const db = makeD1();
  const hit = await db.prepare(
    'UPDATE data SET version = version + 1 WHERE id = 1 AND version = ?').bind(0).run();
  assert.equal(hit.meta.changes, 1);
  const miss = await db.prepare(
    'UPDATE data SET version = version + 1 WHERE id = 1 AND version = ?').bind(0).run();
  assert.equal(miss.meta.changes, 0);
  assert.equal(miss.success, true);
});

test('first() returns null when nothing matches', async () => {
  const db = makeD1();
  assert.equal(await db.prepare('SELECT * FROM devices WHERE token_hash = ?').bind('x').first(), null);
});

test('the single-row CHECK rejects a second data row', async () => {
  const db = makeD1();
  await assert.rejects(() =>
    db.prepare('INSERT INTO data (id, version, blob, updated_at) VALUES (2, 0, \'\', \'x\')').run());
});
