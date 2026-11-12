# Admin notes

Everything here is Alex-run. Nothing in the V7 plan deployed, migrated production, or merged. Spec: `docs/superpowers/specs/2026-11-11-plaenicke-accounts-design.md` (§ 6.9 admin, § 10 release).

All recipes assume:

```
WORKER_URL=https://<worker-host>
ADMIN=$(cat ~/.plaenicke-admin-secret)
```

Every admin route checks auth first (401 `unauthorized`), then method (405), then body. Errors are `{"error":"<code>"}`. Responses below are read from `worker/src/admin.js`.

## Admin routes

**Mint an invite.** `note` is optional, max 200 characters. The code is returned once; only its SHA-256 is stored.
```
curl -s -X POST "$WORKER_URL/admin/invite" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"note":"Sam"}'
# -> {"invite":"<22-char base64url>"}
# With no note, still send a body: -d '{}'. A bodiless request returns 400 bad_json.
```

**Revoke an unused invite** by hash prefix (8 to 64 lowercase hex characters of the invite's SHA-256). 404 `not_found`; 409 `ambiguous` (prefix matches more than one); 409 `already_used`.
```
curl -s -X DELETE "$WORKER_URL/admin/invite" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"hashPrefix":"<hex>"}'
# -> {"revoked":true}
```
To get the prefix from a code you still hold: `printf '%s' "<invite>" | shasum -a 256 | cut -c1-16`.

**List accounts.**
```
curl -s "$WORKER_URL/admin/accounts" -H "authorization: Bearer $ADMIN"
# -> [{"id","email","createdAt","lastSeenAt","devices","smartAddToday","recoveryConfirmed","disabled"}]
```

**Disable / re-enable an account.** Disabling also deletes that account's device rows in the same batch, so its devices get 401 on the next request. 404 `no_account`.
```
curl -s -X POST "$WORKER_URL/admin/account/disable" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"id":2,"disabled":true}'
# -> {"id":2,"disabled":true}
```

**Correct an email.** 409 `not_upgraded` for account 1 before its upgrade; 409 `email_taken`.
```
curl -s -X POST "$WORKER_URL/admin/account/email" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"id":2,"email":"new@example.com"}'
# -> {"id":2}
```

**Delete an account** (usage, devices, data, account row in one batch; the invite stays used). `confirm` must equal the account's email, case-insensitive; 400 `confirm_mismatch`. On the un-upgraded legacy account 1 (email is null) this always returns 400 `confirm_mismatch`, so it cannot be deleted this way.
```
curl -s -X DELETE "$WORKER_URL/admin/account" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"id":2,"confirm":"sam@example.com"}'
# -> {"deleted":true}
```

**Legacy device routes.** Mint now needs an explicit `accountId` (404 `no_account`). Revoke takes a `token_hash`. Minting a device on account 1 is how you get `PLAENICKE_SMOKE_TOKEN`.
```
curl -s -X POST "$WORKER_URL/admin/device" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"accountId":1,"name":"smoke"}'
# -> {"token":"<43 chars, shown once>","name":"smoke"}
curl -s -X DELETE "$WORKER_URL/admin/device" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"token_hash":"<sha256 hex>"}'
# -> 200 {"revoked":true} when a row was deleted; 200 {"revoked":false} for an unknown hash (never 404)
```
Testers never need a device token or a link code; the app mints their device at sign-up and login.

## Inviting a tester

1. Mint an invite (above). Send it to the tester with this message:

> Install plaenicke to your Home Screen first (Safari: Share, then Add to Home Screen), then open it from the Home Screen icon and paste this invite when it asks: `<invite>`.
> Choose a password, then save the recovery link the app shows you. Keep it somewhere you control, such as a password manager.
> If you lose both your password and the recovery link, your data is gone; nobody can recover it for me or for you.
> Do not sign in on a shared computer.

2. After they sign up, `GET /admin/accounts` shows `recoveryConfirmed: true` once they have confirmed the recovery link.

## Release checklist (spec § 10)

**Phase 1: tolerant Worker** (`REQUIRE_SESSION` unset or not `true`)
1. Close plaenicke on both devices. **Required.**
2. `wrangler d1 export plaenicke --remote --output backup-<date>.sql`, and note a Time Travel bookmark with `wrangler d1 time-travel info plaenicke`. **Required.** Restore, if the migration leaves a bad state: `wrangler d1 time-travel restore plaenicke --bookmark=<id>`.
3. `wrangler secret put AT_REST_KEY` (32 random bytes, base64url, same recipe as `ADMIN_SECRET` in `worker/README.md`). Store a second copy in the password manager. Losing or changing it makes every auth route return 500 `at_rest_key_mismatch`.
4. `wrangler d1 migrations apply plaenicke --remote` (see `worker/README.md`, One-time setup).
5. Deploy the Worker (new routes; bearer accepted, not required); bump `worker/src/version.js`; `curl -s $WORKER_URL/version`. Reopen both devices and confirm sync.
6. Run the Phase-1 manual checks below.

**Phase 2: client** (merge to `main`). The client sends the bearer and shows the Account UI. Wait until both devices show the new `CACHE` (`plaenicke-v7-0`).

**Phase 3: require sessions.** Set `REQUIRE_SESSION=true` on the Worker, bump `version.js`, deploy, then `PLAENICKE_SMOKE_TOKEN=<device token minted on account 1> npm run smoke:worker`.

**Then:** `GET /admin/accounts`; list account 1's devices (`wrangler d1 execute plaenicke --remote --command "SELECT name, token_hash, last_seen_at FROM devices WHERE account_id = 1"`) and revoke any you do not recognise (this uses a read-only `wrangler d1 execute ... SELECT` because `GET /admin/accounts` returns only a device count); upgrade account 1 (Settings, Account, Create your login) on one device; confirm the other device still syncs; then mint invites.

### Release-window rules

1. Between `migrations apply` and the Phase-1 deploy, do not mint devices. The old Worker's `mintDevice` does not set `account_id`, which is `NOT NULL` after the migration, so the insert fails.
2. `npm run smoke:worker` needs `PLAENICKE_SMOKE_TOKEN`, a device minted on Alex's account (`accountId` 1), and spends 6 of that account's 50 daily smart adds per run. It also spends Anthropic credits.

### Rollback

Rolling the Worker back to the pre-V7 version is safe only before the first invite is minted and used: the old `authenticateDevice` serves `data WHERE id = 1` to any token. After that, roll forward.

### D1 migration atomicity (spec § 5, checked 2026-11-11)

- `https://developers.cloudflare.com/d1/reference/migrations/`: does not say whether a migration file is applied as one transaction, what happens on a mid-file failure, or whether rollback is supported (WebFetch of the page, 2026-11-11).
- `https://developers.cloudflare.com/workers/wrangler/commands/d1/` (`d1 migrations apply`): "If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied." It also says a backup is captured after applying. It does not use the words "transaction" or "atomic."
- Conclusion: the wrangler reference states per-migration rollback on error but not how (no explicit "applied as a single transaction"). `0002_accounts.sql` rebuilds two tables with `DROP TABLE`/`RENAME`; whether a failure partway leaves partial state is **unverified** here. Keep "close the app on both devices" and the Time Travel bookmark as required pre-steps (steps 1 and 2 above).

## Phase-1 manual checks

**Duplicate-email 409 on real D1.** `accounts.js` maps a sign-up failure to `409 email_taken` by matching `UNIQUE constraint failed: accounts.email` in the error message. The fake D1 (`node:sqlite`) produces that text; real D1's message format is unverified. After the Phase-1 deploy, mint two invites, sign up twice with the same email, and confirm the second call returns 409 (not 500) and that the second invite stays unused:

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$WORKER_URL/auth/signup" \
  -H 'content-type: application/json' \
  -d '{"invite":"<invite>","email":"check@example.com","kdfSalt":"<22 b64url>","kdfIters":600000,"authKey":"<43 b64url>","recAuthKey":"<43 b64url>","wrappedDekPw":"<80 b64>","wrappedDekRec":"<80 b64>","dekCheck":"<64 hex>","deviceName":"check"}'
```
