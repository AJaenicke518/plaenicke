// fake-d1.js — a D1-shaped adapter over node:sqlite, for tests only.
//
// Backed by real SQLite rather than pattern-matched fake responses, so the SQL
// the Worker actually issues — including the compare-and-swap UPDATE and the
// single-row CHECK — is genuinely exercised. Mirrors exactly the subset of the
// D1 binding the Worker uses: prepare().bind().first()/run(). Nothing more —
// an unused method in a test double advertises a contract nothing verifies.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, '..', 'migrations', '0001_init.sql'), 'utf8');

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);

  function prepare(sql) {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async first() {
        // node:sqlite returns null-prototype row objects (Object.create(null)).
        // Real D1 rows are plain objects (deserialized JSON over the wire), so
        // spread into a plain object to match D1's actual shape faithfully —
        // this also keeps assert.deepEqual (prototype-sensitive under
        // node:assert/strict) usable against plain object literals in tests.
        const row = db.prepare(sql).get(...args);
        return row === undefined ? null : { ...row };
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) }, results: [] };
      },
    };
    return api;
  }

  return { prepare };
}
