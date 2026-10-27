# Day scroll on return, and the drainUntil flake: plan

Date: 2026-10-26. Branch: `day-scroll-and-flake`, cut from `main` at 013af41.

## Task 1: Day view opens at 12 AM when you come back to it

**Cause (read from the code, matching the 3-day report's Chrome reproduction):** `renderDay` in
`js/app.js` sets `if (visible) lastDayRendered = viewDay`. Every `showView` calls `render()`, so leaving
Day re-draws its grid while the page is hidden. A browser reports `scrollTop` 0 for a hidden grid, so
the new grid holds 0. On return, `viewDay === lastDayRendered`, `autoScroll` is false, and `dayview.js`
restores that 0: midnight.

**Fix:** `lastDayRendered = visible ? viewDay : null;` A hidden render forgets the day, so the next
visible render scrolls to 7 AM. A re-render while Day stays visible still keeps the user's place. Same
rule as the 3-day branch's 4abee77, written fresh here and not copied, in `renderDay` only.

**Test first (`tests/apply.test.js`):** show Day, scroll to 600, re-render while visible (keeps 600),
go to Today, set the grid's `scrollTop` to 0 as a browser would, come back: expect 7 × 48. Must fail
on the current code. Mutation checks: the old rule; `null` replaced by `viewDay`; `autoScroll` forced
true (kills "keeps the user's place"); forced false.

## Task 2: "drainUntil gives up even when Date is frozen" cancelled under load

**Reproduce first** on an untouched copy of 013af41: 30 serial runs of `tests/apply.test.js`, then 30
runs 4-wide with 14 busy-loop processes. Record the test's duration and the cancelled count.

**Hypothesis to check, not yet a finding:** with `Date` frozen, the 2 s wall bound never fires, so the
loop ends only at `maxPolls` = 200 000 `setImmediate` turns. That costs whatever 200 000 turns cost on
the machine at the time, against the test's 10 s timeout.

**Fix direction, if confirmed:** bound the wait by a clock MockTimers does not freeze
(`performance.now()`; to be verified that `apis: ['Date']` leaves it alone), so the wait ends after
`ms` of real time whatever the machine's speed, and drop the poll cap that only existed for the frozen
case. Re-run the same reproduction after the fix.

## Review

Fresh reviewer per task and a final whole-branch review, each working on a `git archive` copy.
