# Plan — post-V7 punchlist run (2026-11-13, autonomous)

Brief: `.superpowers/sdd/2026-11-13-autonomous/brief.md` (gitignored). Branch `autonomous-2026-11-13` from main @ a39c6b1. **Nothing merges to main or deploys in this run.**

Every code task is test-first (failing test, then the change) and gates on `npm test` showing `# fail 0` AND `# cancelled 0` (CLAUDE.md "Running tests"). Each code task gets a fresh reviewer that **executes** the code (CLAUDE.md "Before you touch sync": reading finds shape errors, running finds real ones).

## T0 — Housekeeping (inline)
- Punchlist: close items whose work shipped, each with its evidence commit — Cloudflare rate-limit rule (V7 requires a session on `/feed` and smart add, per-account 50/day cap; Phase 3 probe returned 401), capture-date-row heading item (468ebf6, 9cb78f9), fixed-wait tests (ae3edf8), sync-safety item 2 (3f5fbfa). Update the Settings-keyboard item (17a1bcc shipped in v6-23; only the iPhone check remains) and the password-manager item (Alex now has one; AT_REST_KEY is in it; ADMIN_SECRET still is not).
- `docs/admin.md` Phase 2 step 5: state that the UTC day boundary is 16:00 Pacific (PST, UTC−8), so both reads and the smart adds must fall on the same side of it.
- Pin wrangler: every `npx wrangler` in `docs/admin.md`, `CLAUDE.md` and `worker/wrangler.toml` comments becomes `npx wrangler@4.161.0` (the version that ran the V7 release). No new dependency: the project has none, and has no lockfile. One line in CLAUDE.md "Deploying" says where the pin lives and how to bump it.
- Success: `git grep -n "npx wrangler " -- docs/admin.md CLAUDE.md` finds no unpinned call; punchlist open count reflects reality; `npm test` passes.

## T1 — Light-mode contrast on type colours (subagent)
Punchlist: "Light-mode contrast failures on type colours". `--on-type` (#fffdf8 light) measures 3.75:1 on `--type-milestone`, 4.40:1 on `--type-idea`, 4.21:1 / 4.24:1 on calendar colours 5 and 6.
- Failing test first: extend `tests/styles.test.js`'s computed-contrast checks to **every** `--on-type` × type-colour pair and every calendar colour that carries `--on-type` text, in light AND dark, requiring ≥ 4.5:1.
- Then darken only the failing light-theme tokens, keeping hue (change lightness only), the minimum needed to clear 4.5:1 with a small margin (≥ 4.6:1). Dark theme unchanged unless the new test shows a dark failure.
- Success: new test fails on main's tokens and passes after; diff touches only `styles.css` token values and `tests/styles.test.js`; report before/after ratio per token.

## T2 — Intermittent linkui test (subagent)
Punchlist: "Merge: a count that moved while the dialog was open re-asks instead of acting" failed once (`fixture check: the dialog shows one calendar`).
- Reproduce: run `node --test tests/linkui.test.js` in a loop (≥ 200 runs, and again under CPU load, e.g. parallel copies) and record the failure rate.
- If reproduced: find the racing wait, replace it with a deterministic signal (`settleUntil` or an explicit promise). Never loosen the assertion. Show ≥ 200 clean runs after.
- If not reproduced: report run counts and conditions; leave the item open with that data. Do not change code speculatively.

## T3 — Asia/Kolkata 26 vs 21 instances (subagent)
Punchlist: brightspace-shape fixture yields 26 instances in Asia/Kolkata vs 21 elsewhere (`tests/fixtures/expansion-golden.json`).
- Diff the instance lists between Kolkata and another zone; name the extra 5 (uid, start, end, kind).
- Decide from RFC 5545 semantics: is each extra a correct consequence of +05:30 (e.g. a UTC event crossing a local midnight) or a double-emit/span bug?
- If bug: failing test first, then the fix in `js/ics.js` (high-risk file: render-perf golden tests must stay green, and any golden-fixture change must be explained instance by instance). If correct: write the explanation into the punchlist item and close it.

## T4 — `applied:false` gap after a failed apply (subagent)
Punchlist: after `applySyncedState` throws, `syncOnce` still reports `applied`. (`js/sync.js` ~219–316.)
- Failing test first: a `syncOnce` whose injected `applyState` throws must not report `applied: true`.
- Fix in `js/sync.js` only. Enumerate every reader of `.applied` (`git grep -n "\.applied\|applied:"`) and state, per reader, what changes in behaviour.
- Reviewer must run the interleavings: apply throws then a later sync succeeds; apply throws mid-adoption.
- Success: test fails before, passes after; no change to merge/wire format; per-reader behaviour table in the report.

## T5 — Notifications design spec + implementation plan (inline, then DA)
From Alex's 2026-11-11 decisions (handoff) and the two reports on unmerged branches (`worktree-agent-affc23db75adec321` spike; `worktree-agent-adff218c12f90165b` research).
- Output: `docs/superpowers/specs/2026-11-13-plaenicke-notifications-design.md` with a decision table and a numbered rulings list for gaps (Alex approves, as with V7 R1–R21), and `docs/superpowers/plans/2026-11-13-plaenicke-notifications.md`.
- Must reconcile with V7: E2E encryption means the Worker cannot read items; Alex accepted plaintext titles on the Worker for notifications, so the spec must say exactly what is stored, by which device, when it is refreshed, and how staleness is bounded.
- Gate: DA on the spec (fresh, worktree). No code.

## T6 — Desktop layout options (inline)
`docs/superpowers/specs/2026-11-13-desktop-layout-options.md`: what the desktop view does today (measured at 1280 px and 1440 px), 2–3 options, a recommendation. Taste call stays with Alex. No code.

## End of branch
`jaeger:review-sweep` over the branch diff (small: 2–3 dimensions). Then a handoff.

## Out of scope (with reason)
- iPhone device checks, minting invites, domain purchase, moving ADMIN_SECRET, forced worktree removal — Alex-only (hardware / outward-facing / money / his vault / classifier).
- Smart-add 60 s backstop — blocked on a latency measurement (item's own blocker).
- `js/linkui.js` split, render fix A (`expandEvents` cost), the V5 "Minor, verified" bundle, the stage 1–2 leftovers, the batch-F speculative list — deferred by priority: each touches files V7 just changed, before V7's iPhone checks have run. Recorded as such.
- Any merge to main, push of main, or Worker deploy.

## Agent budget
DA on this plan (1), T1–T4 implementers (4) and reviewers (4), DA on the notifications spec (1), sweep (2–3). ~12, slightly over the session's ~10 guideline; justified by the per-task independent review the run otherwise lacks.
