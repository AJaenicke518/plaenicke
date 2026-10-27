# Stage 4 (the capture button) — lead report, 2026-10-26

**Status:** built, reviewed, NOT merged and NOT verified on the phone. Branch `stage4-capture` in worktree `.claude/worktrees/agent-af1149b0f51112863`. Merging is Alex's call (merging to `main` is the deploy).

**What it is:** spec § 3. A 56 px round mic button bottom-right on every page. Tap: the capture box grows out of it and listens, with the words appearing live. Tap again: it stops and adds through smart add. Tap the words: you type instead. The top add box stays as it was; its small mic and `dictate()` are gone, leaving one mic.

## Commits (on cfe7913, then main 013af41 merged in)

| SHA | What | Fresh review |
|---|---|---|
| d54cc97 | Plan | devil's advocate (below) |
| 1c493fe | Plan amended from the DA review | — |
| 884439d | Task 1: `js/viewport.js` (the sheet's visual-viewport follower, shared) | Approved |
| 16f6bd8 | Task 2: `listen()` in `js/voice.js` | Approved |
| 308d621 | Task 3: capture button and box markup and CSS | Approved (checked in Chrome at 390×844) |
| 452073a | Task 4: `js/capture.js` (the state machine) | Needs fixes: 1 Important (plan-mandated) |
| bacb623 | Task 4 fix round | Approved |
| 6721e15 | Task 5: `handleAdd` takes a target box; a stale preview is refused | Approved |
| 8f94691 | Task 6: the button wired into app.js; `#mic-btn`/`dictate()` retired | Approved |
| fd39562 | Polish round: the Minor findings ruled APPLY | covered by the whole-branch review |
| 6194eb5 | Docs: plan execution record; spec § 8 stage 4 result | — |
| 139d619 | Merge of `main` 013af41; `CACHE` v6-14 | fresh merge review (below) |

Gate on the merged tree (139d619): `# tests 1612`, `# pass 1612`, `# fail 0`, `# cancelled 0` (baseline cfe7913: 1530).

## How it was built

1. **Plan** `docs/superpowers/plans/2026-10-26-plaenicke-home-stage4.md`: six tasks, each with complete code, exact tests and named mutants. Before review, every step was trial-run in order on a throwaway worktree of cfe7913, so the RED lists and counts in the plan come from real runs. The plan is generated from the same files the implementers copied (`.superpowers/sdd/stage4/files`, `scripts`).
2. **Devil's-advocate review of d54cc97.** No Critical findings; four Important, sixteen Minor. Every one is ruled in the plan's adjudication table:
   - APPLY: I1 (Cancel could cancel the other box's newer request; the latch could stay up for 60 s), I2 (a listen over its own preview re-sent the old text), I3 (Add pushed out of a small box with the keyboard up), I4 (a preview input raised the keyboard without the box following), and M1–M5, M14 (part), M16.
   - DEFER, each with a named blocker: M6, M7, M8, M15 (Alex's call: open questions below) and M10–M13 (need the phone: checklist).
   - DISMISS, with a reason: M9 and part of M14.

   The amended plan was trial-run again end to end before execution.
3. **Execution.** Implementer subagents worked task by task, test-first. Each planted the plan's named mutants, and every one was killed. Every task got a fresh reviewer.
4. **What the reviews changed beyond the plan:**
   - The Task 4 review found that my plan's own code wiped a field the user had edited when tapping the mic over its own preview (decision 17). The fix round keeps an edit.
   - Two small additions came from the same review: "Type instead" now hides when the round button is tapped after a refusal, and a rejected add says "Could not add: …" and is logged.
   - The polish round:
     - a stale preview's confirm is now silent; it was writing over the newer request's line;
     - nothing shows under the sticky actions row any more;
     - the box shadow uses `--shade`;
     - a test pins the guard that keeps "Cancelled" on screen;
     - `stopAndKeep` runs last on backgrounding and when an item opens;
     - the held requests in one test are released in its `finally`.
5. **Whole-branch review of cfe7913..fd39562.** It found one Critical: `main` had moved to 013af41 and had already shipped `plaenicke-v6-13`, the same cache name this branch bumped to. Merged as it stood, this release would not have changed the cache.
   - Fixed in 139d619: merged `main`, set `CACHE` to v6-14 and re-pinned `CACHE_ON_MAIN` to v6-13 (test first: it failed, then passed).
   - The `apply.test.js` conflict was resolved by keeping both appended blocks, with the stage 4 refusal test last.
   - After the merge, the wiring and polish mutants were re-run on the merged tree; all were killed.
   - The review found no correctness defect in the stage 4 code.

## Alex's phone checklist (none of this is verified by the tests)

On the iPhone home-screen app, unless noted.

1. Mic, then words appear live, then tap again: it adds at once, with no wait.
2. Mic, stop, mic again: the second listen adds to the first words.
3. Background the app while listening: on return the words are still there and nothing was added.
4. Open an item while listening: listening stops and the words stay. The round button is hidden while the sheet is open.
5. Open Settings while listening: the same, and the button is hidden while Settings is open.
6. Tap the words while listening: the keyboard comes up in that same tap and the words stay. This depends on clearing read-only, then blur(), then focus() inside the tap, which is untested on iOS.
7. With the keyboard up, the box sits just above it and Add is reachable. With the keyboard down, the box sits just above the round button, which can still be tapped.
8. × with the keyboard up: the box fades where it is, rather than shrinking toward a hidden button or jumping first.
9. In a Safari tab, not the home-screen app, a refusal says "Voice works in the home-screen app."
10. With mic permission off: "Microphone permission is off — Settings → plaenicke.", and "Type instead" brings up the keyboard.
11. The box grows from the button in 250 ms and shrinks back. With Reduce Motion on, it only fades.
12. The button clears the home indicator and the tab bar, and the Undo toast still fits beside it.
13. Pressing the round button scales it instantly and it never sticks.
14. Dark mode: the button, the box and its text all read well.
15. "Thinking…", then Cancel: the late reply adds nothing.
16. A long dictation: the field grows to five lines, then scrolls, and Add stays visible.
17. Continuous listening, across pauses:
    - no repeated words;
    - no words run together ("buy milkand eggs").
18. The very first listen: the iOS microphone and speech prompts do not end it.
19. Typing in the box: it moves above the keyboard without an ugly jump. Editing a preview field also keeps it above the keyboard.
20. "Settings → plaenicke" is a real path to the microphone switch.
21. With a preview open in the capture box, its Add sits below "Add all". The box's Add re-sends the text as a new, paid request and brings the preview back; "Add all" adds the items. Do these read clearly? (whole-branch review)
22. Capture box open, then the Ideas box or the top box focused with the keyboard up: does the capture box cover the field being typed into? (whole-branch review)
23. Typing in the box, then wanting the mic: the keyboard covers the round button. Is it clear to dismiss the keyboard first?
24. While listening, the empty message line leaves a small gap under the words. Is that acceptable?
25. A delete's Undo toast stays usable while the box is open.

## Open questions for Alex (each with my recommendation)

1. **No "Added." after a capture.** Success closes the box (spec § 3: "Success closes the box"), so the message is never seen; the new item appearing on the page is the only feedback. *Recommendation:* keep it as it is, and refine through use. If the item is off-screen (a date next month), a short toast "Added: …" is the natural next step.
2. **Return in the capture field.** It makes a new line; it does not add. In the top box, return adds. *Recommendation:* make return add, with Add/Cancel still there, because voice-first capture rarely needs a second line. It is a one-line change once you say so.
3. **A top-box smart add overtaken by a capture just goes quiet.** Its "Thinking…" clears and its text stays, with no message. *Recommendation:* fine as it is; it is rare.
4. **The capture box's Add while its own preview is open** (checklist 21) sends the text again as a new paid request. *Recommendation:* hide the box's Add while its own preview is open, so "Add all" is the only confirm. I did not do this because it changes what you see and the spec does not settle it.

## Known limits, by design or deferred

- In a desktop browser, which has no on-screen keyboard, focusing the capture field drops the box over the tab bar and the round button until the field loses focus.
- A smart-add request cancelled with Cancel or × is not aborted, so it may still spend credit (spec § 8, "Later").

## Retro and punchlist

- **Worked:** trial-running the whole plan on a throwaway worktree before review. Every RED count and total matched in execution, and plan defects showed up as reviewable findings, not as implementer confusion.
- **Still happened:**
  - The plan's own code had one Important defect: decision 17 wiped edits. A fresh reviewer tracing states found it; neither the DA nor the trial runs did.
  - Three mutant-table rows were stale after the DA amendments. In future, regenerate the tables from the mutant JSON so the two cannot drift.
- **Merge drift:** `main` moved while the branch was being built. Before a whole-branch review, run a `merge-tree` check against `main` as a standard step.
- **Environment:**
  - This session's worktree guard refuses one-line "test && git add && git commit" chains. Implementers ran the gate first, then add and commit as separate commands.
  - A CPU busy-loop repro (`scratchpad/flake/repro.sh`), run by another session, made `drainUntil gives up even when Date is frozen` time out (cancelled) during several gates. Load-sensitive tests are worth a punchlist item.
- **Punchlist candidates:**
  - `apply.test.js` test 209 ("a tick whose render throws… still schedules its sync") waits a fixed 50 ticks for a WebCrypto hash, against CLAUDE.md's "poll, never a fixed tick". It flaked once under load.
  - `.text-row` in `index.html` and `styles.css` now wraps a single input and could be flattened.
  - Aborting a cancelled smart-add request (spec § 8, "Later").

## Where things are

- **Plan, with the DA adjudication and the execution record:** `docs/superpowers/plans/2026-10-26-plaenicke-home-stage4.md`
- **Spec, § 8 stage 4 result:** `docs/superpowers/specs/2026-10-20-plaenicke-home-screen-design.md`
- **Ledger, local only (`.superpowers/` is gitignored):** `.superpowers/sdd/stage4/`. It holds the task reports, the fix and polish briefs, the scripts and the mutant lists.
