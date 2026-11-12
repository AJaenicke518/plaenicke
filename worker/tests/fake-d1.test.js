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

test('the FK to accounts rejects a data row for a missing account', async () => {
  const db = makeD1();
  await assert.rejects(() =>
    db.prepare('INSERT INTO data (id, version, blob, updated_at) VALUES (2, 0, \'\', \'x\')').run());
});

test('the single-row CHECK is gone: a second account may own a second data row', async () => {
  const db = makeD1();
  await db.prepare("INSERT INTO accounts (id, created_at) VALUES (2, 't')").run();
  const res = await db.prepare('INSERT INTO data (id, version, blob, updated_at) VALUES (2, 0, \'\', \'x\')').run();
  assert.equal(res.meta.changes, 1);
});

// --- sweep W1-I6 and the fake-d1 observations ------------------------------

test('a SELECT inside batch reports meta.changes 0, not its row count', async () => {
  const db = makeD1();
  const [sel] = await db.batch([db.prepare('SELECT id FROM accounts')]);
  assert.deepEqual(sel.results, [{ id: 1 }]);
  assert.equal(sel.meta.changes, 0);
});

test('row-vs-run is decided by the statement, not a regex: a CTE SELECT returns rows', async () => {
  const db = makeD1();
  const [r] = await db.batch([db.prepare('WITH x AS (SELECT 7 AS n) SELECT n FROM x')]);
  assert.deepEqual(r.results, [{ n: 7 }]);
  // a string literal containing the word RETURNING does not turn an UPDATE into a row statement
  const [u] = await db.batch([db.prepare("UPDATE accounts SET created_at = 'RETURNING' WHERE id = 1")]);
  assert.equal(u.meta.changes, 1);
  assert.deepEqual(u.results, []);
});

test('a DML with RETURNING inside batch returns its rows and the real change count', async () => {
  const db = makeD1();
  const [r] = await db.batch([db.prepare("UPDATE accounts SET created_at = 'x' WHERE id = 1 RETURNING id")]);
  assert.deepEqual(r.results, [{ id: 1 }]);
  assert.equal(r.meta.changes, 1);
});

test('run() with RETURNING returns the rows', async () => {
  const db = makeD1();
  const r = await db.prepare("UPDATE accounts SET created_at = 'x' WHERE id = 1 RETURNING id").run();
  assert.deepEqual(r.results, [{ id: 1 }]);
  assert.equal(r.meta.changes, 1);
});

test('a failing ROLLBACK does not mask the original batch error', async () => {
  const db = makeD1();
  // COMMIT inside the batch ends the transaction, so the later ROLLBACK itself throws.
  await assert.rejects(db.batch([
    db.prepare('COMMIT'),
    db.prepare("INSERT INTO nosuch VALUES (1)"),
  ]), /no such table: nosuch/);
});

test('yieldPerStatement: every first/run/all/batch waits one macrotask before executing', async () => {
  const db = makeD1({ yieldPerStatement: true });
  for (const call of [
    () => db.prepare('SELECT 1 AS n').first(),
    () => db.prepare('SELECT 1 AS n').all(),
    () => db.prepare("UPDATE accounts SET created_at = 'y' WHERE id = 1").run(),
    () => db.batch([db.prepare('SELECT 1 AS n')]),
  ]) {
    let immediate = false;
    setImmediate(() => { immediate = true; });
    await call();
    assert.equal(immediate, true);
  }
});
