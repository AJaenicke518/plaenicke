# plaenicke-worker

A Cloudflare Worker that does three unrelated things behind one origin:
proxies ICS calendar feeds, runs the smart-add prompt against Claude, and
holds one opaque, client-encrypted sync blob in D1 behind device-token auth.

## Routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `GET /feed?url=…` | GET | Origin header must equal `ALLOWED_ORIGIN` | ICS proxy, SSRF-hardened, 15 min edge cache |
| `GET /feed` | anything but GET/OPTIONS | Origin header must equal `ALLOWED_ORIGIN` | 405 `method_not_allowed` |
| `POST /` | POST | none (public) | Smart-add via Claude Haiku |
| `GET /data` | GET | `Bearer <device token>` | Fetch `{version, blob}` |
| `PUT /data` | PUT | `Bearer <device token>` | Compare-and-swap `{version, blob}` |
| `/data` | anything but GET/PUT | `Bearer <device token>` (checked first — a bad/missing token still 401s) | 405 `method_not_allowed` once authenticated |
| `POST /admin/device` | POST | `Bearer <ADMIN_SECRET>` | Mint a device token (returned once) |
| `DELETE /admin/device` | DELETE | `Bearer <ADMIN_SECRET>` | Revoke by `token_hash` |
| `/admin/device` | anything but POST/DELETE | `Bearer <ADMIN_SECRET>` (checked first — unauthenticated callers get 401, not a hint about which methods exist) | 405 `method_not_allowed` once authenticated |
| anything else | — | — | 404 `not_found` |

`GET /feed` is dispatched before the shared CORS/OPTIONS handling and answers
its own preflight with a narrower `Access-Control-Allow-Methods: GET, OPTIONS`
and its own header allowlist (`content-type, cache-control` — no
`authorization`, since the feed route takes no bearer token). `/`, `/data`,
and `/admin/device` share one CORS policy from `cors.js`
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
- `PUT /data` enforces a `blob` size cap (`MAX_BLOB_CHARS` in `src/data.js`,
  currently 1,000,000 characters) and returns `413 blob_too_large` with the
  cap echoed back if exceeded.
- `GET /feed` returns `403 forbidden` for any request whose `Origin` header
  doesn't match, `400 bad_url` for a missing/invalid/private-host target,
  `413 feed_too_large` over 1 MB, and `422 not_an_ics_feed` if the body
  doesn't start with `BEGIN:VCALENDAR`.

## One-time setup

`database_id` in `wrangler.toml` is a placeholder
(`REPLACE_AFTER_wrangler_d1_create`) — it can't be filled in until the
database exists under your own Cloudflare account, so it stays a placeholder
in version control until you run the first command below.

```bash
cd worker
npx wrangler d1 create plaenicke        # copy the returned database_id into wrangler.toml
npx wrangler d1 execute plaenicke --remote --file=migrations/0001_init.sql
npx wrangler secret put ADMIN_SECRET    # paste a generated secret at the prompt — see below
npx wrangler deploy
```

### Generating `ADMIN_SECRET`

`isAdmin` (`src/auth.js`) compares the bearer token to `ADMIN_SECRET` in
full — it does not enforce a minimum length. A short or guessable secret is
brute-forceable over the network; the Worker has no rate limiting on
`/admin/device`, so this is the only thing standing between the internet and
minting/revoking device tokens. Generate a long random secret yourself:

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
  -d '{"name":"laptop"}'
```

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

There is no HTTP route that lists devices or looks up a token's hash — the
API surface is deliberately minimal (mint and revoke only; see
`src/index.js`'s `handleAdminDevice`). Two ways to get the hash:

- **You still have the plaintext token.** Hash it yourself — the algorithm
  is exactly lowercase-hex SHA-256 of the token string
  (`sha256Hex` in `src/auth.js`):
  ```bash
  printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1
  ```
- **You don't have the token** (e.g. revoking a device you can no longer
  reach). Query D1 directly for the row by name — `devices` has `name`,
  `created_at`, and `last_seen_at` alongside `token_hash`
  (`migrations/0001_init.sql`):
  ```bash
  npx wrangler d1 execute plaenicke --remote \
    --command "SELECT name, token_hash, last_seen_at FROM devices"
  ```

**Known gap:** if you never captured the token *and* can't identify the row
by name (e.g. two devices were minted with the same name), there is no API
path to disambiguate them — you're comparing `created_at`/`last_seen_at`
timestamps by eye in the D1 query output, or deleting both and re-minting.
This is a minimal admin surface, not a device management console.

## What the server does not know

`blob` is ciphertext. The encryption key is generated and held client-side
and never reaches this Worker, so a full database compromise yields no
readable calendar data and no feed URLs. Nothing in `src/data.js` parses,
validates, or logs blob contents — and `src/feed.js` explicitly never logs
its `url` query param either, since a published-calendar URL is itself a
capability token. Don't add request-body logging to either route without
re-reading those two files' header comments first.

## Not yet done

`POST /` (smart-add) is still public — no device token, no passphrase.
Abuse of it is bounded only by the monthly spend cap set in the Anthropic
Console. Requiring a device token there is sequenced last, deliberately,
in Plan 3, after sync is proven end-to-end — see spec § 9. This is an
accepted, tracked gap, not an oversight.
