# Stage 3 leftovers — lead report (2026-10-26)

Branch `stage3-leftovers`, cut from `cfe7913`. Three commits, one per item. Source: `~/punchlists/punchlist-plaenicke.md`, "Three small leftovers from the stage 3 round-2 re-review". Not pushed, not merged, not deployed.

| Item | Commit | Files |
|---|---|---|
| 1. Pin `=== id` in the tick focus-restore | 1657e20 | tests/apply.test.js |
| 2. COUNT=1 YEARLY/MONTHLY reads "single" | f5681c7 | tests/feeds.test.js |
| 3. Saved tick plus a throwing render | df83d7b | js/app.js, tests/apply.test.js |

## Item 1: focus-restore owner check (1657e20)

`toggleDoneKeepingFocus` in `js/app.js` is shared by Today and To-do. Test, looped over both pages: row Y's box has focus, row X's box fires `change`. Focus must not land on X's re-rendered box.

- The code was already correct, so this is a pin. The test passes on the current code.
- Mutant `rowItemId(row) !== null`: both tests fail (Today and To-do).
- Mutant `!!row` (any owner): both tests fail.
- The real pin is `notEqual(activeElement, againX)`. The test also asserts `activeElement === boxY`. That line holds only in the fake DOM: in a browser the re-render detaches boxY and focus falls to body. The reviewer flagged this as minor and it is left as is.
- Gate: tests 1532, pass 1532, fail 0, cancelled 0.

## Item 2: COUNT=1 YEARLY/MONTHLY (f5681c7)

Test: parsed ICS with `FREQ=YEARLY;COUNT=1`, `count=1;freq=monthly`, and COUNT=2 yearly and monthly rules as the control. It asserts `single 2`, `otherRuleEvents 2`, and the exact line `4 events: 0 repeat (RRULE), 2 yearly/monthly (shown as one-offs), 2 single. Uses the rule.`

- The test passes on the current code (a pin).
- Mutant: in `repeatFreqOf`, COUNT=1 is honoured only for DAILY/WEEKLY. Only the new test fails (1 of 78 in feeds.test.js). That confirms the gap was real.
- Gate: tests 1533, pass 1533, fail 0, cancelled 0.

## Item 3: a saved tick whose render throws (df83d7b)

**RED:** new test `a tick that saved but whose render throws says it saved, rethrows the render error, and renders once` failed on the old code with: expected `"Saved, but the screen couldn't update — reload."`, actual `'lo3 render failed'`.

**Fix:**
- `setDone` saves, then calls `scheduleSync()`, and no longer renders. `handleToggleDone` is its only caller (checked with grep), and it now does the render.
- A throw from `setDone` means the save failed. The behaviour is unchanged: the error message is shown and the page re-renders once.
- A throw from the render means the tick saved. The message becomes `"Saved, but the screen couldn't update — reload."` and the error is rethrown, not swallowed. The render is not retried.
- The C9 order (`scheduleSync()` before render) still holds; it now spans the two functions.

**Message wording:** nothing in the code or punchlist settled it, so this is the fallback wording the controller supplied. It is Alex's call to change.

**Mutants I ran:**
- Drop `throw e`: the C9 test and the new test fail.
- Put `render()` back in `setDone` before `scheduleSync()`: the C9 test and the new test fail.
- The old code (the RED run): the new test fails.

**GREEN gate:** tests 1534, pass 1534, fail 0, cancelled 0.

**Unmentioned behaviour change** (the reviewer's minor 1): `setDone`'s `if (idx < 0) return;` used to skip the render. Now `handleToggleDone` renders after it. In practice, ticking a box whose item sync just removed now repaints from `items` instead of leaving a stale box. No test covers the missing-id path. The reviewer's mutant M12 (throw on `idx < 0`) survives. This was not pinned, to keep one commit per item; it is a candidate follow-up.

**Also unpinned** (the reviewer's minor 2): when the render throws, `toggleDoneKeepingFocus` skips its focus restore, because the error propagates. The screen is already broken at that point and the user is told to reload.

## Review

A fresh general-purpose reviewer agent (opus), not the implementer, reviewed all three commits by running them.
- Verdict: approve with minors. No Critical or Important findings.
- It ran 15 mutants (M1–M14 plus M3b); 14 were caught. The survivor is M12, the missing-id path above.
- It confirmed the save-failure path still re-renders and shows the error: sweep D catches the mutants that drop the re-render, drop the message, or show the "Saved" message.
- It confirmed the sync and ownership invariants are intact: no new writer, `nextStamp` kept, the restore on a failed save kept.
- Its gate: tests 1534, pass 1534, fail 0, cancelled 0. Its tree was clean after the run.

## Follow-up: the missing-id path is now pinned

The controller approved open question 2 and kept the message wording (question 1).

New test in `tests/apply.test.js`: `a tick on a box whose item is gone saves nothing, shows no error, and re-renders`.
- **Setup:** render the box, then `seed([])` so the item is gone, then put a sentinel element in the To-do list and tick the stale box.
- **Asserts:** the tick does not throw, no message is shown, storage stays empty, and the sentinel is gone (the page re-rendered).
- **Results:**
  - On the current code the test passes. This is a pin, not a fix.
  - Reviewer mutant M12 (`setDone` throws when `idx < 0`): the test fails.
  - Mutant that skips the render for a missing id (an early return at the top of `handleToggleDone`): the test fails.
  - `js/app.js` was restored after each mutant; `git status` showed only the test file changed.
- **Gate:** tests 1535, pass 1535, fail 0, cancelled 0. One commit holds this test and this report update.

## Open questions for Alex (as of the first hand-off; both now settled by the controller)

1. The message for a tick that saved but whose screen failed to update. It is currently "Saved, but the screen couldn't update — reload." Recommendation: keep it. It says the data is safe and gives the one action that fixes the screen.
2. Pin the missing-id tick path (M12)? Recommendation: yes, as a small follow-up test.

## Friction

- Writing to the main checkout's `.superpowers/` from a worktree is refused, so this report lives on the branch instead.
- A combined `cd && cat >> file <<EOF` command was refused by the worktree guard. Use Edit, or a separate plain command.
