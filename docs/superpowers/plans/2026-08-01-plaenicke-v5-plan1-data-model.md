# plaenicke V5 — Plan 1 of 3: Client Data Model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give records the identity and edit-timestamp fields that sync requires, and start recording deletions — all client-side, with no server involvement, per spec §§ 5.1 and 5.6.

**Architecture:** Three additive changes to existing pure modules: collision-proof IDs via `crypto.randomUUID()`, an `updatedAt` field on items and feeds with backfill for pre-existing records, and a separate tombstone key that survives the deserializers. The app behaves identically to today throughout — nothing here is user-visible.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-01-plaenicke-v5-accounts-sync-design.md`

## Global Constraints

- **`js/storage.js` is the only file that touches `localStorage`** (existing invariant, stated at `storage.js:1`; `theme.js` is the one documented historical exception).
- **`feeds.js` is the sole owner of feed-cache lifecycle**, and `removeFeed(id)` is the only sanctioned feed-deletion path (`feeds.js:6-10`, `:484-487`).
- **Feed URLs are secrets** — never render `feed.url` in the DOM, never log it (`settings.js:8-11`).
- **No new dependencies.** No build step.
- Tombstone retention: **90 days**.
- Feed `updatedAt` backfill value: **`'1970-01-01T00:00:00.000Z'`** — so any genuine post-link edit always wins.
- Item `updatedAt` backfill value: the record's existing **`createdAt`**.

## File Structure

```
js/uid.js           — NEW: single shared ID generator
js/items.js         — MODIFY: makeItem() gains updatedAt
js/storage.js       — MODIFY: deserializer backfill, saveItems quota, tombstone key
js/feeds.js         — MODIFY: removeFeed writes a tombstone
js/app.js           — MODIFY: use shared uid; deleteItem writes a tombstone
js/settings.js      — MODIFY: use shared uid; stamp updatedAt on feed creation
service-worker.js   — MODIFY: precache js/uid.js, bump CACHE
tests/uid.test.js       — NEW
tests/items.test.js     — MODIFY (existing deepEqual assertions must include updatedAt)
tests/storage.test.js   — MODIFY + extend
tests/feeds.test.js     — MODIFY (removeFeed tombstone)
```

---

### Task 1: Shared `uid()` using `crypto.randomUUID()`

Replaces the two duplicated generators at `app.js:98` and `settings.js:37`, both of which are `Date.now() + Math.random()` and can collide across devices (spec § 4.3).

**Files:**
- Create: `js/uid.js`
- Modify: `js/app.js:98`, `js/settings.js:37`
- Test: `tests/uid.test.js`

**Interfaces:**
- Produces: `uid(prefix?: string): string` — returns `crypto.randomUUID()` when no prefix, `` `${prefix}-${crypto.randomUUID()}` `` with one. Feeds pass `'feed'` to preserve the existing readable-ID convention; items pass nothing.

- [ ] **Step 1: Write the failing test**

`tests/uid.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../js/uid.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('uid returns a bare uuid with no prefix', () => {
  assert.match(uid(), UUID_RE);
});

test('uid prefixes when asked', () => {
  const id = uid('feed');
  assert.ok(id.startsWith('feed-'));
  assert.match(id.slice('feed-'.length), UUID_RE);
});

test('uid does not collide across many calls', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) seen.add(uid());
  assert.equal(seen.size, 5000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/uid.test.js`
Expected: FAIL — cannot resolve `../js/uid.js`

- [ ] **Step 3: Implement**

`js/uid.js`:

```js
// uid.js — the single ID generator for records that sync.
//
// Uses crypto.randomUUID() rather than timestamp+random: two devices creating
// a record offline in the same millisecond could otherwise collide, and a
// collision means one device's record silently overwrites the other's.
// Requires a secure context in browsers (HTTPS) — GitHub Pages qualifies.

export function uid(prefix) {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/uid.test.js` — Expected: PASS (3 tests)

- [ ] **Step 5: Replace both duplicates**

In `js/app.js`, delete the local `uid()` at line 98 and add to the import block at the top of the file:

```js
import { uid } from './uid.js';
```

In `js/settings.js`, delete the local `uid()` at line 37 and add:

```js
import { uid } from './uid.js';
```

Then change the feed-creation call site (`settings.js:318`) from `uid()` to `uid('feed')` so feed IDs keep their readable prefix.

- [ ] **Step 6: Verify no duplicate generators remain**

Run: `grep -rn "Math.random" js/`
Expected: no matches in `app.js` or `settings.js`.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`

```bash
git add -A && git commit -m "feat: single crypto.randomUUID-based uid, replacing two duplicated generators"
```

---

### Task 2: `updatedAt` on items

**Files:**
- Modify: `js/items.js:5-28`, `js/storage.js:27-31`
- Test: `tests/items.test.js`, `tests/storage.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `makeItem(fields, meta)` where `meta` is `{ id, createdAt, updatedAt? }`. When `meta.updatedAt` is omitted it defaults to `meta.createdAt`. The returned object gains `updatedAt: string`.
- Produces: `deserializeItems(json)` backfills `updatedAt` from `createdAt` for any stored record lacking it, and preserves it when present.

- [ ] **Step 1: Update the existing `makeItem` assertions and add new tests**

The existing test at `tests/items.test.js:5` uses `assert.deepEqual` on the whole object, so it must gain the new field. Change that first assertion to:

```js
  assert.deepEqual(it, {
    id: 'a', title: 'First draft', date: '2026-05-15', time: null, endTime: null,
    createdAt: '2026-07-18', updatedAt: '2026-07-18',
    type: 'milestone', project: 'Physics paper', subject: 'Physics', category: 'School',
  });
```

Then append to `tests/items.test.js`:

```js
test('makeItem defaults updatedAt to createdAt', () => {
  const it = makeItem({ title: 'x', date: '2026-05-15' }, { id: 'c', createdAt: '2026-07-18' });
  assert.equal(it.updatedAt, '2026-07-18');
});

test('makeItem honours an explicit updatedAt', () => {
  const it = makeItem({ title: 'x', date: '2026-05-15' },
    { id: 'd', createdAt: '2026-07-18', updatedAt: '2026-07-20' });
  assert.equal(it.updatedAt, '2026-07-20');
});
```

Append to `tests/storage.test.js`:

```js
test('deserializeItems backfills updatedAt from createdAt', () => {
  const json = JSON.stringify([{ id: 'a', title: 'Bio', date: '2026-07-02', createdAt: '2026-07-01' }]);
  assert.equal(deserializeItems(json)[0].updatedAt, '2026-07-01');
});

test('deserializeItems preserves an existing updatedAt', () => {
  const json = JSON.stringify([
    { id: 'a', title: 'Bio', date: '2026-07-02', createdAt: '2026-07-01', updatedAt: '2026-07-05' },
  ]);
  assert.equal(deserializeItems(json)[0].updatedAt, '2026-07-05');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/items.test.js tests/storage.test.js`
Expected: FAIL — `updatedAt` is `undefined`.

- [ ] **Step 3: Implement in `js/items.js`**

Change the `return` block of `makeItem` (currently `items.js:17-28`) to include `updatedAt` immediately after `createdAt`:

```js
  return {
    id: meta.id,
    title,
    date: fields.date,
    time,
    endTime,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt || meta.createdAt,
    type: fields.type || 'general',
    project: fields.project || null,
    subject: fields.subject || null,
    category: fields.category || null,
  };
```

- [ ] **Step 4: Implement the backfill in `js/storage.js`**

Replace `deserializeItems`' return statement (`storage.js:27-31`) with:

```js
  return parsed
    .filter(it =>
      it &&
      typeof it.id === 'string' &&
      typeof it.title === 'string' &&
      typeof it.date === 'string')
    // Records written before V5 have no updatedAt. Backfill from createdAt so
    // conflict resolution has an input; see spec 5.1.
    .map(it => (typeof it.updatedAt === 'string'
      ? it
      : { ...it, updatedAt: typeof it.createdAt === 'string' ? it.createdAt : '1970-01-01T00:00:00.000Z' }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/items.test.js tests/storage.test.js` — Expected: PASS

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`

```bash
git add -A && git commit -m "feat: updatedAt on items with backfill from createdAt"
```

---

### Task 3: `updatedAt` on feeds

Per spec § 6.3, `color` and `hidden` are **device-local view preferences and do not sync**, so their mutation paths (`settings.js:208-211`, `:231-235`) are deliberately **not** stamped. Only feed identity (`url`, `name`) syncs.

**Files:**
- Modify: `js/storage.js:57-63`, `js/settings.js:318`
- Test: `tests/storage.test.js`

**Interfaces:**
- Produces: `deserializeFeeds(json)` backfills `updatedAt` to `'1970-01-01T00:00:00.000Z'` when absent.
- Produces: feed records created by `settings.js` are `{ id, url, name, color, hidden, updatedAt }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/storage.test.js`:

```js
const FEED = { id: 'f1', url: 'https://x/c.ics', name: 'X', color: '#111', hidden: false };

test('deserializeFeeds backfills updatedAt to the epoch', () => {
  const out = deserializeFeeds(JSON.stringify([FEED]));
  assert.equal(out[0].updatedAt, '1970-01-01T00:00:00.000Z');
});

test('deserializeFeeds preserves an existing updatedAt', () => {
  const out = deserializeFeeds(JSON.stringify([{ ...FEED, updatedAt: '2026-08-01T00:00:00.000Z' }]));
  assert.equal(out[0].updatedAt, '2026-08-01T00:00:00.000Z');
});

test('deserializeFeeds still rejects records missing required fields', () => {
  assert.deepEqual(deserializeFeeds(JSON.stringify([{ id: 'f', url: 'u' }])), []);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/storage.test.js`
Expected: FAIL — `updatedAt` is `undefined`.

- [ ] **Step 3: Implement the backfill**

Replace `deserializeFeeds`' return statement (`storage.js:57-63`) with:

```js
  return parsed
    .filter(f =>
      f &&
      typeof f.id === 'string' &&
      typeof f.url === 'string' &&
      typeof f.name === 'string' &&
      typeof f.color === 'string' &&
      typeof f.hidden === 'boolean')
    // Pre-V5 feeds have no updatedAt. Backfill to the epoch so any genuine
    // post-link edit always wins; see spec 5.1.
    .map(f => (typeof f.updatedAt === 'string'
      ? f
      : { ...f, updatedAt: '1970-01-01T00:00:00.000Z' }));
```

- [ ] **Step 4: Stamp `updatedAt` at feed creation**

In `js/settings.js:318`, change:

```js
        const feed = { id: uid('feed'), url, name, color, hidden: false };
```

to:

```js
        const feed = {
          id: uid('feed'), url, name, color, hidden: false,
          updatedAt: new Date().toISOString(),
        };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/storage.test.js` — Expected: PASS

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`

```bash
git add -A && git commit -m "feat: updatedAt on feeds; color/hidden stay device-local per spec 6.3"
```

---

### Task 4: Tombstone storage

Deletions must survive, and they cannot live in `plaenicke.items` — a tombstone there has no `title`/`date` and `deserializeItems` would discard it on the next load (spec § 5.6).

**Files:**
- Modify: `js/storage.js`
- Test: `tests/storage.test.js`

**Interfaces:**
- Produces, all exported from `js/storage.js`:
  - `loadTombstones(): Array<{id: string, kind: 'item'|'feed', deletedAt: string}>`
  - `saveTombstones(list): void`
  - `addTombstone(id: string, kind: 'item'|'feed', deletedAt: string): void` — appends; replaces any existing entry for the same `(id, kind)` with the newer `deletedAt`.
  - `pruneTombstones(list, now: Date, maxAgeDays = 90): Array` — pure; drops entries older than `maxAgeDays`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/storage.test.js` (the file already defines `FakeLocalStorage` and installs it — follow the existing setup convention used by the `loadFeeds`/`saveFeeds` tests):

```js
test('tombstones round-trip', () => {
  globalThis.localStorage = new FakeLocalStorage();
  saveTombstones([{ id: 'a', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }]);
  assert.deepEqual(loadTombstones(), [{ id: 'a', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }]);
});

test('loadTombstones returns [] when unset or malformed', () => {
  globalThis.localStorage = new FakeLocalStorage();
  assert.deepEqual(loadTombstones(), []);
  globalThis.localStorage.setItem('plaenicke.syncTombstones', 'not json');
  assert.deepEqual(loadTombstones(), []);
});

test('addTombstone appends and de-duplicates by id+kind keeping the newer', () => {
  globalThis.localStorage = new FakeLocalStorage();
  addTombstone('a', 'item', '2026-08-01T00:00:00.000Z');
  addTombstone('b', 'feed', '2026-08-01T00:00:00.000Z');
  addTombstone('a', 'item', '2026-08-02T00:00:00.000Z');
  const out = loadTombstones();
  assert.equal(out.length, 2);
  assert.equal(out.find(t => t.id === 'a').deletedAt, '2026-08-02T00:00:00.000Z');
});

test('addTombstone treats the same id under a different kind as distinct', () => {
  globalThis.localStorage = new FakeLocalStorage();
  addTombstone('x', 'item', '2026-08-01T00:00:00.000Z');
  addTombstone('x', 'feed', '2026-08-01T00:00:00.000Z');
  assert.equal(loadTombstones().length, 2);
});

test('pruneTombstones drops entries older than the window and keeps the rest', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');
  const list = [
    { id: 'old', kind: 'item', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', kind: 'item', deletedAt: '2026-07-30T00:00:00.000Z' },
  ];
  assert.deepEqual(pruneTombstones(list, now).map(t => t.id), ['new']);
});
```

Add `loadTombstones, saveTombstones, addTombstone, pruneTombstones` to the import block at the top of `tests/storage.test.js`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/storage.test.js`
Expected: FAIL — the functions are not exported.

- [ ] **Step 3: Implement**

Add to `js/storage.js`, after the feeds section and before the feed-cache section:

```js
// --- tombstones ---
// Deletions live here, NOT in plaenicke.items: a tombstone has no title/date,
// so deserializeItems would discard it on the next load and the deletion would
// be lost. Cleared only once a sync has acknowledged them. See spec 5.6.

const TOMBSTONES_KEY = 'plaenicke.syncTombstones';
const TOMBSTONE_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function loadTombstones() {
  const json = localStorage.getItem(TOMBSTONES_KEY);
  if (!json) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(t =>
    t &&
    typeof t.id === 'string' &&
    (t.kind === 'item' || t.kind === 'feed') &&
    typeof t.deletedAt === 'string');
}

export function saveTombstones(list) {
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(list));
}

export function addTombstone(id, kind, deletedAt) {
  const kept = loadTombstones().filter(t => !(t.id === id && t.kind === kind));
  kept.push({ id, kind, deletedAt });
  saveTombstones(kept);
}

export function pruneTombstones(list, now, maxAgeDays = TOMBSTONE_MAX_AGE_DAYS) {
  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  return list.filter(t => Date.parse(t.deletedAt) >= cutoff);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/storage.test.js` — Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add -A && git commit -m "feat: tombstone storage in its own key, surviving the item deserializer"
```

---

### Task 5: Quota handling in `saveItems`

`saveFeedCache` already converts `QuotaExceededError` into a typed `QuotaError` (`storage.js:109-118`) but `saveItems` (`:38-40`) does not — so a pull into a device whose storage is full of feed cache throws a raw browser exception (spec § 7).

**Files:**
- Modify: `js/storage.js:38-40`
- Test: `tests/storage.test.js`

**Interfaces:**
- Produces: `saveItems(items)` throws `QuotaError` (already exported at `storage.js:7`) instead of a raw `QuotaExceededError`.

- [ ] **Step 1: Write the failing test**

Append to `tests/storage.test.js`:

```js
test('saveItems throws QuotaError when storage is full', () => {
  globalThis.localStorage = new FakeLocalStorage();
  globalThis.localStorage.setItem = () => {
    const err = new Error('full');
    err.name = 'QuotaExceededError';
    throw err;
  };
  assert.throws(() => saveItems([ITEM]), QuotaError);
});

test('saveItems rethrows non-quota errors unchanged', () => {
  globalThis.localStorage = new FakeLocalStorage();
  globalThis.localStorage.setItem = () => { throw new Error('boom'); };
  assert.throws(() => saveItems([ITEM]), /boom/);
});
```

Add `saveItems` to the import block at the top of `tests/storage.test.js`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/storage.test.js`
Expected: FAIL — a raw `Error` is thrown, not a `QuotaError`.

- [ ] **Step 3: Implement**

Replace `saveItems` (`storage.js:38-40`) with:

```js
export function saveItems(items) {
  try {
    localStorage.setItem(STORAGE_KEY, serializeItems(items));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      throw new QuotaError('Items exceeded storage quota');
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/storage.test.js` — Expected: PASS

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add -A && git commit -m "feat: saveItems raises typed QuotaError, matching saveFeedCache"
```

---

### Task 6: Record deletions as tombstones

**Files:**
- Modify: `js/feeds.js:488-495`, `js/app.js:164-168`
- Test: `tests/feeds.test.js`

**Interfaces:**
- Consumes: `addTombstone(id, kind, deletedAt)` from Task 4.
- Produces: `removeFeed(id)` writes a `'feed'` tombstone; `deleteItem(id)` in `app.js` writes an `'item'` tombstone. Both keep their existing behavior otherwise.

- [ ] **Step 1: Write the failing test**

Append to `tests/feeds.test.js`, following that file's existing localStorage setup convention:

```js
test('removeFeed records a feed tombstone', () => {
  globalThis.localStorage = new FakeLocalStorage();
  saveFeeds([{ id: 'f1', url: 'https://x/c.ics', name: 'X', color: '#111', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z' }]);

  removeFeed('f1');

  assert.deepEqual(loadFeeds(), []);
  const tombs = loadTombstones();
  assert.equal(tombs.length, 1);
  assert.equal(tombs[0].id, 'f1');
  assert.equal(tombs[0].kind, 'feed');
  assert.ok(Date.parse(tombs[0].deletedAt) > 0);
});
```

Add `loadTombstones` and `loadFeeds`/`saveFeeds` to that file's imports from `../js/storage.js` if not already present.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/feeds.test.js`
Expected: FAIL — `loadTombstones()` returns `[]`.

- [ ] **Step 3: Implement in `js/feeds.js`**

Add `addTombstone` to the existing `storage.js` import block at the top of `feeds.js`, then replace `removeFeed` (`:488-495`) with:

```js
export function removeFeed(id) {
  saveFeeds(loadFeeds().filter((f) => f.id !== id));
  const cache = loadFeedCache();
  if (Object.prototype.hasOwnProperty.call(cache, id)) {
    delete cache[id];
    saveFeedCache(cache);
  }
  // Record the deletion so a later sync can propagate it. Without this, a
  // device that still holds the feed resurrects it on the next pull.
  addTombstone(id, 'feed', new Date().toISOString());
}
```

- [ ] **Step 4: Implement in `js/app.js`**

Add `addTombstone` to the existing `storage.js` import block, then replace `deleteItem` (`:164-168`) with:

```js
function deleteItem(id) {
  items = items.filter((it) => it.id !== id);
  saveItems(items);
  addTombstone(id, 'item', new Date().toISOString());
  render();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/feeds.test.js` — Expected: PASS

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`

```bash
git add -A && git commit -m "feat: record item and feed deletions as tombstones"
```

---

### Task 7: Precache the new module

If `app.js` statically imports a module that is not in the service worker's `ASSETS`, a cold offline start fails the module graph and **white-screens the whole app** — strictly worse than today's graceful degradation (spec § 4.3).

**Files:**
- Modify: `service-worker.js:13-20`
- Test: manual verification

**Interfaces:**
- Consumes: `js/uid.js` from Task 1.

- [ ] **Step 1: Add the module and bump the cache name**

In `service-worker.js`, add `'js/uid.js'` to the `ASSETS` array, and bump the `CACHE` constant from `plaenicke-v4-2` to `plaenicke-v5-1`.

- [ ] **Step 2: Verify every statically imported module is precached**

Run:

```bash
grep -ho "from '\./[a-z-]*\.js'" js/*.js | sed "s|from '\./||;s|'||" | sort -u
```

Cross-check that every filename printed appears in `ASSETS` (prefixed `js/`). Any missing entry is a white-screen risk.

- [ ] **Step 3: Run the full suite and commit**

Run: `npm test`

```bash
git add -A && git commit -m "chore: precache js/uid.js, bump SW cache to plaenicke-v5-1"
```

---

## Self-Review (completed at plan time)

**Spec coverage for Plan 1's scope:** § 4.3 ID collision fix → Task 1. § 5.1 `updatedAt` items → Task 2; feeds → Task 3; the explicit carve-out that `color`/`hidden` are not stamped → Task 3 header. § 5.6 client tombstones → Tasks 4 and 6. § 7 `saveItems` quota → Task 5. § 4.3 service-worker `ASSETS` → Task 7.

**Deferred to later plans, deliberately:** § 5.5 single-writer ownership rule and the `applyRemoteItems`/`applyRemoteFeeds` entry points (no second writer exists until sync does, and they are integration-tested in Plan 3). §§ 4.1, 4.2, 5.2, 5.3, 6 — the Worker, D1, device tokens, and encryption (Plan 2). §§ 5.4, 5.7 merge and adoption (Plan 3). § 13 domain migration (owner task, after sync).

**Placeholder scan:** clean — every step has runnable code and an exact expected outcome.

**Type consistency:** `uid(prefix?)` from Task 1 is used as `uid()` for items and `uid('feed')` in Task 3. `addTombstone(id, kind, deletedAt)` defined in Task 4 is called with exactly that signature in Task 6. `QuotaError` in Task 5 is the existing export at `storage.js:7`, not a new type. The epoch string `'1970-01-01T00:00:00.000Z'` is identical in Tasks 2 and 3 and in Global Constraints.

**Known risk to verify during execution:** `crypto.randomUUID()` is a global in Node 19+; if `node --test` runs on an older Node, Task 1's tests fail at the global rather than at the assertion. Check `node --version` before starting.
