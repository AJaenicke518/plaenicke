// fake-d1.js — a D1-shaped adapter over node:sqlite, for tests only.
//
// Backed by real SQLite rather than pattern-matched fake responses, so the SQL
// the Worker actually issues — including the compare-and-swap UPDATE, foreign
// keys and transactional batches — is genuinely exercised. Mirrors exactly the
// subset of the D1 binding the Worker uses: prepare().bind().first()/run()/all()
// and batch(). Nothing more — an unused method in a test double advertises a
// contract nothing verifies. applyMigration() is test-only plumbing.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

// yieldPerStatement: real D1 is a network hop per statement; the in-process
// fake resolves within one tick, which hides read-then-write races. With this
// option every first()/run()/all()/batch() waits one macrotask (setImmediate)
// before it executes, so concurrent handlers genuinely interleave between
// statements. A batch still executes atomically once it starts, as in D1.
// Every concurrency test uses it.
export function makeD1({ upTo, yieldPerStatement = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const load = (prefix) => {
    const f = MIGRATIONS.find((m) => m.startsWith(prefix));
    if (!f) throw new Error(`no migration ${prefix}`);
    db.exec(readFileSync(join(DIR, f), 'utf8'));
  };
  if (upTo && !MIGRATIONS.some((m) => m.startsWith(upTo))) throw new Error(`no migration ${upTo}`);
  for (const f of MIGRATIONS) {
    load(f.slice(0, 4));
    if (upTo && f.startsWith(upTo)) break;
  }

  const hop = yieldPerStatement ? () => new Promise((r) => setImmediate(r)) : async () => {};
  const totalChanges = () => Number(db.prepare('SELECT total_changes() AS n').get().n);

  function prepare(sql) { return makeStatement(sql, []); }

  // Row-vs-run is decided by the compiled statement (columns() is non-empty
  // for a SELECT and for any DML with RETURNING), never by a regex over the
  // SQL text. meta.changes is the real number of rows written (total_changes
  // delta), so a SELECT reports 0.
  function exec(sql, args) {
    const st = db.prepare(sql);
    const before = totalChanges();
    if (st.columns().length > 0) {
      const rows = st.all(...args).map((r) => ({ ...r }));
      return { success: true, meta: { changes: totalChanges() - before }, results: rows };
    }
    const r = st.run(...args);
    return { success: true, meta: { changes: Number(r.changes) }, results: [] };
  }

  // bind() returns a NEW statement, as D1 does, so one prepared statement can
  // be bound twice with different arguments inside a single batch().
  function makeStatement(sql, args) {
    return {
      bind(...a) { return makeStatement(sql, a); },
      async first() {
        await hop();
        // node:sqlite returns null-prototype row objects (Object.create(null)).
        // Real D1 rows are plain objects, so spread into a plain object; this
        // also keeps assert.deepEqual (prototype-sensitive) usable.
        const row = db.prepare(sql).get(...args);
        return row === undefined ? null : { ...row };
      },
      async run() {
        await hop();
        return exec(sql, args);
      },
      async all() {
        await hop();
        return { success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) };
      },
      _exec() { return exec(sql, args); },
    };
  }

  async function batch(stmts) {
    await hop();
    db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._exec());
      db.exec('COMMIT');
      return out;
    } catch (err) {
      // A failing ROLLBACK (no transaction left open) must not replace the
      // error that actually broke the batch.
      try { db.exec('ROLLBACK'); } catch { /* the original error is the one that matters */ }
      throw err;
    }
  }

  return { prepare, batch, applyMigration: load };
}
