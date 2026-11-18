# Autonomous build — 2026-11-17

Brief: `.superpowers/sdd/2026-11-17-autonomous/brief.md`.
Spec for the N tasks: `docs/superpowers/specs/2026-11-13-plaenicke-notifications-design.md` (rev 5, approved). It reaches main in M1.

**Gate on every commit:** `npm test` shows the exact strings `# fail 0` **and** `# cancelled 0`.

**Every code task:**
- test-first: the named first test is written and seen failing before any implementation;
- a fresh reviewer subagent then runs the code and mutation-checks the tests.

## M1 — Release the four reviewed branches (inline, orchestrator)
- **Merge into `main`**, one `--no-ff` commit each: `fix-linkui-flake`, `fix-applied-partial`, `fix-contrast`, `autonomous-2026-11-13`.
  - Already checked: all four merge cleanly together, and the combined tree passed 2413/2413 earlier today.
- **Release commit:**
  - `service-worker.js` `CACHE` `plaenicke-v7-0` → `plaenicke-v7-1`;
  - `tests/serviceworker.test.js:48` `CACHE_ON_MAIN` `plaenicke-v6-23` → `plaenicke-v7-0` (the pin was stale);
  - first, confirm the test asserts CACHE differs from `CACHE_ON_MAIN`.
- **Gate**, then `git push origin main`. This is the deploy: GitHub Pages serves main.
- **Verify:** after propagation, fetch the live `service-worker.js` and confirm `plaenicke-v7-1`.
- **Success:** origin/main contains the four merges plus the release commit; the live service worker reads v7-1; the suite passes.
- **Out of scope:** any Worker change or deploy. None of these branches touches `worker/src` (only `worker/package.json` pins wrangler).

## D1 — Desktop layout option A (subagent; branch `desktop-a` from the new main; not merged)
- **Goal:** spec `docs/superpowers/specs/2026-11-13-desktop-layout-options.md` option A. CSS only, one `@media (min-width: 900px)` block in `styles.css`:
  - views, header, capture box and tab-bar buttons sit in a centred column, `max-width: 44rem; margin-inline: auto`;
  - the Calendar view switch becomes a compact control;
  - Week and Month views stay full width.
- **First failing test:** in `tests/styles.test.js`, parsing CSS the way that file already does (comments stripped, winning declaration), "a `min-width: 900px` media block gives the Today view `max-width: 44rem` and `margin-inline: auto`".
- **Then tests:**
  - each centred selector;
  - Week and Month are not constrained;
  - no rule outside the media block changes, so the phone layout is untouched.
- **Evidence:** screenshots at 1280×800 and 390×844 through Chrome DevTools against a local static server, attached to the review. At 390 px, computed widths must equal main's.
- **Out of scope:** option B, JS changes, colour changes.

## N0 — P0.3 real-device push materials (subagent; branch `notif-p03`)
- **The three files:**
  - `docs/superpowers/reports/spike-webpush/spike-webpush-keygen.mjs`: prints a VAPID P-256 key pair as a JWK, plus the raw public key in base64url;
  - `spike-push.html` at the repo root: a throwaway page that, opened inside the installed home-screen app, subscribes through `navigator.serviceWorker.ready` → `pushManager.subscribe` (public key pasted in a field) and shows the subscription JSON to copy;
  - `docs/superpowers/reports/spike-webpush/spike-webpush-send.mjs`: takes the subscription JSON and the private JWK, and sends one declarative push using `spike-webpush-lib.mjs`, with VAPID `sub` = the app URL.
- **Not a test file:** none of the names may match node's test patterns.
- **A runbook section** in `docs/admin.md` with the exact steps for Alex.
- **Deploying `spike-push.html` is Alex's call** (it would be a merge to main). Flagged, not done.
- **Test:** a node:test that runs the send script's request builder against a local HTTP server and checks the headers (`TTL`, `Content-Encoding: aes128gcm`, VAPID `Authorization`). The body is decrypted with the subscription's private key using the existing vector approach.

## N1 — T1 `worker/src/webpush.js` (subagent; branch `notif-t1`)
- **What:** port the spike library to production code: VAPID JWT (ES256) and RFC 8291 aes128gcm, WebCrypto only.
- **First failing test:** `worker/tests/webpush.test.js`, the RFC 8291 Appendix A vector, byte for byte.
- **Then:**
  - an independent decrypt with node:crypto;
  - a VAPID JWT that verifies with the public key, with the right `aud`/`exp`/`sub`;
  - two mutations, the delimiter byte and the info string, each turn a test red.

## N2 — T2 migration `0003_notifications.sql` (subagent; branch `notif-t2`)
- **What:** the three tables and the index exactly as spec § 4.
- **First failing test:** in `worker/tests/migration.test.js` style, "after migrating, `notify_prefs` has `items_format`, `feeds_format`, `feeds_seq`, `snap_rev`".
- **Then:**
  - every § 4 column with its type and default;
  - `UNIQUE(endpoint)` refuses a second account's row;
  - the `notify_sent` primary key;
  - every existing Worker test still passes (fake-d1 auto-loads migrations).

## N3 — T3 `worker/src/schedule.js`: `dueMessages` and `nextFire` (subagent; branch `notif-t3`)
- **Pure functions**, no I/O.
- **Interface:**
  - `dueMessages(prefs, items, feeds, sent, now)` → `[{kind, slot, fireAt, windowEnd, title, body}]`, most urgent first;
  - `nextFire(prefs, items, feeds, sent, now)` → epoch ms or null;
  - `prefs` = `{tz, morning_at, nudge_at, items_through, feeds_through, feeds_tz, items_format, feeds_format}`;
  - `items`/`feeds` = arrays of spec D2 entries, or null for a missing half;
  - `sent` = rows `{kind, slot, claimed_at, window_end, sent_at}`.
- **Rules:** spec § 5.3 exactly.
- **First failing test:** "a day past `items_through` gets no summary".
- **Then:** the plan's T3 list in full:
  - **Coverage and leases:** coverage (NULL half, `feeds_tz` ≠ `tz`, unsupported format); live lease not due, but `nextFire` includes lease expiry within `window_end`.
  - **Summaries:** the empty-day wording; "continues" from `endDate`; line caps; title cut.
  - **Event reminders:** a midnight-split occurrence reminds once; a 3-day timed event reminds at its start; an event moved later is reminded again.
  - **Exclusions:** recurring and done items are excluded.
  - **Deadlines (N20):** the 00:00 Friday deadline is nudged Thursday; a passed deadline is dropped from the summary.
  - **Time:** DST forward, back and ambiguous in America/Los_Angeles; an event starting at 02:30 on a spring-forward day starts at 03:00; window expiry; invalid tz throws.
  - **Order:** most urgent first.
- **Not in scope:** sealing, D1, HTTP, sending.

## N4 — T7c step 1: pin current ics/deadline output (subagent; branch `notif-t7c-pin`)
- **Tests only, no production change.**
  - `tests/deadlines.test.js`: a midnight-crossing, a 3+-day timed and a range-clipped trackable event, each asserting `deriveDeadlines`'s exact `{uid, title, date, time}` today.
  - `tests/ics.test.js`: `expandEvents` `date`/`time`/`endTime` and order for the same events.
- **First:** each new test must pass on the current code. Then mutation-check it by temporarily breaking the split branch at `js/ics.js:1209–1214`; it must turn red, then be restored.
- **Success:** the pins are committed green; `js/` is unchanged.

## Integration
- **N branches:** N0–N4 merge into `notifications` (from the new main). Each implementer works in its own worktree; the files don't overlap.
- **Desktop A:** stays on `desktop-a`.
- **End of branch:** `jaeger:review-sweep` on `notifications` (from main) and on `desktop-a`.
- **Then a handoff.**

## Out of scope for this run
- Worker deploy, D1 migration, T4/T5 and later.
- Domain purchase, tester invites (punchlist `[AUTONOMOUS-BLOCKED]`).
- Alex's device checks.
