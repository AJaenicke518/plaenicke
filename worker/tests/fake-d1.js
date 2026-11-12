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

export function makeD1({ upTo } = {}) {
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

  function prepare(sql) { return makeStatement(sql, []); }

  // bind() returns a NEW statement, as D1 does, so one prepared statement can
  // be bound twice with different arguments inside a single batch().
  function makeStatement(sql, args) {
    return {
      bind(...a) { return makeStatement(sql, a); },
      async first() {
        // node:sqlite returns null-prototype row objects (Object.create(null)).
        // Real D1 rows are plain objects, so spread into a plain object; this
        // also keeps assert.deepEqual (prototype-sensitive) usable.
        const row = db.prepare(sql).get(...args);
        return row === undefined ? null : { ...row };
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) }, results: [] };
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) };
      },
      _exec() {
        if (/\bRETURNING\b/i.test(sql) || /^\s*SELECT/i.test(sql)) {
          const rows = db.prepare(sql).all(...args).map((r) => ({ ...r }));
          return { success: true, meta: { changes: rows.length }, results: rows };
        }
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) }, results: [] };
      },
    };
  }

  async function batch(stmts) {
    db.exec('BEGIN');
    try {
      const out = stmts.map((s) => s._exec());
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return { prepare, batch, applyMigration: load };
}
