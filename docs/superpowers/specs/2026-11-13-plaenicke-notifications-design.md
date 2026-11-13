# plaenicke notifications (V8) — design

Date: 2026-11-13. Status: **draft for Alex's approval** (written autonomously; rulings N1–N19 below are decisions made on his behalf, to approve or reject like V7's R1–R21; § 8 lists the questions that are his).

**Revision 2 (same day), after a devil's-advocate review** (1 Critical, 11 Important; `.superpowers/sdd/2026-11-13-autonomous/da-spec-findings.md`). The pre-built queue was replaced by send-time composition with a natural-key claim (§ 4–5). **Revision 2 has not been re-reviewed** — the run's agent cap was reached; review it again before building.

Labels: **concrete** = verified in this repo, a cited source, or a measurement; **speculative** = needs a check, which is named.

Inputs:
- Alex's decisions, 2026-11-11 (recorded in `~/handoffs/plaenicke/main-20261111T1828.md`): Worker-based Web Push; morning summary at a time picked in Settings; a reminder 30 min before every timed event except repeating ones (option B); deadline nudges option B — the evening before at a set time, plus a mention in the morning summary on the day; phone only; **titles may be stored on the Worker in plaintext**; not using Apple Calendar; Cloudflare Free plan. Morning summary contents: today's non-repeating events, the things due / to-do that day, and a couple of upcoming items; all-day items included.
- `docs/superpowers/reports/2026-11-09-notifications-free-plan-spike.md` (copied into this repo 2026-11-13 from branch `worktree-agent-affc23db75adec321`; the spike's WebCrypto push library is copied to `docs/superpowers/reports/spike-webpush/`).
- `docs/superpowers/reports/2026-10-27-notifications-research.md` (copied from `worktree-agent-adff218c12f90165b`).
- V7 accounts as released 2026-11-12 (`docs/superpowers/specs/2026-11-11-plaenicke-accounts-design.md`).

## 1. What changes for whom

| Who | Before | After |
|---|---|---|
| Alex's iPhone (home-screen app) | No notifications | Opt-in per device: a morning summary, a 30-min heads-up for one-off timed events, an evening nudge for tomorrow's deadlines |
| Testers | Nothing on the server can read their planner | Unchanged **unless they turn reminders on**. Turning them on stores the titles and times of the next 7 days of items on the server, readable by it (N2). Settings says so before the switch flips |
| The Worker | HTTP only | Gains a minutely Cron Trigger, 3 D1 tables, 6 routes, a VAPID key |

## 2. Facts this design rests on

- **iOS delivers Web Push to home-screen web apps on iOS 16.4+; Declarative Web Push (no service-worker code needed to show it) on 18.4+.** WebKit 13878 and 16535 (research § 2.1–2.2). **concrete (cited).** Alex's iOS version: unknown — first step of the plan checks it.
- **No local scheduling on iOS:** a reminder while the app is closed needs a server push. (research § 2.4) **concrete.**
- **The Worker cannot read synced data.** V7: the blob is encrypted with a key that never reaches the server. So reminders need the client to hand the Worker what to say and when. **concrete.**
- **Free plan fits:** heaviest realistic cron run ≈ 2.2 ms of 10 ms CPU (local workerd, M4 Pro); 1 of 5 Cron Triggers; 1,440 of 100,000 daily requests. **concrete (measured locally);** production CPU **speculative** (§ 9).
- **`UPDATE … RETURNING` works on production D1** — V7's Phase-1 checks exercised `RETURNING` inside `batch()` on real D1 (2026-11-12, `docs/admin.md` result log). **concrete.** `UPDATE … LIMIT` is not assumed (needs a SQLite compile flag); the claim uses `WHERE id IN (SELECT … LIMIT n)` instead.
- **`Intl` time zones work in workerd** (spike § 4.2, local). Production **speculative**, checked in plan Phase 1.
- **RFC 8291 + VAPID with WebCrypto only:** the spike's ~90-line library reproduces RFC 8291 Appendix A byte for byte and was accepted by a fake push service 71/71. Apple's real endpoint was never contacted. **speculative** until the first real push (plan Phase 0).

## 3. Decision table

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Where the schedule is computed | **The Worker**, from a plaintext snapshot the devices upload | Alex allowed plaintext titles. Server-side computation means any device's upload produces the right schedule for the phone, and the Worker can compose the morning summary itself. The research report's client-encrypted alternative needed a vendored crypto module on the phone and could not be rebuilt by the laptop. |
| D2 | What a snapshot holds | Per entry: `key`, `title`, `date`, `time`, `endTime`, `kind` (`event`/`due`/`todo`), `allDay`, `recurring`, `done`. **Never notes, never feed URLs, never feed names, never item ids in clear for feed instances** (key = SHA-256 of uid+date, truncated) | Minimum needed to compose the three message kinds. Feed URLs are capability tokens (CLAUDE.md invariants) and must never leave the encrypted blob. |
| D3 | Horizon | Today plus the next 7 days (8 local days) | Morning summary needs "a couple of upcoming items"; nudges need tomorrow. Bounds what sits on the server. |
| D4 | Scheduler | One minutely Cron Trigger on the existing Worker. **No pre-built queue:** each run picks accounts whose `next_fire_at` has arrived, composes due messages from the current snapshot, and claims each by a natural key `(account, kind, slot)` with `INSERT OR IGNORE … RETURNING` | A rebuilt queue double-sent or dropped messages on every upload (DA C1) and cost ~160 D1 row writes per upload (DA I2). A natural key makes a slot impossible to send twice and impossible to lose to a concurrent upload; uploads become one row write. |
| D5 | Message format | Declarative Web Push JSON (`web_push: 8030`, `notification.title`, `body`, `navigate` = `APP_URL`), RFC 8291 aes128gcm, VAPID ES256 | Shows without SW code on 18.4+; the SW also gets a `push` handler that shows the same JSON for 16.4–18.3 and desktop browsers. |
| D6 | Time zone | Stored per account, sent by the subscribing device on subscribe and on every open | Item times are zone-less wall-clock strings; the phone's zone is the one that matters for a phone-only feature. |
| D7 | Who subscribes | **One subscription per account; turning reminders on from a device replaces the previous device's subscription** (N17 — Alex to confirm) | Matches "phone only" without browser sniffing, and removes feeds-half flip-flops between devices with different series visibility, per-account time-zone fights, subrequest multiplication and mixed VAPID audiences (DA I8–I10). |
| D8 | Cleanup | Every send joins `devices`, so a deleted device row stops its pushes at once; explicit deletes on reminders-off, sign-out, account delete/disable | V7 deletes device rows on 7 paths (sign-out, sign out others, password change, recovery, admin disable, admin delete, revoke); a join covers all of them without touching each. |

## 4. Data model (migration `0003_notifications.sql`)

```sql
CREATE TABLE push_subs (                   -- at most one row per account (N17)
  account_id   INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL,              -- the subscribing device (devices.token_hash)
  endpoint     TEXT NOT NULL,              -- host must be on the push-service allowlist (N19)
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_sent_at TEXT, last_status INTEGER, failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE notify_prefs (
  account_id    INTEGER PRIMARY KEY,
  tz            TEXT NOT NULL,             -- IANA; validated with Intl on write (400 bad_tz)
  morning_at    TEXT NOT NULL DEFAULT '07:30',
  nudge_at      TEXT NOT NULL DEFAULT '20:00',
  items_sealed  TEXT, items_version INTEGER, items_at INTEGER,   -- items half (any device)
  feeds_sealed  TEXT, feeds_at INTEGER,                          -- feeds half (subscribed device)
  next_fire_at  INTEGER,                   -- earliest unsent slot, epoch ms; recomputed on write and after each run
  updated_at    TEXT NOT NULL
);
CREATE TABLE notify_sent (                 -- natural-key claim; a slot can be sent at most once
  account_id INTEGER NOT NULL,
  kind       TEXT NOT NULL,                -- 'summary' | 'event' | 'nudge' | 'stale-items' | 'stale-feeds'
  slot       TEXT NOT NULL,                -- local date, plus the entry key for 'event'
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind, slot)
);
CREATE INDEX notify_prefs_due ON notify_prefs(next_fire_at);
```

No foreign keys: whether D1 enforces `ON DELETE CASCADE` was not verified, and D8's join makes them unnecessary. A daily sweep deletes `notify_sent` rows older than 3 days, `push_subs` rows whose device is gone, and `notify_prefs` rows with no subscription.

Parameters are positional `?` in every statement (D1 binds `?`/`?NNN`; named `:x` is not assumed).

## 5. Flows

### 5.1 Turning reminders on (device)
1. Settings → **Reminders** shows the disclosure (§ 6) and the switch. Not a home-screen app on iOS → "Add plaenicke to your Home Screen first" (`navigator.standalone` / `display-mode: standalone`).
2. The tap calls `Notification.requestPermission()` then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC })` from the gesture handler. **concrete** (Apple requires the gesture); whether `subscribe` after an awaited `requestPermission` still counts as in-gesture on iOS is checked in Phase 0.
3. `PUT /notify/sub` (session bearer) `{endpoint, keys:{p256dh, auth}, tz}`. The Worker validates `tz` and the endpoint host, then upserts `push_subs` (replacing any other device's row for this account, N17) and creates `notify_prefs` with defaults if missing.
4. The device uploads both halves at once (5.2).

### 5.2 Uploading (only while the account has a subscription)
- **Whether to upload** is a server fact: `GET /notify/state` (on open, on every return to visible, after sign-in) returns `{on, thisDevice, lastSentAt, lastCronOkAt}`. A device on an account with reminders off uploads nothing.
- **Items half** — own items within the horizon, built from the merged state of a successful sync. `syncOnce` returns the server `version` it ended on with every `ok` (new; today `done('ok')` carries none and `syncState.version` is documented as having no reader, `js/sync.js` ~304 — that comment changes). Upload `PUT /notify/items {version, hash, entries}` only when the entries' hash or the local date changed since this device's last accepted upload. One statement:
  `UPDATE notify_prefs SET items_sealed=?, items_version=?, items_at=?, next_fire_at=? WHERE account_id=? AND (items_version IS NULL OR items_version <= ?) AND EXISTS (SELECT 1 FROM push_subs WHERE account_id=?) RETURNING account_id` — no row → 409 `stale_or_off`; the client re-reads state.
- **Feeds half** — from the subscribed device only: non-repeating feed occurrences within the horizon, filtered by its `plaenicke.seriesVisibility` and hidden calendars. Uploaded after any change to feeds, the feed cache or series visibility (not only refreshes), with the same hash skip. `UPDATE … SET feeds_sealed=?, feeds_at=?, next_fire_at=? WHERE account_id=? AND EXISTS (SELECT 1 FROM push_subs WHERE account_id=? AND token_hash=?)`.
- `next_fire_at` is computed by `nextFire(prefs, items, feeds, sent, now)` (pure) before the write.
- Limits: ≤ 400 entries per half, ≤ 64 KB body, titles cut to 120 characters. Rows written per upload: 1 (plus `authenticateDevice`'s `last_seen_at`). Plan Phase 1 measures it on local D1 and fixes a daily budget before testers can turn reminders on.

### 5.3 What is due (Worker, pure `dueMessages(prefs, items, feeds, now)`)
Each entry carries its occurrence's **real start** (`startDate`, `startTime`) and a `continuation` flag, so a feed event that `js/ics.js` splits at local midnight (`:1209-1212`) or spreads over 3+ days as untimed instances (`:1214`) reminds once, at its real start (DA I7).

For local day D in `prefs.tz` (horizon: today + 7):
- **summary** — slot `D`, fires at D `morning_at`, window 2 h. Lines: D's non-repeating events, timed and all-day, own `EVENT_TYPES` and feed (continuations listed once as "continues"), in time order; D's undone to-dos (`due`/`start`/`milestone`/`task`), deadlines first; up to 2 upcoming items within the data the snapshot holds. Title "Today: N events, M due"; the first 4 body lines carry the most important items (the lock screen shows few), then up to 8, then "+K more". Empty day → "Nothing scheduled today" (N8).
- **event** — slot `D|key`, fires at real start − 30 min, window 15 min; timed, non-repeating, non-continuation events only.
- **nudge** — slot `D`, fires at D−1 `nudge_at`, window 1 h, listing undone `due` items on D. A deadline before 06:00 (Brightspace often exports 00:00) belongs to the previous evening's nudge one day earlier, so it is never nudged four hours before it is due (O7).
- **stale-items / stale-feeds** — once, the morning after that half's data runs out ("Open plaenicke on your phone to keep reminders coming" / "…to refresh calendar events"), window 12 h (N7).
- A message whose window has passed is never sent. DST: wall-clock times converted per day with `Intl`; a non-existent time (spring forward) fires at the next valid minute; an ambiguous time (fall back 01:30) fires at the first occurrence.

### 5.4 Sending (cron, every minute)
1. `SELECT account_id FROM notify_prefs WHERE next_fire_at <= ? ORDER BY next_fire_at LIMIT 10` — idle minutes read one index entry and parse nothing (DA I8).
2. Per account: join `push_subs` ⋈ `devices` (no device row → no send, D8); unseal both halves; `dueMessages(…)`; for each message: `INSERT OR IGNORE INTO notify_sent (account_id, kind, slot, claimed_at) VALUES (?,?,?,?) RETURNING slot` — only a returned row is sent. A concurrent run or upload cannot make a slot send twice.
3. Send: RFC 8291 encrypt, POST with `TTL` = seconds left in the window, `Urgency: high`, VAPID JWT cached in `config` **per push-service origin** (`aud`), refreshed when < 1 h of its 12 h remains (DA I9).
4. Stop after 20 fetches in a run (Free plan: 50 subrequests including D1 calls); the rest wait a minute. Raised only after production CPU is measured (N13).
5. Results: 201 → `last_sent_at`, `failures = 0`; 404/410 → delete the subscription (Settings shows reminders stopped, N15); other → `failures + 1`, delete after 10.
6. Recompute and store `next_fire_at`; write `config.last_cron_ok_at` (O9). The cron calls `checkKey` (`worker/src/seal.js:100`) before unsealing.

A run killed mid-way leaves claimed-but-unsent slots: accepted — at most one missed message per slot, never a duplicate.

### 5.5 Turning off and cleanup
- **Reminders off** on the subscribed device: `DELETE /notify/sub` then `pushManager.unsubscribe()`. The Worker deletes the account's `push_subs`, `notify_prefs` and `notify_sent` rows in one batch — nothing readable stays.
- **Sign-out:** accountui calls `DELETE /notify/sub` and `unsubscribe()` **before** `account.logOut()` (the token is dead afterwards; `js/linkui.js` ~570), under the same `signOutBlocked` check; `signOutLocal` stays synchronous (DA I4).
- **Remote sign-out, password change with sign-out-others, recovery, admin revoke:** the device row is deleted elsewhere; D8's join stops sends at once. When that phone next signs in it has a new token: if the browser still holds a subscription the server does not know for this token, the client calls `unsubscribe()` and shows the switch off. **No automatic re-subscribe across a token change** — re-enrolling is a tap with the disclosure (DA I3).
- **Sign in to a different account on the same phone:** same rule; the old account's subscription row points at a deleted device and is swept.
- **Admin disable / delete:** `admin.js` adds the three tables' deletes to its existing batches.

### 5.6 What the user sees
Settings → Reminders: the switch, "Morning summary at [07:30]", "Deadline nudge the evening before at [20:00]" (`PUT /notify/prefs {morning_at, nudge_at, tz}`, recomputes `next_fire_at`), and a status line from `GET /notify/state`: "Last reminder sent: today 07:30", "Reminders are on for another device", or "Reminders stopped — turn them on again." The subscribed device re-checks `pushManager.getSubscription()` on every open; if the browser lost it while the server still has this token's row, the switch shows "stopped" and offers one tap to re-subscribe.

Routes (6): `PUT/DELETE /notify/sub`, `PUT /notify/items`, `PUT /notify/feeds`, `PUT /notify/prefs`, `GET /notify/state`.

### 5.7 Service worker
`push`: parse the declarative JSON and `showNotification`; if parsing fails, still show "plaenicke — open the app" (iOS penalises a push that shows nothing). On 18.4+ a declarative push is shown by the system; Phase 0 checks the SW handler does not show it a second time. `notificationclick`: focus or open `APP_URL`.

## 6. Privacy statement (goes into Settings and the tester note)
> "Reminders need plaenicke's server to keep the titles and times of your next 7 days of items so it can send them while the app is closed. It does not get your notes or your calendar links. The server can read those titles. Turning reminders off deletes them from the server."

The V7 promise ("the server cannot read your planner") stays true for every account that never turns reminders on.

## 7. Rulings (decided on Alex's behalf — approve or reject)

- **N1** — Server-side scheduling from a plaintext snapshot (D1), not client-encrypted payloads. Cost if wrong: titles of 7 days readable by the Worker for opted-in accounts (Alex accepted plaintext 2026-11-11).
- **N2** — Reminders are opt-in per device, with the § 6 disclosure; for testers too. Cost: one extra tap.
- **N3** — Feed events are included (non-repeating only), since Alex does not use Apple Calendar. Their titles leave the device for the first time (the Worker already sees feed bodies in transit, research § 4). Cost: third-party titles at rest for opted-in accounts.
- **N4** — Two-half snapshot in separate columns: items from any device gated atomically on `data.version`; feeds only from the subscribed device, filtered by its own visibility, uploaded on any feed/visibility change. Cost: a laptop edit reaches reminders after the laptop's next sync; a feed change only via the phone.
- **N5** — Both snapshot halves are sealed with `AT_REST_KEY` (`worker/src/seal.js`). The Worker can still read them; this keeps titles out of plain D1 exports and backups. Messages are composed at send time, so nothing else holds titles.
- **N6** — Horizon 8 local days. Cost: up to 8 days of titles on the server.
- **N7** — When a half's data runs out, one "open plaenicke" push per half replaces silence. **This is a notification type Alex did not ask for.** Cost: at most one push per half per week.
- **N8** — The morning summary always sends, even on an empty day (the daily canary that pushes still work). **An addition to Alex's scope** — he may prefer silence on empty days. Cost: a daily push that may say "nothing scheduled".
- **N9** — "Timed event" = own items of `EVENT_TYPES` (`event`, `general`; imported from `js/today.js`, not copied) with a `time`, and feed instances with a time. To-dos with a time get no 30-min reminder; deadlines are covered by the nudge.
- **N10** — "Repeating" = the app's existing meaning (`recurring: true`): DAILY/WEEKLY series plus series the heuristic guessed (same title, weekday and time on ≥ 3 weeks, `js/feeds.js:454-460`). MONTHLY/YEARLY series count as one-offs, so a monthly meeting **does** get a 30-min reminder. **Alex to confirm (§ 8, Q2).**
- **N11** — Defaults: morning 07:30, nudge 20:00, editable in Settings. Cost: none.
- **N12** — No acknowledgement from the service worker in v1: an ack needs the session token readable by the SW, i.e. a new IndexedDB copy of a credential. Health is "last sent" from the server plus the daily summary as canary.
- **N13** — `scheduled()` lives in the existing Worker (one deploy unit). Invocation logs stay off (they would record `/feed` capability URLs). Production CPU is checked via the dashboard's aggregate CPU metrics; if those are not available on Free, a one-off measurement Worker is the fallback (spike § 6). Cost: CPU headroom only estimated until then.
- **N14** — VAPID `sub` is the app URL, not an email (Apple accepts a URL or `mailto:`), so no contact address is published.
- **N15** — A user-visible failure mode: on 404/410 the subscription is deleted and Settings says reminders stopped. No silent retry loop.
- **N16** — Notifications are V8, a separate release after V7's iPhone device checks; release order Worker (migration, routes, cron) → client → turn on.
- **N17** — One subscription per account; the newest device to turn reminders on replaces the previous one. **Alex to confirm (§ 8, Q1).**
- **N18** — Feed entry key = SHA-256 of feedId + uid + start date + start time, truncated to 16 hex (unique across feeds and same-day duplicate UIDs, DA O3).
- **N19** — `PUT /notify/sub` accepts only endpoints on known push services (`*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`), so the cron cannot be pointed at arbitrary hosts (DA O8).

## 8. Questions only Alex can answer
1. **One device or several?** N17 sends to one device per account (the latest to turn reminders on). Several devices would duplicate every reminder.
2. **What counts as "repeating"?** Today's rule treats monthly/yearly series as one-offs (N10), so they get 30-min reminders. Is that what "except repeating ones" meant?
3. **Two additions:** an empty-day "nothing scheduled" summary (N8) and an "open plaenicke" push when reminders are about to run dry (N7). Keep, or drop?
4. iOS version on the phone (Phase 0).

## 9. Out of scope
Per-item "remind me" fields (would change `makeItem`'s 13-key whitelist and the four-copy type list); reminders for repeating events; email or SMS; Apple Calendar export; a Durable Object scheduler; badges.

## 10. Open checks (each has a plan step)
1. Alex's iOS version (≥ 16.4 required; 18.4+ for declarative). Phase 0.
2. One real push to Alex's iPhone through Apple's endpoint, sent by the spike library from the laptop, before anything else is built. Phase 0.
3. `Intl` zones on production workerd; production cron CPU (N13). Phase 1 after the first deploy.
4. Whether the account already uses any of its 5 Cron Triggers (`wrangler triggers` / dashboard). Phase 0.
5. Cron jitter: record `now − fire_at` per send for the first week (`notify_sent` gains `late_ms` while measuring).
6. D1 rows written per upload and per cron run, measured on local D1, against the 100,000/day allowance shared with sync (DA I2).
