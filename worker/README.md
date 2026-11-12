# plaenicke-worker

A Cloudflare Worker that does three unrelated things behind one origin:
proxies ICS calendar feeds, runs the smart-add prompt against Claude, and
holds one opaque, client-encrypted sync blob per account in D1 behind device-token auth.
Accounts are invite-only (V7); see `docs/admin.md` for admin recipes and the release checklist.

## Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `GET /feed?url=…` | GET | Origin header must equal `ALLOWED_ORIGIN`; a device token as well when `REQUIRE_SESSION` is on (checked before the edge cache) | ICS proxy, SSRF-hardened, 15 min edge cache |
| `/feed` | anything but GET/OPTIONS | Origin header must equal `ALLOWED_ORIGIN` | 405 `method_not_allowed` |
| `POST /` | POST | none while `REQUIRE_SESSION` is tolerant; `Bearer <device token>` when it is on. A token, when sent and valid, is counted against its account's 50 per UTC day either way | Smart-add via Claude Haiku |
| `GET /data` | GET | `Bearer <device token>` | Fetch `{version, blob}` |
| `PUT /data` | PUT | `Bearer <device token>` | Compare-and-swap `{version, blob}` |
| `/data` | anything but GET/PUT/OPTIONS | `Bearer <device token>` (checked first — a bad/missing token still 401s) | 405 `method_not_allowed` once authenticated (`OPTIONS` never reaches here — it is answered as an unauthenticated 200 preflight before pathname dispatch) |
| `POST /admin/device` | POST | `Bearer <ADMIN_SECRET>` | Mint a device token (returned once) |
| `DELETE /admin/device` | DELETE | `Bearer <ADMIN_SECRET>` | Revoke by `token_hash` |
| `/admin/device` | anything but POST/DELETE/OPTIONS | `Bearer <ADMIN_SECRET>` (checked first — unauthenticated callers get 401, not a hint about which methods exist) | 405 `method_not_allowed` once authenticated (`OPTIONS` never reaches here — it is answered as an unauthenticated 200 preflight before pathname dispatch) |
| `POST /auth/signup`, `/auth/prelogin`, `/auth/login`, `/auth/recover/start`, `/auth/recover/finish` | POST | none (public; 50 consecutive failed password checks lock an account for 1 hour, recovery routes exempt) | Invite sign-up, login, recovery |
| `POST /auth/logout` | POST | `Bearer <device token>` | End this device's session |
| `GET /account` | GET | `Bearer <device token>` | Account state (`email` is `null` for an un-upgraded legacy account) |
| `POST /account/password`, `/account/recovery` | POST | `Bearer <device token>` plus the current password's `currentAuthKey`; 10 failed checks lock that device's password checks for 1 hour (`devices.failed_pw`), never the anonymous login counter | Change password, new recovery link |
| `POST /account/recovery/confirm` | POST | `Bearer <device token>`; body `{recAuthKey}` of the code on screen | Confirm the saved recovery link; 409 `recovery_changed` when the account's recovery key is no longer that code's |
| `POST /account/upgrade` | POST | `Bearer <device token>` plus a one-time `upgradeCode` from `POST /admin/upgrade-code` | Upgrade legacy account 1 (403 `invalid_upgrade_code`, 409 `already_upgraded`) |
| `POST /account/devices/signout-others` | POST | `Bearer <device token>` | Sign out other devices |
| `GET /account/devices` | GET | `Bearer <device token>` | List this account's devices |
| `POST /admin/invite`, `DELETE /admin/invite` | POST/DELETE | `Bearer <ADMIN_SECRET>` | Mint / revoke an invite |
| `GET /admin/accounts` | GET | `Bearer <ADMIN_SECRET>` | List accounts |
| `POST /admin/account/disable`, `POST /admin/account/email`, `DELETE /admin/account` | POST/DELETE | `Bearer <ADMIN_SECRET>` | Disable, correct email, delete |
| `POST /admin/upgrade-code` | POST | `Bearer <ADMIN_SECRET>` | Mint a one-time code (24 h) that `/account/upgrade` requires |
| `GET /version` | GET | none | Deploy marker `{version}` from `src/version.js` |
| anything else | — | — | 404 `not_found` |

`POST /admin/device` now requires `accountId` in the body. Request and response
shapes for every admin route are in `docs/admin.md`.

### Secrets and variables

| Name | Kind | Purpose |
|---|---|---|
| `ADMIN_SECRET` | secret | Bearer for every `/admin/*` route: devices, invites, accounts, disable, email, delete, upgrade codes. |
| `ANTHROPIC_API_KEY` | secret | Smart add's key for the Claude API (`POST /`). |
| `AT_REST_KEY` | secret | 32 bytes base64url (43 characters). Seals the stored password and recovery wraps and MACs the stored auth keys (`src/seal.js`). Missing or not 32 bytes: the account routes (`/auth/*`, `/account/*`) answer 500 `not_configured`. A different key from the one that first ran: they answer 500 `at_rest_key_mismatch` (a `config` row holds the key check). `/data` sync, smart add and `/feed` never read it. Keep a second copy in a password manager; sealed values cannot be read without it. Set with `printf '%s' "$K" \| npx wrangler secret put AT_REST_KEY` (`docs/admin.md`, Phase 1). |
| `REQUIRE_SESSION` | var, in `wrangler.toml` `[vars]` only | `true` or `"true"`: `GET /feed` and smart add (`POST /`) require a device token (401 `unauthorized` without one). `false`, `"false"` or unset: tolerant, a valid bearer is counted when sent but not required, and an unknown one is served as anonymous. Any other value (`"1"`, `"TRUE"`, …): the real `GET /feed` and `POST /` answer 500 `bad_config`; OPTIONS and the Origin check are unaffected. Never set it in the dashboard or with `--var`: `wrangler deploy` overwrites dashboard variables unless `keep_vars = true` (developers.cloudflare.com/workers/wrangler/configuration/, "Source of truth", fetched 2026-11-12), so it would silently vanish on the next deploy. `tests/wrangler-config.test.js` pins both. |

Smart add is capped at 50 calls per account per UTC day (429 `daily_limit` with `resetsAt`).

`GET /feed` is dispatched before the shared CORS/OPTIONS handling and answers
its own preflight with a narrower `Access-Control-Allow-Methods: GET, OPTIONS`
and its own header allowlist (`content-type, cache-control, authorization` —
the client sends its device token as a bearer, and a required `REQUIRE_SESSION`
makes the feed route demand it). `/`, `/data`, the `/auth/*`, `/account/*`
and `/admin/*` routes share one CORS policy from `cors.js`
(`GET, POST, PUT, DELETE, OPTIONS` / `content-type, authorization`).

`/data` and `/admin/device` both check auth before checking method, so an
unsupported verb never leaks past a 401 for an unauthenticated caller.
`/admin/device` also checks method before reading the request body, so a
bodiless request to an unsupported method gets a real 405 instead of a
misleading `bad_json`.

### Error shapes worth knowing about

- `PUT /data` on a version mismatch returns `409` with the server's current
  `{version, blob}` in the body, not just an error code — the client is
  expected to merge and retry against that state rather than re-fetch.
- `PUT /data` enforces a `blob` size cap (`MAX_BLOB_BYTES` in `src/data.js`,
  currently 1,000,000 **bytes** of UTF-8, not characters — D1's row limit is
  2 MB and one CJK character is 3 bytes) and returns `413 blob_too_large` if
  exceeded, with the cap echoed back as `max` (a byte count).
- Any unhandled exception below the `/feed` dispatch — a D1 outage, say —
  returns `500 internal_error` **carrying the normal CORS headers**, so the
  browser can read it. Cloudflare's own 1101 exception page carries none, and
  the client would see an opaque `TypeError` indistinguishable from being
  offline. `src/index.js` logs only the error's name and message for these,
  never the request or the blob. Catching also suppresses Cloudflare's
  automatic exception logging, so that `console.error` is the only remaining
  signal — `[observability] enabled = true` in `wrangler.toml` is what makes
  it visible in Workers Logs.
- `GET /feed` returns `403 forbidden` for any request whose `Origin` header
  doesn't match, `500 bad_config` for a malformed `REQUIRE_SESSION`,
  `401 unauthorized` without a valid token while the flag is on,
  `400 bad_url` for a missing/invalid/private-host target,
  `413 feed_too_large` over 1 MB, and `422 not_an_ics_feed` if the body
  doesn't start with `BEGIN:VCALENDAR`.

### Account and configuration error codes

Read from `src/accounts.js`, `src/admin.js`, `src/seal.js` and `src/index.js`. All are `{"error":"<code>"}`.

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | A missing or malformed field. Includes `kdfIters` outside 600,000–10,000,000, and recover/finish with the same new recovery key as the old one. |
| 401 | `bad_credentials` | Wrong password key, or the password changed between the check and the session insert. |
| 401 | `bad_recovery` | Wrong recovery key or unknown email on `/auth/recover/*` (never counted toward lockout). |
| 401 | `unauthorized` | No, unknown or revoked device token on a bearer route. |
| 403 | `disabled` | Account disabled; reported only after a correct key. (`POST /admin/device` for a disabled account answers 409 `disabled`.) |
| 403 | `invalid_invite` | Invite unknown, used or revoked. |
| 403 | `invalid_upgrade_code` | Upgrade code unknown, used, expired, or for another account. |
| 404 | `no_account` | Unknown email (prelogin, login) or unknown account id (admin routes). Login answers it too, by design: existence is not secret for invited users (spec § 6.2). |
| 409 | `email_taken` | Sign-up, upgrade or admin email correction to an email already in use. |
| 409 | `already_upgraded` | Upgrade or upgrade-code mint for an account that has an email. |
| 409 | `password_changed` | The password changed on another device while this change was in flight. |
| 409 | `recovery_changed` | Recovery confirm or recover/finish raced a newer recovery link. |
| 409 | `no_password` | Password-gated route on a legacy account with no password. |
| 429 | `locked` | 50 failed logins (account) or 10 failed bearer password checks (device); `retryAt` is never null. |
| 429 | `daily_limit` | Smart-add cap; `resetsAt` is the next 00:00 UTC. |
| 500 | `not_configured` | `AT_REST_KEY` missing or not 32 bytes. |
| 500 | `at_rest_key_mismatch` | `AT_REST_KEY` differs from the key that first ran. |
| 500 | `bad_seal` | A stored sealed value failed to unseal (tampering, wrong column/account, corruption). Login mints no session first. |
| 500 | `bad_config` | `REQUIRE_SESSION` is neither true nor false. |

Admin-only codes (`not_found`, `ambiguous`, `already_used`, `not_upgraded`, `confirm_mismatch`) are listed per route in `docs/admin.md`.

The client adds its own codes that never come from the Worker, among them `kdf_iters_out_of_range` (prelogin asked for more than 10,000,000 iterations; `js/keys.js` refuses before running PBKDF2) and `kdf_iters_too_low`. Every account request from the client has a 30 s deadline (`js/account.js` `ACCOUNT_TIMEOUT_MS`) and reports a timeout as `unreachable`.

## One-time setup

`database_id` in `wrangler.toml` is already set to the production D1
database, so the deployed Worker needs none of this. The steps below are for
standing the Worker up from scratch under a different Cloudflare account: the
first command creates the database, and its returned id replaces the one in
`wrangler.toml`.

```bash
cd worker
npx wrangler d1 create plaenicke        # put the returned database_id in wrangler.toml
npx wrangler d1 migrations apply plaenicke --remote
npx wrangler secret put ADMIN_SECRET       # paste a generated secret at the prompt — see below
npx wrangler secret put ANTHROPIC_API_KEY  # paste the key from the Anthropic Console
npx wrangler secret put AT_REST_KEY        # 32 random bytes, base64url; generate it like ADMIN_SECRET below, keep a second copy
npx wrangler deploy
```

`migrations apply` rather than `d1 execute --file=`: `migrations/` is already
wrangler's default `migrations_dir` and `0001_init.sql` already matches the
required `NNNN_name.sql` convention, so this works with no config change and
records what ran in D1's own `d1_migrations` table. `--file=` does not, which
would leave later migrations with no record of what production has already
applied. Check state with:

```bash
(cd worker && npx wrangler d1 migrations list plaenicke --remote)   # unapplied migrations only
```

Verified against wrangler 4.118.0: `migrations list` picks up
`migrations/0001_init.sql` with no `migrations_dir` set, and after `apply` the
file is recorded in `d1_migrations`.

### Generating `ADMIN_SECRET`

`isAdmin` (`src/auth.js`) compares the bearer token to `ADMIN_SECRET` in
full — it does not enforce a minimum length. A short or guessable secret is
brute-forceable over the network; the Worker has no rate limiting on
`/admin/*`, so this is the only thing standing between the internet and
minting device tokens, invites and upgrade codes, and disabling or deleting
accounts. Generate a long random secret yourself:

```bash
# 32 random bytes, base64url — generate one and keep it in a password manager
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Verified output shape: 43 characters, alphabet `[A-Za-z0-9_-]`, no padding.
The secret is never returned in any response and never logged — treat it the
same as the Anthropic API key.

## Minting a device token

```bash
curl -X POST https://<worker-host>/admin/device \
  -H "authorization: Bearer $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"accountId":1,"name":"laptop"}'
```

`accountId` is required (400 `bad_request` without it, 404 `no_account` for an
unknown id, 409 `disabled` for a disabled account). All admin recipes are in
`docs/admin.md`. On account 1, mint only after its upgrade (`docs/admin.md`,
release-window rule 2). A raw 43-character token is right only for an account's very first device:
`linkWithCode` treats it as a bootstrap and mints a fresh, empty encryption
key, so never paste one (a smoke token included) into a device of an existing
account (CLAUDE.md, Device linking).

Response: `{"token": "...", "name": "laptop"}`.

The token is shown **once** and is not recoverable: `devices` stores only
its SHA-256 hex (`token_hash` — `src/auth.js`), never the plaintext. If it's
lost, mint a replacement and revoke the old row (see below) — there is no
"show me the token again" path, by design.

## Revoking a device token

`DELETE /admin/device` takes a `token_hash`, not the plaintext token:

```bash
curl -X DELETE https://<worker-host>/admin/device \
  -H "authorization: Bearer $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"token_hash":"<sha256 hex>"}'
```

There is no HTTP route that lists devices or looks up a token's hash
(`GET /admin/accounts` returns only a device count; the device routes are in
`handleAdminDevice`, `src/admin.js`). Two ways to get the hash:

- **You still have the plaintext token.** Hash it yourself — the algorithm
  is exactly lowercase-hex SHA-256 of the token string
  (`sha256Hex` in `src/auth.js`):
  ```bash
  printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1
  ```
- **You don't have the token** (e.g. revoking a device you can no longer
  reach). Query D1 directly for the row by name — `devices` has `account_id`,
  `name`, `created_at`, and `last_seen_at` alongside `token_hash`
  (`migrations/0002_accounts.sql`):
  ```bash
  (cd worker && npx wrangler d1 execute plaenicke --remote \
    --command "SELECT account_id, name, token_hash, last_seen_at FROM devices")
  ```

**Known gap:** if you never captured the token *and* can't identify the row
by name (e.g. two devices were minted with the same name), there is no API
path to disambiguate them — you're comparing `created_at`/`last_seen_at`
timestamps by eye in the D1 query output, or deleting both and re-minting.
The device routes are not a device management console.

## What the server does not know

`blob` is ciphertext under a per-account data key (DEK) that is generated and
held client-side. The Worker stores that DEK only wrapped twice — by a
password-derived key and by a recovery-code-derived key — and seals both wraps
with `AT_REST_KEY` (spec § 4.2). A D1 dump alone therefore yields no readable
calendar data, no stored feed URLs and no password-guessing oracle. A dump
**plus** the Worker secrets allows offline guessing of a password at one
600,000-iteration PBKDF2 per guess (spec § 4.4). The server does know each
account's email, device names, created/last-seen times and daily smart-add
counts, and `/feed` sees each feed URL in transit (it fetches it). Nothing in
`src/data.js` parses, validates, or logs blob contents, and `src/feed.js`
never logs its `url` query param, since a published-calendar URL is itself a
capability token. Don't add request-body logging to either route without
re-reading those two files' header comments first. Spec § 4.4 also states the
limit of all this: Alex controls the client's origin, so a hostile client
release could exfiltrate keys.

## Smart add exposure

`POST /` and `GET /feed` accept anonymous callers until `REQUIRE_SESSION =
"true"` is deployed from `wrangler.toml` (release Phase 3, `docs/admin.md`).
Until then, anonymous smart add is bounded only by the monthly spend cap set in
the Anthropic Console; sessions are capped at 50 per account per UTC day in
every phase.
