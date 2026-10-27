# Remaining flaky sync tests: report (2026-10-27)

Branch `sync-flakes`, from `main` at f1d97ea (v6-16). Only `tests/apply.test.js` changed. No production code changed and CACHE was not bumped.

## Result

| Condition (`node --test tests/apply.test.js`) | Before | After |
|---|---|---|
| Idle, 90 runs one at a time | 0 / 90 failing runs | 0 / 90 |
| 14 at a time, 90 runs | 0 / 90 | not re-run |
| **40 at a time, 360 runs** | **55 / 360 failing runs** | **0 / 360** |
| Reviewer's own runs, 40 at a time | 7 / 80 | 1 / 80, then 1 / 160 (both: the open flake below) |

Cancelled tests: 0 in every run, before and after. The machine has 14 cores. The prior lead's "3 of 90" did not reproduce idle or at 14-way load. It reproduced at 40-way load, so all the per-test numbers below come from that load.

Per test, 40-way load, 360 runs each side. "Failed" counts every run in which the test failed. "First" counts the runs in which it was the first failure, which is where the cause shows. Later failures in the same run are mostly knock-on effects.

| Test | Failed before | First before | After |
|---|---|---|---|
| cross-tab sync: two visible tabs … no ping-pong | 26 | 9 | 0 |
| slow sync write: a slow write that then fails shows the error … | 21 | 4 | 0 |
| a tick whose render throws after the save still schedules its sync … | 21 | 2 | 0 |
| slow sync write: a write fetch that throws at once … | 19 | 2 | 0 |
| slow sync write: a pending adoption outranks the slow line | 19 | 1 | 0 |
| cross-tab sync: a write from a tab that hid is pushed … | 19 | 3 | 0 |
| slow sync write: a corrupt stored code outranks the slow line | 17 | 0 | 0 |
| slow sync write: the line clears when its write settles, even when a retry follows | 16 | 8 | 0 |
| slow sync write: a slow READ never shows the slow-write line | 8 | 5 | 0 |
| visible-only sync: a delete committed on backgrounding … | 6 | 6 | 0 |
| slow sync write: a write that settles quickly … | 6 | 5 | 0 |
| visible-only sync: with no visibilityState at all … | 4 | 4 | 0 |
| cross-tab sync: a storage event for a key that is not synced … | 4 | 4 | 0 |
| slow sync write: the shell says so past the threshold … | 2 | 2 | 0 |

## Root cause (one cause, measured)

app.js's `scheduleSync` arms a **real** `setTimeout(runSync, 2000)` whenever a test writes under real timers: a tick, an Ideas capture, an add, a Settings calendar change. Twenty earlier tests leave one pending when they end. The reviewer counted this in afterEach: 21 per run including guard test 1, the same idle and loaded. On an idle machine all of them fire after the last linked test, against the offline fetch, so nothing breaks. Under load the file runs slower. Those timers then fire inside whichever test is running 2 s later, and that is usually one of the visible-only, slow-write or cross-tab sync tests (tests 154–168). By then the device is linked, the test's fetch stub is installed, and `installManualTimers` has replaced `setTimeout`.

Two effects follow:
- **An extra sync inside the test.** Examples: "expected 1 PUT, got 2"; a second PUT replaces `holdAccountWrite`'s single `releasePut`; or the test's own trigger finds `syncInFlight` set and only sets `syncPending`.
- **A sync that never ends.** In the slow-READ test's never-answering stub, the stray sync's read deadline (`fetchWithTimeout`) is a *manual* timer that nobody fires. `syncInFlight` then stays true for the rest of the file. Every later sync in the file fails, which explains the 8–10-failure runs that end at the tick test (now test 231).

**Evidence.** A temporary trace wrapped `setTimeout` for functions named `runSync` and logged the test in which each timer was armed and the test in which it fired. Across 120 runs at 40-way load, the stray timer fired inside the failing test in every failing run, each time with that test's stub installed (`fetchIsOffline=false`) and its manual timers in place (`setTimeoutIsReal=false`). Idle, the same timers all fired in the file's last test.

**Ruled out by measurement, for tests 154–168 only:** the fixed-turn waits in those tests (`drain()`'s 50 turns, and the `for i < 200` loops). Instrumented at 40-way load over 120 runs, a healthy sync reached the network in at most 15 turns. A wait that ran out did so because the sync was stuck: it did not arrive within 10 s either. I left those waits unchanged. WebCrypto timing was not a cause at this load.

## Fix (test-side)

In `tests/apply.test.js`, installed at module scope before app.js is first imported:
- A `setTimeout` wrapper tracks real timers whose callback is app.js's `runSync`.
- A matching `clearTimeout` wrapper drops cleared timers from the tracker.
- An `afterEach` cancels any tracked timer still pending, so every test ends with no real sync timer armed.

`installManualTimers` and MockTimers save whatever `setTimeout` is current and restore it afterwards. I checked that MockTimers' `reset()` restores the wrapper.

Two guard tests, written first, run in order:
1. "a real sync timer a test leaves armed is seen by the tracker". If app.js renames `runSync` or arms its debounce some other way, this test fails, so the file cannot quietly go back to leaking timers.
2. "…and is cancelled when that test ends". It checks that the previous test's timer was actually cleared (`_destroyed`), not just forgotten.

I mutation-checked each against a planted bug, and each failed:
- The `afterEach` clearing removed: both guard tests fail.
- The name match broken: both fail.
- The handle forgotten but not cleared: test 2 fails on `_destroyed`.

There are no raised timeouts, no skips and no retries.

## STILL OPEN: "ticking a to-do schedules a sync" (test 30, tests/apply.test.js:1084)

The final reviewer found this one, not my runs. Its counts:
- after the fix: 2 failures in 240 runs at 40-way load;
- on the parent file: 1 failure in 80 runs.

So it predates this commit and is independent of the stray timers: it runs under MockTimers, so a real timer cannot reach it. In the failing run it failed after 6 ms with no PUT sent ('a completed to-do must reach the account…').

The test waits a fixed 50 setImmediate turns after `t.mock.timers.tick(2000)` (line 1105). CLAUDE.md forbids that: "poll, never a fixed tick".
- **Speculative cause:** that wait runs out before syncOnce's WebCrypto steps reach the PUT.
- **Recommended fix:** replace the loop with `drainUntil(() => requests.some((r) => r.url.includes('/data') && r.method === 'PUT'))`, as the tick test at 7414 already does. Then measure before and after at 40-way load.

The same raw 50-turn pattern is also at lines 564, 1237 and 2617. Not fixed here: the controller's hard stop left no time for a reviewed, measured fix.

## Not changed, noted

- **Speculative risk.** "the line clears when its write settles…" releases the `pending` PUTs in `finally`. A PUT issued after that loop would stay held forever. Reaching that requires the test's own sync to arrive late, and I measured no such case once stray timers were gone. I made no change for it.
- In two loaded baseline runs, the tick test failed on its own (2 s `drainUntil` exhausted). Those runs had no timer trace, so this is not attributed with evidence. After the fix it failed 0 times in 360 runs.
- The `_destroyed` check reads a Node-internal Timeout field. It holds on Node 22.18. If a Node upgrade removes the field, guard test 2 fails loudly; it does not pass silently.

## Gate

`npm test`: tests 1760, pass 1760, fail 0, cancelled 0.

## Process gaps

- I wrote no separate plan under `docs/superpowers/plans/` and ran no devil's-advocate review of a plan. The work was a single test-side change, investigated directly.
- Final diff review: a fresh reviewer agent (opus) reviewed bc7f3b5. It:
  - re-ran the gates and the three mutations, all of which matched;
  - confirmed that the tracker stays installed for all 266 tests and that 0 tracked timers fire during tests (so none a test needs is cancelled);
  - confirmed that odd handles passed to clearTimeout are safe.

  Nothing blocking. Its findings:
  - the open flake above;
  - the overstated ruling-out and count, both corrected here;
  - a suggestion to add `beforeEach(() => assert.equal(realSyncTimers.size, 0))` to catch a sync timer re-armed after a test's afterEach. It measured 0 such cases in 80 loaded runs. Not added.
