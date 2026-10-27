# 3-day view, option A (time grid): build plan

Date: 2026-10-26. Branch: `three-day-view`, cut from `main` at 013af41.
Design: the 3-day lead's option A, mockup https://claude.ai/artifact/WvXrGgMmutvNPFXfTX3dGh.

## What Alex picked (2026-10-26)

- Option A: three columns of Day's hour grid, with an "All day" strip above.
- ← → move 3 days.
- 3-day sits beside Week: the switcher is Day | 3-day | Week | Month.
- It starts on today and follows today the way Day and Week do (`followToday`).
- It includes repeating instances, so the classes show.
- Tapping a block opens the item sheet. Tapping a day heading opens Day.

## Decisions this plan makes (not settled by the spec)

1. **Own cursor.** `viewThreeDayStart` is a new cursor, separate from `viewDay`. It starts on today
   at load. `refreshForToday` passes it through `followToday` with the day keys, as `viewDay` is.
   `openDay` does NOT move it. The mockup says "If you leave it on another window, it stays there".
2. **Same data path as Day.** The view reads `visibleItems(start, start + 2)`, which is own scheduled
   items plus every visible feed's instances for the range. That includes repeating instances; it is
   the path Day already uses. Ideas are excluded by `isScheduled`, as on Day. Done items stay, styled
   done, as on Day. Week's list (`upcomingRows`) is not touched.
3. **Hour height 48px**, as Day (`HOUR_PX`). The mockup used 44px to fit 8 AM–9 PM in a frame; it
   says the real grid scrolls all 24 hours and opens at 7 AM like Day. The grid scrolls inside itself
   (`max-height: 60vh`, as `.day-grid`), so the headings and the All-day strip stay above it.
4. **Auto-scroll** to 7 AM follows Day's rule: only when the window changed while the view is visible;
   otherwise the grid's own scroll position is kept across re-renders. The `scrollTop` write stays the
   last thing done, after the grid is in the document.
5. **Blocks**: start time without AM/PM ("9:25") over the title, as the mockup draws. The button's
   accessible name carries the full time ("9:25–10:15 AM PHYS 2100") through `aria-label`, so a screen
   reader does not hear an ambiguous "9:25". No × (the mockup: too narrow; the sheet has Delete).
   Overlaps use `layoutDayBlocks`, unchanged.
6. **All-day strip** is drawn only when one of the three days has an untimed item. Each chip is an
   `.item-open` button that opens the sheet.
7. **Headings**: a button per day ("Mon" over a bold "26"), `aria-label="Open Mon, Oct 26 in Day view"`,
   today's number in the today colour. Tap → `openDay(date)`.
8. **Label**: `weekLabel(start, start + 2)` ("10/26 – 10/28"), years added across New Year's.
9. **Arrows** get `aria-label`s "Previous 3 days" / "Next 3 days" (as the mockup).
10. **Focus return** after the sheet closes: the 3-day body is added to `focusOpener`'s pages.
11. `CACHE` is not bumped (controller does it at release). `js/threedayview.js` is added to `ASSETS`
    (the service-worker test requires every js module to be precached).

## Files

- New `js/threedayview.js`: `renderThreeDayView(container, startISO, itemsByDate, todayISO, { onOpen, onSelectDay, autoScroll })`.
  Pure layout reuse: `bucketDayItems`, `layoutDayBlocks`, `formatTime`, `formatTimeRange`, `addDays`, `itemTypeClass`.
- `index.html`: `#show-3day` after `#show-day`; `<section id="three-day-view" hidden>` with
  `#prev-3day`, `#three-day-label`, `#next-3day`, `#three-day-body`.
- `js/app.js`: els, cursor, `renderThreeDay`, `render()`, `CALENDAR_VIEWS`, `showView` maps,
  `focusOpener`, arrows, `refreshForToday`.
- `styles.css`: `.tday-*` rules, colours from tokens only. Blocks keep Day's compact sizes. The day
  headings and the All-day label use the new-screen label style (`--sans`, `--label-tracking`), as the
  mockup and the Week list's day labels do, so `tests/styles.test.js`'s `NEW_SCREEN` allowlist gains `tday-`.
- `service-worker.js`: `ASSETS` gains `js/threedayview.js`.
- Tests: new `tests/threedayview.test.js`; `tests/apply.test.js` (switcher, NAV, integration);
  `tests/styles.test.js` (new rules).

## Tasks (test-first; each gets a fresh reviewer)

1. **Module.** `tests/threedayview.test.js` first: three headings with labels/aria, today marked; heading
   tap → `onSelectDay(date)`; timed blocks placed per column (top/height from minutes, 48px/h), overlaps
   halve; untimed in the All-day strip in its own column; no strip when none; block tap → `onOpen(item)`;
   `data-item-id`; no delete control; feed colour; done class; throws without `onOpen`/`onSelectDay`;
   scroll to 7 AM written after the grid is in the document, and the previous scroll kept when
   `autoScroll` is false. Then `js/threedayview.js`.
2. **Wiring.** `apply.test.js` first: switcher order and labels; `#show-3day` reveals only
   `#three-day-view` and marks itself; Calendar tab reopens on 3-day when last used; label is today–today+2;
   → / ← move 3 days; a weekly feed class shows on its days (repeating instance); an own item and an
   idea (idea absent); a block opens its sheet and focus returns to it; a heading opens Day on that date;
   follows today across midnight when it showed today, stays when navigated away; arrows after midnight
   step from what is on screen. Then `index.html`, `app.js`, `service-worker.js`.
3. **Styles.** `styles.test.js` first: tokens only, compact sizes, 44px heading target, the grid scrolls
   inside itself. Then `styles.css`. Then a real-browser check at 390px in light and dark (Chrome
   DevTools MCP against a local static server), screenshots recorded in the report.
4. **Whole-branch review** by a fresh reviewer; report committed at
   `docs/superpowers/reports/2026-10-26-three-day-report.md`.

Gate every commit on `# fail 0` and `# cancelled 0`. Mutation-check each new assertion.
