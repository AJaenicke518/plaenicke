# Daily-use fixes: report (2026-10-27)

Branch `daily-fixes`, cut from `main` @ f1d97ea. CACHE is not bumped. Plan: `docs/superpowers/plans/2026-10-27-daily-fixes.md` (61a026c).
app.js changes: one import line, plus the `createdAt` line and its comment in `addItems`. `handleAdd`, `handleManualAdd` and `index.html` are not touched (the parallel `capture-date-row` branch owns them).

## Commits
| SHA | Item |
|---|---|
| 61a026c | plan |
| f71ebeb | 1: the Settings backdrop scrolls |
| eb3bcd3 | 3a/3b: press pointerleave checks pointerId; the test fake honours capture; uninstall test |
| 3e70dc0 | 2: same-day ideas list newest first (createdAt carries the local time) |
| 618af41 | 3c: the 16px scan reads the `font:` shorthand |
| (this commit) | 3c review fix (the scan reads inside @media) + this report |

## Item 1: Settings can run off the screen
- **Claim verified.** `.settings-backdrop` was fixed with `padding-top: 15vh` and had no overflow rule. `js/scrolllock.js` sets `body.style.overflow = 'hidden'` while the panel is open.
- **Fix:** three declarations on the backdrop:
  - `overflow-y: auto`;
  - `overscroll-behavior: contain` (as `.sheet` has);
  - `padding-bottom: calc(24px + env(safe-area-inset-bottom))`.
- **Test:** `tests/styles.test.js` "the Settings backdrop scrolls…". It fails without the declarations.
- **Chrome check.** Fresh isolated context, 375×667 mobile emulation. Cross-origin `fetch` was stubbed offline, so nothing reached the Worker.
  - Before seeding, `localStorage` held only `plaenicke.launches` and `plaenicke.auth` was null, so there was no link code.
  - Seeded 6 calendars and 24 hidden series. Settings `scrollHeight` was 2710 against `clientHeight` 667. It scrolled to 2042.5 of 2043, and the panel bottom ended at 643 (24px of padding above the viewport edge). A screenshot showed the Sync section fully visible.
  - With the rule switched off inline, `scrollTop` stayed 0 and the panel bottom sat at 2685px. That reproduces the bug.
- **Not verified on WebKit/iOS (speculative).** The devil's advocate raised whether WebKit counts a flex scroll container's `padding-bottom` in the scroll range. Chrome does. If WebKit does not, the panel still scrolls, but the 24px plus safe-area gap at the end would be missing. Fallback if an iPhone check shows that: move the space to `margin-bottom` on `.settings-panel`.

## Item 2: same-day ideas in random order
- **Claim verified.** `addItems` stamped `createdAt: toISO(new Date())`, a date only. `sortIdeasNewestFirst` broke ties on `uid()`, which comes from `crypto.randomUUID`.
- **Every `createdAt` reader checked** (by me, the devil's advocate and the task reviewer):
  - `makeItem` copies it and does not validate it.
  - `deserializeItems` reads it only to backfill a missing `updatedAt` on pre-V5 records.
  - `applyEdit` carries it through.
  - `merge`, `sync` and `linkui` never read it; dedupe keys on title/date/time or id.
  - **The Worker never mentions `createdAt`** (grep over `worker/`), so there was nothing to stop on.
  - `formatDayLabel` takes `item.date`. No view displays or slices `createdAt`.
- **Fix:**
  - `localStamp(d)` in `js/dateparse.js` produces a local `YYYY-MM-DDTHH:MM:SS.sss`, prefixed by `toISO`. `addItems` uses it.
  - `sortIdeasNewestFirst` compares the whole string.
- **Devil's-advocate finding 1, accepted and fixed.** Compared whole, the stamp would have reordered the calendar pages:
  - an own item added today would sort after that day's all-day feed events, whose `createdAt` is `'<date>T00:00'`;
  - same-day own items would sort by clock time instead of title.
  - The fix: `sortItemsByDate` compares only the stamp's day (`createdDay`, which cuts only the exact local-stamp shape). That reproduces the old order.
  - The task reviewer checked this by running 20,000 random mixed lists: 0 mismatches against the old order, 0 order changes on shuffled input, 0 transitivity violations.
- **Tests:**
  - dateparse: format, and the 23:59 local / next-day UTC case.
  - items: ideas order within one day, and calendar order kept.
  - apply: a mocked Date, idea A, then idea B 5 minutes later; the Ideas page shows B first. `randomUUID` is mocked ascending so the old tie-break would put A first, which makes the mutant fail deterministically.
  - The existing assertion `idea.date === idea.createdAt` now compares the date prefix.
- **Mutants:**
  - `addItems` back to `toISO` fails the Ideas-page test.
  - Dropping `createdDay` fails the calendar-order test.
- **Known, accepted (written in the `localStamp` comment):**
  - Inside the repeated hour of a DST fall-back, ideas can list out of order.
  - Ideas captured on two devices in different time zones can list out of order.
  - Several ideas saved in one `addItems` batch share a millisecond, so they still tie on the random id. That only happens with a multi-idea smart add.
- **Rollout transient (reviewer, low).** A device still on the old client compares stamped records whole until it updates. On that device, new own items sort after the day's all-day feed events, and same-day items sort by clock. This affects display order only.

## Item 3: leftovers
- **3a.** `pointerleave` now requires `e.pointerId === pointerId`. New test: a second pointer leaving does not clear the press. The mutant that drops the check fails it.
- **3b.** The fake `removeEventListener` matches on type, function and capture flag, taking either a boolean or `{capture}`. A test pins the fake itself.
  - New uninstall test. The mutant `uninstall` without opts fails both uninstall tests. The original uninstall test passed under that mutant before the fake changed.
- **3c.** The scan also parses the `font:` shorthand.
  - CSS-wide keywords (`inherit` and the like) are skipped by name. A shorthand with no readable size is reported, not skipped.
  - The mutant `input { font: 14px x }` fails the scan.
- **3c review finding, fixed.** The scan's regex never read the first rule inside an `@media` block. That gap predates this branch. The scan now uses the file's existing `rulesOf` parser. The mutant `@media (min-width:1px){ input{font:14px x} }` now fails it. Before the fix, the reviewer's probe passed.
- **Reviewer low, not fixed:**
  - `14px!important x` reads as "no readable size". That is a loud false positive, not a miss.
  - The scan does not resolve `font: inherit`'s parent size. The rules that use it set `font-size: 1rem` on the next line, which the scan reads.

## Reviews
- **Plan:** devil's advocate (jaeger:devil-advocate-reviewer, opus).
  - Its Grep and Glob failed, so it read the files by hand and did not read `worker/` or `tests/`. The task reviewer covered those.
  - Finding 1 was fixed. Findings 2 and 5 are documented. Finding 3 is recorded above as unverified on WebKit.
  - Finding 4 was accepted in part: `inherit` stays skipped, with the reason above.
- **Item 1:** fresh reviewer (sonnet). No blocking issues. Mutation confirmed.
- **Item 2:** fresh reviewer (opus). No blocking issues. Both mutants and the randomized order check were run.
- **Item 3:** fresh reviewer (sonnet). One medium finding (the @media blind spot), fixed. All three mutants confirmed.
- **No separate whole-branch review was run** beyond the per-task reviews and the final full gate.

## Gate
`npm test` at the final commit: `# tests 1767`, `# pass 1767`, `# fail 0`, `# cancelled 0`. Every commit on the branch was gated on `# fail 0` and `# cancelled 0`.

## Open questions for Alex
- None blocking.
- Recommend checking item 1 once on the iPhone PWA (WebKit), since only Chrome was exercised.
