# plaenicke V5 — Plan 3 of 4: Client Sync Orchestration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two devices show the same items and calendar subscriptions, by encrypting local state client-side and syncing it through the Worker's compare-and-swap `/data` endpoint — per spec §§ 5.4–5.7, 6.2–6.3, 6.6, 7.

**Architecture:** A pure `merge()` over `{items, feeds, tombstones}` decides what the combined state is. `sync.js` orchestrates pull → decrypt → merge → apply → encrypt → push with bounded compare-and-swap retry, and **never writes storage directly** — it hands merged state to the modules that own each key. `crypto.js` holds AES-GCM and link-code encoding; `auth.js` holds the link-code lifecycle; `linkui.js` holds the linking DOM.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. Web Crypto (`crypto.subtle`, `crypto.getRandomValues`). `node --test` with injected effects, matching `js/feeds.js`.

**Spec:** `docs/superpowers/specs/2026-08-01-plaenicke-v5-accounts-sync-design.md`

## Global Constraints

- **`sync.js` must never import `saveItems`, `saveFeeds`, or `saveFeedCache`.** Spec § 5.5: `app.js:53` holds `let items = loadItems()` at module scope and writes the whole array back. A second writer means the next `addItems()` silently reverts every pulled record — **deterministically, not as a race**. Merged state reaches storage only through owner callbacks.
- **Apply before advancing.** Write merged state to `localStorage` first, persist the new `syncState.version` second. Reversing this loses pulled data permanently on any failure between the two (spec § 7).
- **A fresh random 12-byte IV per encryption, from `crypto.getRandomValues`.** Never derived from the version, the key, a counter, or anything else stable. AES-GCM loses confidentiality catastrophically on IV reuse. This is the single highest-consequence requirement in the plan.
- **`encKey` never leaves the device and is never sent to the Worker.** Only `authToken` goes on the wire, as `Authorization: Bearer <token>`.
- **The client refuses to apply a blob it cannot parse** (spec § 6.6). A decrypt failure or an unknown `schemaVersion` halts the sync and surfaces — it never partially applies. A record silently dropped by a deserializer would look like a local deletion and propagate a tombstone to every device.
- **`color` and `hidden` are per-device and never sync** (spec § 6.3). `merge` preserves the local values for a feed that already exists locally, and emits `color: null` for a feed seen for the first time; `feeds.js` assigns the real default because it owns the colour cycle.
- **A pulled feed deletion goes through `feeds.js`'s `removeFeed()`, never a raw `saveFeeds()`** (spec § 6.3). Otherwise `feedCache[id]` is orphaned forever — never read, but still iterated and re-serialised by `pruneForQuota` — a permanent quota leak on the most constrained device.
- **CAS retry is bounded at 3 attempts, then halt and surface** (spec § 5.3). The Worker's conflict check fails *closed*: an unexpected `meta.changes` shape from D1 makes every `PUT` return 409 permanently, so an unbounded retry loop would spin forever.
- `schemaVersion` is `1`. A blob with any other value is rejected, not migrated.
- Feed URLs are capability tokens. Never log a blob, a request body, a feed URL, or a link code. Log error *names* only, matching `js/feeds.js:456`.
- Test command: **`npm test`** at the repo root. **`node --test tests/` runs ZERO tests** — it treats the directory as a module and reports one spurious failure. Node is v22.18.0.
- No new dependencies. No build step.
- Sync is a no-op when the device is not linked (spec § 4.4): unlinked stays fully local and fully offline.

## File Structure

```
js/crypto.js          — NEW: AES-GCM encrypt/decrypt; link-code encode/decode/generate
js/merge.js           — NEW: pure merge() and dedupeState(); no I/O, no crypto, no DOM
js/auth.js            — NEW: link-code lifecycle over storage.js
js/sync.js            — NEW: pull/merge/apply/push orchestration, effects injected
js/linkui.js          — NEW: linking DOM — paste, adopt choice, status, compose-for-new-device
js/storage.js         — MODIFY: add plaenicke.auth and plaenicke.syncState
js/feeds.js           — MODIFY: add applyRemoteFeeds()
js/app.js             — MODIFY: sync apply callback, storage listener, sync triggers
js/settings.js        — MODIFY: mount linkui
service-worker.js     — MODIFY: precache the 5 new modules, bump CACHE
tests/crypto.test.js  — NEW
tests/merge.test.js   — NEW
tests/auth.test.js    — NEW
tests/sync.test.js    — NEW
tests/storage.test.js — MODIFY
```

## Owner steps (manual, cannot be automated)

Deployment needs the owner's Cloudflare account and is **not** part of this plan:
`wrangler d1 create`, `d1 migrations apply --remote`, `secret put ADMIN_SECRET`, `deploy`.
Until those run, `/data` does not exist and sync cannot be exercised against a real server.
Every test in this plan runs against an injected `fetchImpl`.

---

### Task 1: `crypto.js` — AES-GCM and link-code encoding

The link code is `base64url( authToken(32 bytes) || encKey(32 bytes) )` — 64 bytes, 86 base64url characters (spec § 4.1). The Worker mints the token as `base64url(32 random bytes)` with padding stripped and `+/` mapped to `-_`, and stores only `sha256(that exact 43-character string)`. **The client must send back a byte-identical string** or authentication fails, so the encoder must match the Worker's exactly.

**Files:**
- Create: `js/crypto.js`
- Test: `tests/crypto.test.js`

**Interfaces:**
- Produces, all exported from `js/crypto.js`:
  - `bytesToBase64url(bytes: Uint8Array): string`
  - `base64urlToBytes(s: string): Uint8Array` — throws on invalid input
  - `generateEncKey(): Uint8Array` — 32 bytes from `crypto.getRandomValues`
  - `composeLinkCode(authToken: string, encKey: Uint8Array): string`
  - `parseLinkCode(code: string): { authToken: string, encKey: Uint8Array }` — throws on wrong length or invalid characters
  - `encryptBlob(encKey: Uint8Array, obj: any): Promise<string>` — base64 of `iv || ciphertext`
  - `decryptBlob(encKey: Uint8Array, blob: string): Promise<any>` — throws on tamper, wrong key, or malformed input
  - `IV_BYTES = 12`, `KEY_BYTES = 32`, `TOKEN_BYTES = 32`

- [ ] **Step 1: Write the failing tests**

`tests/crypto.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64url, base64urlToBytes, generateEncKey,
  composeLinkCode, parseLinkCode, encryptBlob, decryptBlob,
  IV_BYTES, KEY_BYTES,
} from '../js/crypto.js';

// The Worker mints tokens with exactly this encoding (worker/src/auth.js).
// If our encoder disagrees by one character the Bearer token never matches
// the stored hash and every request 401s.
function workerStyleToken(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('bytesToBase64url matches the Worker encoding for all 256 byte values', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  assert.equal(bytesToBase64url(all), workerStyleToken(all));
});

test('base64url round-trips every byte value without loss', () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  assert.deepEqual([...base64urlToBytes(bytesToBase64url(all))], [...all]);
});

test('base64urlToBytes rejects non-base64url input', () => {
  assert.throws(() => base64urlToBytes('has spaces'));
  assert.throws(() => base64urlToBytes('plus+slash/'));
});

test('generateEncKey returns 32 fresh bytes', () => {
  const a = generateEncKey();
  const b = generateEncKey();
  assert.equal(a.length, KEY_BYTES);
  assert.notDeepEqual([...a], [...b]);
});

test('a composed link code parses back to the EXACT token string the Worker hashed', () => {
  const raw = new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256);
  const token = workerStyleToken(raw);          // what POST /admin/device returned
  const encKey = generateEncKey();
  const code = composeLinkCode(token, encKey);
  assert.equal(code.length, 86);
  const parsed = parseLinkCode(code);
  assert.equal(parsed.authToken, token);        // byte-identical, not merely equivalent
  assert.deepEqual([...parsed.encKey], [...encKey]);
});

test('parseLinkCode rejects a bare token, a truncated code, and junk', () => {
  const token = workerStyleToken(generateEncKey());
  assert.throws(() => parseLinkCode(token));        // 43 chars — bootstrap, not a link code
  assert.throws(() => parseLinkCode(token + 'AA'));
  assert.throws(() => parseLinkCode('!!!'));
  assert.throws(() => parseLinkCode(''));
});

test('encrypt then decrypt round-trips an object', async () => {
  const key = generateEncKey();
  const obj = { schemaVersion: 1, items: [{ id: 'a', title: 'x' }], feeds: [], tombstones: [] };
  assert.deepEqual(await decryptBlob(key, await encryptBlob(key, obj)), obj);
});

test('every encryption uses a fresh IV — identical plaintext never produces identical ciphertext', async () => {
  const key = generateEncKey();
  const obj = { schemaVersion: 1, items: [], feeds: [], tombstones: [] };
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    const blob = await encryptBlob(key, obj);
    const iv = atob(blob).slice(0, IV_BYTES);
    assert.ok(!seen.has(iv), 'IV reused — AES-GCM confidentiality is void');
    seen.add(iv);
  }
});

test('decrypting with the wrong key throws rather than returning garbage', async () => {
  const blob = await encryptBlob(generateEncKey(), { schemaVersion: 1 });
  await assert.rejects(() => decryptBlob(generateEncKey(), blob));
});

test('a tampered ciphertext is rejected by the auth tag', async () => {
  const key = generateEncKey();
  const blob = await encryptBlob(key, { schemaVersion: 1, items: [] });
  const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  await assert.rejects(() => decryptBlob(key, btoa(bin)));
});

test('decryptBlob rejects malformed input without throwing something unhelpful', async () => {
  const key = generateEncKey();
  await assert.rejects(() => decryptBlob(key, 'not base64 at all !!!'));
  await assert.rejects(() => decryptBlob(key, btoa('short')));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `../js/crypto.js` cannot be resolved.

- [ ] **Step 3: Implement**

`js/crypto.js`:

```js
// crypto.js — AES-GCM for the sync blob, and the link-code encoding.
//
// The link code carries two independent secrets concatenated:
//   base64url( authToken(32 bytes) || encKey(32 bytes) )
// authToken proves the device may talk to the Worker and is stored server-side
// hashed. encKey decrypts the blob and NEVER leaves this device — a full
// database compromise yields ciphertext. See spec 4.1.
//
// The base64url encoding here must match worker/src/auth.js byte for byte: the
// Worker stored sha256 of the exact token string it minted, so a token that
// re-encodes even one character differently authenticates as nobody.

export const KEY_BYTES = 32;
export const TOKEN_BYTES = 32;
export const IV_BYTES = 12;

const LINK_CODE_BYTES = TOKEN_BYTES + KEY_BYTES;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function bytesToBase64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(s) {
  if (typeof s !== 'string' || !s || !BASE64URL.test(s)) {
    throw new Error('Not a base64url string');
  }
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateEncKey() {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export function composeLinkCode(authToken, encKey) {
  const tokenBytes = base64urlToBytes(authToken);
  if (tokenBytes.length !== TOKEN_BYTES) throw new Error('Token must be 32 bytes');
  if (!(encKey instanceof Uint8Array) || encKey.length !== KEY_BYTES) {
    throw new Error('Key must be 32 bytes');
  }
  const joined = new Uint8Array(LINK_CODE_BYTES);
  joined.set(tokenBytes, 0);
  joined.set(encKey, TOKEN_BYTES);
  return bytesToBase64url(joined);
}

export function parseLinkCode(code) {
  const bytes = base64urlToBytes((code || '').trim());
  if (bytes.length !== LINK_CODE_BYTES) {
    throw new Error('A link code is 86 characters');
  }
  return {
    authToken: bytesToBase64url(bytes.slice(0, TOKEN_BYTES)),
    encKey: bytes.slice(TOKEN_BYTES),
  };
}

async function importKey(encKey) {
  return crypto.subtle.importKey('raw', encKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBlob(encKey, obj) {
  // A fresh random IV per encryption. Deriving it from anything stable — the
  // version, a counter, the key — would repeat an IV under the same key, which
  // for AES-GCM leaks the XOR of the plaintexts and destroys the auth tag's
  // integrity guarantee. This is not a tunable choice.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(encKey);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function decryptBlob(encKey, blob) {
  let bytes;
  try {
    const bin = atob(blob);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new Error('Blob is not valid base64');
  }
  if (bytes.length <= IV_BYTES) throw new Error('Blob is too short to contain an IV');
  const key = await importKey(encKey);
  // Any failure here — wrong key, tampered bytes, truncation — surfaces as a
  // rejection. The caller must NOT fall back to applying partial state.
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS (11 new tests).

- [ ] **Step 5: Mutation-check the IV requirement**

Temporarily replace the IV line with a constant (`new Uint8Array(IV_BYTES)`), run `npm test`, and confirm the fresh-IV test FAILS. Revert and confirm green. Record both outputs in your report. Do not commit the mutation.

- [ ] **Step 6: Commit**

```bash
git add js/crypto.js tests/crypto.test.js
git commit -m "feat(sync): AES-GCM blob encryption and link-code encoding"
```

---

### Task 2: `merge.js` — the pure merge

**Files:**
- Create: `js/merge.js`
- Test: `tests/merge.test.js`

**Interfaces:**
- Consumes: nothing. This module imports nothing and touches no I/O — that is what makes the convergence property test in Task 9 possible without stubs.
- Produces, exported from `js/merge.js`:
  - `SCHEMA_VERSION = 1`
  - `merge(local, remote, now: Date): state` where `state` is `{schemaVersion, items, feeds, tombstones}`. Throws if either side has an unrecognised `schemaVersion`.
  - `dedupeState(state): state` — collapses feeds sharing a normalised URL and items sharing `(title, date, time)`. Used only at adoption (§ 5.7).
  - `emptyState(): state`

- [ ] **Step 1: Write the failing tests**

`tests/merge.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, dedupeState, emptyState, SCHEMA_VERSION } from '../js/merge.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const item = (id, updatedAt, extra = {}) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt, ...extra });
const feed = (id, updatedAt, extra = {}) => ({ id, url: `https://cal.example/${id}.ics`, name: `n-${id}`, color: '#111', hidden: false, updatedAt, ...extra });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });

test('a record present on only one side survives', () => {
  const out = merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }), state(), NOW);
  assert.deepEqual(out.items.map(i => i.id), ['a']);
});

test('the higher updatedAt wins, in both directions', () => {
  const older = '2026-08-01T00:00:00.000Z', newer = '2026-08-02T00:00:00.000Z';
  const localWins = merge(state({ items: [item('a', newer, { title: 'LOCAL' })] }),
                          state({ items: [item('a', older, { title: 'REMOTE' })] }), NOW);
  assert.equal(localWins.items[0].title, 'LOCAL');
  const remoteWins = merge(state({ items: [item('a', older, { title: 'LOCAL' })] }),
                           state({ items: [item('a', newer, { title: 'REMOTE' })] }), NOW);
  assert.equal(remoteWins.items[0].title, 'REMOTE');
});

test('a tie goes to remote, which is what makes a re-push idempotent', () => {
  const same = '2026-08-01T00:00:00.000Z';
  const out = merge(state({ items: [item('a', same, { title: 'LOCAL' })] }),
                    state({ items: [item('a', same, { title: 'REMOTE' })] }), NOW);
  assert.equal(out.items[0].title, 'REMOTE');
});

test('a tombstone newer than the record removes it', () => {
  const out = merge(
    state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }),
    NOW);
  assert.deepEqual(out.items, []);
  assert.equal(out.tombstones.length, 1);
});

test('a record re-created after its deletion is NOT removed', () => {
  const out = merge(
    state({ items: [item('a', '2026-08-03T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }),
    NOW);
  assert.deepEqual(out.items.map(i => i.id), ['a']);
});

test('a tombstone suppresses a record BEFORE age-pruning can drop the tombstone', () => {
  // Both are ancient. If pruning ran first the tombstone would vanish and the
  // item would resurrect inside a single merge.
  const out = merge(
    state({ items: [item('a', '2020-01-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2020-06-01T00:00:00.000Z' }] }),
    NOW);
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.tombstones, []);
});

test('tombstones older than 90 days are pruned; newer ones are kept', () => {
  const out = merge(state(), state({ tombstones: [
    { id: 'old', kind: 'item', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', kind: 'item', deletedAt: '2026-07-30T00:00:00.000Z' },
  ] }), NOW);
  assert.deepEqual(out.tombstones.map(t => t.id), ['new']);
});

test('the newer of two tombstones for the same record wins', () => {
  const out = merge(
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-07-01T00:00:00.000Z' }] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-07-20T00:00:00.000Z' }] }),
    NOW);
  assert.equal(out.tombstones.length, 1);
  assert.equal(out.tombstones[0].deletedAt, '2026-07-20T00:00:00.000Z');
});

test('an item tombstone does not delete a feed with the same id', () => {
  const out = merge(
    state({ feeds: [feed('a', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }),
    NOW);
  assert.deepEqual(out.feeds.map(f => f.id), ['a']);
});

test('local color and hidden survive a pull that changes the feed name', () => {
  const out = merge(
    state({ feeds: [feed('a', '2026-08-01T00:00:00.000Z', { color: '#abc', hidden: true, name: 'old' })] }),
    state({ feeds: [feed('a', '2026-08-02T00:00:00.000Z', { color: '#zzz', hidden: false, name: 'new' })] }),
    NOW);
  assert.equal(out.feeds[0].name, 'new');
  assert.equal(out.feeds[0].color, '#abc');
  assert.equal(out.feeds[0].hidden, true);
});

test('a feed seen for the first time arrives with color null for feeds.js to assign', () => {
  const out = merge(state(), state({ feeds: [feed('a', '2026-08-02T00:00:00.000Z', { color: '#zzz', hidden: true })] }), NOW);
  assert.equal(out.feeds[0].color, null);
  assert.equal(out.feeds[0].hidden, false);
});

test('an unknown schemaVersion is rejected rather than migrated', () => {
  assert.throws(() => merge(state(), { ...state(), schemaVersion: 99 }, NOW));
  assert.throws(() => merge({ ...state(), schemaVersion: 0 }, state(), NOW));
});

test('merge is idempotent — merging a result with its own remote changes nothing', () => {
  const local = state({ items: [item('a', '2026-08-01T00:00:00.000Z')] });
  const remote = state({ items: [item('b', '2026-08-02T00:00:00.000Z')] });
  const once = merge(local, remote, NOW);
  assert.deepEqual(merge(once, remote, NOW), once);
});

test('dedupeState collapses feeds sharing a normalised URL, keeping the newer', () => {
  const out = dedupeState(state({ feeds: [
    { ...feed('a', '2026-08-01T00:00:00.000Z'), url: 'https://cal.example/x.ics' },
    { ...feed('b', '2026-08-02T00:00:00.000Z'), url: 'HTTPS://Cal.Example/x.ics/' },
  ] }));
  assert.equal(out.feeds.length, 1);
  assert.equal(out.feeds[0].id, 'b');
});

test('dedupeState collapses items sharing title, date and time', () => {
  const out = dedupeState(state({ items: [
    { ...item('a', '2026-08-01T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('b', '2026-08-02T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('c', '2026-08-02T00:00:00.000Z'), title: 'Dentist', date: '2026-08-06', time: '09:00' },
  ] }));
  assert.deepEqual(out.items.map(i => i.id).sort(), ['b', 'c']);
});

test('emptyState is a valid mergeable state', () => {
  assert.deepEqual(merge(emptyState(), emptyState(), NOW), emptyState());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `../js/merge.js` cannot be resolved.

- [ ] **Step 3: Implement**

`js/merge.js`:

```js
// merge.js — the pure conflict-resolution function. No I/O, no crypto, no DOM,
// no imports. Everything it needs arrives as arguments, which is what lets the
// convergence property test drive it directly.
//
// Last-write-wins per record. Because merging is per record, edits to DIFFERENT
// records on two devices never conflict — that is the common case and it is
// safe. Editing the SAME record on both devices while offline loses the older
// edit; see spec 5.4 for why that trade is accepted.

export const SCHEMA_VERSION = 1;

const TOMBSTONE_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [] };
}

function ts(s) {
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

function requireKnownVersion(state, side) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unrecognised schemaVersion on the ${side} state`);
  }
}

// Union by id. Ties go to remote so that re-pushing an identical record is a
// no-op — which is what makes the CAS retry loop safe to run repeatedly.
function unionById(localList, remoteList, pick) {
  const out = new Map();
  for (const rec of localList || []) if (rec && typeof rec.id === 'string') out.set(rec.id, rec);
  for (const rec of remoteList || []) {
    if (!rec || typeof rec.id !== 'string') continue;
    const mine = out.get(rec.id);
    if (!mine || ts(rec.updatedAt) >= ts(mine.updatedAt)) {
      out.set(rec.id, pick ? pick(rec, mine) : rec);
    }
  }
  return [...out.values()];
}

// color and hidden are per-device view preferences and never sync (spec 6.3).
// Keep the local values when we already know the feed; hand a first-seen feed
// to feeds.js with color null so it can assign from its own colour cycle.
function pickFeed(remoteFeed, localFeed) {
  return localFeed
    ? { ...remoteFeed, color: localFeed.color, hidden: localFeed.hidden }
    : { ...remoteFeed, color: null, hidden: false };
}

function mergeTombstones(localList, remoteList) {
  const out = new Map();
  for (const t of [...(localList || []), ...(remoteList || [])]) {
    if (!t || typeof t.id !== 'string' || (t.kind !== 'item' && t.kind !== 'feed')) continue;
    const key = `${t.kind}:${t.id}`;
    const prior = out.get(key);
    if (!prior || ts(t.deletedAt) > ts(prior.deletedAt)) out.set(key, t);
  }
  return [...out.values()];
}

function applyTombstones(records, tombstones, kind) {
  const dead = new Map();
  for (const t of tombstones) if (t.kind === kind) dead.set(t.id, ts(t.deletedAt));
  // A record whose updatedAt is at or after the deletion was re-created after
  // it and must survive.
  return records.filter(r => !(dead.has(r.id) && dead.get(r.id) > ts(r.updatedAt)));
}

function prune(tombstones, now) {
  const cutoff = now.getTime() - TOMBSTONE_MAX_AGE_DAYS * DAY_MS;
  return tombstones.filter(t => {
    const parsed = Date.parse(t.deletedAt);
    // An unparseable deletedAt must never cause a drop: losing the tombstone
    // resurrects the record on the next sync.
    if (Number.isNaN(parsed)) return true;
    return parsed >= cutoff;
  });
}

export function merge(local, remote, now) {
  requireKnownVersion(local, 'local');
  requireKnownVersion(remote, 'remote');

  const tombstones = mergeTombstones(local.tombstones, remote.tombstones);

  // Suppress BEFORE pruning. Pruning first would drop an old tombstone and let
  // its record resurrect within this same merge.
  const items = applyTombstones(unionById(local.items, remote.items), tombstones, 'item');
  const feeds = applyTombstones(unionById(local.feeds, remote.feeds, pickFeed), tombstones, 'feed');

  return { schemaVersion: SCHEMA_VERSION, items, feeds, tombstones: prune(tombstones, now) };
}

// --- adoption only (spec 5.7) ---
// Feed ids are per device, so linking a laptop and a phone that subscribe to
// the same four calendars otherwise yields eight feeds — every event drawn
// twice, in two colours, in every view.

function normalizeUrl(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

function collapse(records, keyOf) {
  const out = new Map();
  for (const rec of records) {
    const key = keyOf(rec);
    const prior = out.get(key);
    if (!prior || ts(rec.updatedAt) > ts(prior.updatedAt)) out.set(key, rec);
  }
  return [...out.values()];
}

export function dedupeState(state) {
  return {
    ...state,
    feeds: collapse(state.feeds, f => normalizeUrl(f.url)),
    items: collapse(state.items, i => `${i.title} ${i.date} ${i.time || ''}`),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS (17 new tests).

- [ ] **Step 5: Mutation-check the merge core**

Run each of these, one at a time, confirming at least one test FAILS, then revert:
- **M1:** swap `>=` for `>` in `unionById`'s comparison (ties would go local, breaking retry idempotence).
- **M2:** move `prune()` to run before `applyTombstones` (records resurrect).
- **M3:** delete the `color`/`hidden` preservation in `pickFeed` (per-device prefs start syncing).
- **M4:** change `applyTombstones`'s `>` to `>=` (a record re-created in the same millisecond as its deletion vanishes).

Record every mutant and its result in your report. If any mutant survives, add a test that catches it and prove the new test fails under that mutant.

- [ ] **Step 6: Commit**

```bash
git add js/merge.js tests/merge.test.js
git commit -m "feat(sync): pure merge with last-write-wins, tombstones and adoption dedupe"
```

---

### Task 3: `storage.js` — `plaenicke.auth` and `plaenicke.syncState`

**Files:**
- Modify: `js/storage.js` (append; do not alter existing exports)
- Test: `tests/storage.test.js` (append)

**Interfaces:**
- Produces, exported from `js/storage.js`:
  - `loadAuth(): string | null` — the raw link code, or `null`
  - `saveAuth(code: string): void`
  - `clearAuth(): void`
  - `loadSyncState(): { version: number, tokenHash: string | null, lastSyncedAt: string | null, lastError: string | null }`
  - `saveSyncState(s): void`
  - `AUTH_KEY = 'plaenicke.auth'`, `SYNC_STATE_KEY = 'plaenicke.syncState'`

- [ ] **Step 1: Write the failing tests**

Append to `tests/storage.test.js` (the file already stubs `localStorage`; follow the existing pattern at the top of that file):

```js
import {
  loadAuth, saveAuth, clearAuth, loadSyncState, saveSyncState,
} from '../js/storage.js';

test('auth round-trips and clears', () => {
  localStorage.clear();
  assert.equal(loadAuth(), null);
  saveAuth('abc');
  assert.equal(loadAuth(), 'abc');
  clearAuth();
  assert.equal(loadAuth(), null);
});

test('loadSyncState returns a zeroed state when nothing is stored', () => {
  localStorage.clear();
  assert.deepEqual(loadSyncState(), { version: 0, tokenHash: null, lastSyncedAt: null, lastError: null });
});

test('syncState round-trips', () => {
  localStorage.clear();
  saveSyncState({ version: 7, tokenHash: 'h', lastSyncedAt: '2026-08-02T00:00:00.000Z', lastError: null });
  assert.deepEqual(loadSyncState(), { version: 7, tokenHash: 'h', lastSyncedAt: '2026-08-02T00:00:00.000Z', lastError: null });
});

test('a corrupt or non-numeric syncState falls back to zero rather than throwing', () => {
  localStorage.clear();
  localStorage.setItem('plaenicke.syncState', '{{{');
  assert.equal(loadSyncState().version, 0);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 'seven' }));
  assert.equal(loadSyncState().version, 0);
});

test('saveSyncState converts a quota failure to QuotaError', () => {
  localStorage.clear();
  const real = localStorage.setItem;
  localStorage.setItem = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
  try {
    assert.throws(() => saveSyncState({ version: 1, tokenHash: null, lastSyncedAt: null, lastError: null }),
      (e) => e.name === 'QuotaError');
  } finally {
    localStorage.setItem = real;
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `loadAuth` is not exported.

- [ ] **Step 3: Implement**

Append to `js/storage.js`:

```js
// --- sync credentials and cursor ---
// The link code holds the encryption key, so it is a secret: never log it and
// never render it outside the linking UI.

export const AUTH_KEY = 'plaenicke.auth';
export const SYNC_STATE_KEY = 'plaenicke.syncState';

export function loadAuth() {
  const v = localStorage.getItem(AUTH_KEY);
  return typeof v === 'string' && v ? v : null;
}

export function saveAuth(code) {
  localStorage.setItem(AUTH_KEY, code);
}

export function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
}

const ZERO_SYNC_STATE = { version: 0, tokenHash: null, lastSyncedAt: null, lastError: null };

export function loadSyncState() {
  const json = localStorage.getItem(SYNC_STATE_KEY);
  if (!json) return { ...ZERO_SYNC_STATE };
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ...ZERO_SYNC_STATE };
  }
  if (!parsed || typeof parsed !== 'object') return { ...ZERO_SYNC_STATE };
  // A non-integer version must reset to 0 rather than be sent to the Worker:
  // a garbage version would 409 forever with no way out.
  return {
    version: Number.isInteger(parsed.version) && parsed.version >= 0 ? parsed.version : 0,
    tokenHash: typeof parsed.tokenHash === 'string' ? parsed.tokenHash : null,
    lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null,
    lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
  };
}

export function saveSyncState(s) {
  try {
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(s));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      throw new QuotaError('Sync state exceeded storage quota');
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS (5 new tests).

- [ ] **Step 5: Commit**

```bash
git add js/storage.js tests/storage.test.js
git commit -m "feat(sync): persist the link code and the sync cursor"
```

---

### Task 4: `auth.js` — link-code lifecycle

**Files:**
- Create: `js/auth.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: `parseLinkCode`, `composeLinkCode`, `generateEncKey`, `bytesToBase64url`, `base64urlToBytes`, `TOKEN_BYTES` from `js/crypto.js`; `loadAuth`, `saveAuth`, `clearAuth`, `loadSyncState`, `saveSyncState` from `js/storage.js`.
- Produces, exported from `js/auth.js`:
  - `isLinked(): boolean`
  - `getLink(): { authToken, encKey, code } | null`
  - `tokenHash(authToken: string): Promise<string>` — SHA-256 hex, matching the Worker
  - `linkWithCode(code: string): Promise<{authToken, encKey, code}>` — accepts an 86-char link code, or a 43-char bare token which bootstraps a **new** `encKey`
  - `unlink(): void` — clears the link code and resets `syncState`. **Never touches items, feeds or tombstones.**
  - `resetSyncStateIfDeviceChanged(authToken): Promise<void>` — hard-resets the cursor when the token differs from the stored hash

- [ ] **Step 1: Write the failing tests**

`tests/auth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateEncKey, bytesToBase64url, composeLinkCode } from '../js/crypto.js';
import { loadSyncState, saveSyncState, loadItems, saveItems } from '../js/storage.js';
import { isLinked, getLink, linkWithCode, unlink, tokenHash, resetSyncStateIfDeviceChanged } from '../js/auth.js';

const bareToken = () => bytesToBase64url(generateEncKey());

test('an unlinked device reports unlinked and has no link', () => {
  localStorage.clear();
  assert.equal(isLinked(), false);
  assert.equal(getLink(), null);
});

test('a bare token bootstraps a fresh encKey and stores a full link code', async () => {
  localStorage.clear();
  const token = bareToken();
  const link = await linkWithCode(token);
  assert.equal(link.authToken, token);
  assert.equal(link.encKey.length, 32);
  assert.equal(link.code.length, 86);
  assert.equal(isLinked(), true);
  assert.equal(getLink().authToken, token);
});

test('two bootstraps generate DIFFERENT keys — a bare token never joins an existing account', async () => {
  localStorage.clear();
  const a = await linkWithCode(bareToken());
  localStorage.clear();
  const b = await linkWithCode(bareToken());
  assert.notDeepEqual([...a.encKey], [...b.encKey]);
});

test('a full link code joins with the SAME key it carries', async () => {
  localStorage.clear();
  const token = bareToken();
  const key = generateEncKey();
  const link = await linkWithCode(composeLinkCode(token, key));
  assert.deepEqual([...link.encKey], [...key]);
});

test('linkWithCode rejects junk without linking', async () => {
  localStorage.clear();
  await assert.rejects(() => linkWithCode('nonsense!'));
  assert.equal(isLinked(), false);
});

test('tokenHash matches the Worker SHA-256 hex shape and is stable', async () => {
  const h = await tokenHash('abc');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await tokenHash('abc'));
  assert.notEqual(h, await tokenHash('abd'));
});

test('linking hard-resets the sync cursor so a re-link never reuses a stale version', async () => {
  localStorage.clear();
  saveSyncState({ version: 42, tokenHash: 'stale', lastSyncedAt: null, lastError: null });
  await linkWithCode(bareToken());
  assert.equal(loadSyncState().version, 0);
});

test('resetSyncStateIfDeviceChanged zeroes the version on a different token, and leaves it alone on the same one', async () => {
  localStorage.clear();
  const token = bareToken();
  await resetSyncStateIfDeviceChanged(token);
  saveSyncState({ ...loadSyncState(), version: 9 });
  await resetSyncStateIfDeviceChanged(token);
  assert.equal(loadSyncState().version, 9, 'same device must not reset');
  await resetSyncStateIfDeviceChanged(bareToken());
  assert.equal(loadSyncState().version, 0, 'different device must reset');
});

test('unlink clears credentials and cursor but NEVER touches local data', async () => {
  localStorage.clear();
  saveItems([{ id: 'a', title: 'keep me', date: '2026-08-02', updatedAt: '2026-08-02T00:00:00.000Z' }]);
  await linkWithCode(bareToken());
  unlink();
  assert.equal(isLinked(), false);
  assert.equal(loadSyncState().version, 0);
  assert.equal(loadItems().length, 1, 'unlinking must never delete local data');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `../js/auth.js` cannot be resolved.

- [ ] **Step 3: Implement**

`js/auth.js`:

```js
// auth.js — the link-code lifecycle.
//
// A link code is base64url(authToken || encKey). Pasting an 86-character code
// JOINS the account that key belongs to. Pasting a bare 43-character token
// BOOTSTRAPS a new key — correct for the first device, wrong for the second,
// which is why linkui.js warns before doing it.
//
// Unlinking never deletes local data. Signed-out plaenicke is a complete,
// working, offline app (spec 4.4).

import { parseLinkCode, composeLinkCode, generateEncKey, base64urlToBytes, TOKEN_BYTES } from './crypto.js';
import { loadAuth, saveAuth, clearAuth, loadSyncState, saveSyncState } from './storage.js';

const ZERO = { version: 0, tokenHash: null, lastSyncedAt: null, lastError: null };

export async function tokenHash(authToken) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authToken));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function getLink() {
  const code = loadAuth();
  if (!code) return null;
  try {
    const { authToken, encKey } = parseLinkCode(code);
    return { authToken, encKey, code };
  } catch {
    // A corrupt stored code is treated as unlinked rather than throwing on
    // every sync tick. linkui.js surfaces the unlinked state.
    return null;
  }
}

export function isLinked() {
  return getLink() !== null;
}

export async function linkWithCode(input) {
  const trimmed = (input || '').trim();
  let code;
  const bytes = base64urlToBytes(trimmed); // throws on junk, before anything is stored
  if (bytes.length === TOKEN_BYTES) {
    code = composeLinkCode(trimmed, generateEncKey());
  } else {
    parseLinkCode(trimmed); // validate before storing
    code = trimmed;
  }
  const { authToken, encKey } = parseLinkCode(code);
  saveAuth(code);
  // Hard reset: a re-link must never reuse a version from a previous device,
  // which would push at a cursor the server never issued (spec 5.7).
  saveSyncState({ ...ZERO, tokenHash: await tokenHash(authToken) });
  return { authToken, encKey, code };
}

export function unlink() {
  clearAuth();
  saveSyncState({ ...ZERO });
}

export async function resetSyncStateIfDeviceChanged(authToken) {
  const hash = await tokenHash(authToken);
  const state = loadSyncState();
  if (state.tokenHash !== hash) saveSyncState({ ...ZERO, tokenHash: hash });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS (9 new tests).

- [ ] **Step 5: Commit**

```bash
git add js/auth.js tests/auth.test.js
git commit -m "feat(sync): link-code lifecycle with hard cursor reset on device change"
```

---

### Task 5: `sync.js` — pull, merge, apply, push

**Files:**
- Create: `js/sync.js`
- Test: `tests/sync.test.js`

**Interfaces:**
- Consumes: `merge`, `dedupeState`, `emptyState`, `SCHEMA_VERSION` (Task 2); `encryptBlob`, `decryptBlob` (Task 1); `getLink`, `resetSyncStateIfDeviceChanged` (Task 4); `loadSyncState`, `saveSyncState`, `loadItems`, `loadFeeds`, `loadTombstones` from `js/storage.js`.
- Produces, exported from `js/sync.js`:
  - `MAX_ATTEMPTS = 3`
  - `syncOnce(deps): Promise<{status, ...}>` where `status` is one of `'skipped'`, `'ok'`, `'conflict'`, `'unauthorized'`, `'undecryptable'`, `'offline'`, `'error'`.
    `deps` = `{ fetchImpl, now, apiBase, applyState, adoptChoice }`.
  - `pullRemote(deps): Promise<{version, state} | {version, state: null}>`
- **`sync.js` must not import `saveItems`, `saveFeeds` or `saveFeedCache`.** Task 8's test asserts this by reading the source.

- [ ] **Step 1: Write the failing tests**

`tests/sync.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncOnce, MAX_ATTEMPTS } from '../js/sync.js';
import { linkWithCode } from '../js/auth.js';
import { encryptBlob, decryptBlob, generateEncKey, bytesToBase64url } from '../js/crypto.js';
import { SCHEMA_VERSION } from '../js/merge.js';
import { saveItems, loadSyncState, saveSyncState } from '../js/storage.js';

const NOW = () => new Date('2026-08-02T12:00:00.000Z');
const item = (id, updatedAt) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });

// A fake Worker holding one row, enforcing the real compare-and-swap rule.
function fakeServer({ version = 0, blob = '' } = {}) {
  const row = { version, blob };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, auth: (opts.headers || {}).authorization });
    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ version: row.version, blob: row.blob }) };
    }
    const body = JSON.parse(opts.body);
    if (body.version !== row.version) {
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', version: row.version, blob: row.blob }) };
    }
    row.version += 1;
    row.blob = body.blob;
    return { ok: true, status: 200, json: async () => ({ version: row.version }) };
  };
  return { fetchImpl, row, calls };
}

async function linked() {
  localStorage.clear();
  const key = generateEncKey();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  return link;
}

test('an unlinked device does not sync and does not call the network', async () => {
  localStorage.clear();
  let called = false;
  const res = await syncOnce({ fetchImpl: async () => { called = true; }, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  assert.equal(res.status, 'skipped');
  assert.equal(called, false);
});

test('an empty server accepts the local state as the first push', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  assert.equal(res.status, 'ok');
  assert.equal(server.row.version, 1);
  const pushed = await decryptBlob(link.encKey, server.row.blob);
  assert.deepEqual(pushed.items.map(i => i.id), ['a']);
});

test('the Bearer token is sent and the encryption key is NEVER on the wire', async () => {
  const link = await linked();
  const server = fakeServer();
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  assert.ok(server.calls.every(c => c.auth === `Bearer ${link.authToken}`));
  const wire = JSON.stringify(server.calls);
  assert.ok(!wire.includes(bytesToBase64url(link.encKey)), 'encKey must never be transmitted');
});

test('remote records are merged and handed to applyState, not written directly', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 3, blob: await encryptBlob(link.encKey, state({ items: [item('remote', '2026-08-01T00:00:00.000Z')] })) });
  let applied = null;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: (s) => { applied = s; } });
  assert.equal(res.status, 'ok');
  assert.deepEqual(applied.items.map(i => i.id).sort(), ['local', 'remote']);
});

test('applyState runs BEFORE the version is advanced', async () => {
  const link = await linked();
  const server = fakeServer({ version: 5, blob: await encryptBlob(link.encKey, state()) });
  let versionAtApply = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: () => { versionAtApply = loadSyncState().version; } });
  assert.equal(versionAtApply, 0, 'the cursor must still be stale while applying');
  assert.ok(loadSyncState().version >= 5);
});

test('a failure inside applyState does not advance the version', async () => {
  const link = await linked();
  const server = fakeServer({ version: 5, blob: await encryptBlob(link.encKey, state({ items: [item('r', '2026-08-01T00:00:00.000Z')] })) });
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: () => { throw new Error('quota'); } });
  assert.equal(res.status, 'error');
  assert.equal(loadSyncState().version, 0, 'a failed apply must leave the cursor alone so the next sync re-pulls');
});

test('a 409 is re-merged and retried, and the retry succeeds', async () => {
  const link = await linked();
  saveItems([item('mine', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z')] })) });
  // Land a competing write between our GET and our PUT.
  let first = true;
  const raced = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT' && first) {
      first = false;
      server.row.version += 1;
      server.row.blob = await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z'), item('third', '2026-08-01T00:00:00.000Z')] }));
    }
    return server.fetchImpl(url, opts);
  };
  const res = await syncOnce({ fetchImpl: raced, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  assert.equal(res.status, 'ok');
  const final = await decryptBlob(link.encKey, server.row.blob);
  assert.deepEqual(final.items.map(i => i.id).sort(), ['mine', 'theirs', 'third'],
    'the losing write must be preserved, not dropped');
});

test('a server that 409s forever gives up after MAX_ATTEMPTS instead of spinning', async () => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  let puts = 0;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') {
      puts += 1;
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', version: 99, blob: '' }) };
    }
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) };
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  assert.equal(res.status, 'conflict');
  assert.equal(puts, MAX_ATTEMPTS);
});

test('an undecryptable blob halts and applies NOTHING', async () => {
  const link = await linked();
  const other = generateEncKey();
  const server = fakeServer({ version: 2, blob: await encryptBlob(other, state({ items: [item('x', '2026-08-01T00:00:00.000Z')] })) });
  let applied = false;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => { applied = true; } });
  assert.equal(res.status, 'undecryptable');
  assert.equal(applied, false, 'partially applying an unreadable blob would propagate phantom deletions');
  assert.equal(server.row.version, 2, 'nothing may be pushed over a blob we cannot read');
});

test('an unknown schemaVersion halts and applies nothing', async () => {
  const link = await linked();
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, { ...state(), schemaVersion: 99 }) });
  let applied = false;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => { applied = true; } });
  assert.equal(res.status, 'undecryptable');
  assert.equal(applied, false);
});

test('a 401 reports unauthorized and never clears local data', async () => {
  await linked();
  saveItems([item('keep', '2026-08-01T00:00:00.000Z')]);
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  assert.equal(res.status, 'unauthorized');
  assert.equal(JSON.parse(localStorage.getItem('plaenicke.items')).length, 1);
});

test('a network failure reports offline and records the error without throwing', async () => {
  await linked();
  const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  assert.equal(res.status, 'offline');
  assert.equal(typeof loadSyncState().lastError, 'string');
});

test('syncing when nothing changed does not push', async () => {
  const link = await linked();
  const server = fakeServer({ version: 4, blob: await encryptBlob(link.encKey, state()) });
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  assert.equal(server.row.version, 4, 'an unchanged state must not burn a version');
  assert.equal(loadSyncState().version, 4);
});

test('a successful sync records lastSyncedAt and clears lastError', async () => {
  const link = await linked();
  saveSyncState({ ...loadSyncState(), lastError: 'previous failure' });
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state()) });
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => {} });
  const s = loadSyncState();
  assert.equal(s.lastError, null);
  assert.equal(s.lastSyncedAt, NOW().toISOString());
});

test('adoptChoice "replace" discards local state instead of merging it', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({ items: [item('remote', '2026-08-01T00:00:00.000Z')] })) });
  let applied = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; }, adoptChoice: 'replace' });
  assert.deepEqual(applied.items.map(i => i.id), ['remote']);
});

test('adoptChoice "merge" dedupes items that match on title, date and time', async () => {
  const link = await linked();
  saveItems([{ id: 'l', title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: '2026-08-01T00:00:00.000Z' }]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({
    items: [{ id: 'r', title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: '2026-08-01T00:00:00.000Z' }],
  })) });
  let applied = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; }, adoptChoice: 'merge' });
  assert.equal(applied.items.length, 1, 'linking must not double every record');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `../js/sync.js` cannot be resolved.

- [ ] **Step 3: Implement**

`js/sync.js`:

```js
// sync.js — pull, merge, apply, push. All effects injected, matching feeds.js.
//
// THE OWNERSHIP RULE (spec 5.5): this module never writes items or feeds. It
// hands merged state to applyState(), and app.js/feeds.js — which own those
// keys — perform the write. app.js holds `let items` at module scope for the
// page's lifetime and writes the whole array back; a second writer here means
// the next addItems() silently reverts every pulled record, deterministically.
// That is why this file imports no save function.

import { merge, dedupeState, emptyState, SCHEMA_VERSION } from './merge.js';
import { encryptBlob, decryptBlob } from './crypto.js';
import { getLink, resetSyncStateIfDeviceChanged } from './auth.js';
import { loadItems, loadFeeds, loadTombstones, loadSyncState, saveSyncState } from './storage.js';

export const MAX_ATTEMPTS = 3;

function localState() {
  return { schemaVersion: SCHEMA_VERSION, items: loadItems(), feeds: loadFeeds(), tombstones: loadTombstones() };
}

function record(patch) {
  saveSyncState({ ...loadSyncState(), ...patch });
}

export async function pullRemote({ fetchImpl, apiBase, link }) {
  const res = await fetchImpl(`${apiBase}/data`, {
    headers: { authorization: `Bearer ${link.authToken}` },
  });
  if (res.status === 401) return { unauthorized: true };
  if (!res.ok) return { failed: res.status };
  const { version, blob } = await res.json();
  if (!blob) return { version, state: null };          // empty server — first push
  const state = await decryptBlob(link.encKey, blob);  // throws → caller halts
  if (!state || state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('Unrecognised schemaVersion');
  }
  return { version, state };
}

export async function syncOnce(deps) {
  const { fetchImpl, now, apiBase, applyState, adoptChoice = 'merge' } = deps;
  const link = getLink();
  if (!link) return { status: 'skipped' };

  await resetSyncStateIfDeviceChanged(link.authToken);

  let pulled;
  try {
    pulled = await pullRemote({ fetchImpl, apiBase, link });
  } catch (err) {
    // Undecryptable or unparseable. Apply NOTHING: a record silently dropped
    // by a deserializer looks like a local deletion and would propagate a
    // tombstone to every device (spec 6.6).
    record({ lastError: err.name || 'DecryptError' });
    return { status: 'undecryptable' };
  }
  if (pulled.unauthorized) {
    record({ lastError: 'unauthorized' });
    return { status: 'unauthorized' };
  }
  if (pulled.failed) {
    record({ lastError: `http_${pulled.failed}` });
    return { status: 'error' };
  }

  let version = pulled.version;
  let remote = pulled.state || emptyState();
  let merged;
  try {
    merged = adoptChoice === 'replace' && pulled.state
      ? remote
      : merge(localState(), remote, now());
    if (adoptChoice === 'merge' && pulled.state) merged = dedupeState(merged);

    // Apply BEFORE advancing the cursor. If this throws, the version stays
    // stale and the next sync re-pulls; reversing the order loses the pulled
    // data permanently (spec 7).
    applyState(merged);
  } catch (err) {
    record({ lastError: err.name || 'ApplyError' });
    return { status: 'error' };
  }

  const changed = JSON.stringify(merged) !== JSON.stringify(remote);
  if (!changed) {
    record({ version, lastSyncedAt: now().toISOString(), lastError: null });
    return { status: 'ok', pushed: false };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}/data`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${link.authToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version, blob: await encryptBlob(link.encKey, merged) }),
      });
    } catch {
      record({ lastError: 'offline' });
      return { status: 'offline' };
    }
    if (res.status === 401) {
      record({ lastError: 'unauthorized' });
      return { status: 'unauthorized' };
    }
    if (res.ok) {
      const body = await res.json();
      record({ version: body.version, lastSyncedAt: now().toISOString(), lastError: null });
      return { status: 'ok', pushed: true };
    }
    if (res.status !== 409) {
      record({ lastError: `http_${res.status}` });
      return { status: 'error' };
    }

    // Someone wrote first. Re-merge against the state they left and retry.
    const conflict = await res.json();
    version = conflict.version;
    try {
      remote = conflict.blob ? await decryptBlob(link.encKey, conflict.blob) : emptyState();
      merged = merge(merged, remote, now());
      applyState(merged);
    } catch (err) {
      record({ lastError: err.name || 'DecryptError' });
      return { status: 'undecryptable' };
    }
  }

  // Bounded, because the Worker's CAS check fails closed: an unexpected
  // meta.changes shape from D1 makes every PUT 409 forever.
  record({ lastError: 'version_conflict' });
  return { status: 'conflict' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS (16 new tests).

- [ ] **Step 5: Mutation-check the ordering and bounds**

Run each, confirm at least one test FAILS, then revert:
- **M1:** advance the cursor before calling `applyState` (apply-before-advance broken).
- **M2:** change the retry loop bound to `while (true)` (unbounded spin).
- **M3:** on `undecryptable`, call `applyState(emptyState())` instead of returning (phantom deletion of everything).
- **M4:** drop the `if (!changed)` guard so every sync pushes (burns a version per tick).

Record all four and their results. Add a test for any that survives.

- [ ] **Step 6: Commit**

```bash
git add js/sync.js tests/sync.test.js
git commit -m "feat(sync): pull/merge/apply/push with bounded compare-and-swap retry"
```

---

### Task 6: `feeds.js` — `applyRemoteFeeds()`

**Files:**
- Modify: `js/feeds.js`
- Test: `tests/feeds.test.js` (append)

**Interfaces:**
- Consumes: the merged `feeds` array from Task 5, where a first-seen feed has `color: null`.
- Produces: `applyRemoteFeeds(mergedFeeds: array): void` exported from `js/feeds.js`.

Read `js/feeds.js` before writing this. It owns feed-cache lifecycle and states that `removeFeed(id)` is the only sanctioned deletion path. `applyRemoteFeeds` must:
1. Delete local feeds absent from `mergedFeeds` **via `removeFeed()`**, so `feedCache[id]` is cleaned. A raw `saveFeeds()` orphans the cache entry forever — never read, still iterated and re-serialised by `pruneForQuota`, a permanent quota leak.
2. Assign this device's next colour to any feed arriving with `color: null`, and `hidden: false`.
3. Preserve the existing `color`/`hidden` for feeds already known.
4. Save once, then let the caller re-render.

- [ ] **Step 1: Write the failing tests**

Append to `tests/feeds.test.js`, following its existing setup:

```js
test('applyRemoteFeeds assigns a real colour to a first-seen feed', () => {
  // arrange one existing feed, then apply a merged list containing a new feed with color null
  // assert the new feed's color is a non-null string and hidden === false
});

test('applyRemoteFeeds preserves local colour and hidden for a feed it already knows', () => {
  // assert a name change from the merged list lands, while color/hidden keep their local values
});

test('applyRemoteFeeds removes a dropped feed through removeFeed, clearing its cache entry', () => {
  // seed feedCache[id], apply a merged list without that feed,
  // assert loadFeedCache() no longer contains the id — this is the quota-leak guard
});
```

Write these out fully against the real `feeds.js` API — the sketch above names the assertions, not the code. Read the file first and match its existing test setup and injected-effects pattern exactly.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test` — Expected: FAIL, `applyRemoteFeeds` is not exported.

- [ ] **Step 3: Implement `applyRemoteFeeds` in `js/feeds.js`**

Follow the module's existing structure and comment style. Route deletions through `removeFeed()`. Do not restructure anything else in the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Mutation-check the cache cleanup**

Replace the `removeFeed()` call with a direct `saveFeeds(kept)` and confirm the orphaned-cache test FAILS. Revert. Record the output.

- [ ] **Step 6: Commit**

```bash
git add js/feeds.js tests/feeds.test.js
git commit -m "feat(sync): applyRemoteFeeds honouring feed-cache ownership"
```

---

### Task 7: `app.js` — apply callback, storage listener, sync triggers

**Files:**
- Modify: `js/app.js`
- Test: `tests/sync.test.js` (append the ownership assertion)

**Interfaces:**
- Consumes: `syncOnce` (Task 5), `applyRemoteFeeds` (Task 6), `isLinked` (Task 4).
- Produces: `scheduleSync(reason)` wired to load, post-mutation (debounced 2000 ms), `visibilitychange`→visible, and `online`; an in-flight guard so two syncs never overlap; a `storage` listener that reloads the module-scope snapshot and re-renders.

- [ ] **Step 1: Write the failing ownership test**

Append to `tests/sync.test.js`. This is a source-level assertion because the property it protects — that no second writer exists — cannot be observed from behaviour in a single-tab test:

```js
import { readFileSync } from 'node:fs';

test('sync.js never imports a storage writer — the single-writer rule, enforced', () => {
  const src = readFileSync(new URL('../js/sync.js', import.meta.url), 'utf8');
  for (const forbidden of ['saveItems', 'saveFeeds', 'saveFeedCache']) {
    assert.ok(!src.includes(forbidden),
      `sync.js references ${forbidden}; a second writer silently reverts pulled records (spec 5.5)`);
  }
});
```

- [ ] **Step 2: Run to verify it passes already, then write the app.js wiring**

Run: `npm test` — this test should PASS against Task 5's `sync.js`. It is a regression guard, not a red-green step. Confirm it fails if you temporarily add `import { saveItems } from './storage.js';` to `sync.js`, then revert.

- [ ] **Step 3: Implement the wiring in `js/app.js`**

Add, following the file's existing style and its `onFeedsChanged` precedent at `js/app.js:98`:

```js
// Sync applies through the owners of each key, never through storage directly.
// app.js owns `items`; feeds.js owns feeds. See spec 5.5 — a second writer
// reverts pulled records deterministically, not as a race.
function applySyncedState(state) {
  items = state.items;
  saveItems(items);
  applyRemoteFeeds(state.feeds);
  saveTombstones(state.tombstones);
  feeds = loadFeeds();
  feedCache = loadFeedCache();
  render();
}

let syncInFlight = false;
let syncTimer = null;

async function runSync() {
  if (syncInFlight || !isLinked()) return;
  syncInFlight = true;
  try {
    await syncOnce({
      fetchImpl: (u, o) => fetch(u, o),
      now: () => new Date(),
      apiBase: WORKER_URL,
      applyState: applySyncedState,
    });
  } catch (err) {
    // Never let a sync failure break the app; local data keeps rendering.
    console.error('sync', err && err.name);
  } finally {
    syncInFlight = false;
    renderSyncStatus();
  }
}

// Debounced so one smart-add batch is one push, not one per item.
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 2000);
}

// Another tab wrote. Reload our module-scope snapshot rather than letting the
// next addItems() write a stale array back over it. This event does not fire in
// the tab that performed the write, so no echo guard is needed.
window.addEventListener('storage', (e) => {
  if (!e.key || !e.key.startsWith('plaenicke.')) return;
  items = loadItems();
  feeds = loadFeeds();
  feedCache = loadFeedCache();
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') runSync();
});
window.addEventListener('online', runSync);
runSync();
```

Call `scheduleSync()` at the end of `addItems` and `deleteItem`. Import `WORKER_URL` from `js/config.js` — read that file and use whatever it actually exports; do not invent a name.

- [ ] **Step 4: Run the suite**

Run: `npm test` — Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add js/app.js tests/sync.test.js
git commit -m "feat(sync): wire sync triggers, apply callback and cross-tab refresh"
```

---

### Task 8: `linkui.js` — the linking UI

**Files:**
- Create: `js/linkui.js`
- Modify: `js/settings.js` (mount only)
- Test: `tests/linkui.test.js`

**Interfaces:**
- Consumes: `isLinked`, `getLink`, `linkWithCode`, `unlink` (Task 4); `composeLinkCode` (Task 1); `loadSyncState` (Task 3).
- Produces: `initLinkUI({ host, onLinked, onUnlinked })` exported from `js/linkui.js`, plus the pure helpers below, which are what the tests target:
  - `describeSyncStatus(syncState, now: Date): string` — e.g. `'Last synced 4 minutes ago'`, `'Never synced'`, `'Sync failed — will retry'`
  - `classifyPastedCode(input: string): 'linkcode' | 'token' | 'invalid'`

Keep DOM assembly thin and the decisions pure — `tests/linkui.test.js` tests the two pure helpers only, matching how `settings.js` is tested today.

The UI must offer:
1. **Unlinked:** a paste field. On a bare token, warn that this creates a **new** account and that joining an existing one needs an 86-character code from an already-linked device.
2. **Adoption choice**, when the server blob is non-empty and local data exists: **Merge** (default), **Replace this device**, **Cancel** — spec § 5.7. Never union silently.
3. **Linked:** sync status from `describeSyncStatus`, a failure banner when `lastError` is set, and **Unlink** (with a note that local data is kept).
4. **Link another device:** paste a fresh token from `POST /admin/device`, get back the composed 86-character link code. This is the only way a second device can obtain `encKey`, since the Worker never sees it.

Never render the link code except in the field the user copies from, and never log it.

- [ ] **Step 1: Write the failing tests for the pure helpers**

`tests/linkui.test.js` — cover: `describeSyncStatus` for never-synced, just-synced, minutes ago, hours ago, and with `lastError` set; `classifyPastedCode` for an 86-char code, a 43-char token, whitespace padding, and junk.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test` — Expected: FAIL, `../js/linkui.js` cannot be resolved.

- [ ] **Step 3: Implement `js/linkui.js` and mount it from `js/settings.js`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/linkui.js js/settings.js tests/linkui.test.js
git commit -m "feat(sync): linking UI with explicit adoption choice"
```

---

### Task 9: Service worker, convergence property test, and the offline guard

**Files:**
- Modify: `service-worker.js`
- Test: `tests/merge.test.js` (append), `tests/serviceworker.test.js` (create if absent)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing service-worker test**

`tests/serviceworker.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('every js/ module is precached — a missing one white-screens a cold offline start', () => {
  const sw = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
  for (const f of readdirSync(new URL('../js', import.meta.url))) {
    if (!f.endsWith('.js')) continue;
    assert.ok(sw.includes(`js/${f}`), `service-worker ASSETS is missing js/${f}`);
  }
});

test('the cache name was bumped past the previous release', () => {
  const sw = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
  assert.ok(!sw.includes("'plaenicke-v5-1'"), 'CACHE must be bumped so the new modules are fetched');
});
```

This guards spec § 4.3's warning directly: `app.js` statically imports `sync.js`, so if `sync.js` is not precached a cold offline start fails the module graph and white-screens the app — strictly worse than today's graceful degradation.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test` — Expected: FAIL, the five new modules are absent from `ASSETS`.

- [ ] **Step 3: Add the modules and bump the cache**

In `service-worker.js`, add `js/crypto.js`, `js/merge.js`, `js/auth.js`, `js/sync.js`, `js/linkui.js` to `ASSETS` and set `CACHE = 'plaenicke-v5-2'`.

- [ ] **Step 4: Write the convergence property test**

Append to `tests/merge.test.js`. Spec § 8 calls this out specifically: it would have caught two of the first draft's criticals before they were written.

```js
test('two clients applying randomised operations converge to identical state', () => {
  // Deterministic PRNG — no Math.random, so a failure reproduces.
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

  for (let trial = 0; trial < 200; trial += 1) {
    let a = emptyState(), b = emptyState();
    for (let step = 0; step < 12; step += 1) {
      const at = new Date(Date.UTC(2026, 7, 1 + rnd(20), rnd(24)));
      const id = `r${rnd(5)}`;
      const target = rnd(2) === 0 ? 'a' : 'b';
      const apply = (s) => (rnd(2) === 0
        ? { ...s, items: [...s.items.filter(i => i.id !== id), { id, title: id, date: '2026-08-02', time: null, updatedAt: at.toISOString() }] }
        : { ...s, tombstones: [...s.tombstones.filter(t => t.id !== id), { id, kind: 'item', deletedAt: at.toISOString() }] });
      if (target === 'a') a = apply(a); else b = apply(b);
    }
    const now = new Date('2026-09-01T00:00:00.000Z');
    // Both directions must land on the same place.
    const ab = merge(a, b, now);
    const ba = merge(b, a, now);
    const key = (s) => JSON.stringify({
      items: s.items.map(i => i.id).sort(),
      tombstones: s.tombstones.map(t => `${t.kind}:${t.id}`).sort(),
    });
    assert.equal(key(ab), key(ba), `diverged on trial ${trial}`);
  }
});
```

- [ ] **Step 5: Run the full suite**

Run: `npm test` — Expected: PASS. Also run `cd worker && npm test` to confirm 100 still pass and nothing in this plan touched the Worker.

- [ ] **Step 6: Commit**

```bash
git add service-worker.js tests/serviceworker.test.js tests/merge.test.js
git commit -m "feat(sync): precache sync modules, bump cache, add convergence property test"
```

---

## Self-Review (completed at plan time)

**Spec coverage.** § 5.4 merge → Task 2. § 5.5 single-writer → Tasks 5 (no save imports), 6 (`applyRemoteFeeds`), 7 (apply callback), with a source-level regression guard in Task 7. § 5.6 tombstones → Task 2 (already stored by Plan 1). § 5.7 adoption and dedupe → Tasks 2 (`dedupeState`), 5 (`adoptChoice`), 8 (the choice UI). § 6.2 encryption → Task 1. § 6.3 `color`/`hidden` never sync and deletions route through `removeFeed` → Tasks 2 and 6. § 6.6 refuse to apply an unparseable blob → Task 5. § 7 apply-before-advance, surfaced failures, never clear local data → Tasks 5 and 8. § 8 convergence property test → Task 9. § 4.3 service-worker precache → Task 9.

**Deliberately out of scope, per the user's decision to split:** authenticating smart-add, the `usage` quota table, and rate limiting (spec §§ 6.1, 6.5) are Plan 4 — they follow the manual "link the phone and verify" step in § 9. The custom domain (§ 13) is excluded by the owner.

**Placeholder scan.** Tasks 6 and 8 give test *intent* rather than literal test code, because both depend on `feeds.js`'s and `settings.js`'s existing setup, which the implementer must read first — writing invented code against an unread API is worse than naming the assertions precisely. Every other task carries literal, runnable code. No TBDs.

**Type consistency.** `state` is `{schemaVersion, items, feeds, tombstones}` everywhere. `merge(local, remote, now: Date)` is called with `now()` in Task 5 and a `Date` in Task 2's tests. `getLink()` returns `{authToken, encKey, code}` in Task 4 and is destructured as such in Task 5. `applyState(state)` in Task 5 matches `applySyncedState(state)` in Task 7. `color: null` is emitted by Task 2 and consumed by Task 6.

**Known risk carried from Plan 2.** Nothing here is verified against real D1. The Worker's CAS check fails closed, so if real D1 ever returns an unexpected `meta.changes` shape, every `PUT` 409s permanently — which is exactly why `MAX_ATTEMPTS` is bounded and the failure surfaces rather than spinning.
