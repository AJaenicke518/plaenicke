# Day scroll on return, two flaky tests, and the Show/Hide label: build report

Date: 2026-10-26. Branch: `day-scroll-and-flake`, cut from `main` at 013af41. Not pushed or merged, and `CACHE` was not bumped.
Plan: `docs/superpowers/plans/2026-10-26-day-scroll-and-flake.md` (84d526e).

## What was done

| # | Item | Commit(s) | Pinned by |
|---|---|---|---|
| 1 | Day view opened at 12 AM when you came back to it | faa054d | apply: "Day: coming back to Calendar opens the grid at 7 AM again, not at midnight" |
| 2 | Flaky "drainUntil gives up even when Date is frozen" | 0a9f4e1, 264c140 | the same test, now timed |
| 3 | Flaky "a tick whose render throws after the save still schedules its sync" (added by the controller) | e4ec119 | the same test |
| 4 | The Show/Hide toggle names its calendar (added by the controller; Hide after ruling Q2) | d107827, 3ab6db1, 1dc9e33 | settings: two new tests |
| 5 | CLAUDE.md names each test file's poll helper (controller ruling) | 5b89f4a | — |

Files changed:
- `js/app.js`: one line in `renderDay`, plus its comment.
- `js/settings.js`: one line, plus a comment.
- `tests/apply.test.js` and `tests/settings.test.js`.
- `CLAUDE.md`: one sentence in the test section.
- The plan.

## 1. Day view at 12 AM on return

**Cause.** `showView` hides the old page and then calls `render()`, which re-renders every page. Leaving Day therefore redraws Day's grid while it is hidden. A browser reports `scrollTop` 0 for a hidden grid, so the new grid holds 0.

`renderDay` kept `lastDayRendered` through that hidden render (`if (visible) lastDayRendered = viewDay`). On the way back to the same day, `autoScroll` came out false, and `dayview.js` restored the 0.

**Fix.** `lastDayRendered = visible ? viewDay : null;`. A hidden render forgets the day, so the next visible render scrolls to 7 AM. A re-render while Day stays visible (a sheet save, a storage event, a resume) still keeps the user's place.

This is the same rule as the 3-day branch's 4abee77, written fresh in `renderDay` only. **Merge note:** both branches change the same line of `renderDay`. Whichever lands second takes this one-line version.

**Test first.** The test does this:
1. Shows Day and scrolls to 600.
2. Re-renders while visible, and the scroll stays at 600.
3. Goes to Today and writes `scrollTop` 0 the way a browser would.
4. Comes back and expects 336.

On the old code it failed with `expected 336, actual 0`.

**Mutants killed (5 of 5):**
- the old rule
- always remember the day
- never remember the day
- `autoScroll` forced true
- `autoScroll` forced false

The reviewer also killed an inverted ternary and `const visible = true`.

**Not done:** checking it in a real browser. The 3-day lead reproduced the bug in Chrome on main. I did not repeat that check after the fix, because the Mac's lid was closed and it kept going to sleep (see "Environment"). The fake DOM cannot show what a browser does with a hidden element; the test writes the 0 by hand.

## 2. "drainUntil gives up even when Date is frozen"

**Reproduction before the fix (main, 013af41).** Each run is one `node --test tests/apply.test.js`. Runs that overlapped a system sleep are counted separately, using `pmset -g log`.

| Condition | Awake runs | Cancelled | Test duration |
|---|---|---|---|
| Serial, no added load | 26 | 0 | 2.9–6.5 s (median 3.2 s) |
| 4 at once, 14 busy-loop processes | 18 | **16** | 9.6–10.0 s (cut off by the timeout) |
| 4 at once, 14 busy-loop processes, later session | 90 | 1 | 6.6–10.0 s (median 8.0 s) |

The two loaded rows differ because other sessions' load on the machine changed between them. In every loaded run the test ran within 0–3.4 s of its 10 s timeout.

**Root cause.** The test freezes `Date` with `t.mock.timers.enable({ apis: ['Date'] })`. That meant `drainUntil`'s `Date.now()` deadline never passed, and the loop stopped only at its 200 000-poll cap.

- Each poll is a `setImmediate` turn. 200 000 of them took 2.7 s in a bare script, and 2.9–8.5 s inside `apply.test.js`.
- Under load that ran past the test's 10 s timeout, which counts as `cancelled`.
- In a bare script, 200 000 turns used 0.5 s of CPU over 2.7 s of wall time. So the cost is mostly the process waiting on the OS, not computing. That is why load moves it so much.

**Fix.** The deadline now reads `performance.now()`, and the poll cap is gone. Verified on Node 22.18: with `apis: ['Date']`, `performance.now()` still advances while `Date.now()` stays put. The reviewer confirmed the same with every MockTimers API enabled.

The test now asks for 50 ms. It asserts that the wait took at least 50 ms and less than 500 ms of real time. The 10 s timeout is unchanged and is now only a guard against a hang. The frozen `Date` is pinned at today (`now: Date.now()`) instead of 1970.

**Mutants:**

| Mutant | Result |
|---|---|
| The old code | Killed. Cancelled at 10 s; this is the test failing first. |
| `Date.now()` with no cap | Killed. Cancelled. |
| `ms` ignored | Killed. "waited 2001 ms" |
| Giving up at once | Killed. |
| `ms * 10` | Killed after 264c140 tightened the bound from 1000 ms to 500 ms. |
| `ms / 2` | Killed (reviewer). |
| A `performance.now()` deadline with the old cap kept | Passes. It behaves the same as the fix. |

**After the fix:**

| Tree | Condition | Runs | Cancelled | Test duration |
|---|---|---|---|---|
| 0a9f4e1 | Serial | 30 (28 awake) | 0 | 50–148 ms |
| 0a9f4e1 | 4 at once, 14 busy processes | 30 (16 awake) | 0 | 50–189 ms |
| d107827 | 4 at once, 8 busy processes | 120 | 0 | 50–75 ms |
| e4ec119 (final) | 4 at once, 14 busy processes | 90 | 0 | 50–61 ms |

`apply.test.js` as a whole also got faster: about 11 s became about 2.5–7.6 s, because this test took most of that time.

## 3. "a tick whose render throws after the save still schedules its sync"

**Reproduction before the fix (main, 013af41).**

| Condition | Awake runs | Failed |
|---|---|---|
| Serial, no added load | 26 | 1 |
| 4 at once, 14 busy processes | 18 | 1 (and 1 more in a run that overlapped a sleep) |
| 4 at once, 14 busy processes, with diagnostics | 90 | **4** |

**Root cause.** The diagnostic copy logged the state after the test's fixed 50 `setImmediate` turns. All 4 failures looked the same:
- only a GET was sent, with no PUT;
- no offline fetch was made during the test;
- no mock timer was pending;
- `lastError` was null.

The 86 passing runs had GET and PUT. So the sync had started and had its answer. Between the GET and the PUT, `syncOnce` decrypts, merges and encrypts through WebCrypto, and that work finishes on the thread pool. Under load, 50 turns sometimes ran out before it finished. The PUT then went to the offline fetch, which the test had already put back.

This is the pattern CLAUDE.md warns about: poll, never use a fixed tick.

A sync left over from an earlier test was ruled out: no offline fetch was made during the test and no timer was pending. A separate instrumented run (30 runs under load) never needed more than 5 turns to reach the PUT. That fits a rare tail, not a steady shortfall.

**Fix.** The test polls with the file's `drainUntil` until the PUT appears. The assertion is unchanged. It still catches the bug it was written for: with `scheduleSync()` removed from `setDone`, it fails with "the saved tick must still be pushed".

**After the fix:**

| Tree | Condition | Runs | Failed | Test duration |
|---|---|---|---|---|
| main + only this fix | 4 at once, 14 busy processes | 90 | 0 | 2.7–26 ms |
| e4ec119 (final) | 4 at once, 14 busy processes | 90 | 0 | 2.2–18 ms |

For comparison, the tree with the first flake fixed but this one not yet fixed failed 0 of 120 runs (d107827, 8 busy processes). The cleanest comparison is main against main with only this fix, under the same load: 4/90 then 0/90.

## 4. The Show/Hide button's accessible name

`js/settings.js` gives the toggle `aria-label="Show <feed.name>"` when the calendar is hidden and `aria-label="Hide <feed.name>"` when it is visible. Show came first (d107827). Hide followed in 1dc9e33, after the controller ruled yes on open question 2.

**No URL in the label.** The label uses `feed.name` only:
- When a calendar is added, a name that looks like a link is refused (`settings.js:522`).
- An empty name falls back to `inferName`, which returns only Google, iCloud, Outlook, Canvas or Calendar.

**Tests (written first; each step failed on the code before it):**
- Two hidden calendars and one visible one. The labels are "Show Work", "Show Home" and "Hide School". No label contains a token, host or scheme from any feed URL.
- Hide, then Show. The re-rendered toggle is "Show Work", and then "Hide Work".

At d107827 the Hide button was asserted to have no label. 1dc9e33 changed those assertions to the Hide label first; both tests failed (null label) until the fix.

**Mutants killed (8 of 8, against the final code):**
- no label
- Show only (the code at d107827)
- Hide only
- the words swapped
- the URL in place of the name
- the name plus the URL
- the verb alone
- the first feed's name on every row

Against d107827, 7 of 7 were killed, and the Show-label reviewer killed 3 more: a lower-case label, the name without "Show", and `feed.id`.

## 5. CLAUDE.md: the poll helper's name

The syncOnce note said "poll (`settleUntil`)". `apply.test.js` has no `settleUntil`; its helper is `drainUntil` (`tests/apply.test.js:1074`). `settleUntil` is defined in `tests/linkui.test.js:785` and also in `tests/sync.test.js:1014`. The controller's ruling named only linkui.test.js, but both files have it. The note now names the helper for each file.

## Review

| What | Reviewer | Result |
|---|---|---|
| Plan | devil's-advocate (`jaeger:devil-advocate-reviewer`, Opus) | No Criticals. Adjudication below. |
| Task 1, faa054d | fresh Opus | No Critical or Important. 5 of 6 mutants killed. Its M5 (`autoScroll` without `visible &&`) survives because, under the new rule, it behaves the same in a browser. Left as is. |
| Task 2, 0a9f4e1 | fresh Opus | No Critical or Important. Minor 1 (upper bound too loose) fixed in 264c140. Minor 2 (a comment justified by a test that does not exist) fixed in 264c140. |
| Show label, d107827 | fresh Sonnet | No Critical or Important. Minor (the re-render path was untested) fixed in 3ab6db1. |
| Hide label (1dc9e33) and CLAUDE.md (5b89f4a) | **none**: added after the whole-branch review, on the controller's ruling | Mutation-checked by me (8 of 8). No independent reviewer saw these two commits. |
| Whole branch, 013af41..e4ec119 | fresh Opus | No Critical or Important. See below. |

**Plan review adjudication:**
- **I1, no failing test for Task 2:** fixed. The test is now timed, and the old code fails it.
- **I2, frozen Date reads 1970:** fixed with `now: Date.now()`.
- **I3, cause plausible but not pinned:** pinned by the loaded reproduction.
- **M2, Day → another page → Day now opens at 7 AM rather than where you left it:** this is open question 1.
- **M3, merge conflict with the 3-day branch:** noted above.

**Whole-branch review:**
- **Changes stay local:** confirmed. No `CACHE` bump.
- **Mutants:** it ran its own on every fix, and all were killed.
- **`npm test`:** 1538/1538.
- **Time zones:** `apply.test.js` passes under TZ=UTC and TZ=Asia/Tokyo.
- **Commit-message claims:** none of those it checked was false. It noted that 0a9f4e1's "50 ms to 1 s" was later tightened to 500 ms.
- **Its Minors, both left:**
  - CLAUDE.md names `settleUntil`, which exists only in `linkui.test.js`; `apply.test.js` calls it `drainUntil`.
  - `drainUntil` returns silently when time runs out, so each call site must assert afterwards. Every current one does.

All reviewers worked in `git archive` copies. None of them ran anything in the worktree.

## Environment: the Mac was asleep for much of the session

The lid was closed and the Mac was on battery (`AppleClamshellState = Yes`). It went into Maintenance Sleep every few minutes and woke for about 45 s at a time. `caffeinate` does not prevent clamshell sleep.

A test running across a sleep can time out. Two runs did:
- A reproduction run (17:54:32–17:58:41) was cancelled in the drainUntil test, at 250 s.
- A full `npm test` took 647 s and showed `fail 1, cancelled 1`. That matched a 647 s sleep exactly. Its per-test detail was lost because I piped it through `tail`. A re-run passed 1536/1536 in 10.5 s.

Every reproduction run therefore records its start and end. Runs that overlap a sleep in `pmset -g log` are reported separately. The rates above count awake runs, except where a table says otherwise.

## Other flaky tests seen (not fixed; outside this scope)

These failed across all reproduction runs, which cover the main and branch trees:

| Test | Failures |
|---|---|
| cross-tab sync: two visible tabs reacting to each other converge — no ping-pong | 5 |
| slow sync write: a write fetch that throws at once leaves no slow state | 3 |
| runSync records a lastError and lights the indicator when syncOnce itself rejects | 3 |
| slow sync write: a slow write that then fails shows the error, not the slow line | 2 |
| cross-tab sync: a storage event for a key that is not synced schedules nothing | 2 |
| wiring: a trigger during a sync waits for it, then runs once it settles | 1 |
| sweep D: with calendars, the stamp is the OLDEST fetch among the visible ones | 1 |
| removing a calendar in Settings pushes it, without waiting for a reload (in a run that overlapped a sleep) | 1 |

In the final 90-run loaded reproduction on e4ec119, 3 runs failed on these. That is enough to trip the `# cancelled 0` / `# fail 0` gate at random under load.

**Leads, all speculative:**
- `apply.test.js` has 34 fixed `await drain()` waits of 50 turns each.
- "a storage event for a key that is not synced schedules nothing" asserts that *no* request is made. A sync still running from an earlier test could break it, so a fixed wait may not be the only cause.

Each needs the same treatment as item 3: diagnostics, then a fix.

## Gate

`npm test` on the tree of 5b89f4a (the last code commit): `# tests 1538`, `# pass 1538`, `# fail 0`, `# cancelled 0`. The baseline on main was 1535; this branch adds 3 tests. The commit that updates this report changes only the report.

## Open questions: the controller's rulings

1. **Should Day remember where you scrolled when you leave it and come back?** Ruled: keep 7 AM. No change.
2. **Should the Hide button also name its calendar?** Ruled: yes. Done in 1dc9e33.
3. **Should the other sync-test flakes be taken on?** Ruled: yes, by a separate lead, not on this branch. The CLAUDE.md helper-name fix is done here (5b89f4a).

## What I'd do differently

- **Check the power state first.** I found the clamshell sleep only after a 647 s gate run and a 250 s test. I should read `pmset -g log` before trusting any timing on a laptop, and record each run's start and end from the beginning.
- **Never pipe the gate through `tail` alone.** I lost the names of the tests in the one gate run that failed. Gate output now goes to a file first.
- **Count failure rates in dozens of runs or more.** 30 instrumented runs did not catch the tick flake; 90 diagnostic runs caught it 4 times. With rates around 2–5%, small samples prove little.
