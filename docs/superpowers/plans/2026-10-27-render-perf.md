# Render perf: memoize the per-feed series work (2026-10-27)

Punchlist item: "`seriesIndex`/`spanKeyUids` run on every `instancesForRange` call".

## Measurement that triggered this (step 1)

Chrome, fresh isolated context, 4x CPU throttle, 390x844 mobile emulation.
Seed: 200 own items; an LMU-Classes-shaped feed (8 weekly RRULE series with
EXDATEs and RECURRENCE-ID overrides, 8 finals; 32 ParsedEvents); a 1,500-event
no-RRULE feed. 10 runs after 2 warm-ups.

- `render()` script time: median 400.8 ms, p90 434.3 ms (rule: act if > 50 ms).
- Profile of one render (338.5 ms sampled): `seriesIndex` 41.1 %, almost all
  `guessedGroups` -> `guessKeyOf` -> `icsDateToLocal` on the no-RRULE feed;
  `spanKeyUids` 0.7 %; `guessedUids` 0.5 %. `expandEvents` 49.4 %.
- Instrumented build: 12 feed expansions per render (6 `instancesForRange`
  calls x 2 feeds); series+span 43.2 % of render.

Both conditions hold, so the series work is memoized.

## Change

`js/feeds.js` only. A module-scope `WeakMap` keyed by the `entry.events` array:

- value `{ tz, series, spanUids }`; a hit requires the same array AND the same
  `targetTz` (the heuristic reads weekday and start time in `targetTz`, and
  `refreshForToday` can change `deviceTz` without reloading the cache);
- a miss computes `seriesIndex` + `spanKeyUids` and stores them;
- used only inside `instancesForRange`. `seriesIndex` itself stays pure and
  unmemoized (exported; `feedShape` and tests call the shared helpers).

Why identity is a sound key: every writer of a cache entry builds a NEW events
array (`syncFeed` line 268 `parsed.events`; quota prune line 162 `kept`;
`loadFeedCache` re-parses JSON, so app.js's snapshot is a new array after
every reload). No code mutates an events array in place (grep:
no `.events.push/splice/sort` or index assignment in `js/`). The contract
"replace, never mutate in place" is written at the WeakMap.

The memoized Sets are never handed out of `instancesForRange` (only read with
`.has`), so no caller can corrupt them.

## Tests (written first, `tests/feeds.test.js`)

1. Same results: for a heuristic feed and a rule feed, repeated calls return
   deep-equal instances to the first call. (Guards correctness, not memo.)
2. (Revised after the devil's-advocate review: the original in-place-edit
   probe made stale output required behaviour.) A test-only counter,
   `seriesComputations()`, shows the work runs once per array and zone:
   six calls on one array = 1; a new array +1; another zone +1.
3. Refetch replaces the entry: `syncFeed` with a changed ICS, then
   `loadFeedCache()`, yields the new flags (never stale).
4. Zone is part of the key: same array, different `targetTz`, recomputes.

Each new assertion mutation-checked (drop the tz check; remove the memo;
return a stale entry after a refetch).

## Re-measure

Same seed, same harness, same throttle; report before/after.

## Out of scope

`expandEvents` is the other ~50 %. Not touched here; reported with numbers.
