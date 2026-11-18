# plaenicke notifications (V8) — design

Date: 2026-11-13. Revision 5 (with review fixes): 2026-11-17. Status: **approved by Alex, 2026-11-17** (rulings N1–N25 included). Phase 0 of the plan comes before any code.

**Revision history.** Review records are in `.superpowers/sdd/2026-11-13-autonomous/`, which is gitignored and local only.
- **Rev 2** (2026-11-13) replaced the pre-built queue with send-time composition and a natural-key claim. Source: `da-spec-findings.md`.
- **Rev 3** (same day): uploads only move `next_fire_at` earlier, claims are budgeted, the server holds the items hash, dead accounts are cleaned at once, and the `ics.js` real-start contract was added. Source: `sweep-findings.md`.
- **Rev 4** (2026-11-17), after three reviews of rev 3 (5 Critical): coverage dates, per-account isolation, leased claims, every push status mapped, tracked deadline copies excluded, `snap_rev`, guarded deletes, the tz travels with the feeds half, version-keyed skip, split 409s, the sweep, `endDate`, the empty-day wording. Source: `rev3-review-findings.md`.
- **Rev 5** (2026-11-17), after two reviews of rev 4 (2 Critical, both found by both reviewers; `rev4-review-findings.md`). This revision **removes mechanism** where it can.
  - **Removed:**
    - uploads no longer compute `next_fire_at`; every writer sets it to "now or earlier" and the cron recomputes within a minute;
    - one cron expression instead of two.
  - **Added:**
    - the feeds half is re-uploaded when its coverage falls behind (C1);
    - `nextFire` counts lease expiry (C2);
    - accounts are leased at selection, so a run that dies can't pin the queue;
    - claim, send and record happen one message at a time, under a subrequest reserve;
    - format columns, `feeds_seq`, `paused`, VAPID JWT eviction;
    - N23 refined by Alex.
  - Reviewed once (converging; one Critical, `feeds_seq` reset), with every finding fixed the same day (`rev5-review-findings.md`).

**Alex's answers.**
- **2026-11-13:**
  - weekly series repeat; monthly and yearly don't (N10);
  - phone only (N17);
  - iOS is the latest version;
  - midnight deadlines follow the standard behaviour (N20);
  - empty days get a friendly summary (N8);
  - reminders stop quietly when the app isn't opened (N7).
- **2026-11-17:**
  - untracked Brightspace "- Due" feed entries are excluded (N21);
  - the empty-day text never claims the day is empty (N8);
  - a send that didn't finish is retried, so a rare duplicate is accepted (N22);
  - a subscription is dropped only after 3 messages expired unsent **and** 24 h passed with no success (N23).

Labels: **concrete** = verified in this repo, a cited source, or a measurement; **speculative** = needs a check, which is named.

Inputs:
- **Alex's decisions, 2026-11-11** (`~/handoffs/plaenicke/main-20261111T1828.md`):
  - Worker-based Web Push;
  - a morning summary at a time picked in Settings;
  - a reminder 30 min before every timed event except repeating ones;
  - deadline nudges the evening before at a set time, plus a mention in that day's summary;
  - phone only;
  - **titles may be stored on the Worker in plaintext**;
  - not using Apple Calendar;
  - Cloudflare Free plan;
  - summary contents: today's non-repeating events, what's due or to-do that day, a couple of upcoming items, all-day items included.
- `docs/superpowers/reports/2026-11-09-notifications-free-plan-spike.md`. The spike's WebCrypto push library is in `docs/superpowers/reports/spike-webpush/`.
- `docs/superpowers/reports/2026-10-27-notifications-research.md`.
- V7 accounts as released 2026-11-12 (`docs/superpowers/specs/2026-11-11-plaenicke-accounts-design.md`).

## 1. What changes for whom

| Who | Before | After |
|---|---|---|
| Alex's iPhone (home-screen app) | No notifications | Opt-in on the phone: a morning summary, a 30-min heads-up for one-off timed events, an evening nudge for tomorrow's deadlines |
| Testers | Nothing on the server can read their planner | Unchanged **unless they turn reminders on**. Turning them on stores the titles and times of up to 9 local days of items on the server, readable by it (N2). Settings says so before the switch flips |
| The Worker | HTTP only | Gains one minutely Cron Trigger, 3 D1 tables, 6 routes, a VAPID key |

## 2. Facts this design rests on

- **iOS delivers Web Push to home-screen web apps on 16.4+, and Declarative Web Push on 18.4+.** Sources: WebKit 13878 and 16535 (research § 2.1–2.2). Alex is on the latest iOS. **concrete (cited).**
- **No local scheduling on iOS:** a reminder while the app is closed needs a server push (research § 2.4). **concrete.**
- **The Worker cannot read synced data.** Since V7 the blob is encrypted with a key that never reaches the server. **concrete.**
- **Free-plan CPU** (10 ms per invocation).
  - **Measured:** the spike measured ≈ 2.2 ms for a cold isolate plus 3 sends (local workerd). **concrete for that case.**
  - **Added per selected account:** unsealing two halves (up to ~213 KB of base64; `worker/src/seal.js:22–30` decodes byte by byte), `JSON.parse`, and `dueMessages` with `Intl`.
  - **Uploads** only seal their own half; they no longer unseal the other one (§ 5.2).
  - **Unmeasured: speculative.** T4b measures it, and the result **sets** the per-run account limit (§ 5.4).
- **`RETURNING` on D1.**
  - **On production:** `INSERT … SELECT … RETURNING` in `batch()` and `UPDATE … RETURNING` ran in V7's Phase-1 checks and the account-1 upgrade (`docs/admin.md` result log). **concrete.**
  - **On node:sqlite 3.50.2 (2026-11-17), checked:**
    - § 5.4's lease claim (`ON CONFLICT … DO UPDATE … WHERE … RETURNING`) returns zero rows on a live lease, a sent slot, or a missing subscription;
    - § 5.4's account lease (`UPDATE … WHERE account_id IN (SELECT … ORDER BY … LIMIT ?) RETURNING`) gives a second run in the same minute different accounts.
    - On production D1 both are **speculative**: plan P0.4.
- **`Intl` time zones work in workerd** (spike § 4.2, local). On production: **speculative** (Phase 3).
- **RFC 8291 + VAPID with WebCrypto only.** The spike's library (`spike-webpush-lib.mjs`) reproduces RFC 8291 Appendix A byte for byte. Apple's endpoint was never contacted. **speculative** until P0.3.
- **SQLite `MIN(x, NULL)` and `NULL < x` are NULL** (node:sqlite). Every comparison below that can see a NULL handles it explicitly. **concrete.**

## 3. Decision table

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Where the schedule is computed | **The Worker**, from a plaintext snapshot the devices upload | Alex allowed plaintext titles. Any device's upload yields the right schedule, and the Worker composes the summary itself. |
| D2 | What a snapshot holds | Per entry: `key`, `title`, `startDate`, `startTime`, `endDate`, `endTime`, `kind` (`event`/`due`/`todo`), `allDay`, `recurring`, `done`. One entry per **occurrence** that overlaps the horizon. Per half: `through` (last local date covered after trimming) and `format`. The feeds half also records its `tz`. **Never notes, feed URLs or feed names. Feed keys per N18** | The minimum for the three message kinds. `endDate` gives "continues" lines. `through` tells "not covered" from "empty". Feed URLs are capability tokens (CLAUDE.md). |
| D3 | Horizon | Yesterday, today and the next 7 days in `prefs.tz` (9 local days) | Summary upcoming items and next-day nudges. Bounds what sits on the server. |
| D4 | Scheduler | One minutely Cron Trigger. **No pre-built queue:** accounts whose `next_fire_at` has arrived are leased, due messages are composed from the current snapshot, and each is claimed by a natural key `(account, kind, slot)` with a 5-min lease, one message at a time | The natural key stops two runs sending one slot. The claim lease retries a send from a dead run (N22). The account lease stops a dead run from pinning the queue. |
| D5 | Message format | Declarative Web Push JSON (`web_push: 8030`, `notification.title`, `body`, `navigate` = `APP_URL`), RFC 8291 aes128gcm, VAPID ES256 | Shown by the system on 18.4+. The service worker's `push` handler covers 16.4–18.3. |
| D6 | Time zone | Stored per account. Changed only by the subscribed device, together with a feeds half expanded in that zone | Feed instances are expanded into a zone (`js/feeds.js:764–775`). A zone change without them would shift every feed reminder. |
| D7 | Who subscribes | **The phone only** (Alex, 2026-11-13). The switch appears only when `navigator.standalone === true`. One subscription per account, one account per endpoint (N17) | |
| D8 | Cleanup | Every send joins `devices` and `accounts.disabled_at IS NULL`. Explicit deletes on reminders off, sign-out, and account delete or disable. A daily sweep removes what the cron never selects | V7 deletes device rows on 7 paths, including `revokeDevice` (`worker/src/auth.js:75–77`). The join covers all of them. |
| D9 | Who computes `next_fire_at` | **Only the cron.** Every HTTP writer sets it to "now, or earlier if already earlier" | No unseal of the other half in the HTTP path, no `sent` read, and one rule for every writer. Cost: at most one extra cron wake per upload. The shortest window (15 min) absorbs the one-minute delay. |

## 4. Data model (migration `0003_notifications.sql`)

```sql
CREATE TABLE push_subs (                   -- at most one row per account (N17)
  account_id       INTEGER PRIMARY KEY,
  token_hash       TEXT NOT NULL,          -- the subscribing device (devices.token_hash)
  endpoint         TEXT NOT NULL UNIQUE,   -- one account per endpoint; host on the allowlist (N19)
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,       -- epoch ms
  last_sent_at     INTEGER,                -- last 201
  last_status      INTEGER,
  first_failure_at INTEGER,                -- start of the current failure run; NULL after a 201 (backoff)
  lost_count       INTEGER NOT NULL DEFAULT 0, -- messages that ran out of window unsent since the last 201 (N23)
  retry_after      INTEGER                 -- epoch ms; no send before this
);
CREATE TABLE notify_prefs (
  account_id    INTEGER PRIMARY KEY,
  tz            TEXT NOT NULL,             -- IANA; validated with Intl on every write (400 bad_tz)
  morning_at    TEXT NOT NULL DEFAULT '07:30',
  nudge_at      TEXT NOT NULL DEFAULT '20:00',
  items_sealed  TEXT, items_version INTEGER, items_hash TEXT, items_through TEXT, items_format INTEGER, items_at INTEGER,
  feeds_sealed  TEXT, feeds_tz TEXT, feeds_through TEXT, feeds_format INTEGER, feeds_seq INTEGER, feeds_at INTEGER,
  snap_rev      INTEGER NOT NULL DEFAULT 0, -- +1 on every HTTP write; cron writes never bump it
  next_fire_at  INTEGER,                   -- earliest instant the cron should look; NULL = nothing to send
  last_error    TEXT, last_error_at INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE notify_sent (                 -- natural-key claim
  account_id INTEGER NOT NULL,
  kind       TEXT NOT NULL,                -- 'summary' | 'event' | 'nudge'
  slot       TEXT NOT NULL,                -- local date; for 'event' also start time and key
  claimed_at INTEGER NOT NULL,
  window_end INTEGER NOT NULL,             -- epoch ms; the lease is never retried past it
  sent_at    INTEGER,                      -- NULL = claimed, not confirmed
  status     INTEGER,
  PRIMARY KEY (account_id, kind, slot)
);
CREATE INDEX notify_prefs_due ON notify_prefs(next_fire_at);
```

- **No foreign keys:** D1 cascades were not verified, and D8's join makes them unnecessary.
- **Parameters** are positional `?` everywhere.
- **The wake rule (D9).** Every HTTP writer (`/notify/sub`, `/notify/items`, `/notify/feeds`, `/notify/prefs`) sets:
  `snap_rev = snap_rev + 1, updated_at = ?now, next_fire_at = CASE WHEN next_fire_at IS NULL OR next_fire_at > ?now THEN ?now ELSE next_fire_at END`
  - Only the cron's guarded recompute (`WHERE snap_rev = ?`) and its account lease move `next_fire_at` later or set it to NULL.
  - Checked on node:sqlite. **concrete.**

## 5. Flows

### 5.1 Turning reminders on (phone)
1. Settings → **Reminders** shows the disclosure (§ 6) and the switch, only when `navigator.standalone === true`.
2. The tap calls `Notification.requestPermission()`, then `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC })`. Apple requires a user gesture. Phase 0 checks that `subscribe` after an awaited `requestPermission` still counts.
3. `PUT /notify/sub` (session bearer) `{endpoint, keys:{p256dh, auth}, tz}`. The Worker validates `tz` and the endpoint host, then runs one `batch()` **in this order**:
   1. delete any **other** account's `push_subs` row with this endpoint, and that account's `notify_prefs` under a `NOT EXISTS` guard. This delete must come first, because the upsert below would otherwise throw on `UNIQUE(endpoint)` (node:sqlite).
   2. upsert this account's `push_subs`: replace another device's row for this account (N17); reset `first_failure_at`, `lost_count`, `retry_after`.
   3. create or update `notify_prefs` with this `tz` and **`feeds_seq = NULL`** (a new or reinstalled phone starts its counter again), applying the wake rule. `push_subs.created_at` is set to now on every upsert.
4. The phone uploads the feeds half, then the items half (§ 5.2).

### 5.2 Uploading (only while the account has a subscription)
- **`GET /notify/state`** (on open, on every return to visible, after sign-in) returns:
  - `{on, thisDevice, tz}`;
  - `{itemsHash, itemsVersion, itemsThrough, itemsFormat, feedsThrough, feedsFormat, feedsSeq}`;
  - `{lastSentAt, lastCronOkAt, lastError, lastErrorAt}`.
  - A device on an account with reminders off uploads nothing.
- **Entry validation (both halves):**
  - dates are `YYYY-MM-DD`;
  - times are `HH:MM` (00–23:00–59) or null;
  - `kind` is in its enum, booleans are booleans, `title` is a string, `key` is ≤ 64 characters.
  - Anything else → 400 `bad_entries`, nothing written.
  - `format` ≠ the Worker's supported format → 400 `bad_format`. The client treats it as terminal until it reloads a newer build, and does not retry it after each sync.
- **Items half** — own items whose occurrence overlaps the horizon.
  - **Source:** the merged state the `ok` `syncOnce` pushed, which is what `applyState` **returned** (`js/sync.js:313`; it re-merges against live storage, `:301–302`). Not a later localStorage read.
  - **Version:** `syncOnce` returns the version it ended on with every `ok`. Today `done('ok')` carries none, and the "no reader" comment at `js/sync.js:304–309` changes.
  - **Skip rule:** the hash covers `{version, through, format, entries}`. The client skips only when the returned version **and** the hash equal the server's last confirmed values (from `/notify/state`, an upload response, or a 409).
  - **Request:** `PUT /notify/items {version, hash, through, format, entries}`, written with one CAS statement (no unseal, no other read):
    `UPDATE notify_prefs SET items_sealed=?, items_version=?, items_hash=?, items_through=?, items_format=?, items_at=?, <wake rule> WHERE account_id=? AND EXISTS (SELECT 1 FROM push_subs WHERE account_id=?) AND ? <= (SELECT version FROM data WHERE id=?) AND (items_format IS NULL OR items_format <= ?) AND (items_version IS NULL OR items_version < ? OR (items_version = ? AND (items_through IS NULL OR items_through <= ?))) AND NOT (feeds_through IS NOT NULL AND feeds_through < ?cutoff) AND NOT (feeds_through IS NULL AND (SELECT created_at FROM push_subs WHERE account_id=?) < ?now-86400000) RETURNING account_id`
  - **No row:** one more read decides the answer:
    - no subscription → 409 `off`;
    - stored `items_format` is higher → 409 `old_format` (terminal until the client reloads a newer build);
    - `feeds_through` is before `cutoff`, or still NULL a day after subscribing → 409 `paused`;
    - otherwise 409 `stale`, with the current `itemsVersion`/`itemsHash`.
  - **`cutoff`** = UTC date − 2 days (conservative; no per-row `Intl`).
  - **`paused`:** the server holds the phone's feeds half and it is past, so items from another device would keep titles on the server that can never be sent. The subscribed device answers `paused` by uploading its feeds half and retrying. Other devices stop until their next `/notify/state`.
- **Feeds half** — from the subscribed device only.
  - **What goes in:** non-repeating feed occurrences overlapping the horizon.
  - **Filters**, in this order:
    1. `plaenicke.seriesVisibility` through `js/visibility.js` on the **calendar** surface, plus hidden calendars;
    2. `hideTrackedCopies(…, trackedCopyIds(items, tombstones))` (`js/deadlines.js:202–216`), as the calendar views do (`js/app.js:222–224`);
    3. instances whose title passes `isTrackableTitle` (`js/deadlines.js:24`) (N21).
  - **An account with no feeds** uploads an empty half (`entries: []`), so coverage still advances.
  - **When.** Uploads go through one client-side queue, so they never overlap. The subscribed device uploads:
    - after any change to feeds, the feed cache or series visibility;
    - when its zone differs from `/notify/state.tz`;
    - **whenever `/notify/state.feedsThrough` is null or earlier than the `through` it would upload now.** That catches the date rolling over, and feeds whose fetches keep failing.
  - **Request:** `PUT /notify/feeds {seq, tz, through, format, entries}`. `seq` = `max(Date.now(), last seq + 1, feedsSeq + 1)`, a device-local value that only goes up:
    `UPDATE notify_prefs SET feeds_sealed=?, feeds_tz=?, feeds_through=?, feeds_format=?, feeds_seq=?, feeds_at=?, tz=?, <wake rule> WHERE account_id=? AND EXISTS (SELECT 1 FROM push_subs WHERE account_id=? AND token_hash=?) AND (feeds_seq IS NULL OR feeds_seq < ?) AND (feeds_format IS NULL OR feeds_format <= ?) RETURNING account_id`
  - **No row:** 409 `off`, `old_format` or `stale`, decided by one read. On `stale` the client re-reads `/notify/state` and retries once with `seq` above `feedsSeq`. `PUT /notify/sub` sets `feeds_seq = NULL` (§ 5.1 step 3.3).
  - **The zone** changes only here and in `PUT /notify/sub`. Own items are zone-less wall clock, so they are read correctly in the new zone. The items `through` may lag a day until the next items upload, and coverage (§ 5.3) bounds that.
- **Limits:** ≤ 400 entries and ≤ 160 KB per half; titles cut to 120 characters. If a half would exceed either, the client drops the **farthest days first**, sets `through` to the last whole day kept, and Settings says "Reminders cover the next N days".
- **Rows written per upload:** the prefs row plus its index entry, plus `authenticateDevice`'s `last_seen_at`. Index writes counting as rows is **speculative** (T4b).

### 5.3 What is due (Worker, pure `dueMessages(prefs, items, feeds, sent, now)` and `nextFire(…)`)
**Occurrences.** Each entry is one occurrence with its real start and end.
- **Today's ics.js output:** `js/ics.js` emits display segments `{uid, title, date, time, endTime}` only (`emitOccurrence`, `:1168–1214`).
  - A midnight-crossing event becomes two segments (`:1209–1212`).
  - A 3+-day timed event becomes untimed per-day instances (`:1214`).
  - An occurrence clipped at the range start has no `first` segment.
  - `js/feeds.js` `instancesForRange` rebuilds instances from named fields (`:791–804`).
- **So the instance contract changes first** (plan T7c).

**Coverage.** Day D is **covered** only when:
- both halves are non-NULL;
- `feeds_tz = tz`;
- both formats are supported;
- D ≤ `items_through` and D ≤ `feeds_through`.

A NULL half is never unsealed. Nothing is composed for an uncovered day: no summary, no nudge for D, no event reminder starting on D. Past coverage, `nextFire` returns null (N7).

For each covered local day D in `prefs.tz`:
- **summary** — slot `D`, fires at D `morning_at`, window 2 h.
  - **Lines:**
    - D's non-repeating events, timed and all-day, own `EVENT_TYPES` and feed, in time order; an occurrence that started before D with `endDate` ≥ D is listed once as "continues";
    - D's undone to-dos (`due`/`start`/`milestone`/`task`), deadlines first, deadlines already past at send time left out (N20);
    - up to 2 upcoming items from covered days.
  - **Title** "Today: N events, M due". The first 4 body lines carry the most important items, then up to 8, then "+K more".
  - **No one-off events, nothing due and nothing upcoming:** title "No one-off events today", body one friendly line chosen by date from a fixed list (N8).
- **event** — slot `startDate|startTime|key`, fires at real start − 30 min, window 15 min. Timed, non-repeating occurrences only. The slot's start time means an event moved later the same day is reminded again.
- **nudge** — slot `D`, fires at D−1 `nudge_at`, window 1 h, listing undone `due` items on D (N20). Needs D covered.

**Time.**
- Wall clock is converted per day with `Intl`. The −30 min is taken from the instant of the real start.
- A wall-clock time that doesn't exist (spring forward), whether a fire time or an event start, maps to the next valid minute.
- An ambiguous time (fall back) maps to the first occurrence.
- A message whose window has passed is never sent.

**`sent`** is the account's `notify_sent` rows.
- A slot with `sent_at` set isn't due.
- A slot with a live lease (`sent_at IS NULL AND claimed_at > now − 5 min`) isn't due **now**, but `nextFire` includes `claimed_at + 5 min` as a candidate when that is before `window_end`. So a run that dies is followed by a run when its lease expires (N22).
- `dueMessages` returns messages most urgent first (earliest window end).

**Prefs validation:** `PUT /notify/prefs` accepts `morning_at` in `04:00–12:00` and `nudge_at` in `16:00–23:00`, so no window crosses a date and neither hits a spring-forward gap. Anything else → 400 `bad_time`.

### 5.4 Sending (cron, every minute)
The handler is `scheduled(event)`. One expression, `* * * * *`. The run whose `event.scheduledTime` is 00:15 UTC also does the daily sweep (§ 5.5) after its send work.

**Subrequest reserve.** The run keeps a counter against the Free limit of 50, where every D1 statement and every fetch counts as one (whether a `batch()` counts as one is unmeasured, so it isn't assumed). Before each message it requires remaining ≥ `7 + 3 × (accounts not yet started) + 2 + 1 + (sweep run ? 6 : 0)`. The 7 is the worst single message: claim, a JWT refresh write, a fetch, on 401/403 an evict and re-sign write and a second fetch, then 2 record statements. The 2 is the catch path, the 1 is liveness. Otherwise it stops claiming, finishes step 5 for accounts already started, and leaves the rest for the next minute. **Fixed costs:** account lease 1, VAPID config 1–2, `checkKey` up to 3 when cold (`seal.js:105–110`), `last_cron_ok_at` 1.

1. **Lease accounts:** `UPDATE notify_prefs SET next_fire_at = ?now+120000 WHERE account_id IN (SELECT account_id FROM notify_prefs WHERE next_fire_at <= ?now ORDER BY next_fire_at LIMIT ?) RETURNING account_id`.
   - The limit starts at 3 and is set by T4b.
   - A run that dies delays these accounts by 2 minutes instead of pinning them. An overlapping run picks other accounts.
   - Idle minutes read one index entry.
2. **Per account, inside its own `try/catch`:** `SELECT … FROM notify_prefs LEFT JOIN push_subs … LEFT JOIN devices … LEFT JOIN accounts …`.
   - **No live subscription** (no sub row, no device row, or `disabled_at` set):
     - if a sub row was read: `DELETE FROM push_subs WHERE account_id=? AND token_hash=? AND endpoint=?` with the values read;
     - then: `DELETE FROM notify_prefs WHERE account_id=? AND NOT EXISTS (SELECT 1 FROM push_subs WHERE account_id=?)`;
     - continue.
   - **`retry_after` in the future:** `UPDATE notify_prefs SET next_fire_at=? WHERE account_id=? AND snap_rev=?` with `retry_after`, and continue. No unseal.
3. **Compose:** unseal the non-NULL halves, read `notify_sent` for the account, run `dueMessages`.
4. **For each message, one at a time, while the reserve allows:**
   1. **Claim:** `INSERT INTO notify_sent (account_id, kind, slot, claimed_at, window_end) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM push_subs WHERE account_id=? AND token_hash=? AND endpoint=?) ON CONFLICT (account_id, kind, slot) DO UPDATE SET claimed_at=excluded.claimed_at, status=NULL WHERE notify_sent.sent_at IS NULL AND notify_sent.claimed_at <= ?now-300000 AND notify_sent.window_end > ?now RETURNING slot`. No row → skip this message, but it **stays due** for step 5's `nextFire`. Another run may hold its lease, and an early wake is safe.
   2. **Send:**
      - RFC 8291 encrypt;
      - POST with `TTL` = seconds left in the window, and `Urgency: high`;
      - VAPID JWT cached in `config` per push-service origin, refreshed when < 1 h of its 12 h remains.
      - **401/403:** evict that origin's cached JWT, re-sign, retry once. Only the second answer counts.
   3. **Record**, guarded by `claimed_at` (notify_sent) or by `token_hash` + `endpoint` (push_subs):

      | Status | `notify_sent` | `push_subs` / prefs | Then |
      |---|---|---|---|
      | 201 | `sent_at`, `status` | `last_sent_at = now`, `first_failure_at`, `lost_count`, `retry_after` → NULL/0 | next message |
      | 404, 410 | `sent_at`, `status` | delete sub (guarded), then prefs (`NOT EXISTS` guard). Settings: stopped (N15) | stop this account |
      | 429, 5xx, thrown fetch | released (row deleted) | `first_failure_at = COALESCE(first_failure_at, now)`; `retry_after = now + max(Retry-After, clamp(now − first_failure_at, 2 min, 15 min))`; if the window ends before `retry_after`: `lost_count + 1`, then, **only on that increment**, if `lost_count ≥ 3` and `now − COALESCE(last_sent_at, created_at) ≥ 24 h`: delete as for 410 (N23). A failure that loses nothing never deletes. `lost_count` can undercount messages whose whole window passed during a `retry_after` wait, which only delays a drop | stop this account |
      | any other (400, 413, a second 401/403, …) | `sent_at`, `status` (a server fault; not retried) | prefs `last_error = 'push_<status>'`, `last_error_at = now` | stop this account |

      - A thrown fetch may follow a push Apple already accepted. The release then re-sends it, a known duplicate path (N22).
5. **Recompute:** `UPDATE notify_prefs SET next_fire_at=? WHERE account_id=? AND snap_rev=?` with `max(nextFire(…), retry_after)`, or NULL.
   - `nextFire` sees this run's claims and sends, including leases (§ 5.3).
   - If an HTTP write happened since step 2, `snap_rev` differs and nothing is written. That writer already set `next_fire_at` to now, so the next minute recomputes.
   - Cron writes never bump `snap_rev`.
6. **Catch:**
   - `UPDATE notify_prefs SET next_fire_at=?, last_error=?, last_error_at=? WHERE account_id=? AND snap_rev=?`. The backoff is now + 2 min for `internal`, and now + 15 min for `bad_seal`/`bad_entry`/`bad_format`.
   - Release a claim held but not recorded (at most one, because of step 4's order).
   - **Log only the error class.** A `JSON.parse` message can quote titles (compare `worker/src/index.js:111–112`).
   - Continue with the next account.
7. **Liveness:** `config.last_cron_ok_at` is written at most every 10 minutes.

**Worst case with the reserve.** 3 accounts, all failing on their first message:
- 7 fixed + 3 × 3 per account + 3 × 7 per message + 1 liveness = 38.
- With all 201s (5 statements each), the check admits 6 messages per run. Worked through for 3 accounts: 43 remain after fixed costs, the first account sends 6, the other two only recompute, and the run ends with 3 to spare.
- The 00:15 run reserves 6 more for its 5 sweep statements.
- **speculative** until T5 measures whether `batch()` counts once, which could raise these.

**Known window (accepted).** Another account can take over the same endpoint (§ 5.1 step 3) between a claim and its send. A message composed for account A could then reach the phone now signed in as B. The window is one send's latency.

### 5.5 Turning off and cleanup
- **Reminders off** on the subscribed device: `DELETE /notify/sub`, then `pushManager.unsubscribe()`. The Worker deletes the account's `push_subs` and `notify_prefs` in one batch. `notify_sent` is kept (no titles; swept after 3 days), so off-and-on within a day doesn't re-send.
- **Sign-out (both paths: `signOut()` and the revoke inside `signIn()`, `js/accountui.js:1020–1083`).**
  - No new await goes between `signOutBlocked()` and the revoke (R13).
  - The **server's** logout becomes a batch (`worker/src/accounts.js:383` is a single `.run()` today). The batch deletes, in order:
    1. the device row;
    2. `push_subs WHERE account_id=? AND token_hash=?`;
    3. `notify_prefs WHERE account_id=? AND NOT EXISTS (SELECT 1 FROM push_subs WHERE account_id=?)`.
  - The client calls `pushManager.unsubscribe()` **after** `signOutLocal()` returns.
  - If the revoke fails offline, the local `unsubscribe()` still runs, the next send gets 410, and step 4 deletes.
- **Remote sign-out, password change with sign-out-others, recovery, admin revoke:** D8's join stops sends at once. At the phone's next sign-in, `/notify/state` reports `thisDevice: false`. The client calls `unsubscribe()` and shows the switch off. **No automatic re-subscribe across a token change.**
- **Another account on the same phone:** § 5.1 step 3 removes the old account's row for a reused endpoint.
- **A 409 `off`** makes the client re-read `/notify/state`. It shows the switch off only if the state says off, and it **never** calls `unsubscribe()` from a 409. That way it can't race a re-subscribe.
- **Admin disable / delete:** `admin.js` adds the three tables' deletes to its existing batches.
- **Daily sweep** (inside the 00:15 UTC run; single statements, no per-row `Intl`; `cutoff` = UTC date − 2 days):
  1. `DELETE FROM notify_sent WHERE claimed_at < ?now-3d`.
  2. `DELETE FROM push_subs WHERE NOT EXISTS (SELECT 1 FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.token_hash = push_subs.token_hash AND a.id = push_subs.account_id AND a.disabled_at IS NULL)`.
  3. `DELETE FROM notify_prefs WHERE NOT EXISTS (SELECT 1 FROM push_subs WHERE account_id = notify_prefs.account_id)`.
  4. `UPDATE notify_prefs SET items_sealed=NULL, items_hash=NULL, next_fire_at=NULL WHERE items_sealed IS NOT NULL AND (items_through IS NULL OR items_through < ?cutoff) AND COALESCE(items_at, 0) < ?now-1d`.
  5. `UPDATE notify_prefs SET items_sealed=NULL, items_hash=NULL, feeds_sealed=NULL, next_fire_at=NULL WHERE (feeds_through IS NULL OR feeds_through < ?cutoff) AND COALESCE(feeds_at, updated_at) < ?now-1d`.
     - Each half has its own grace (`items_at` / `feeds_at`), so uploads of one half never protect the other half's stale titles.
     - A past or missing feeds half also clears the items titles, because nothing can be composed without it.
     - Coverage has ended, or a half never arrived within a day, so nothing can be composed from those titles.
     - Settings then shows "Reminders paused — open plaenicke to resume". The phone's next open re-uploads both halves (§ 5.2).
     - `items_hash=NULL` makes the next items upload go through.

### 5.6 What the user sees
Settings → Reminders shows:
- the switch;
- "Morning summary at [07:30]" and "Deadline nudge the evening before at [20:00]". These call `PUT /notify/prefs` with either of `{morning_at, nudge_at}`, which applies the wake rule.
- a status line from `GET /notify/state`. It shows the first that applies:
  1. "Reminders stopped — turn them on again."
  2. "Reminders are failing (server error <status>)" when `lastErrorAt` > `lastSentAt` and is within 24 h.
  3. "Reminders paused — open plaenicke to resume."
  4. "Reminders cover the next N days."
  5. "Last reminder sent: today 07:30."

The subscribed device re-checks `pushManager.getSubscription()` on every open. If the browser lost the subscription while the server still has this token's row, the switch shows "stopped" with a one-tap re-subscribe.

Routes (6): `PUT/DELETE /notify/sub`, `PUT /notify/items`, `PUT /notify/feeds`, `PUT /notify/prefs`, `GET /notify/state`. Each catches `AtRestError` like `handleAccountRoute` (`worker/src/accounts.js:446–449`). `scheduled()` runs `checkKey` once per run before unsealing.

### 5.7 Service worker
- **`push`:** parse the declarative JSON and `showNotification`. On a parse failure, show "plaenicke — open the app".
- **On 18.4+** Phase 0 checks the service worker doesn't show a declarative push twice.
- **`notificationclick`:** focus or open `APP_URL`.

## 6. Privacy statement (Settings and the tester note)
> "Reminders need plaenicke's server to keep the titles and times of your items from yesterday through the next 7 days so it can send them while the app is closed. It does not get your notes or your calendar links. The server can read those titles. Turning reminders off deletes them from the server."

- **Point-in-time restore:** if D1 keeps deleted rows restorable for a period, the last sentence gains "…; database backups keep them for up to N more days". Which wording applies is **speculative** (P0.5).
- **After a restore:** `data.version` can go back while `items_version` doesn't, so every items upload would answer `stale`. The restore runbook in `docs/admin.md` adds `UPDATE notify_prefs SET items_version = NULL`.
- The V7 promise ("the server cannot read your planner") stays true for every account that never turns reminders on.

## 7. Rulings (approve or reject)

- **N1** — Server-side scheduling from a plaintext snapshot. Cost: 9 days of titles readable by the Worker for opted-in accounts (accepted 2026-11-11).
- **N2** — Opt-in on the phone with the § 6 disclosure, testers included.
- **N3** — Non-repeating feed events are included. Cost: third-party titles at rest for opted-in accounts.
- **N4** — Two halves in separate columns.
  - Items come from any device (version-gated, refused while the feeds half is past).
  - Feeds come only from the subscribed device (ordered by `seq`).
  - Each half records what it covers.
- **N5** — Both halves are sealed with `AT_REST_KEY`. This keeps titles out of plain D1 exports. Messages are composed at send time.
- **N6** — Horizon of 9 local days in the account's zone.
- **N7** — **Alex, 2026-11-13: stop quietly.** Past coverage nothing is sent, and Settings shows "paused".
- **N8** — **Alex, 2026-11-13 / 2026-11-17.** The empty-day summary is titled "No one-off events today" plus a friendly line. It never says the day is empty.
- **N9** — "Timed event" = own `EVENT_TYPES` items (`js/today.js:19`, exported for this) with a `time`, and feed instances with a time. Timed to-dos get no 30-min reminder.
- **N10** — **Alex, 2026-11-13:** weekly series repeat, and monthly and yearly don't.
  - This is the app's `recurring` (`seriesIndex`, `js/feeds.js:657–667`): DAILY/WEEKLY (`:456`), plus guessed series of ≥ 3 weeks (`:459`; feeds with no RRULE).
  - `COUNT=1` is a one-off.
  - **Accepted residual (speculative):** a quota prune can push a guessed series below 3 weeks. It would then count as non-repeating and get reminders.
- **N11** — Defaults: morning 07:30, nudge 20:00, within the § 5.3 ranges.
- **N12** — No service-worker acknowledgement in v1. Health comes from "last sent", `last_error`, and the summary as a canary.
- **N13** — `scheduled()` lives in the existing Worker. Invocation logs stay off (`worker/tests/wrangler-config.test.js:30`). The cron logs error classes only.
- **N14** — VAPID `sub` is the app URL. P0.3 signs with that exact value.
- **N15** — 404/410 delete the subscription, and Settings says stopped. Other non-retryable statuses are shown, not retried silently.
- **N16** — V8 ships after V7's iPhone device checks (the `docs/admin.md` table is still empty). Order: Worker → client → turn on.
- **N17** — **Alex, 2026-11-13: phone only.** One subscription per account, one account per endpoint.
  - **Speculative:** whether `navigator.standalone` is true for macOS "Add to Dock" apps (P0.6).
- **N18** — Feed entry key = SHA-256 of `feedId`, `uid`, start date and start time joined with `\u0001`, truncated to 16 hex characters. Computed on the client with async `crypto.subtle.digest`.
- **N19** — Endpoint allowlist: `*.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`.
- **N20** — **Alex, 2026-11-13:** deadlines are taken literally. The nudge goes the evening before the deadline's date, and the summary lists only deadlines still ahead.
- **N21** — **Alex, 2026-11-17:** feed instances with deadline-shaped titles (`isTrackableTitle`) are excluded. Cost: a non-Brightspace "… due" feed event is excluded too.
- **N22** — **Alex, 2026-11-17: a rare duplicate over a silent loss.** Claims are leased for 5 minutes and retried until their window ends. A thrown fetch after Apple accepted the push can duplicate. Nothing is sent after its window (`TTL` and `window_end`).
- **N23** — **Alex, 2026-11-17:** a subscription is dropped on retryable failures only when **at least 3 messages ran out of their window unsent and there has been no success for 24 h**. Retries back off between 2 and 15 min and honour `Retry-After`. 404/410 delete at once.
- **N24** — `bs-` deadline items are LMU wall clock (`js/deadlines.js:12`) and are read in `prefs.tz`. Accepted for v1. A later fix converts them in `js/notifysnapshot.js`.
- **N25** — Per-account faults go to `last_error`, are shown in Settings, and back off (2 min for `internal`, 15 min for data faults). The cron continues with the other accounts.

## 8. Questions only Alex can answer
None open. Rulings approved 2026-11-17.

## 9. Out of scope
- per-item "remind me" fields;
- reminders for repeating events;
- email or SMS;
- Apple Calendar export;
- a Durable Object scheduler;
- badges;
- converting `bs-` times to the account's zone (N24).

## 10. Open checks (each has a plan step)
1. One real push to the iPhone through Apple (P0.3).
2. Production D1 (P0.4):
   - both claim forms return zero rows when the conflict path writes nothing;
   - the account-lease `UPDATE … IN (SELECT … LIMIT) RETURNING` works.
3. D1 point-in-time restore and deleted rows (P0.5).
4. `navigator.standalone` in macOS "Add to Dock" apps (P0.6).
5. How many of the account's 5 Cron Triggers are used (P0.2).
6. Production `Intl` and cron CPU (Phase 3).
7. Cron jitter for a week (`late_ms` while measuring).
8. D1 rows per upload and per run, index writes included (T4b).
9. Whether `batch()` counts as one subrequest; production CPU per run. This sets the account limit and the reserve (T5, Phase 3).
