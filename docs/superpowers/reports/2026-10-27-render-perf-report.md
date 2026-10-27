# Render perf: measure, then decide (2026-10-27)

Punchlist item: "`seriesIndex`/`spanKeyUids` run on every `instancesForRange` call".
Branch `render-perf`, from `main` @ f1d97ea. CACHE not bumped.

## Verdict

The item was real. A full `render()` was **400.8 ms median at 4x throttling**, and
the series work was **41–43 %** of it. Both conditions of the decision rule held,
so the series work is memoized. It now takes **0 %** of a render, and render fell to
**184.5 ms median**. That is still over 50 ms. The rest is `expandEvents`, which is
now 85 % of a render. This change does not touch it; see "Next" below.

## Setup

- Served the worktree on 127.0.0.1 from a small Node server
  (scratchpad `perf/serve.mjs`). It serves the files unchanged, except for one
  appended line in `app.js` (`window.__render = render`) so `render()` can be
  timed directly. A second port served an instrumented `feeds.js` that adds up
  the time spent in each part. The worktree itself was never modified for
  measuring.
- Chrome via chrome-devtools MCP: a fresh isolated context. **Before seeding,
  localStorage held only `plaenicke.launches`.** `plaenicke.auth` and
  `plaenicke.syncState` were both null, so there was no sync or link code.
- 4x CPU throttling; viewport 390x844, DPR 3, mobile and touch.
- Seed data was built through the app's own `parseICS` (scratchpad
  `perf/gen-seed.mjs`). Feed URLs were `https://example.invalid/...` and
  `fetchedAt` was set to the current time, so `syncStale` fetched nothing.
  - **Own items:** 200, a mix of event, due, task, idea and general, dated
    ±60 days around today. 6 to-dos are due today, so Today showed 38
    checkboxes.
  - **LMU-Classes-shaped feed:** 8 weekly RRULE series (BYDAY, UNTIL in
    December), each with 2 EXDATEs and 2 RECURRENCE-ID overrides, plus 8
    one-off finals. That is 32 ParsedEvents, none skipped.
  - **Large no-RRULE feed:** 1,500 ParsedEvents, none skipped:
    - 900 timed events in 30 weekly patterns (these are what the heuristic groups);
    - 300 point-in-time deadlines (DTSTART == DTEND);
    - 150 all-day events;
    - 150 one-off timed events.
  - Before running, I checked that Today rendered rows from both feeds.
- Each scenario: 2 warm-up runs, then 10 measured runs, 150 ms apart.
  - **"Script"** is the synchronous time of the action: `performance.now()`
    taken around the call or `.click()`.
  - **"To next frame"** runs up to the first rAF plus one task. It sat at
    about 850 ms both before and after the change, while script time moved
    by 216 ms. So it is not tracking this work, and I do not use it for
    decisions. The cause was not established. The page reported
    `visibilityState: visible` and focus, and another session had a tab open
    in the same browser.

## Step 1: before (main @ f1d97ea)

| Action (4x throttle) | median | p90 | min | max |
|---|---|---|---|---|
| `render()` direct | 400.8 ms | 434.3 ms | 336.7 | 453.6 |
| Tab switch (Today / Calendar, alternating) | 339.0 ms | 372.6 ms | 321.3 | 374.7 |
| To-do tick on Today (tick / untick, alternating) | 313.4 ms | 315.2 ms | 310.3 | 315.5 |

A tab switch and a tick both call `render()`, which re-renders every page.
That is why the three numbers are close.

### Where one render goes

From the DevTools trace's CPU samples (scratchpad `perf/profile.py`), one
`render()`, 338.5 ms sampled. Each figure includes the time of the functions
it calls:

| Function | ms | share of render |
|---|---|---|
| `instancesForRange` | 309.7 | 91.5 % |
| `expandEvents` | 167.2 | 49.4 % |
| **`seriesIndex`** | **139.1** | **41.1 %** |
| – `guessedGroups` → `guessKeyOf` → `icsDateToLocal` | 136.5 / 135.3 / 124.9 | 40.3 / 40.0 / 36.9 % |
| **`guessedUids`** | **1.5** | **0.5 %** |
| **`spanKeyUids`** | **2.5** | **0.7 %** |

The instrumented build agrees, over 10 renders:
- 12 feed expansions per render (6 `instancesForRange` calls × 2 feeds);
- series + span: 43.2 % of the render;
- `guessedUids`: 0.6 %;
- `expandEvents`: 50.4 %.

The series cost is almost all the heuristic's zone conversion of every event
in the 1,500-event no-RRULE feed. It was recomputed 6 times per render on
identical input. The RRULE feed's series work rounds to 0.

Node, same data, Mac, **no throttling, not a phone measurement**: all 6
calls of one render took 93.5 ms median. Of that, 43.1 ms was series work
and 50.7 ms was `expandEvents`.

## Step 2: decision and change

Render was over 50 ms and the series work was a large share of it, so I
built the memo.

- **`js/feeds.js`:** `seriesFor(events, targetTz)` keeps a module-scope
  `WeakMap` keyed on the `entry.events` array.
  - Each entry is `{ targetTz, series, spanUids }`. A lookup is a hit only
    for the same array AND the same zone. The heuristic reads weekday and
    start time in `targetTz`, and `deviceTz` can change in `refreshForToday`
    without the cache being reloaded.
  - The result is computed in full before it is stored. If `seriesIndex`
    throws, nothing is stored and the feed is skipped, as before.
  - `seriesIndex` itself is unchanged.
  - **Contract:** a feed's events are replaced, never edited in place. It is
    written at the WeakMap. Every writer already works this way:
    - `syncFeed` stores `parsed.events`;
    - the quota prune builds `kept`, or `[]`;
    - `loadFeedCache` JSON-parses fresh arrays and objects.
    I grepped `js/` and `tests/` and found no in-place edit of an events
    array or a ParsedEvent.
  - `seriesComputations()` is exported for tests only.
- **`tests/feeds.test.js`:** four "series memo" tests, written first.
  1. Repeated calls, and a `structuredClone` copy of the events, give
     deep-equal instances on a heuristic feed and a rule feed.
  2. The work is computed once per array and zone. Six calls on one array
     give 1 computation; a new array gives +1; another zone gives +1.
     Before the implementation this failed: the export was missing.
  3. A refetch through `syncFeed` that turns 4 weeks into 2 makes the
     instance non-recurring, and back again. The snapshot was rendered 3
     times first.
  4. Zone in the key: four UTC-stamped Mondays across the 1 Nov DST change
     are one series in Los Angeles and not a series in UTC. The test reads
     them on the same array in LA, then UTC, then LA.

### Mutation checks (planted, run, restored)

| Mutation | Result |
|---|---|
| Drop the zone check (`if (hit) return hit`) | tests 2 and 4 fail |
| No memo hit (always recompute) | test 2 fails |
| One global slot, ignoring the array (stale across refetch) | tests 1, 2 and 3 fail, plus 9 existing instancesForRange tests |

### After (render-perf @ 1d7d0e4), same seed, same page, same throttle

| Action (4x throttle) | median | p90 | min | max | median before |
|---|---|---|---|---|---|
| `render()` direct | **184.5 ms** | 187.8 ms | 180.8 | 190.1 | 400.8 ms |
| Tab switch | **181.8 ms** | 184.8 ms | 175.5 | 190.1 | 339.0 ms |
| To-do tick on Today | **179.2 ms** | 183.1 ms | 175.6 | 184.9 | 313.4 ms |

Over the 36 timed renders, `seriesComputations()` went up by 0: every render
was served from the memo. In the profile of one render after the change
(195.9 ms sampled), `seriesIndex`, `guessedGroups`, `guessedUids` and
`spanKeyUids` each had 0 samples. `expandEvents` took 165.9 ms, 84.7 %.

## Gate

`npm test`: 1762 tests, `# fail 0`, `# cancelled 0`.

## Review

- **Plan:** a devil's-advocate review of 8fb6bf0 found no criticals. What I
  changed in response:
  - **Accepted:** the original test 2 was dropped. It made "an in-place edit
    is not seen" required behaviour. A test-only call counter replaced it.
  - **Accepted:** I grepped `tests/` for fixture mutation as well; there is none.
  - **Checked:** its warning that the zone test could be vacuous. Mutation
    1 shows the DST fixture fails without the zone check.
  - **Noted:** another tab's refetch is not seen until a reload. That was
    already true before the memo, and the memo does not change it.
- **Code:** a fresh reviewer (not the implementer) reviewed 1d7d0e4 and
  approved it, with no correctness defect. It ran:
  - `npm test`: 1762 tests, fail 0;
  - a deep-freeze check: it froze real `parseICS` output and ran it through
    `instancesForRange` across 3 zones and 2 ranges, on an RRULE feed with
    EXDATE, an override and multi-day events, and on a heuristic feed. There
    were 0 errors and the output matched the unfrozen run, so nothing in
    `expandEvents`, `seriesIndex` or `spanKeyUids` writes to a ParsedEvent;
  - four mutations of its own, including keying the memo on `feed.id`, which
    12 tests fail.

  Its Low findings and what I did:
  - **Fixed:** the plan text still described the old test 2.
  - **Fixed:** the `feeds.js` comment cites this report, which was not yet
    committed; it is committed now.
  - **Accepted as is:** the production export used only by tests.
  - **Accepted as is:** there is one zone slot per array, so calls that
    alternate zones recompute every time. The app uses a single `deviceTz`.

## Next (not done here)

- **`expandEvents` is the next cost:** about 166 ms of a 185–196 ms render
  at 4x, from the trace. Inside it, `formatZonedParts` takes 123 ms of self
  time. That is `Intl.DateTimeFormat.formatToParts`; the formatter itself is
  already cached. It runs for every occurrence of every event, in all 6
  ranges, before `emitOccurrence` drops the occurrences that fall outside
  the range. Possible fixes, all **speculative** (none were measured):
  - a cheap UTC-day pre-filter, with a ±1 day margin, for events with no
    rule, run before converting the zone;
  - memoizing each event's local start and end per (array, zone), the same
    way as this change;
  - one expansion per render over the union range, sliced per view.
  I recommend a new punchlist item for this, with these numbers. The
  50 ms target is not met until it is done.
- **Real-device numbers are still missing.** 4x throttling is a stand-in for
  a phone. Real feed sizes are unknown too: the 1,500-event feed is the
  stated assumption, not Alex's data.
