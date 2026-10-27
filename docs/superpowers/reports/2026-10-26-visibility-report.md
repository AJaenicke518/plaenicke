# Per-series visibility, option A — build report (2026-10-26)

Branch `visibility`, cut from 013af41. Approved design:
`.superpowers/sdd/lead-visibility-report.md` (main checkout), mockup
https://claude.ai/artifact/6aRVSz73LcWngKKFV6cxbX. Plan:
`docs/superpowers/plans/2026-10-26-visibility.md`.

## What was built

- `plaenicke.seriesVisibility`, a key kept on this device only:
  `{ [feedId]: { [uid]: { calendar, list, title } } }`.
  - `title` was added to the design's `{calendar, list}`. Settings has to name
    a hidden series even when no instance of it is in range. It holds an
    event title, never a URL.
  - `js/visibility.js` is the only reader and writer.
  - `js/storage.js` only moves the raw bytes, and its diff only adds lines.
- Two switches on a feed event's read-only sheet, under "From <calendar>":
  - **On the calendar** hides the series from Day, the Week grid and Month.
  - **On Today and in lists** hides it from Today's events, Next 7 days,
    Coming up, the Week list and the "Next:" line.
  - The note under them reads "On this device only. Undo it here or in
    Settings → Linked calendars."
- Under each calendar row in Settings, "Hidden on this device (N)" lists each
  hidden series with:
  - its title;
  - where it is hidden: "everywhere", "from Today & lists" or "from calendar";
  - a Show button.
- No trace of a hidden series is left on the pages it is hidden from.
  Nothing is synced. Whole-calendar Hide is unchanged.
- `service-worker.js` precaches `js/visibility.js`, which the existing
  serviceworker test requires. **CACHE is not bumped.**

## Controller rulings, as built

1. **A series hidden from lists also leaves Today's "Next:" line.**
   - `renderToday` filters both instance sets by the list surface, the 30-day
     look-ahead included.
   - Pinned by a test where the hidden class comes before the next shown event.
2. **A corrupt entry reads as shown and logs once per session.**
   - A corrupt entry is dropped on the next write made through `visibility.js`.
3. **A guessed (Canvas-shaped) series gets no switches.**
   - `canHideSeries` requires `guessedSeries !== true`.
   - If a series is hidden while not guessed and is later classed as guessed,
     its sheet shows no switches and only Settings can undo the hide. That is
     accepted.

## Hard constraints: how each is pinned

- **No change to `toWire`, `merge`, `pickFeed`, `applyRemoteFeeds` or
  `schemaVersion`.** `git diff 013af41 -- js/merge.js js/sync.js js/feeds.js`
  is empty. A test reads those three files and fails if any of them mentions
  series visibility.
- **A toggle leaves the stored `plaenicke.feeds` bytes identical.** Pinned in
  `tests/apply.test.js` (`toggleMeasured`) on every sheet toggle and on
  Settings Show. The check covers every key except
  `plaenicke.seriesVisibility`.
- **A toggle schedules no sync.** Pinned in the same place: no 2 s timer is
  live after the tap.
  - A positive control shows the same harness does see `addItems`' sync.
  - The cross-tab storage branch is pinned the same way.
- **`toWire` output is unchanged.** `JSON.stringify(toWire(localState()))` is
  identical before and after each toggle.
- **Feed URLs are never rendered.** A `stringsOf` walk over the sheet with
  switches and over the Settings panel finds no fragment of a secret URL.
- **Orphan entries are pruned only in `visibility.js`, on its own writes.**
  - The prune drops calendars that are no longer linked.
  - `removeFeed` is untouched.
  - A test reads `settings.js` and checks it imports only `loadVisibility`,
    `hiddenSeriesFor`, `showSeries` and `UnlinkedCalendarError` from
    `visibility.js`.

## Decisions beyond the mockup

- **"Show every <title>"** appears when the calendar holds more than one
  occurrence of the uid, or a rule for it. Otherwise the heading is
  "Show <title>". The test is not `recurring`, which covers only daily and
  weekly series, so a monthly series still says "every".
- **The list switch's sub-label** follows the series:
  - For a daily or weekly series it is the mockup's "Today's events and the
    “Next” line". Those series never appear in the upcoming lists.
  - For anything else it is "Today's events, upcoming lists and the “Next”
    line".
- **Writing for a calendar that is no longer linked throws
  `UnlinkedCalendarError` and stores nothing.** Otherwise the write would be
  pruned by itself. The check also stops an unreadable `plaenicke.feeds` from
  wiping every hide. The sheet and Settings say so in plain words.
- **A hide that saved but whose redraw throws** still moves the switch. It
  shows "Saved, but the screen couldn't update — reload." and logs the error.
  This mirrors how a ticked to-do handles the same failure.
- **Keys are read and written as own properties only.** A uid of `__proto__`
  or `constructor` from a feed's ICS is an ordinary series.
- **Settings Show uses `notifyViewChanged`, the same path as a colour tap.**
  - With no visible calendars, that path repaints "Updated <now>", exactly as
    a colour tap does.
  - It never calls `notifySyncedChanged`.
- **An event with no title** is shown as "Untitled event".

## Process and review

- **Plan** (3f1852f): a devil's-advocate review raised six Important and nine
  Minor findings. Adopted:
  - the copy, both what "every" depends on and the second sub-label (I1, I2);
  - `__proto__` keys (I3);
  - a saved hide whose redraw fails is not reported as failed (I4);
  - the other-key and no-sync pins widened, with a positive control (I5);
  - a check that `storage.js` only adds lines (I6);
  - a write for an unlinked calendar is refused, not pruned (M1);
  - Settings re-reads the map on every render (M3);
  - the empty-title placeholder (M6);
  - the switches are added to the sheet's Tab stops (M8);
  - the static check on what `settings.js` imports from `visibility.js` (M9).

  Not adopted: a dedicated callback for Settings Show (M2). It follows the
  colour-tap path, as noted above.
- **Task 1** (c3e4311, fixed in 17ee853), fresh reviewer: Important, stored
  JSON could pollute `Object.prototype`. Fixed by own-property writes and
  reads, and by refusing a write for an unlinked calendar.
- **Task 2** (fceee39, fixed in d105b4d), fresh reviewer: two Important.
  - The sheet's starting switch state was untested. The planted bugs M16 and
    M18 survived; both are now killed.
  - The app's failed-save path was untested (M12 survived; now killed).
  - User-facing error words were added.
- **Task 3** (d809dac, fixed in 64eaa53), fresh reviewer: two Important.
  - A disabled Show button passed every test.
  - A hard-coded colour passed. Both are now pinned.
  - The error words were made plain.
- **Final whole-branch review** of 64eaa53, fresh reviewer: no Critical and
  no Important findings.
  - It verified every hard constraint by diff, by planted bugs and by an
    end-to-end probe script.
  - It found that the branch merges cleanly as text with `contrast-and-gap`
    and `day-scroll-and-flake`, but did not run tests on the merged result.
  - Its Minor finding 2 (the "Close and reopen" wording) is fixed in the
    final commit.
- **Planted bugs:** every new assertion was checked by planting a bug and
  confirming a named test fails. In total 70 were planted across
  `visibility.js`, `itemsheet.js`, `app.js`, `settings.js` and `styles.css`.
  Each one that survived was turned into a new or stronger test.

## Open items for Alex

1. **Focus after a hide.** Hiding a series from its own sheet removes the row
   that opened it. On close, focus goes wherever the browser puts it, as after
   a delete.
   - Recommendation: accept for now.
   - If keyboard use matters, a follow-up can move focus to the page heading.
2. **Two kinds of "Show" button on a hidden calendar's row.**
   - The whole-calendar Hide/Show toggle predates this branch and has no name
     for its calendar.
   - With the calendar hidden, its row also holds the per-series Show buttons
     ("Show <title> again").
   - Recommendation: give the toggle `aria-label="Show <calendar>"` in a
     separate change. That code is shared, and other branches touch the same
     files, so it was left alone here.
3. **Stale names and state.**
   - A hidden series keeps the title it had when it was hidden.
   - An open sheet does not follow a hide made in another tab. One tap brings
     it back in line, and no wrong data is stored.
   - Recommendation: accept.
4. **Flaky existing tests in `tests/apply.test.js`.**
   - "a tick whose render throws after the save still schedules its sync"
     failed in 2 of about 10 runs on this branch and passed in all 6 runs on
     013af41. It runs before every new test and waits a fixed 50 rounds for a
     sync, where `CLAUDE.md` says to poll instead.
   - "drainUntil gives up even when Date is frozen" flickers on base and on
     this branch alike.
   - I have not proven the branch plays no part in the first. The runs
     happened while several agents were running the suite at once.
   - Recommendation: switch the first test to `drainUntil`. I did not do it
     here because another lead's branch (`day-scroll-and-flake`) appears to
     target these flakes.
