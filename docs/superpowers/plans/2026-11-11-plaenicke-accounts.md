# plaenicke Accounts (V7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invite-only, end-to-end-encrypted email+password accounts for ~10 testers, with Alex's link-code account upgrading in place.

**Architecture:** The device derives keys from the password (PBKDF2 → HKDF) and holds the same `base64url(token ‖ DEK)` credential as today, so `sync.js` runs unmodified. The Worker gains an `accounts` table, per-account `data`/`devices` rows, sealed wrapped keys, a lockout, a smart-add cap, and token-gated `/feed` and smart add behind a `REQUIRE_SESSION` flag for a phased release.

**Tech Stack:** Vanilla ES modules, WebCrypto, `node --test`, Cloudflare Workers + D1 (tests: real `node:sqlite` via `worker/tests/fake-d1.js`).

**Spec:** `docs/superpowers/specs/2026-11-11-plaenicke-accounts-design.md` (commit `3f0f5e4` + § 6.1 step 5 fix). Every task's implementer reads the spec sections named in the task.

**Deviation from the writing-plans template, stated out loud:** worker and crypto tasks carry full test code and the load-bearing implementation (SQL, crypto). UI tasks carry exact DOM ids, copy strings and tests, not full DOM-building code. Reason: CLAUDE.md records nine defects in V5 that lived in a plan's *prescribed code*. Precise contracts with executable tests transfer better than long prescribed UI code. Implementers follow the surrounding file's idiom.

## Global Constraints

- No framework, no build step, no bundler, no npm dependencies (CLAUDE.md).
- `npm test` from the worktree root; a commit requires `# fail 0` **and** `# cancelled 0`. Never `node --test tests/`.
- Storage-touching tests call `installFakeLocalStorage()`. `js/storage.js` is the only module that touches `localStorage`.
- Poll, never fixed waits, for anything behind WebCrypto (`drainUntil` / `settleUntil` / a bounded poll).
- `sync.js` and `linkui.js` must never write `plaenicke.items`, `plaenicke.feeds`, or tombstones (`tests/sync.test.js` enforces this).
- PBKDF2: SHA-256, **600,000** iterations default, client **refuses < 600,000**, 16-byte salt.
- Recovery code: 16 random bytes, base64url, 22 chars. Invite: 16 random bytes, base64url.
- Lockout: **50** consecutive failed password checks ⇒ **1 hour**; recovery routes exempt.
- Smart-add cap: **50** per account per UTC day.
- Password policy: ≥ 8 chars, ≥ 1 digit, ≥ 1 char that is neither letter nor digit, not on the blocklist, must not contain the email local part (case-insensitive, only when the local part is ≥ 3 chars).
- HKDF info strings exactly as spec § 4.1 / D5 (`plaenicke/v1/auth`, `plaenicke/v1/wrap`, `plaenicke/v1/rec-auth`, `plaenicke/v1/rec-wrap`, `plaenicke/v1/dek-check`, `plaenicke/v1/at-rest/mac`, `plaenicke/v1/at-rest/seal`); AAD `plaenicke/v1/dek-pw`, `plaenicke/v1/dek-rec`; seal AAD `<column>|<accountId>`; seal prefix `k1:`.
- Worker error responses are `{error: '<code>'}` JSON with CORS headers (`cors.js` `json()`).
- Never log request bodies, emails, keys, tokens, or blobs. Log lines carry counts and statuses only.
- Nothing in this plan deploys, migrates production, pushes, or merges to `main`.

## Review Focus

1. **Signing in on a device that already holds another account's data:** must be blocked, never merged (Task 12 test `owner guard blocks a different account`).
2. **App evicted between sign-up and recovery confirmation (iOS `mailto:` switch):** the banner must reappear on relaunch and on other devices (Task 13 test `banner shows while recoveryConfirmed is false`).
3. **Sync on an old-shaped request during the phased release** (tokenless smart add/feed while `REQUIRE_SESSION=false`; old `data.js` queries after migration): must keep working (Task 1 `old data.js queries still work`, Task 7 `tolerant mode accepts tokenless`).
4. **Device whose session was deleted by recovery:** must say "This device was signed out. Sign in again." and offer sign-in, never the 86-character-code copy (Task 12 test `account device 401 copy`).
5. **Concurrent requests at the edges** (51st smart add at the same instant as the 50th; two recover/finish with the same code; 60 parallel wrong logins): bounded exactly (Task 4 lockout concurrency, Task 5 concurrent finish, Task 7 concurrent cap).

---

## File map

| File | Responsibility |
|---|---|
| `worker/migrations/0002_accounts.sql` (new) | Schema per spec § 5 |
| `worker/tests/fake-d1.js` | All migrations, FKs on, transactional `batch()` |
| `worker/src/seal.js` (new) | HKDF subkeys from `AT_REST_KEY`, `mac`, `seal`/`unseal`, key-check |
| `worker/src/auth.js` | `authenticateDevice` → `{tokenHash, accountId}` (joins accounts, rejects disabled); `mintDevice(env, accountId, name, now)`; `isAdmin` unchanged |
| `worker/src/data.js` | Per-account row by `id = accountId` |
| `worker/src/accounts.js` (new) | `/auth/*` and `/account/*` handlers |
| `worker/src/admin.js` (new) | `/admin/invite`, `/admin/accounts`, `/admin/account/*`; legacy `/admin/device` moves here |
| `worker/src/usage.js` (new) | Smart-add cap |
| `worker/src/feed.js` | Session gate before cache, allow-headers, Max-Age |
| `worker/src/index.js` | Route table, `REQUIRE_SESSION` |
| `js/keys.js` (new) | Client derivations, wrap/unwrap, dekCheck, recovery code |
| `js/password-policy.js`, `js/common-passwords.js` (new) | Policy |
| `js/account.js` (new) | Client network calls |
| `js/fragment.js` (new) | Boot-time `#invite=` / `#recover=` |
| `js/storage.js` | `plaenicke.localOwner` |
| `js/linkui.js` | `linkAndAdopt`, owner guard, account-aware copy, sign-out routing |
| `js/accountui.js` (new) | Account section + forms + recovery screen + banner |
| `js/settings.js`, `js/app.js` | Mount account UI; boot intent |
| `js/smartadd.js`, `js/feeds.js` | Bearer header, error codes |
| `service-worker.js` | `ASSETS`, `CACHE` |
| `docs/admin.md` (new), `CLAUDE.md`, `worker/README.md` | Operations docs |

---

### Task 1: Migration 0002 and a faithful fake D1

**Spec:** § 5.

**Files:**
- Create: `worker/migrations/0002_accounts.sql`
- Modify: `worker/tests/fake-d1.js`
- Test: `worker/tests/migration.test.js` (new)

**Interfaces:**
- Produces: `makeD1({ upTo } = {})`. It loads migrations `0001…upTo` in filename order (default: all), with `PRAGMA foreign_keys = ON`. Returns `{ prepare, batch, exec }`:
  - `batch(stmts)` runs the bound statements inside `BEGIN`/`COMMIT`, rolls back on any throw, rethrows, and returns an array of `run()`-shaped results.
  - `exec(sql)` is for tests only, for seeding.
  - `prepare().bind().first()/run()/all()`. `all()` is added for the admin list and returns `{ results: [...] }`.

- [ ] **Step 1: Write the failing tests** in `worker/tests/migration.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './fake-d1.js';
import { handleGetData, handlePutData } from '../src/data.js';

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
  const acct = await db.prepare('SELECT id, email, failed_logins FROM accounts').first();
  assert.deepEqual(acct, { id: 1, email: null, failed_logins: 0 });
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
```

  Add `applyMigration(name)` to the fake as a test-only helper. It applies a single named migration on top of `upTo`.

- [ ] **Step 2: Run them and confirm they fail.** `npm test`. Expected: failures (`makeD1` ignores `upTo`, no `batch`, no `0002`).

- [ ] **Step 3: Implement.** Write `0002_accounts.sql` verbatim from spec § 5, including the `devices_v2` and `data_v2` rebuilds that keep `data.id`. Rewrite `fake-d1.js`:

```js
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

export function makeD1({ upTo } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const load = (name) => db.exec(readFileSync(join(DIR, MIGRATIONS.find((f) => f.startsWith(name))), 'utf8'));
  for (const f of MIGRATIONS) {
    load(f.slice(0, 4));
    if (upTo && f.startsWith(upTo)) break;
  }
  function prepare(sql) {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async first() { const row = db.prepare(sql).get(...args); return row === undefined ? null : { ...row }; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) }, results: [] }; },
      async all() { return { success: true, results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
      _exec() {
        if (/\bRETURNING\b/i.test(sql)) {
          const rows = db.prepare(sql).all(...args).map((r) => ({ ...r }));
          return { success: true, meta: { changes: rows.length }, results: rows };
        }
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) }, results: [] };
      },
    };
    return api;
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
```

  Keep the existing header comment's rule ("Mirrors exactly the subset of the D1 binding the Worker uses"). Update it to name `batch` and `all`.

- [ ] **Step 4: Run `npm test`.** Expected: new tests pass. **Existing worker tests that touch `data` or `devices` now fail**, because `devices` requires `account_id`. That is expected, and Task 3 fixes it. To keep this commit green, Step 3 also updates `worker/src/auth.js`'s `mintDevice` INSERT to bind `account_id = 1` **temporarily**, with a `// TEMP(Task 3)` comment. Task 3's reviewer checks that it is gone.

- [ ] **Step 5: Mutation check.** Remove `PRAGMA foreign_keys = ON` and confirm `foreign keys are enforced` fails. Remove `ROLLBACK` and confirm `batch is atomic` fails. Restore both.

- [ ] **Step 6: Commit** — `git commit -m "worker: migration 0002 (accounts) and a transactional, FK-enforcing fake D1"`

---

### Task 2: At-rest sealing (`seal.js`)

**Spec:** D5, § 4.2, § 8.

**Files:** Create `worker/src/seal.js`. Test `worker/tests/seal.test.js`.

**Interfaces:**
- Produces:
  - `async atRest(env)` returns `{ mac(str) → hex, seal(column, accountId, plaintextStr) → 'k1:'+b64, unseal(column, accountId, sealed) → str }`.
  - It throws `AtRestError('not_configured')` if `env.AT_REST_KEY` is missing or not 32 bytes of base64url.
  - `async checkKey(env)` reads the `config` row `key-check` and writes it on first use. If the row exists and does not match, it throws `AtRestError('at_rest_key_mismatch')`.
  - `export class AtRestError extends Error { constructor(code) { super(code); this.code = code; } }`

- [ ] **Step 1: Failing tests:**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atRest, checkKey, AtRestError } from '../src/seal.js';
import { makeD1 } from './fake-d1.js';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'; // 32 bytes base64url
const env = (k = KEY) => ({ AT_REST_KEY: k, DB: makeD1() });

test('mac is deterministic hex and differs per input', async () => {
  const a = await atRest(env());
  assert.equal(await a.mac('x'), await a.mac('x'));
  assert.notEqual(await a.mac('x'), await a.mac('y'));
  assert.match(await a.mac('x'), /^[0-9a-f]{64}$/);
});

test('seal round-trips and carries the k1: prefix', async () => {
  const a = await atRest(env());
  const s = await a.seal('wrapped_dek_pw_sealed', 3, 'hello');
  assert.ok(s.startsWith('k1:'));
  assert.equal(await a.unseal('wrapped_dek_pw_sealed', 3, s), 'hello');
});

test('a sealed value moved to another account or column does not unseal', async () => {
  const a = await atRest(env());
  const s = await a.seal('wrapped_dek_pw_sealed', 3, 'hello');
  await assert.rejects(a.unseal('wrapped_dek_pw_sealed', 4, s));
  await assert.rejects(a.unseal('wrapped_dek_rec_sealed', 3, s));
});

test('missing or malformed key throws not_configured', async () => {
  await assert.rejects(atRest({}), (e) => e instanceof AtRestError && e.code === 'not_configured');
  await assert.rejects(atRest({ AT_REST_KEY: 'short' }), (e) => e.code === 'not_configured');
});

test('checkKey writes on first use and detects a changed key', async () => {
  const e = env();
  await checkKey(e);
  await checkKey(e); // same key: fine
  const other = { AT_REST_KEY: 'HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4', DB: e.DB };
  await assert.rejects(checkKey(other), (err) => err.code === 'at_rest_key_mismatch');
});

test('mac and seal subkeys are separated (mac of x ≠ any seal output prefix)', async () => {
  const a = await atRest(env());
  const m = await a.mac('plaenicke/v1/key-check');
  const s = await a.seal('c', 1, 'plaenicke/v1/key-check');
  assert.ok(!s.includes(m));
});
```

- [ ] **Step 2: Run and confirm failure** (module missing).
- [ ] **Step 3: Implement** with WebCrypto:
  - `importKey('raw', bytes, 'HKDF', false, ['deriveKey'])`.
  - `macKey = deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(32),info:utf8('plaenicke/v1/at-rest/mac')}, …, {name:'HMAC',hash:'SHA-256',length:256}, false, ['sign'])`.
  - `sealKey` is the same with `info 'plaenicke/v1/at-rest/seal'` and `{name:'AES-GCM',length:256}`.
  - `seal`: random 12-byte IV, `additionalData: utf8(`${column}|${accountId}`)`, output `'k1:' + base64(iv‖ct)`.
  - `unseal` rejects a value without `k1:`.
  - `checkKey` stores `mac('plaenicke/v1/key-check')` under `config.key = 'key-check'` with `INSERT … ON CONFLICT(key) DO NOTHING`, then reads it back and compares.
- [ ] **Step 4: `npm test` passes.**
- [ ] **Step 5: Commit** — `worker: at-rest seal and MAC with key check (spec D5)`

---

### Task 3: Per-account devices and data

**Spec:** D13, § 6.8 (authenticateDevice), § 6.9 (legacy `/admin/device`).

**Files:** Modify `worker/src/auth.js`, `worker/src/data.js`, `worker/src/index.js`. Update `worker/tests/index.test.js`, `worker/tests/data.test.js` and `worker/tests/auth.test.js` (whichever exist; `grep -l mintDevice worker/tests`).

**Interfaces:**
- Produces:
  - `authenticateDevice(request, env, now)` returns `{tokenHash, accountId}` or `null`. `null` if the token is unknown **or the account is disabled**.
  - `mintDevice(env, accountId, name, now)` returns the token. It throws `TypeError('accountId required')` if `accountId` is not a positive integer.
  - `handleGetData(env, accountId)` and `handlePutData(request, env, now, accountId)`.
  - `POST /admin/device` body `{name, accountId}`, where `accountId` is required.

- [ ] **Step 1: Failing tests:**
  - (a) A token for account 2 GETs account 2's row, never account 1's.
  - (b) A PUT CAS on account 2 does not touch account 1's version.
  - (c) `authenticateDevice` returns `null` for a device whose account has `disabled_at` set.
  - (d) `mintDevice(env, undefined, 'n', t)` throws.
  - (e) A GET for an account with no data row returns 500 `not_initialised`. **No empty fallback**, per spec § 8.
  - (f) `POST /admin/device` without `accountId` returns 400 `bad_request`.

  Example for (a):

```js
test('a token reads only its own account row', async () => {
  const DB = makeD1();
  await DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (2, 'b@x.de', 't')").run();
  await DB.prepare("INSERT INTO data (id, version, blob, updated_at) VALUES (2, 3, 'B', 't')").run();
  const env = { DB };
  const token = await mintDevice(env, 2, 'phone', 't');
  const res = await worker.fetch(new Request('https://w/data', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.deepEqual(await res.json(), { version: 3, blob: 'B' });
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
  - `authenticateDevice`: `SELECT d.token_hash, d.account_id FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.token_hash = ? AND a.disabled_at IS NULL`.
  - `data.js`: replace `id = 1` with `id = ?` bound to `accountId` in all three queries. Keep the fail-closed `changes` check and `not_initialised`.
  - `index.js` `handleData` passes `device.accountId`.
  - Remove the `TEMP(Task 3)` binding from Task 1.
  - Update every existing test call site to the new signatures. Existing `/data` tests use account 1, which migration 0002 seeds.
- [ ] **Step 4: `npm test` passes** (the full suite, including every pre-existing `/data` test).
- [ ] **Step 5: Mutation check.** Drop `AND a.disabled_at IS NULL` and confirm (c) fails. Hard-code `id = 1` in GET and confirm (a) fails.
- [ ] **Step 6: Commit** — `worker: devices and data scoped per account`

---

### Task 4: Sign-up, prelogin, login (lockout), logout, devices, account, recovery confirm

**Spec:** D11, D12, D23, § 6.1 step 5, § 6.2, § 6.6, § 6.1 step 7 (confirm).

**Files:** Create `worker/src/accounts.js`. Modify `worker/src/index.js` (routes). Test `worker/tests/accounts.test.js`.

**Interfaces:**
- Consumes: `atRest`, `checkKey`, `AtRestError` (Task 2); `mintDevice`, `authenticateDevice`, `sha256Hex` (Task 3).
- Produces the routes and JSON shapes below. Base64url fields are validated by length: `authKey`/`recAuthKey` decode to 32 bytes; `kdfSalt` to 16; `wrappedDek*` are base64 of 12 + 32 + 16 = 60 bytes.

| Route | Auth | Body | 200 | Errors |
|---|---|---|---|---|
| `POST /auth/signup` | — | `{invite,email,kdfSalt,kdfIters,authKey,recAuthKey,wrappedDekPw,wrappedDekRec,dekCheck,deviceName}` | `{token,accountId}` | 400 `bad_request`, 403 `invalid_invite`, 409 `email_taken`, 500 `not_configured`/`at_rest_key_mismatch` |
| `POST /auth/prelogin` | — | `{email}` | `{kdfSalt,kdfIters}` | 404 `no_account` (also for legacy null-email) |
| `POST /auth/login` | — | `{email,authKey,deviceName}` | `{token,accountId,wrappedDekPw,dekCheck,recoveryConfirmed}` | 401 `bad_credentials`, 403 `disabled`, 429 `locked {retryAt}` |
| `POST /auth/logout` | bearer | — | `{ok:true}` | 401 `unauthorized` |
| `GET /account` | bearer | — | `{accountId,email,recoveryConfirmed}` | 401 |
| `GET /account/devices` | bearer | — | `{devices:[{name,createdAt,lastSeenAt,current}]}` | 401 |
| `POST /account/devices/signout-others` | bearer | — | `{signedOut:n}` | 401 |
| `POST /account/recovery/confirm` | bearer | — | `{ok:true}` | 401 |

- [ ] **Step 1: Failing tests.** Helpers at the top of the file:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeD1 } from './fake-d1.js';
import { sha256Hex } from '../src/auth.js';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const b64u = (n, fill) => Buffer.alloc(n, fill).toString('base64url');
const b64 = (n, fill) => Buffer.alloc(n, fill).toString('base64');
function envWith() { return { DB: makeD1(), AT_REST_KEY: KEY, ADMIN_SECRET: 'adm' }; }
async function invite(env, code = 'INVITE-1') {
  await env.DB.prepare('INSERT INTO invites (hash, created_at) VALUES (?, ?)').bind(await sha256Hex(code), 't').run();
  return code;
}
function body(over = {}) {
  return { invite: 'INVITE-1', email: 'Tester@Example.com', kdfSalt: b64u(16, 1), kdfIters: 600000,
    authKey: b64u(32, 2), recAuthKey: b64u(32, 3), wrappedDekPw: b64(60, 4), wrappedDekRec: b64(60, 5),
    dekCheck: 'a'.repeat(64), deviceName: 'iPhone', ...over };
}
const post = (env, path, json, token) => worker.fetch(new Request(`https://w${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(json) }), env);
```

  Tests (each a separate `test()`):
  1. Sign-up with a valid invite returns `{token, accountId}`. The account row has the lowercased email, `failed_logins 0` and `recovery_confirmed_at NULL`. A `data` row exists with `version 0, blob ''`. One device row exists. `invites.used_at` is non-null.
  2. A second sign-up with the same invite returns 403 `invalid_invite`, and the account count is unchanged.
  3. An invite stays used after its account is deleted: delete that account's `usage`, `devices`, `data` and `accounts` rows directly, then re-sign-up with the same invite, which returns 403 (`used_at` persists).
  4. A revoked invite returns 403.
  5. A duplicate email with a fresh invite returns 409 `email_taken`. The **second invite is not consumed** (rollback): `used_at IS NULL`.
  6. A batch that throws rolls back everything. Wrap `env.DB.batch` so it throws for the sign-up call (`env.DB = { ...env.DB, batch: async () => { throw new Error('boom'); } }` for that one request). Assert 500 `internal_error`, zero accounts, zero data rows, and `used_at IS NULL`.
  7. Prelogin for a known email returns its salt and iters. Unknown returns 404. Legacy account 1 (null email) is not findable.
  8. Login with the right `authKey` returns token, `wrappedDekPw` (unsealed, equal to the signed-up value), `dekCheck`, `recoveryConfirmed:false`, and resets `failed_logins`.
  9. Login with a wrong key returns 401 `bad_credentials`; `failed_logins` increments.
  10. **Lockout at exactly 50:** 49 wrong attempts are still 401; the 50th is 401 and sets `locked_until`; the 51st (even with the *right* key) returns 429 `locked` with `retryAt`. Use an injectable clock: `env.NOW = () => '2026-11-11T12:00:00.000Z'` read by `accounts.js` via `nowISO(env)`. At `+61 min` the right key succeeds.
  11. **Concurrency:** 60 wrong logins fired with `Promise.all` give exactly 50 × 401 and 10 × 429, and `failed_logins` never exceeds 50.
  12. A disabled account returns 403 `disabled` on login.
  13. Logout deletes only the calling device; its token then gets 401 on `/data`.
  14. `GET /account/devices` lists both devices with `current` true only for the caller. `signout-others` leaves only the caller.
  15. `POST /account/recovery/confirm` sets `recovery_confirmed_at`; the next login returns `recoveryConfirmed:true`.
  16. A missing `AT_REST_KEY` returns 500 `not_configured` on signup and login. A changed key returns 500 `at_rest_key_mismatch` (sign up with key A, log in with key B).
  17. Response bodies and `console.log` never contain the email or keys: stub `console.log`/`console.error` during tests 1 and 9 and assert no captured string includes `tester@example.com` or `authKey`.

- [ ] **Step 2: Run and confirm failures.**
- [ ] **Step 3: Implement `accounts.js`.** The load-bearing SQL is below. Use these statements, not paraphrases.

  Sign-up batch (spec § 6.1 step 5). `nonce = `${now}|${crypto.randomUUID()}``:

```js
const inviteHash = await sha256Hex(b.invite);
const email = b.email.trim().toLowerCase();
const tokenRaw = /* 32 random bytes base64url, as auth.js does */;
const tokenHash = await sha256Hex(tokenRaw);
const results = await env.DB.batch([
  env.DB.prepare('UPDATE invites SET used_at = ? WHERE hash = ? AND used_at IS NULL AND revoked_at IS NULL').bind(nonce, inviteHash),
  env.DB.prepare(`INSERT INTO accounts (email, kdf_salt, kdf_iters, auth_mac, rec_auth_mac, dek_check, invite_hash, created_at)
                  SELECT ?, ?, ?, ?, ?, ?, hash, ? FROM invites WHERE hash = ? AND used_at = ?`)
    .bind(email, b.kdfSalt, b.kdfIters, await A.mac(b.authKey), await A.mac(b.recAuthKey), b.dekCheck, now, inviteHash, nonce),
  env.DB.prepare(`INSERT INTO data (id, version, blob, updated_at) SELECT id, 0, '', ? FROM accounts WHERE email = ? AND invite_hash = ?`)
    .bind(now, email, inviteHash),
  env.DB.prepare(`INSERT INTO devices (token_hash, account_id, name, created_at) SELECT ?, id, ?, ? FROM accounts WHERE email = ? AND invite_hash = ?`)
    .bind(tokenHash, deviceName, now, email, inviteHash),
]);
if (results[1].meta.changes !== 1) return json({ error: 'invalid_invite' }, 403);
```

  - The unique-email violation surfaces as a thrown error whose message contains `UNIQUE`. Map it to 409 `email_taken`; rethrow anything else.
  - The wrapped DEKs need the account id for their AAD. After the batch, `SELECT id`, then `UPDATE accounts SET wrapped_dek_pw_sealed = ?, wrapped_dek_rec_sealed = ? WHERE id = ? AND wrapped_dek_pw_sealed IS NULL`.
  - **This second step is a deliberate non-atomic tail.** If it fails, the account exists with null wraps. Login on such an account returns 500 `account_incomplete`, never a fallback, and the admin list shows it. Add test 18: force the tail to fail, then assert login returns 500 `account_incomplete` and a re-sign-up returns 409.
  - Add a `// WHY` comment naming the trade-off: an AAD on account id requires the id first. The alternative, a pre-chosen id via `SELECT max(id)+1`, races.

  Login attempt reservation (spec § 6.2 step 3):

```js
const lockUntil = addMinutes(now, 60);
const reserved = await env.DB.prepare(`UPDATE accounts SET failed_logins = failed_logins + 1,
    locked_until = CASE WHEN failed_logins + 1 >= 50 THEN ? ELSE locked_until END
  WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?) RETURNING failed_logins`).bind(lockUntil, row.id, now).first();
if (!reserved) return json({ error: 'locked', retryAt: row.locked_until }, 429);
```

  Lock semantics, pinned by test 10. The CASE leaves `failed_logins` at 50 when it sets the lock, so an expired lock must restart the count. **Before** the reservation, run `UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ? AND locked_until IS NOT NULL AND locked_until <= ?` (bind `now`). Then compare `timingSafeEqual(await A.mac(b.authKey), row.auth_mac)`. On success, batch `UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?` with the device insert.

  Every route starts with `const A = await atRest(env); await checkKey(env);` inside a `try` that maps `AtRestError` to 500 `{error: e.code}`.

- [ ] **Step 4: `npm test` passes.**
- [ ] **Step 5: Mutation checks.**
  - Remove the `AND used_at IS NULL` guard and confirm test 2 fails.
  - Remove the reservation (compare first, count after) and confirm test 11 fails.
  - Remove the lowercase normalisation and confirm test 7 fails (prelogin with `tester@example.com`).
- [ ] **Step 6: Commit** — `worker: sign-up, login with atomic lockout, sessions, recovery confirm`

---

### Task 5: Recovery, change password, new recovery link, upgrade

**Spec:** D9, D11 (recovery exempt), D18 (server side: `dekCheck` returned), § 6.3, § 6.4, § 6.5, § 6.7.

**Files:** Modify `worker/src/accounts.js`. Test `worker/tests/accounts-recovery.test.js`. Reuse the helpers by moving them to `worker/tests/account-helpers.js` in this task and importing them in both files.

| Route | Auth | Body | 200 | Errors |
|---|---|---|---|---|
| `POST /auth/recover/start` | — | `{email,recAuthKey}` | `{accountId,wrappedDekRec,dekCheck}` | 401 `bad_recovery`, 403 `disabled` |
| `POST /auth/recover/finish` | — | `{email,recAuthKey,kdfSalt,kdfIters,authKey,recAuthKey2,wrappedDekPw,wrappedDekRec2,deviceName}` | `{token,accountId}` | 401 `bad_recovery`, 409 `recovery_changed` |
| `POST /account/password` | bearer | `{currentAuthKey,kdfSalt,kdfIters,authKey,wrappedDekPw,signOutOthers}` | `{ok:true}` | 401 `bad_credentials`, 429 `locked`, 409 `password_changed` |
| `POST /account/recovery` | bearer | `{currentAuthKey,recAuthKey,wrappedDekRec}` | `{ok:true}` | 401, 429 |
| `POST /account/upgrade` | bearer | `{email,kdfSalt,kdfIters,authKey,recAuthKey,wrappedDekPw,wrappedDekRec,dekCheck}` | `{ok:true,accountId}` | 409 `already_upgraded`, 409 `email_taken` |

- [ ] **Step 1: Failing tests:**
  1. `recover/start` with the right `recAuthKey` returns the sealed-then-unsealed `wrappedDekRec`; a wrong key returns 401 and does **not** increment `failed_logins`.
  2. `recover/finish` replaces all credentials. The old `authKey` login gets 401 and the new one gets 200. The old `recAuthKey` gets 401. `recovery_confirmed_at` is NULL. Every pre-existing device token gets 401 on `/data`. Exactly one new device exists.
  3. **Concurrent finish:** two `recover/finish` calls with the same old `recAuthKey` and different new material via `Promise.all` give exactly one 200 and one 409 `recovery_changed`. Devices are deleted once and exactly one new device exists.
  4. `recover/finish` works while the account is locked (exempt), and clears `failed_logins`/`locked_until`.
  5. Password change with the right current key: the new key logs in; other devices stay unless `signOutOthers:true`, which leaves only the caller.
  6. Password change with a wrong current key returns 401 and increments `failed_logins`. At 50 it returns 429 (D11 reworded: password checks lock; sync does not). `/data` with the same token still returns 200 while locked.
  7. New recovery link: replaces `rec_auth_mac` and the wrapped rec, and clears `recovery_confirmed_at`.
  8. Upgrade on legacy account 1 with an account-1 token sets the email and credentials. A second upgrade returns 409 `already_upgraded`. A token of a non-legacy account returns 409 `already_upgraded`. An email already used by another account returns 409 `email_taken`.
  9. After upgrade, account 1's `data` row is byte-identical and both account-1 device tokens still work.
- [ ] **Step 2: Confirm the tests fail.**
- [ ] **Step 3: Implement.** `recover/finish` as one batch (spec § 6.3 step 4). The device DELETE is conditioned on the **new** `rec_auth_mac`, so it runs only if the UPDATE landed:

```js
const oldMac = await A.mac(b.recAuthKey), newMac = await A.mac(b.recAuthKey2);
const res = await env.DB.batch([
  env.DB.prepare(`UPDATE accounts SET kdf_salt=?, kdf_iters=?, auth_mac=?, rec_auth_mac=?, wrapped_dek_pw_sealed=?, wrapped_dek_rec_sealed=?,
      recovery_confirmed_at=NULL, failed_logins=0, locked_until=NULL WHERE id=? AND rec_auth_mac=?`)
    .bind(b.kdfSalt, b.kdfIters, await A.mac(b.authKey), newMac,
          await A.seal('wrapped_dek_pw_sealed', id, b.wrappedDekPw), await A.seal('wrapped_dek_rec_sealed', id, b.wrappedDekRec2), id, oldMac),
  env.DB.prepare('DELETE FROM devices WHERE account_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND rec_auth_mac = ?)').bind(id, id, newMac),
  env.DB.prepare('INSERT INTO devices (token_hash, account_id, name, created_at) SELECT ?, id, ?, ? FROM accounts WHERE id = ? AND rec_auth_mac = ?')
    .bind(tokenHash, deviceName, now, id, newMac),
]);
if (res[0].meta.changes !== 1) return json({ error: 'recovery_changed' }, 409);
```

  - **Hazard named for the implementer:** if two finishes produce the *same* `recAuthKey2` (impossible with random codes, but a test could do it), the second batch's DELETE would fire. Test 3 must use different new material.
  - Password change and new recovery link: verify the current key through the same reservation as login (factor `reservePasswordAttempt(env, row, now)` out of Task 4's code; it returns `null | {}`). Then run `UPDATE … WHERE id = ? AND auth_mac = ?old` and check `changes`.
  - Upgrade: `UPDATE accounts SET email=?, … WHERE id = ? AND email IS NULL`, with the caller's `accountId`. `changes === 0` gives 409 `already_upgraded`. A unique violation gives 409 `email_taken`.
- [ ] **Step 4: `npm test` passes.**
- [ ] **Step 5: Mutation checks.**
  - Make the DELETE unconditional and confirm test 3 fails (two deletes leave zero or two devices).
  - Remove the `email IS NULL` guard and confirm test 8 fails.
  - Count recovery failures toward the lockout and confirm test 1 fails.
- [ ] **Step 6: Commit** — `worker: recovery (single-use, atomic), password change, new recovery link, legacy upgrade`

---

### Task 6: Admin routes

**Spec:** D22, § 6.9.

**Files:** Create `worker/src/admin.js` and move `handleAdminDevice` there from `index.js`. Modify `index.js` routes. Test `worker/tests/admin.test.js`.

- [ ] **Step 1: Failing tests** (all with `authorization: Bearer adm`):
  1. Every admin route returns 401 without the secret or with a wrong one.
  2. `POST /admin/invite {note}` returns `{invite}` (22-char base64url). The DB stores only `sha256(invite)`. The invite works for sign-up once.
  3. `DELETE /admin/invite {hashPrefix}` with a ≥ 8-char prefix of an unused invite's hash sets `revoked_at`. An ambiguous prefix (matching 2) returns 409 `ambiguous`. A used invite returns 409 `already_used`.
  4. `GET /admin/accounts` lists `{id, email, createdAt, lastSeenAt, devices, smartAddToday, recoveryConfirmed, disabled}`: `lastSeenAt` is the max over devices, `smartAddToday` comes from `usage` for today's UTC day, and the legacy account shows `email: null`.
  5. `POST /admin/account/disable {id, disabled:true}` sets `disabled_at` and deletes devices in one batch; login gives 403. `disabled:false` clears it.
  6. `POST /admin/account/email {id, email}` changes the email. Login with the new email and the same `authKey` works: the wraps still unseal because their AAD is the account id.
  7. `DELETE /admin/account {id, confirm}` with a wrong `confirm` returns 400 `confirm_mismatch`. A correct one deletes usage, devices, data and account in one batch, and the invite stays used.
  8. Legacy `POST /admin/device {name, accountId}` works. Without `accountId` it returns 400.
- [ ] **Step 2: Confirm the tests fail.**
- [ ] **Step 3: Implement.** Admin keeps "auth before method before body", as in today's `handleAdminDevice`.
- [ ] **Step 4: `npm test` passes.**
- [ ] **Step 5: Commit** — `worker: admin routes for invites and accounts`

---

### Task 7: Smart-add cap, session gating, `/feed`, phased flag

**Spec:** D19, D20, D21, § 6.8, § 10.

**Files:** Create `worker/src/usage.js`. Modify `worker/src/index.js`, `worker/src/feed.js`, `scripts/smoke-worker.mjs`, `tests/smoke-worker.test.js`. Tests go in `worker/tests/usage.test.js` and additions to `worker/tests/feed.test.js` / `index.test.js`.

**Interfaces:**
- `takeSmartAddSlot(env, accountId, day)` returns `{ok:true, calls}` or `{ok:false}`.
- `recordTokens(env, accountId, day, inTok, outTok)`.
- `utcDay(iso)` returns `'YYYY-MM-DD'`.
- `REQUIRE_SESSION` is read as `env.REQUIRE_SESSION === 'true'`. Anything else counts as false, so the default is tolerant, which suits Phase 1.

- [ ] **Step 1: Failing tests:**
  1. With `REQUIRE_SESSION='true'`: smart add without a token returns 401 `unauthorized`, and the fetch stub to Anthropic is **never called** (count calls on a stubbed global `fetch`).
  2. With a token: the 1st–50th calls are 200 and the 51st is 429 `daily_limit` with `resetsAt` = next 00:00Z. Anthropic is called exactly 50 times.
  3. **Concurrency:** 55 parallel calls at the same instant give exactly 50 × 200 and 5 × 429.
  4. The UTC day rolls over: at `2026-11-11T23:59Z` the cap is reached; at `2026-11-12T00:00Z` the call is 200.
  5. A call that straddles midnight records tokens on the **request's** day (the day is captured once): stub Anthropic to return `usage:{input_tokens:900, output_tokens:120}` and advance the injected clock during the call.
  6. A Claude failure (stub 500) still consumes a slot (documented, D19).
  7. With `REQUIRE_SESSION` unset: smart add without a token goes through (tolerant), and **no usage row is written** (the account is unknown). With a token, usage is counted even in tolerant mode.
  8. `/feed` with `REQUIRE_SESSION='true'` and no token returns 401, and **`cache.match` is not called** (inject a cache spy). With a token it reaches the existing behaviour.
  9. A `/feed` OPTIONS preflight is unaffected by the session check and now lists `authorization` in `Access-Control-Allow-Headers`, with `Access-Control-Max-Age: 86400`.
  10. `/feed` with a bad Origin is still 403 *before* token checking (order: OPTIONS → Origin → token → cache).
  11. A disabled account's token returns 401 on smart add and feed (`authenticateDevice` returns null).
- [ ] **Step 2: Confirm the tests fail.**
- [ ] **Step 3: Implement.**
  - `handleFeed(request, deps)` gains `deps.authenticate`, an async function returning an account or `null`, plus `deps.requireSession`. `index.js` passes `(req) => authenticateDevice(req, env, nowISO())`. That keeps `feed.js` free of D1 imports.
  - Smart add:

```js
const device = await authenticateDevice(request, env, nowISO());
if (!device && requireSession(env)) return json({ error: 'unauthorized' }, 401);
const day = utcDay(nowISO());
if (device) {
  const slot = await takeSmartAddSlot(env, device.accountId, day);
  if (!slot.ok) return json({ error: 'daily_limit', resetsAt: nextUtcMidnight(day) }, 429);
}
// … existing Claude call …
if (device && data.usage) await recordTokens(env, device.accountId, day, data.usage.input_tokens | 0, data.usage.output_tokens | 0);
```

  - The log line gains token counts only: `smart-add claude_ms=… status=… in=… out=…`.
  - `scripts/smoke-worker.mjs` reads a token from `PLAENICKE_SMOKE_TOKEN` and sends it. With the variable unset it **exits non-zero with a message**, never silently tokenless. `tests/smoke-worker.test.js` gets a case for the missing variable.
- [ ] **Step 4: `npm test` passes.**
- [ ] **Step 5: Mutation checks.**
  - Move the token check after `cache.match` and confirm test 8 fails.
  - Replace the upsert-WHERE with read-then-insert and confirm test 3 fails.
- [ ] **Step 6: Commit** — `worker: per-account smart-add cap, session gating behind REQUIRE_SESSION, /feed auth before cache`

---

### Task 8: Client key derivation (`js/keys.js`)

**Spec:** § 4.1, D3, D6, D18.

**Files:** Create `js/keys.js`. Test `tests/keys.test.js`.

**Interfaces:**
- Produces:
  - `MIN_KDF_ITERS = 600000`.
  - `newSalt()` returns a 16-byte `Uint8Array`.
  - `async derivePasswordKeys(password, saltB64u, iters)` returns `{authKey: b64u32, wrapKey: CryptoKey}`. It throws `Error('kdf_iters_too_low')` if `iters < MIN_KDF_ITERS`, and `Error('bad_salt')` if the salt is not 16 bytes.
  - `newRecoveryCode()` returns a 22-char string.
  - `async deriveRecoveryKeys(code)` returns `{recAuthKey, wrapKey}`. It throws `Error('bad_recovery_code')` if the code does not decode to 16 bytes.
  - `async wrapDek(wrapKey, dek, kind /* 'pw'|'rec' */)` returns base64.
  - `async unwrapDek(wrapKey, wrapped, kind)` returns a `Uint8Array(32)`. It throws `Error('unwrap_failed')`.
  - `async dekCheck(dek)` returns 64-char hex.
  - `export const KDF_ITERS = 600000`.

- [ ] **Step 1: Failing tests:**
  1. A known-answer PBKDF2-HMAC-SHA-256 vector through the same WebCrypto path. Check the module derives `masterKey` with the documented parameters by exposing `_masterKeyForTest(password, salt, iters)`. Use the widely published vector: P="password", S="salt", c=1, dkLen=32 gives `120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b` (verify against RFC 7914 §11's PBKDF2-SHA256 vector or the Python `hashlib.pbkdf2_hmac` output in the test comment; the implementer must recompute and paste the source). This test bypasses the floor via the `_ForTest` hook.
  2. An HKDF-SHA-256 RFC 5869 Test Case 1 vector through WebCrypto (`deriveBits`), checked against the RFC's OKM truncated to 32 bytes. This proves the platform HKDF is the one the spec assumes.
  3. `derivePasswordKeys('pw', salt, 599999)` rejects with `kdf_iters_too_low`.
  4. Determinism: the same password, salt and iters give the same `authKey`. A different password or salt gives a different one.
  5. Separation: `authKey` ≠ the raw export of any wrap key (wrap keys are non-extractable; assert `exportKey` rejects).
  6. Round trip: `unwrapDek(k, await wrapDek(k, dek, 'pw'), 'pw')` equals `dek`. Unwrapping as `'rec'` throws `unwrap_failed` (AAD mismatch). A different password's key throws `unwrap_failed`.
  7. `newRecoveryCode()` is 22 chars of base64url and decodes to 16 bytes; 100 calls are all distinct.
  8. `dekCheck` is stable for one DEK and different across DEKs.
  9. NFKC: `'ﬁ'` (U+FB01) and `'fi'` derive the same `authKey`.
- [ ] **Step 2: Confirm the tests fail.**
- [ ] **Step 3: Implement** exactly per spec § 4.1. Use `bytesToBase64url`/`base64urlToBytes` from `js/crypto.js`; do not add another copy.
- [ ] **Step 4: `npm test` passes.** Note the test run time: 600k iterations in Node. If any single test exceeds 5 s, use the `_ForTest` hook with low iterations everywhere except test 3 and one real-count smoke test.
- [ ] **Step 5: Commit** — `client: key derivation, DEK wrapping, recovery codes (js/keys.js)`

---

### Task 9: Password policy

**Spec:** D10.

**Files:** Create `js/password-policy.js` and `js/common-passwords.js`. Test `tests/password-policy.test.js`. Add a license line to `js/common-passwords.js`'s header.

**Interfaces:** `checkPassword(password, email)` returns `{ok: boolean, problems: string[]}`. Problems are exactly these strings:
- `'At least 8 characters'`
- `'At least one number'`
- `'At least one symbol (like ! ? # or a space)'`
- `'Too common — pick something less guessable'`
- `'Don't use your email name in it'`

- [ ] **Step 1: Build the list.** Download SecLists `Passwords/Common-Credentials/10-million-password-list-top-100000.txt` (MIT) into the scratchpad. Keep only entries that **pass** the three composition rules, lowercase them and dedupe. Write `export const COMMON = new Set([...])`. Record the source URL, commit hash and the count in the file header. Measure the file size and report it; if it is over 100 KB, keep the top N that fit and record N.
- [ ] **Step 2: Failing tests:** a table covering:
  - `'short1!'` gives the length problem.
  - `'longpassword!'` gives no number.
  - `'longpassword1'` gives no symbol.
  - `'Password1!'` gives too common (assert it is in the list; if the download lacks it, the test fails loudly, which tells you the list is wrong).
  - `'alex.j2026!'` with `alex.j@x.de` gives the email name problem.
  - `'correct horse 7'` is ok (the space counts as a symbol).
  - A 64-character password is ok.
  - An empty string lists all its problems.
- [ ] **Step 3: Implement.** Compare `COMMON.has(password.toLowerCase())`.
- [ ] **Step 4: `npm test` passes.**
- [ ] **Step 5: Commit** — `client: password policy with common-password blocklist`

---

### Task 10: Client account API (`js/account.js`)

**Spec:** § 6.1–6.7, D18.

**Files:** Create `js/account.js`. Test `tests/account.test.js`.

**Interfaces:** Every function takes `{fetchImpl, apiBase}` last, with the defaults `fetch` and `WORKER_URL`. Each returns a value or throws `AccountError(code)`, where `code` is the Worker's `error` string, or `'unreachable'` / `'server'`. `export class AccountError extends Error { constructor(code, extra) {…} }`.
- `signUp({invite, email, password, deviceName})` → `{code /*86-char link code*/, accountId, recoveryCode}`. It generates the DEK with `generateEncKey`, `R` and the salt, derives and wraps, then POSTs.
- `logIn({email, password, deviceName})` → `{code, accountId, recoveryConfirmed}`. It refuses low iterations (`kdf_iters_too_low` propagates as an `AccountError`). After unwrapping it verifies `dekCheck`, and a mismatch throws `AccountError('dek_check_failed')`.
- `recover({email, recoveryCode, newPassword, deviceName})` → `{code, accountId, recoveryCode /*new*/}`.
- `changePassword({link, email, currentPassword, newPassword, signOutOthers})`. `link` comes from `getLink()`. It runs the D18 decrypt-check first: `GET /data` with the bearer, then `decryptBlob(link.encKey, blob)` unless `blob === ''`. On failure it throws `AccountError('wrong_key_on_device')`.
- `newRecoveryLink({link, email, currentPassword})` → `{recoveryCode}`, with the D18 check.
- `upgrade({link, email, password})` → `{recoveryCode, accountId}`, with the D18 check and `link.encKey` as the DEK.
- `getAccount({link})`, `listDevices({link})`, `signOutOthers({link})`, `confirmRecovery({link})`.
- `logOut({link})` → `{revoked: boolean}`. It never throws on network failure: it returns `{revoked:false}`.
- `recoveryLink(code)` returns `` `${APP_URL}#recover=${code}` ``, where `APP_URL` is added to `js/config.js` as `'https://ajaenicke518.github.io/plaenicke/'`.
- `mailtoHref(email, code)` returns a `mailto:` URL with an encoded subject "Your plaenicke recovery link" and a body that holds the link plus one sentence: "Keep this email. If you forget your password, open this link to reset it. Anyone with access to this email can reset your password."

- [ ] **Step 1: Failing tests** against a **fake server built from the real Worker**: `fetchImpl = (url, opts) => worker.fetch(new Request(url, opts), env)` with `env` from `worker/tests/account-helpers.js` (`AT_REST_KEY`, a minted invite). Use the `_ForTest` low-iteration hook through an injected `iters` option, or the suite becomes too slow. The production default stays 600k, and one test asserts `signUp` sends `kdfIters: 600000` when no override is given.
  1. `signUp` then `logIn` gives the same DEK (compare `parseLinkCode(code).encKey`) and different tokens.
  2. Wrong password gives `AccountError('bad_credentials')`.
  3. `recover` with the signed-up code: the old password now fails, the new one works, the returned new recovery code works for a second recovery, and the old code fails.
  4. A server returning `kdfIters: 1000` in prelogin (stub that one response) gives `kdf_iters_too_low`, and **no login request is sent**.
  5. A tampered `dekCheck` (stub the login response) gives `dek_check_failed`.
  6. `upgrade` from a device whose `encKey` cannot decrypt the account blob gives `wrong_key_on_device`, and **no upgrade request is sent**. Seed account 1's blob with `encryptBlob(keyA, {...})` and call with `keyB`.
  7. `logOut` while offline (`fetchImpl` rejects) returns `{revoked:false}` and does not throw.
  8. `mailtoHref` round-trips through `new URL()`, and the body contains `#recover=<code>`.
- [ ] **Step 2: Confirm the tests fail.**
- [ ] **Step 3: Implement.** `account.js` never imports `storage.js`.
- [ ] **Step 4: `npm test` passes.**
- [ ] **Step 5: Commit** — `client: account API (sign-up, login, recovery, password, upgrade)`

---

### Task 11: Local owner and boot fragments

**Spec:** D16, D24, § 6.1 step 1, § 6.3 step 1.

**Files:** Modify `js/storage.js`. Create `js/fragment.js`. Tests: `tests/storage.test.js` additions and `tests/fragment.test.js`.

**Interfaces:**
- `LOCAL_OWNER_KEY = 'plaenicke.localOwner'`, `loadLocalOwner()` returning `number|null`, `saveLocalOwner(id)`, `clearLocalOwner()`. Device-local; add it to storage.js's list of never-synced keys, with a comment at the constant naming D16.
- `readBootIntent({location, history})` returns `{kind:'invite', code} | {kind:'recover', code} | null`. When it finds an intent it **always** calls `history.replaceState(null, '', location.pathname + location.search)` before returning.

- [ ] **Step 1: Failing tests:**
  - `localOwner` round trip.
  - A corrupt value (`'abc'`) reads as `null`.
  - `readBootIntent` with `#invite=ABC` returns the intent and `replaceState` was called with no hash.
  - `#recover=X` returns the intent.
  - `#other` returns `null` and `replaceState` was **not** called.
  - No hash returns `null`.
  - `#invite=` with an empty code returns `null` but still strips the hash.
  - The `tests/sync.test.js` writer-scan still passes, with `localOwner` not listed as a synced key.
- [ ] **Step 2: Confirm the tests fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npm test` passes.**
- [ ] **Step 5: Commit** — `client: device-local account owner and boot-time invite/recover fragments`

---

### Task 12: linkui for accounts

**Spec:** D15, D16, D17, D27, § 6.10, § 6.11.

**Files:** Modify `js/linkui.js`. Test `tests/linkui.test.js` additions. **Read CLAUDE.md "Before you touch sync" and the ledger first.** This task changes the adoption entry point.

**Interfaces:**
- `initLinkUI(options)` returns `{ settled, linkAndAdopt(code, {accountId}) }`. `linkAndAdopt`:
  1. If `getLink()` is non-null, throws `Error('already_linked')` (D17).
  2. If `loadLocalOwner()` is non-null and `!== accountId`, **and** local items or feeds are non-empty (`localState()` from `sync.js`: items or feeds length > 0, tombstones ignored), throws `Error('other_account_data')`. Nothing is written.
  3. Otherwise runs `runAdoption((g) => doLink(code, g))`. After `linkWithCode` succeeds and before the preview, calls `saveLocalOwner(accountId)`. It returns the adoption's settled promise.
- `options.accountMode` is a function returning `'legacy' | 'account' | 'unlinked'`, computed by the caller from `loadLocalOwner()` and `getLink()`. When it is `'account'`:
  - `failureText('unauthorized')` and the 401 copy read: `"This device was signed out. Sign in again."`
  - The paste field and *Link another device* are hidden.
  - *Unlink* is labelled *Sign out* and calls `options.onSignOut()`. `onSignOut` is supplied by accountui and implements D27. linkui does not call `account.logOut` itself.
- With `options.accountMode` absent, linkui behaves exactly as today. Legacy devices keep their UI.

- [ ] **Step 1: Failing tests:**
  1. `linkAndAdopt` on an empty device: links, raises adoption, completes bootstrap against an empty remote, and `loadLocalOwner()` equals the accountId.
  2. **Owner guard blocks a different account:** with `localOwner = 5` and one local item, `linkAndAdopt(code, {accountId: 6})` rejects with `other_account_data`; `loadAuth()` stays null; items are unchanged.
  3. With `localOwner = 5` and no local items or feeds, `linkAndAdopt(code, {accountId: 6})` succeeds.
  4. Same owner (5 → 5) with local data: proceeds to the existing Merge dialog (assert the Merge button is present). It does not auto-merge.
  5. `already_linked` when already linked.
  6. **Account device 401 copy:** with `accountMode: () => 'account'` and `syncState.lastError = 'unauthorized'`, the rendered text contains "This device was signed out. Sign in again." and does **not** contain "86-character".
  7. In account mode the paste input and the "Link another device" control are absent, and the *Sign out* button calls `onSignOut`.
  8. Legacy mode (no `accountMode`): every pre-existing `linkui.test.js` test still passes unchanged.
  9. Concurrency: two `linkAndAdopt` calls in the same tick run one adoption (the second joins the first via `runAdoption`); `linkWithCode` is called once.
- [ ] **Step 2: Confirm the tests fail.**
- [ ] **Step 3: Implement.** Keep `doLink` unchanged. The owner write sits in `linkAndAdopt`'s wrapper, after `linkWithCode` resolves. `saveLocalOwner` must happen **before** `doPreview` so that a crash mid-adoption leaves the owner recorded. Explain in a `// WHY` comment: an unrecorded owner reopens the D16 cross-account merge.
- [ ] **Step 4: `npm test` passes.** Run it **five times**, since linkui tests poll WebCrypto (CLAUDE.md release flow).
- [ ] **Step 5: Mutation checks.**
  - Remove the owner guard and confirm test 2 fails.
  - Write the owner after the preview and confirm a test that throws from `doPreview` (add it) shows `localOwner` unset.
- [ ] **Step 6: Commit** — `linkui: linkAndAdopt with account-owner guard; account-mode copy and sign-out`

---

### Task 13: Account UI, settings mount, client bearer and error codes

**Spec:** § 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, D8, D21, D27; smart-add copy in § 6.8.

**Files:**
- Create: `js/accountui.js`.
- Modify: `js/settings.js` (mount Account above Sync; pass `linkAndAdopt` and `accountMode`), `js/app.js` (boot intent opens Settings at the Account section; banner host), `js/smartadd.js`, `js/feeds.js`, `index.html` (banner element `#account-banner`), `styles.css` (forms reuse existing tokens only; no new hard-coded colours; `tests/styles.test.js` enforces this).
- Test: `tests/accountui.test.js`; additions to `tests/smartadd.test.js`, `tests/feeds.test.js`, `tests/settings.test.js`.

**Contract (ids and copy are exact):**
- Section heading `Account`, container `#account-section`.
- Unlinked device: buttons `#acct-login` "Log in", `#acct-invite` "I have an invite", `#acct-forgot` "Forgot password".
- Forms:
  - `#acct-email` (`type=email`, `autocomplete=username`).
  - `#acct-password` (`autocomplete=current-password` on login, `new-password` on sign-up and reset).
  - `#acct-password2` (confirm; sign-up and reset only).
  - `#acct-invite-code`.
  - `#acct-recovery-code` (forgot only).
  - Submit `#acct-submit`.
  - Live policy list `#acct-policy`, one `<li>` per `checkPassword` problem.
  - Errors in `#acct-error`, `role=alert`.
- Error copy map:
  - `bad_credentials` → "Email or password is wrong."
  - `locked` → "Too many tries. Try again after <local time of retryAt>."
  - `invalid_invite` → "That invite code doesn't work. Ask Alex for a new one."
  - `email_taken` → "There's already an account with that email. Log in instead."
  - `no_account` → "No account with that email."
  - `disabled` → "This account is turned off. Ask Alex."
  - `bad_recovery` → "That recovery link doesn't match this email."
  - `other_account_data` → "This device holds another account's planner. Signing in here would copy it into that account."
  - `dek_check_failed` / `wrong_key_on_device` → "Something is wrong with this account's keys. Nothing was changed. Tell Alex."
  - `kdf_iters_too_low` → "The server asked for unsafe settings. Nothing was sent."
  - `unreachable` → "Can't reach the server. Check your connection."
  - `not_configured` / `at_rest_key_mismatch` / `server` → "The server isn't set up right. Tell Alex."
  - Any **unmapped** code → "Unexpected error: <code>". A visible code, never a generic fallback.
- Recovery screen `#acct-recovery-screen`:
  - The code in `#acct-recovery-value`.
  - `#acct-recovery-email` "Email it to me" (an `<a href=mailtoHref(...)>`).
  - `#acct-recovery-copy` "Copy".
  - `#acct-recovery-download` "Download" (a `Blob` `.txt` download containing the link and the sentence from Task 10).
  - Checkbox `#acct-recovery-saved` "I saved my recovery link".
  - `#acct-recovery-done` "Done", disabled until checked. It calls `confirmRecovery`.
- Linked account device: email shown; `#acct-change-password`, `#acct-new-recovery`, a devices list `#acct-devices`, `#acct-signout-others` "Sign out other devices", `#acct-signout` "Sign out".
- Legacy device (`getAccount` returns `email:null`): `#acct-upgrade` "Create your login".
- Banner `#account-banner`, shown while `recoveryConfirmed === false`: "Save your recovery link — without it, a forgotten password means losing your planner." with a button that opens *Make a new recovery link*. App load runs `getAccount` on linked account devices and paints the banner from the answer. If `getAccount` fails (offline or any error), the banner keeps its last painted state and the next successful `getAccount` repaints it. The failure is not written to `syncState` (that indicator belongs to sync). State this in a comment at the call site.
- Sign-out (D27): `logOut`, then `unlink()`. **`localOwner` is kept**, because the local data still belongs to that account and D16 needs the tag. If `revoked:false`, show "This device's session could not be revoked — use Sign out other devices from another device." Never block.
- Error copy for `account_incomplete` → "Your account setup didn't finish. Tell Alex."
- `smartadd.js`: send `authorization` when `getLink()` is non-null. Map 429 `daily_limit` to `Error('limit')` and 401 to `Error('unauthorized')`. `app.js` copy:
  - `limit` → "You've used today's smart adds. They reset at <local time of resetsAt>. You can still add it by picking a date."
  - `unauthorized` → "Signed out — sign in again to use smart add."
  - Signed out with no call made → "Sign in to use smart add."
- `feeds.js`: `syncFeed` gets `authToken` in its options and sends `authorization` when present. Signed out (no token) it returns `{ok:false, error:'signed_out'}` **without fetching**, and the Calendars list shows "Sign in to refresh calendars." The cache keeps rendering.

- [ ] **Step 1: Failing tests** (fake DOM; `account.js` functions injected as `options.api`, so UI tests do not run PBKDF2):
  1. Unlinked device: the three buttons render. Linked account device: change/new recovery/devices/sign-out render. Legacy device: "Create your login" renders.
  2. Sign-up happy path: submit calls `api.signUp`, then `linkAndAdopt(code, {accountId})`, **then** shows the recovery screen. Assert call order with a log array.
  3. *Done* is disabled until the checkbox is ticked. Clicking it calls `confirmRecovery`.
  4. **Banner shows while `recoveryConfirmed` is false** on load, and hides after confirm.
  5. Every mapped error code renders its exact copy. An unmapped code renders "Unexpected error: weird_code".
  6. `other_account_data` from `linkAndAdopt` renders its copy, and the account is **not** left half-linked (`loadAuth()` null).
  7. Sign-out offline: `unlink` was called, the warning copy is shown, and `localOwner` is preserved.
  8. The policy list updates on input. Submit is disabled while `checkPassword().ok` is false or the passwords differ.
  9. Boot intent `invite` opens Settings with the invite form pre-filled; `recover` opens the reset form pre-filled. **No `api` call happens on open** (link-scanner rule).
  10. `smartadd.test.js`: sends the bearer when linked; 429 gives `limit`; 401 gives `unauthorized`.
  11. `feeds.test.js`: sends the bearer; signed out gives `signed_out` and `fetchImpl` is never called.
- [ ] **Step 2: Confirm the tests fail.**
- [ ] **Step 3: Implement.** Follow `settings.js`'s per-open mount pattern. accountui mounts against a fresh element each open, like linkui.
- [ ] **Step 4: `npm test` passes** five times.
- [ ] **Step 5: Commit** — `client: account UI (sign-up, login, reset, recovery link, devices, upgrade) and bearer on smart add/feeds`

---

### Task 14: End-to-end convergence through real handlers

**Spec:** § 9 end-to-end.

**Files:** Test `tests/accounts-e2e.test.js` (new). No production code unless a defect is found. A defect gets its own failing test in the owning module's test file and a fix commit.

- [ ] **Step 1: Write the tests.** Two simulated devices run in one process, each with its own fake `localStorage` instance (swap `globalThis.localStorage` between device turns using the existing `installFakeLocalStorage` helper, or the established pattern in `tests/sync.test.js`, whichever the file uses). Both talk to one `env` through `fetchImpl = (u, o) => worker.fetch(new Request(u, o), env)` and use the **real** `syncOnce`.
  1. Device A: `signUp` → `linkAndAdopt` → add an item → `syncOnce`. Device B: `logIn` → `linkAndAdopt` → `syncOnce`, then B shows A's item. B edits it; A syncs and shows the edit.
  2. Legacy upgrade: seed account 1 by linking A and B the old way (admin-minted token + `composeForNewDevice`), both synced with items. A runs `upgrade`. B keeps syncing **without any action**, and both converge after an edit on each. The account-1 blob decrypts with the original `encKey` throughout.
  3. Recovery signs B out: A runs `recover`. B's next `syncOnce` returns `unauthorized`, and B's rendered status (linkui in account mode) shows "This device was signed out. Sign in again." B logs in with the new password and converges with A, with **no data lost** on either side (item sets equal and include B's last unsynced local edit after the merge).
  4. Cross-account guard end to end: device A (account 1 with items) signs out, then tries `logIn` to account 2, which gives `other_account_data`. Account 2's blob on the server is unchanged (version and blob bytes equal).
  5. Capped smart add in tolerant vs required mode through `worker.fetch` with a stubbed Anthropic: tolerant + tokenless gives 200; required + tokenless gives 401.
- [ ] **Step 2: Run `npm test` five times**, and check `# fail 0`/`# cancelled 0` each time.
- [ ] **Step 3: Commit** — `test: end-to-end accounts convergence through real Worker handlers and real sync`

---

### Task 15: Service worker, docs, CLAUDE.md

**Files:** Modify `service-worker.js`, `tests/serviceworker.test.js` (the `CACHE_ON_MAIN` pin stays main's live value), `CLAUDE.md`, `worker/README.md`. Create `docs/admin.md`.

- [ ] **Step 1:** Add `js/keys.js`, `js/password-policy.js`, `js/common-passwords.js`, `js/account.js`, `js/accountui.js` and `js/fragment.js` to `ASSETS`. Pick the new `CACHE` name after `git branch -a` plus `git grep -n "plaenicke-v6-" $(git for-each-ref --format='%(refname:short)' refs/heads)`. Use the next number unused on any branch, and record the choice in the commit body. Run the existing serviceworker test that asserts every imported module is precached.
- [ ] **Step 2:** Write `docs/admin.md`: curl recipes for every admin route, with `ADMIN=$(cat ~/.plaenicke-admin-secret)`; minting an invite and the message to send a tester; the § 10 release checklist verbatim; the tester instructions verbatim; the rollback rule.
- [ ] **Step 3:** In `CLAUDE.md`:
  - Replace "Single user" with "Invite-only multi-user (V7 accounts, spec 2026-11-11)".
  - Add a short "Accounts" section with: the `AT_REST_KEY` secret and its backup rule; `REQUIRE_SESSION`; "login enters through `linkAndAdopt`, never `linkWithCode` directly"; "`plaenicke.localOwner` guards cross-account merges; never clear it on sign-out".
  - Update "Where things live" with the spec and `docs/admin.md`.
  - Update "Device linking" to say testers never see link codes.
- [ ] **Step 4:** `npm test` five times.
- [ ] **Step 5: Commit** — `docs + service worker for V7 accounts`

---

## Out of scope (explicit)

Production migration, secrets, deploys and merges (spec § 10, Alex-run); custom domain; DEK rotation; AT_REST_KEY rotation; erase-this-browser; desktop layout; themes; notifications; PBKDF2 timing on iPhone (Alex-run measurement).
