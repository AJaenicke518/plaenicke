# plaenicke V5 — Plan 2 of 3: Worker Sync Backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Worker a D1-backed store that holds one opaque encrypted blob, guarded by device tokens and updated through compare-and-swap — per spec §§ 4.1, 4.2, 5.2, 5.3, 6.1.

**Architecture:** The Worker gains explicit routing (it currently treats every non-`/feed` path as smart-add), a single D1 database with a one-row `data` table plus a `devices` table, and two endpoints: `GET /data` returns `{version, blob}`, `PUT /data` accepts `{version, blob}` and succeeds only if the version still matches. The server never interprets the blob — it is ciphertext produced and read by the client in Plan 3.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), `node --test`. No dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-08-01-plaenicke-v5-accounts-sync-design.md`

## Global Constraints

- **The server never decrypts.** `blob` is an opaque string; no route parses, validates, or logs its contents.
- **Feed URLs are secrets** and live inside the blob — never log a request body, never echo a blob into an error message.
- **The link code's encryption key never reaches the server.** `POST /admin/device` issues an auth token only; the client composes the link code in Plan 3. Nothing in this plan generates, stores, or transports an encryption key.
- **Device tokens are stored hashed** (SHA-256 hex), never in plaintext. A token is returned exactly once, at mint time.
- **`ADMIN_SECRET` comparison must be timing-safe.** Token lookup is by hash as a primary key, so it needs no comparison.
- **Smart-add stays public in this plan.** Spec § 9 sequences the auth flip *last*, after sync is proven; flipping it here would break the owner's own smart-add. Do not touch `POST /` behaviour beyond routing.
- Blob size cap: **1,000,000 characters** (D1's row limit is 2 MB — verified; this leaves headroom for encryption overhead).
- Worker test command: **`cd worker && npm test`**. Node is v22.18.0.
- No new dependencies. `node:sqlite` is built in and used only by tests.

## File Structure

```
worker/src/cors.js              — NEW: the single ALLOWED_ORIGIN + cors()/json() helpers
worker/src/auth.js              — NEW: device-token hash/verify/mint/revoke, admin check
worker/src/data.js              — NEW: GET /data and PUT /data (compare-and-swap)
worker/src/index.js             — MODIFY: explicit route table, 404 default
worker/src/feed.js              — MODIFY: import ALLOWED_ORIGIN from cors.js
worker/migrations/0001_init.sql — NEW: D1 schema
worker/wrangler.toml            — MODIFY: D1 binding
worker/tests/fake-d1.js         — NEW: D1-shaped adapter over node:sqlite (real SQL)
worker/tests/auth.test.js       — NEW
worker/tests/data.test.js       — NEW
worker/tests/index.test.js      — MODIFY: CORS assertions, 404 coverage
```

## Owner step (manual, before Task 3 can be deployed)

Creating the D1 database requires the owner's Cloudflare account:

```bash
cd worker && npx wrangler d1 create plaenicke
```

That prints a `database_id`. It goes into `wrangler.toml` (Task 3). **Tests do not need this** — they run against `node:sqlite`. Only deployment does.

---

### Task 1: Extract CORS into one module

`ALLOWED_ORIGIN` is currently duplicated across `worker/src/index.js:7`, `worker/src/feed.js:11`, and both test files — a security constant with four copies is a drift hazard. This task consolidates it and widens the preflight for the new routes.

**Files:**
- Create: `worker/src/cors.js`
- Modify: `worker/src/index.js:7-22`, `worker/src/feed.js:11`
- Test: `worker/tests/index.test.js:16-17`

**Interfaces:**
- Produces: `ALLOWED_ORIGIN: string`, `cors(headers?: object): object`, `json(obj: any, status?: number): Response` — all exported from `worker/src/cors.js`. `cors()` returns `Access-Control-Allow-Methods: 'GET, POST, PUT, DELETE, OPTIONS'` and `Access-Control-Allow-Headers: 'content-type, authorization'`.

- [ ] **Step 1: Update the existing preflight assertions**

`worker/tests/index.test.js:16-17` currently pins the old values. Change them to:

```js
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, POST, PUT, DELETE, OPTIONS');
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'content-type, authorization');
```

Then append a test that the constant is shared rather than copied:

```js
test('feed.js and index.js agree on the allowed origin', async () => {
  const { ALLOWED_ORIGIN: fromCors } = await import('../src/cors.js');
  assert.equal(fromCors, 'https://ajaenicke518.github.io');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `../src/cors.js` cannot be resolved, and the two assertions mismatch.

- [ ] **Step 3: Implement**

`worker/src/cors.js`:

```js
// cors.js — the single source of truth for the allowed origin and the JSON
// response shape. Previously duplicated across index.js and feed.js; a
// security constant with several copies drifts.

export const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';

export function cors(headers = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'content-type': 'application/json',
    ...headers,
  };
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors() });
}
```

- [ ] **Step 4: Replace the duplicates**

In `worker/src/index.js`, delete the local `ALLOWED_ORIGIN`, `cors`, and `json` definitions (lines 7-22, keeping the `ISO` regex) and import instead:

```js
import { cors, json } from './cors.js';
```

In `worker/src/feed.js`, delete its local `const ALLOWED_ORIGIN` at line 11 and import it:

```js
import { ALLOWED_ORIGIN } from './cors.js';
```

Leave `feed.js`'s own `cors()` helper alone — it declares a narrower `GET, OPTIONS` method set appropriate to that route, and `feed.test.js:477` asserts it. Only the origin constant is shared.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npm test` — Expected: PASS

- [ ] **Step 6: Verify no copies remain**

Run: `grep -rn "ajaenicke518.github.io" worker/src/`
Expected: exactly one match, in `worker/src/cors.js`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(worker): single ALLOWED_ORIGIN, widen preflight for sync routes"
```

---

### Task 2: Explicit routing with a 404 default

`worker/src/index.js:34-40` treats **every** path except `/feed` as smart-add. A typo'd client path silently spends Anthropic budget instead of erroring, and there is nowhere to hang the new routes.

**Files:**
- Modify: `worker/src/index.js:32-89`
- Test: `worker/tests/index.test.js`

**Interfaces:**
- Produces: `handleSmartAdd(request, env): Promise<Response>` — exported from `worker/src/index.js`, containing the body that currently lives inline in `fetch`. Behaviour unchanged.
- Produces: `fetch` dispatches on `pathname`; anything unmatched returns `404 {error: 'not_found'}`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/index.test.js`:

```js
test('an unknown path returns 404 rather than falling through to smart-add', async () => {
  const request = new Request('https://worker.example/nope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'dentist tuesday' }),
  });
  const res = await worker.fetch(request, ENV);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not_found');
});

test('a GET to an unknown path returns 404, not method_not_allowed', async () => {
  const res = await worker.fetch(new Request('https://worker.example/nope'), ENV);
  assert.equal(res.status, 404);
});

test('OPTIONS on any path still returns the preflight', async () => {
  const res = await worker.fetch(
    new Request('https://worker.example/data', { method: 'OPTIONS' }), ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://ajaenicke518.github.io');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd worker && npm test`
Expected: FAIL — unknown paths currently reach smart-add and return 400 `empty_text` or 502, not 404.

- [ ] **Step 3: Implement**

Restructure `worker/src/index.js`'s default export. Move the existing smart-add body verbatim into an exported `handleSmartAdd(request, env)` — do not change a line of its logic — and make `fetch` a router:

```js
export async function handleSmartAdd(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  // ...the existing body, unchanged, from `let payload;` through the final return...
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Preflight first: it must answer for every route, including unknown ones.
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (pathname === '/feed') {
      return handleFeed(request, { fetchImpl: fetch, cache: caches.default });
    }
    if (pathname === '/') return handleSmartAdd(request, env);

    return json({ error: 'not_found' }, 404);
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npm test` — Expected: PASS, including every pre-existing smart-add test unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(worker): explicit routing, unknown paths 404 instead of hitting smart-add"
```

---

### Task 3: D1 schema, binding, and a real-SQL test double

**Files:**
- Create: `worker/migrations/0001_init.sql`, `worker/tests/fake-d1.js`
- Modify: `worker/wrangler.toml`
- Test: `worker/tests/fake-d1.test.js`

**Interfaces:**
- Produces: `makeD1(): D1-shaped object` exported from `worker/tests/fake-d1.js`, backed by `node:sqlite` so tests exercise real SQL. Supports `prepare(sql).bind(...args).first()` → row or `null`, `.all()` → `{results}`, `.run()` → `{success, meta: {changes}}`, and `exec(sql)` for applying the migration.
- Produces: the schema in `0001_init.sql`, applied by `makeD1()` so tests and production share one definition.

- [ ] **Step 1: Write the migration**

`worker/migrations/0001_init.sql`:

```sql
-- Device tokens. The token itself is never stored — only its SHA-256 hex.
CREATE TABLE IF NOT EXISTS devices (
  token_hash   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);

-- Exactly one row, enforced by the CHECK. Holds the opaque encrypted blob and
-- the version used for compare-and-swap. The server never reads inside `blob`.
CREATE TABLE IF NOT EXISTS data (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seed so GET /data always has a row and the first PUT is version 0 -> 1.
INSERT OR IGNORE INTO data (id, version, blob, updated_at)
VALUES (1, 0, '', '1970-01-01T00:00:00.000Z');
```

- [ ] **Step 2: Write the failing test for the double**

`worker/tests/fake-d1.test.js`:

```js
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd worker && npm test`
Expected: FAIL — `./fake-d1.js` cannot be resolved.

- [ ] **Step 4: Implement the double**

`worker/tests/fake-d1.js`:

```js
// fake-d1.js — a D1-shaped adapter over node:sqlite, for tests only.
//
// Backed by real SQLite rather than pattern-matched fake responses, so the SQL
// the Worker actually issues — including the compare-and-swap UPDATE and the
// single-row CHECK — is genuinely exercised. Mirrors the subset of the D1
// binding the Worker uses: prepare().bind().first()/all()/run().
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
        const row = db.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...args) };
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) }, results: [] };
      },
    };
    return api;
  }

  return { prepare, exec: (sql) => db.exec(sql) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd worker && npm test` — Expected: PASS (4 new tests)

Note: `node:sqlite` emits an `ExperimentalWarning` on import. That is expected noise and not a failure.

- [ ] **Step 6: Add the D1 binding to wrangler.toml**

Append to `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "plaenicke"
database_id = "REPLACE_AFTER_wrangler_d1_create"
```

The placeholder is intentional — `database_id` comes from the owner running `npx wrangler d1 create plaenicke`, which needs their Cloudflare account. Deployment is blocked on it; tests are not.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(worker): D1 schema, binding, and a real-SQL test double over node:sqlite"
```

---

### Task 4: Device-token authentication

**Files:**
- Create: `worker/src/auth.js`
- Test: `worker/tests/auth.test.js`

**Interfaces:**
- Produces, all exported from `worker/src/auth.js`:
  - `sha256Hex(s: string): Promise<string>`
  - `bearerToken(request): string | null` — parses `Authorization: Bearer <token>`
  - `authenticateDevice(request, env, now: string): Promise<string | null>` — returns the matching `token_hash`, or `null`. Updates `last_seen_at` on success.
  - `isAdmin(request, env): boolean` — timing-safe comparison against `env.ADMIN_SECRET`; `false` when the secret is unset.
  - `mintDevice(env, name: string, now: string): Promise<string>` — returns the plaintext token **once**; stores only its hash.
  - `revokeDevice(env, tokenHash: string): Promise<boolean>` — `true` if a row was removed.

- [ ] **Step 1: Write the failing tests**

`worker/tests/auth.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd worker && npm test`
Expected: FAIL — `../src/auth.js` cannot be resolved.

- [ ] **Step 3: Implement**

`worker/src/auth.js`:

```js
// auth.js — device-token authentication.
//
// A token is 32 random bytes, base64url-encoded, handed to the owner exactly
// once at mint time. Only its SHA-256 hex is stored, so a database leak yields
// no usable credential. Lookup is BY hash as a primary key, so no secret
// comparison happens on the request path.
//
// Note this issues the AUTH half of a link code only. The encryption key that
// protects the blob is generated and held client-side and never reaches this
// Worker — see spec 4.1.

const TOKEN_BYTES = 32;

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

// Constant-time for equal-length inputs; length itself is not secret.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAdmin(request, env) {
  const token = bearerToken(request);
  if (!token || !env.ADMIN_SECRET) return false;
  return timingSafeEqual(token, env.ADMIN_SECRET);
}

export async function authenticateDevice(request, env, now) {
  const token = bearerToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT token_hash FROM devices WHERE token_hash = ?')
    .bind(hash).first();
  if (!row) return null;
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash = ?')
    .bind(now, hash).run();
  return hash;
}

export async function mintDevice(env, name, now) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  await env.DB.prepare('INSERT INTO devices (token_hash, name, created_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), name, now).run();
  return token;
}

export async function revokeDevice(env, tokenHash) {
  const res = await env.DB.prepare('DELETE FROM devices WHERE token_hash = ?').bind(tokenHash).run();
  return res.meta.changes > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npm test` — Expected: PASS (7 new tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): device-token auth with hashed storage and timing-safe admin check"
```

---

### Task 5: `GET /data` and `PUT /data` with compare-and-swap

**Files:**
- Create: `worker/src/data.js`
- Test: `worker/tests/data.test.js`

**Interfaces:**
- Consumes: `json` from `worker/src/cors.js`.
- Produces: `handleGetData(env): Promise<Response>` → `200 {version, blob}`.
- Produces: `handlePutData(request, env, now): Promise<Response>` → `200 {version}` on success, `409 {error:'version_conflict', version, blob}` when the version no longer matches (the current server state is returned so the client can merge and retry), `400 {error:'bad_json'|'bad_request'}`, `413 {error:'blob_too_large', max}`.
- Produces: `MAX_BLOB_CHARS = 1000000`.

- [ ] **Step 1: Write the failing tests**

`worker/tests/data.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd worker && npm test`
Expected: FAIL — `../src/data.js` cannot be resolved.

- [ ] **Step 3: Implement**

`worker/src/data.js`:

```js
// data.js — the sync store. One row, one opaque blob, updated by
// compare-and-swap.
//
// The server never decrypts or parses `blob`; it is ciphertext produced by the
// client. It therefore also never appears in an error message or a log — feed
// URLs are capability tokens and live inside it.
//
// Compare-and-swap rather than read-modify-write because D1 has no interactive
// transactions: the UPDATE below is a single atomic statement, so two devices
// writing concurrently cannot both win.
import { json } from './cors.js';

export const MAX_BLOB_CHARS = 1_000_000;

export async function handleGetData(env) {
  const row = await env.DB.prepare('SELECT version, blob FROM data WHERE id = 1').first();
  if (!row) return json({ error: 'not_initialised' }, 500);
  return json({ version: row.version, blob: row.blob });
}

export async function handlePutData(request, env, now) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const version = payload && Number.isInteger(payload.version) ? payload.version : null;
  const blob = payload && typeof payload.blob === 'string' ? payload.blob : null;
  if (version === null || version < 0 || blob === null) return json({ error: 'bad_request' }, 400);
  if (blob.length > MAX_BLOB_CHARS) {
    return json({ error: 'blob_too_large', max: MAX_BLOB_CHARS }, 413);
  }

  const res = await env.DB.prepare(
    'UPDATE data SET blob = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?',
  ).bind(blob, now, version).run();

  if (res.meta.changes === 0) {
    // Someone else wrote first. Hand back current state so the client can
    // merge and retry rather than guessing.
    const cur = await env.DB.prepare('SELECT version, blob FROM data WHERE id = 1').first();
    return json({ error: 'version_conflict', version: cur.version, blob: cur.blob }, 409);
  }

  return json({ version: version + 1 });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npm test` — Expected: PASS (7 new tests)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): GET/PUT /data with compare-and-swap versioning"
```

---

### Task 6: Wire the routes

**Files:**
- Modify: `worker/src/index.js`
- Test: `worker/tests/index.test.js`

**Interfaces:**
- Consumes: `handleGetData`, `handlePutData` (Task 5); `authenticateDevice`, `isAdmin`, `mintDevice`, `revokeDevice` (Task 4).
- Produces: routes `/data` (GET, PUT — device token required) and `/admin/device` (POST, DELETE — `ADMIN_SECRET` required), plus a `nowISO()` boundary function so handlers stay time-injectable.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/index.test.js` (import `makeD1` from `./fake-d1.js` and `mintDevice` from `../src/auth.js`):

```js
test('/data requires a device token', async () => {
  const env = { ...ENV, DB: makeD1() };
  const res = await worker.fetch(new Request('https://worker.example/data'), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

test('/data with a valid token returns the seeded state', async () => {
  const env = { ...ENV, DB: makeD1() };
  const token = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');
  const res = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: `Bearer ${token}` },
  }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 0, blob: '' });
});

test('/data rejects an unsupported method', async () => {
  const env = { ...ENV, DB: makeD1() };
  const token = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');
  const res = await worker.fetch(new Request('https://worker.example/data', {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  }), env);
  assert.equal(res.status, 405);
});

test('/admin/device requires the admin secret, not a device token', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const deviceToken = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');

  const asDevice = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone' }),
  }), env);
  assert.equal(asDevice.status, 401);

  const asAdmin = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone' }),
  }), env);
  assert.equal(asAdmin.status, 200);
  const body = await asAdmin.json();
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.name, 'phone');
});

test('a minted token immediately works against /data', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const minted = await (await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone' }),
  }), env)).json();

  const res = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: `Bearer ${minted.token}` },
  }), env);
  assert.equal(res.status, 200);
});

test('smart-add is still public — this plan does not flip it', async () => {
  const env = { ...ENV, DB: makeD1() };
  const res = await worker.fetch(new Request('https://worker.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'empty_text');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd worker && npm test`
Expected: FAIL — `/data` and `/admin/device` currently return 404.

- [ ] **Step 3: Implement**

Add to `worker/src/index.js` (importing `handleGetData`/`handlePutData` from `./data.js` and the four auth helpers from `./auth.js`):

```js
function nowISO() { return new Date().toISOString(); }

async function handleData(request, env) {
  const device = await authenticateDevice(request, env, nowISO());
  if (!device) return json({ error: 'unauthorized' }, 401);
  if (request.method === 'GET') return handleGetData(env);
  if (request.method === 'PUT') return handlePutData(request, env, nowISO());
  return json({ error: 'method_not_allowed' }, 405);
}

async function handleAdminDevice(request, env) {
  if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  if (request.method === 'POST') {
    const name = payload && typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) return json({ error: 'bad_request' }, 400);
    // The token is returned here and never again — only its hash is stored.
    const token = await mintDevice(env, name, nowISO());
    return json({ token, name });
  }

  if (request.method === 'DELETE') {
    const hash = payload && typeof payload.token_hash === 'string' ? payload.token_hash : '';
    if (!hash) return json({ error: 'bad_request' }, 400);
    return json({ revoked: await revokeDevice(env, hash) });
  }

  return json({ error: 'method_not_allowed' }, 405);
}
```

Then add to the router in `fetch`, before the 404 fallback:

```js
    if (pathname === '/data') return handleData(request, env);
    if (pathname === '/admin/device') return handleAdminDevice(request, env);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && npm test` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): wire /data and /admin/device routes behind their respective auth"
```

---

### Task 7: Deployment notes

**Files:**
- Create: `worker/README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write the deployment notes**

`worker/README.md`:

```markdown
# plaenicke-worker

Routes:

| Route | Auth | Purpose |
|---|---|---|
| `GET /feed?url=…` | Origin check | ICS proxy |
| `POST /` | none (public) | Smart-add via Claude Haiku |
| `GET /data` | `Bearer <device token>` | Fetch `{version, blob}` |
| `PUT /data` | `Bearer <device token>` | Compare-and-swap `{version, blob}` |
| `POST /admin/device` | `Bearer <ADMIN_SECRET>` | Mint a device token (returned once) |
| `DELETE /admin/device` | `Bearer <ADMIN_SECRET>` | Revoke by `token_hash` |
| anything else | — | 404 |

## One-time setup

```bash
cd worker
npx wrangler d1 create plaenicke        # copy database_id into wrangler.toml
npx wrangler d1 execute plaenicke --remote --file=migrations/0001_init.sql
npx wrangler secret put ADMIN_SECRET    # a long random string you keep
npx wrangler deploy
```

## Minting a device token

```bash
curl -X POST https://<worker-host>/admin/device \
  -H "authorization: Bearer $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"name":"laptop"}'
```

The token is shown **once**. Only its SHA-256 hash is stored, so it cannot be
recovered — mint a new one and revoke the old if it is lost.

## What the server does not know

`blob` is ciphertext. The encryption key lives only on the client and is never
sent here, so a full database compromise yields no readable calendar data and
no feed URLs. Nothing in this Worker parses, validates, or logs blob contents.

## Not yet done

`POST /` is still public. Requiring a device token there is sequenced last, in
Plan 3, after sync is proven end-to-end — see spec § 9.
```

- [ ] **Step 2: Run the full suite and commit**

Run: `cd worker && npm test`

```bash
git add -A && git commit -m "docs(worker): routes, one-time setup, and the encryption boundary"
```

---

## Self-Review (completed at plan time)

**Spec coverage for Plan 2's scope:** § 4.2 route table → Tasks 2 and 6, with the explicit 404 replacing the current catch-all. § 4.2 `ALLOWED_ORIGIN` consolidation → Task 1. § 5.2 D1 schema (`devices`, one-row `data`) → Task 3. § 5.3 compare-and-swap protocol and the 409-returns-current-state contract → Task 5. § 6.1 device tokens hashed at rest, revocable → Task 4. § 6.6 blob byte cap → Task 5. § 4.1 the encryption key never reaching the server → enforced by omission and documented in Task 7.

**Deliberately deferred, per spec § 9's rollout order:** authenticating `POST /` and the per-day quota (both belong with the smart-add flip, after sync is proven — a Task 6 test pins that smart-add is still public so the deferral is explicit rather than forgotten). `usage` table, client-side encryption, merge, and adoption UI are Plan 3.

**Placeholder scan:** one intentional placeholder — `database_id = "REPLACE_AFTER_wrangler_d1_create"` in Task 3, which cannot be filled without the owner's Cloudflare account and is called out as an owner step at the top of this plan. No others.

**Type consistency:** `makeD1()` from Task 3 is used identically in Tasks 4, 5, and 6. `sha256Hex`, `mintDevice`, `authenticateDevice`, `isAdmin`, `revokeDevice` are defined in Task 4 with the exact signatures Task 6 calls. `json` from Task 1 is used by Tasks 5 and 6. `MAX_BLOB_CHARS` is defined once in Task 5 and imported by its test. `res.meta.changes` matches the verified D1 `run()` shape and the `node:sqlite` adapter in Task 3 maps `changes` onto it.

**Known risk:** `node:sqlite` is experimental in Node 22 and prints an `ExperimentalWarning`. It is used only by tests, never shipped to the Worker, so a future change to it cannot break production — only the test double, visibly.
