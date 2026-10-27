# 3-day view, option A (time grid): build report

Date: 2026-10-26. Branch: `three-day-view`, cut from `main` at 013af41. Not pushed, not merged, `CACHE` not bumped.
Plan: `docs/superpowers/plans/2026-10-26-three-day-view.md`. Mockup: https://claude.ai/artifact/WvXrGgMmutvNPFXfTX3dGh.

## What was built

What Alex picked on 2026-10-26, and where each one lives:

| Pick | Where | Pinned by |
|---|---|---|
| Three columns of Day's hour grid, with an All-day strip | `js/threedayview.js` (new) | `tests/threedayview.test.js` |
| ← → move 3 days, stepping from the window on screen | `app.js` `prev-3day`/`next-3day` through `stepFrom` | apply: "→ and ← move three days", "→ after midnight… steps from the window on screen", the sF next-arrows case |
| Switcher is Day / 3-day / Week / Month | `index.html` `#show-3day` | apply: the tabs/switcher test, NAV, SEGMENTS |
| Starts on today and follows today | `viewThreeDayStart = viewDay` at load; `followToday` in `refreshForToday` | apply: "the window follows a resume… a moved window stays put" |
| Repeating instances included | reads `visibleItems(start, start + 2)`, the same path Day uses | apply: a weekly MWF and a TuTh feed class drawn on their days |
| A block opens the item sheet | `onOpen: openItem`; the 3-day body is in `focusOpener`'s pages | apply: a block and an All-day chip open THIS item, and focus returns |
| A day heading opens Day | `onSelectDay: openDay` | apply: "a day heading opens that day in Day view" |

Files changed: `js/threedayview.js` (new), `js/app.js`, `index.html`, `styles.css`, `service-worker.js` (ASSETS only),
`tests/threedayview.test.js` (new), `tests/apply.test.js`, `tests/styles.test.js`.

## Decisions I made that the spec did not settle

1. **3-day has its own cursor, and `openDay` does not move it.** Tapping a Month cell and then 3-day shows
   the 3-day window you last had, which starts on today unless you moved it. The mockup said so ("If you
   leave it on another window, it stays there"). The other reading of "follows today the way Day and Week
   do" is that it also moves when a day is opened, the way `openDay` moves Day and Week together. Open
   question 1 below.
2. **48px an hour**, as in Day. The mockup's 44px was only there to fit a frame. The grid scrolls inside
   itself at Day's 60vh and opens at 7 AM, following Day's auto-scroll rule.
3. **Time then title, wrapping** (`flex-wrap: wrap`) rather than strictly time over title. On a tall
   block it reads as time over title; on a short one the title starts on the same line. A block of
   20–30 minutes in half a column still shows only its time ("9:25"), as the mockup's Wed 28 quiz did.
   Tapping it opens the sheet.
4. **Accessible name.** The visible time drops AM/PM. The rest ("–10:15 AM") is in a `.visually-hidden`
   span, so the name is "9:25–10:15 AM PHYS 2100" and begins with the visible text (WCAG 2.5.3). An
   `aria-label` would not have started with the visible text. Headings keep an `aria-label`
   ("Open Mon, Oct 26 in Day view"), following the Week list's day labels.
5. **All-day chips are 44px tall** (the `.item-open` minimum), not the mockup's 28px. The repo treats
   44px as the target size for tappable rows. The cost is that three untimed items on one day make a
   strip about 140px tall.
6. **Arrow labels** "Previous 3 days" / "Next 3 days", as in the mockup.

## Process and review

- **Plan:** committed at 26d874e. The devil's-advocate review (`jaeger:devil-advocate-reviewer`) found no
  Criticals. How I dealt with each finding:
  - **Fixed:** Day's 18px × padding and its row-direction `.item-open` are overridden; time and title now
    wrap (finding 2); the label-in-name change; the `NEW_SCREEN` allowlist is narrowed to `tday-head` and
    `tday-allday-label`; the stale index.html comment is updated.
  - **Tests:** every shared test list (PAGE_CONTROLS, NAV, SEGMENTS, `visiblePageButton`, the
    starts-hidden list) now includes 3-day. Each 3-day test puts the cursor back itself.
  - **Left as is:**
    - The All-day strip's height (decision 5).
    - Decision 1, which is open question 1.
    - Merge order on the shared lines (`render()`, `CALENDAR_VIEWS`, `showView`'s maps, `focusOpener`,
      `refreshForToday`, the ASSETS line, `index.html`'s switcher, `NEW_SCREEN`). That is the controller's
      call.
- **Task 1 (renderer, a9c7164):** a fresh reviewer (Opus) found no Critical. It found one Important: the
  All-day chip's done class, feed colour and "opens its own item" had no tests, and 4 of its 15
  mutations survived. Fixed in 004d5d3 with a three-chip test, which kills all four mutations. Its Minor
  ("Mon26" without a block `<b>`) is fixed in CSS and pinned in the styles test.
- **Task 2 (wiring, 004d5d3):** a fresh reviewer (Opus) worked in its own copy of the code and found no
  Critical. Its 10 mutations of app.js killed 7.
  - **Important 1:** three mutants of the scroll wiring survived (`autoScroll` forced true, forced false, and
    the lastRendered update).
  - **Important 2 (speculative):** coming back to the same window might open the grid at midnight. I
    **reproduced it in Chrome**: `scrollTop` was 0 after Today → Calendar.
  - **Fixed in 4abee77:** a hidden render now forgets the window, so the grid opens at 7 AM on return, and a
    re-render while it stays visible keeps the user's place. A new apply test kills all three mutants. In
    Chrome after the fix: 336 on return, and 600 kept after a sheet opened and closed.
  - **Same bug in Day, not fixed here:** I reproduced it in Chrome. Day on a moved day scrolled to 336; after
    Today → Calendar it read 0. The cause is the same `if (visible) lastDayRendered = …` rule in `renderDay`.
    I left it alone because it is shared code outside this workstream; open question 3.
  - **Minor, no change:** `PAGES` leaves out 3-day (and Week); the 3-day focus test covers that path. `CACHE`
    is unchanged on purpose: the controller bumps it at release.
- **Task 3 (styles, 446e316):** a fresh reviewer (Sonnet) found no Critical or Important. All 7 of its mutations
  were killed, and the narrowed `NEW_SCREEN` still rejects `.tday-block` reading `--text-row`.
  - **Minor 1 (fixed in 4abee77):** the overrides win only by coming later in the file. A test now checks
    their order and fails when the section is moved above `.item-open`.
  - **Minor 2 (left):** a desktop scrollbar narrows the grid but not the headings. iOS overlay scrollbars are
    unaffected.
  - **Minor 3 (left):** a done chip is dimmed by the global `.done` rule as well as struck through, which is
    consistent with other done items.
- **Final whole-branch review (013af41..4abee77):** a fresh reviewer (Opus) worked in its own copy and found
  no Critical or Important.
  - **What it checked by reading:** the view never writes; the Day, Week and Month cursors are unchanged.
  - **Mutations:** 6 of its own on app.js, all killed.
  - **Other time zones and dates:** the new tests pass under TZ=UTC, Berlin and Tokyo. With the real clock
    moved to 2026-12-31 23:59:30, 2027-03-14, 2026-10-27 08:00 and 2026-10-25 22:00, apply.test.js still
    ended `# fail 0`.
  - **Claims in this report:** none of those it checked were false.
  - **Minors, all left as they are:**
    - The heading's `aria-label` does not begin with its visible "MON 26" (WCAG 2.5.3). It follows the Week
      list's existing day labels; changing both is a separate decision.
    - An existing test, "drainUntil gives up even when Date is frozen" (apply.test.js:1079), was reported
      cancelled in 2 of about 10 runs under parallel load. Re-running cleared it. This is not new with this
      branch, but it can trip the `# cancelled 0` gate.
    - `CACHE` must be bumped at release.
    - The merge-conflict surface is the list given above.

### Mutation checks I ran (each new assertion seen to fail, then restored)

- **Renderer:** 24 mutations, every one killed.
  - The first run left one alive: a mutant that opened the column's first item. I fixed the test so two
    items share a column.
  - Also killed: today marking, the heading date, the chip handlers and ids, the strip condition, height
    and width, feed colour, the scroll order and the kept scroll, the hour label, HOUR_PX, the day lookup,
    the type class, the innerHTML reset, the done and feed colour on chips, `classList.add` with two
    tokens, and the hidden time span.
- **app.js:** 14 mutations, every one killed. They covered:
  - `followToday`, `openDay` moving the window, steps of ±1, the `focusOpener` entry, `CALENDAR_VIEWS`,
    and the segments map;
  - the data source: own items only, and no `isScheduled`;
  - `onSelectDay` as a no-op;
  - both arrows without `stepFrom`. These first survived, and I added the "after midnight" test so they
    fail.
- **styles.css:** 5 mutations, 4 killed at first. The fifth (the All-day label reading `--text-row`) is now
  pinned by a size assertion.

### Real-browser check

Done in Chrome DevTools at 390×844 (DPR 3, mobile), in light and dark, against a local static server on
the branch. The data was the LMU class pattern as feed events, plus own items:

- The view opens on Mon 10/26 – Wed 10/28, with the grid scrolled to 7 AM (`scrollTop` 336).
- The classes show on their days. The Wed quiz and PHYS 2100 share a column. MATH 234 and the 12:00
  advising appointment overlap on Monday and split the column.
- The heading columns line up with the grid columns: lefts 53, 160 and 266 px on both. The document is
  390px wide, with no horizontal scroll.
- → shows 10/29 – 10/31. Tapping the Fri heading opened Day on "Fri, Oct 30". Going back to 3-day kept
  10/29 – 10/31. Tapping a block opened the PHYS 2100 sheet ("Thu, Oct 29 · 9:55–11:35 AM, From LMU").
- The console showed no errors or warnings.
- One thing seen: desktop Chrome draws a scrollbar inside the grid, which takes a few pixels from the
  Wednesday column. iOS scrollbars overlay the content and take no width, but **this has not been checked
  on a real iPhone.**

## Gate

`npm test` at 4abee77 (the last code commit): `# tests 1573`, `# pass 1573`, `# fail 0`, `# cancelled 0`.
Baseline on `main` at 013af41 was 1535, so this branch adds 38 tests. The commit that adds this report changes only the report.

## Open questions for Alex

1. **Should opening a day (a Month cell, a Week column or list label, or a 3-day heading) also move the 3-day
   window to start on that day?** Right now it does not: 3-day keeps its own window, as the mockup said.
   **Recommendation: keep it as built.** A heading tap from 3-day would otherwise move the window you
   just came from, and pressing 3-day again would no longer bring you back to it.
2. **Short blocks show only their start time.** At 48px an hour in half a column, items under about
   35 minutes show "9:25" and no title. The sheet has the title. **Recommendation: leave it.** The other
   option is a taller hour, which means more scrolling.
3. **Day view has the same midnight-on-return bug, and it is already on `main`.** Open Day on a day other
   than the one it last showed, scroll, then go to Today and back: the grid shows 12 AM.
   **Recommendation:** apply the same one-line rule to `renderDay` in its own small change, with a test. It
   is not done here because it touches shared code.

## What I'd do differently

- Port 8765 was already taken by another session's server, and my first browser tab loaded *that* app.
  I only caught it because my own server failed to start. Next time: check the port first, and read the
  page's own title or label before trusting what is on screen.
- Reviewers and I shared one worktree. One reviewer's `npm test` ran while I was editing
  `tests/apply.test.js`. From Task 2 on, I had reviewers work in a `git archive` copy.
