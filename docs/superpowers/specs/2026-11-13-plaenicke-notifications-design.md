# plaenicke notifications (V8) — design

Date: 2026-11-13. Status: **draft for Alex's approval** (written autonomously; rulings N1–N16 below are decisions made on his behalf, to approve or reject like V7's R1–R21).

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
| The Worker | HTTP only | Gains a minutely Cron Trigger, 3 D1 tables, 4 routes, a VAPID key |

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
| D4 | Scheduler | One minutely Cron Trigger on the existing Worker, claiming due rows in D1 | Spike § 4.1: no new runtime concept; the atomic claim gives the serialisation a Durable Object would. |
| D5 | Message format | Declarative Web Push JSON (`web_push: 8030`, `notification.title`, `body`, `navigate` = `APP_URL`), RFC 8291 aes128gcm, VAPID ES256 | Shows without SW code on 18.4+; the SW also gets a `push` handler that shows the same JSON for 16.4–18.3 and desktop browsers. |
| D6 | Time zone | Stored per account, sent by the subscribing device on subscribe and on every open | Item times are zone-less wall-clock strings; the phone's zone is the one that matters for a phone-only feature. |
| D7 | Who subscribes | Any signed-in device can turn reminders on for itself; Alex will use the phone | "Phone only" is satisfied by Alex's choice; refusing desktop would need browser sniffing. |
| D8 | Cleanup | Every send joins `devices`, so a deleted device row stops its pushes at once; explicit deletes on reminders-off, sign-out, account delete/disable | V7 deletes device rows on 7 paths (sign-out, sign out others, password change, recovery, admin disable, admin delete, revoke); a join covers all of them without touching each. |

## 4. Data model (migration `0003_notifications.sql`)

```sql
CREATE TABLE push_subs (
  token_hash  TEXT PRIMARY KEY,            -- the device (devices.token_hash)
  account_id  INTEGER NOT NULL,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_sent_at TEXT, last_status INTEGER, failures INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE notify_prefs (
  account_id   INTEGER PRIMARY KEY,
  tz           TEXT NOT NULL,              -- IANA, e.g. America/Los_Angeles
  morning_at   TEXT NOT NULL DEFAULT '07:30',
  nudge_at     TEXT NOT NULL DEFAULT '20:00',
  snapshot_sealed TEXT,                    -- AT_REST_KEY-sealed JSON (N5)
  items_version   INTEGER,                 -- data.version the item half was built from
  items_at        TEXT, feeds_at TEXT,     -- when each half was last uploaded
  updated_at   TEXT NOT NULL
);
CREATE TABLE notify_queue (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL,
  fire_at     INTEGER NOT NULL,            -- epoch ms, UTC
  kind        TEXT NOT NULL,               -- 'summary' | 'event' | 'nudge' | 'stale'
  payload_sealed TEXT NOT NULL,            -- sealed declarative JSON
  late_ms     INTEGER NOT NULL,            -- drop if claimed later than this after fire_at
  claimed_at  INTEGER
);
CREATE INDEX notify_queue_due ON notify_queue(fire_at) WHERE claimed_at IS NULL;
```

Not keyed by foreign keys: whether D1 enforces `ON DELETE CASCADE` was not verified, and D8's join makes it unnecessary. A daily sweep deletes `push_subs` rows whose device is gone and `notify_*` rows of accounts with no subscription left.

## 5. Flows

### 5.1 Turning reminders on (device)
1. Settings → **Reminders** shows the disclosure (N2) and the switch. If the page is not a home-screen app on iOS, it says "Add plaenicke to your Home Screen first" (`navigator.standalone` / `display-mode: standalone`).
2. The tap calls `Notification.requestPermission()` then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC })` inside the gesture handler (Apple requires the gesture). **concrete.**
3. `PUT /notify/sub` (session bearer) with `{endpoint, keys:{p256dh, auth}, tz}`. Worker upserts `push_subs` and `notify_prefs` (defaults on first use).
4. The device uploads a full snapshot at once (5.2), so the first summary does not wait for the next sync.

### 5.2 Uploading a snapshot (any signed-in device of an account with reminders on)
- Two halves, uploaded separately (N4):
  - **Items half** — own items from the synced state: built after every successful sync (push or pull) and stamped with the `data.version` that sync ended on. `PUT /notify/items {version, entries}`. Worker accepts only if `version >= items_version` (a stale device cannot roll the schedule back).
  - **Feeds half** — non-repeating feed instances within the horizon, filtered by this device's `plaenicke.seriesVisibility` (device-local) — **uploaded only by a device that has a push subscription**, after each feed refresh. `PUT /notify/feeds {entries}`; last write wins.
- A device learns whether its account has reminders on from `GET /notify/state` (on open and after sign-in) and caches it; a device on an account with no subscription uploads nothing.
- Every accepted upload rebuilds that account's unclaimed `notify_queue` rows in one `batch()`: delete unclaimed rows for the account, insert the new ones (5.3).
- Limits: ≤ 400 entries per half, ≤ 64 KB body, titles cut to 120 characters.

### 5.3 Building the queue (Worker, pure function `buildQueue(snapshot, prefs, now)`)
For each local day D in the horizon, in `prefs.tz`:
- **summary** at D `morning_at`: lines for (a) D's non-repeating events, timed and all-day (own `EVENT_TYPES` items and feed instances with `recurring: false`), in time order; (b) D's undone to-dos (`due`/`start`/`milestone`/`task`, `done !== true`), deadlines first; (c) up to 2 upcoming items after D (non-repeating events and undone to-dos in the next 7 days). Title "Today: N events, M due". Body ≤ 8 lines, then "+K more". If D has nothing, the summary still goes out ("Nothing scheduled today" + upcoming) — it is the daily canary that pushes still work (research finding 3). `late_ms` 2 h.
- **event** at `start − 30 min` for every timed, non-repeating event on D (own `EVENT_TYPES` and feed `recurring: false`). Body "in 30 min · 14:00–15:00". Skipped if the fire time is already past at build time. `late_ms` 15 min.
- **nudge** at D−1 `nudge_at` for undone `due` items on D (Brightspace `bs-` items are `due` items). One push per evening listing all of tomorrow's deadlines. `late_ms` 1 h.
- **stale** (N7) at the morning after the horizon ends: "plaenicke hasn't been opened in a week — open it to keep reminders coming." `late_ms` 12 h.
- DST: local times converted with `Intl` per day, so 07:30 stays 07:30 across a change; a wall-clock time that does not exist (spring forward) fires at the next valid minute.

### 5.4 Sending (cron, every minute)
1. Claim: `UPDATE notify_queue SET claimed_at = :now WHERE id IN (SELECT id FROM notify_queue WHERE claimed_at IS NULL AND fire_at <= :now ORDER BY fire_at LIMIT 40) RETURNING …`.
2. For each claimed row: if `now − fire_at > late_ms`, drop. Else join `push_subs` ⋈ `devices` for the account (no device row → no send), unseal, encrypt per subscription, POST with `TTL` = remaining `late_ms` in seconds, `Urgency: high`, VAPID JWT cached in `config` (refreshed when < 1 h of its 12 h left).
3. Result per subscription: 201 → `last_sent_at`, `failures = 0`; 404/410 → delete the subscription; other → `failures + 1`, delete after 10 consecutive.
4. Claimed rows older than 2 days are deleted by the daily sweep.

40 per run keeps under the Free plan's 50 subrequests (spike § 4.3) with room for D1 calls; 10 testers × ~10 sends a day never approaches it.

### 5.5 Turning off and cleanup
- **Reminders off** on a device: `pushManager.unsubscribe()`, `DELETE /notify/sub`. If it was the account's last subscription, the Worker deletes `notify_prefs` (snapshot included) and all queue rows — nothing stays readable.
- **Sign-out** (`js/linkui.js` `signOutLocal`): unsubscribe locally first; the device row's deletion makes the join stop sends even if the unsubscribe call fails.
- **Sign in to a different account on the same phone:** the old device row is gone, so no old-account pushes; reminders are off for the new account until turned on.
- **Admin disable / delete account:** `admin.js` gains `DELETE FROM push_subs/notify_prefs/notify_queue WHERE account_id = ?` in the same batch as its existing deletes.

### 5.6 What the user sees
Settings → Reminders: the switch, "Morning summary at [07:30]", "Deadline nudge the evening before at [20:00]", and a status line from `GET /notify/state`: "Last reminder sent to this device: today 07:30" or "Reminders stopped: the phone's subscription expired — turn them on again." The app re-checks `pushManager.getSubscription()` on every open and re-uploads the subscription if it changed or vanished (iOS does not fire `pushsubscriptionchange`, research § 2.3).

## 6. Privacy statement (goes into Settings and the tester note)
> "Reminders need plaenicke's server to keep the titles and times of your next 7 days of items so it can send them while the app is closed. It does not get your notes or your calendar links. The server can read those titles. Turning reminders off deletes them from the server."

The V7 promise ("the server cannot read your planner") stays true for every account that never turns reminders on.

## 7. Rulings (decided on Alex's behalf — approve or reject)

- **N1** — Server-side scheduling from a plaintext snapshot (D1), not client-encrypted payloads. Cost if wrong: titles of 7 days readable by the Worker for opted-in accounts (Alex accepted plaintext 2026-11-11).
- **N2** — Reminders are opt-in per device, with the § 6 disclosure; for testers too. Cost: one extra tap.
- **N3** — Feed events are included (non-repeating only), since Alex does not use Apple Calendar. Their titles leave the device for the first time (the Worker already sees feed bodies in transit, research § 4). Cost: third-party titles at rest for opted-in accounts.
- **N4** — Two-half snapshot: items from any device gated on `data.version`; feeds only from a subscribed device, filtered by its own series visibility. Solves "two devices, one schedule" without a single-writer election. Cost: a laptop edit reaches the schedule after the laptop's next sync; a feed change reaches it only when the phone refreshes feeds.
- **N5** — Snapshot and queue payloads are sealed with `AT_REST_KEY` (AES-GCM, reusing `worker/src/seal.js`). The Worker can still read them; this keeps them out of plain D1 exports and backups. Cost: ~0.01 ms per row.
- **N6** — Horizon 8 local days. Cost: up to 8 days of titles on the server.
- **N7** — When the horizon runs out because no device uploaded, one "open plaenicke" push replaces silence. Cost: one push a week at most.
- **N8** — The morning summary always sends, even on an empty day (the daily canary). Cost: one push a day that may say "nothing scheduled".
- **N9** — "Timed event" = own items of `EVENT_TYPES` (`event`, `general`; imported from `js/today.js`, not copied) with a `time`, and feed instances with a time. To-dos with a time get no 30-min reminder; deadlines are covered by the nudge.
- **N10** — Repeating = feed instance with `recurring: true` (`js/today.js:309` already requires the flag). Own items have no recurrence.
- **N11** — Defaults: morning 07:30, nudge 20:00, editable in Settings. Cost: none.
- **N12** — No acknowledgement from the service worker in v1: an ack needs the session token readable by the SW, i.e. a new IndexedDB copy of a credential. Health is "last sent" from the server plus the daily summary as canary.
- **N13** — `scheduled()` lives in the existing Worker (one deploy unit). Invocation logs stay off (they would record `/feed` capability URLs). Production CPU is checked via the dashboard's aggregate CPU metrics; if those are not available on Free, a one-off measurement Worker is the fallback (spike § 6). Cost: CPU headroom only estimated until then.
- **N14** — VAPID `sub` is the app URL, not an email (Apple accepts a URL or `mailto:`), so no contact address is published.
- **N15** — A user-visible failure mode: on 404/410 the subscription is deleted and Settings says reminders stopped. No silent retry loop.
- **N16** — Notifications are V8, a separate release after V7's iPhone device checks; release order Worker (migration, routes, cron) → client → turn on.

## 8. Out of scope
Per-item "remind me" fields (would change `makeItem`'s 13-key whitelist and the four-copy type list); reminders for repeating events; email or SMS; Apple Calendar export; a Durable Object scheduler; badges.

## 9. Open checks (each has a plan step)
1. Alex's iOS version (≥ 16.4 required; 18.4+ for declarative). Phase 0.
2. One real push to Alex's iPhone through Apple's endpoint, sent by the spike library from the laptop, before anything else is built. Phase 0.
3. `Intl` zones on production workerd; production cron CPU (N13). Phase 1 after the first deploy.
4. Whether the account already uses any of its 5 Cron Triggers (`wrangler triggers` / dashboard). Phase 0.
5. Cron jitter: log `now − fire_at` on each send into `push_subs.last_status` context for the first week.
