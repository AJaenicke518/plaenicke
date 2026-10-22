# Autonomous brief — home screen stage 3 (2026-10-22)

## Authorization (Alex, 2026-10-22, verbatim)

> 1. it should stay struck through until tomorrow. show next to the class. yes the formats are ok. and build with subagents autonomous mode

Answers to the four stage-3 questions in the 2026-10-22 handoff:

1. Ticking an overdue item on Today → **stays struck through until tomorrow** (overrides spec § 2.3 "A ticked overdue item leaves Overdue").
2. A "no class" one-off on a class day → **shows next to the class** (the plan already does this).
3. Display formats ("142d"; "Tomorrow" / "Thu" / "Thu, Oct 29"; "in 2 h"; checkboxes only in Overdue and To do today; "All day") → **approved as is**.
4. Build approach → **subagent-driven, autonomous mode**.

## What is authorized

Execute `docs/superpowers/plans/2026-10-21-plaenicke-home-stage3.md` with superpowers:subagent-driven-development: one implementer subagent per task, a fresh reviewer subagent per finished task, then a devil's-advocate review of the plan before any of it and `jaeger:review-sweep` at the end.

## What is NOT authorized (committed assumptions)

- **No merge to `main`.** CLAUDE.md: "merging to `main` IS the deploy." The plan's Tasks 10 and 13 say "REQUIRES ALEX'S EXPLICIT GO-AHEAD"; "autonomous mode" does not name a release. Both gates stop the run's release work and go to the punchlist as `[AUTONOMOUS-BLOCKED]`.
- **No `git push`.** Global constraint in the plan: "No merge to `main` and no push without Alex's explicit go-ahead." Commits stay local on the branches. (`home-screen-design` @ cf07890 is already on origin; the new commits are not pushed.)
- **No Worker deploy, no `npm run smoke:worker`** (spends Anthropic credits). Stage 3 touches no Worker code.
- **Task 14 (record that List stays) is not done.** It needs Alex's words after he has used Today.

## Committed decisions for the run

- **Overdue tick rule (assumption A).** An item has no "when ticked" field, and the spec forbids new item fields (§ 6). A done to-do whose date has passed stays in Overdue, struck through, **while its `updatedAt` falls on today's local date** (`toISO(new Date(updatedAt)) === todayISO`). `handleToggleDone` bumps `updatedAt` on every tick, so this is "ticked today". Known cost: any other write to a done overdue item (a note edit in Calendar, on any device) also brings it back, struck, for the rest of that local day. It cannot hide an undone overdue item. A missing or unreadable `updatedAt` → not shown (it cannot be shown as "ticked today" without evidence).
- **Order in Overdue:** undone rows oldest first, then ticked rows (oldest first): the same "done last" rule as To do today. A ticked row keeps its age and colour, struck through.
- **Branch layout (assumption B).** Tasks 1–9 (3a + 3b) on `home-screen-design`. The run then stops at Task 10 (release gate). Tasks 11–12 (3c) go on a new branch `home-screen-3c` cut from the Task-9 commit, so 3a+3b can be released by merging `home-screen-design` alone, and 3c's work is ready for Alex's 3b phone check without being tangled into it. Task 13 (release 3c) is blocked the same way.
- **Where subagents work (DA I5).** Implementers and reviewers work in the main checkout `/Users/ajaenicke25/projects/plaenicke` on the named branch — never `isolation: "worktree"` (those worktrees are cut from `main`, without the plan or earlier tasks). Reviewers get the base and head SHAs and confirm `git rev-parse HEAD` before reviewing. The controller cuts `home-screen-3c` in the main checkout.
- **Task 13 ships from `home-screen-3c`** after merging `main` (with Task 10's v6-9) into it; the plan's Task 13 carries the branch amendment.
- The baseline in the plan is HEAD 94dec6a with 1345 tests; the branch is now at cf07890 (two docs-only commits on top). Test counts in the plan should still hold; a mismatch is investigated, not papered over.

## Done means

- Tasks 1–9 committed on `home-screen-design`, each gated on `# fail 0` AND `# cancelled 0`, each mutation-checked, each reviewed by a fresh subagent.
- Tasks 11–12 committed on `home-screen-3c`, the same way.
- A review sweep over both branches, with every finding adjudicated.
- Tasks 10, 13, 14 recorded as waiting for Alex, with what he must check on the phone.
- A handoff written.
