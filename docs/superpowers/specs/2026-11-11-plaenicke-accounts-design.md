# plaenicke — Accounts & logins (V7)

**Date:** 2026-11-11
**Status:** Revised after adversarial review (devil's advocate, 2 Critical + 14 Important, all applied or adjudicated; constructive sparring). Autonomous run — brief `docs/superpowers/briefs/2026-11-11-accounts-autonomous-brief.md`. Pending Alex's review on return.
**Owner:** Alexander Jaenicke

> **Revision note.** Draft `fd48fea` was reviewed adversarially. The review found the migration would fail on D1 (`ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT 1 REFERENCES` is illegal with foreign keys on), that renaming `data.id` would break the deployed Worker mid-release, that multi-statement writes ignored D1's atomic `batch()`, and that the login hand-off could merge one person's planner into another person's account. § 12 lists every change.

## 1. Goal

Let ~10 invited testers (LMU friends) each have their own end-to-end-encrypted plaenicke account, signing in with **email + password** on any number of devices, while Alex's existing link-code account upgrades in place without data loss.

**Success:** every tester can sign up with an invite, use the app on one or more devices, and never lose data; nobody can read another person's planner data — the server stores only ciphertext and wrapped keys (bounded by code trust: Alex serves the JavaScript, § 4.4); smart add and calendar feeds cannot be used without an account.

**Non-goals:** notifications, desktop layout, themes; server-sent email; account self-deletion; DEK rotation; AT_REST_KEY rotation; per-field merge; switching a device between accounts that both hold local data (§ 6.10); Apple/Google sign-in; App Store / TestFlight.

## 2. What this changes in the V5 decisions

| V5 objection (`2026-08-01…` § 2) | Answer here |
|---|---|
| "No email → no password reset → permanent lockout" | A **recovery code** made on the device at sign-up and saved by the user (mail-to-self, copy, or download), tracked server-side until confirmed (§ 6.1). |
| "PBKDF2 … exceeds the 10 ms Worker CPU budget" | **The device** runs PBKDF2. The Worker computes one HMAC over a 256-bit derived key (§ 4.3). |

CLAUDE.md's "Single user" line and V5's non-goals ("multi-user accounts; public signup") are superseded. Sign-up stays **invite-only**.

## 3. Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Login identifier | Email (trimmed, lowercased) | Alex, 2026-11-11. |
| D2 | Key model | Random 32-byte **DEK** encrypts the blob exactly as today; server stores it **wrapped twice** — by a password-derived key and a recovery-code-derived key | Bitwarden / Standard Notes shape. Password change and recovery never re-encrypt data. Alex's `encKey` **becomes** his DEK: his blob stays byte-identical. |
| D3 | Password KDF | PBKDF2-HMAC-SHA-256 (WebCrypto), **600,000 iterations**, 16-byte random salt, stored per account. **Client refuses any `kdfIters` < 600,000** | OWASP's current figure; Bitwarden's minimum. Native, no dependency. The floor stops a compromised server from downgrading the KDF to brute-force `authKey`. |
| D4 | Login proof | `authKey = HKDF(masterKey, 'plaenicke/v1/auth')`; server stores `HMAC(macKey, authKey)` | 256-bit secret ⇒ one keyed hash suffices (NIST 800-63B § 3.1.2.2 stretching applies below 112 bits). SRP/OPAQUE rejected: no WebCrypto primitives, no gain against a dump that also holds the wrapped key. |
| D5 | At-rest key | Worker secret `AT_REST_KEY`; HKDF subkeys `macKey` ('plaenicke/v1/at-rest/mac') and `sealKey` ('…/seal'). Sealed values carry a key-id prefix `k1:`. A `config` row stores `HMAC(macKey, 'plaenicke/v1/key-check')`; on mismatch every auth route returns 500 `at_rest_key_mismatch` | A D1 dump alone yields neither a guess oracle nor a crackable wrap. Losing or changing the secret produces a loud, specific error — never "wrong password" for everyone. Alex keeps two copies (laptop + password manager, punchlist L49). |
| D6 | Recovery code | 16 random bytes (128 bits), base64url (22 chars), unstretched | NIST: ≥ 64 bits for saved recovery codes; 128 bits clears the no-stretch threshold. |
| D7 | Recovery delivery | **Device-delivered**: *Email it to me* (`mailto:` to own address), *Copy*, *Download* (`.txt`). Server never sees the code | Server-sent email needs Workers Paid (Cloudflare Email Service pricing, updated 2026-06-09) or a domain + third-party sender storing content 7–45 days, and would hand the Worker the code. Alex's trade-off (inbox control = reset) preserved. |
| D8 | Recovery confirmed server-side | `accounts.recovery_confirmed_at`; set only by `POST /account/recovery/confirm`; returned by login and `GET /account`; every device shows a persistent "Save your recovery link" banner while it is null | A `mailto:` switch to Mail can evict the standalone PWA; a client-only flag would be lost. |
| D9 | Recovery is single-use | Completing recovery issues a new code and signs out every device (one atomic batch) | Proton's model. |
| D10 | Password policy | ≥ 8 chars, ≥ 1 digit, ≥ 1 non-letter-non-digit, not on the bundled common-password list, not containing the email's local part. Device-only | Alex. The server never sees the password. The blocklist is what stops `Password1!`. |
| D11 | Lockout | 50 consecutive failed **password** checks ⇒ password checks for that email refused for 1 h. Attempt slot reserved atomically before comparing. Success resets. **Recovery routes are exempt.** Lockout never blocks sync or smart add | Alex (50), Claude (temporary). 128-bit recovery codes need no throttle; sharing the counter would let anyone who knows an email block recovery indefinitely. |
| D12 | Sessions | Never expire. Settings: device list, *Sign out other devices*, *Sign out*; password change offers "also sign out other devices" | Alex. NIST suggests ≤ 30-day reauthentication (SHOULD) — deviation deliberate. |
| D13 | Session = device row | `devices` is the session table, rebuilt with `account_id NOT NULL` (no default). `mintDevice(env, accountId, name, now)` requires the account | Reuses `authenticateDevice`. No silent attachment to account 1. |
| D14 | Local credential format | **Unchanged**: `plaenicke.auth` = `base64url(sessionToken ‖ DEK)` | `sync.js` and its invariants run unmodified. |
| D15 | Login enters via adoption | One exported entry `linkAndAdopt(code, {accountId})` in `linkui.js`, run through `runAdoption` | Keeps cross-mount exclusion and the preview. Re-renders the Sync section. |
| D16 | Local data owner | Device-local `plaenicke.localOwner` = account id, written at link. Signing in to a **different** account while the device holds items or feeds is **blocked** with an explanation | Without it, sign-out-keeps-data + Merge copies one person's planner (feed capability URLs included) into another's account. |
| D17 | Login only when unlinked | The login / sign-up screens are reachable only on an unlinked device | Stops overwriting `plaenicke.auth` and orphaning a never-expiring session. |
| D18 | Wrap integrity | Before any wrap upload (sign-up excepted), the client GETs `/data` and must decrypt it with its DEK (`blob === ''` skips). Server also stores `dek_check = HMAC(DEK, 'plaenicke/v1/dek-check')`; every unwrap is verified against it | A device on the wrong key (the known 43-char bootstrap mistake) must never become the account's wrapped key. |
| D19 | Smart-add cap | **50 calls / account / UTC day**, `day` captured once per request, slot taken **before** the Claude call | ESTIMATE ~$0.002/call; 10 × 50 = ~$1/day typical, $11/day worst case. Console spend cap stays the outer bound. Failed calls consume a slot. |
| D20 | `/feed` | Token required after OPTIONS + Origin checks and **before** `cache.match`; `authorization` added to allow-headers; `Access-Control-Max-Age: 86400` | Closes the open proxy. Max-Age keeps preflights off every refresh. |
| D21 | Signed-out app | Local planner works signed out; calendar feeds and smart add need an account | Alex (punchlist L31 folded in). |
| D22 | Admin | `ADMIN_SECRET` endpoints: invites, accounts list, disable, delete, **email correction** | Alex chose option A; email fix because a typo'd login is otherwise permanent. |
| D23 | Invites | 16 random bytes; SHA-256 stored; `used_at` consumed in the sign-up batch (`WHERE used_at IS NULL AND revoked_at IS NULL`) | Survives account deletion. |
| D24 | Invite delivery | Alex sends the code; tester pastes it **in the installed app**. Links `…/#invite=<code>` also work | On iOS a link opens Safari, whose storage is separate from the home-screen app (to verify on device). |
| D25 | Custom domain | Not in this spec; **required before Alex publishes any second GitHub Pages site** | One account's `*.github.io` sites share one origin and `localStorage`. `plaenicke` is the only Pages repo (verified 2026-11-11). Post-accounts, a domain move costs one sign-in. Money ⇒ Alex's call. |
| D26 | DEK on device | Stays in `localStorage` (as today) | A non-extractable IndexedDB key changes the credential path every sync invariant depends on, and does not stop XSS from using the key. Revisit with the domain. |
| D27 | Sign-out | Revoke this session if reachable; always clear `plaenicke.auth`; local data stays. Offline ⇒ "This device's session could not be revoked — use *Sign out other devices* from another device." Never refuses. linkui's *Unlink* routes here for account devices | One path; matches `unlink()`'s keep-data invariant (`js/auth.js:11`). |

## 4. Cryptography (CONCRETE — WebCrypto calls named)

### 4.1 Client derivations — new module `js/keys.js` (pure, async, no storage/DOM)

```
pwKey     = importKey('raw', utf8(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
masterKey = deriveBits({name:'PBKDF2', hash:'SHA-256', salt: kdfSalt, iterations: kdfIters /* ≥ 600000 */}, pwKey, 256)
hk        = importKey('raw', masterKey, 'HKDF', false, ['deriveBits','deriveKey'])
authKey   = deriveBits({name:'HKDF', hash:'SHA-256', salt: zero32, info: utf8('plaenicke/v1/auth')}, hk, 256)
pwWrapKey = deriveKey ({…, info: utf8('plaenicke/v1/wrap')}, hk, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt'])

rk         = importKey('raw', recoveryCodeBytes /*16*/, 'HKDF', false, ['deriveBits','deriveKey'])
recAuthKey = HKDF(rk, 'plaenicke/v1/rec-auth') → 256 bits
recWrapKey = HKDF(rk, 'plaenicke/v1/rec-wrap') → AES-GCM-256

wrappedDekPw  = base64(iv12 ‖ AES-GCM(pwWrapKey,  iv12, DEK, AAD 'plaenicke/v1/dek-pw'))
wrappedDekRec = base64(iv12 ‖ AES-GCM(recWrapKey, iv12, DEK, AAD 'plaenicke/v1/dek-rec'))
dekCheck      = hex(HMAC-SHA-256(DEK, 'plaenicke/v1/dek-check'))
```

`js/crypto.js` (blob encryption, link-code encoding) is unchanged.

### 4.2 Server storage per account

`kdf_salt`, `kdf_iters`, `auth_mac = HMAC(macKey, authKey)`, `rec_auth_mac = HMAC(macKey, recAuthKey)`, `wrapped_dek_pw_sealed`, `wrapped_dek_rec_sealed`, `dek_check`, where `seal(x) = 'k1:' ‖ base64(iv12 ‖ AES-GCM(sealKey, iv12, x, AAD column ‖ '|' ‖ accountId))`. The AAD uses the immutable account id (read from the row), so the email can be corrected.

### 4.3 Worker cost

Per login: HKDF subkeys (cacheable per isolate), one HMAC, a constant-time compare, one AES-GCM unseal of < 100 bytes; three D1 statements (attempt reservation, reset, device insert in a batch). No stretching on the Worker.

### 4.4 Exposure, stated

- **D1 + Worker secrets stolen:** one 600k-iteration PBKDF2 per guess, ~14,800 guesses/s per RTX 4090 (ESTIMATE, linear scaling of hashcat's 999-iteration benchmark). Random 8-char lowercase ≈ 164 days/GPU; a human-chosen 8-char password on a cracking list falls fast. Mitigations: blocklist, D5, D3 floor.
- **D1 alone stolen:** no guess oracle (MACs keyed, wraps sealed).
- **Code trust:** Alex controls the JS origin, so a malicious client release could exfiltrate keys. "The server cannot read data" holds for the server's stored state, not against a hostile client deploy.

## 5. Migration `worker/migrations/0002_accounts.sql`

```sql
CREATE TABLE accounts (
  id                     INTEGER PRIMARY KEY,
  email                  TEXT UNIQUE COLLATE NOCASE,   -- NULL only for legacy account 1 before upgrade
  kdf_salt               TEXT,
  kdf_iters              INTEGER,
  auth_mac               TEXT,
  rec_auth_mac           TEXT,
  wrapped_dek_pw_sealed  TEXT,
  wrapped_dek_rec_sealed TEXT,
  dek_check              TEXT,
  invite_hash            TEXT UNIQUE,                  -- NULL for legacy account 1
  recovery_confirmed_at  TEXT,
  created_at             TEXT NOT NULL,
  disabled_at            TEXT,
  failed_logins          INTEGER NOT NULL DEFAULT 0,
  locked_until           TEXT
);
INSERT INTO accounts (id, created_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- devices: rebuilt (ADD COLUMN … NOT NULL REFERENCES is illegal with FKs on).
CREATE TABLE devices_v2 (
  token_hash   TEXT PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
INSERT INTO devices_v2 (token_hash, account_id, name, created_at, last_seen_at)
  SELECT token_hash, 1, name, created_at, last_seen_at FROM devices;
DROP TABLE devices;
ALTER TABLE devices_v2 RENAME TO devices;

-- data: rebuilt to drop CHECK (id = 1). The key column KEEPS the name `id`
-- (= account id) so the deployed Worker's `WHERE id = 1` keeps working for
-- Alex until the new Worker ships.
CREATE TABLE data_v2 (
  id         INTEGER PRIMARY KEY REFERENCES accounts(id),
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO data_v2 (id, version, blob, updated_at) SELECT id, version, blob, updated_at FROM data;
DROP TABLE data;
ALTER TABLE data_v2 RENAME TO data;

CREATE TABLE invites (hash TEXT PRIMARY KEY, note TEXT, created_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT);
CREATE TABLE usage (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  day TEXT NOT NULL, calls INTEGER NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- 'key-check' written on first use
```

- `fake-d1.js` loads every migration in order with foreign keys **on**, and gains `batch()` backed by real `BEGIN`/`COMMIT`/`ROLLBACK`.
- First worker task proves: the migration runs on a populated `0001` database; Alex's `data` row and `devices` survive byte-identical; the **old** `data.js` queries still work against the migrated schema.
- **SPECULATIVE until verified in the plan:** that `wrangler d1 migrations apply` runs a file atomically on D1. Mitigation regardless: both of Alex's devices are closed during the migration (§ 10).

## 6. Flows

### 6.1 Sign-up (invited tester, on an unlinked device)

1. Tester pastes the invite in Settings → Account → *I have an invite* (or opens `…/#invite=<code>`; `js/fragment.js` reads and `replaceState`s it away at boot; **no network call on load**).
2. Email + password + confirm; D10 policy shown live. Forms carry `autocomplete="username"` / `"new-password"` so iCloud Keychain offers to save.
3. Device: `kdfSalt`, derive (§ 4.1), `DEK = generateEncKey()`, `R = random16`, wrap twice, `dekCheck`.
4. `POST /auth/signup {invite, email, kdfSalt, kdfIters, authKey, recAuthKey, wrappedDekPw, wrappedDekRec, dekCheck, deviceName}`.
5. Worker picks a **random account id** first (`id = 2 + random 52-bit integer` from `crypto.getRandomValues`; collision ⇒ the batch fails on the primary key and the handler retries once with a new id), seals both wraps with that id in the AAD, then runs **one `batch()`** keyed on a per-request `nonce` (`<ISO time>|<uuid>`):
   1. `UPDATE invites SET used_at = ?nonce WHERE hash = ? AND used_at IS NULL AND revoked_at IS NULL`
   2. `INSERT INTO accounts (id, email, …, wrapped_dek_pw_sealed, wrapped_dek_rec_sealed, invite_hash, created_at) SELECT ?id, ?, …, hash, ? FROM invites WHERE hash = ? AND used_at = ?nonce` — inserts nothing unless step 1 claimed the invite **in this request**.
   3. `INSERT INTO data (id, version, blob, updated_at) SELECT a.id, 0, '', ? FROM accounts a JOIN invites i ON i.hash = a.invite_hash WHERE i.hash = ? AND i.used_at = ?nonce`
   4. `INSERT INTO devices (token_hash, account_id, name, created_at) SELECT ?, a.id, ?, ? FROM accounts a JOIN invites i ON i.hash = a.invite_hash WHERE i.hash = ? AND i.used_at = ?nonce`

   Steps 3–4 are keyed on the nonce, never on the email, so a replayed used invite can never attach a device to someone else's account. They use `INSERT … SELECT`, never `VALUES ((SELECT …))` (a NULL into `INTEGER PRIMARY KEY` auto-assigns an id). The handler reads step 2's `changes`: 0 ⇒ 403 `invalid_invite`. Only a `UNIQUE` violation on `accounts.email` ⇒ 409 `email_taken`; any other constraint error ⇒ 500. Else `{token, accountId}`. The whole sign-up is atomic.
6. Device: `linkAndAdopt(composeLinkCode(token, DEK), {accountId})` — **link first**, so the credential is persisted before anything can evict the app.
7. Recovery screen: the code, *Email it to me*, *Copy*, *Download*; *Done* is enabled after ticking "I saved my recovery link" and calls `POST /account/recovery/confirm`. If the app is evicted or the tester leaves, D8's banner reappears on every device until confirmed. If the code itself was lost before confirmation, the banner offers *Make a new recovery link* (§ 6.5).

### 6.2 Log in (unlinked device)

1. `POST /auth/prelogin {email}` → `{kdfSalt, kdfIters}` or 404 `no_account`. (No fake salt — for invited users the existence of an account is not a secret worth the code; D11 lockout already reveals it.)
2. Device refuses `kdfIters < 600000`; derives `authKey`, `pwWrapKey`.
3. `POST /auth/login {email, authKey, deviceName}`. Worker: `disabled_at` ⇒ 403 `disabled`; reserve an attempt:
   ```sql
   UPDATE accounts SET failed_logins = failed_logins + 1,
     locked_until = CASE WHEN failed_logins + 1 >= 50 THEN ?lockUntil ELSE locked_until END
   WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?now)
   RETURNING failed_logins;
   ```
   No row ⇒ 429 `locked {retryAt}`. Compare MAC (constant-time). Wrong ⇒ 401 `bad_credentials`. Right ⇒ batch: `failed_logins = 0, locked_until = NULL`; insert device. Returns `{token, accountId, wrappedDekPw, dekCheck, recoveryConfirmed}`.
4. Device unwraps; verifies `dekCheck` (mismatch ⇒ visible error, **not linked**); D16 owner check; `linkAndAdopt`.

### 6.3 Forgot password

1. `…/#recover=<R>` (or paste the code in *Forgot password*). Hash stripped at boot; "Reset your password" form; **no network call until submit**.
2. `POST /auth/recover/start {email, recAuthKey}` → `{wrappedDekRec, dekCheck, accountId}` (not lockout-counted; 401 `bad_recovery` on mismatch).
3. Device unwraps, verifies `dekCheck`, derives new password material and `R′`.
4. `POST /auth/recover/finish {email, recAuthKey, kdfSalt, kdfIters, authKey, recAuthKey2, wrappedDekPw, wrappedDekRec2, deviceName}` → **one batch**: `UPDATE accounts SET <6 credential cols>, recovery_confirmed_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = ? AND rec_auth_mac = ?old`; `DELETE FROM devices WHERE account_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND rec_auth_mac = ?new)`; insert device. Handler checks `changes` of the UPDATE (0 ⇒ 409 `recovery_changed`). Returns `{token}`.
5. `linkAndAdopt` (D16 applies), then the recovery screen for `R′`.

### 6.4 Change password (signed in)

Current + new password (+ "also sign out other devices"). D18 decrypt-check. `POST /account/password {currentAuthKey, kdfSalt, kdfIters, authKey, wrappedDekPw, signOutOthers}` — current key verified through the D11 reservation; `UPDATE … WHERE id = ? AND auth_mac = ?old`; optional device delete in the same batch.

### 6.5 Make a new recovery link (signed in)

Password required. D18 decrypt-check. `POST /account/recovery {currentAuthKey, recAuthKey, wrappedDekRec}` replaces the two columns and clears `recovery_confirmed_at`; recovery screen; confirm.

### 6.6 Devices and sign-out

`GET /account` → `{email, recoveryConfirmed}`; `GET /account/devices` → `[{name, createdAt, lastSeenAt, current}]`; `POST /account/devices/signout-others`; `POST /auth/logout`. Sign-out per D27.

### 6.7 Alex's upgrade (legacy account 1)

Settings → Account shows **Create your login** when `GET /account` returns `{email: null}`.

1. Email + password. D18 decrypt-check of the live blob with the device's `encKey`.
2. `POST /account/upgrade {email, kdfSalt, kdfIters, authKey, recAuthKey, wrappedDekPw, wrappedDekRec, dekCheck}` (bearer = existing token): `UPDATE accounts SET … WHERE id = ? AND email IS NULL` (0 changes ⇒ 409 `already_upgraded`).
3. Device writes `plaenicke.localOwner = 1`; recovery screen; confirm.
4. Same token, same DEK, same blob: `resetSyncStateIfDeviceChanged` keys on the token hash (`js/auth.js:82-86`), so adoption is **not** re-raised. The second phone keeps syncing; it gets `localOwner = 1` on its next `GET /account`.

### 6.8 Smart add and `/feed`

- Linked clients send `Authorization: Bearer <token>`; signed out they show "Sign in to use smart add / calendars".
- `authenticateDevice` joins `accounts` and rejects disabled accounts; returns `{tokenHash, accountId}`.
- **Smart add:** `day = utcDay(now)` once; `INSERT INTO usage (account_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (account_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < 50 RETURNING calls` — no row ⇒ 429 `daily_limit {resetsAt}`. After Claude replies, add `usage.input_tokens/output_tokens` to the same `(account, day)`. **RETURNING on D1: SPECULATIVE until a local test and the Phase-1 deploy prove it.** Client codes: `limit` → "You've used today's smart adds. They reset at <local time>. You can still add it by picking a date."; `unauthorized` → "Signed out — sign in again".
- **`/feed`:** OPTIONS and Origin checks first; then token; then `cache.match`. Cache key stays the target URL.

### 6.9 Admin (`docs/admin.md` curl recipes)

`POST /admin/invite {note}` → `{invite}` once · `DELETE /admin/invite {hashPrefix}` · `GET /admin/accounts` → `[{id, email, createdAt, lastSeenAt, devices, smartAddToday, recoveryConfirmed, disabled}]` · `POST /admin/account/disable {id, disabled}` (disabling deletes device rows in the same batch) · `POST /admin/account/email {id, email}` · `DELETE /admin/account {id, confirm: email}` (one batch: usage, devices, data, account). `POST/DELETE /admin/device` stay as legacy and take an explicit `accountId`.

### 6.10 Revoked and switching devices

- A device whose session was deleted (recovery, *sign out others*, disable) gets 401 on sync; the existing indicator lights (`js/sync.js:234,319`); linkui's copy for account devices reads "This device was signed out. Sign in again." with a *Sign in* button that first runs D27 sign-out locally, then shows the login form.
- **Signing in as a different account** on a device that holds items or feeds is blocked (D16): "This device holds another account's planner. Signing in here would copy it into that account." Clearing a device for a new owner is out of scope; Alex must not test with a throwaway account on a device holding his own data.

### 6.11 linkui for account devices

*Link another device* is hidden; the paste field is hidden; *Unlink* becomes *Sign out* (D27). Legacy (no `localOwner`, `email: null`) devices keep today's UI until upgraded.

## 7. Modules

| Module | Change |
|---|---|
| `js/keys.js` (new) | § 4.1. |
| `js/password-policy.js` + `js/common-passwords.js` (new) | D10; blocklist = policy-passing entries from SecLists' common-credentials lists (MIT), size measured in the plan (target < 100 KB). |
| `js/account.js` (new) | Network calls for § 6, `fetchImpl` injected; returns link codes, never writes storage. |
| `js/accountui.js` (new) | Account section, sign-up / login / reset / recovery screens, banner. |
| `js/fragment.js` (new) | `#invite=` / `#recover=` at boot, `replaceState`. |
| `js/linkui.js` | Export `linkAndAdopt`; account-aware copy; D16 guard; D27 sign-out routing; § 6.11. |
| `js/storage.js` | `plaenicke.localOwner` (device-local, never synced). |
| `js/smartadd.js`, `js/feeds.js` | Bearer header; `limit` / `unauthorized`. |
| `js/settings.js` | Mounts Account above Sync. |
| `service-worker.js` | New modules in `ASSETS`; `CACHE` bump (check other branches). |
| Worker | `accounts.js`, `seal.js`, `usage.js` (new); `auth.js` (`authenticateDevice` → `{tokenHash, accountId}`, joins accounts; `mintDevice` takes `accountId`); `data.js` (`WHERE id = ?accountId`, fail-closed `not_initialised` kept); `feed.js` (auth before cache, allow-headers, Max-Age); `index.js` routes; `REQUIRE_SESSION` flag for the phased release. |

## 8. Error handling (zero fallback)

Typed `{error}` per failure, each mapped to a specific client message; unwrap or `dekCheck` failure ⇒ not linked + visible error; `AT_REST_KEY` missing ⇒ 500 `not_configured`, wrong ⇒ 500 `at_rest_key_mismatch`; batches roll back whole; no "missing row ⇒ empty" fallback anywhere.

## 9. Testing

- **Worker** (real `node:sqlite`, all migrations, FKs on, transactional `batch`): migration from a populated `0001`; old `data.js` queries against the migrated schema; signup (invite reuse, reuse after account deletion, revoked, duplicate email, batch rollback when any statement fails); login (lockout at exactly 50 under concurrent requests, 1 h unlock with injected `now`, disabled); recover start/finish (single-use, concurrent finish, devices deleted only when the UPDATE landed, lockout exempt); password change and new recovery (`changes` checked); upgrade (once, legacy only); usage cap (50 ok, 51 → 429, UTC rollover, same-day token update); `/feed` and smart add 401 without token and **cached feed not served without token**; OPTIONS unaffected; `REQUIRE_SESSION=false` accepts tokenless; admin routes; `at_rest_key_mismatch`.
- **Client:** `keys.js` vectors (RFC 6070-style PBKDF2-SHA-256 and RFC 5869 HKDF via WebCrypto in Node); iteration floor; policy table; `account.js` with a fake server; fragment stripping; D16 owner guard; D18 decrypt-check refusing a wrong-key device.
- **End-to-end:** sign up on A, log in on B, both converge through real `sync.js` against real Worker handlers (`worker.fetch` + `fake-d1`); Alex upgrade with a second linked device that keeps syncing; recovery signs B out and B shows "signed out — sign in again".
- **Mutation checks:** every lockout, single-use, auth-before-cache, owner-guard and decrypt-check test proven to fail with its guard removed.
- **Alex-run:** PBKDF2 timing on his iPhone; D1 RETURNING and batch on the Phase-1 deploy; Safari-vs-PWA storage separation (D24).

## 10. Release (Alex-run; none of it done by the autonomous run)

**Phase 1 — tolerant Worker** (`REQUIRE_SESSION=false`):
1. Close plaenicke on both devices.
2. `wrangler d1 export plaenicke --remote --output backup-<date>.sql` and note a Time Travel bookmark (`wrangler d1 time-travel info plaenicke`).
3. `wrangler secret put AT_REST_KEY`; store a second copy in the password manager.
4. `wrangler d1 migrations apply plaenicke --remote` (`worker/README.md:74-79`).
5. Deploy the Worker (new routes; bearer accepted, not required; feed allow-headers include `authorization`); bump `version.js`; `curl /version`. Reopen both devices; confirm sync.

**Phase 2 — client** (merge to `main`): sends bearer, Account UI. Wait until both devices show the new `CACHE`.

**Phase 3 — require sessions:** `REQUIRE_SESSION=true`, bump `version.js`, deploy, `npm run smoke:worker` (updated to send a token).

**Then:** list account-1 devices (`GET /admin/accounts`), revoke any unrecognised; upgrade (§ 6.7) on one device; confirm the other still syncs; mint invites. Tester instructions: install to the home screen first, paste the invite in the app, save the recovery link; lost password **and** recovery link = data gone; don't sign in on shared computers.

**Rollback:** safe to roll the Worker back to the pre-V7 version only **before the first invite** (the old `authenticateDevice` serves `data WHERE id = 1` to any token). After that, roll forward.

## 11. Open risks

PBKDF2 time on iPhone Safari (SPECULATIVE; WebKit bug 277601) · Safe Links may carry the full recovery URL to Microsoft (SPECULATIVE; mitigated by D9) · shared `github.io` origin until the domain (D25) · a signed-out device keeps downloaded data (only DEK rotation cuts it off) · lost password **and** recovery link ⇒ unrecoverable · Workers Free's 100k requests/day is shared by every route; unauthenticated `/auth/*` can be spammed (pre-existing exposure via public smart add today) · D1 migration atomicity (SPECULATIVE; mitigated by closing the app).

## 12. Changes from draft `fd48fea`

C1 devices rebuild · C2 keep `data.id` · I1 three-phase release + Max-Age · I2 link-first + server `recovery_confirmed_at` · I3 D16 owner guard · I4 `linkAndAdopt` · I5 single sign-out, account-aware copy · I6 `batch()`, no empty fallback · I7 D18 decrypt-check + `dek_check` · I8 atomic attempt slot, recovery exempt · I9 key id, key-check, HKDF subkeys, second copy (dual-key rotation dismissed: no trigger in a 10-person test; the key id keeps it addable) · I10 account-id AAD + admin email fix · I11 `invites.used_at` · I12 600k floor + code-trust note · I13 Time Travel + rollback rule · I14 close apps during migration · sparring: Download option, autocomplete · O1 fake salt cut · O2 day captured once · O3 auth after OPTIONS/Origin · O5 device id dropped · O6 disabled join · O7 install-first · O9 `mintDevice(accountId)` · O10 audit account-1 devices · O11 sign-out-others on password change · O13 login only when unlinked.
