# Plan — V8 notifications

Spec: `docs/superpowers/specs/2026-11-13-plaenicke-notifications-design.md`.

**Status: not started.** Spec revision 5 and rulings N1–N25 approved by Alex, 2026-11-17. Next: Phase 0. After that, build T3 and T5 test-first: the races in this design are settled by tests that run them, not by more reading (CLAUDE.md, "Before you touch sync").

**Process.**
- Every code task is test-first, with a **named first failing test**.
- Gate each commit on `npm test` showing the exact strings `# fail 0` **and** `# cancelled 0`.
- A fresh reviewer per task runs the code and mutation-checks the tests.
- **[measure]** tasks record a number in the spec and change a limit. They are not TDD.

## Phase 0 — before any code (Alex + Claude)
- **P0.1** Done 2026-11-13: latest iOS.
- **P0.2** Alex: Cloudflare dashboard → Workers → Triggers. How many of the 5 account Cron Triggers are used? V8 needs one.
- **P0.3** Real-device spike. Success = the notification appears on the lock screen and tapping it opens plaenicke. Otherwise stop.
  - **Setup:**
    - write `docs/superpowers/reports/spike-webpush/spike-webpush-keygen.mjs` (prints a VAPID JWK pair; nothing like it exists yet);
    - Alex runs it and keeps the private key;
    - a throwaway page on the Pages origin subscribes the home-screen app;
    - a local Node script using the spike library sends one declarative push through `web.push.apple.com`, signed with VAPID `sub` = the production app URL (N14).
  - **Also check:**
    - `subscribe` after an awaited `requestPermission` works in standalone mode;
    - a declarative push isn't shown twice with a service-worker `push` handler present;
    - a forced 410 after unsubscribing;
    - offline `unsubscribe()` behaviour.
- **P0.4** Remote checks on a scratch table, then drop it (`npm run wrangler -- d1 execute plaenicke --remote --command …`):
  - `INSERT … ON CONFLICT DO NOTHING RETURNING` and the spec § 5.4 lease claim (`DO UPDATE … WHERE … RETURNING`) both return zero rows when the conflict path doesn't write;
  - `UPDATE … WHERE id IN (SELECT … ORDER BY … LIMIT ?) RETURNING` returns the leased rows.
- **P0.5** D1 point-in-time restore: does it keep deleted rows restorable, and for how long on Free? Fix spec § 6.
- **P0.6** Alex, on the Mac: is `navigator.standalone` true in a Safari "Add to Dock" app? If so, N17's switch condition needs a second test.

## Phase 1 — Worker (branch `notifications`)
- **T1 `worker/src/webpush.js`** — port the spike library.
  - First failing test: the RFC 8291 Appendix A vector, byte for byte.
  - Then: an independent decrypt with node:crypto; two mutations (delimiter, info string) go red.
- **T2 Migration `0003_notifications.sql`**, with a schema test on node:sqlite.
  - First failing test: the three tables have spec § 4's columns, including `items_format`, `feeds_format`, `feeds_seq`, `lost_count`, `window_end`.
  - Then: `UNIQUE(endpoint)` refuses a second account's row.
  - fake-d1 auto-loads migrations (`worker/tests/fake-d1.js:15, 32–35`).
- **T3 `dueMessages(prefs, items, feeds, sent, now)` and `nextFire(…)`** (pure).
  - First failing test: "a day past `items_through` gets no summary".
  - Then:
    - **Coverage:** past either `through` → nothing and `nextFire` null; a NULL half → nothing (and the half is never unsealed); `feeds_tz ≠ tz` → nothing; an unsupported format → nothing.
    - **Leases:** a live lease isn't due, but `nextFire` returns `claimed_at + 5 min` when that is inside `window_end`.
    - **Summaries:** the empty-day wording "No one-off events today"; "continues" from `endDate`; line caps; title cut.
    - **Event reminders:** a midnight-split occurrence reminds once at its real start; a 3-day timed event reminds at its start; an event moved later the same day is reminded again.
    - **Exclusions:** `recurring` and done items are excluded.
    - **Deadlines (N20):** a 00:00 Friday deadline is nudged Thursday at `nudge_at`, and the summary drops a deadline that has passed.
    - **Time:** DST forward, back and ambiguous in America/Los_Angeles (−30 min from the instant; an event starting at 02:30 on a spring-forward day starts at 03:00); window expiry; invalid tz rejected.
    - **Order:** most urgent first.
- **T4 Routes** `PUT/DELETE /notify/sub`, `PUT /notify/items`, `PUT /notify/feeds`, `PUT /notify/prefs`, `GET /notify/state`.
  - First failing test: "an items upload with an older version answers 409 `stale`; with no subscription, 409 `off`".
  - Then, all on node:sqlite with the real SQL:
    - **Wake rule:** every route applies it. `snap_rev` +1. A stored earlier `next_fire_at` is kept; a later one or NULL becomes now.
    - **Items CAS:**
      - a lower `format` → 409 `old_format`;
      - a past `feeds_through` → 409 `paused`, with nothing written;
      - `feeds_through` still NULL a day after subscribing → `paused`; an hour after → written;
      - the same version with an older `through` → `stale`; with a newer `through` → written.
    - **Feeds CAS:**
      - an older `seq` → `stale`;
      - a new device replaces the old (`PUT /notify/sub`), then its first feeds upload with a small `seq` succeeds (`feeds_seq` reset);
      - a new `tz` writes `tz` and `feeds_tz` together;
      - an empty half is accepted.
    - **Halves:** items and feeds writes interleaved in both orders keep both halves.
    - **Off:** an upload after the last subscription was deleted is refused.
    - **Subscriptions:** a new device replaces the old; the same endpoint from another account removes that account's sub and prefs, in that order.
    - **Validation:** 400 `bad_entries`, `bad_format`, `bad_time`, `bad_tz`.
    - **Errors:** `AtRestError` → 500 `at_rest_key_mismatch`.
- **T4b [measure]** On local D1 (`wrangler dev` / `d1 execute --local` meta, not fake-d1, whose `meta.changes` is `total_changes()`):
  - rows written per upload and per cron run;
  - local CPU for a full 160 KB upload, and for cron runs with 1, 3 and 5 accounts holding full halves.
  - Set the § 5.4 account limit from the result.
- **T5 `scheduled()`**.
  - First failing test: "two interleaved runs (fake-d1 `yieldPerStatement`) send each slot once".
  - Then, **stepping the clock minute by minute, never jumping:**
    - **Leases:**
      - a run killed at t after claiming (claim written, no record): t+1 the account is still leased and isn't selected; t+2 it is selected, nothing is sent, `next_fire_at` = t+5; t+5 sent (`claimed_at <= now − 5 min`); never sent after `window_end`;
      - a claim refused because another run holds the lease stays due: step 5 doesn't write a later time or NULL;
      - a run killed before step 5 leaves its accounts with `next_fire_at = now + 2 min`, and an overlapping run takes other accounts.
    - **Races:**
      - an HTTP write during a run makes step 5's guard miss, and the next minute recomputes;
      - a re-subscribe between a run's read and its cleanup survives;
      - a 410 for an old endpoint doesn't delete a new subscription.
    - **Isolation:**
      - ten dead accounts (missing device, disabled account, no sub) are cleaned and don't starve a live one (LEFT JOIN);
      - a half that fails to unseal → `last_error = 'bad_seal'`, a 15-min backoff, and the next account still sends;
      - an `internal` error backs off 2 min.
    - **Reserve:** the run stops claiming when the reserve is reached. With every statement and fetch counted, no run exceeds 50, including:
      - 3 accounts all hitting 410;
      - a message that refreshes the JWT and gets 401 twice (7);
      - the 00:15 sweep run.
    - **Statuses:**
      - after a 5xx the account stops for this run; the claim is released; `retry_after` is set; `Retry-After: 600` is honoured;
      - **N23:**
        - 3 messages expiring unsent over 24 h with no success → deleted;
        - 2 expired over 3 days → kept;
        - 3 expired within 2 h → kept until 24 h have passed since the last success;
        - with `lost_count = 3` from Monday, a single 503 on Tuesday that loses nothing → kept (the drop is evaluated only on an increment);
      - a 403 evicts the cached JWT and retries once; a second 403 → `last_error = 'push_403'`, not retried;
      - a 410 deletes the sub, then the prefs.
    - **Cleanup:**
      - a revoked device gets nothing;
      - the 00:15 run does the sweep's four statements;
      - the sweep nulls a row whose half never arrived after a day, but not one subscribed an hour ago;
      - a past items half is nulled even while the feeds half is uploaded daily, and vice versa (per-half grace).
    - **[measure]** subrequests per run against `wrangler dev`: does `batch()` count as one? Then set the reserve.
- **T6 Cleanup wiring** in `admin.js` disable/delete batches.
  - First failing test: "admin delete leaves no `push_subs`/`notify_prefs`/`notify_sent` rows".
- **T7 `wrangler.toml` `[triggers] crons = ["* * * * *"]`** (one expression), pinned in `worker/tests/wrangler-config.test.js`.
  - Version bump.
  - `VAPID_PRIVATE_JWK` documented in `docs/admin.md` and `worker/README.md`.
  - Add to `docs/admin.md`:
    - **VAPID rotation:** every device must re-subscribe;
    - **D1 restore:** run `UPDATE notify_prefs SET items_version = NULL`.

## Phase 2 — Client (same branch)
- **T7a Push API seam.** An injected push API (`Notification`, `pushManager`, `getSubscription`, `unsubscribe`) in `app.js`/`accountui.js`, plus fakes in `tests/fake-dom.js`.
  - First failing test: "the Reminders switch is hidden when `isStandalone()` is false".
- **T7b `syncOnce` returns `version` and the state `applyState` returned, on `ok`.**
  - Read the V5 ledger first.
  - Update `js/sync.js:304–309`.
  - First failing test: "an `ok` result carries the server version it ended on".
  - Then: the version-conflict path; the snapshot source is `applyState`'s return value (`:313`).
- **T7c `js/ics.js` instance contract** (sensitive parser; feeds the Brightspace import). Order matters:
  1. **Pin today's output (tests only, committed green):**
     - `tests/deadlines.test.js` cases for a midnight-crossing, a 3+-day timed and a range-clipped trackable event, asserting `deriveDeadlines`'s exact `{uid, title, date, time}`;
     - one asserting `expandEvents`'s `date`/`time`/`endTime` and order.
  2. **Add the fields:**
     - `occurrenceStart: {date, time}` and `occurrenceEnd: {date, time}` (plain strings, never the frozen memoised parts, `ics.js:206–224`);
     - `segment: 'whole'|'first'|'continuation'|'day'` (all-day single → `whole`, all-day multi-day → `day`);
     - `instancesForRange` copies them (`js/feeds.js:791–804`).
  3. **Deliberate test edits:** `tests/feeds.test.js:1155` (13 → 16 keys), `tests/ics.test.js:1679` (5 → 8), `tests/ics.test.js:846`. The golden test `:2008–2029` stays unchanged.
  4. **Then** the Brightspace mutation checks listed in CLAUDE.md. The step-1 pins must still pass.
- **T8 `js/notifysnapshot.js`** — async, with an injected SHA-256.
  - First failing test: "a tracked `bs-` deadline whose feed instance was renamed to a non-trackable title is excluded". This pins `hideTrackedCopies`; the title filter alone doesn't catch it.
  - Then:
    - untracked "… - Due" instances are excluded (N21);
    - one entry per occurrence overlapping the horizon, with `endDate`;
    - horizon in `prefs.tz`, yesterday included;
    - `through` = the last whole day kept after trimming farthest days first;
    - an empty feeds half when there are no feeds;
    - the calendar surface plus hidden calendars;
    - `EVENT_TYPES` exported from `js/today.js:19`, and `isTodo`;
    - never notes, URLs or feed names;
    - N18 keys with the separator;
    - a deterministic hash over `{version, through, format, entries}`.
- **T9 Settings → Reminders** — disclosure, switch, times within range, the § 5.6 status line order.
  - First failing test: "`subscribe` is called in the tap handler after `requestPermission` resolves".
- **T10 Upload wiring** in `app.js`, through **one upload queue**.
  - **Items half:** after each `ok` sync, using T7b's state and version, with the skip rule.
  - **Feeds half:**
    - on any feed, cache or visibility change;
    - on a zone change;
    - **whenever `/notify/state.feedsThrough` is null or earlier than the `through` it would upload now.**
  - **`GET /notify/state`** on open, on return to visible, and after sign-in.
  - **409 handling:**
    - `stale` → re-read state, and upload only if newer;
    - `old_format` → stop until reload;
    - `paused` → the subscribed device uploads feeds, then retries items; other devices stop until the next state read;
    - `off` → re-read state, and never call `unsubscribe()` from a 409;
    - feeds `stale` → re-read state, then retry once with `seq` above `feedsSeq`;
    - 400 `bad_format` → terminal until reload, not retried after each sync.
  - **Token change:** `thisDevice: false` with a browser subscription → unsubscribe, switch off.
  - First failing test: "a feed-less subscribed device re-uploads the feeds half on the first open of a new day".
- **T10b `VAPID_PUBLIC`** in client config, pinned to the format P0.3 produced.
- **T11 Service worker** — `push` and `notificationclick`; precache `js/notifysnapshot.js`.
  - **First:** move `tests/serviceworker.test.js:48` `CACHE_ON_MAIN` from `plaenicke-v6-23` to main's CACHE at branch time (`plaenicke-v7-0` today).
  - **Then:** bump CACHE.
- **T12 Sign-out.**
  - **Worker:** logout (`worker/src/accounts.js:383`, a single `.run()` today) becomes a batch: device row, then `push_subs` (`account_id` + `token_hash`), then `notify_prefs` with a `NOT EXISTS` guard.
  - **Client:** `unsubscribe()` runs after `signOutLocal()` returns `signed_out`, on both paths. No await is added before the revoke.
  - First failing test: "`unsubscribe` is called after `signOutLocal`, never before".

## Phase 3 — Release (Alex-run, runbook in `docs/admin.md`)
1. Back up D1, then migrate 0003.
2. Set `VAPID_PRIVATE_JWK`, then deploy the Worker.
3. Probes: `/notify/state` answers 401 without a session.
4. Merge the client.
5. Turn on reminders on the iPhone.
6. The first summary arrives the next morning.
7. Check CPU, `Intl` and subrequests per run, then set the account limit and reserve.
8. Measure cron jitter for a week.

## End of branch
- `jaeger:review-sweep` (security, concurrency, data lifecycle, UI).
- Device checks on the iPhone.
