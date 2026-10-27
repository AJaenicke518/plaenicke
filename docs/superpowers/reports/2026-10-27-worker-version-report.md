# Worker version marker report (2026-10-27)

Branch `worker-version`, cut from main f1d97ea. Not deployed, wrangler not run, smoke not run.

## What changed
- `worker/src/version.js`: `VERSION = 'worker-2026-10-27.1'`. Choice: a build-time constant bumped by hand (no derived value).
- `worker/src/index.js`: `GET /version` returns 200 `{ version }` with CORS. Non-GET gets 405 (never reaches smart-add). Reads no env, no D1, no fetch. Smart-add logs `smart-add claude_ms=N status=S` (S is the upstream status, or `unreachable`); time is to response headers. A Claude 200 body that fails to parse now returns 502 `unparseable_model_output` in its own try (before, the outer catch logged `err.message`, which quotes a fragment of the body).
- `scripts/smoke-worker.mjs`: `checkVersion` and `runAll`. The version is checked first (free) against `worker/src/version.js` in the checkout; on mismatch no phrase is sent. Edited only, never run.
- Tests: `worker/tests/version.test.js`, additions to `tests/smoke-worker.test.js`.

## Mutants checked (each failed the named tests, then restored)
- route `/version` to smart-add: 3 failures.
- log the user text: 2 failures.
- checkVersion compare disabled: 1 failure.
- runAll runs phrases despite a version mismatch: 1 failure.

## Review (fresh sweep-reviewer, not the implementer)
Fixed after review: runAll ordering test (finding 1), non-200 status test (2), log capture on all console channels (3), claude_ms checked as a duration with a 40 ms stub delay (4), 529 leak check (5), unparseable-body log leak (6), header comment on /version, VERSION-bump limit noted in the smoke header (7 partly).
Not done:
- (7) Nothing enforces bumping VERSION when worker/src changes. If forgotten, the old deploy passes the check. Hand discipline only.
- (8) CLAUDE.md line "the first smoke test after a deploy can hit the old version" is now partly stale. I did not edit CLAUDE.md; the controller should update it at merge.
- The punchlist item for `/version` (outside the worktree) was not checked.
- The final fix commit was not re-reviewed by a second fresh reviewer.

## Gate
`npm test`: 1772 tests, pass 1772, fail 0, cancelled 0.

## Deploy and verify (Alex)
This change touches no client file, so "ship the client before the Worker" has nothing to ship first.
1. Merge the branch to main.
2. `cd worker && npx wrangler deploy` (Alex's call).
3. Wait about 20 s, then the free check: `curl -s <WORKER_URL>/version` must print `{"version":"worker-2026-10-27.1"}` (`WORKER_URL` is in `js/config.js`).
4. Optionally `npm run smoke:worker` (spends credits). It prints `version ... confirmed` first, or `VERSION CHECK FAILED (no Claude calls made)` and exits 1 on a stale edge.
5. Logs: `npx wrangler tail`, then do one smart-add; expect a line `smart-add claude_ms=... status=200`.

Bump `VERSION` in `worker/src/version.js` with every future Worker change.
