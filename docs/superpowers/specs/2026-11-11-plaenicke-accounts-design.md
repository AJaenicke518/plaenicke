# plaenicke — Accounts & logins (V7)

**Date:** 2026-11-11
**Status:** Draft for adversarial review (autonomous run, brief `docs/superpowers/briefs/2026-11-11-accounts-autonomous-brief.md`).
**Owner:** Alexander Jaenicke

## 1. Goal

Let ~10 invited testers (LMU friends) each have their own end-to-end-encrypted plaenicke account, signing in with **email + password** on any number of devices, while Alex's existing link-code account upgrades in place without data loss.

**Success:** every tester can sign up with an invite, use the app on one or more devices, and never lose data; nobody — including Alex as server owner — can read another person's planner data; smart add and calendar feeds cannot be used by people without an account.

**Non-goals (this spec):** notifications, desktop layout, themes; server-sent email; account self-deletion; changing the data key (DEK rotation); per-field merge; offline login on a never-signed-in device; Apple/Google sign-in; App Store / TestFlight.

## 2. What this changes in the V5 decisions

V5 (`2026-08-01-plaenicke-v5-accounts-sync-design.md` § 2) rejected passwords for two reasons. Both are answered:

| V5 objection | Answer here |
|---|---|
| "No email → no password reset → permanent lockout" | A **recovery code** made on the device at sign-up, saved by the user (mail-to-self draft + copy). Recovery needs no server email (§ 6). |
| "PBKDF2 at a credible iteration count exceeds the 10 ms Worker CPU budget" | **The device** runs PBKDF2. The Worker only computes one HMAC-SHA-256 over a 256-bit derived key (§ 4.3). |

CLAUDE.md's "Single user" line and V5's non-goals ("multi-user accounts; public signup") are superseded by this spec. Sign-up stays **invite-only** — there is no public sign-up.

## 3. Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Login identifier | Email (trimmed, lowercased) | Alex, 2026-11-11. |
| D2 | Key model | Random 32-byte **data key (DEK)** encrypts the blob exactly as today; the DEK is stored on the server **wrapped twice** — by a password-derived key and by a recovery-code-derived key | Same shape as Bitwarden (protected symmetric key) and Standard Notes (items keys). Password change and recovery never re-encrypt data. Alex's existing `encKey` **becomes** his DEK, so his blob stays byte-identical through the upgrade. |
| D3 | Password KDF | PBKDF2-HMAC-SHA-256 in WebCrypto, **600,000 iterations**, 16-byte random salt, both stored per account | OWASP Password Storage Cheat Sheet's current figure; Bitwarden's minimum. Native WebCrypto — no dependency, no WASM. Argon2id is not in WebCrypto. Iterations stored per account so they can change later. |
| D4 | Login proof | `authKey = HKDF(masterKey, info "plaenicke/v1/auth")`; server stores `HMAC-SHA-256(AT_REST_KEY, authKey)` | 256-bit high-entropy secret ⇒ a single keyed hash is sufficient (NIST 800-63B § 3.1.2.2's stretching rule applies below 112 bits). Keyed with a Worker secret so a D1 dump alone cannot test guesses. One HMAC is far inside 10 ms. SRP/OPAQUE rejected: no WebCrypto primitives, no gain against a D1 dump that also holds the wrapped key. |
| D5 | At-rest key | New Worker secret `AT_REST_KEY` (32 random bytes). Wrapped DEKs are additionally AES-GCM-encrypted under it in D1 | A D1 dump alone yields neither a guess oracle nor a crackable wrapped key; the attacker also needs Worker secrets. Alex keeps the only copy beside `~/.plaenicke-admin-secret`. |
| D6 | Recovery code | 16 random bytes (128 bits), base64url (22 chars), no stretching | NIST 800-63B: ≥ 64 bits for saved recovery codes; 128 bits clears the 112-bit no-stretch threshold. 1Password's recovery key is likewise unstretched. |
| D7 | Recovery delivery | **Device-delivered**: a `mailto:` draft to the user's own address containing the recovery link, plus Copy. The server never sees the code | Cloudflare Email Sending to arbitrary recipients needs Workers Paid (pricing page, updated 2026-06-09); every third-party sender needs a custom domain and stores message content 7–45 days. Server-sent email would also hand the Worker the code, breaking "server can never read data". Alex's accepted trade-off — whoever controls the inbox can reset — is preserved. |
| D8 | Recovery is single-use | Completing recovery issues a **new** recovery code and signs out every device | Proton's model. A used code sitting in an inbox must not stay valid. |
| D9 | Password policy | ≥ 8 characters, ≥ 1 digit, ≥ 1 non-letter-non-digit, not on a bundled common-password list, not containing the email's local part. Enforced **on the device only** | Alex, 2026-11-11. The server never sees the password, so it cannot enforce anything. NIST discourages composition rules; Alex chose them knowingly — the blocklist is what stops `Password1!`. |
| D10 | Online guessing | Per-email counter: **50 consecutive failures ⇒ that email cannot log in or recover for 1 hour**; success resets | Alex (50), Claude (temporary — a permanent lock lets anyone who knows an email lock that tester out). Lockout never affects already-signed-in devices. |
| D11 | Sessions | Never expire. Device list + "Sign out other devices" + "Sign out" in Settings | Alex. NIST 800-63B suggests ≤ 30-day reauthentication (SHOULD); deviation recorded deliberately. |
| D12 | Session = device row | Today's `devices` table **is** the session table, gaining `account_id` | Reuses `authenticateDevice` and its tests. |
| D13 | Local credential format | **Unchanged**: `plaenicke.auth` = `base64url(sessionToken ‖ DEK)` (86 chars) | After login a device holds exactly a token and a 32-byte key — today's link-code shape. `sync.js`, adoption, the shell indicator and every invariant in CLAUDE.md run unmodified. |
| D14 | Login enters via adoption | A successful login calls the existing `linkWithCode(code)` → adoption gate → Merge/Cancel dialog | The adoption flow already merges local data into an account and never wipes. No second entry path into a linked state. |
| D15 | Smart-add cap | **50 calls / account / UTC day**, counted in D1, checked **before** the Claude call | ESTIMATE ~$0.002 per typical call (Haiku 4.5, $1/$5 per MTok); 10 users × 50 = $1/day typical, $11/day if every call hit `max_tokens`. Anthropic Console spend cap stays the outer bound. UTC because the client-sent `today` must never pick the bucket. Counter also stores token counts so the cap can be resized from data. |
| D16 | `/feed` | Requires a session token; checked **before** the edge-cache lookup | Closes the open proxy (the `Origin` check is forgeable). The only caller is the app (`js/feeds.js:219`). |
| D17 | Signed-out app | The local planner keeps working signed out. **Calendar feeds and smart add need an account** | Alex folded punchlist L31 into accounts. Signed-out manual add, To-do, ideas, Brightspace-free use all remain offline-capable. |
| D18 | Admin | Worker endpoints behind `ADMIN_SECRET`: mint invite, list accounts, disable, delete. No in-app admin screen | Alex chose option A. |
| D19 | Invites | 16 random bytes, base64url; only a SHA-256 stored; single use enforced by a `UNIQUE` column. Not bound to an email | Simplest for Alex to hand out. A leaked unused invite is revocable. |
| D20 | Invite delivery | Alex sends a link `…/plaenicke/#invite=<code>`; the app also accepts a pasted code | Fragment never reaches a server. |
| D21 | Custom domain | **Not in this spec; required before Alex publishes any second GitHub Pages site** | All `*.github.io` paths of one account share one origin and one `localStorage`. Today `plaenicke` is the account's only Pages repo (verified 2026-11-11). After accounts, a domain move costs testers one sign-in, not data. Buying it is Alex's (money). |
| D22 | DEK at rest on device | Stays in `localStorage` inside `plaenicke.auth` (as today) | Moving it to a non-extractable IndexedDB `CryptoKey` changes the credential path every sync invariant hangs off (D13) for a gain that does not stop XSS from *using* the key. Revisit with the domain move. |
| D23 | Sign-out keeps local data | "Sign out" revokes this device's session and clears `plaenicke.auth`; local items stay | Matches the existing `unlink()` invariant ("Unlinking never deletes local data", `js/auth.js:11`). Testers are told not to sign in on shared computers. An "erase this browser" action is deferred: erasing is only safe when nothing is unsynced, which `syncState` cannot currently prove. |

## 4. Cryptography (all CONCRETE — WebCrypto calls named)

### 4.1 Derivations (client)

```
pwKey     = importKey('raw', utf8(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
masterKey = deriveBits({name:'PBKDF2', hash:'SHA-256', salt: kdfSalt, iterations: kdfIters}, pwKey, 256)
hk        = importKey('raw', masterKey, 'HKDF', false, ['deriveBits','deriveKey'])
authKey   = deriveBits({name:'HKDF', hash:'SHA-256', salt: zero32, info: utf8('plaenicke/v1/auth')}, hk, 256)
pwWrapKey = deriveKey ({name:'HKDF', hash:'SHA-256', salt: zero32, info: utf8('plaenicke/v1/wrap')}, hk,
                       {name:'AES-GCM', length:256}, false, ['encrypt','decrypt'])

rk           = importKey('raw', recoveryCodeBytes(16), 'HKDF', false, ['deriveBits','deriveKey'])
recAuthKey   = HKDF(rk, info 'plaenicke/v1/rec-auth')   → 256 bits
recWrapKey   = HKDF(rk, info 'plaenicke/v1/rec-wrap')   → AES-GCM-256

wrappedDekPw  = base64(iv12 ‖ AES-GCM(pwWrapKey,  iv12, DEK, additionalData = utf8('plaenicke/v1/dek-pw')))
wrappedDekRec = base64(iv12 ‖ AES-GCM(recWrapKey, iv12, DEK, additionalData = utf8('plaenicke/v1/dek-rec')))
```

New module **`js/keys.js`** owns all of this (pure, async, no storage, no DOM). `js/crypto.js` keeps the blob encryption and link-code encoding unchanged.

### 4.2 What the server stores per account

`kdf_salt`, `kdf_iters`, `auth_mac = HMAC(AT_REST_KEY, authKey)`, `rec_auth_mac = HMAC(AT_REST_KEY, recAuthKey)`, `wrapped_dek_pw_sealed = seal(wrappedDekPw)`, `wrapped_dek_rec_sealed = seal(wrappedDekRec)`, where `seal(x) = base64(iv12 ‖ AES-GCM(AT_REST_KEY, iv12, x, additionalData = utf8(column ‖ '|' ‖ email)))`. Binding the email in the AAD stops a sealed value being copied onto another account's row.

### 4.3 Worker cost

Per login: one `importKey`, one HMAC, one constant-time compare, one AES-GCM unseal of < 100 bytes, two D1 statements. No stretching on the Worker. Fits the Free plan's 10 ms CPU limit (Workers' measured crypto cost is microseconds for these sizes; the V5 spike measured RFC 8291 encryption at ~0.08 ms).

### 4.4 Offline-guessing exposure (recorded, not hidden)

With **D1 and Worker secrets both** stolen, an attacker pays one 600k-iteration PBKDF2 per guess: ~14,800 guesses/s per RTX 4090 (ESTIMATE, linear scaling of hashcat's published 999-iteration benchmark). A truly random 8-character lowercase password ≈ 164 days on one GPU; a human-chosen 8-character password on a cracking list falls fast. The blocklist and D5 are the mitigations; Alex accepted the 8-character minimum.

## 5. Data model — migration `worker/migrations/0002_accounts.sql`

```sql
CREATE TABLE accounts (
  id                     INTEGER PRIMARY KEY,
  email                  TEXT UNIQUE COLLATE NOCASE,      -- NULL only for the legacy account before upgrade
  kdf_salt               TEXT,
  kdf_iters              INTEGER,
  auth_mac               TEXT,
  rec_auth_mac           TEXT,
  wrapped_dek_pw_sealed  TEXT,
  wrapped_dek_rec_sealed TEXT,
  invite_hash            TEXT UNIQUE,                      -- NULL for the legacy account
  created_at             TEXT NOT NULL,
  disabled_at            TEXT,
  failed_logins          INTEGER NOT NULL DEFAULT 0,
  locked_until           TEXT
);
-- The existing single-user data becomes account 1, credential-less until Alex upgrades.
INSERT INTO accounts (id, created_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

ALTER TABLE devices ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1 REFERENCES accounts(id);

-- data had CHECK (id = 1); SQLite cannot drop a CHECK, so rebuild.
CREATE TABLE data_v2 (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO data_v2 (account_id, version, blob, updated_at) SELECT 1, version, blob, updated_at FROM data WHERE id = 1;
DROP TABLE data;
ALTER TABLE data_v2 RENAME TO data;

CREATE TABLE invites (
  hash       TEXT PRIMARY KEY,
  note       TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE usage (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  day        TEXT NOT NULL,          -- UTC YYYY-MM-DD
  calls      INTEGER NOT NULL,
  in_tok     INTEGER NOT NULL DEFAULT 0,
  out_tok    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
```

- The account's `data` row is created at sign-up (`version 0, blob ''`), the same empty state `0001` seeds today.
- `fake-d1.js` must load **every** migration in order (today it reads only `0001`), so tests exercise the real rebuild.
- **Production migration is an Alex-run release step** after `wrangler d1 export` (§ 10).

## 6. Flows

### 6.1 Sign-up (invited tester)

1. Tester opens `…/plaenicke/#invite=<code>` (or pastes the code in Settings → Account → *I have an invite*). The app reads `location.hash`, immediately `history.replaceState`s it away, and shows the sign-up form. **No network call on page load.**
2. Tester enters email + password (+ confirm). Policy (D9) is checked live with a plain-language hint.
3. Device: `kdfSalt = random16`; derive (§ 4.1); `DEK = generateEncKey()`; `R = random16`; derive recovery keys; wrap DEK twice.
4. `POST /auth/signup {invite, email, kdfSalt, kdfIters, authKey, recAuthKey, wrappedDekPw, wrappedDekRec, deviceName}`.
5. Worker, in this order: validate shapes; `SELECT` the invite by `sha256(invite)` where `revoked_at IS NULL` (absent ⇒ 403 `invalid_invite`); `INSERT INTO accounts … invite_hash = ?` — the `UNIQUE` constraint makes a second use fail (⇒ 403 `invalid_invite`), a duplicate email fails `UNIQUE(email)` (⇒ 409 `email_taken`); insert the `data` row; mint a device token bound to the account. Returns `{token}`.
   - D1 has no interactive transactions. If a statement after the account insert fails, the account exists without a data row or device. `handleGetData` therefore treats a missing data row for an existing account as `{version: 0, blob: ''}` and `PUT` upserts with `INSERT … ON CONFLICT(account_id) DO UPDATE … WHERE version = ?`; a retried sign-up with the same email gets `email_taken` and the tester logs in instead. (Covered by tests that kill the sequence after each statement.)
6. **Recovery screen (blocking):** shows the recovery code, an **Email it to me** button (`mailto:<email>?subject=Your plaenicke recovery link&body=…#recover=<R>…`), and **Copy**. *Continue* is enabled only after the tester ticks "I emailed or saved my recovery link". Leaving the screen without ticking keeps the account and offers the screen again from Settings (*Show recovery link* is not possible later — the code is not stored — so Settings offers *Make a new recovery link*, § 6.5).
7. Device composes `code = composeLinkCode(token, DEK)` and calls `linkWithCode(code)` → adoption gate → existing Merge/Cancel flow merges whatever the device already holds locally into the (empty) account.

### 6.2 Log in on another device

1. `POST /auth/prelogin {email}` → `{kdfSalt, kdfIters}`. Unknown email ⇒ deterministic fake salt `HMAC(AT_REST_KEY, 'salt|'+email)[0..16]` and the default iterations, so the response does not reveal whether an account exists.
2. Device derives `authKey`, `pwWrapKey`.
3. `POST /auth/login {email, authKey, deviceName}`. Worker: row by email; if `disabled_at` ⇒ 403 `disabled`; if `locked_until > now` ⇒ 429 `locked` with `retryAt`; compare `HMAC(AT_REST_KEY, authKey)` to `auth_mac` (constant-time). Wrong ⇒ `failed_logins += 1`; at 50 set `locked_until = now + 1h` and reset the counter; 401 `bad_credentials` (same response for unknown email). Right ⇒ `failed_logins = 0`, mint device token, return `{token, wrappedDekPw}` (unsealed).
4. Device unwraps the DEK (an AES-GCM failure here is a bug, not a wrong password — the server already verified it; surface it, never fall back), composes the link code, `linkWithCode(code)` → adoption.

### 6.3 Forgot password

1. Tester opens the recovery link from their email: `…/plaenicke/#recover=<R>`. App strips the hash immediately (`replaceState`), shows "Reset your password" (email + new password). **No network call until the tester submits** — link scanners render pages headlessly.
2. `POST /auth/recover/start {email, recAuthKey}` → `{wrappedDekRec}` (same lockout counter and responses as login).
3. Device unwraps the DEK with `recWrapKey`, derives new password material and a **new** recovery code `R′`.
4. `POST /auth/recover/finish {email, recAuthKey, kdfSalt, kdfIters, authKey, wrappedDekPw, recAuthKey2, wrappedDekRec2, deviceName}` → Worker re-verifies `recAuthKey`, replaces all six credential columns with **one** `UPDATE … WHERE id = ? AND rec_auth_mac = ?` (so two concurrent finishes cannot both win), deletes **all** of the account's devices, mints one new token. Returns `{token}`.
5. Recovery screen for `R′` (as § 6.1 step 6), then `linkWithCode` → adoption.

### 6.4 Change password (signed in)

Settings → Account → *Change password*: current + new. Device fetches `prelogin` salt, derives current `authKey`, unwraps nothing (it already holds the DEK), derives new material. `POST /account/password {currentAuthKey, kdfSalt, kdfIters, authKey, wrappedDekPw}` (bearer token). Worker verifies the current `authKey` (counts toward lockout), replaces the three password columns in one `UPDATE … WHERE id = ? AND auth_mac = ?`. Other devices stay signed in (their DEK did not change).

### 6.5 Make a new recovery link (signed in)

`POST /account/recovery {currentAuthKey, recAuthKey, wrappedDekRec}` — requires the password, replaces the two recovery columns, then the § 6.1 step 6 screen. The old link stops working.

### 6.6 Devices

- `GET /account/devices` → `[{id, name, createdAt, lastSeenAt, current}]` where `id` is the first 12 hex chars of `token_hash` (enough to target, useless as a credential).
- `POST /account/devices/signout-others` → deletes every other device row of the account.
- `POST /auth/logout` → deletes the calling device's row; client then calls `unlink()` (D23).

### 6.7 Alex's upgrade (legacy account 1)

On a linked device, Settings → Account shows **Create your login** when `GET /account` returns `{email: null}`.

1. Alex enters email + password. Device takes its existing `encKey` **as the DEK**, generates salt and `R`, derives and wraps.
2. `POST /account/upgrade {email, kdfSalt, kdfIters, authKey, recAuthKey, wrappedDekPw, wrappedDekRec}` (bearer = this device's existing token). Worker: `UPDATE accounts SET … WHERE id = ? AND email IS NULL` — only a credential-less account can be upgraded, and only once.
3. Recovery screen for `R`.
4. **Nothing else changes on any device**: same token, same DEK, same `plaenicke.auth`, same blob. `resetSyncStateIfDeviceChanged` does not fire (token unchanged), so the adoption gate is **not** re-raised. Alex's second phone keeps syncing untouched.

### 6.8 Smart add and `/feed` with a session

- Client sends `Authorization: Bearer <token>` from `getLink()` on both calls when linked; signed out it does not call them and shows "Sign in to use smart add / calendars".
- **Smart add:** `authenticateDevice` → account; `disabled_at` ⇒ 403; then

  ```sql
  INSERT INTO usage (account_id, day, calls) VALUES (?1, ?2, 1)
  ON CONFLICT (account_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?3
  RETURNING calls;
  ```
  No row ⇒ 429 `daily_limit` with `resetsAt` (next 00:00 UTC). After Claude replies, `UPDATE usage SET in_tok = in_tok + ?, out_tok = out_tok + ?` from `usage.input_tokens/output_tokens`. RETURNING-on-upsert is standard SQLite ≥ 3.35; **SPECULATIVE on D1 until a local test and a staging run prove it** — the plan's first worker task pins it.
  Client: new error code `limit` → "You've used today's smart adds. They reset at <local time>. You can still add it by picking a date." A `401` gets its own message ("Sign in again"), not "Smart add is unavailable".
- **`/feed`:** `feed.js` CORS allow-headers gains `authorization`; the token check runs **before** `cache.match`, so a cached feed is never served to a caller without a session. The cache key stays the target URL (feeds are not per-user data; two testers adding the same public calendar share one cached copy — acceptable, the ICS is identical).

### 6.9 Admin (curl recipes in `docs/admin.md`)

| Route | Body | Returns |
|---|---|---|
| `POST /admin/invite` | `{note}` | `{invite, link}` — shown once |
| `DELETE /admin/invite` | `{hashPrefix}` | revokes an unused invite |
| `GET /admin/accounts` | — | `[{id, email, createdAt, lastSeenAt, devices, smartAddToday, disabled}]` |
| `POST /admin/account/disable` | `{id, disabled: true/false}` | disabling also deletes the account's device rows |
| `DELETE /admin/account` | `{id, confirm: email}` | deletes usage, devices, data, account (order chosen so a partial failure leaves an orphan the next attempt finishes) |

`POST`/`DELETE /admin/device` (raw link-code minting) **stay** for Alex's existing workflow and are documented as legacy.

## 7. Client modules

| Module | Change |
|---|---|
| `js/keys.js` (new) | § 4.1 derivations, wrap/unwrap, recovery-code encode/decode. Pure. |
| `js/password-policy.js` (new) | D9 rules → `{ok, problems[]}`; bundled blocklist `js/common-passwords.js` (policy-passing entries from SecLists' common-credentials lists, MIT; size measured in the plan, target < 100 KB). |
| `js/account.js` (new) | Network calls for § 6 (signup, prelogin, login, recover, password, recovery, devices, logout, upgrade). Effects injected (`fetchImpl`), the `js/sync.js` pattern. Ends every successful sign-in by returning a link code; it never writes storage itself. |
| `js/accountui.js` (new) | Settings → Account section and the full-screen sign-up / log-in / reset / recovery-link screens. Calls `linkWithCode` for the hand-off. Not added to `linkui.js` (1,245 lines; punchlist L78). |
| `js/fragment.js` (new) | Reads `#invite=` / `#recover=` once at boot, `replaceState`s, returns the intent. |
| `js/smartadd.js`, `js/feeds.js` | Bearer header when linked; `limit` / `unauthorized` error codes. |
| `js/settings.js` | Mounts the Account section above Sync. |
| `service-worker.js` | New modules in `ASSETS`; `CACHE` bump (check other branches first — CLAUDE.md trap). |

Worker: `worker/src/accounts.js` (new: signup/prelogin/login/recover/password/recovery/devices/logout/upgrade), `worker/src/seal.js` (new: HMAC + seal/unseal with `AT_REST_KEY`), `worker/src/usage.js` (new: cap), `auth.js` (`authenticateDevice` returns `{tokenHash, accountId}`), `data.js` (per-account row), `feed.js` (auth before cache), `index.js` (route table), `cors.js` (`ALLOWED_ORIGINS` list, ready for the domain).

## 8. Error handling (zero fallback)

- Every Worker error is a typed JSON `{error}` with a specific status; the client maps each to a specific message. No "something went wrong" catch-all for a known code.
- Unwrap failure after a server-verified login ⇒ a visible error naming the failure; the device is **not** linked.
- `AT_REST_KEY` missing ⇒ every `/auth/*` and `/account/*` route returns 500 `not_configured` (never a silent unsealed write).
- Sign-up partial failure ⇒ § 6.1 step 5 rule; no orphan blocks future use.
- The recovery screen cannot be skipped silently (§ 6.1 step 6).

## 9. Testing

- **Worker** (`worker/tests/`, real `node:sqlite` via `fake-d1.js` loading all migrations): migration from a populated `0001` database preserves Alex's row and devices; signup (invite reuse, duplicate email, revoked invite, partial-failure after each statement); login (wrong/right, lockout at 50, unlock after 1 h with injected `now`, disabled); prelogin indistinguishability; recover start/finish (single-use, concurrent finish, devices wiped); password change; upgrade (once only, legacy only); usage cap (50th allowed, 51st 429, UTC rollover, concurrent increments); `/feed` and smart add 401 without token, `/feed` cache not served without token; admin routes.
- **Client** (`tests/`): `keys.js` round trips and fixed vectors (PBKDF2 and HKDF RFC test vectors via WebCrypto in Node); password policy table; `account.js` with a fake server; fragment stripping; **end-to-end**: two simulated devices — sign up on A, log in on B, both converge through the real `sync.js` against the real Worker handlers (`worker.fetch` + `fake-d1`), not `fakeServer`; Alex upgrade with a second linked device that keeps syncing; recovery signs B out and B shows a clear "signed out" state rather than silent failure.
- **Mutation checks** (CLAUDE.md): each lockout, single-use and auth-before-cache test is proven to fail with its guard removed.
- **Not testable locally, Alex-run:** PBKDF2 600k timing on his iPhone (sign-in must complete in a tolerable time; if > ~3 s the iteration count is revisited, stored per account so existing users keep theirs); D1 RETURNING on a staging deploy.

## 10. Release (Alex-run; nothing here is done by the autonomous run)

1. `wrangler d1 export plaenicke --remote --output backup-<date>.sql`.
2. `wrangler secret put AT_REST_KEY` (32 random bytes, base64url); save a copy next to the admin secret.
3. Apply `0002_accounts.sql` to production D1.
4. **Client first** (merge to main): sends bearer on smart add / feed (the old Worker ignores it), has the Account UI. Wait until both of Alex's devices show the new `CACHE`.
5. **Worker second**: deploy with gating on; bump `version.js`; `curl /version`; `npm run smoke:worker` (smoke script updated to send a token).
6. Alex upgrades his account (§ 6.7) on one device; confirms the other still syncs.
7. Mint invites; send links. Tell testers: lost password **and** lost recovery email = data gone; don't sign in on shared computers.

Order matters: Worker-first would break smart add and feeds on Alex's not-yet-updated client.

## 11. Open risks

- **PBKDF2 time on iPhone Safari** (SPECULATIVE; WebKit bug 277601 shows Safari slower than Chrome).
- **Microsoft Safe Links may carry the full recovery URL, fragment included, to Microsoft's servers** (SPECULATIVE). Accepted under "inbox control = reset"; mitigated by single-use recovery (D8).
- **Shared `github.io` origin** until the domain (D21).
- **A signed-out device keeps the data it already downloaded** (D11/D23). Only DEK rotation would cut it off; out of scope.
- **Tester loses password and recovery email** ⇒ unrecoverable by design. Told up front.
