# plaenicke V5 — Plan 3 of 4: Client Sync Orchestration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two devices show the same items and calendar subscriptions, by encrypting local state client-side and syncing it through the Worker's compare-and-swap `/data` endpoint — per spec §§ 5.4–5.7, 6.2–6.3, 6.6, 7.

**Architecture:** A pure `merge()` over `{items, feeds, tombstones}` decides the combined state. `sync.js` orchestrates pull → decrypt → merge → apply → encrypt → push with bounded compare-and-swap retry, and **never writes storage directly** — it hands merged state to the modules that own each key, and those owners re-merge against live storage immediately before writing. `crypto.js` holds AES-GCM and link-code encoding; `auth.js` the link lifecycle; `linkui.js` the linking DOM.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. Web Crypto (`crypto.subtle`, `crypto.getRandomValues`). `node --test` with injected effects, matching `js/feeds.js`.

**Spec:** `docs/superpowers/specs/2026-08-01-plaenicke-v5-accounts-sync-design.md`

**This plan was revised after an adversarial review found four Critical defects in its first draft.** Sections marked **(DA-Cx)** exist because of specific findings; do not "simplify" them back.

## Global Constraints

- **`sync.js` must never import `saveItems`, `saveFeeds`, or `saveFeedCache`.** Spec § 5.5: `app.js:53` holds `let items = loadItems()` at module scope and writes the whole array back. A second writer means the next `addItems()` silently reverts every pulled record — **deterministically, not as a race**.
- **The owner re-merges against live storage immediately before writing (DA-C4).** Between the merge that produced a state and the write, there can be `await`s — a whole PUT round trip on a CAS retry — during which the user adds or deletes. Writing the snapshot wholesale destroys those edits. For a feed this is unrecoverable: `settings.js` never renders `feed.url`, so a destroyed subscription cannot be re-entered from anything on screen.
- **`dedupeState` runs ONLY at adoption, never on an ordinary sync (DA-C1).** It collapses items sharing `title+date+time`. Two todos called "Call mom" on the same day is ordinary in an app with no edit UI; collapsing them on every tick is silent, permanent, cross-device deletion with an `ok` status.
- **The adoption choice is presented BEFORE anything is applied or pushed (DA-C2).** Linking sets `adoptionPending`; ordinary sync refuses to run while it is set. Spec § 5.7: never union silently.
- **The pushed blob is canonical and carries no per-device fields (DA-C3).** Sorted by `id`, with `color`/`hidden` stripped. Otherwise two devices each see the other's blob as "changed" and push on every trigger forever — measured at 7 pushes in 8 syncs.
- **A fresh random 12-byte IV per encryption, taken from `crypto.getRandomValues`.** Never a counter, never derived from the version or the key. Two devices share one `encKey`; a counter-derived IV means both start at zero and collide across devices, which voids AES-GCM confidentiality entirely.
- **`encKey` never leaves the device and never reaches the Worker.** Only `authToken` goes on the wire.
- **The client refuses to apply a blob it cannot parse** (spec § 6.6). Decrypt failure or unknown `schemaVersion` halts and surfaces; it never partially applies. A record dropped by a deserializer looks like a local deletion and would propagate a tombstone to every device.
- **`color` and `hidden` are per-device and never sync** (spec § 6.3). `merge` keeps local values for a known feed and emits `color: null` for a first-seen one; `feeds.js` assigns the real default because it owns the colour cycle. **Every feed reaching `saveFeeds` must have a string `color` and boolean `hidden`** — `deserializeFeeds` (`js/storage.js:71-77`) drops feeds that fail those checks, so a `null` colour that reaches storage silently destroys the subscription on the next load.
- **A pulled feed deletion goes through `feeds.js`'s `removeFeed()`**, never a raw `saveFeeds()`, or `feedCache[id]` orphans into a permanent quota leak.
- **CAS retry is bounded at 3 attempts, then halt and surface** (spec § 5.3). The Worker's conflict check fails *closed*: an unexpected `meta.changes` shape from D1 makes every `PUT` 409 permanently.
- **Every task that creates a `js/` module adds it to `service-worker.js`'s `ASSETS` in the same commit (DA-M5).** `app.js` statically imports these modules; a commit where `ASSETS` lags leaves a cold offline start white-screening the app — strictly worse than today's graceful degradation.
- `schemaVersion` is `1`. Any other value is rejected, not migrated.
- Feed URLs and link codes are secrets. Never log a blob, a request body, a feed URL, or a link code. Log error *names* only, matching `js/feeds.js:456`.
- Test command: **`npm test`** at the repo root. **`node --test tests/` runs ZERO tests** — verified. Node is v22.18.0, where **`localStorage` is undefined**; every test touching storage must install the shared fake (Task 0).
- No new dependencies. No build step.
- Sync is a no-op when unlinked (spec § 4.4).

## File Structure

```
tests/fake-localstorage.js — NEW: shared localStorage double (Node has none)
js/crypto.js               — NEW: AES-GCM; link-code encode/decode/generate/compose-for-new-device
js/merge.js                — NEW: pure merge(), dedupeState(), toWire(); no I/O, no crypto, no DOM
js/auth.js                 — NEW: link-code lifecycle, adoptionPending flag
js/sync.js                 — NEW: pull/merge/apply/push, effects injected
js/linkui.js               — NEW: linking DOM + renderSyncStatus
js/storage.js              — MODIFY: plaenicke.auth, plaenicke.syncState
js/feeds.js                — MODIFY: applyRemoteFeeds()
js/settings.js             — MODIFY: re-read feeds before each save; mount linkui
js/app.js                  — MODIFY: apply callback, storage listener, sync triggers
service-worker.js          — MODIFY: precache each new module in its own task's commit
tests/{crypto,merge,auth,sync,linkui,serviceworker}.test.js — NEW
tests/{storage,feeds}.test.js — MODIFY
```

## Owner steps (manual, cannot be automated)

`wrangler d1 create`, `d1 migrations apply --remote`, `secret put ADMIN_SECRET`, `deploy` all need the owner's Cloudflare account. Until they run, `/data` does not exist. **Nothing in this plan is verified against real D1 or a real browser** — every test runs against an injected `fetchImpl` and a fake `localStorage`.

---

### Task 0: Shared `localStorage` double

Node 22 has no `localStorage` (verified: `node -e 'console.log(typeof localStorage)'` → `undefined`). Existing tests each define their own fake inline; the new test files need one too, and Task 3 appends to `tests/storage.test.js` after a stub that implements only `getItem`/`setItem`. Without this task the new tests fail with `ReferenceError` and `TypeError` — red for the wrong reason, which invites weakening the assertions until they pass.

**Files:** Create `tests/fake-localstorage.js`; Test: `tests/fake-localstorage.test.js`

**Interfaces:**
- Produces: `class FakeLocalStorage` with `getItem`, `setItem`, `removeItem`, `clear`, `key`, `length`; and `installFakeLocalStorage(): FakeLocalStorage` which assigns it to `globalThis.localStorage` and returns it.

- [ ] **Step 1: Write the failing test**

`tests/fake-localstorage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';

test('the double implements the full surface the app uses', () => {
  const ls = installFakeLocalStorage();
  assert.equal(globalThis.localStorage, ls);
  assert.equal(ls.getItem('nope'), null);
  ls.setItem('a', '1');
  assert.equal(ls.getItem('a'), '1');
  assert.equal(ls.length, 1);
  assert.equal(ls.key(0), 'a');
  ls.removeItem('a');
  assert.equal(ls.getItem('a'), null);
  ls.setItem('b', '2');
  ls.clear();
  assert.equal(ls.length, 0);
});

test('setItem coerces to string like the real API', () => {
  const ls = installFakeLocalStorage();
  ls.setItem('n', 5);
  assert.strictEqual(ls.getItem('n'), '5');
});

test('installing again gives a clean store', () => {
  installFakeLocalStorage().setItem('a', '1');
  assert.equal(installFakeLocalStorage().getItem('a'), null);
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test`, expect FAIL (module not found).

- [ ] **Step 3: Implement**

`tests/fake-localstorage.js`:

```js
// fake-localstorage.js — Node 22 has no localStorage, so every test that
// exercises storage.js installs this. Kept deliberately faithful: setItem
// coerces to string, getItem returns null (not undefined) for a miss.

export class FakeLocalStorage {
  constructor() { this.store = new Map(); }
  get length() { return this.store.size; }
  key(i) { return [...this.store.keys()][i] ?? null; }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

export function installFakeLocalStorage() {
  const ls = new FakeLocalStorage();
  globalThis.localStorage = ls;
  return ls;
}
```

- [ ] **Step 4: Run tests** — `npm test`, expect PASS (3 new).

- [ ] **Step 5: Commit**

```bash
git add tests/fake-localstorage.js tests/fake-localstorage.test.js
git commit -m "test: shared localStorage double for the sync test suite"
```

---

### Task 1: `crypto.js` — AES-GCM and link-code encoding

The link code is `base64url( authToken(32 bytes) || encKey(32 bytes) )` — 86 characters (spec § 4.1). The Worker mints the token as `base64url(32 random bytes)`, padding stripped, `+/`→`-_`, and stores only `sha256(that exact 43-character string)`. **The client must send a byte-identical string** or every request 401s.

**Files:** Create `js/crypto.js`; Modify `service-worker.js` (ASSETS); Test: `tests/crypto.test.js`

**Interfaces:**
- Produces from `js/crypto.js`: `bytesToBase64url(bytes)`, `base64urlToBytes(s)` (throws on invalid), `generateEncKey()`, `composeLinkCode(authToken, encKey)`, `parseLinkCode(code)` (throws), `composeForNewDevice(newToken, link)`, `encryptBlob(encKey, obj) → Promise<string>`, `decryptBlob(encKey, blob) → Promise<any>`, `IV_BYTES = 12`, `KEY_BYTES = 32`, `TOKEN_BYTES = 32`.

- [ ] **Step 1: Write the failing tests**

`tests/crypto.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToBase64url, base64urlToBytes, generateEncKey, composeLinkCode,
  parseLinkCode, composeForNewDevice, encryptBlob, decryptBlob, IV_BYTES, KEY_BYTES,
} from '../js/crypto.js';

// Exactly the encoding worker/src/auth.js uses. If ours differs by one
// character the Bearer token never matches the stored hash.
function workerStyleToken(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const allBytes = () => Uint8Array.from({ length: 256 }, (_, i) => i);

test('bytesToBase64url matches the Worker encoding for all 256 byte values', () => {
  assert.equal(bytesToBase64url(allBytes()), workerStyleToken(allBytes()));
});

test('base64url round-trips every byte value without loss', () => {
  assert.deepEqual([...base64urlToBytes(bytesToBase64url(allBytes()))], [...allBytes()]);
});

test('base64urlToBytes rejects non-base64url input', () => {
  assert.throws(() => base64urlToBytes('has spaces'));
  assert.throws(() => base64urlToBytes('plus+slash/'));
  assert.throws(() => base64urlToBytes(''));
});

test('generateEncKey returns 32 fresh bytes', () => {
  const a = generateEncKey(), b = generateEncKey();
  assert.equal(a.length, KEY_BYTES);
  assert.notDeepEqual([...a], [...b]);
});

test('a composed link code parses back to the EXACT token string the Worker hashed', () => {
  const token = workerStyleToken(generateEncKey());
  const encKey = generateEncKey();
  const code = composeLinkCode(token, encKey);
  assert.equal(code.length, 86);
  const parsed = parseLinkCode(code);
  assert.equal(parsed.authToken, token);
  assert.deepEqual([...parsed.encKey], [...encKey]);
});

test('parseLinkCode rejects a bare token, a truncated code, and junk', () => {
  const token = workerStyleToken(generateEncKey());
  assert.throws(() => parseLinkCode(token));
  assert.throws(() => parseLinkCode(token + 'AA'));
  assert.throws(() => parseLinkCode('!!!'));
  assert.throws(() => parseLinkCode(''));
});

// The single most dangerous mistake in the linking flow: composing a code for
// a second device with a NEW key means that device can never read the account
// and there is no diagnostic for it.
test('composeForNewDevice reuses the EXISTING key, never a fresh one', () => {
  const encKey = generateEncKey();
  const link = { authToken: workerStyleToken(generateEncKey()), encKey };
  const newToken = workerStyleToken(generateEncKey());
  const parsed = parseLinkCode(composeForNewDevice(newToken, link));
  assert.equal(parsed.authToken, newToken, 'must carry the NEW token');
  assert.deepEqual([...parsed.encKey], [...encKey], 'must carry the EXISTING key');
});

test('encrypt then decrypt round-trips an object', async () => {
  const key = generateEncKey();
  const obj = { schemaVersion: 1, items: [{ id: 'a', title: 'x' }], feeds: [], tombstones: [] };
  assert.deepEqual(await decryptBlob(key, await encryptBlob(key, obj)), obj);
});

// A CONSTANT iv and a COUNTER-derived iv are both catastrophic, and a
// distinctness check over N samples only catches the constant. Spy on the
// entropy source instead: the IV must come from getRandomValues, every time.
test('the IV is drawn from crypto.getRandomValues on every encryption', async () => {
  const key = generateEncKey();
  const real = crypto.getRandomValues.bind(crypto);
  const sizes = [];
  crypto.getRandomValues = (arr) => { sizes.push(arr.length); return real(arr); };
  try {
    await encryptBlob(key, { schemaVersion: 1 });
    await encryptBlob(key, { schemaVersion: 1 });
  } finally {
    crypto.getRandomValues = real;
  }
  assert.deepEqual(sizes, [IV_BYTES, IV_BYTES],
    'each encryption must request exactly one fresh IV from the CSPRNG');
});

test('identical plaintext never produces identical ciphertext', async () => {
  const key = generateEncKey();
  const obj = { schemaVersion: 1, items: [], feeds: [], tombstones: [] };
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    const iv = atob(await encryptBlob(key, obj)).slice(0, IV_BYTES);
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
  const bytes = Uint8Array.from(atob(await encryptBlob(key, { schemaVersion: 1 })), c => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff;
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  await assert.rejects(() => decryptBlob(key, btoa(bin)));
});

test('decryptBlob rejects malformed input', async () => {
  const key = generateEncKey();
  await assert.rejects(() => decryptBlob(key, 'not base64 at all !!!'));
  await assert.rejects(() => decryptBlob(key, btoa('short')));
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test`, expect FAIL (module not found).

- [ ] **Step 3: Implement**

`js/crypto.js`:

```js
// crypto.js — AES-GCM for the sync blob, and the link-code encoding.
//
// A link code carries two independent secrets concatenated:
//   base64url( authToken(32 bytes) || encKey(32 bytes) )
// authToken proves the device may talk to the Worker and is stored server-side
// hashed. encKey decrypts the blob and NEVER leaves this device — a full
// database compromise yields ciphertext. See spec 4.1.
//
// The base64url here must match worker/src/auth.js byte for byte: the Worker
// stored sha256 of the exact token string it minted, so a token that
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
  if (typeof s !== 'string' || !s || !BASE64URL.test(s)) throw new Error('Not a base64url string');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
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
  if (!(encKey instanceof Uint8Array) || encKey.length !== KEY_BYTES) throw new Error('Key must be 32 bytes');
  const joined = new Uint8Array(LINK_CODE_BYTES);
  joined.set(tokenBytes, 0);
  joined.set(encKey, TOKEN_BYTES);
  return bytesToBase64url(joined);
}

export function parseLinkCode(code) {
  const bytes = base64urlToBytes((code || '').trim());
  if (bytes.length !== LINK_CODE_BYTES) throw new Error('A link code is 86 characters');
  return { authToken: bytesToBase64url(bytes.slice(0, TOKEN_BYTES)), encKey: bytes.slice(TOKEN_BYTES) };
}

// Composing a code for a SECOND device. It must carry this device's existing
// key: generating a fresh one here would produce a device that can never
// decrypt the account, with no diagnostic beyond a permanent "undecryptable".
export function composeForNewDevice(newToken, link) {
  if (!link || !(link.encKey instanceof Uint8Array)) throw new Error('This device is not linked');
  return composeLinkCode((newToken || '').trim(), link.encKey);
}

async function importKey(encKey) {
  return crypto.subtle.importKey('raw', encKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBlob(encKey, obj) {
  // A fresh random IV per encryption, from the CSPRNG. NOT a counter: two
  // devices share one encKey, so both would start at zero and collide across
  // devices, which for AES-GCM leaks the XOR of the plaintexts and voids the
  // auth tag. This is not a tunable choice.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(encKey);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  let bin = ''; for (const b of out) bin += String.fromCharCode(b);
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
  // Wrong key, tampering, truncation — all surface as a rejection. The caller
  // must NOT fall back to applying partial state.
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES));
  return JSON.parse(new TextDecoder().decode(plain));
}
```

- [ ] **Step 4: Add to the service worker in this same commit**

In `service-worker.js`, add `'js/crypto.js'` to `ASSETS` and set `CACHE = 'plaenicke-v5-2'`. Every module gets precached in the commit that creates it — a commit where `ASSETS` lags leaves a cold offline start white-screening.

- [ ] **Step 5: Run tests** — `npm test`, expect PASS (13 new).

- [ ] **Step 6: Mutation-check the IV**

Run each, confirm a test FAILS, revert, and record the output:
- **M1:** constant IV — `new Uint8Array(IV_BYTES)`.
- **M2:** counter IV — a module-level `let n = 0` written into the last byte. **The distinctness test alone does not catch this; the getRandomValues spy must.**

- [ ] **Step 7: Commit**

```bash
git add js/crypto.js tests/crypto.test.js service-worker.js
git commit -m "feat(sync): AES-GCM blob encryption and link-code encoding"
```

---

### Task 2: `merge.js` — the pure merge

**Files:** Create `js/merge.js`; Modify `service-worker.js`; Test: `tests/merge.test.js`

**Interfaces:**
- Consumes: nothing. Imports nothing, touches no I/O — that is what makes Task 9's convergence simulation possible without stubs.
- Produces: `SCHEMA_VERSION = 1`; `emptyState()`; `merge(local, remote, now: Date) → state` (throws on unknown `schemaVersion`); `dedupeState(state)` — **adoption only**; `toWire(state)` — canonical, sorted, `color`/`hidden` stripped.

- [ ] **Step 1: Write the failing tests**

`tests/merge.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, dedupeState, toWire, emptyState, SCHEMA_VERSION } from '../js/merge.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const item = (id, updatedAt, extra = {}) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt, ...extra });
const feed = (id, updatedAt, extra = {}) => ({ id, url: `https://cal.example/${id}.ics`, name: `n-${id}`, color: '#111', hidden: false, updatedAt, ...extra });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });

test('a record present on only one side survives', () => {
  assert.deepEqual(merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }), state(), NOW).items.map(i => i.id), ['a']);
});

test('the higher updatedAt wins, in both directions', () => {
  const older = '2026-08-01T00:00:00.000Z', newer = '2026-08-02T00:00:00.000Z';
  assert.equal(merge(state({ items: [item('a', newer, { title: 'LOCAL' })] }),
                     state({ items: [item('a', older, { title: 'REMOTE' })] }), NOW).items[0].title, 'LOCAL');
  assert.equal(merge(state({ items: [item('a', older, { title: 'LOCAL' })] }),
                     state({ items: [item('a', newer, { title: 'REMOTE' })] }), NOW).items[0].title, 'REMOTE');
});

test('a tie goes to remote, which is what makes a re-push idempotent', () => {
  const same = '2026-08-01T00:00:00.000Z';
  assert.equal(merge(state({ items: [item('a', same, { title: 'LOCAL' })] }),
                     state({ items: [item('a', same, { title: 'REMOTE' })] }), NOW).items[0].title, 'REMOTE');
});

// DA-C1: an ordinary sync must NEVER collapse distinct records that happen to
// share a title, date and time. In an app with no edit UI, re-adding is how a
// user duplicates — and losing one is silent, permanent and cross-device.
test('merge keeps two DISTINCT items sharing title, date and time', () => {
  const out = merge(
    state({ items: [{ ...item('a', '2026-08-01T00:00:00.000Z'), title: 'Call mom', date: '2026-08-05', time: null }] }),
    state({ items: [{ ...item('b', '2026-08-01T00:00:00.000Z'), title: 'Call mom', date: '2026-08-05', time: null }] }),
    NOW);
  assert.deepEqual(out.items.map(i => i.id).sort(), ['a', 'b'],
    'merge must not dedupe — that is adoption-only behaviour');
});

test('a tombstone newer than the record removes it', () => {
  const out = merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.items, []);
  assert.equal(out.tombstones.length, 1);
});

test('a record re-created after its deletion is NOT removed', () => {
  const out = merge(state({ items: [item('a', '2026-08-03T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.items.map(i => i.id), ['a']);
});

// DA-M4: no test in the first draft used a feed tombstone, so deleting the
// feed branch entirely passed the whole suite — meaning an unsubscribe would
// never propagate and would resurrect from the other device forever.
test('a FEED tombstone removes the feed', () => {
  const out = merge(state({ feeds: [feed('f1', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'f1', kind: 'feed', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.feeds, [], 'an unsubscribe must propagate');
});

test('a re-subscribed feed survives its older tombstone', () => {
  const out = merge(state({ feeds: [feed('f1', '2026-08-03T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'f1', kind: 'feed', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.feeds.map(f => f.id), ['f1']);
});

test('an item tombstone does not delete a feed with the same id, and vice versa', () => {
  assert.deepEqual(merge(state({ feeds: [feed('a', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW).feeds.map(f => f.id), ['a']);
  assert.deepEqual(merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'feed', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW).items.map(i => i.id), ['a']);
});

test('a tombstone suppresses a record BEFORE age-pruning can drop the tombstone', () => {
  const out = merge(state({ items: [item('a', '2020-01-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2020-06-01T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.tombstones, []);
});

test('tombstones older than 90 days are pruned; newer ones are kept', () => {
  const out = merge(state(), state({ tombstones: [
    { id: 'old', kind: 'item', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', kind: 'item', deletedAt: '2026-07-30T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.tombstones.map(t => t.id), ['new']);
});

test('the newer of two tombstones for the same record wins', () => {
  const out = merge(state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-07-01T00:00:00.000Z' }] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-07-20T00:00:00.000Z' }] }), NOW);
  assert.equal(out.tombstones.length, 1);
  assert.equal(out.tombstones[0].deletedAt, '2026-07-20T00:00:00.000Z');
});

test('local color and hidden survive a pull that changes the feed name', () => {
  const out = merge(state({ feeds: [feed('a', '2026-08-01T00:00:00.000Z', { color: '#abc', hidden: true, name: 'old' })] }),
    state({ feeds: [feed('a', '2026-08-02T00:00:00.000Z', { color: '#zzz', hidden: false, name: 'new' })] }), NOW);
  assert.equal(out.feeds[0].name, 'new');
  assert.equal(out.feeds[0].color, '#abc');
  assert.equal(out.feeds[0].hidden, true);
});

test('a first-seen feed arrives with color null for feeds.js to assign', () => {
  const out = merge(state(), state({ feeds: [feed('a', '2026-08-02T00:00:00.000Z', { color: '#zzz', hidden: true })] }), NOW);
  assert.equal(out.feeds[0].color, null);
  assert.equal(out.feeds[0].hidden, false);
});

test('a wire feed carrying no color at all is still handled', () => {
  const bare = { id: 'a', url: 'https://cal.example/a.ics', name: 'n', updatedAt: '2026-08-02T00:00:00.000Z' };
  assert.equal(merge(state(), state({ feeds: [bare] }), NOW).feeds[0].color, null);
});

test('an unknown schemaVersion is rejected rather than migrated', () => {
  assert.throws(() => merge(state(), { ...state(), schemaVersion: 99 }, NOW));
  assert.throws(() => merge({ ...state(), schemaVersion: 0 }, state(), NOW));
});

test('merge is idempotent — merging a result with its own remote changes nothing', () => {
  const once = merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }),
                     state({ items: [item('b', '2026-08-02T00:00:00.000Z')] }), NOW);
  assert.deepEqual(merge(once, state({ items: [item('b', '2026-08-02T00:00:00.000Z')] }), NOW), once);
});

// DA-C3: without a canonical projection, two devices each see the other's
// blob as "changed" — measured at 7 pushes in 8 syncs, forever.
test('toWire strips per-device fields and sorts, so two devices agree byte for byte', () => {
  const a = state({
    items: [item('z', '2026-08-01T00:00:00.000Z'), item('a', '2026-08-01T00:00:00.000Z')],
    feeds: [feed('f', '2026-08-01T00:00:00.000Z', { color: '#111', hidden: false })],
    tombstones: [{ id: 'y', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }, { id: 'x', kind: 'feed', deletedAt: '2026-08-01T00:00:00.000Z' }],
  });
  const b = state({
    items: [item('a', '2026-08-01T00:00:00.000Z'), item('z', '2026-08-01T00:00:00.000Z')],
    feeds: [feed('f', '2026-08-01T00:00:00.000Z', { color: '#999', hidden: true })],
    tombstones: [{ id: 'x', kind: 'feed', deletedAt: '2026-08-01T00:00:00.000Z' }, { id: 'y', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }],
  });
  assert.equal(JSON.stringify(toWire(a)), JSON.stringify(toWire(b)));
  assert.ok(!JSON.stringify(toWire(a)).includes('#111'), 'colour must not reach the wire');
  assert.ok(!('hidden' in toWire(a).feeds[0]), 'hidden must not reach the wire');
});

test('toWire is idempotent', () => {
  const w = toWire(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }));
  assert.deepEqual(toWire(w), w);
});

test('dedupeState collapses feeds sharing a normalised URL, keeping the newer', () => {
  const out = dedupeState(state({ feeds: [
    { ...feed('a', '2026-08-01T00:00:00.000Z'), url: 'https://cal.example/x.ics' },
    { ...feed('b', '2026-08-02T00:00:00.000Z'), url: 'HTTPS://Cal.Example/x.ics/' }] }));
  assert.equal(out.feeds.length, 1);
  assert.equal(out.feeds[0].id, 'b');
});

test('dedupeState collapses items sharing title, date and time', () => {
  const out = dedupeState(state({ items: [
    { ...item('a', '2026-08-01T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('b', '2026-08-02T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('c', '2026-08-02T00:00:00.000Z'), title: 'Dentist', date: '2026-08-06', time: '09:00' }] }));
  assert.deepEqual(out.items.map(i => i.id).sort(), ['b', 'c']);
});

// Deterministic tie-breaking: without it two devices with different array
// order keep different survivors and the id flaps between them forever.
test('dedupeState breaks an updatedAt tie deterministically by id', () => {
  const same = '2026-08-01T00:00:00.000Z';
  const base = { title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: same };
  const forward = dedupeState(state({ items: [{ ...base, id: 'a' }, { ...base, id: 'b' }] }));
  const reverse = dedupeState(state({ items: [{ ...base, id: 'b' }, { ...base, id: 'a' }] }));
  assert.deepEqual(forward.items.map(i => i.id), reverse.items.map(i => i.id));
});

test('emptyState is a valid mergeable state', () => {
  assert.deepEqual(merge(emptyState(), emptyState(), NOW), emptyState());
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test`, expect FAIL (module not found).

- [ ] **Step 3: Implement**

`js/merge.js`:

```js
// merge.js — the pure conflict-resolution function. No I/O, no crypto, no DOM,
// no imports. Everything arrives as arguments, which is what lets the
// convergence simulation drive it directly.
//
// Last-write-wins per record. Because merging is per record, edits to DIFFERENT
// records on two devices never conflict — the common case, and it is safe.
// Editing the SAME record on both while offline loses the older edit; spec 5.4
// explains why that trade is accepted.
//
// CLOCK SKEW IS THE WEAK JOINT. updatedAt is wall-clock time from two devices
// whose clocks are never compared. A phone 90 seconds ahead of a laptop wins
// every tie for 90 seconds, silently. This is tolerable ONLY because the app
// has no edit path today — app.js adds and deletes, nothing rewrites a record —
// so the same id is almost never written on both devices. Anyone adding an edit
// feature must revisit this before shipping it.

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
    if (!mine || ts(rec.updatedAt) >= ts(mine.updatedAt)) out.set(rec.id, pick ? pick(rec, mine) : rec);
  }
  return [...out.values()];
}

// color and hidden are per-device view preferences and never sync (spec 6.3).
// Keep local values for a feed we know; hand a first-seen feed to feeds.js with
// color null so it assigns from its own colour cycle. feeds.js MUST replace
// that null before saving — deserializeFeeds drops feeds whose color is not a
// string, which would silently destroy the subscription on the next load.
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
  // its record resurrect inside this same merge.
  return {
    schemaVersion: SCHEMA_VERSION,
    items: applyTombstones(unionById(local.items, remote.items), tombstones, 'item'),
    feeds: applyTombstones(unionById(local.feeds, remote.feeds, pickFeed), tombstones, 'feed'),
    tombstones: prune(tombstones, now),
  };
}

// --- the wire form ---
// The blob two devices compare and exchange must be identical for identical
// content, or each sees the other's push as a change and they push at each
// other forever. Sorting removes array-order drift; stripping color/hidden
// removes the per-device fields that are deliberately NOT synced.

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byTombstone = (a, b) => {
  const ka = `${a.kind}:${a.id}`, kb = `${b.kind}:${b.id}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

export function toWire(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    items: [...state.items].sort(byId),
    feeds: [...state.feeds].map(({ color, hidden, ...rest }) => rest).sort(byId),
    tombstones: [...state.tombstones].sort(byTombstone),
  };
}

// --- adoption only (spec 5.7) ---
// Feed ids are per device, so linking a laptop and a phone that subscribe to
// the same four calendars otherwise yields eight feeds — every event drawn
// twice, in two colours, in every view. This runs ONCE, at link time, on the
// user's explicit choice. Running it on an ordinary sync would silently delete
// any two records that happen to share a title, date and time.

function normalizeUrl(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

function collapse(records, keyOf) {
  const out = new Map();
  for (const rec of records) {
    const key = keyOf(rec);
    const prior = out.get(key);
    // Tie-break by id so two devices with different array order keep the SAME
    // survivor; otherwise the winning id flaps between them indefinitely.
    if (!prior || ts(rec.updatedAt) > ts(prior.updatedAt)
      || (ts(rec.updatedAt) === ts(prior.updatedAt) && rec.id < prior.id)) {
      out.set(key, rec);
    }
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

- [ ] **Step 4: Add `js/merge.js` to `service-worker.js`'s `ASSETS`** (same commit).

- [ ] **Step 5: Run tests** — `npm test`, expect PASS (23 new).

- [ ] **Step 6: Mutation-check the merge core**

Run each, confirm a test FAILS, revert, record the output:
- **M1:** `>=` → `>` in `unionById` (ties go local; retry idempotence breaks).
- **M2:** move `prune()` before `applyTombstones` (records resurrect).
- **M3:** delete the `color`/`hidden` preservation in `pickFeed`. **Check this one carefully rather than assuming it bites:** once `toWire` strips `color`/`hidden`, the only wire fields a feed carries are `id`, `url`, `name`, `updatedAt`, so the per-device-field protection has very little surface left to fail on. If M3 survives, the protection is untested in the one place it matters — add a direct test that a pulled feed whose remote record carries a different colour leaves the local colour untouched.
- **M4:** `>` → `>=` in `applyTombstones` (same-millisecond re-creation vanishes).
- **M5:** delete the `'feed'` call in `merge` (unsubscribes stop propagating).
- **M6:** make `toWire` return `state` unchanged (per-device fields reach the wire).
- **M7:** drop the id tie-break in `collapse`.

Add a test for any mutant that survives, and prove the new test fails under it.

- [ ] **Step 7: Commit**

```bash
git add js/merge.js tests/merge.test.js service-worker.js
git commit -m "feat(sync): pure merge, canonical wire form, adoption dedupe"
```

---

### Task 3: `storage.js` — `plaenicke.auth` and `plaenicke.syncState`

**Files:** Modify `js/storage.js` (append only); Test: `tests/storage.test.js` (append)

**Interfaces:**
- Produces from `js/storage.js`: `loadAuth()`, `saveAuth(code)`, `clearAuth()`, `loadSyncState()`, `saveSyncState(s)`, `AUTH_KEY`, `SYNC_STATE_KEY`.
- `syncState` shape: `{ version, tokenHash, lastSyncedAt, lastError, adoptionPending }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/storage.test.js`. **Import the shared double from Task 0 and install it in every new test** — the stub left installed by the preceding tests implements only `getItem`/`setItem`.

```js
import { installFakeLocalStorage } from './fake-localstorage.js';
import { loadAuth, saveAuth, clearAuth, loadSyncState, saveSyncState } from '../js/storage.js';

test('auth round-trips and clears', () => {
  installFakeLocalStorage();
  assert.equal(loadAuth(), null);
  saveAuth('abc');
  assert.equal(loadAuth(), 'abc');
  clearAuth();
  assert.equal(loadAuth(), null);
});

test('loadSyncState returns a zeroed state when nothing is stored', () => {
  installFakeLocalStorage();
  assert.deepEqual(loadSyncState(),
    { version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false });
});

test('syncState round-trips including adoptionPending', () => {
  installFakeLocalStorage();
  const s = { version: 7, tokenHash: 'h', lastSyncedAt: '2026-08-02T00:00:00.000Z', lastError: null, adoptionPending: true };
  saveSyncState(s);
  assert.deepEqual(loadSyncState(), s);
});

test('a corrupt or non-numeric syncState falls back to zero rather than throwing', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.syncState', '{{{');
  assert.equal(loadSyncState().version, 0);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 'seven' }));
  assert.equal(loadSyncState().version, 0);
});

// adoptionPending gates the first sync of a newly linked device. A corrupt
// value must fail CLOSED (pending) rather than open, or the union is applied
// and pushed before the user is asked.
test('a missing or non-boolean adoptionPending reads as false only when explicitly false', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1, adoptionPending: 'yes' }));
  assert.equal(loadSyncState().adoptionPending, true);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1, adoptionPending: false }));
  assert.equal(loadSyncState().adoptionPending, false);
});

test('saveSyncState converts a quota failure to QuotaError', () => {
  const ls = installFakeLocalStorage();
  ls.setItem = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
  assert.throws(() => saveSyncState({ version: 1 }), (e) => e.name === 'QuotaError');
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test`, expect FAIL (`loadAuth` not exported).

- [ ] **Step 3: Implement** — append to `js/storage.js`:

```js
// --- sync credentials and cursor ---
// The link code contains the encryption key, so it is a secret: never log it
// and never render it outside the linking UI.

export const AUTH_KEY = 'plaenicke.auth';
export const SYNC_STATE_KEY = 'plaenicke.syncState';

export function loadAuth() {
  const v = localStorage.getItem(AUTH_KEY);
  return typeof v === 'string' && v ? v : null;
}

export function saveAuth(code) { localStorage.setItem(AUTH_KEY, code); }
export function clearAuth() { localStorage.removeItem(AUTH_KEY); }

const ZERO_SYNC_STATE = {
  version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false,
};

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
  return {
    version: Number.isInteger(parsed.version) && parsed.version >= 0 ? parsed.version : 0,
    tokenHash: typeof parsed.tokenHash === 'string' ? parsed.tokenHash : null,
    lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null,
    lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
    // Fails CLOSED: ONLY an explicit false lifts the gate. A missing key, a
    // corrupt value, null, 0 — all read as still-pending, so nothing can let
    // the silent union through. Do NOT add `&& !== undefined`: a stored object
    // that omits the key would then read as lifted, which is the exact
    // fail-open this guard exists to prevent.
    adoptionPending: parsed.adoptionPending !== false,
  };
}

// Merges over the CURRENT persisted state, not over the zero state: a caller
// doing a partial update (`{version, lastSyncedAt}` after a routine sync) would
// otherwise silently reset adoptionPending to false and lift the gate.
export function saveSyncState(s) {
  try {
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ ...loadSyncState(), ...s }));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') throw new QuotaError('Sync state exceeded storage quota');
    throw err;
  }
}
```

- [ ] **Step 4: Run tests** — `npm test`, expect PASS (6 new).

- [ ] **Step 5: Commit**

```bash
git add js/storage.js tests/storage.test.js
git commit -m "feat(sync): persist the link code and the sync cursor"
```

---

### Task 4: `auth.js` — link lifecycle and the adoption gate

**Files:** Create `js/auth.js`; Modify `service-worker.js`; Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: `parseLinkCode`, `composeLinkCode`, `generateEncKey`, `base64urlToBytes`, `TOKEN_BYTES` (Task 1); the storage functions (Task 3).
- Produces from `js/auth.js`: `isLinked()`, `getLink() → {authToken, encKey, code} | null`, `tokenHash(t) → Promise<string>`, `linkWithCode(input) → Promise<link>` (sets `adoptionPending`), `unlink()`, `resetSyncStateIfDeviceChanged(t) → Promise<void>`, `isAdoptionPending()`, `clearAdoptionPending()`.

- [ ] **Step 1: Write the failing tests**

`tests/auth.test.js` — **begin the file with the Task 0 double**:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { generateEncKey, bytesToBase64url, composeLinkCode } from '../js/crypto.js';
import { loadSyncState, saveSyncState, loadItems, saveItems } from '../js/storage.js';
import {
  isLinked, getLink, linkWithCode, unlink, tokenHash,
  resetSyncStateIfDeviceChanged, isAdoptionPending, clearAdoptionPending,
} from '../js/auth.js';

const bareToken = () => bytesToBase64url(generateEncKey());

test('an unlinked device reports unlinked and has no link', () => {
  installFakeLocalStorage();
  assert.equal(isLinked(), false);
  assert.equal(getLink(), null);
});

test('a bare token bootstraps a fresh encKey and stores a full link code', async () => {
  installFakeLocalStorage();
  const token = bareToken();
  const link = await linkWithCode(token);
  assert.equal(link.authToken, token);
  assert.equal(link.encKey.length, 32);
  assert.equal(link.code.length, 86);
  assert.equal(isLinked(), true);
});

test('two bootstraps generate DIFFERENT keys — a bare token never joins an existing account', async () => {
  installFakeLocalStorage();
  const a = await linkWithCode(bareToken());
  installFakeLocalStorage();
  const b = await linkWithCode(bareToken());
  assert.notDeepEqual([...a.encKey], [...b.encKey]);
});

test('a full link code joins with the SAME key it carries', async () => {
  installFakeLocalStorage();
  const key = generateEncKey();
  const link = await linkWithCode(composeLinkCode(bareToken(), key));
  assert.deepEqual([...link.encKey], [...key]);
});

test('linkWithCode rejects junk without linking or setting the gate', async () => {
  installFakeLocalStorage();
  await assert.rejects(() => linkWithCode('nonsense!'));
  assert.equal(isLinked(), false);
  assert.equal(isAdoptionPending(), false);
});

test('tokenHash matches the Worker SHA-256 hex shape and is stable', async () => {
  const h = await tokenHash('abc');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await tokenHash('abc'));
  assert.notEqual(h, await tokenHash('abd'));
});

test('linking hard-resets the cursor so a re-link never reuses a stale version', async () => {
  installFakeLocalStorage();
  saveSyncState({ version: 42, tokenHash: 'stale', adoptionPending: false });
  await linkWithCode(bareToken());
  assert.equal(loadSyncState().version, 0);
});

// DA-C2: linking must gate the first sync, or the union is applied and pushed
// before the user is ever offered Merge / Replace / Cancel.
test('linking sets the adoption gate, and only clearAdoptionPending lifts it', async () => {
  installFakeLocalStorage();
  await linkWithCode(bareToken());
  assert.equal(isAdoptionPending(), true, 'a freshly linked device must not sync silently');
  clearAdoptionPending();
  assert.equal(isAdoptionPending(), false);
});

// The JOIN path is the case the gate exists for: a first device bootstrapping
// has no remote data to union, a second device joining does. A gate set only on
// the bootstrap branch passes every other test in this file.
test('joining an existing account with a full link code also raises the gate', async () => {
  installFakeLocalStorage();
  await linkWithCode(composeLinkCode(bareToken(), generateEncKey()));
  assert.equal(isAdoptionPending(), true, 'a device joining an existing account must not sync silently');
});

test('clearAdoptionPending preserves the rest of the cursor', async () => {
  installFakeLocalStorage();
  await linkWithCode(bareToken());
  saveSyncState({ ...loadSyncState(), version: 5 });
  clearAdoptionPending();
  assert.equal(loadSyncState().version, 5);
  assert.equal(loadSyncState().adoptionPending, false);
});

test('resetSyncStateIfDeviceChanged zeroes on a different token and leaves the same one alone', async () => {
  installFakeLocalStorage();
  const token = bareToken();
  await resetSyncStateIfDeviceChanged(token);
  saveSyncState({ ...loadSyncState(), version: 9 });
  await resetSyncStateIfDeviceChanged(token);
  assert.equal(loadSyncState().version, 9, 'same device must not reset');
  await resetSyncStateIfDeviceChanged(bareToken());
  assert.equal(loadSyncState().version, 0, 'different device must reset');
});

test('unlink clears credentials and cursor but NEVER touches local data', async () => {
  installFakeLocalStorage();
  saveItems([{ id: 'a', title: 'keep me', date: '2026-08-02', updatedAt: '2026-08-02T00:00:00.000Z' }]);
  saveFeeds([{ id: 'f', url: 'https://cal.example/a.ics', name: 'n', color: '#111', hidden: false, updatedAt: '2026-08-02T00:00:00.000Z' }]);
  saveTombstones([{ id: 'gone', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }]);
  await linkWithCode(bareToken());
  unlink();
  assert.equal(isLinked(), false);
  assert.equal(loadSyncState().version, 0);
  // All three are local data. A wiped feed is a URL nothing on screen can
  // restore; wiped tombstones resurrect every deleted item on the next sync.
  assert.equal(loadItems().length, 1, 'unlinking must never delete items');
  assert.equal(loadFeeds().length, 1, 'unlinking must never delete feeds');
  assert.equal(loadTombstones().length, 1, 'unlinking must never delete tombstones');
});

test('a corrupt stored link code reads as unlinked rather than throwing on every tick', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.auth', 'not-a-code');
  assert.equal(getLink(), null);
  assert.equal(isLinked(), false);
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test`, expect FAIL (module not found).

- [ ] **Step 3: Implement**

`js/auth.js`:

```js
// auth.js — the link-code lifecycle and the adoption gate.
//
// An 86-character code JOINS the account its key belongs to. A bare
// 43-character token BOOTSTRAPS a new key — correct for the first device,
// wrong for the second, which is why linkui.js warns before doing it.
//
// Linking sets adoptionPending. sync.js refuses to run an ordinary sync while
// it is set, so the union is never applied or pushed before the user has been
// offered Merge / Replace / Cancel (spec 5.7).
//
// Unlinking never deletes local data. Signed-out plaenicke is a complete,
// working, offline app (spec 4.4).

import { parseLinkCode, composeLinkCode, generateEncKey, base64urlToBytes, TOKEN_BYTES } from './crypto.js';
import { loadAuth, saveAuth, clearAuth, loadSyncState, saveSyncState } from './storage.js';

const ZERO = { version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false };

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
    return null; // corrupt code reads as unlinked; linkui surfaces it
  }
}

export function isLinked() { return getLink() !== null; }

export function isAdoptionPending() { return loadSyncState().adoptionPending === true; }

export function clearAdoptionPending() {
  saveSyncState({ ...loadSyncState(), adoptionPending: false });
}

export async function linkWithCode(input) {
  const trimmed = (input || '').trim();
  const bytes = base64urlToBytes(trimmed); // throws on junk BEFORE anything is stored
  let code;
  if (bytes.length === TOKEN_BYTES) {
    code = composeLinkCode(trimmed, generateEncKey());
  } else {
    parseLinkCode(trimmed); // validate before storing
    code = trimmed;
  }
  const { authToken } = parseLinkCode(code);
  // ORDER MATTERS. Write the cursor (with the gate raised) BEFORE the
  // credential. If saveAuth ran first and this threw — a quota failure on the
  // syncState key, or crypto.subtle being unavailable — the device would be
  // left linked with the adoption gate DOWN, which is the one state the gate
  // exists to prevent. With this order a failure leaves a cursor and no
  // credential, which reads as unlinked and is inert.
  const hash = await tokenHash(authToken);
  saveSyncState({ ...ZERO, tokenHash: hash, adoptionPending: true });
  saveAuth(code);
  return getLink();
}

export function unlink() {
  clearAuth();
  saveSyncState({ ...ZERO });
}

export async function resetSyncStateIfDeviceChanged(authToken) {
  const hash = await tokenHash(authToken);
  const state = loadSyncState();
  if (state.tokenHash !== hash) saveSyncState({ ...ZERO, tokenHash: hash, adoptionPending: true });
}
```

- [ ] **Step 4: Add `js/auth.js` to `ASSETS`** (same commit).

- [ ] **Step 5: Run tests** — `npm test`, expect PASS (12 new).

- [ ] **Step 6: Mutation-check the gate**

- **M1:** make `linkWithCode` set `adoptionPending: false` — the gate test must FAIL.
- **M2:** make `loadSyncState` default `adoptionPending` to `false` on a corrupt value — Task 3's fail-closed test must FAIL.

- [ ] **Step 7: Commit**

```bash
git add js/auth.js tests/auth.test.js service-worker.js
git commit -m "feat(sync): link lifecycle, cursor reset, and the adoption gate"
```

---

### Task 5: `sync.js` — pull, merge, apply, push

**Files:** Create `js/sync.js`; Modify `service-worker.js`; Test: `tests/sync.test.js`

**Interfaces:**
- Consumes: `merge`, `dedupeState`, `toWire`, `emptyState`, `SCHEMA_VERSION` (Task 2); `encryptBlob`, `decryptBlob` (Task 1); `getLink`, `resetSyncStateIfDeviceChanged`, `isAdoptionPending`, `clearAdoptionPending` (Task 4); `loadItems`, `loadFeeds`, `loadTombstones`, `loadSyncState`, `saveSyncState` (Task 3).
- Produces from `js/sync.js`:
  - `MAX_ATTEMPTS = 3`
  - `previewRemote(deps) → Promise<{status, version, state}>` — pull only, applies and pushes **nothing**. Used by the linking UI to decide whether to offer the adoption choice.
  - `syncOnce(deps) → Promise<{status, ...}>`; `status` ∈ `'skipped' | 'adoption-required' | 'ok' | 'conflict' | 'unauthorized' | 'undecryptable' | 'offline' | 'error'`.
  - `deps` = `{ fetchImpl, now, apiBase, applyState, adoptChoice }`. `adoptChoice` is `null` for an ordinary sync (**no dedupe**), or `'adopt-merge'` / `'adopt-replace'` — passed only by the linking flow.
  - **`applyState(state, opts)` must return the state it actually wrote.** It re-merges against live storage (Task 7), so what lands may differ from what was handed in; the push must send what landed. `opts.replace === true` tells the owner to write wholesale WITHOUT re-merging — `adopt-replace` means the user explicitly chose to discard local data, and re-merging would union it straight back in and then push it to the account being joined.
- **`sync.js` must not import `saveItems`, `saveFeeds` or `saveFeedCache`.**

- [ ] **Step 1: Write the failing tests**

`tests/sync.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { syncOnce, previewRemote, MAX_ATTEMPTS } from '../js/sync.js';
import { linkWithCode, clearAdoptionPending } from '../js/auth.js';
import { encryptBlob, decryptBlob, generateEncKey, bytesToBase64url } from '../js/crypto.js';
import { SCHEMA_VERSION, toWire } from '../js/merge.js';
import { saveItems, loadSyncState, saveSyncState } from '../js/storage.js';

const NOW = () => new Date('2026-08-02T12:00:00.000Z');
const item = (id, updatedAt) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });
const echo = (s) => s;   // simplest applyState: writes nothing, returns what it got

// A fake Worker holding one row, enforcing the real compare-and-swap rule.
// It records the FULL request, body included — a fake that drops the body
// makes any "the key never goes on the wire" assertion vacuous.
function fakeServer({ version = 0, blob = '' } = {}) {
  const row = { version, blob };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, headers: opts.headers || {}, body: opts.body });
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ ...row }) };
    const body = JSON.parse(opts.body);
    if (body.version !== row.version) {
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', ...row }) };
    }
    row.version += 1;
    row.blob = body.blob;
    return { ok: true, status: 200, json: async () => ({ version: row.version }) };
  };
  return { fetchImpl, row, calls };
}

async function linked() {
  installFakeLocalStorage();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  clearAdoptionPending();   // most tests exercise the steady state
  return link;
}

test('sync.js never imports a storage writer — the single-writer rule, enforced', () => {
  const src = readFileSync(new URL('../js/sync.js', import.meta.url), 'utf8');
  for (const forbidden of ['saveItems', 'saveFeeds', 'saveFeedCache']) {
    assert.ok(!src.includes(forbidden),
      `sync.js references ${forbidden}; a second writer silently reverts pulled records (spec 5.5)`);
  }
});

test('an unlinked device does not sync and does not call the network', async () => {
  installFakeLocalStorage();
  let called = false;
  const res = await syncOnce({ fetchImpl: async () => { called = true; }, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'skipped');
  assert.equal(called, false);
});

// DA-C2
test('a freshly linked device refuses to sync until adoption is resolved', async () => {
  installFakeLocalStorage();
  await linkWithCode(bytesToBase64url(generateEncKey()));
  let called = false;
  const res = await syncOnce({ fetchImpl: async () => { called = true; }, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'adoption-required');
  assert.equal(called, false, 'nothing may be pulled, applied or pushed before the user chooses');
});

test('previewRemote pulls without applying or pushing', async () => {
  const link = await linked();
  const server = fakeServer({ version: 3, blob: await encryptBlob(link.encKey, state({ items: [item('r', '2026-08-01T00:00:00.000Z')] })) });
  let applied = false;
  const res = await previewRemote({ fetchImpl: server.fetchImpl, apiBase: 'https://w.example', applyState: () => { applied = true; } });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.state.items.map(i => i.id), ['r']);
  assert.equal(applied, false);
  assert.equal(server.row.version, 3);
  assert.ok(server.calls.every(c => c.method === 'GET'));
});

test('an empty server accepts the local state as the first push', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'ok');
  assert.equal(server.row.version, 1);
  assert.deepEqual((await decryptBlob(link.encKey, server.row.blob)).items.map(i => i.id), ['a']);
});

// DA-M4: the fake records the body, so this assertion can actually fail.
test('the Bearer token is sent and the encryption key is NEVER on the wire', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.ok(server.calls.some(c => c.method === 'PUT'), 'the test must actually exercise a push');
  assert.ok(server.calls.every(c => c.headers.authorization === `Bearer ${link.authToken}`));
  const wire = JSON.stringify(server.calls);
  assert.ok(!wire.includes(bytesToBase64url(link.encKey)), 'encKey must never be transmitted');
  assert.ok(!wire.includes('t-a'), 'plaintext must never be transmitted');
});

test('remote records are merged and handed to applyState, not written directly', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 3, blob: await encryptBlob(link.encKey, state({ items: [item('remote', '2026-08-01T00:00:00.000Z')] })) });
  let applied = null;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; } });
  assert.equal(res.status, 'ok');
  assert.deepEqual(applied.items.map(i => i.id).sort(), ['local', 'remote']);
});

// DA-C1: the single most important test in this file.
test('an ordinary sync does NOT dedupe items sharing title, date and time', async () => {
  const link = await linked();
  saveItems([{ id: 'l', title: 'Call mom', date: '2026-08-05', time: null, updatedAt: '2026-08-01T00:00:00.000Z' }]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state({
    items: [{ id: 'r', title: 'Call mom', date: '2026-08-05', time: null, updatedAt: '2026-08-01T00:00:00.000Z' }] })) });
  let applied = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; } });
  assert.equal(applied.items.length, 2, 'ordinary sync must never collapse distinct records');
});

test('applyState runs BEFORE the version is advanced', async () => {
  const link = await linked();
  const server = fakeServer({ version: 5, blob: await encryptBlob(link.encKey, state()) });
  let versionAtApply = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { versionAtApply = loadSyncState().version; return s; } });
  assert.equal(versionAtApply, 0);
  assert.ok(loadSyncState().version >= 5);
});

test('a failure inside applyState does not advance the version and does not push', async () => {
  const link = await linked();
  const server = fakeServer({ version: 5, blob: await encryptBlob(link.encKey, state({ items: [item('r', '2026-08-01T00:00:00.000Z')] })) });
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: () => { throw new Error('quota'); } });
  assert.equal(res.status, 'error');
  assert.equal(loadSyncState().version, 0);
  assert.equal(server.row.version, 5);
});

// DA-C4: the retry must re-read local state, not replay a pre-PUT snapshot.
test('a record created DURING the retry window survives', async () => {
  const link = await linked();
  saveItems([item('mine', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z')] })) });
  let raced = false;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT' && !raced) {
      raced = true;
      // The user adds an item while our first PUT is in flight...
      saveItems([...JSON.parse(localStorage.getItem('plaenicke.items')), item('during', '2026-08-02T00:00:00.000Z')]);
      // ...and another device lands a write first, forcing our retry.
      server.row.version += 1;
      server.row.blob = await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z'), item('third', '2026-08-01T00:00:00.000Z')] }));
    }
    return server.fetchImpl(url, opts);
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'ok');
  const final = await decryptBlob(link.encKey, server.row.blob);
  assert.deepEqual(final.items.map(i => i.id).sort(), ['during', 'mine', 'theirs', 'third'],
    'an item added during the retry window must not be destroyed');
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
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'conflict');
  assert.equal(puts, MAX_ATTEMPTS);
});

test('an undecryptable blob halts and applies NOTHING', async () => {
  await linked();
  const server = fakeServer({ version: 2, blob: await encryptBlob(generateEncKey(), state({ items: [item('x', '2026-08-01T00:00:00.000Z')] })) });
  let applied = false;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => { applied = true; } });
  assert.equal(res.status, 'undecryptable');
  assert.equal(applied, false, 'partially applying an unreadable blob would propagate phantom deletions');
  assert.equal(server.row.version, 2);
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
  const res = await syncOnce({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'unauthorized');
  assert.equal(JSON.parse(localStorage.getItem('plaenicke.items')).length, 1);
});

test('a network failure reports offline and records the error without throwing', async () => {
  await linked();
  const res = await syncOnce({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'offline');
  assert.equal(typeof loadSyncState().lastError, 'string');
});

test('syncing when nothing changed does not push', async () => {
  const link = await linked();
  const server = fakeServer({ version: 4, blob: await encryptBlob(link.encKey, toWire(state())) });
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(server.row.version, 4, 'an unchanged state must not burn a version');
  assert.equal(loadSyncState().version, 4);
});

// DA-C3: two devices differing only in per-device fields and array order must
// reach a fixed point, not push at each other forever.
test('a device whose only difference is colour, hidden and array order does not push', async () => {
  const link = await linked();
  const remote = toWire(state({
    feeds: [{ id: 'f1', url: 'https://cal.example/a.ics', name: 'A', updatedAt: '2026-08-01T00:00:00.000Z' },
            { id: 'f2', url: 'https://cal.example/b.ics', name: 'B', updatedAt: '2026-08-01T00:00:00.000Z' }],
  }));
  const server = fakeServer({ version: 9, blob: await encryptBlob(link.encKey, remote) });
  // Local holds the same feeds in the other order with its own colours.
  localStorage.setItem('plaenicke.feeds', JSON.stringify([
    { id: 'f2', url: 'https://cal.example/b.ics', name: 'B', color: '#222', hidden: true, updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'f1', url: 'https://cal.example/a.ics', name: 'A', color: '#111', hidden: false, updatedAt: '2026-08-01T00:00:00.000Z' },
  ]));
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.pushed, false, 'per-device fields and array order must not count as a change');
  assert.equal(server.row.version, 9);
});

test('a successful sync records lastSyncedAt and clears lastError', async () => {
  const link = await linked();
  saveSyncState({ ...loadSyncState(), lastError: 'previous failure' });
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, toWire(state())) });
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(loadSyncState().lastError, null);
  assert.equal(loadSyncState().lastSyncedAt, NOW().toISOString());
});

test('adopt-replace discards local state instead of merging it', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({ items: [item('remote', '2026-08-01T00:00:00.000Z')] })) });
  let applied = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; }, adoptChoice: 'adopt-replace' });
  assert.deepEqual(applied.items.map(i => i.id), ['remote']);
});

test('adopt-merge dedupes, and clears the adoption gate on success', async () => {
  installFakeLocalStorage();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  saveItems([{ id: 'l', title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: '2026-08-01T00:00:00.000Z' }]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({
    items: [{ id: 'r', title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: '2026-08-01T00:00:00.000Z' }] })) });
  let applied = null;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; }, adoptChoice: 'adopt-merge' });
  assert.equal(res.status, 'ok');
  assert.equal(applied.items.length, 1, 'linking must not double every record');
  assert.equal(loadSyncState().adoptionPending, false, 'a completed adoption lifts the gate');
});

test('a failed adoption leaves the gate up so the user is asked again', async () => {
  installFakeLocalStorage();
  await linkWithCode(bytesToBase64url(generateEncKey()));
  const res = await syncOnce({ fetchImpl: async () => { throw new TypeError('offline'); },
    now: NOW, apiBase: 'https://w.example', applyState: echo, adoptChoice: 'adopt-merge' });
  assert.equal(res.status, 'offline');
  assert.equal(loadSyncState().adoptionPending, true);
});

// applyState re-merges against live storage, so what lands may differ from
// what was handed in. The push must send what LANDED.
test('the pushed blob is what applyState returned, not what it was given', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => ({ ...s, items: [...s.items, item('added-by-apply', '2026-08-03T00:00:00.000Z')] }) });
  const pushed = await decryptBlob(link.encKey, server.row.blob);
  assert.ok(pushed.items.some(i => i.id === 'added-by-apply'));
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test`, expect FAIL (module not found).

- [ ] **Step 3: Implement**

`js/sync.js`:

```js
// sync.js — pull, merge, apply, push. All effects injected, matching feeds.js.
//
// THE OWNERSHIP RULE (spec 5.5): this module never writes items or feeds. It
// hands merged state to applyState(), and app.js/feeds.js — which own those
// keys — perform the write and RETURN what they actually wrote. app.js holds
// `let items` at module scope for the page's lifetime and writes the whole
// array back; a second writer here means the next addItems() silently reverts
// every pulled record, deterministically. That is why this file imports no
// save function.

import { merge, dedupeState, toWire, emptyState, SCHEMA_VERSION } from './merge.js';
import { encryptBlob, decryptBlob } from './crypto.js';
import { getLink, resetSyncStateIfDeviceChanged, isAdoptionPending, clearAdoptionPending } from './auth.js';
import { loadItems, loadFeeds, loadTombstones, loadSyncState, saveSyncState } from './storage.js';

export const MAX_ATTEMPTS = 3;

function localState() {
  return { schemaVersion: SCHEMA_VERSION, items: loadItems(), feeds: loadFeeds(), tombstones: loadTombstones() };
}

function record(patch) { saveSyncState({ ...loadSyncState(), ...patch }); }

async function fetchRemote({ fetchImpl, apiBase, link }) {
  const res = await fetchImpl(`${apiBase}/data`, { headers: { authorization: `Bearer ${link.authToken}` } });
  if (res.status === 401) return { unauthorized: true };
  if (!res.ok) return { failed: res.status };
  const { version, blob } = await res.json();
  if (!blob) return { version, state: null };          // empty server — first push
  const state = await decryptBlob(link.encKey, blob);  // throws → caller halts
  if (!state || state.schemaVersion !== SCHEMA_VERSION) throw new Error('Unrecognised schemaVersion');
  return { version, state };
}

// Pull only. Applies nothing and pushes nothing — the linking UI uses this to
// decide whether to offer Merge / Replace / Cancel before any write happens.
export async function previewRemote({ fetchImpl, apiBase }) {
  const link = getLink();
  if (!link) return { status: 'skipped' };
  try {
    const pulled = await fetchRemote({ fetchImpl, apiBase, link });
    if (pulled.unauthorized) return { status: 'unauthorized' };
    if (pulled.failed) return { status: 'error' };
    return { status: 'ok', version: pulled.version, state: pulled.state };
  } catch {
    return { status: 'undecryptable' };
  }
}

export async function syncOnce(deps) {
  const { fetchImpl, now, apiBase, applyState, adoptChoice = null } = deps;
  const link = getLink();
  if (!link) return { status: 'skipped' };
  const isReplace = adoptChoice === 'adopt-replace';

  // A freshly linked device must not pull-merge-push before the user has been
  // offered Merge / Replace / Cancel. Only the linking flow passes adoptChoice
  // (spec 5.7 — never union silently).
  if (isAdoptionPending() && !adoptChoice) return { status: 'adoption-required' };

  await resetSyncStateIfDeviceChanged(link.authToken);
  if (isAdoptionPending() && !adoptChoice) return { status: 'adoption-required' };

  let pulled;
  try {
    pulled = await fetchRemote({ fetchImpl, apiBase, link });
  } catch (err) {
    // Undecryptable or unparseable. Apply NOTHING: a record silently dropped
    // by a deserializer looks like a local deletion and would propagate a
    // tombstone to every device (spec 6.6).
    record({ lastError: err.name || 'DecryptError' });
    return { status: 'undecryptable' };
  }
  if (pulled.unauthorized) { record({ lastError: 'unauthorized' }); return { status: 'unauthorized' }; }
  if (pulled.failed) { record({ lastError: `http_${pulled.failed}` }); return { status: 'error' }; }

  let version = pulled.version;
  let remote = pulled.state || emptyState();
  let merged;
  try {
    merged = isReplace ? remote : merge(localState(), remote, now());
    // Dedupe runs ONLY here, on an explicit adoption. On an ordinary sync it
    // would collapse any two records sharing a title, date and time — silent,
    // permanent, cross-device deletion.
    if (adoptChoice === 'adopt-merge') merged = dedupeState(merged, now());

    // Apply BEFORE advancing the cursor, and push what applyState actually
    // wrote: it re-merges against live storage, so the two can differ.
    // On adopt-replace the owner must NOT re-merge — the user chose to discard
    // local data, and re-merging unions it back in and then pushes it.
    merged = applyState(merged, { replace: isReplace }) || merged;
  } catch (err) {
    record({ lastError: err.name || 'ApplyError' });
    return { status: 'error' };
  }

  if (JSON.stringify(toWire(merged)) === JSON.stringify(toWire(remote))) {
    record({ version, lastSyncedAt: now().toISOString(), lastError: null });
    if (adoptChoice) clearAdoptionPending();
    return { status: 'ok', pushed: false };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}/data`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${link.authToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version, blob: await encryptBlob(link.encKey, toWire(merged)) }),
      });
    } catch {
      record({ lastError: 'offline' });
      return { status: 'offline' };
    }
    if (res.status === 401) { record({ lastError: 'unauthorized' }); return { status: 'unauthorized' }; }
    if (res.ok) {
      const body = await res.json();
      record({ version: body.version, lastSyncedAt: now().toISOString(), lastError: null });
      if (adoptChoice) clearAdoptionPending();
      return { status: 'ok', pushed: true };
    }
    if (res.status !== 409) { record({ lastError: `http_${res.status}` }); return { status: 'error' }; }

    // Someone wrote first. Re-merge against LIVE local state, not the snapshot
    // from before the PUT: the round trip is long enough for the user to have
    // added or deleted, and replaying the snapshot would destroy that — for a
    // feed, destroying a URL nothing on screen can restore.
    let conflict;
    try {
      conflict = await res.json();
    } catch {
      record({ lastError: 'offline' });
      return { status: 'offline' };
    }
    version = conflict.version;
    try {
      remote = conflict.blob ? await decryptBlob(link.encKey, conflict.blob) : emptyState();
    } catch (err) {
      record({ lastError: err.name || 'DecryptError' });
      return { status: 'undecryptable' };
    }
    try {
      // Replace still means replace after a conflict: adopt the NEW server
      // state, do not quietly convert the user's choice into a merge.
      merged = isReplace ? remote : merge(localState(), remote, now());
      merged = applyState(merged, { replace: isReplace }) || merged;
    } catch (err) {
      // A local apply failure is NOT 'undecryptable' — the remote data was
      // read fine. Same condition, same label as the main path.
      record({ lastError: err.name || 'ApplyError' });
      return { status: 'error' };
    }
  }

  // Bounded, because the Worker's CAS check fails closed: an unexpected
  // meta.changes shape from D1 makes every PUT 409 forever.
  record({ lastError: 'version_conflict' });
  return { status: 'conflict' };
}
```

- [ ] **Step 4: Add `js/sync.js` to `ASSETS`** (same commit).

- [ ] **Step 5: Run tests** — `npm test`, expect PASS (24 new).

- [ ] **Step 6: Mutation-check the orchestration**

- **M1:** advance the cursor before `applyState`.
- **M2:** `for` → `while (true)` in the retry loop.
- **M3:** on `undecryptable`, call `applyState(emptyState())` instead of returning.
- **M4:** default `adoptChoice` to `'adopt-merge'` (the original C1 defect).
- **M5:** delete the `isAdoptionPending()` guard (the original C2 defect).
- **M6:** compare raw `JSON.stringify(merged)` instead of `toWire` (the original C3 defect).
- **M7:** in the retry, `merge(merged, remote, ...)` instead of `merge(localState(), ...)` (the original C4 defect).

Every one must fail at least one test. Add a test for any that survives.

- [ ] **Step 7: Commit**

```bash
git add js/sync.js tests/sync.test.js service-worker.js
git commit -m "feat(sync): pull/merge/apply/push with adoption gate and bounded CAS retry"
```

---

### Task 6: `feeds.js` — `applyRemoteFeeds()`; `settings.js` — stop the second writer

Two separate defects, one task because both are about who is allowed to write `plaenicke.feeds`.

**Files:** Modify `js/feeds.js`, `js/settings.js`; Test: `tests/feeds.test.js`, `tests/settings.test.js` (append)

**Interfaces:**
- Produces: `applyRemoteFeeds(mergedFeeds) → { added: string[], removed: string[] }` from `js/feeds.js`. The `added` ids let `app.js` fetch newly pulled calendars.

Read `js/feeds.js` first — it owns feed-cache lifecycle and declares `removeFeed(id)` the only sanctioned deletion path.

`applyRemoteFeeds` must:
1. Delete local feeds absent from `mergedFeeds` **via `removeFeed()`**, so `feedCache[id]` is cleaned. A raw `saveFeeds()` orphans the entry forever — never read, still iterated and re-serialised by `pruneForQuota`, a permanent quota leak.
2. Replace `color: null` with this device's next colour and set `hidden: false`. **A `null` colour reaching `saveFeeds` is silently dropped by `deserializeFeeds` on the next load** (`js/storage.js:71-77`), destroying the subscription.
3. Preserve existing `color`/`hidden` for known feeds.
4. Return the added and removed ids.

**The `settings.js` fix (DA-M2).** `js/settings.js:114` does `let feeds = loadFeeds()` when the panel opens and writes that array back at `:209`, `:233` and `:337`. Task 8 mounts the linking UI **inside that panel**, so the panel is guaranteed open across a newly linked device's first sync — one tap on Hide afterwards writes the pre-sync array back over everything sync pulled. Fix: re-read `loadFeeds()` immediately before each of those three writes and re-apply the single field being changed, rather than persisting a stale snapshot.

- [ ] **Step 1: Write the failing tests**

Read `tests/feeds.test.js` and `tests/settings.test.js` and follow their existing setup exactly. Write these assertions in full:

- `applyRemoteFeeds` gives a first-seen feed (`color: null`) a **string** colour and `hidden === false`, and the result survives a `saveFeeds`→`loadFeeds` round trip.
- `applyRemoteFeeds` preserves local `color`/`hidden` while accepting a changed `name`.
- `applyRemoteFeeds` removes a dropped feed **and its cache entry** — seed `feedCache[id]`, apply a list without it, assert `loadFeedCache()` no longer contains the id.
- `applyRemoteFeeds` returns the added and removed ids.
- **settings:** with the panel open, toggling `hidden` on one feed does not discard a feed that arrived in storage after the panel opened.

- [ ] **Step 2: Run to verify they fail** — `npm test`.

- [ ] **Step 3: Implement** in `js/feeds.js` and `js/settings.js`, following each file's existing structure and comment style. Do not restructure anything else.

- [ ] **Step 4: Run tests** — `npm test`, expect PASS.

- [ ] **Step 5: Mutation-check**

- **M1:** replace the `removeFeed()` call with `saveFeeds(kept)` — the orphaned-cache test must FAIL.
- **M2:** leave `color` as `null` — the round-trip test must FAIL.
- **M3:** revert `settings.js` to writing its stale snapshot — the panel test must FAIL.

- [ ] **Step 6: Commit**

```bash
git add js/feeds.js js/settings.js tests/feeds.test.js tests/settings.test.js
git commit -m "feat(sync): applyRemoteFeeds with cache-safe deletion; settings re-reads before writing"
```

---

### Task 7: `app.js` — apply callback, storage listener, sync triggers

**Files:** Modify `js/app.js`; Test: `tests/apply.test.js` (create)

**Interfaces:**
- Consumes: `syncOnce` (Task 5); `applyRemoteFeeds` (Task 6); `isLinked`, `isAdoptionPending` (Task 4); `merge`, `SCHEMA_VERSION` (Task 2); `renderSyncStatus` (Task 8 — **import it; do not call an undefined function**); `WORKER_URL` from `js/config.js` (verified: that is the exported name, no trailing slash).
- Produces: `applySyncedState(state) → state` exported from `js/app.js` so it can be tested without a DOM; `scheduleSync()`; a `storage` listener; `visibilitychange` and `online` handlers.

**Explicit import edits** — `js/app.js`'s current import block does not include any of these. Add:

```js
import { syncOnce } from './sync.js';
import { isLinked, isAdoptionPending } from './auth.js';
import { merge, SCHEMA_VERSION } from './merge.js';
import { applyRemoteFeeds } from './feeds.js';        // extend the existing feeds.js import
import { renderSyncStatus } from './linkui.js';
import { WORKER_URL } from './config.js';             // extend the existing config import
import { loadTombstones, saveTombstones } from './storage.js';  // extend the existing storage import
```

- [ ] **Step 1: Write the failing test**

`tests/apply.test.js` — this is the first test in the suite that exercises the app-wiring layer, which previously shipped entirely unexecuted:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { SCHEMA_VERSION } from '../js/merge.js';
import { saveItems, loadItems, saveTombstones } from '../js/storage.js';

const item = (id, updatedAt) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });

// applySyncedState must re-merge against live storage. Between the merge that
// produced `state` and this call there may have been a full PUT round trip.
test('applySyncedState keeps a record written after the state was computed', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  saveItems([item('a', '2026-08-01T00:00:00.000Z'), item('added-late', '2026-08-03T00:00:00.000Z')]);
  const written = applySyncedState(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }));
  assert.ok(written.items.some(i => i.id === 'added-late'), 'a concurrent add must not be destroyed');
  assert.ok(loadItems().some(i => i.id === 'added-late'));
});

test('applySyncedState honours a tombstone written after the state was computed', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  saveTombstones([{ id: 'a', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }]);
  const written = applySyncedState(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }));
  assert.deepEqual(written.items, [], 'a concurrent delete must not be undone');
});

test('applySyncedState returns what it wrote', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const written = applySyncedState(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }));
  assert.deepEqual(written.items.map(i => i.id), loadItems().map(i => i.id));
});
```

`js/app.js` reaches for `document` at module scope, so this test needs a minimal DOM stub installed **before** the dynamic `import`. Add whatever `globalThis.document` / `globalThis.window` shims the import requires — a `getElementById` returning a stub object with `textContent`, `value`, `addEventListener`, `appendChild`, and `classList` is normally enough. If `app.js` proves genuinely un-importable under Node without restructuring, **stop and report DONE_WITH_CONCERNS** rather than deleting the test: the wiring layer being untestable is itself the finding.

- [ ] **Step 2: Run to verify it fails** — `npm test`.

- [ ] **Step 3: Implement in `js/app.js`**

```js
// Sync applies through the owners of each key, never through storage directly.
// app.js owns `items`; feeds.js owns feeds. See spec 5.5.
//
// It re-merges against LIVE storage first: between the merge that produced
// `state` and this call there may have been a full PUT round trip (a CAS
// retry), during which the user may have added or deleted. Writing `state`
// wholesale would destroy those edits — and for a feed, destroy a URL that is
// never rendered anywhere and so cannot be re-entered.
export function applySyncedState(state, opts = {}) {
  // opts.replace is set only by the linking flow's "Replace this device".
  // The user explicitly chose to discard local data, so re-merging would union
  // it straight back in — and sync would then push it to the account being
  // joined. Replace is a LOCAL discard: nothing is tombstoned, so the other
  // devices keep their own copies.
  const live = {
    schemaVersion: SCHEMA_VERSION,
    items: loadItems(), feeds: loadFeeds(), tombstones: loadTombstones(),
  };
  const written = opts.replace ? state : merge(live, state, new Date());
  items = written.items;
  saveItems(items);
  applyRemoteFeeds(written.feeds);
  saveTombstones(written.tombstones);
  feeds = loadFeeds();
  feedCache = loadFeedCache();
  render();
  return written;
}

let syncInFlight = false;
let syncPending = false;
let syncTimer = null;

async function runSync() {
  if (!isLinked() || isAdoptionPending()) return;
  if (syncInFlight) { syncPending = true; return; }
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
    // A trigger that arrived mid-sync would otherwise wait for an unrelated one.
    if (syncPending) { syncPending = false; scheduleSync(); }
  }
}

// Debounced so one smart-add batch is one push, not one per item.
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 2000);
}

// Another tab wrote. Reload our module-scope snapshot rather than letting the
// next addItems() write a stale array back over it. This event does not fire
// in the tab that performed the write, so no echo guard is needed. Narrowed to
// the three data keys — plaenicke.syncState is written on every sync tick and
// would otherwise force a full re-render in every other tab.
const CROSS_TAB_KEYS = ['plaenicke.items', 'plaenicke.feeds', 'plaenicke.syncTombstones'];
window.addEventListener('storage', (e) => {
  if (!CROSS_TAB_KEYS.includes(e.key)) return;
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

Call `scheduleSync()` at the end of `addItems` and `deleteItem`.

**Newly pulled feeds must be fetched (DA-M5).** `app.js`'s background `syncStale` runs once at module scope with the feed list from load time, so a freshly linked device otherwise shows the right subscriptions with **zero events** until a full page reload. After `applyRemoteFeeds` reports `added` ids, run those through the existing quota-aware `syncStale(feeds, feedCache, { fetchImpl: fetch })` path and re-render — reuse the existing call's error handling; do not write a second fetch path.

- [ ] **Step 4: Run the suite** — `npm test`, expect PASS with no regressions.

- [ ] **Step 5: Mutation-check**

- **M1:** make `applySyncedState` write `state` directly instead of re-merging — both concurrency tests must FAIL.
- **M2:** delete the `isAdoptionPending()` guard in `runSync`.
- **M3:** widen the storage listener back to `startsWith('plaenicke.')` and confirm you can articulate what it now over-fires on.

- [ ] **Step 6: Commit**

```bash
git add js/app.js tests/apply.test.js
git commit -m "feat(sync): apply callback re-merging against live storage, triggers, cross-tab refresh"
```

---

### Task 8: `linkui.js` — the linking UI

**Files:** Create `js/linkui.js`; Modify `js/settings.js`, `service-worker.js`; Test: `tests/linkui.test.js`

**Interfaces:**
- Consumes: `isLinked`, `getLink`, `linkWithCode`, `unlink`, `isAdoptionPending`, `clearAdoptionPending` (Task 4); `composeForNewDevice` (Task 1); `previewRemote`, `syncOnce` (Task 5); `loadSyncState` (Task 3).
- Produces from `js/linkui.js`:
  - `describeSyncStatus(syncState, now: Date) → string` — **must distinguish "linked, waiting for you to choose" from "never synced".** The adoption gate means a device that links while offline sits at `adoptionPending: true` and syncs nothing until the user completes the dialog. The failure mode moved from "silently wrong" to "silently does nothing", and this string is the only thing standing between the user and an app they believe is syncing but is not.
  - `classifyPastedCode(input) → 'linkcode' | 'token' | 'invalid'`
  - `chooseAdoption(localState, remoteState) → 'none' | 'auto' | 'ask'` — `'none'` when the server is empty, `'auto'` when local is empty, `'ask'` when both hold data
  - `renderSyncStatus()` — **imported by `app.js`; it must exist and be safe to call when the host element is absent**
  - `initLinkUI({ host, onLinked, onUnlinked })`

The UI must offer:
1. **Unlinked:** a paste field. On a bare token, warn that this creates a **new** account and that joining an existing one needs an 86-character code from an already-linked device.
2. **Adoption:** after linking, call `previewRemote`. Per `chooseAdoption`: `'none'`/`'auto'` → run `syncOnce({adoptChoice: 'adopt-merge'})` directly; `'ask'` → present **Merge** (default), **Replace this device**, **Cancel**. Cancel leaves `adoptionPending` set and syncs nothing.
3. **Linked:** `describeSyncStatus` output, a failure banner when `lastError` is set, and **Unlink** (noting local data is kept).
4. **Link another device:** paste a fresh token from `POST /admin/device`, get back `composeForNewDevice(token, getLink())`. This is the only way a second device obtains `encKey`.

Never render the link code except in the field the user copies from, and never log it.

- [ ] **Step 1: Write the failing tests for the pure helpers**

`tests/linkui.test.js` must cover: `describeSyncStatus` for never-synced, just-synced, minutes, hours, with `lastError` set, and — distinctly from all of those — with `adoptionPending: true`, asserting the string mentions a pending choice and does NOT read as "never synced"; `classifyPastedCode` for an 86-char code, a 43-char token, whitespace padding, and junk; `chooseAdoption` for all three outcomes including empty-local-and-empty-remote; and `renderSyncStatus()` not throwing when the host element is absent.

- [ ] **Step 2: Run to verify they fail** — `npm test`.

- [ ] **Step 3: Implement `js/linkui.js`, mount it from `js/settings.js`, add it to `ASSETS`.**

- [ ] **Step 4: Run tests** — `npm test`, expect PASS.

- [ ] **Step 5: Commit**

```bash
git add js/linkui.js js/settings.js tests/linkui.test.js service-worker.js
git commit -m "feat(sync): linking UI with an explicit, pre-write adoption choice"
```

---

### Task 9: Service-worker guard and the convergence simulation

**Files:** Modify `service-worker.js`; Test: `tests/serviceworker.test.js`, `tests/convergence.test.js`

- [ ] **Step 1: Write the failing service-worker test**

`tests/serviceworker.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('every js/ module is precached — a missing one white-screens a cold offline start', () => {
  const sw = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
  for (const f of readdirSync(new URL('../js', import.meta.url))) {
    if (f.endsWith('.js')) assert.ok(sw.includes(`js/${f}`), `service-worker ASSETS is missing js/${f}`);
  }
});

test('the cache name was bumped past the previous release', () => {
  const sw = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
  assert.ok(!sw.includes("'plaenicke-v5-1'"), 'CACHE must be bumped so the new modules are fetched');
});
```

- [ ] **Step 2: Run** — `npm test`. If it fails, a module was missed in an earlier task's commit; add it now.

- [ ] **Step 3: Write the convergence simulation**

`tests/convergence.test.js`. **This must simulate the real replicated loop**, not merely assert `merge(a,b) ≡ merge(b,a)` — commutativity of one merge is not convergence, and cannot see a dedupe-on-sync bug, a non-canonical wire form, or a stale-snapshot retry.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, toWire, emptyState, SCHEMA_VERSION } from '../js/merge.js';

// Two devices, a shared compare-and-swap row, randomised local operations.
// Each round: a device pulls, merges, applies locally, and pushes if its wire
// form differs. Assert both devices converge AND that the protocol reaches a
// fixed point — a version that stops climbing once operations stop.
test('two devices converge and stop pushing', () => {
  let seed = 987654321;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

  for (let trial = 0; trial < 100; trial += 1) {
    const server = { version: 0, wire: emptyState() };
    const devices = [emptyState(), emptyState()];
    const colours = ['#111', '#222'];

    const sync = (d) => {
      const remote = server.wire;
      const merged = merge(devices[d], remote, new Date('2026-09-01T00:00:00.000Z'));
      // Give each device its own per-device fields, as feeds.js would.
      devices[d] = { ...merged, feeds: merged.feeds.map(f => ({ ...f, color: colours[d], hidden: d === 1 })) };
      const wire = toWire(devices[d]);
      if (JSON.stringify(wire) !== JSON.stringify(toWire(remote))) {
        server.version += 1;
        server.wire = wire;
        return true;
      }
      return false;
    };

    for (let step = 0; step < 10; step += 1) {
      const d = rnd(2);
      const at = new Date(Date.UTC(2026, 7, 1 + rnd(20), rnd(24))).toISOString();
      const id = `r${rnd(4)}`;
      const op = rnd(3);
      if (op === 0) {
        devices[d] = { ...devices[d], items: [...devices[d].items.filter(i => i.id !== id), { id, title: 'shared title', date: '2026-08-05', time: null, updatedAt: at }] };
      } else if (op === 1) {
        devices[d] = { ...devices[d], tombstones: [...devices[d].tombstones.filter(t => !(t.id === id && t.kind === 'item')), { id, kind: 'item', deletedAt: at }] };
      } else {
        devices[d] = { ...devices[d], feeds: [...devices[d].feeds.filter(f => f.id !== id), { id, url: `https://cal.example/${id}.ics`, name: id, color: colours[d], hidden: false, updatedAt: at }] };
      }
      sync(d);
    }

    // Quiesce: no more local operations, just sync until nobody pushes.
    let rounds = 0;
    while (rounds < 20 && (sync(0) || sync(1))) rounds += 1;

    assert.ok(rounds < 20, `trial ${trial}: never reached a fixed point — devices push at each other forever`);
    assert.equal(JSON.stringify(toWire(devices[0])), JSON.stringify(toWire(devices[1])),
      `trial ${trial}: devices diverged`);
    // Every item carries the SAME title, so a dedupe leaking into the sync
    // path would collapse them all and this count would collapse with it.
    assert.equal(toWire(devices[0]).items.length, toWire(server.wire).items.length);
  }
});
```

- [ ] **Step 4: Run the full suite** — `npm test`. Also `cd worker && npm test` to confirm 100 still pass and nothing here touched the Worker.

- [ ] **Step 5: Commit**

```bash
git add service-worker.js tests/serviceworker.test.js tests/convergence.test.js
git commit -m "test(sync): precache guard and two-device convergence simulation"
```

---

## Self-Review (completed at plan time, after adversarial review)

**Spec coverage.** § 5.4 merge → Task 2. § 5.5 single-writer → Tasks 5, 6, 7 (and its real weak point, `settings.js`, in Task 6). § 5.6 tombstones → Task 2. § 5.7 adoption → Tasks 2, 4 (gate), 5 (`previewRemote`, `adoptChoice`), 8 (the choice UI). § 6.2 encryption → Task 1. § 6.3 per-device fields and `removeFeed` routing → Tasks 2, 6. § 6.6 refuse an unparseable blob → Task 5. § 7 apply-before-advance, surfaced failures, never clear local data → Tasks 5, 7, 8. § 8 convergence → Task 9. § 4.3 precache → every task that creates a module.

**Out of scope, per the owner's split:** authenticating smart-add, the `usage` quota table, and rate limiting (§§ 6.1, 6.5) are Plan 4. The custom domain (§ 13) is excluded by the owner.

**Placeholder scan.** Tasks 6 and 8 name assertions rather than giving literal test code, because both depend on `feeds.js`/`settings.js` setup the implementer must read first. Every assertion is named specifically enough to fail correctly. All other tasks carry literal, runnable code.

**Type consistency.** `state` is `{schemaVersion, items, feeds, tombstones}` throughout. `applyState(state) → state` in Task 5 matches `applySyncedState(state) → state` in Task 7. `adoptChoice` is `null | 'adopt-merge' | 'adopt-replace'` in Tasks 5 and 8. `applyRemoteFeeds` returns `{added, removed}` in Task 6 and is consumed in Task 7. `renderSyncStatus` is exported by Task 8 and imported by Task 7.

**What the adversarial review changed.** Four Criticals: dedupe ran on every sync (C1); the adoption choice was offered after the union had already been pushed (C2); the protocol never reached a fixed point (C3); the CAS retry replayed a pre-PUT snapshot and could destroy an unrecoverable feed URL (C4). Five Majors: `renderSyncStatus` was undefined and the whole wiring layer untested (M1); the single-writer rule was enforced on the wrong file (M2); `localStorage` does not exist in Node and the new test files had no stub (M3); four tests passed under broken implementations (M4); a commit boundary white-screened the app and pulled feeds never fetched (M5).

**Known risk.** Nothing here is verified against real D1 or a real browser. The Worker's CAS check fails closed, so an unexpected `meta.changes` shape makes every `PUT` 409 permanently — which is why `MAX_ATTEMPTS` is bounded and the failure surfaces rather than spinning.
