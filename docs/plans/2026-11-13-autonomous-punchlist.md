# Plan — post-V7 punchlist run (2026-11-13, autonomous)

Brief: `.superpowers/sdd/2026-11-13-autonomous/brief.md` (gitignored). Base: main @ a39c6b1. **Nothing merges to main or deploys in this run.**

**Revised after DA (findings: `.superpowers/sdd/2026-11-13-autonomous/da-plan-findings.md`).** Branches: `autonomous-2026-11-13` (T0, T5, T6 docs), `fix-contrast` (T1), `fix-linkui-flake` (T2, only if code changes), `fix-kolkata` (T3, only if code changes), `fix-applied-partial` (T4). Each merges independently; any client change needs a CACHE bump at release. **V7-defect rule:** if any task finds a defect in released V7, stop the punchlist work and put it at the top of the handoff. **Hard agent cap: 13 total** (DA on plan already used 1).

Every code task is test-first (failing test, then the change) and gates on `npm test` showing `# fail 0` AND `# cancelled 0` (CLAUDE.md "Running tests"). Each code task gets a fresh reviewer that **executes** the code (CLAUDE.md "Before you touch sync": reading finds shape errors, running finds real ones).

## T0 — Housekeeping (inline)
- Punchlist: close items whose work shipped, citing work commits plus the release merge — rate-limit rule (Alex's delegated 2026-11-11 decision; V7 gates `/feed` on a session, Phase 3 probe 401; smart add has the 50/day cap, `/feed` has no per-account limit), capture-date-row heading item (capture-date-row merge 468ebf6, released in v6-22 3f5fbfa), sync-safety item 2 (1b6c1fa, 7bf175c; released 3f5fbfa), batch-F speculative list ((a)=1b6c1fa, (b) fe66fee, (c) device-checked 2026-11-07, (d) 06928ea). **Narrow** fixed-wait tests to the remaining fixed waits (apply.test.js:228, :3711 `settle`; sync.test.js:657, :731, :751) — 90b0ab8 converted only the sync PUT/GET waits. Update the Settings-keyboard item (17a1bcc in v6-23; iPhone check owed) and the password-manager item (Alex has one; AT_REST_KEY in it; ADMIN_SECRET not). Add V7's "Not fixed — recorded" items (`.superpowers/sdd/2026-11-11-plaenicke-accounts/sweep-findings.md`) and the range-edge-tests-for-fix-A item. Every closure is listed with evidence in the handoff (the punchlist is outside the repo).
- `docs/admin.md` Phase 2 step 5: the UTC day boundary is 16:00 PST / 17:00 PDT.
- Pin wrangler: `worker/package.json` gets `"wrangler": "npx --yes wrangler@4.161.0"`; docs call `(cd worker && npm run wrangler -- <args>)` in `docs/admin.md`, `CLAUDE.md`, `worker/README.md`. Record 4.161.0 (ran V7, resolved via `npm view`) in admin.md's result log. CLAUDE.md "Deploying" says the pin lives in that one script.
- Success: `git grep -n "npx wrangler" -- docs CLAUDE.md worker/README.md` finds no unpinned call; `npm test` passes.

## T1 — Light-mode contrast on type colours (subagent)
Punchlist: "Light-mode contrast failures on type colours". `--on-type` (#fffdf8 light) measures 3.75:1 on `--type-milestone`, 4.40:1 on `--type-idea`, 4.21:1 / 4.24:1 on calendar colours 5 and 6.
- Failing test first: extend `tests/styles.test.js`'s computed-contrast checks to **every** `--on-type` × type-colour pair and every calendar colour that carries `--on-type` text, in light AND dark, requiring ≥ 4.5:1.
- The test must use the **effective** text colour: any `--on-type` text with opacity (e.g. `.tday-time { opacity: 0.85 }`, styles.css:628) is composited over the background before measuring.
- Then darken only failing light-theme tokens, in **OKLCH lightness** (hue and chroma held), the minimum to clear 4.5:1 for every effective pair. Note these tokens also colour feed events (`js/palette.js`) and tag tints.
- Deliver a before/after preview page (`docs/previews/2026-11-13-contrast.html`, static swatches of each changed token with on-type text, light theme). **Alex's visual approval is required before merge.**
- Success: new test fails on main and passes after; diff limited to `styles.css` tokens, `tests/styles.test.js`, the preview; before/after ratios reported.

## T2 — Intermittent linkui test (subagent)
Punchlist: "Merge: a count that moved while the dialog was open re-asks instead of acting" failed once (`fixture check: the dialog shows one calendar`).
- Context: a fix for this test already shipped (d844ba7, clock mismatch); both observed failures were inside a full `npm test`; the file alone under 8-way load gave 0/24 (2026-10-19).
- Static audit first: what `setup()`/`dialogFixture` awaits before the first fixture check (`tests/linkui.test.js` ~1572–1595); a fixed wait found by reading is evidence.
- Reproduce: loop the **full `npm test`**, and run with a ~3 ms injected encrypt delay (module-captured setTimeout; the proven flusher). Record failure rates.
- If reproduced: find the racing wait, replace it with a deterministic signal (`settleUntil` or an explicit promise). Never loosen the assertion. Show ≥ 200 clean runs after.
- If not reproduced: report run counts and conditions; leave the item open with that data. Do not change code speculatively.

## T3 — Asia/Kolkata 26 vs 21 instances (subagent)
Punchlist: brightspace-shape fixture yields 26 instances in Asia/Kolkata vs 21 elsewhere (`tests/fixtures/expansion-golden.json`).
- Diff the instance lists between Kolkata and another zone; name the extra 5 (uid, start, end, kind).
- Decide each extra: (a) correct under RFC 5545 at +05:30, (b) correct under the app's own multi-day span rules, or (c) a double-emit/span bug.
- `expandEvents` also feeds the Brightspace import (`js/deadlines.js:51`, zone America/Los_Angeles). Any `js/ics.js` change must re-run the mutation checks CLAUDE.md lists for that path (91f162c, 5bac703, 5411fbf, d407816, 65e660e, a0fe768, 6fecb56) and the golden tests; a regenerated golden fixture must state what generated it and explain each changed instance.
- If bug: failing test first, then the fix on branch `fix-kolkata`. If not a bug: the explanation goes to the reviewer too, then into the punchlist.

## T4 — `applied:false` after a partial apply (subagent)
Real defect (`docs/superpowers/reports/2026-10-27-sync-safety-report.md` "Known gaps"): when `applyState` (app.js `applySyncedState`, ~1657–1702) throws **after** writing items (in `applyRemoteFeeds` or `saveTombstones`), `syncOnce` returns `applied:false` and linkui can say "Nothing has been combined yet" while the page shows merged items. `applied = true` is set after `applyState` returns (sync.js:313–316), so a throw before any write is already correct.
- Failing test first: a fake `applyState` that writes then throws must not produce "nothing combined" copy; one that throws before writing must still report not applied.
- Fix: a contract for "did anything get written" between `applyState` and `syncOnce` (e.g. a typed error carrying `partial: true`, or applyState reporting progress); `js/linkui.js` failure copy gets a "saved on this device partway; the server was not updated" variant. `APPLIED_FAILURE_TEXT.error` must not claim the server refused a local failure. Files: `js/sync.js`, `js/app.js`, `js/linkui.js`, tests.
- Per-reader table for `.applied` (linkui.js ~1285, ~1602).
- Required pre-read (gitignored, absolute path): `/Users/ajaenicke25/projects/plaenicke/.superpowers/sdd/2026-08-02-plaenicke-v5-plan3-client-sync/progress.md`.
- Reviewer must run interleavings: partial throw then a later sync succeeds; throw mid-adoption; throw before any write.

## T5 — Notifications design spec + implementation plan (inline, then DA)
From Alex's 2026-11-11 decisions (handoff) and the two reports on unmerged branches (`worktree-agent-affc23db75adec321` spike; `worktree-agent-adff218c12f90165b` research).
- Output: `docs/superpowers/specs/2026-11-13-plaenicke-notifications-design.md` with a decision table and a numbered rulings list for gaps (Alex approves, as with V7 R1–R21), and `docs/superpowers/plans/2026-11-13-plaenicke-notifications.md`.
- Must reconcile with V7 (server cannot read stored data). Required sections: per-account opt-in with disclosure to testers; exactly what is uploaded (own items, feed-event titles — **feed URLs never**), by which device, when; staleness honestly stated and capped (nothing sent from a schedule older than N days); two devices → one writer or a dedupe rule; cleanup on sign-out, account disable/delete, and sign-in to a different account; copy the spike and research facts into the repo (`docs/superpowers/reports/`) so they survive worktree cleanup.
- Gate: DA on the spec (fresh, worktree). No code.

## T6 — Desktop layout options (inline)
`docs/superpowers/specs/2026-11-13-desktop-layout-options.md`: what the desktop view does today (measured with Chrome DevTools at 1280 px and 1440 px), 2–3 options, a recommendation. Taste call stays with Alex. No code.

## End of branch
`jaeger:review-sweep` over the branch diff (small: 2–3 dimensions). Then a handoff.

## Out of scope (with reason)
- iPhone device checks, minting invites, domain purchase, moving ADMIN_SECRET, forced worktree removal — Alex-only (hardware / outward-facing / money / his vault / classifier).
- Smart-add 60 s backstop — blocked on a latency measurement (item's own blocker).
- `js/linkui.js` split (V7 just changed it; before V7's iPhone checks), render fix A and its range-edge tests, the V5 "Minor, verified" bundle, the stage 1–2 leftovers — deferred because the hard agent cap of 13 leaves no room. Recorded on the punchlist with that reason.
- Any merge to main, push of main, or Worker deploy.

## Agent budget
Hard cap 13: DA on plan (1, used), T1–T4 implementers (4), per-task reviewers (4), DA on the notifications spec (1), sweep (2), one spare for a fix round. Over the cap → stop and hand off.
