# Admin notes

Everything here is Alex-run. As of 2026-11-12, nothing in V7 has been deployed, migrated to production, or merged to `main`; the branch is `accounts`. Spec: `docs/superpowers/specs/2026-11-11-plaenicke-accounts-design.md` (§ 6.9 admin, § 10 release, § 11 risks).

## Conventions

Set these once per terminal. Every recipe below uses them.

```
WORKER_URL=https://plaenicke-worker.lucky-star-0281.workers.dev
ORIGIN=https://ajaenicke518.github.io
ADMIN=$(cat ~/.plaenicke-admin-secret)
```

`WORKER_URL` is `js/config.js`'s; `ORIGIN` is `worker/src/cors.js`'s `ALLOWED_ORIGIN`.

- Phases 0 and 1 run in the `accounts` worktree, `~/projects/plaenicke/.claude/worktrees/accounts` (branch `accounts` is checked out there, so `git switch accounts` in the main checkout would be refused). Phases 2 and 3 run in the main checkout, `~/projects/plaenicke`, which has `main` checked out. Run every command from the root of that checkout. Wrangler commands are written `(cd worker && npx wrangler …)`: wrangler reads `worker/wrangler.toml` from the directory it runs in, and the subshell leaves your terminal at the repo root. `npm run smoke:worker` and `npm test` run from the repo root.
- `jq` and `openssl` are used below; both ship with macOS (`/usr/bin/jq`, `/usr/bin/openssl`).
- Backups go to `~/plaenicke-backups/`, never inside the repo. Secrets and tokens go to chmod-600 files in `~`, never into the repo or a commit.

Every admin route checks auth first (401 `unauthorized`), then method (405), then body. Errors are `{"error":"<code>"}`. Responses below are read from `worker/src/admin.js`.

## Admin routes

**Mint an invite.** `note` is optional, max 200 characters. The code is returned once; only its SHA-256 is stored.
```
curl -s -X POST "$WORKER_URL/admin/invite" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"note":"Sam"}'
# -> {"invite":"<22-char base64url>"}
# With no note, still send a body: -d '{}'. A bodiless request returns 400 bad_json.
```

**Revoke an unused invite** by hash prefix (8 to 64 lowercase hex characters of the invite's SHA-256). 404 `not_found`; 409 `ambiguous` (prefix matches more than one); 409 `already_used`. A `{"revoked":true}` answer also proves the invite was still unused.
```
curl -s -X DELETE "$WORKER_URL/admin/invite" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"hashPrefix":"<hex>"}'
# -> {"revoked":true}
```
To get the prefix from a code you still hold: `printf '%s' "<invite>" | shasum -a 256 | cut -c1-16`.

**List accounts.** `devices` is a count; `smartAddToday` is the UTC day's count; `lastSeenAt` is the newest device's.
```
curl -s "$WORKER_URL/admin/accounts" -H "authorization: Bearer $ADMIN"
# -> [{"id","email","createdAt","lastSeenAt","devices","smartAddToday","recoveryConfirmed","disabled"}]
```

**Mint an upgrade code for legacy account 1.** `POST /account/upgrade` (the app's *Create your login*) refuses without one (sweep W1-C1). Single use, expires 24 hours after minting; only its SHA-256 is stored. 409 `already_upgraded` once the account has an email; 404 `no_account`.
```
curl -s -X POST "$WORKER_URL/admin/upgrade-code" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"accountId":1}'
# -> {"upgradeCode":"<22-char base64url>"}
```
An expired or used code makes the app say "That upgrade code doesn't work" (`403 invalid_upgrade_code`); mint another.

**Disable / re-enable an account.** Disabling also deletes that account's device rows in the same batch, so its devices get 401 on the next request. **Re-enabling does not bring the device rows back**: every device must sign in again. 404 `no_account`.
```
curl -s -X POST "$WORKER_URL/admin/account/disable" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"id":2,"disabled":true}'
# -> {"id":2,"disabled":true}
```
**Never disable account 1 before it is upgraded.** A legacy device has no password to sign in with; once its device row is gone the only way back is a link code from another linked device (CLAUDE.md, Device linking), and disabling deletes all of them at once.

**Correct an email.** 409 `not_upgraded` for account 1 before its upgrade; 409 `email_taken`.
```
curl -s -X POST "$WORKER_URL/admin/account/email" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"id":2,"email":"new@example.com"}'
# -> {"id":2}
```

**Delete an account** (usage, upgrade codes, devices, data, account row in one batch; the invite stays used). `confirm` must equal the account's email, case-insensitive; 400 `confirm_mismatch`. On the un-upgraded legacy account 1 (email is null) this always returns 400 `confirm_mismatch`, so it cannot be deleted this way.
```
curl -s -X DELETE "$WORKER_URL/admin/account" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"id":2,"confirm":"sam@example.com"}'
# -> {"deleted":true}
```

**Legacy device routes.** Mint needs an explicit `accountId` (404 `no_account`; 409 `disabled` for a disabled account). Revoke takes a `token_hash`.
```
curl -s -X POST "$WORKER_URL/admin/device" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"accountId":1,"name":"smoke"}'
# -> {"token":"<43 chars, shown once>","name":"smoke"}
curl -s -X DELETE "$WORKER_URL/admin/device" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"token_hash":"<sha256 hex>"}'
# -> 200 {"revoked":true} when a row was deleted; 200 {"revoked":false} for an unknown hash (never 404)
```
A minted token is a full session for that account. Mint one on account 1 only after account 1 is upgraded (release step 2b before 3), keep it in a chmod-600 file, revoke it after use, and **never paste it into the app**: a raw 43-character token bootstraps a fresh encryption key (CLAUDE.md, Device linking).

Testers never need a device token or a link code; the app mints their device at sign-up and login.

## Inviting a tester

1. Mint an invite (above). Send it to the tester with this message:

> Install plaenicke to your Home Screen first (Safari: Share, then Add to Home Screen), then open it from the Home Screen icon and paste this invite when it asks: `<invite>`.
> Choose a password, then save the recovery link the app shows you. Keep it somewhere you control, such as a password manager.
> If you lose both your password and the recovery link, your data is gone; nobody can recover it for me or for you.
> Do not sign in on a shared computer.

2. After they sign up, `GET /admin/accounts` shows `recoveryConfirmed: true` once they have confirmed the recovery link.

If a tester says the app keeps refusing their password: besides length, a digit and a symbol, it refuses anything on the bundled common-password list (`js/common-passwords.js`) and any password that is a common word plus digits or symbols — `Summer2024!`, `Football1!`, `Berlin 2024!` and `Plaenicke1!` are all refused ("Too close to a common password — add something unusual"); a passphrase such as `correct horse 7` passes. The base-word list is `js/common-bases.js`, generated by `node scripts/gen-common-bases.mjs <list.txt>` from the pinned SecLists file named in its header.

## Release checklist (spec § 10)

The order is fixed: **Worker (tolerant), then client, then account 1's upgrade, then the flag.** Each step says what to expect; anything else means stop.

### Phase 0: prepare (laptop only, nothing in production changes)

1. Go to the `accounts` worktree and confirm the tree is the one to release:
   ```
   cd ~/projects/plaenicke/.claude/worktrees/accounts
   git branch --show-current   # expect accounts
   git status --short          # expect no output
   git log -1 --oneline
   ```
2. `npm test` — expect `# fail 0` **and** `# cancelled 0`.
3. Confirm the Worker version this release deploys:
   ```
   grep VERSION worker/src/version.js
   # -> export const VERSION = 'worker-2026-11-12.1';
   ```
   If anything in `worker/` changes before the deploy, bump this string in the same commit and use the new one everywhere below.
4. Confirm `worker/wrangler.toml` has no `[vars]` block (`grep -n '^\[vars\]' worker/wrangler.toml` prints nothing). Phase 1 must deploy with `REQUIRE_SESSION` unset. `wrangler deploy` overwrites variables set in the Cloudflare dashboard (see *Why the flag lives in wrangler.toml* below), so this deploy also removes any `REQUIRE_SESSION` someone set there.
5. `mkdir -p ~/plaenicke-backups && chmod 700 ~/plaenicke-backups`

### Phase 1: tolerant Worker

1. **Close plaenicke on both devices** (swipe it away in the app switcher). **Required:** the migration rebuilds the `devices` and `data` tables.
2. **Set `AT_REST_KEY`** (32 random bytes, base64url, 43 characters):
   ```
   K=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
   echo ${#K}                                  # expect 43
   (umask 077; printf '%s\n' "$K" > ~/.plaenicke-at-rest-key)
   printf '%s' "$K" | (cd worker && npx wrangler secret put AT_REST_KEY)
   ```
   Then put the same value (`cat ~/.plaenicke-at-rest-key`) in the password manager, and `unset K`. Two copies, laptop and password manager. If it is missing or not 32 bytes the account routes answer 500 `not_configured`; if it is changed after first use they answer 500 `at_rest_key_mismatch`. `/data` sync, smart add and `/feed` never read it. `wrangler secret put` creates and deploys a new version of the *currently deployed* (old) Worker at once (Cloudflare, Secrets page); the old code ignores the secret.
3. **Back up D1. Required.**
   ```
   D=$(date +%Y-%m-%d-%H%M)
   (cd worker && npx wrangler d1 export plaenicke --remote --output ~/plaenicke-backups/backup-$D.sql)
   (cd worker && npx wrangler d1 time-travel info plaenicke --timestamp=$(date +%s))
   ```
   Write the bookmark that `time-travel info` prints into the results table at the end of this file. Take both after steps 1 and 2 and immediately before step 4: with the apps closed nothing writes to D1 in between, and a restore discards everything written after the bookmark.
4. **Migrate.**
   ```
   (cd worker && npx wrangler d1 migrations list plaenicke --remote)    # expect exactly 0002_accounts.sql
   (cd worker && npx wrangler d1 migrations apply plaenicke --remote)
   ```
   If `migrations list` shows anything else, stop. From here until step 5 is done, **do not mint devices** (release-window rule 1).
5. **Deploy and confirm the version.**
   ```
   (cd worker && npx wrangler deploy)
   sleep 20
   curl -s "$WORKER_URL/version"
   # -> {"version":"worker-2026-11-12.1"}
   ```
   The old string `worker-2026-10-27.2` means the edge has not caught up: wait and repeat the curl.
6. **Free probes.**
   ```
   curl -s -w ' %{http_code}\n' -H "Origin: $ORIGIN" "$WORKER_URL/feed?url=x"
   # -> {"error":"bad_url"} 400        tolerant, as Phase 1 must be
   #    {"error":"unauthorized"} 401   flag is on: stop
   #    {"error":"bad_config"} 500     flag has a value that is neither true nor false: stop
   curl -s -w ' %{http_code}\n' -X POST "$WORKER_URL/auth/prelogin" \
     -H 'content-type: application/json' -d '{"email":"nobody@example.com"}'
   # -> {"error":"no_account"} 404     AT_REST_KEY is set and is the key of record
   #    {"error":"not_configured"} 500 / {"error":"at_rest_key_mismatch"} 500: stop
   curl -s "$WORKER_URL/admin/accounts" -H "authorization: Bearer $ADMIN"
   # -> one row: {"id":1,"email":null,...,"devices":<your device count>,...}
   ```
   The first account-route request stores the key check (`worker/src/seal.js` `checkKey`); every later request compares against it. That is why the prelogin probe must run with the key you saved.
7. Reopen both devices. Make an edit on one and confirm it appears on the other.
8. Run the **Phase-1 checks** below. Do not start Phase 2 until all pass.

### Phase 2: client

1. Merge and push (GitHub Pages serves `main`; the push is the deploy):
   ```
   cd ~/projects/plaenicke
   git branch --show-current    # expect main
   git status --short           # expect no output
   git pull --ff-only origin main
   git merge --no-ff accounts -m "Merge V7 accounts"
   npm test                     # expect # fail 0 and # cancelled 0
   git push origin main
   ```
2. Confirm Pages serves the new client:
   ```
   curl -s https://ajaenicke518.github.io/plaenicke/service-worker.js | grep "const CACHE"
   # -> const CACHE = 'plaenicke-v7-0';
   ```
3. On each device: force-quit and reopen plaenicke, then open Settings. The new client is running when Settings shows an **Account** section above Sync (`js/settings.js`, "Account (accounts Task 13), above Sync"). If it does not, wait a few minutes and force-quit and reopen again: the service worker fetches network-first (`service-worker.js`), but the browser may still hold an HTTP-cached copy of the old files.
4. From now on a device with no session makes no smart-add or calendar request at all (`js/smartadd.js` throws `signed_out` before the fetch; `js/feeds.js` returns `signed_out`). Alex's two linked devices have a session and keep working.
5. **Prove every device sends its session (required before Phase 3).** Read the count first and write it into the result log:
   ```
   curl -s "$WORKER_URL/admin/accounts" -H "authorization: Bearer $ADMIN" | jq '.[] | select(.id == 1) | .smartAddToday'
   ```
   Then do one smart add on each device, and read again:
   ```
   curl -s "$WORKER_URL/admin/accounts" -H "authorization: Bearer $ADMIN" | jq '.[] | select(.id == 1)'
   ```
   Expect `smartAddToday` to have risen by exactly one per device since the first read (the count is per UTC day: do both reads and the smart adds on the same UTC day) and `lastSeenAt` to be a minute ago. In tolerant mode a tokenless smart add is still served but is not counted (`worker/src/index.js` takes a slot only for an authenticated device), so a count that did not rise means a device is not sending its token: stop. This also exercises the smart-add counter's `RETURNING` upsert on real D1.

### Phase 2b: upgrade account 1 (before minting any other account-1 token)

1. **Audit account 1's devices.** `GET /admin/accounts` gives only a count, so read the rows directly (read-only):
   ```
   (cd worker && npx wrangler d1 execute plaenicke --remote \
     --command "SELECT name, token_hash, created_at, last_seen_at FROM devices WHERE account_id = 1")
   ```
   Revoke any row you do not recognise with `DELETE /admin/device` and its `token_hash`.
2. **Mint the upgrade code** (`POST /admin/upgrade-code`, above). It expires 24 hours after minting, so mint it right before the next step.
3. **On one device:** Settings → Account → *Create your login*. Paste the code into *Upgrade code from Alex*, enter the email and a password twice, tap *Create login*. If the section says "This device hasn't checked its account yet", tap *Check again* first: the button appears only once the Worker has said the account has no email.
4. Save the recovery link the app shows (Copy, Email it to me, or Download), tick the box, tap Done.
5. Check:
   ```
   curl -s "$WORKER_URL/admin/accounts" -H "authorization: Bearer $ADMIN" | jq '.[] | select(.id == 1)'
   # -> "email": "<your email>", "recoveryConfirmed": true
   ```
6. On the **other** device, make an edit and confirm it reaches the first device (it keeps its legacy link; both stay on account 1).

### Phase 3: require sessions

1. **Mint the smoke token now, not earlier** (release-window rule 2: only after the upgrade):
   ```
   (umask 077; curl -s -X POST "$WORKER_URL/admin/device" -H "authorization: Bearer $ADMIN" \
     -H 'content-type: application/json' -d '{"accountId":1,"name":"smoke"}' \
     | jq -r .token > ~/.plaenicke-smoke-token)
   wc -c < ~/.plaenicke-smoke-token     # expect 44 (43 characters and a newline)
   ```
2. **The Phase-3 commit, on `main`.** Two changes: the flag in `worker/wrangler.toml`, and a new version string. The commands use `worker-2026-11-12.2`; any string works as long as it differs from `worker-2026-11-12.1`, and the smoke run compares against whatever this file says:
   ```
   cd ~/projects/plaenicke
   git branch --show-current    # expect main
   git pull --ff-only origin main
   printf '\n[vars]\nREQUIRE_SESSION = "true"\n' >> worker/wrangler.toml
   sed -i '' "s/'worker-2026-11-12.1'/'worker-2026-11-12.2'/" worker/src/version.js
   git diff
   ```
   The changed lines in `git diff` must be exactly these:
   ```diff
   --- a/worker/src/version.js
   +++ b/worker/src/version.js
   -export const VERSION = 'worker-2026-11-12.1';
   +export const VERSION = 'worker-2026-11-12.2';
   --- a/worker/wrangler.toml
   +++ b/worker/wrangler.toml
    # overwrites dashboard variables (keep_vars is unset; Cloudflare's "Source of
    # truth" note), so a later deploy would silently drop it.
   +
   +[vars]
   +REQUIRE_SESSION = "true"
   ```
   Then:
   ```
   npm test                     # expect # fail 0 and # cancelled 0
   git commit -am "Worker: require sessions (release Phase 3)"
   git push origin main
   ```
   `worker/tests/wrangler-config.test.js` fails if the value is anything `requireSession()` would answer with 500 `bad_config` (for example `"TRUE"` or `"1"`), or if `keep_vars = true` appears. The push redeploys Pages with an unchanged client.
3. **Deploy and confirm.**
   ```
   (cd worker && npx wrangler deploy)
   sleep 20
   curl -s "$WORKER_URL/version"                                     # -> the new string
   curl -s -w ' %{http_code}\n' -H "Origin: $ORIGIN" "$WORKER_URL/feed?url=x"
   # -> {"error":"unauthorized"} 401     the flag is on
   #    {"error":"bad_url"} 400          the flag is off: stop
   ```
4. **Smoke** (spends Anthropic credits and 6 of account 1's 50 daily smart adds):
   ```
   PLAENICKE_SMOKE_TOKEN=$(cat ~/.plaenicke-smoke-token) npm run smoke:worker
   # -> version worker-2026-11-12.2 confirmed; 6 Claude calls … 6/6 passed
   ```
   A version mismatch stops it before any Claude call; wait and run it again.
5. **Revoke the smoke token and delete the file:**
   ```
   H=$(tr -d '\n' < ~/.plaenicke-smoke-token | shasum -a 256 | cut -d' ' -f1)
   curl -s -X DELETE "$WORKER_URL/admin/device" -H "authorization: Bearer $ADMIN" \
     -H 'content-type: application/json' -d "{\"token_hash\":\"$H\"}"
   # -> {"revoked":true}
   rm ~/.plaenicke-smoke-token
   ```
6. On both devices: a smart add works, and Settings → Linked calendars shows no "signed out" or "sign in to refresh" stamp.
7. Run the **device checks** below on the iPhone, then mint invites.

### Why the flag lives in wrangler.toml

Cloudflare's configuration reference, section "Source of truth" (https://developers.cloudflare.com/workers/wrangler/configuration/, fetched 2026-11-12): "If you change your environment variables in the Cloudflare dashboard, Wrangler will override them" on the next deploy, unless `keep_vars = true` is set. The `wrangler deploy` reference (https://developers.cloudflare.com/workers/wrangler/commands/workers/, fetched 2026-11-12) says the same of `--keep-vars` (default false) and that a `--var` value applies to that deploy only, as a string. So a flag set in the dashboard or with `--var` disappears on the next plain `npx wrangler deploy`, and Phase 3 would silently revert to tolerant. `worker/wrangler.toml` is the only supported place for `REQUIRE_SESSION`; `keep_vars` stays unset. Secrets (`AT_REST_KEY`, `ADMIN_SECRET`, `ANTHROPIC_API_KEY`) are never deleted by a deploy (same reference).

### Release-window rules

1. Between `migrations apply` and the Phase-1 deploy, do not mint devices. The old Worker's `mintDevice` does not set `account_id`, which is `NOT NULL` after the migration, so the insert fails.
2. Upgrade code first, upgrade second, any other account-1 token third. The upgrade route no longer accepts a bare account-1 bearer, but a smoke token is still a full account-1 session: mint it only for Phase 3 and revoke it straight after.
3. Never disable account 1 before it is upgraded (see *Disable* above).
4. `npm run smoke:worker` needs `PLAENICKE_SMOKE_TOKEN`, a device minted on account 1, and spends 6 of that account's 50 daily smart adds per run. It also spends Anthropic credits. Never run it except in Phase 3 step 4.
5. Tolerant mode (Phases 1 and 2) treats an unknown or revoked bearer on `POST /` and `GET /feed` as anonymous: the request is served, not refused with 401 (`worker/src/index.js` `handleSmartAdd`; `worker/src/feed.js`). `/data` and the `/account/*` routes answer 401 for it in every phase. A revoked device therefore notices only through sync until Phase 3.

### Rollback

- **Commands.** List versions with `(cd worker && npx wrangler versions list)` and roll back with `(cd worker && npx wrangler rollback <VERSION_ID> --message "<why>")` (Cloudflare, `wrangler rollback` reference, fetched 2026-11-12). A rollback creates a new deployment of that version; it does not change connected resources such as D1 (Cloudflare, Rollbacks page). Whether a rollback restores that version's `[vars]` is **unverified** (the pages do not say). To turn the flag off, roll forward instead: a commit that deletes the `[vars]` block, a version bump, `npx wrangler deploy`, and the `/feed?url=x` probe expecting 400.
- **Worker back to the pre-V7 version:** safe only while no account other than 1 has device rows. The pre-V7 `authenticateDevice` accepts any token in `devices` and the pre-V7 `data.js` always serves `data WHERE id = 1` (`git show dcc17ac:worker/src/auth.js`, `…:worker/src/data.js`), so any other account's device would read and write Alex's planner. The Phase-1 check account is deleted in its cleanup (step 4), so the rollback stays safe after the checks. Check before rolling back:
  ```
  (cd worker && npx wrangler d1 execute plaenicke --remote \
    --command "SELECT COUNT(*) AS n FROM devices WHERE account_id != 1")
  ```
  `n` must be 0. Otherwise disable or delete those accounts first (both delete their device rows), or roll forward.
- **After Phase 2, a Worker rollback needs the client reverted too.** The V7 client sends `authorization` on every `/feed` request (`js/feeds.js`), and the pre-V7 Worker's feed preflight allows only `content-type, cache-control` (`git show dcc17ac:worker/src/feed.js`, the pre-V7 `main`), so calendars stop refreshing. Revert the merge on `main` (`git revert -m 1 <merge commit>`, push), then roll the Worker back.
- **After Phase 3, a client rollback needs the flag off first.** The pre-V7 client sends no bearer on smart add or `/feed`, so with the flag on both answer 401. Roll the flag forward to off (above), then revert the client.
- **D1 restore order: roll the Worker back first, then restore D1.** The V7 Worker cannot run against the pre-migration schema (no `accounts` table); the pre-V7 Worker can run against the migrated one (spec § 9 tests the old `data.js` queries on it). Then: `(cd worker && npx wrangler d1 time-travel restore plaenicke --bookmark=<bookmark from Phase 1 step 3>)`. A restore discards every write after the bookmark, syncs included.

### D1 migration atomicity (spec § 5, checked 2026-11-11)

- `https://developers.cloudflare.com/d1/reference/migrations/`: does not say whether a migration file is applied as one transaction, what happens on a mid-file failure, or whether rollback is supported (WebFetch of the page, 2026-11-11).
- `https://developers.cloudflare.com/workers/wrangler/commands/d1/` (`d1 migrations apply`): "If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied." It also says a backup is captured after applying. It does not use the words "transaction" or "atomic."
- Conclusion: the wrangler reference states per-migration rollback on error but not how (no explicit "applied as a single transaction"). `0002_accounts.sql` rebuilds two tables with `DROP TABLE`/`RENAME`; whether a failure partway leaves partial state is **unverified** here. Keep "close the app on both devices" and the Time Travel bookmark as required pre-steps (Phase 1 steps 1 and 3).

## Phase-1 checks

These prove, on real D1, the things the fake D1 (`node:sqlite`) cannot: per-statement `RETURNING` inside a `batch()` (sign-up and login both decide success from it, `worker/src/accounts.js`), the `UNIQUE constraint failed: accounts.email` message that maps to 409, batch rollback, and the seal round trip under the real `AT_REST_KEY`. They use a throwaway account with random keys (the Worker cannot tell random keys from real ones) and clean up after themselves. No Claude call.

```
# Two invites, random key material, one sign-up body per invite.
INV1=$(curl -s -X POST "$WORKER_URL/admin/invite" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"note":"phase1-check-1"}' | jq -r .invite)
INV2=$(curl -s -X POST "$WORKER_URL/admin/invite" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"note":"phase1-check-2"}' | jq -r .invite)
SALT=$(openssl rand -base64 16 | tr '+/' '-_' | tr -d '=')
AUTH=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
REC=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
WPW=$(openssl rand -base64 60 | tr -d '\n')
WREC=$(openssl rand -base64 60 | tr -d '\n')
CHK=$(openssl rand -hex 32)
EMAIL=phase1-check@example.com
signup() { printf '{"invite":"%s","email":"%s","kdfSalt":"%s","kdfIters":600000,"authKey":"%s","recAuthKey":"%s","wrappedDekPw":"%s","wrappedDekRec":"%s","dekCheck":"%s","deviceName":"check"}' "$1" "$EMAIL" "$SALT" "$AUTH" "$REC" "$WPW" "$WREC" "$CHK"; }
```
(`openssl rand -base64` wraps at 64 characters; the `tr -d '\n'` keeps the 80-character values on one line.)

1. **Sign-up succeeds (`RETURNING` in a batch).**
   ```
   S1=$(curl -s -X POST "$WORKER_URL/auth/signup" -H 'content-type: application/json' -d "$(signup "$INV1")"); echo "$S1"
   # -> {"token":"<43 chars>","accountId":<number>}
   ID=$(printf '%s' "$S1" | jq .accountId)
   ```
   `{"error":"invalid_invite"}` with a fresh invite means `results[1].results` came back empty on real D1: stop, it is a Worker bug.
2. **Duplicate email is 409, and the failed batch rolled back.**
   ```
   curl -s -w ' %{http_code}\n' -X POST "$WORKER_URL/auth/signup" -H 'content-type: application/json' -d "$(signup "$INV2")"
   # -> {"error":"email_taken"} 409
   P2=$(printf '%s' "$INV2" | shasum -a 256 | cut -c1-16)
   curl -s -w ' %{http_code}\n' -X DELETE "$WORKER_URL/admin/invite" -H "authorization: Bearer $ADMIN" \
     -H 'content-type: application/json' -d "{\"hashPrefix\":\"$P2\"}"
   # -> {"revoked":true} 200        the second invite stayed unused, and is now revoked
   ```
   `{"error":"internal_error"} 500` on the sign-up means real D1's error text differs from `node:sqlite`'s. `{"error":"already_used"} 409` on the revoke means the batch did not roll back. Either: stop.
3. **Login mints a device and returns the sealed value intact (`RETURNING` in a batch, seal round trip).**
   ```
   curl -s -X POST "$WORKER_URL/auth/login" -H 'content-type: application/json' \
     -d "{\"email\":\"$EMAIL\",\"authKey\":\"$AUTH\",\"deviceName\":\"check-login\"}" \
     | jq --arg w "$WPW" '{accountId, sealRoundTrip: (.wrappedDekPw == $w), error}'
   # -> {"accountId": <same as ID>, "sealRoundTrip": true, "error": null}
   curl -s "$WORKER_URL/admin/accounts" -H "authorization: Bearer $ADMIN" | jq ".[] | select(.id == $ID) | .devices"
   # -> 2
   ```
4. **Clean up.**
   ```
   curl -s -X DELETE "$WORKER_URL/admin/account" -H "authorization: Bearer $ADMIN" \
     -H 'content-type: application/json' -d "{\"id\":$ID,\"confirm\":\"$EMAIL\"}"
   # -> {"deleted":true}
   curl -s "$WORKER_URL/admin/accounts" -H "authorization: Bearer $ADMIN" | jq length
   # -> 1
   ```

The smart-add counter's `RETURNING` upsert on real D1 is checked in Phase 2 step 5.

## Device checks (iPhone, Alex-run)

Things the tests cannot reach: WebKit, iOS Mail, Keychain, the keyboard and real networks. Run them after Phase 3 on the iPhone, with a test invite and a throwaway email you can receive (delete the account afterwards with `DELETE /admin/account`). Record each result here and commit the edit.

| # | Check | How | Expect | Result (date, pass/fail, note) |
|---|---|---|---|---|
| 1 | Safari-tab warning | Open `https://ajaenicke518.github.io/plaenicke/#invite=<code>` in a Safari tab, not the Home Screen app (`js/config.js` `APP_URL` plus the `#invite=` fragment `js/fragment.js` reads) | Sign-up says "You're in Safari, not the plaenicke app — open the app from your Home Screen and paste the code there." | |
| 2 | Code fields | Type into the invite, recovery and upgrade-code fields | No autocorrect, no capitalisation, no suggestions | |
| 3 | Keychain autofill | Sign in with a Keychain-saved password via the QuickType bar | Submit becomes enabled without typing a character | |
| 4 | Form in view | Open a form from a link while the keyboard is up | The form scrolls into view inside the keyboard-fitted Settings panel | |
| 5 | Download | Recovery screen → Download | A `plaenicke-recovery-link.txt` is saved (Files) and contains the link | |
| 6 | Email it to me | Recovery screen → Email it to me → send → come back to plaenicke | Mail opens with the link; on return the recovery screen is still there (or the banner offers it again) | |
| 7 | Whole link pasted | Copy the whole recovery link from that email, paste it into "Recovery link or code" | Accepted; the 22-character code is taken from the link | |
| 8 | Weak network | Sign in on one bar of cellular (or, if the iPhone shows Settings → Developer, its Network Link Conditioner on "Very Bad Network") | Either it completes, or within 30 s of the request it says "Can't reach the server. Check your connection." and the form is usable again (`js/account.js` `ACCOUNT_TIMEOUT_MS`) | |
| 9 | PBKDF2 time | Sign in and time from tapping Sign in to the home view | Note the seconds (600,000 iterations; spec § 11 risk) | |
| 10 | Storage separation | Sign in in the Home Screen app, then open the app's URL in a Safari tab | The Safari tab is signed out (separate storage, spec D24) | |

Result log:

| Item | Value |
|---|---|
| Phase 1 Time Travel bookmark | |
| Phase 1 `/version` | |
| Phase-1 checks 1–4 | |
| Phase 2 step 5 smartAddToday before / after | |
| Phase 3 `/version` | |
| Phase 3 smoke result | |
