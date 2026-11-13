# plaenicke notifications (V8) — design

Date: 2026-11-13. Status: **draft for Alex's approval** (written autonomously; rulings N1–N19 below are decisions made on his behalf, to approve or reject like V7's R1–R21; § 8 lists the questions that are his).

**Revision 2 (same day), after a devil's-advocate review** (1 Critical, 11 Important; `.superpowers/sdd/2026-11-13-autonomous/da-spec-findings.md`). The pre-built queue was replaced by send-time composition with a natural-key claim (§ 4–5). **Revision 3 (same day), after a review sweep of revision 2** (6 findings consolidated as Critical, 11 Important; `.superpowers/sdd/2026-11-13-autonomous/sweep-findings.md`): `next_fire_at` can only move earlier from an upload, claims are budgeted and released on retryable failures, the server holds the items hash, dead accounts are cleaned at once, and feed instances need a real-start contract from `js/ics.js` (new plan task). **Revision 3 has not been reviewed** — review it again before building.

**Alex's answers (2026-11-13):** weekly series repeat, monthly/yearly do not (N10 confirmed); notifications on the phone only (N17 tightened); iOS is the latest version (declarative push available); midnight deadlines follow the standard behaviour (N20 replaced). Q3 (the two added push types) still open.

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
| Testers | Nothing on the server can read their planner | Unchanged **unless they turn reminders on**. Turning them on stores the titles and times of up to 9 local days of items (yesterday, today and the next 7) on the server, readable by it (N2). Settings says so before the switch flips |
| The Worker | HTTP only | Gains a minutely Cron Trigger, 3 D1 tables, 6 routes, a VAPID key |

## 2. Facts this design rests on

- **iOS delivers Web Push to home-screen web apps on iOS 16.4+; Declarative Web Push (no service-worker code needed to show it) on 18.4+.** WebKit 13878 and 16535 (research § 2.1–2.2). **concrete (cited).** Alex's iOS version: unknown — first step of the plan checks it.
- **No local scheduling on iOS:** a reminder while the app is closed needs a server push. (research § 2.4) **concrete.**
- **The Worker cannot read synced data.** V7: the blob is encrypted with a key that never reaches the server. So reminders need the client to hand the Worker what to say and when. **concrete.**
- **Free plan, crypto only:** the spike measured ≈ 2.2 ms of 10 ms CPU for a cold isolate plus 3 sends of ~180 B payloads (local workerd, M4 Pro). **concrete for that case.** This design adds per account: unsealing two halves (up to ~160 KB), `JSON.parse`, and `dueMessages` with `Intl` over 9 days; uploads seal one half and unseal the other under the 10 ms HTTP limit. `worker/src/seal.js`'s base64 helpers work a byte at a time (lines 22–30). **All unmeasured: speculative** — plan T4b/T5 measure a 10-account run with full halves before testers can turn reminders on. 1 of 5 Cron Triggers; 1,440 of 100,000 daily requests.
- **`RETURNING` on production D1:** `INSERT … SELECT … RETURNING` inside `batch()` ran in V7's Phase-1 checks, and `UPDATE … RETURNING` in the account-1 upgrade (2026-11-12, `docs/admin.md` result log). **concrete.** The claim here relies on `INSERT … ON CONFLICT DO NOTHING RETURNING` returning **zero rows on a conflict** — true on SQLite 3.50.2 (measured by the sweep), never exercised on production D1: **speculative**, one remote check in plan Phase 0.
- **`Intl` time zones work in workerd** (spike § 4.2, local). Production **speculative**, checked after the first deploy (plan Phase 3).
- **RFC 8291 + VAPID with WebCrypto only:** the spike's ~90-line library reproduces RFC 8291 Appendix A byte for byte and was accepted by a fake push service 71/71. Apple's real endpoint was never contacted. **speculative** until the first real push (plan Phase 0).

## 3. Decision table

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Where the schedule is computed | **The Worker**, from a plaintext snapshot the devices upload | Alex allowed plaintext titles. Server-side computation means any device's upload produces the right schedule for the phone, and the Worker can compose the morning summary itself. The research report's client-encrypted alternative needed a vendored crypto module on the phone and could not be rebuilt by the laptop. |
| D2 | What a snapshot holds | Per entry: `key`, `title`, `startDate`, `startTime`, `endTime`, `kind` (`event`/`due`/`todo`), `allDay`, `recurring`, `done`. One entry per **occurrence**, not per display segment (so no `continuation` entries exist on the server). **Never notes, never feed URLs, never feed names; feed keys per N18** | Minimum needed to compose the three message kinds. Feed URLs are capability tokens (CLAUDE.md invariants) and must never leave the encrypted blob. |
| D3 | Horizon | Yesterday, today and the next 7 days, in `prefs.tz` (9 local days) — built in the account's zone by every uploading device, so a device in another zone cannot drop the phone's today | Morning summary needs "a couple of upcoming items"; nudges need tomorrow. Bounds what sits on the server. |
| D4 | Scheduler | One minutely Cron Trigger on the existing Worker. **No pre-built queue:** each run picks accounts whose `next_fire_at` has arrived, composes due messages from the current snapshot, and claims each by a natural key `(account, kind, slot)` with `INSERT OR IGNORE … RETURNING` | A rebuilt queue double-sent or dropped messages on every upload (DA C1) and cost ~160 D1 row writes per upload (DA I2). A natural key makes a slot impossible to send twice and impossible to lose to a concurrent upload; uploads become one row write. |
| D5 | Message format | Declarative Web Push JSON (`web_push: 8030`, `notification.title`, `body`, `navigate` = `APP_URL`), RFC 8291 aes128gcm, VAPID ES256 | Shows without SW code on 18.4+; the SW also gets a `push` handler that shows the same JSON for 16.4–18.3 and desktop browsers. |
| D6 | Time zone | Stored per account, sent by the subscribing device on subscribe and on every open | Item times are zone-less wall-clock strings; the phone's zone is the one that matters for a phone-only feature. |
| D7 | Who subscribes | **The phone only** (Alex, 2026-11-13): the Reminders switch appears only in the iPhone home-screen app (`navigator.standalone === true`, a WebKit-only property that is true exactly there), and the server keeps one subscription per account (N17) | Matches "phone only" without browser sniffing, and removes feeds-half flip-flops between devices with different series visibility, per-account time-zone fights, subrequest multiplication and mixed VAPID audiences (DA I8–I10). |
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
  items_sealed  TEXT, items_version INTEGER, items_hash TEXT, items_at INTEGER,   -- items half (any device)
  feeds_sealed  TEXT, feeds_at INTEGER,                          -- feeds half (subscribed device)
  next_fire_at  INTEGER,                   -- earliest unsent slot, epoch ms; an upload can only move it EARLIER (MIN); the cron recomputes it only if neither half changed since it read them
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

No foreign keys: whether D1 enforces `ON DELETE CASCADE` was not verified, and D8's join makes them unnecessary. A daily sweep deletes `notify_sent` rows older than 3 days (they hold no titles: kind, local date, entry key). Accounts whose subscription or device is gone are cleaned by the cron the moment it finds them (§ 5.4), not by the sweep.

Parameters are positional `?` in every statement (D1 binds `?`/`?NNN`; named `:x` is not assumed).

## 5. Flows

### 5.1 Turning reminders on (device)
1. Settings → **Reminders** shows the disclosure (§ 6) and the switch. Not a home-screen app on iOS → "Add plaenicke to your Home Screen first" (`navigator.standalone` / `display-mode: standalone`).
2. The tap calls `Notification.requestPermission()` then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC })` from the gesture handler. **concrete** (Apple requires the gesture); whether `subscribe` after an awaited `requestPermission` still counts as in-gesture on iOS is checked in Phase 0.
3. `PUT /notify/sub` (session bearer) `{endpoint, keys:{p256dh, auth}, tz}`. The Worker validates `tz` and the endpoint host, then upserts `push_subs` (replacing any other device's row for this account, N17) and creates `notify_prefs` with defaults if missing.
4. The device uploads both halves at once (5.2).

### 5.2 Uploading (only while the account has a subscription)
- **Whether to upload** is a server fact: `GET /notify/state` (on open, on every return to visible, after sign-in) returns `{on, thisDevice, tz, itemsHash, itemsVersion, lastSentAt, lastCronOkAt}`. A device on an account with reminders off uploads nothing.
- **Items half** — own items within the horizon, built from the merged state of a successful sync. `syncOnce` returns the server `version` it ended on with every `ok` (new; today `done('ok')` carries none and `syncState.version` is documented as having no reader, `js/sync.js` ~304 — that comment changes). Upload `PUT /notify/items {version, hash, entries}` when the entries' hash differs from the **server's** `itemsHash` (from `/notify/state`, refreshed by every 409) — never from this device's own last upload, so a device whose state went back to an older shape still corrects a newer stale snapshot. The route reads the row (to unseal the feeds half and the sent slots for `nextFire`), then writes with one CAS statement:
  `UPDATE notify_prefs SET items_sealed=?, items_version=?, items_hash=?, items_at=?, next_fire_at=MIN(COALESCE(next_fire_at, ?), ?) WHERE account_id=? AND (items_version IS NULL OR items_version <= ?) AND ? <= (SELECT version FROM data WHERE id=?) AND EXISTS (SELECT 1 FROM push_subs WHERE account_id=?) RETURNING account_id` — no row → 409 `stale_or_off` with the current `itemsHash`/`itemsVersion`; the client re-reads state. The `data.version` bound stops a wrong client version from locking honest devices out.
- **Feeds half** — from the subscribed device only: non-repeating feed occurrences within the horizon, filtered by its `plaenicke.seriesVisibility` and hidden calendars. Visibility is read through `js/visibility.js` (the only reader of the key, `js/storage.js:347-353`), using the **calendar** surface. Uploaded after any change to feeds, the feed cache or series visibility (not only refreshes). `UPDATE … SET feeds_sealed=?, feeds_at=?, next_fire_at=MIN(COALESCE(next_fire_at, ?), ?) WHERE account_id=? AND EXISTS (SELECT 1 FROM push_subs WHERE account_id=? AND token_hash=?)`.
- `next_fire_at` is computed by `nextFire(prefs, items, feeds, sent, now)` (pure) from the row the route read; because the write takes `MIN` with the stored value, a concurrent upload or cron run can make the cron wake early (harmless: nothing due, it recomputes) but never late (sweep A1).
- Limits: ≤ 400 entries and ≤ 160 KB per half; titles cut to 120 characters. If a half would exceed either, the client drops the **farthest days first** and Settings says "Reminders cover the next N days" — never a silent cut. Rows written per upload: the prefs row plus its `notify_prefs_due` index entry, plus `authenticateDevice`'s `last_seen_at` (D1 counts index writes as rows: **speculative**, measured in T4b).

### 5.3 What is due (Worker, pure `dueMessages(prefs, items, feeds, now)`)
Each entry is one **occurrence** with its real start (`startDate`, `startTime`). Today `js/ics.js` `emitOccurrence` emits display segments `{uid, title, date, time, endTime}` only: a midnight-crossing event becomes two segments (`:1209-1212`, the second at `00:00`), a 3+-day timed event becomes untimed per-day instances (`:1214`), and `js/feeds.js` `instancesForRange` adds no start field. **So the instance contract must change first** (plan T7c: segments carry `occurrenceStart` and `segment: 'whole'|'first'|'continuation'|'day'`), and `js/notifysnapshot.js` keeps one entry per occurrence (DA I7, sweep B1).

For local day D in `prefs.tz` (horizon: today + 7):
- **summary** — slot `D`, fires at D `morning_at`, window 2 h. Lines: D's non-repeating events, timed and all-day, own `EVENT_TYPES` and feed (continuations listed once as "continues"), in time order; D's undone to-dos (`due`/`start`/`milestone`/`task`), deadlines first; up to 2 upcoming items within the data the snapshot holds. Title "Today: N events, M due"; the first 4 body lines carry the most important items (the lock screen shows few), then up to 8, then "+K more". Empty day → "Nothing scheduled today" (N8).
- **event** — slot `startDate|key` (the event's start date, not the fire date — they differ for events before 00:30), fires at real start − 30 min, window 15 min; timed, non-repeating occurrences only.
- **nudge** — slot `D`, fires at D−1 `nudge_at`, window 1 h, listing undone `due` items on D. Deadlines are taken literally by date and time (N20): the nudge goes the evening before the deadline's date; the summary lists only deadlines still ahead at send time.
- **stale-items / stale-feeds** — once, the morning after that half's data runs out (items: "Open plaenicke to keep reminders coming"; feeds: "Open plaenicke on the phone to refresh calendar events"), window 12 h (N7).
- A message whose window has passed is never sent. DST: wall-clock times converted per day with `Intl`; a non-existent time (spring forward) fires at the next valid minute; an ambiguous time (fall back 01:30) fires at the first occurrence.

### 5.4 Sending (cron, every minute)
1. `SELECT account_id FROM notify_prefs WHERE next_fire_at <= ? ORDER BY next_fire_at LIMIT 5` — idle minutes read one index entry and parse nothing.
2. Per account: read prefs ⋈ `push_subs` ⋈ `devices`. **No subscription or no device row → delete the account's `push_subs` and `notify_prefs` now** (titles gone, § 6) and continue — such an account is never re-selected, so it cannot hold the head of the queue (sweep A6, A10).
3. Unseal both halves; `dueMessages(…)`; take at most the run's remaining **fetch budget** (8 per run until production CPU and subrequests are measured).
4. Claim those messages in one `batch()`, each `INSERT INTO notify_sent (account_id, kind, slot, claimed_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM push_subs WHERE account_id=? AND token_hash=?) ON CONFLICT (account_id, kind, slot) DO NOTHING RETURNING slot` — only returned slots are sent; a constraint error other than the key conflict throws instead of reading as "already claimed" (sweep A5); a subscription deleted meanwhile claims nothing (A7).
5. Send each claimed message: RFC 8291 encrypt, POST with `TTL` = seconds left in the window, `Urgency: high`, VAPID JWT cached in `config` per push-service origin, refreshed when < 1 h of its 12 h remains.
6. Results, written in one `batch()`: 201 → `last_sent_at`, `failures = 0`; 404/410 → delete `push_subs` and `notify_prefs` (Settings shows reminders stopped, N15); 429, 5xx or a thrown fetch → `DELETE FROM notify_sent WHERE account_id=? AND kind=? AND slot=? AND claimed_at=?` (released: retried next minute while its window lasts) and `failures + 1`; 10 consecutive failures → delete the subscription.
7. Recompute `next_fire_at` **only if the snapshot did not change while the run worked**: `UPDATE notify_prefs SET next_fire_at=? WHERE account_id=? AND items_at IS ? AND feeds_at IS ?` — otherwise leave it (an upload already moved it earlier or equal) and the next minute recomputes (sweep A1).
8. `config.last_cron_ok_at` is written at most every 10 minutes (idle runs included), so `GET /notify/state` can show the cron is alive at a cost of 144 writes a day.

**Subrequest budget per run** (Free: 50, D1 queries counted): 1 select + per account (1 read, 1 claim batch, 1 result batch, 1 recompute) + sends + up to 2 JWT/config + 1 `checkKey` when cold. With 5 accounts and 8 sends: about 1 + 20 + 8 + 3 = 32. Whether a D1 `batch()` counts as one subrequest is **speculative**; T5 measures it, and the caps only rise after that. The daily sweep runs in its own cron minute (00:15 UTC), not inside a send run.

### 5.5 Turning off and cleanup
- **Reminders off** on the subscribed device: `DELETE /notify/sub` then `pushManager.unsubscribe()`. The Worker deletes the account's `push_subs` and `notify_prefs` rows in one batch — nothing readable stays. `notify_sent` is kept (no titles; swept after 3 days), so turning reminders off and on again within a day does not re-send messages already sent (sweep A11).
- **Sign-out (both paths: `signOut()` and the revoke inside `signIn()`, `js/accountui.js` ~1024–1066):** no new await goes between `signOutBlocked()` and the revoke — that gap is ruling R13's one-request window and must not widen (sweep B4). Instead the **server** deletes the device's `push_subs` row in the same batch that deletes its device row (`worker/src/accounts.js` ~383 logout path), and the client calls `pushManager.unsubscribe()` **after** `signOutLocal()` succeeds. If the revoke fails offline (`revoked:false`), the local `unsubscribe()` still runs, so the push service answers 410 to the next send and step 6 deletes the subscription.
- **Remote sign-out, password change with sign-out-others, recovery, admin revoke:** the device row is deleted elsewhere; D8's join stops sends at once. When that phone next signs in it has a new token: if the browser still holds a subscription the server does not know for this token, the client calls `unsubscribe()` and shows the switch off. **No automatic re-subscribe across a token change** — re-enrolling is a tap with the disclosure (DA I3).
- **Sign in to a different account on the same phone:** same rule; the old account's subscription row points at a deleted device and is swept.
- **Admin disable / delete:** `admin.js` adds the three tables' deletes to its existing batches.

### 5.6 What the user sees
Settings → Reminders: the switch, "Morning summary at [07:30]", "Deadline nudge the evening before at [20:00]" (`PUT /notify/prefs` with any of `{morning_at, nudge_at, tz}`; the subscribed device sends `tz` alone when its zone differs from the `tz` in `/notify/state`; recomputes `next_fire_at` from both halves), and a status line from `GET /notify/state`: "Last reminder sent: today 07:30", "Reminders are on for another device", or "Reminders stopped — turn them on again." The subscribed device re-checks `pushManager.getSubscription()` on every open; if the browser lost it while the server still has this token's row, the switch shows "stopped" and offers one tap to re-subscribe.

Routes (6): `PUT/DELETE /notify/sub`, `PUT /notify/items`, `PUT /notify/feeds`, `PUT /notify/prefs`, `GET /notify/state`.

### 5.7 Service worker
`push`: parse the declarative JSON and `showNotification`; if parsing fails, still show "plaenicke — open the app" (iOS penalises a push that shows nothing). On 18.4+ a declarative push is shown by the system; Phase 0 checks the SW handler does not show it a second time. `notificationclick`: focus or open `APP_URL`.

## 6. Privacy statement (goes into Settings and the tester note)
> "Reminders need plaenicke's server to keep the titles and times of your items from yesterday through the next 7 days so it can send them while the app is closed. It does not get your notes or your calendar links. The server can read those titles. Turning reminders off deletes them from the server."

The V7 promise ("the server cannot read your planner") stays true for every account that never turns reminders on.

## 7. Rulings (decided on Alex's behalf — approve or reject)

- **N1** — Server-side scheduling from a plaintext snapshot (D1), not client-encrypted payloads. Cost if wrong: titles of 7 days readable by the Worker for opted-in accounts (Alex accepted plaintext 2026-11-11).
- **N2** — Reminders are opt-in per device, with the § 6 disclosure; for testers too. Cost: one extra tap.
- **N3** — Feed events are included (non-repeating only), since Alex does not use Apple Calendar. Their titles leave the device for the first time (the Worker already sees feed bodies in transit, research § 4). Cost: third-party titles at rest for opted-in accounts.
- **N4** — Two-half snapshot in separate columns: items from any device gated atomically on `data.version`; feeds only from the subscribed device, filtered by its own visibility, uploaded on any feed/visibility change. Cost: a laptop edit reaches reminders after the laptop's next sync; a feed change only via the phone.
- **N5** — Both snapshot halves are sealed with `AT_REST_KEY` (`worker/src/seal.js`). The Worker can still read them; this keeps titles out of plain D1 exports and backups. Messages are composed at send time, so nothing else holds titles.
- **N6** — Horizon 9 local days (yesterday through today + 7) in the account's zone. Cost: up to 9 days of titles on the server.
- **N7** — When a half's data runs out, one "open plaenicke" push per half replaces silence. **This is a notification type Alex did not ask for.** Cost: at most one push per half per week.
- **N8** — The morning summary always sends, even on an empty day (the daily canary that pushes still work). **An addition to Alex's scope** — he may prefer silence on empty days. Cost: a daily push that may say "nothing scheduled".
- **N9** — "Timed event" = own items of `EVENT_TYPES` (`event`, `general`; imported from `js/today.js`, not copied) with a `time`, and feed instances with a time. To-dos with a time get no 30-min reminder; deadlines are covered by the nudge.
- **N10** — **Confirmed by Alex 2026-11-13:** weekly series repeat (no 30-min reminder); monthly and yearly series do not (they get one). This is the app's existing `recurring` meaning (`js/feeds.js:454-460`): DAILY and WEEKLY series, plus series the heuristic guessed from the same title, weekday and time on ≥ 3 weeks. Daily series stay "repeating" too — Alex named weekly; daily repeats more often than weekly, so it follows.
- **N11** — Defaults: morning 07:30, nudge 20:00, editable in Settings. Cost: none.
- **N12** — No acknowledgement from the service worker in v1: an ack needs the session token readable by the SW, i.e. a new IndexedDB copy of a credential. Health is "last sent" from the server plus the daily summary as canary.
- **N13** — `scheduled()` lives in the existing Worker (one deploy unit). Invocation logs stay off (they would record `/feed` capability URLs). Production CPU is checked via the dashboard's aggregate CPU metrics; if those are not available on Free, a one-off measurement Worker is the fallback (spike § 6). Cost: CPU headroom only estimated until then.
- **N14** — VAPID `sub` is the app URL, not an email (Apple accepts a URL or `mailto:`), so no contact address is published.
- **N15** — A user-visible failure mode: on 404/410 the subscription is deleted and Settings says reminders stopped. No silent retry loop.
- **N16** — Notifications are V8, a separate release after V7's iPhone device checks; release order Worker (migration, routes, cron) → client → turn on.
- **N17** — **Phone only (Alex, 2026-11-13).** The switch is shown only when `navigator.standalone === true`; the server still keeps at most one subscription per account (a re-installed home-screen app replaces the old one).
- **N18** — Feed entry key = SHA-256 of feedId + uid + start date + start time, truncated to 16 hex (unique across feeds and same-day duplicate UIDs, DA O3).
- **N20** — **Alex, 2026-11-13: follow the standard.** A deadline is taken literally by its date and time, with no special case: the nudge fires the evening before its *date*, so a 00:00 deadline on Friday is nudged Thursday at `nudge_at` (a few hours before it is due). The morning summary lists only deadlines that are still ahead at send time, so a deadline that passed overnight is not shown as "due today".
- **N19** — `PUT /notify/sub` accepts only endpoints on known push services (`*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`), so the cron cannot be pointed at arbitrary hosts (DA O8).

## 8. Questions only Alex can answer
Answered 2026-11-13: one device (the phone only, N17); weekly repeats, monthly/yearly do not (N10); iOS is the latest version; midnight deadlines follow the standard (N20).

Still open:
1. **The two notification types Alex did not ask for** — (a) N8: on a day with nothing scheduled, send the morning summary anyway ("Nothing scheduled today"), which also proves reminders still work; or send nothing on empty days. (b) N7: if the phone has not opened plaenicke for about a week, the server's copy of upcoming items runs out; send one "Open plaenicke to keep reminders coming", or let reminders stop silently.

## 9. Out of scope
Per-item "remind me" fields (would change `makeItem`'s 13-key whitelist and the four-copy type list); reminders for repeating events; email or SMS; Apple Calendar export; a Durable Object scheduler; badges.

## 10. Open checks (each has a plan step)
1. Alex's iOS version (≥ 16.4 required; 18.4+ for declarative). Phase 0.
2. One real push to Alex's iPhone through Apple's endpoint, sent by the spike library from the laptop, before anything else is built. Phase 0.
3. `Intl` zones on production workerd; production cron CPU (N13). Phase 3, after the first deploy.
4. Whether the account already uses any of its 5 Cron Triggers (`wrangler triggers` / dashboard). Phase 0.
5. Cron jitter: record `now − fire_at` per send for the first week (`notify_sent` gains `late_ms` while measuring).
6. D1 rows written per upload and per cron run (index writes included), measured on local D1, against the 100,000/day allowance shared with sync (DA I2, sweep D2).
7. `INSERT … ON CONFLICT DO NOTHING RETURNING` returns zero rows on a conflict on production D1 (one `wrangler d1 execute --remote` against a scratch table). Phase 0.
8. Whether a D1 `batch()` counts as one subrequest. T5.
