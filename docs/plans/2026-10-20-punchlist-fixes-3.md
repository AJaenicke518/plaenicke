# Plan — punchlist fixes 3 (autonomous run, 2026-10-20)

Branch `punchlist-fixes-3` from main 8b4e819. Not released: merging to main is a production deploy and was not authorized for this run.

## Task 1 — smart add gives up instead of hanging

**Problem.** `js/smartadd.js` `parseViaWorker` calls bare `fetch(WORKER_URL, …)`. A Worker that never answers leaves the add box on "Thinking…" forever (code audit 2026-10-20).

**Change.** Use `fetchWithTimeout` from `js/fetchtimeout.js` (already shared by app.js and settings.js). A timeout or any fetch rejection throws `Error('unreachable')` exactly as a network failure does today, so app.js's existing message ("Smart add is unavailable — pick a date below and tap Add to add it manually.") and manual-add fallback apply unchanged.

**Success criteria.**
- New test: a fetch that never settles → `parseViaWorker` rejects with `unreachable` after the timeout (mock timers; no real network — keep apply.test.js's offline guard pattern if the test lives there).
- Existing 413 / non-ok / success behaviour unchanged (existing tests green; add one if a path is unpinned).
- Mutation: bare `fetch` again → new test fails.
- If the shared timeout is 60 s and that is too long for an interactive add, STOP and report the number rather than inventing a second constant — the length is a product call.

## Task 2 — a failed sync save never leaves memory ahead of storage

**Problem.** `js/app.js` `applySyncedState` does `items = written.items; saveItems(items);`. If `saveItems` throws (QuotaError), the module-scope `items` already holds the synced state that storage does not, and the next successful save of ANY item writes it. `addItems` already rolls back for exactly this reason (its comment explains). HIGH-risk file (sync apply path).

**Change.** Assign the module-scope `items` only after `saveItems` succeeds (save the new array first, then assign), matching `addItems`. Do not reorder the three writes (`saveItems` → `applyRemoteFeeds` → `saveTombstones`) — CLAUDE.md and the comment at that site explain why the order is load-bearing.

**Success criteria.**
- New test: a sync whose items write throws QuotaExceededError → afterwards, a local add (or any write) does NOT persist the synced records that failed to save; in-memory items equal stored items.
- Existing quota-through-sync test (4c92dea) and all apply tests stay green; `lastError === 'QuotaError'` still reached.
- Mutation: assign before save again → new test fails.
- Fresh reviewer must execute the test, not read it.

## Task 3 — a smoke check for the deployed Worker (written, NOT run)

**Problem.** Model behaviour has no offline test (punchlist "Model behaviour has no offline test"), and the first check after a deploy can hit the old version for ~20 s (punchlist "deploy tooling").

**Change.** `scripts/smoke-worker.mjs` + `npm run smoke:worker`. POSTs a fixed phrase set to the Worker's `POST /` with the app's Origin header and asserts `type` (and for the idea phrase, that `notes` contains the full sentence). Retries the first phrase up to ~25 s to cover edge propagation, then runs the rest once. Prints a pass/fail table; exits non-zero on any failure. Phrase set: one each for event (with time), due, task, idea (long sentence), milestone — taken from the shapes in `worker/src/prompt.js`'s instructions.

**Success criteria.**
- Unit test the script's pure parts (phrase table → expectations; result checker; retry loop with an injected fetch and clock). No real network in tests.
- **Not executed against production in this run**: each call spends Anthropic credits, which this run is not authorized to spend. Logged [AUTONOMOUS-BLOCKED] for Alex: run it once after the next deploy.

## Out of scope
- Anything in the home-screen design (separate branch, not approved).
- createdAt full timestamps, unionById non-string ids, the linkui split, memoising feed expansion — each needs a decision or overlaps the redesign.
- Any release, deploy, or metered call.

## Process
Subagent-driven: one implementer per task in this worktree (`.claude/worktrees/punchlist-3`), sequential (Task 2 and 1 share no files, but one checkout), fresh reviewer per completed task that executes the tests and mutation-checks. Full suite `# fail 0` before each commit.
