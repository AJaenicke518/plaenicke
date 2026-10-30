# plaenicke — Brightspace deadlines (see and track)

**Status:** DRAFT, awaiting Alex's review of this written spec. Sections 1–4 were approved one at a time in conversation on 2026-10-29/30.

Code facts cite file:line on `main` @ 71b922d (v6-17). Feed facts come from Alex's real LMU feed, fetched once on 2026-10-27 and run through plaenicke's own `parseICS`/`expandEvents` on the laptop; the feed itself is **not** committed (§ 6). Background research: `docs/superpowers/reports/2026-10-27-brightspace-research.md` on branch `worktree-agent-abc5101109f85b94e` (approach B2).

## 0. Intent

**What Alex said:** Brightspace deadlines should appear in plaenicke without typing them; he wants to **see and track** them (Overdue, checkbox, To-do page); the source is the live feed, so it follows instructor changes. Today he checks Brightspace directly and records deadlines nowhere, so there is nothing hand-typed to reconcile.

**Decisions (Alex, 2026-10-29/30):**

| Question | Answer |
|---|---|
| What is trackable? | **A:** "Due" and "revisions due". Exams, "Available" and class items stay calendar-only. |
| Deadlines already past when the feed is added? | **A:** only deadlines on or after the day tracking is turned on. |
| Due date moves after a tick? | **The tick stays.** |
| Approach | **1:** import each trackable deadline as an own `type: 'due'` item (research approach B2). |
| Tracking turned off / calendar removed | Existing items **stay**, ticks included; nothing new is imported. |
| Section 3 thresholds | Hold a removal of more than 3 at once; never auto-delete a past deadline. |

**Assumption, stated:** "done" means ticked in plaenicke. An ICS feed cannot say whether Alex submitted in Brightspace; only the Valence API can, and that needs LMU ITS (research § 2.2). Out of scope.

**Success:** opening plaenicke shows the next Brightspace deadlines with their course; a missed one is Overdue; a tick holds on both devices across feed refreshes and due-date changes.

## 1. What the feed contains (measured 2026-10-27)

- 106 VEVENTs, `parseICS` skips 0. `describeFeedShape`: "106 events: 1 repeat (RRULE), 105 single. Uses the rule." The feed has an RRULE, so the no-RRULE series heuristic (`js/feeds.js:489-518`) is never used on it, and the research's hidden-weekly-deadline risk does not apply.
- DTSTART forms: 82 UTC (`…Z`), 23 `VALUE=DATE`, 1 `TZID=PST8PDT`. `expandEvents` renders `HW 4.6 - Due` as 2026-11-02 23:59 in `America/Los_Angeles`, correctly.
- **The course is in `LOCATION`**, e.g. `Fall 2026 Calculus III (MATH-234-01/02)`, `Fall 2026 Introduction to Electricity and Magnetism (PHYS-2100-02/03)`. `parseICS` currently drops LOCATION (`js/ics.js:906-919`).
- **UID** is `NNNN-NNN@brightspace.lmu.edu`. 67 of 106 events have `SEQUENCE` > 0 under an unchanged UID: Brightspace keeps the UID across edits. This is what lets a tick survive a due-date change.
- Title shapes include `HW 4.7 - Due`, `IA 4.5 revisions due` / `IA 4.3 Revisions Due`, `Standard Exam 5`, `PHYS 2100 3.1 Practice Solutions - Available`, `Online Class`.
- Events date back to 2016 (past courses and surveys).
- The link alone fetches the feed (no login). Its "View event" links redirect to `/d2l/login`: the token reads the calendar and nothing inside the courses.

## 2. What Alex sees (approved, section 1)

- **Settings → Calendars:** the Brightspace link is added like any calendar. A per-calendar switch **"Track deadlines from this calendar"**; turning it on records today as the start date.
- **Trackable:** a non-repeating event whose SUMMARY matches `/(?:\s-\s|\s)(?:revisions\s+)?due\s*$/i` (so `- Due`, `Due`, `revisions due`, any case) and whose LA-zone date is ≥ the start date.
- **Title:** `<COURSE> · <title without the trailing "- Due">`, e.g. `MATH 234 · HW 4.7`, `PHYS 2100 · TEST #2`, `MATH 234 · IA 4.5 revisions due`. Course code: the first `(XXXX-NNNN…)` group in LOCATION → letters, a space, digits (`MATH-234-01/02` → `MATH 234`). No match → the cleaned title alone.
- Each becomes an ordinary Deadline: Overdue when missed, checkbox, To-do page, calendar, synced.
- **Calendar-only:** exams, "Available", class sessions, anything dated before the start date, the one repeating event.
- **No double display:** the feed's own copy of a tracked deadline is hidden.
- **Changes:** new assignment → appears on the next feed refresh (app open or return to visible, feed > 30 min old: `js/feeds.js:314-331`); due date/title change → item updates, tick kept; removed in Brightspace → removed from plaenicke (subject to § 4).
- **Deleted in plaenicke** → stays deleted.
- **Tracking off / calendar removed** → items stay; no new imports.

## 3. Data and the import (approved, section 2)

### 3.1 Feed record
New **optional, synced** field on the feed record: `trackDeadlines: { from: 'YYYY-MM-DD' }` (absent = off).
- `toWire` strips only `color` and `hidden` and passes the rest (`js/merge.js:316-322`); `deserializeFeeds` filters on id/url/name/color/hidden and keeps other fields (`js/storage.js:106-122`). No `schemaVersion` change.
- Turning it on/off is a feed write and bumps the feed's `updatedAt`, so it wins over the other device's older copy.
- It must not be added to the per-device fields that `applyRemoteFeeds` assigns (`js/storage.js:99-103` comment).

### 3.2 Parser
`collectProperty` (`js/ics.js:906-919`) keeps `LOCATION` (unescaped) on the parsed event as `location`. The cached ParsedEvent gains that field; `deserializeFeedCache` (`js/storage.js:214-235`) checks only `fetchedAt`/`events`/`skipped`, so old caches still load (no `location` until the next fetch → no course prefix until then; the import is idempotent and will update the title once it arrives).

### 3.3 Item identity
- id = `bs-` + the VEVENT UID, e.g. `bs-6606-237@brightspace.lmu.edu`. Independent of plaenicke's feed id, so removing and re-adding the calendar cannot duplicate items, and both devices derive the same id.
- Built with `makeItem` (`js/items.js:5-48`): `type: 'due'`, `title`, `date`, `time` (null for a `VALUE=DATE` event), `endTime: null`. No new item field; the 13-key whitelist is untouched.

### 3.4 Dates
Converted in **`America/Los_Angeles`** on every device (not the device zone), so two devices always compute identical values and never overwrite each other while one travels. Items then read as LMU wall-clock time, like any typed item.

### 3.5 The import step
A pure planner, new module `js/deadlines.js`:

```
planDeadlineImport({ feeds, cache, items, tombstones, todayISO })
  → { create: [fields+id], update: [{ id, patch }], remove: [id], held: { feedId, ids } | null, note }
```

`app.js` (the sole items writer, CLAUDE.md "Ownership") applies the plan after each settled feed refresh (`js/app.js:1405-1430`, `settle`), for feeds with `trackDeadlines`:

1. Trackable events per § 2, expanded in LA zone.
2. For each: no item and no item tombstone for the id → **create**; an item tombstone exists → **skip**; item exists and title/date/time differ → **update** those fields only through the existing edit path (`editItem`, `js/app.js:628`, which stamps with `nextStamp`); `done` is never in the patch; identical → **nothing**.
3. A `bs-` item absent from every tracking feed's current events → **remove** through the delete path (`deleteItem`, `js/app.js:514`, which writes the tombstone), only when § 4 allows.

Writes happen only on a real difference, so the second device to refresh usually finds nothing to do.

### 3.6 Hiding the feed copy
`instancesForRange` (`js/feeds.js:742`) callers drop a feed instance whose `bs-` + uid is an existing live item **or** has an item tombstone, for feeds with `trackDeadlines`. Implemented as a filter in the caller, with the id set passed in, so `feeds.js` stays free of item knowledge.

### 3.7 Known gap (accepted)
Item tombstones are pruned after 90 days (`js/merge.js:256-266`). A tracked deadline deleted by Alex **more than 90 days before its due date**, still listed by Brightspace when the tombstone ages out, would be re-created. Accepted rather than adding machinery.

## 4. Safety and errors (approved, section 3)

Removal (§ 3.5 step 3) runs only when **all** hold:

1. Every tracking feed's refresh this round succeeded (no network error, 4xx/5xx, 422 `not_an_ics_feed`, or parse failure).
2. The feed returned ≥ 1 event **and** ≥ 1 trackable event, or plaenicke holds no `bs-` items. Otherwise nothing is removed and the Settings row reads `Brightspace returned no deadlines — none removed`.
3. At most **3** removals in this round. More → none removed; the Settings row reads `N deadlines disappeared from Brightspace — not removed` with a **Remove them** button that applies exactly that held list.
4. The item's date is **today or later**. Past deadlines are never auto-removed.
5. With several tracking feeds, the id is missing from all of them.

**Other failures:**
- A write throws (e.g. `QuotaError`): the import stops at that item; Settings shows the existing storage-full message; already-written items stay; the next refresh continues. Never swallowed.
- No course code → plain title. A skipped VEVENT stays in the feed's skipped count and is never imported.

**Release order:**
1. The Worker logging fix (`invocation_logs = false`, commit 815d1d7, branch `worker-no-invocation-logs`) is **deployed before the Brightspace link is added anywhere**. As of 2026-10-30 the Worker still answers `worker-2026-10-27.1`.
2. The client ships before tracking is turned on.
3. A device on an older client keeps the `trackDeadlines` field (§ 3.1), shows the feed as an ordinary calendar, and imports nothing.

## 5. Testing (approved, section 4)

Test-first throughout; gate on `# fail 0` and `# cancelled 0`; mutation-test the guards.

- **`tests/deadlines.test.js` (pure):** trackable matcher (each title shape incl. `Revisions Due` casing; Available/exam/class rejected; repeating rejected; start-date cut-off); course code (`MATH-234-01/02` → `MATH 234`, `PHYS-2100-02/03` → `PHYS 2100`, none → plain); title cleanup; LA-zone conversion identical under several `TZ` settings and across the 2026-11-01 DST change; planner create/update/skip/remove including every § 4 guard (empty feed, >3 held, past never removed, tombstoned never re-created, `done` never patched, failed feed blocks removal).
- **`tests/ics.test.js`:** LOCATION captured and unescaped (`Sport\, Race`).
- **`tests/apply.test.js` (wiring):** after a refresh, items exist, are Overdue/To-do/tickable, and the feed copy is hidden; moved due date keeps the tick; a deleted item is not re-created; tracking off keeps items and stops imports; a write failure surfaces. Waits poll (`drainUntil`), never fixed ticks.
- **Sync:** two devices importing the same feed converge to one item each and the second writes nothing; `trackDeadlines` survives `toWire`/merge/`deserializeFeeds`.
- **Fixture:** a synthetic `tests/fixtures/brightspace-shape.ics` reproducing § 1's shapes (UTC, DATE, one RRULE, LOCATION with course codes, `NNNN-NNN@brightspace.lmu.edu` UIDs, each title shape).
- **On the phone after release:** three known deadlines match Brightspace; a tick syncs to the laptop; Practice Solutions items are calendar-only.

## 6. Privacy

- The repo is public (GitHub Pages). **Alex's real feed is never committed**: it carries course names, instructor Webex links and assignment text. `tests/fixtures/README.md` already limits fixtures to public sources.
- The Brightspace link is stored like other feed URLs: localStorage on each device, the encrypted sync blob, and in transit to the Worker. It can be re-copied from Brightspace (research § 3); Alex chose not to rotate it after it appeared in a Claude session.
- The local copy fetched for § 1 (`…/scratchpad/bs/feed.ics`) is deleted once the build is verified.

## 7. Out of scope

Submission status (Valence API, needs LMU ITS); notifications for these deadlines (separate notifications design); per-course filtering.

**Consequence to confirm:** Brightspace owns an imported deadline's title, date and time. If Alex edits one of those in plaenicke, the next refresh sets it back (§ 3.5 step 2 sees a difference). Notes, type-independent fields and the tick are never touched by the import.
