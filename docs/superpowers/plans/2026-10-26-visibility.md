# Per-series visibility, option A — plan (2026-10-26)

Approved design: `.superpowers/sdd/lead-visibility-report.md` (main checkout),
mockup https://claude.ai/artifact/6aRVSz73LcWngKKFV6cxbX, option A.

## What gets built

- A device-local key `plaenicke.seriesVisibility`:
  `{ [feedId]: { [uid]: { calendar: boolean, list: boolean, title: string } } }`.
  `title` is added to the design's `{calendar, list}` because Settings must name a
  hidden series that has no instance in any rendered range. It is an event
  title from the feed, never the URL.
- Two switches on a feed event's read-only sheet: "On the calendar" (Day, the
  Week grid, Month) and "On Today and in lists" (Today's events, Next 7 days,
  Coming up, the Week list, the "Next:" line).
- "Hidden on this device (N)" under each calendar row in Settings, one row per
  hidden series: title, where it is hidden, a Show button.
- No trace on the pages the series is hidden from. Nothing synced. Whole-calendar
  Hide stays as it is.

## Controller rulings (2026-10-26)

1. Hidden from lists ⇒ also out of Today's "Next:" line. Done by filtering the
   look-ahead instances with the `list` surface before `buildToday` sees them.
2. A corrupt entry reads as shown, and logs once per session.
3. A guessed series (`guessedSeries === true`) gets no switches.

## Hard constraints and how each is pinned

| Constraint | Pin |
|---|---|
| No write to `plaenicke.feeds` | apply test: a sheet toggle and a Settings Show leave `localStorage.getItem('plaenicke.feeds')` byte-identical. Static test: `js/visibility.js` names no feed/item/tombstone writer. |
| No sync scheduled | apply test, device linked, manual timers: after a toggle, no 2000 ms timer is live and no request goes out. |
| `toWire` unchanged | apply test: `JSON.stringify(toWire(localState()))` is identical before and after a toggle. No change to `merge.js`, `sync.js`, `feeds.js`. |
| No change to `toWire`/`merge`/`pickFeed`/`applyRemoteFeeds`/`schemaVersion` | Those files are not edited; the final review checks `git diff main -- js/merge.js js/sync.js js/feeds.js` is empty. |
| Feed URLs never rendered | apply test: the sheet with switches and the Settings hidden list contain no fragment of the feed URL (the existing `stringsOf` walk). |
| Orphan pruning only in `visibility.js`, on its own writes | `setSeriesVisibility`/`showSeries` drop entries whose feedId is not in `loadFeeds()`. Static test: `js/feeds.js` does not mention visibility. |

## Files

- `js/storage.js`: `SERIES_VISIBILITY_KEY`, `readSeriesVisibility()` (raw string or
  null) and `writeSeriesVisibility(obj)` (quota-translated). No parsing here.
- `js/visibility.js` (new):
  - `parseVisibility(json) -> { map, corrupt }` (pure). Valid entry: object with
    boolean `calendar`, boolean `list`, string `title`. Anything else under a
    feedId/uid is corrupt and reads as shown. An entry with both true is not stored.
  - `loadVisibility()`: reads and parses; logs once per session on corruption.
  - `isShown(map, inst, surface)`, `filterBySurface(instances, map, surface)`:
    pure; an unknown surface throws. Own items (no `external`) always pass.
  - `canHideSeries(item)`: external, string uid, not guessed (ruling 3).
  - `setSeriesVisibility({ feedId, uid, title }, surface, shown)` and
    `showSeries(feedId, uid)`: read-modify-write in one synchronous step; prune
    orphan feedIds and corrupt entries; throw on bad arguments.
  - `hiddenSeriesFor(map, feedId)`: rows for Settings, sorted by title.
- `js/app.js`:
  - `render()` reloads the map once at its top (`visibility = loadVisibility()`).
  - `visibleItems` (Month and Day) filters instances by `calendar`.
  - `renderWeek`: grid gets `calendar`, list gets `list`.
  - `renderToday`: both instance sets get `list` (ruling 1 via the look-ahead).
  - `openItem`: for `canHideSeries(item)`, passes `visibility` and
    `onVisibilityChange(surface, shown)` to the sheet. That callback writes via
    visibility.js, re-renders, and never calls `scheduleSync`.
  - storage listener: `SERIES_VISIBILITY_KEY` re-renders and returns BEFORE the
    synced-key branch, so it never schedules a sync.
- `js/itemsheet.js`: the switch block in the external branch, when given.
  `role="switch"`, `aria-checked`, `aria-label` naming the series. A failed write
  shows its message in the block (`role="alert"`) and leaves the switch as it was.
- `js/settings.js`: the hidden list per feed row; Show calls `showSeries`, then
  `renderCalendars()` and `notifyViewChanged()` (never `notifySyncedChanged`).
- `styles.css`: switch and hidden-list rules, tokens only, 44 px hit areas.

## Copy

- Sheet head: "Show every <title>" for a repeating series, "Show <title>" otherwise.
- Rows: "On the calendar / Day, Week and Month"; "On Today and in lists /
  Today's events, upcoming lists and the “Next” line". (The mockup's second
  sub-label, "Today's events and the “Next” line", is accurate only for a
  repeating series; a one-off also leaves Next 7 days and the Week list.)
- Note: "On this device only. Undo it here or in Settings → Linked calendars."
- Settings: "Hidden on this device (N)"; where: "everywhere", "from Today & lists",
  "from calendar"; button "Show".

## Tasks (test-first, each mutation-checked, fresh reviewer each)

1. storage + `visibility.js` with `tests/visibility.test.js` (pure + storage +
   corrupt-log-once + orphan prune + static no-writer checks).
2. app.js filters at the call sites, the sheet switches, and the apply tests
   (every surface, ruling 1, ruling 3, feeds bytes, no sync, toWire, no URL,
   storage-listener branch).
3. Settings hidden list + styles, with settings and styles tests.
4. Final whole-branch review; report.

## Known, accepted

- If the series is hidden while its sheet is open, closing the sheet finds no
  opener to return focus to; `focusOpener` already leaves focus where the browser
  puts it (same as a delete).
- Entries for a uid that has left the feed are kept (the cache can be emptied
  for quota and refill). Only a vanished feedId is pruned.
