# plaenicke — Brightspace deadlines (see and track)

**Status:** APPROVED by Alex, 2026-10-30. Plan: `docs/superpowers/plans/2026-10-30-brightspace-deadlines.md`.

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
| Alex edits an imported title/date/time or adds notes | **His edits stick** until Brightspace itself changes that field (2026-10-30). Notes are never touched. |

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
- **Changes:** new assignment → appears on the next feed refresh (app open or return to visible, feed > 30 min old: `js/feeds.js:314-331`); due date/title/time changed **in Brightspace** → that field updates, tick kept; removed in Brightspace → removed from plaenicke (subject to § 4).
- **Edited in plaenicke** → Alex's title, date, time and notes stick. A field is overwritten only when Brightspace changes that same field afterwards (per field: an instructor date change keeps his custom title). The tick is never touched.
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

**Amended 2026-10-31 after final review.** The sentence above was wrong about the title: a pre-release entry's derived titles lack the course code, and judging the next fetch against them would make "MATH 234 · " look like a Brightspace title change and overwrite a title Alex renamed (on the other device, synced here). A tracking feed whose cache entry has any event **lacking the `location` key** (a parsed event without LOCATION has `location: null`) is therefore treated as **not refreshed** that round, like a failed feed (§ 3.5): nothing created, updated or removed from it, removals blocked, its baseline unchanged. The next real fetch writes `location`.

### 3.3 Item identity
- id = `bs-` + the VEVENT UID, e.g. `bs-6606-237@brightspace.lmu.edu`. Independent of plaenicke's feed id, so removing and re-adding the calendar cannot duplicate items, and both devices derive the same id.
- Built with `makeItem` (`js/items.js:5-48`): `type: 'due'`, `title`, `date`, `time` (null for a `VALUE=DATE` event), `endTime: null`. No new item field; the 13-key whitelist is untouched.

### 3.4 Dates
Converted in **`America/Los_Angeles`** on every device (not the device zone), so two devices always compute identical values and never overwrite each other while one travels. Items then read as LMU wall-clock time, like any typed item.

### 3.5 The import step
A pure planner, new module `js/deadlines.js`:

```
planDeadlineImport({ feeds, baseline, cache, items, tombstones, failedFeedIds, pendingIds, todayISO })
  → { create: [fields+id], update: [{ id, patch }], remove: [id], held: [id], note, nextBaseline, judged }
```

**Amended 2026-10-31 after final review: a device-local baseline replaces `prevCache`.** The final review reproduced two losses with `prevCache` (this device's feed cache before the refresh): a device whose cache was older than the other device's removed real upcoming deadlines (ticks included) the other device had imported, and a sync or storage reload landing mid feed batch replaced the "before" cache with the new one, so a Brightspace date change was never applied. The rules in steps 2 and 3 below are now judged against **`plaenicke.deadlineBaseline`**: device-local, never synced, owned by `app.js`, shaped `{ [feedId]: { fetchedAt, deadlines: { [id]: { title, date, time } } } }` — what *this device* last imported per tracking feed.

- **Update:** patch a field only when it differs between the baseline record and the current derived record **and** the item differs. No baseline record for the id → no update.
- **Remove (candidate):** the id is in `baseline[feed.id].deadlines`, absent from that feed's current derived set, the feed was **re-fetched** since (`cache[feed.id].fetchedAt !== baseline[feed.id].fetchedAt`), and absent from every other tracking feed's current set. An id never in this device's baseline is never removed by this device. Then every § 4 guard; a candidate whose item is gone (deleted, never here) has nothing to remove and drops out.
- **`nextBaseline`:** per tracking feed that refreshed OK and was not degenerate, `{ fetchedAt, deadlines: current derived ∪ carried }`, where *carried* = candidates not removed this round (held, or blocked by a guard), so they stay candidates. A feed not re-fetched keeps every earlier record. Failed, degenerate and pre-release (§ 3.2) feeds keep their old entry; feeds no longer tracking are dropped.
- `app.js` loads the baseline per import and saves `nextBaseline` **only after** the plan's writes succeeded (or when it has none). A failed write leaves the stored baseline as it was, so the next import plans the same change again.
- **`judged`** is false only when every tracking feed refreshed OK and none was re-fetched (an import from the same cache: a resume within 30 minutes, a Settings tap). Such a round has no candidates by the rule above, so `app.js` keeps the last judged round's note and held list rather than clearing "Remove them".

Where steps 2 and 3 and the paragraph after them say `prevCache`, read the baseline.

`app.js` (the sole items writer, CLAUDE.md "Ownership") applies the plan after each settled feed refresh (`js/app.js:1405-1430`, `settle`), for feeds with `trackDeadlines`:

1. Trackable events per § 2, expanded in LA zone.
2. For each: no item and no item tombstone for the id → **create**; an item tombstone exists → **skip**; item exists → compute the event's derived `{title, date, time}` from **`prevCache`** (this device's feed cache entry before the refresh) and from **`cache`** (after). For each field whose derived value **changed between the two fetches** and differs from the item, **update** that field only, through the existing edit path (`editItem`, `js/app.js:628`, which stamps with `nextStamp`). A field Brightspace did not change is left alone even if the item differs: that difference is Alex's edit. `done` and `notes` are never in the patch. No prior entry for the event in `prevCache` (fresh device, cleared cache, event new to this device) → **no update**; the device that saw the change applies it and sync carries it.
3. A `bs-` item absent from every tracking feed's current events → **remove** through the delete path (`deleteItem`, `js/app.js:514`, which writes the tombstone), only when § 4 allows.

Writes happen only on a real difference, so the second device to refresh usually finds nothing to do: it sees the same Brightspace change, and after syncing the first device's write the item already holds the new value.

~~`prevCache` is captured in `app.js` before `syncStale` replaces the entries.~~ Superseded 2026-10-31: there is no `prevCache` (see the amendment above), and a pre-release cache is not a refresh (§ 3.2 amendment) — the earlier claim that "no edit of Alex's can be overwritten" did not hold once the other device had imported and Alex had renamed.

### 3.6 Hiding the feed copy
`instancesForRange` (`js/feeds.js:742`) callers drop a feed instance whose `bs-` + uid is an existing live item **or** has an item tombstone. Implemented as a filter in the caller, with the id set passed in, so `feeds.js` stays free of item knowledge.

**Amended 2026-10-31 after final review:** for **every** feed, tracking or not (`hideTrackedCopies(instances, hiddenIds)`). The items outlive "Stop tracking" and a removed and re-added calendar (a new feed id, tracking off), and hiding only on tracking feeds showed every deadline twice then.

### 3.7 Known gap (accepted)
Item tombstones are pruned after 90 days (`js/merge.js:256-266`). A tracked deadline deleted by Alex **more than 90 days before its due date**, still listed by Brightspace when the tombstone ages out, would be re-created. Accepted rather than adding machinery.

## 4. Safety and errors (approved, section 3)

Removal (§ 3.5 step 3) runs only when **all** hold:

1. Every tracking feed's refresh this round succeeded (no network error, 4xx/5xx, 422 `not_an_ics_feed`, or parse failure).
2. The feed returned ≥ 1 event **and** ≥ 1 trackable event, or plaenicke holds no `bs-` items. Otherwise nothing is removed and the Settings row reads `Brightspace returned no deadlines — none removed`.
3. At most **3** removals in this round. More → none removed; the Settings row reads `N deadlines disappeared from Brightspace — not removed` with a **Remove them** button that applies exactly that held list.
4. The item's date is **today or later**. Past deadlines are never auto-removed.
5. With several tracking feeds, the id is missing from all of them.

**Amended 2026-10-31 after final review — the import waits for sync on a linked device.** A device that has not yet pulled the account's latest items would patch a stale copy, stamped later than Alex's tick or note on the other device, and whole-record last-write-wins keeps that later automatic write: the tick and notes are lost. So on a linked device, `app.js` defers the import (and "Remove them") while an adoption is pending or until a sync has **succeeded** (`syncOnce` status `ok`) since launch or the last return to visible; the deferred import then runs from `runSync`'s success path. A failed or skipped sync leaves it waiting (the sync indicator already shows the failure). An unlinked device imports at once. **Accepted residual:** a Brightspace change applied in the same sync window as a tick on the other device can still lose the tick (whole-record last-write-wins, CLAUDE.md); the deferral removes the stale-device case, not true concurrency.

**Other failures:**
- A write throws (e.g. `QuotaError`): the import stops at that item; Settings shows the existing storage-full message; already-written items stay; the next refresh continues. Never swallowed. *(Amended 2026-10-31: the items write is one save, so a failure leaves `items` as it was; tombstones for that round's removals are written first and may already be stored; the baseline is not advanced, so the next refresh retries. The message is on the top line.)*
- No course code → plain title. A skipped VEVENT stays in the feed's skipped count and is never imported.

**Release order:**
1. The Worker logging fix (`invocation_logs = false`, commit 815d1d7, branch `worker-no-invocation-logs`) is **deployed before the Brightspace link is added anywhere**. As of 2026-10-30 the Worker still answers `worker-2026-10-27.1`.
2. The client ships before tracking is turned on.
3. A device on an older client keeps the `trackDeadlines` field (§ 3.1), shows the feed as an ordinary calendar, and imports nothing.

## 5. Testing (approved, section 4)

Test-first throughout; gate on `# fail 0` and `# cancelled 0`; mutation-test the guards.

- **`tests/deadlines.test.js` (pure):** trackable matcher (each title shape incl. `Revisions Due` casing; Available/exam/class rejected; repeating rejected; start-date cut-off); course code (`MATH-234-01/02` → `MATH 234`, `PHYS-2100-02/03` → `PHYS 2100`, none → plain); title cleanup; LA-zone conversion identical under several `TZ` settings and across the 2026-11-01 DST change; planner create/update/skip/remove; edits stick (item title differs, Brightspace unchanged → no patch; Brightspace changes the date only → date patched, custom title kept; no `prevCache` entry → no patch; `notes` never patched); every § 4 guard (empty feed, >3 held, past never removed, tombstoned never re-created, `done` never patched, failed feed blocks removal).
- **`tests/ics.test.js`:** LOCATION captured and unescaped (`Sport\, Race`).
- **`tests/apply.test.js` (wiring):** after a refresh, items exist, are Overdue/To-do/tickable, and the feed copy is hidden; moved due date keeps the tick; a renamed item keeps Alex's title across refreshes; a deleted item is not re-created; tracking off keeps items and stops imports; a write failure surfaces. Waits poll (`drainUntil`), never fixed ticks.
- **Sync:** two devices importing the same feed converge to one item each and the second writes nothing; `trackDeadlines` survives `toWire`/merge/`deserializeFeeds`.
- **Fixture:** a synthetic `tests/fixtures/brightspace-shape.ics` reproducing § 1's shapes (UTC, DATE, one RRULE, LOCATION with course codes, `NNNN-NNN@brightspace.lmu.edu` UIDs, each title shape).
- **On the phone after release:** three known deadlines match Brightspace; a tick syncs to the laptop; Practice Solutions items are calendar-only.

## 6. Privacy

- The repo is public (GitHub Pages). **Alex's real feed is never committed**: it carries course names, instructor Webex links and assignment text. `tests/fixtures/README.md` already limits fixtures to public sources.
- The Brightspace link is stored like other feed URLs: localStorage on each device, the encrypted sync blob, and in transit to the Worker. It can be re-copied from Brightspace (research § 3); Alex chose not to rotate it after it appeared in a Claude session.
- The local copy fetched for § 1 (`…/scratchpad/bs/feed.ics`) is deleted once the build is verified.

## 7. Out of scope

Submission status (Valence API, needs LMU ITS); notifications for these deadlines (separate notifications design); per-course filtering.

**Who owns which field (decided 2026-10-30):** Alex's edits to an imported deadline's title, date and time stick; a later Brightspace change to that same field replaces his value (§ 3.5 step 2). Notes, type and the tick are never touched by the import.
