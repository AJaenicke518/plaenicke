import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './fake-d1.js';

// The OLD data.js queries, copied verbatim from pre-V7 worker/src/data.js, so
// this test keeps proving the deployed Worker survives the migration even
// after data.js itself changes in Task 3.
const OLD_GET = 'SELECT version, blob FROM data WHERE id = 1';
const OLD_CAS = 'UPDATE data SET blob = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?';

async function seeded0001() {
  const db = makeD1({ upTo: '0001' });
  await db.prepare("UPDATE data SET version = 7, blob = 'CIPHER', updated_at = '2026-11-01T00:00:00.000Z' WHERE id = 1").run();
  await db.prepare("INSERT INTO devices (token_hash, name, created_at, last_seen_at) VALUES ('h1','laptop','2026-08-28T00:00:00.000Z','2026-11-10T00:00:00.000Z')").run();
  await db.prepare("INSERT INTO devices (token_hash, name, created_at) VALUES ('h2','iphone','2026-08-28T00:00:01.000Z')").run();
  return db;
}

test('0002 applies on a populated 0001 database and preserves data and devices byte-identical', async () => {
  const db = await seeded0001();
  db.applyMigration('0002');
  const data = await db.prepare('SELECT id, version, blob, updated_at FROM data').first();
  assert.deepEqual(data, { id: 1, version: 7, blob: 'CIPHER', updated_at: '2026-11-01T00:00:00.000Z' });
  const devs = (await db.prepare('SELECT token_hash, account_id, name, created_at, last_seen_at FROM devices ORDER BY token_hash').all()).results;
  assert.deepEqual(devs, [
    { token_hash: 'h1', account_id: 1, name: 'laptop', created_at: '2026-08-28T00:00:00.000Z', last_seen_at: '2026-11-10T00:00:00.000Z' },
    { token_hash: 'h2', account_id: 1, name: 'iphone', created_at: '2026-08-28T00:00:01.000Z', last_seen_at: null },
  ]);
  const acct = await db.prepare('SELECT id, email, failed_logins, invite_hash FROM accounts').first();
  assert.deepEqual(acct, { id: 1, email: null, failed_logins: 0, invite_hash: null });
  const cols = (await db.prepare('PRAGMA table_info(accounts)').all()).results.map((c) => c.name);
  for (const c of ['invite_hash', 'dek_check', 'recovery_confirmed_at', 'wrapped_dek_pw_sealed']) assert.ok(cols.includes(c), c);
});

test('one prepared statement bound twice inside a batch runs with both argument lists', async () => {
  const db = makeD1();
  const s = db.prepare('INSERT INTO invites (hash, created_at) VALUES (?, ?)');
  await db.batch([s.bind('a', 't'), s.bind('b', 't')]);
  const rows = (await db.prepare('SELECT hash FROM invites ORDER BY hash').all()).results;
  assert.deepEqual(rows, [{ hash: 'a' }, { hash: 'b' }]);
});

test('an upTo that matches no migration throws', () => {
  assert.throws(() => makeD1({ upTo: '001' }));
});

test('old data.js queries still work after 0002 (phased release, spec § 10)', async () => {
  const db = await seeded0001();
  db.applyMigration('0002');
  assert.deepEqual(await db.prepare(OLD_GET).first(), { version: 7, blob: 'CIPHER' });
  const res = await db.prepare(OLD_CAS).bind('NEW', '2026-11-12T00:00:00.000Z', 7).run();
  assert.equal(res.meta.changes, 1);
  assert.deepEqual(await db.prepare(OLD_GET).first(), { version: 8, blob: 'NEW' });
});

test('foreign keys are enforced: a device for a missing account is rejected', async () => {
  const db = makeD1();
  await assert.rejects(
    db.prepare("INSERT INTO devices (token_hash, account_id, name, created_at) VALUES ('x', 99, 'n', 't')").run(),
  );
});

test('devices.account_id has no default: an insert without it fails', async () => {
  const db = makeD1();
  await assert.rejects(
    db.prepare("INSERT INTO devices (token_hash, name, created_at) VALUES ('x', 'n', 't')").run(),
  );
});

test('batch is atomic: a failing statement rolls back the ones before it', async () => {
  const db = makeD1();
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO invites (hash, created_at) VALUES ('i1', 't')"),
    db.prepare("INSERT INTO invites (hash, created_at) VALUES ('i1', 't')"), // PK clash
  ]));
  assert.equal(await db.prepare("SELECT hash FROM invites WHERE hash = 'i1'").first(), null);
});

test('usage upsert with WHERE … RETURNING returns no row once the cap is reached', async () => {
  const db = makeD1();
  const sql = `INSERT INTO usage (account_id, day, calls) VALUES (1, '2026-11-11', 1)
    ON CONFLICT (account_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < 2 RETURNING calls`;
  assert.deepEqual(await db.prepare(sql).first(), { calls: 1 });
  assert.deepEqual(await db.prepare(sql).first(), { calls: 2 });
  assert.equal(await db.prepare(sql).first(), null);
});
