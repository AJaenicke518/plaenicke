# Plan — V8 notifications

Spec: `docs/superpowers/specs/2026-11-13-plaenicke-notifications-design.md`. **Not started. Needs Alex's approval of the spec and rulings N1–N16 first.** Every task test-first; gate on `npm test` `# fail 0` and `# cancelled 0`; a fresh reviewer per task that runs the code.

## Phase 0 — before any code (Alex + Claude, ~no code)
- **P0.1** Alex: iOS version on the iPhone (Settings → General → About). Stop if < 16.4.
- **P0.2** Alex: `(cd worker && npm run wrangler -- triggers list)` or dashboard — how many of the 5 account Cron Triggers are used.
- **P0.3** Real-device spike: Alex generates a VAPID key pair (script from `docs/superpowers/reports/spike-webpush/`), a throwaway page on the Pages origin subscribes the home-screen app, and a local Node script using the spike library sends one declarative push through `web.push.apple.com`. Success = the notification appears on the lock screen and tapping it opens plaenicke. If it fails, the design stops here.

## Phase 1 — Worker (branch `notifications`)
- **T1 `worker/src/webpush.js`** — port the spike library (VAPID JWT, RFC 8291). Tests: RFC 8291 Appendix A vector byte for byte; independent decrypt with node:crypto; two mutations (delimiter, info string) go red.
- **T2 Migration `0003_notifications.sql`** + `worker/tests` schema test on node:sqlite.
- **T3 `buildQueue(snapshot, prefs, now)`** (pure). Tests: each rule in spec § 5.3 incl. empty day, DST forward/back in America/Los_Angeles, past fire times skipped, `recurring` excluded, done excluded, 8-line cap, title cut.
- **T4 Routes** `PUT/DELETE /notify/sub`, `PUT /notify/items` (version gate), `PUT /notify/feeds`, `GET /notify/state`; session auth via existing `authenticateDevice`; size limits; rebuild queue in one batch. Tests incl. stale-version rejection and two-device interleavings.
- **T5 `scheduled()`** — claim (`WHERE id IN (SELECT … LIMIT 40) RETURNING`), lateness drop, join `devices`, send, per-status handling, JWT cache in `config`, daily sweep. Tests with fake fetch: double-run claims nothing twice; revoked device gets nothing; 410 deletes the sub.
- **T6 Cleanup wiring** in `admin.js` disable/delete batches. Tests.
- **T7 `wrangler.toml` `[triggers] crons = ["* * * * *"]`**, version bump, `VAPID_PRIVATE_JWK` secret documented in `docs/admin.md` and `worker/README.md`.

## Phase 2 — Client (same branch)
- **T8 `js/notifysnapshot.js`** (pure): items/feed instances → entries; imports `EVENT_TYPES` (export it from `js/today.js`) and `isTodo`; never emits notes/URLs; feed keys hashed.
- **T9 Settings → Reminders** section: disclosure, switch (gesture → permission → subscribe), times, status line; standalone check.
- **T10 Upload wiring** in `app.js`: after successful sync (items half), after feed refresh on a subscribed device (feeds half), on open; `GET /notify/state` cache; re-check `getSubscription()` on open.
- **T11 Service worker** `push` (show declarative JSON) and `notificationclick` (focus/open `APP_URL`); CACHE bump.
- **T12 Sign-out** unsubscribes before `signOutLocal` completes.

## Phase 3 — Release (Alex-run, runbook in `docs/admin.md`)
Backup D1 → migrate 0003 → set `VAPID_PRIVATE_JWK` → deploy Worker → probes (`/notify/state` 401 without session) → merge client → turn on reminders on the iPhone → first summary next morning → check CPU (N13), `Intl` output, cron jitter for a week.

## End of branch
`jaeger:review-sweep` (security, concurrency, data lifecycle, UI). Device checks on the iPhone.
