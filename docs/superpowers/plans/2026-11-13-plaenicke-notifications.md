# Plan — V8 notifications

Spec: `docs/superpowers/specs/2026-11-13-plaenicke-notifications-design.md`. **Not started. Needs Alex's approval of the spec (revision 2), rulings N1–N20 and answers to spec § 8 first. Revision 3 was not reviewed: run a devil's advocate on it before T1.** Every task test-first; gate on `npm test` `# fail 0` and `# cancelled 0`; a fresh reviewer per task that runs the code.

## Phase 0 — before any code (Alex + Claude, ~no code)
- **P0.1** Alex: iOS version on the iPhone (Settings → General → About). Stop if < 16.4.
- **P0.2** Alex: Cloudflare dashboard → Workers → each Worker's Triggers — how many of the 5 account Cron Triggers are used (wrangler 4.161.0 has `triggers deploy` only, no list).
- **P0.4** One remote check: on a scratch table, `INSERT … ON CONFLICT DO NOTHING RETURNING` returns zero rows on a conflict on production D1 (`npm run wrangler -- d1 execute plaenicke --remote --command …`, then drop the table).
- **P0.3** Real-device spike (also check: `subscribe` after an awaited `requestPermission` still works in standalone mode; a declarative push is not shown twice when a SW `push` handler exists; a forced 410 after unsubscribing): Alex generates a VAPID key pair (script from `docs/superpowers/reports/spike-webpush/`), a throwaway page on the Pages origin subscribes the home-screen app, and a local Node script using the spike library sends one declarative push through `web.push.apple.com`. Success = the notification appears on the lock screen and tapping it opens plaenicke. If it fails, the design stops here.

## Phase 1 — Worker (branch `notifications`)
- **T1 `worker/src/webpush.js`** — port the spike library (VAPID JWT, RFC 8291). Tests: RFC 8291 Appendix A vector byte for byte; independent decrypt with node:crypto; two mutations (delimiter, info string) go red.
- **T2 Migration `0003_notifications.sql`** + `worker/tests` schema test on node:sqlite.
- **T3 `dueMessages(prefs, items, feeds, now)` and `nextFire(…)`** (pure). Tests: every rule in spec § 5.3 incl. empty day, DST forward/back/ambiguous in America/Los_Angeles, window expiry, `recurring` excluded, done excluded, midnight-split continuation reminds once at the real start, 3-day timed event reminds at its start, sub-06:00 deadline nudged the evening before the previous day, line caps, title cut, invalid tz rejected.
- **T4 Routes** `PUT/DELETE /notify/sub` (endpoint allowlist, one sub per account), `PUT /notify/items` (single CAS statement), `PUT /notify/feeds` (subscribed token only), `PUT /notify/prefs`, `GET /notify/state`. Tests run the real SQL on node:sqlite: stale version refused; feeds and items writes interleaved in both orders keep both halves; upload after the last sub is deleted is refused with no write; a sub from a new device replaces the old.
- **T4b D1 write and CPU budget** — measure rows written (index writes included) per upload and per cron run on local D1, and local CPU for an upload with a full 160 KB half and for a 5-account cron run with full halves; write the per-account daily budget into the spec; a test pins rows-per-upload.
- **T5 `scheduled()`** — `next_fire_at` selection, immediate cleanup of accounts with no sub/device, budgeted `ON CONFLICT DO NOTHING RETURNING` claim gated on the sub existing, release on 429/5xx/throw, conditional `next_fire_at` recompute, measured subrequests per run (does `batch()` count as one?), join `devices`, send with per-origin JWT, 20-fetch cap, status handling, `checkKey`, `last_cron_ok_at`, daily sweep. Tests on node:sqlite with fake fetch: two overlapping runs send each slot once (run them interleaved, not sequentially); an upload during a run neither re-sends nor drops a due slot; an 08:10 upload after a 07:30 summary sends nothing new; an items upload racing a feeds upload never leaves `next_fire_at` later than the earliest due slot; ten dead accounts do not starve a live one; a 503 releases the claim and the next minute sends; revoked device gets nothing; 410 deletes the sub.
- **T6 Cleanup wiring** in `admin.js` disable/delete batches. Tests.
- **T7 `wrangler.toml` `[triggers] crons = ["* * * * *"]`**, version bump, `VAPID_PRIVATE_JWK` secret documented in `docs/admin.md` and `worker/README.md`.

## Phase 2 — Client (same branch)
- **T7b `syncOnce` returns `version` on `ok`** — read the V5 ledger (`.superpowers/sdd/2026-08-02-plaenicke-v5-plan3-client-sync/progress.md`) first; update the "no reader" comment in `js/sync.js`; tests incl. the version-conflict path.
- **T7c `js/ics.js` instance contract** — each emitted segment carries `occurrenceStart` (date + time) and `segment: 'whole'|'first'|'continuation'|'day'`; `js/feeds.js` `instancesForRange` passes them through. Sensitive parser: golden tests unchanged in shape, new unit tests for the midnight split, the 3+-day split and range-edge clipping, and the Brightspace-path mutation checks listed in CLAUDE.md (expandEvents feeds `js/deadlines.js:51`).
- **T8 `js/notifysnapshot.js`** (pure): items/feed segments → one entry per occurrence (from T7c's fields), horizon in `prefs.tz` incl. yesterday, visibility via `js/visibility.js` calendar surface, farthest-days-first trimming to the limits; imports `EVENT_TYPES` (export it from `js/today.js`) and `isTodo`; never emits notes/URLs; feed keys per N18; stable hash for the skip rule.
- **T9 Settings → Reminders** section: disclosure, switch (gesture → permission → subscribe), times, status line; standalone check.
- **T10 Upload wiring** in `app.js`: items half after each successful sync using the returned version, with the hash skip; feeds half on any feed/cache/visibility change on the subscribed device; `GET /notify/state` on open, visible and sign-in; 409 flips the cached state off; unknown browser subscription after a token change → unsubscribe, switch off.
- **T11 Service worker** `push` (show declarative JSON) and `notificationclick` (focus/open `APP_URL`); CACHE bump.
- **T12 Sign-out** — the Worker's logout deletes the device's `push_subs` row in the same batch as its device row; the client calls `unsubscribe()` after `signOutLocal()` succeeds, on both `signOut()` and the revoke inside `signIn()`; no await added between `signOutBlocked()` and the revoke.

## Phase 3 — Release (Alex-run, runbook in `docs/admin.md`)
Backup D1 → migrate 0003 → set `VAPID_PRIVATE_JWK` → deploy Worker → probes (`/notify/state` 401 without session) → merge client → turn on reminders on the iPhone → first summary next morning → check CPU (N13), `Intl` output, cron jitter for a week.

## End of branch
`jaeger:review-sweep` (security, concurrency, data lifecycle, UI). Device checks on the iPhone.
