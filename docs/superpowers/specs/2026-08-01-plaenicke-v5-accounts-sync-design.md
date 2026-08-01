# plaenicke V5 — Accounts & Cross-Device Sync

**Date:** 2026-08-01
**Status:** Draft — pending adversarial review
**Owner:** Alexander Jaenicke

## 1. Goal

Let a person sign in to plaenicke on multiple devices and see the same items and calendar subscriptions on each. Multi-user with separate per-user data, closed signup via invite links.

Today there is no auth of any kind: all state lives in `localStorage` per device (`plaenicke.items`, `plaenicke.feeds`, `plaenicke.feedCache`), and the Worker is a stateless proxy. The `APP_PASSPHRASE` secret referenced in `worker/src/index.js:2` is vestigial — the code comment at line 49 states "No passphrase (personal use)" and the client never references it.

## 2. Constraints & decisions

| Decision | Choice | Rationale |
|---|---|---|
| Users | Multi-user, separate data | User requirement |
| Signup | Invite links only, no public signup | Closed surface; no email verification / bot defense needed |
| Storage | Cloudflare D1, one row per item | Strongly consistent (KV is not); no whole-document last-write-wins data loss; auth/invite/quota tables live in the same store |
| Sync model | Local-first, background reconcile | Preserves existing offline PWA behavior; mirrors existing `syncStale` pattern |
| What syncs | `items` + `feeds` | `feedCache` is derived, regenerable per device, and already causes quota pressure |
| Live sync | No (Durable Objects deferred) | Sync-on-open + sync-on-change is indistinguishable in practice for a planner; DO remains a later option without redoing the data model |
| Smart-add quota | 100/user/day | Measured cost ≈ $0.001/request (Haiku 4.5, ~650 input + ~75 output tokens); 100/day ≈ $3/user/month worst case. Bounds abuse, not normal use |

**Non-goals:** live/WebSocket sync; public signup; syncing `feedCache`; sharing calendars between users; any change to how ICS feeds are fetched or rendered.

## 3. Cost basis (measured, not assumed)

Voice input is **free** — `js/voice.js:7` uses the browser Web Speech API; no audio leaves the device. The only paid path is smart-add text → Claude Haiku 4.5 (`worker/src/prompt.js:46`).

Measured payload: system prompt 1,338 chars + JSON schema 783 chars + user note ~60 chars ≈ **650 input tokens**; output ≈ **75 tokens** for one parsed event. At $1.00/1M input and $5.00/1M output → **~$0.001 per smart-add**.

**Prompt caching is unavailable here:** Haiku 4.5 requires a ≥4,096-token cacheable prefix; ours is ~650. It would silently no-op rather than error. There is no cheap 10x optimization available — accepted, since absolute cost is negligible at this scale.

## 4. Architecture

Three layers; the first two are additive to what exists.

### 4.1 Worker + D1

Existing routes unchanged: `GET /feed` (ICS proxy), `POST /` (smart-add). New routes:

- `POST /auth/signup` — redeem invite token, set password
- `POST /auth/login` — returns session token
- `POST /auth/logout` — invalidates session
- `POST /sync` — combined push+pull (see § 5.2)
- `POST /admin/invite` — mint an invite; gated by `ADMIN_SECRET` Worker secret

### 4.2 Client modules

- **`js/sync.js` (new)** — sync orchestration. Follows the pattern `js/feeds.js` already establishes: pure logic, no DOM, all effects (`fetchImpl`, `now`) injected so every path is testable without network or wall-clock.
- **`js/auth.js` (new)** — session token lifecycle, login/logout/refresh.
- **`js/storage.js` (modified)** — retains its stated invariant as the only file touching `localStorage`. Gains `plaenicke.syncState` (cursor + dirty ids) and `plaenicke.auth` (session token). No other module reaches around it.
- **`js/settings.js` (modified)** — account section: sign in / sign out, sync status, "last synced" indicator.
- **`js/app.js` / `js/settings.js` (modified)** — replace the two duplicated `uid()` implementations (`app.js:98`, `settings.js:37`) with a single shared `crypto.randomUUID()`-based helper (see § 4.3).

### 4.3 ID collision fix (targeted, in-scope)

Current IDs are `'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)` (`app.js:98`) and the same shape for feeds (`settings.js:37`). Across two devices creating an item in the same millisecond, collision probability is ~1e-6 per event — low but nonzero, and a collision means one device's event silently overwrites another's. Offline-capable multi-device sync makes this a correctness issue rather than a theoretical one.

**Fix:** one shared `uid()` using `crypto.randomUUID()`. Existing IDs remain valid — this changes generation only, not stored data.

### 4.4 Signed-out behavior

Unchanged from today: fully local, fully offline, no account required. Signing in **adopts** existing local data into the account; it never wipes it.

## 5. Data model & sync protocol

### 5.1 D1 schema

```sql
users     (id TEXT PK, username TEXT UNIQUE, password_hash TEXT, salt TEXT, created_at TEXT)
invites   (token_hash TEXT PK, created_at TEXT, expires_at TEXT, used_by TEXT, used_at TEXT)
sessions  (token_hash TEXT PK, user_id TEXT, created_at TEXT, expires_at TEXT)
user_rev  (user_id TEXT PK, rev INTEGER NOT NULL)
items     (user_id TEXT, id TEXT, rev INTEGER, updated_at TEXT, deleted INTEGER DEFAULT 0,
           payload TEXT, PRIMARY KEY (user_id, id))
feeds     (user_id TEXT, id TEXT, rev INTEGER, updated_at TEXT, deleted INTEGER DEFAULT 0,
           payload TEXT, PRIMARY KEY (user_id, id))
usage     (user_id TEXT, date TEXT, count INTEGER, PRIMARY KEY (user_id, date))
```

Index: `items(user_id, rev)` and `feeds(user_id, rev)` — the pull query is `WHERE user_id = ? AND rev > ?`.

**Why `payload` as JSON rather than per-field columns:** the server never interprets item semantics — only `id`, `rev`, `updated_at`, `deleted`. Adding a field to `makeItem()` requires no migration. The client pulls everything and renders locally, so no server-side querying by date/category is needed.

### 5.2 Protocol

Per-user monotonic `rev`. Every accepted write bumps it. Each device persists the last `rev` it has seen.

**`POST /sync`** — one round trip, one D1 transaction:

```
request:  { since: <cursor>, items: [<changed>], feeds: [<changed>] }
response: { rev: <new cursor>, items: [<records with rev > since>], feeds: [...] }
```

Pull-only sync = same call with empty arrays. Each changed record carries `{ id, updated_at, deleted, payload }`.

### 5.3 Conflict resolution

Per-item last-write-wins on the client's `updated_at`. Ties resolve to the stored copy (deterministic).

Because storage is row-level, edits to *different* items on two devices never conflict — the common case is fully safe. The only lossy case is editing *the same* item on two devices while offline, where the older edit is discarded. Accepted for a single-person planner.

### 5.4 Deletes

Tombstones (`deleted = 1`), retained 90 days, then pruned. Without tombstones a delete on one device is resurrected by another device's stale copy.

### 5.5 Clock skew

The server clamps any incoming `updated_at` that is ahead of server time to server time. Without this, a device with a fast clock wins every future conflict permanently.

### 5.6 First sign-in adoption

Local records push as new. On a second device the result is the union of both sets. Sign-in is never destructive.

## 6. Auth & security

- **Passwords:** PBKDF2-HMAC-SHA256, per-user salt, high iteration count, via WebCrypto. Argon2/bcrypt are not natively available in Workers.
- **Sessions:** 32 random bytes; stored server-side **hashed** (SHA-256) so a DB leak cannot be replayed as live sessions. Long expiry with refresh-on-use.
- **Invites:** 32 random bytes, stored hashed, single-use, expiring. Minted only via `POST /admin/invite` gated by `ADMIN_SECRET`. No public signup route exists.
- **Smart-add becomes authenticated.** Today `POST /` is public (`worker/src/index.js:49`) and anyone with the URL can spend the owner's Anthropic budget. This closes that — a security improvement independent of sync.
- **Rate limiting** on `/auth/login` and `/auth/signup` per IP, so a leaked invite link is not a brute-force foothold.
- **CORS** stays pinned to the existing `ALLOWED_ORIGIN`.
- The `/feed` proxy's existing SSRF hardening and capability-token secrecy (`worker/src/feed.js`) are unchanged.

## 7. Error handling

Per the zero-fallback rule: no silent degradation.

- Sync failure never blocks the UI; local data keeps rendering (same posture as existing feed sync). The failure is **surfaced** — settings shows "last synced N minutes ago" plus a failure banner — not swallowed and retried forever in silence.
- Expired/invalid session → prompt re-login. **Never** clears local data.
- Quota exceeded → explicit "smart-add limit reached, resets at midnight UTC"; manual entry unaffected.
- Bounded retries with backoff on transient network errors, then halt and surface.

## 8. Testing

Matches the existing `node --test` setup and the injected-effects pattern from `feeds.js`.

- **Merge logic (pure, table-driven):** LWW in both directions; tie → stored copy; tombstone propagation; tombstone does not resurrect; clock-skew clamp; first-sign-in adoption; empty-cursor bootstrap; union across two devices.
- **Worker endpoints (contract tests, local D1, no network):** sync round trip; cursor advances; invite single-use (second redemption must fail); session expiry; quota increments and blocks at 100.
- **Auth:** hash/verify roundtrip; wrong password rejected; session token hashed at rest.

## 9. Rollout order

Ordering prevents breaking the working app mid-migration:

1. Auth + sync ship; app still works fully signed-out, exactly as today.
2. Sign in on desktop; verify local data adopted, nothing lost.
3. Sign in on phone; verify union across devices.
4. **Last:** flip smart-add to require auth. Doing this earlier would break the owner's own smart-add while sync is still unproven.

## 10. Open items to verify during implementation

1. D1 free-tier limits (rows read/written per day, storage) against expected usage.
2. PBKDF2 iteration count that keeps Worker CPU time within limits while remaining strong.
3. Whether `crypto.randomUUID()` is available in all target browsers/PWA contexts in use.
4. D1 binding configuration in `worker/wrangler.toml` (currently has no bindings).
