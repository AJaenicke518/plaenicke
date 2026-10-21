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

## Adjudication of the devil's-advocate review (2026-10-20) — these OVERRIDE the task text above

No Criticals.

- **I1 APPLY.** Task 1: on 413 / non-ok, read the body (`await res.text().catch(() => {})`) before throwing so fetchWithTimeout disarms. Criterion: 413 and 500 paths leave no armed timer (tick the budget, signal not aborted). `parseViaWorker` has NO tests today — add tests for success, 413 → `too_long`, 500 → `server`, hang → `unreachable`.
- **I2 APPLY (constant) / DEFER (cancel).** New `SMART_ADD_TIMEOUT_MS = 60000` exported from js/smartadd.js (decoupled from FETCH_TIMEOUT_MS; same value as a backstop because there is no latency data and max_tokens 4096 allows long legitimate replies). Pass it to fetchWithTimeout (check its signature; if it takes no budget argument, add an optional one without changing existing callers). Cancel button DEFERRED — blocker: capture UI is being redesigned in the home-screen proposal awaiting Alex's approval; added there.
- **I3 APPLY.** handleAdd gets a generation counter: a smart-add result or error that is not from the latest request is dropped (no setMessage, no addItems/preview). Test: request 1 hangs, a manual add shows "Added.", request 1 then times out → message stays "Added."; and two smart adds resolving out of order → only the latest applies.
- **I4 APPLY.** Task 2's real consequence: memory shows synced records storage doesn't hold, a render shows records a reload removes, and the next local write persists them outside the sync path. Not data loss. Title narrowed: "applySyncedState assigns items only after they are saved".
- **I5 APPLY.** Task 2 test: make setItem throw for plaenicke.items during the sync; RESTORE setItem; do a follow-up `addItems`; assert `loadItems()` has no unsaved synced record and the visible list doesn't show it; use installManualTimers (addItems arms scheduleSync); run the whole apply.test.js file; add a second test for the 409-retry apply failing.
- **I6 APPLY.** Task 3: drop the propagation retry and its claim; each phrase runs once. A Worker `GET /version` marker would let a smoke check confirm the deploy — needs a Worker deploy → punchlist.
- **I7 APPLY.** Task 3 assertions: type survives normalize (not coerced to 'event'); event phrase asserts time (e.g. "at 2pm" → "14:00"); idea phrase asserts type 'idea' and date === today (not verbatim notes). Phrases taken from prompt.js's own examples on the unambiguous side; one phrase per ITEM_TYPE including `start`; a boundary phrase may accept a set of types.
- **I8 APPLY.** Task 3: pure parts importable with no side effects; entry guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`; the new test file installs an offline fetch at the top; criterion "importing the script under npm test makes zero fetches"; header comment warns that renaming to test-*.mjs or moving under test/ would make npm test run it; CLAUDE.md Running-tests gets one line about scripts/.
- **O1 APPLY** (body-stall `timeout` error is mapped to `unreachable` too, or described accurately — wrap res.json()). **O2 APPLY** (update fetchtimeout.js header: it is shared by feeds, Settings, sync reads and smart add). **O3 noted.** **O4**: title narrowed (I4); the feeds/tombstones half → punchlist. **O5 APPLY** (assert response Access-Control-Allow-Origin === https://ajaenicke518.github.io instead of sending Origin for effect). **O6 APPLY** (commit message says the script has never run against production). **O7 APPLY** (every task's fresh reviewer executes tests and mutation-checks).
