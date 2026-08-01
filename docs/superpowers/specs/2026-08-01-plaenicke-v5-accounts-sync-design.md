# plaenicke V5 — Device Linking & Sync

**Date:** 2026-08-01
**Status:** Revised after adversarial review (devil's advocate + constructive sparring). Pending user approval.
**Owner:** Alexander Jaenicke

> **Revision note.** The first draft of this spec (git history, commit `2fe1659`) specified multi-user accounts with password auth and a per-row sync protocol using monotonic revision cursors. Two independent adversarial reviews rejected it: the protocol depended on a client `updated_at` field that **does not exist in the data model**, and six of seven critical defects lived in machinery that the data scale never justified. This revision cuts roughly three quarters of the surface area. § 12 records what changed and why.

## 1. Goal

Sign in on a second device and see the same items and calendar subscriptions. One person, multiple devices.

Today there is no auth: all state is in `localStorage` per device (`plaenicke.items`, `plaenicke.feeds`, `plaenicke.feedCache`) and the Worker is a stateless proxy. The `APP_PASSPHRASE` secret named in `worker/src/index.js:2` is vestigial — line 49 states "No passphrase (personal use)" and no client code references it.

**Already solved, and out of scope:** external calendars. ICS subscriptions sync by nature — the same published URL added on two devices already shows identical events. The genuinely device-local data is exactly two keys: `plaenicke.items` and the `plaenicke.feeds` URL list.

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Users | **Single owner, multiple devices** | The stated goal needs no second account. Single→multi later is additive (add an owner column); multi→single is never done. Deferred, not foreclosed. |
| Auth | **Device-link code**, no passwords | No email service exists → no password reset → a forgotten password is a permanent lockout. PBKDF2 at a credible iteration count also likely exceeds the Workers free-plan 10 ms CPU budget (§ 11.2). |
| Storage | **Cloudflare D1**, single-row blob | D1 for strong consistency and compare-and-swap; KV has neither. Blob because the whole dataset is tens of KB and CAS is one atomic statement — D1 has no interactive transactions, so read-decide-write across rows cannot be made atomic. |
| Encryption | **Client-side, AES-GCM** | Feed URLs are capability tokens (§ 6.2). Encrypting an opaque blob is trivial; encrypting per-row payloads is impossible when the server must read `id`/`rev`. |
| Merge | **Client-side pure function** | Matches the codebase's existing strength: `js/feeds.js` is pure, effect-injected, table-tested. |
| Conflicts | Per-item last-write-wins, tie → remote | Deterministic; see § 5.4 for what this does and does not protect. |
| Live sync | No (Durable Objects deferred) | Sync-on-open + sync-on-change is indistinguishable for a planner. DO stays available later without redoing the data model. |

**Non-goals:** multi-user accounts; public signup; live/WebSocket sync; syncing `feedCache`; sharing calendars between people; any change to ICS fetching or rendering.

## 3. Cost basis (measured)

Voice input is **free** — `js/voice.js:7` uses the browser Web Speech API; no audio leaves the device. The only paid path is smart-add text → Claude Haiku 4.5 (`worker/src/prompt.js:46`).

Measured payload: system prompt 1,338 chars + JSON schema 783 chars + note ~60 chars ≈ **650 input tokens**; output ≈ **75 tokens**. At $1.00/1M input and $5.00/1M output → **~$0.001 per smart-add**. 100/day ≈ $3/month worst case.

**Prompt caching is unavailable:** Haiku 4.5 needs a ≥4,096-token cacheable prefix; ours is ~650. It silently no-ops rather than erroring. No 10x optimization exists here — accepted.

## 4. Architecture

### 4.1 The link code

A single code carries two independent secrets, concatenated and base64url-encoded:

```
linkCode = base64url( authToken(32 bytes) || encKey(32 bytes) )
```

- **`authToken`** — proves the device may talk to the Worker. Stored server-side **hashed** (SHA-256), one row per device, individually revocable.
- **`encKey`** — the AES-GCM key for the blob. **Never transmitted, never stored server-side.** The server cannot decrypt your data even with full database access.

Minted by the owner via `POST /admin/device` (gated by an `ADMIN_SECRET` Worker secret), then pasted into each device once. Rotating a compromised token is one command; rotating `encKey` requires a re-upload from a device that still holds it.

### 4.2 Worker routes

`worker/src/index.js:34-40` currently treats **every path except `/feed` as smart-add** — there is no 404. A typo'd client path silently spends Anthropic budget. This must be converted to an explicit route table first.

| Route | Auth | Purpose |
|---|---|---|
| `GET /feed` | Origin check (unchanged) | ICS proxy — untouched |
| `POST /smart-add` | Device token | Was `POST /` (public). Now authenticated. |
| `GET /data` | Device token | → `{ version, blob }` |
| `PUT /data` | Device token | `{ version, blob }` → `200 {version}` or `409 {version, blob}` |
| `POST /admin/device` | `ADMIN_SECRET` | Mint a link code |
| `DELETE /admin/device` | `ADMIN_SECRET` | Revoke by token hash |
| *anything else* | — | **404** |

`ALLOWED_ORIGIN` is already duplicated (`index.js:7`, `feed.js:11`); consolidate to one module rather than adding a third copy of a security constant.

### 4.3 Client modules

- **`js/sync.js` (new)** — pull, merge, push, retry. Pure logic, no DOM, effects (`fetchImpl`, `now`) injected — the pattern `js/feeds.js` already establishes.
- **`js/crypto.js` (new)** — AES-GCM encrypt/decrypt of the blob; link-code parsing.
- **`js/auth.js` (new)** — link-code storage and lifecycle.
- **`js/storage.js` (modified)** — remains the only file touching `localStorage`. Adds `plaenicke.syncState` (version, last-synced snapshot), `plaenicke.auth` (link code), `plaenicke.syncTombstones`. Gains quota handling in `saveItems` (§ 7).
- **`js/feeds.js` (modified)** — gains `applyRemoteFeeds()` so sync never writes feeds around its ownership rules (§ 6.3).
- **`js/app.js`, `js/settings.js` (modified)** — single shared `crypto.randomUUID()`-based `uid()` replacing the two duplicated implementations (`app.js:98`, `settings.js:37`); `updatedAt` stamping (§ 5.1); sync-apply callbacks (§ 5.5).
- **`service-worker.js` (modified)** — add the new modules to `ASSETS` and bump `CACHE` past `plaenicke-v4-2`. **If `app.js` statically imports `sync.js` and it isn't precached, a cold offline start fails the module graph and white-screens the app** — strictly worse than today's graceful degradation.

### 4.4 Signed-out behavior

Unchanged: fully local, fully offline, no link code required. Linking **adopts** local data (§ 5.6); it never wipes.

## 5. Data model & protocol

### 5.1 Required client-side change: `updatedAt`

**The first draft's fatal flaw.** Conflict resolution needs a per-record edit timestamp and none exists:

- `js/items.js:17-28` — `makeItem()` returns `createdAt` only.
- `js/settings.js:318` — feed records are `{id, url, name, color, hidden}`, no timestamp.
- `js/storage.js:27-31` and `:57-63` validate exactly those shapes and **silently drop** records that fail.

Required work:
1. Add `updatedAt` to `makeItem()` and to the feed record shape.
2. Stamp it on every mutation of a **synced** field — `addItems` (`app.js:101`), `deleteItem` (`app.js:164`), and feed add/rename. The feed color cycle (`settings.js:208-211`) and hide toggle (`settings.js:231-235`) are the app's highest-frequency writes but are **device-local view preferences and are not synced** (§ 6.3), so they need no stamp.
3. Extend both deserializers to accept and preserve it.
4. **Backfill at adoption:** items → `createdAt`; feeds → a fixed past epoch, so any genuine post-link edit always wins.

### 5.2 D1 schema

```sql
devices (token_hash TEXT PRIMARY KEY, name TEXT, created_at TEXT, last_seen_at TEXT)
data    (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
         blob TEXT NOT NULL, updated_at TEXT NOT NULL)
usage   (date TEXT PRIMARY KEY, count INTEGER NOT NULL)
```

`data` is a single row by construction. **D1's maximum row/value size is 2 MB** (verified); at ~250 bytes per item that is ~8,000 items — many years of use. If it ever approaches the ceiling, shard by year.

### 5.3 Compare-and-swap protocol

```
GET  /data              → { version, blob }
PUT  /data { version, blob }
        → 200 { version: version+1 }        (accepted)
        → 409 { version, blob }             (stale — server's current state returned)
```

The write is one atomic statement, which is the whole point:

```sql
UPDATE data SET blob = ?, version = version + 1, updated_at = ?
 WHERE id = 1 AND version = ?
```

Zero rows changed → 409. **This is why the blob design exists:** D1 has no interactive transactions, so the first draft's read-decide-write across many rows could not be made atomic, and two devices syncing concurrently could silently lose a record permanently.

On 409 the client merges the returned server blob with its local state and retries, bounded (3 attempts, then surface).

### 5.4 Merge

A pure function, `merge(local, remote, lastSynced) → merged`, over `{ items, feeds, tombstones, schemaVersion }`:

- Union by `id`; on collision the higher `updatedAt` wins; **ties go to remote** (deterministic, and makes a re-pushed identical record a no-op — which is what makes retry safe).
- A tombstone beats a record when `deletedAt > updatedAt`.
- Tombstones older than 90 days are pruned during merge.

**What LWW does and does not protect.** Because merging is per item, edits to *different* items on two devices never conflict — that is the common case and it is safe. Only editing *the same* item on both devices while offline loses the older edit.

Worth stating plainly: the app currently has **no edit path at all** — `app.js` only adds (`:101`) and deletes (`:164`), and `items.js` has no update function. So today the lossy case is nearly unreachable. The real constraint being accepted is forward-looking: per-item LWW forecloses future *multi-item* operations (rename a project, bulk delete, edit a recurring series), which would produce partial states across devices with no error.

### 5.5 Single-writer ownership (mandatory)

`js/app.js:51` holds `let items = loadItems()` at module scope for the page's lifetime, and `addItems` (`:103`) and `deleteItem` (`:165`) write the **whole array** back from that snapshot. `settings.js:114` does the same for feeds.

If `sync.js` writes pulled records through `storage.js`, the next `addItems()` overwrites every pulled item with the pre-sync snapshot — **deterministically, not as a race**. The codebase already understands this hazard (`feeds.js:305`, `settings.js:121` serialize feed syncs for exactly this reason), but those locks know nothing about a second writer.

**Rule: `sync.js` never writes `items` or `feeds` directly.** It hands merged state to owners via callbacks, matching the existing `onFeedsChanged` shape (`app.js:95`): `app.js` owns the `items` write and refreshes its module-scope copy; `feeds.js` owns feeds via a new `applyRemoteFeeds()`. The invariant that protects the data is **one writer per key per tab**, not "only `storage.js` touches `localStorage`."

### 5.6 Deletes need client-side tombstones

`app.js:164-168` filters the item out and saves — the record is destroyed, so there is nothing left to push. And a tombstone parked in `plaenicke.items` would be discarded by `deserializeItems` on the next load (no `title`, no `date`).

Tombstones therefore live in **`plaenicke.syncTombstones`** — `{id, kind, deletedAt}[]`, written by `deleteItem` and `removeFeed`, cleared only on a confirmed server ack. Without this: delete on phone → reload before sync → deletion is lost everywhere; or delete succeeds locally, push fails, next pull resurrects it on the device that deleted it.

### 5.7 Linking a device (adoption)

1. Paste the link code. Client fetches `GET /data`.
2. **If the server blob is empty** → local data uploads as-is. Done.
3. **If it is not empty** → the device already has data *and* the account does. Present an explicit choice rather than silently unioning:
   - **Merge** (default) — union with dedupe (below)
   - **Replace this device** — discard local, pull server
   - **Cancel**
4. **Dedupe on merge:** feeds by normalized URL; items by `(title, date, time)`.

Why the explicit step: feed IDs are per-device (`settings.js:37`), so linking a laptop and phone that both subscribe to the same 4 calendars produces **8 feeds** — every event rendered twice, in two colors, in every view. Items entered on both devices duplicate the same way. This hits exactly the person the feature is for, on their first link.

`syncState` stores the device-token hash alongside the version; **any change hard-resets `syncState`** so a re-link never reuses a stale version.

## 6. Security

### 6.1 What linking changes

- **Smart-add stops being public.** `worker/src/index.js:49` today accepts any request; anyone with the URL can spend the Anthropic budget, bounded only by the Console cap. Requiring a device token closes it. This is worth shipping on its own merits.
- **`encKey` never reaches the server.** A full D1 compromise yields ciphertext.

### 6.2 Why the blob is encrypted

Feed URLs are capability tokens, and the codebase says so emphatically in three places: `worker/src/feed.js:8-9` ("must NEVER be logged"), `js/feeds.js:456` (logs the error *name* only), `js/settings.js:8-11` ("never re-displayed in the DOM and never logged").

Syncing feeds moves those secrets into a database at rest, into backups, into any debugging `SELECT`, and over the network on every pull. ICS capability URLs **do not expire** and the app has no revocation UI, so a leak is permanent read access to real Google/iCloud calendars. Client-side encryption is the price of syncing them at all.

### 6.3 Preserving `feeds.js` ownership

`js/feeds.js:6-10` and `:484-487` state that `feeds.js` is the sole owner of cache lifecycle and that `removeFeed(id)` is the only sanctioned deletion path. Sync must respect this:

- A pulled feed deletion goes through `removeFeed()`, not a raw `saveFeeds()`. Otherwise `feedCache[id]` is orphaned forever — never read (`feeds.js:447`) but still iterated and re-serialized by `pruneForQuota` (`:152`), a permanent quota leak on the most constrained device.
- New feeds arriving by pull trigger fresh `/feed` fetches (up to 1 MB each into `localStorage`) — must go through the existing quota-aware path.
- **`color` and `hidden` are per-device view preferences and are not synced.** Hiding a calendar on your phone should not hide it on your laptop, and they are the app's highest-frequency writes — syncing them would generate constant conflicts over a preference nobody wants shared.

  Mechanically: feed records live in one object, so merge takes `url`, `name`, and `updatedAt` from the winning side but **always preserves the local device's `color` and `hidden`**. A feed arriving by pull for the first time gets this device's default color and `hidden: false`. This keeps one storage key rather than splitting synced and local fields apart.

### 6.4 Residual exposures (accepted, documented)

- **GitHub Pages origin isolation is per-account, not per-repo.** Every project page at `ajaenicke518.github.io/*` shares one origin and one `localStorage`. Any script in any other repo you publish — or any third-party dependency it adds — can read the link code and all data. XSS *within* plaenicke is currently low-risk (every render uses `textContent`; no `innerHTML` with user data), but that is not where the exposure comes from. **Mitigation: a custom domain.** Recommended, tracked separately.
- **`index.html` has no CSP** and one inline script; a hash-based CSP is cheap and worth adding.
- **`/feed` remains gated only by an `Origin` header check** (`feed.js:169`), forgeable by any non-browser client. Unchanged by this work, but noted so the threat model is coherent rather than accidentally uneven.

### 6.5 Quota

One `usage` row per **server UTC date**. `worker/src/index.js:54` deliberately takes `today` from the request body so relative dates resolve in the user's timezone — **the quota must not key on that value**, or rotating it bypasses the limit entirely. Increment atomically before the Anthropic call:

```sql
INSERT INTO usage (date, count) VALUES (?, 1)
  ON CONFLICT(date) DO UPDATE SET count = count + 1 RETURNING count
```

At 100, return 429 with "smart-add limit reached, resets at midnight UTC". Manual entry is unaffected — hitting the cap degrades one feature, not the app.

Rate-limit `/admin/device` (brute-forceable `ADMIN_SECRET`) and `PUT /data`. Use the Workers rate-limiting binding, **not** D1 — putting the counter in D1 lets an attacker exhaust the write budget through the anti-abuse mechanism itself.

### 6.6 Payload validation

The server stores ciphertext and cannot validate contents, so it enforces what it can: a **byte cap** on the blob and a rejected-if-unknown `schemaVersion` stamped inside it. The client validates after decryption and **refuses to apply a blob it cannot parse** rather than partially applying it — a record that silently vanishes in `deserializeItems` would otherwise look like a local deletion and propagate a tombstone to every device.

## 7. Error handling

No silent degradation.

- Sync failure never blocks the UI; local data keeps rendering. The failure is **surfaced** — settings shows "last synced N minutes ago" plus a failure banner.
- **Apply before advancing.** Write the merged blob to `localStorage` *first*, persist the new version *second*, and make apply idempotent. Reversing this loses pulled data permanently on any failure between the two.
- **`saveItems` has no quota handling** (`storage.js:38-40`) while `saveFeedCache` does (`:110-117`) — and this app demonstrably hits `QuotaExceededError` (`feeds.js:266-293` exists to recover from it). A pull into a device whose storage is full of feed cache throws a raw exception. `saveItems` needs the same treatment. Note the awkward coupling: the quota is consumed by `feedCache`, which is not synced, and only `syncFeed` prunes it — so a quota-blocked sync stays blocked until an unrelated feed sync fires.
- Invalid/revoked device token → prompt re-link. **Never** clears local data.
- Bounded retries with backoff, then halt and surface.

## 8. Testing

Matches the existing `node --test` setup and the injected-effects pattern.

**Merge (pure, table-driven):** LWW both directions; tie → remote; tombstone beats older record; tombstone does not resurrect; tombstone pruning at 90 days; adoption dedupe (feeds by URL, items by title+date+time); empty-server bootstrap; schema-version rejection; **local `color`/`hidden` survive a pull that changes a feed's `name`**; a newly-pulled feed gets local defaults.

**Protocol:** CAS accepted; CAS 409 → merge → retry succeeds; retry of an identical push is a no-op; apply-then-advance survives a failure injected between the two; version reset on device-token change.

**Convergence property test:** two simulated clients, randomized operation sequences, assert identical final state. This single test would have caught two of the first draft's criticals before they were written.

**Worker contract tests** (local D1, no network): auth required on `/smart-add` and `/data`; unknown route → 404; quota increments on server date and blocks at 100; blob byte cap enforced; revoked token rejected.

**Regression:** `storage.js` deserializers preserve `updatedAt`; `saveItems` handles quota; service worker `ASSETS` includes new modules.

## 9. Rollout order

1. **`crypto.randomUUID()` + `updatedAt` + client tombstones.** No server involvement; app behaves identically. Ships the ID-collision fix immediately.
2. **Explicit Worker routing + 404**, `ALLOWED_ORIGIN` consolidation. No behavior change.
3. **D1 + device tokens + `/data` endpoints + encryption.** Link the desktop, verify adoption is non-destructive.
4. **Link the phone.** Verify the dedupe path with real duplicate calendars.
5. **Last: `POST /smart-add` requires auth.** Flipping this earlier breaks your own smart-add while sync is unproven.

## 10. Deferred (available later, not foreclosed)

- **Multi-user** — add an owner column and a users table; the blob and merge logic are unchanged.
- **Live sync** — Durable Objects, without redoing the data model.
- **Custom domain** — fixes § 6.4 origin isolation.

## 11. To verify during implementation

1. ~~D1 max row/value size~~ — **verified: 2 MB**, ≈8,000 items. Not a constraint.
2. Workers free-plan CPU headroom for AES-GCM + SHA-256 per request (much cheaper than PBKDF2, but measure).
3. `crypto.randomUUID()` and `crypto.subtle` availability in all target browsers/PWA contexts. **`crypto.subtle` requires a secure context** — fine on HTTPS, but confirm for any local dev flow.
4. D1 binding configuration in `worker/wrangler.toml` (currently has no bindings).

## 12. What the adversarial review changed

| First draft | Now | Why |
|---|---|---|
| Multi-user, invite links, sessions | Single owner, device tokens | Goal never required it; cost is permanent (`user_id` on every future feature) |
| PBKDF2 passwords | Link code (auth + enc secrets) | No email → no password reset; PBKDF2 likely exceeds the 10 ms CPU budget |
| Per-row tables + rev cursors | Single encrypted blob + CAS | D1 has no interactive transactions; concurrent syncs could silently lose data |
| Server-side LWW + clock clamp | Client-side merge | Clamped-vs-local timestamps never converged; a fast clock rejected all remote edits forever |
| Server tombstones + 90-day TTL | Client tombstones in the blob | A long-offline device silently missed pruned deletions |
| (absent) | `updatedAt` on every record | Conflict resolution had no input — the data model has no edit timestamp |
| (absent) | Client tombstones key | `deleteItem` destroys the record; nothing left to push |
| (absent) | Single-writer ownership rule | Module-scope arrays would clobber pulled data deterministically |
| (absent) | Client-side encryption | Feed URLs are capability tokens the codebase treats as secrets |
| (absent) | Explicit adoption choice + dedupe | Union silently doubles every shared calendar on first link |
| Quota on client `today` | Quota on server UTC date | Client-supplied date made the limit bypassable |
