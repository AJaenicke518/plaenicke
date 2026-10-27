# Sync safety — lead report (2026-10-27)

Branch `sync-safety`, base `main` @ f1d97ea. CACHE not bumped.
Commits: 845fa6c plan · 7d393af item 1 · 8e3752d item 3 · this report.
Gate at 8e3752d: `npm test` → tests 1763, pass 1763, fail 0, cancelled 0.

## Item 1 — applySyncedState half-applied after a storage failure (BUILT, 7d393af)

Claim verified at f1d97ea: applyRemoteFeeds and saveTombstones ran bare after
`items` was saved and assigned. A throw left `feeds` and `feedCache` stale and skipped `render()`.

Change:
- `try { applyRemoteFeeds; saveTombstones } finally { reload feeds and feedCache; render() }`,
  then rethrow. The write order is unchanged (merge, saveItems, assign, applyRemoteFeeds,
  saveTombstones).
- `applySyncedState(state, now)`. `now` must be a valid Date, else a TypeError before any
  read or write. There is no default.
- sync.js passes `now()` at both applyState call sites. In production that is the same
  `new Date()` clock.
- `saveAuth` translates QuotaExceededError to QuotaError and rethrows anything else unchanged.
- In tests/apply.test.js, the 27 existing one-argument calls gain `new Date()`. The
  "whatever options" test moves `{ replace: true }` to the third argument.

Tests, each seen failing before the fix:
- Quota on the tombstones key, refused once: lastError is QuotaError, nothing is pushed,
  and the Day page shows the pulled item and the pulled feed's event without navigating.
- The injected clock decides the prune.
- An invalid or missing clock throws and writes nothing.
- saveAuth throws QuotaError on a quota failure and rethrows a non-quota error unchanged.

Mutants (lead-run, restored, tree verified clean):

| Mutant | Fails |
|---|---|
| M1: finally reload and render removed | the tombstone-quota test |
| M1b: render kept, feeds reload dropped | the quota test and 4 existing feed-fetch tests |
| M2: no saveAuth translation | the saveAuth test |
| M3: `new Date()` in merge | the clock test |

Under M1, which runs the same code paths as the original, "wiring: addItems schedules a
debounced sync" also failed once. On clean source apply.test.js then passed 3 of 3 runs.
I am treating it as a possible flake, not yet explained.

Known gaps, not fixed (out of scope):
- After a throw, sync.js still returns `applied:false`. linkui.js can then say "Nothing has
  been combined yet" while the page shows the merged items. This was already in the V5
  ledger as a lone finding, and the fix makes it visible. Fixing it changes syncOnce's
  status semantics, so it needs its own review.
- A newly pulled feed is fetched only on success. After a throw it waits for the next
  load-time or visibility fetch.
- If `render()` throws inside the finally, its error replaces the storage error in lastError.

DA review (opus, on 845fa6c): 0 Critical, 2 Important, 2 Minor.
- Applied: the fake now refuses only once, so lastError can come only from the tombstones write.
- Recorded: the `applied:false` gap above.
- Minor, noted: the saveAuth translation changes the link-error text in linkui.js:718.
  Nothing matches on that text.

Independent run-the-code review of 7d393af (opus, fresh): **CLEAN**, 0 Critical / 0 Important.
- 14 mutants, full `npm test` each, tree verified clean after each. 12 killed. Survivors:
  dropping only the feedCache reload (not observable: render reads the cache only for feeds
  in `feeds`, same gap as before), and sync.js passing `new Date()` instead of `now()`
  (identical in production).
- Differential against 845fa6c under a fixed clock, driving the real syncOnce and
  applySyncedState: success path and 409-retry path byte-identical (result, written state,
  decrypted PUT bodies, all stored keys, screen). Three failure cases (tombstones write,
  addTombstone inside removeFeed, feeds write): stored keys and lastError identical; only the
  screen differs, and the new code shows what storage holds. **Sync writes and merges are unchanged.**
- The flake did not reproduce in 76 runs (serial and parallel). The new tests run after
  #70 and cannot cause it. Suspect: drainUntil's 2 s limit under load (unconfirmed).

## Item 2 — nextStamp at the maximum Date (BLOCKED, not built)

Verified by running it: an edit to a record stamped `+275760-09-13T00:00:00.000Z` is stamped
`now` and merges back to the old copy. The triage's fix (nextStamp throws) trips the
brief's stop condition:
- `dedupeState` (js/merge.js:400-402) calls nextStamp, and sync.js:254 runs it on
  adopt-merge. The reviewer reproduced two colliding records, both stamped at the maximum
  date. The dropped one reaches nextStamp, so a throw would make the adoption fail. Today it
  writes a tombstone that does nothing.
- tests/edit.test.js:437 (sweep F, O1) pins the current return-now behaviour as a
  deliberate decision.

**Question for Alex. Recommendation (concrete):** leave merge.js's nextStamp alone. Add a
strict user-write stamp in js/edit.js that throws a named error when the result is not
strictly later than a parseable prev. Use it only at app.js:525 (deleteItem), 581
(setDone), 639 (editItem) and feeds.js:772 (removeFeed), each surfacing the error through
its existing failure path. Sync and dedupe stay unchanged, and the sweep-F test stays as
it is. Urgency is low: such a stamp can only come from corrupt data or a device clock set
to year 275760.

## Item 3 — isAdoptionPending comment (BUILT, 8e3752d)

Comment-only. A fresh reviewer (sonnet) reproduced the state it describes: with a quota
failure on saveAuth, isLinked() is false and isAdoptionPending() is true. The reviewer also
confirmed that all 5 callers (sync.js:208/211, app.js:1514, linkui.js:1218/1242) check
the link first. Reviewed, and safe to release.

## Status for release
- Item 3: reviewed, safe.
- Item 1: reviewed (DA + independent run-the-code review, clean), gated. Safe to release.
- Item 2: blocked on Alex.

## Retro
- Friction: worktree isolation refused compound shell commands (`cd && heredoc`,
  `cd && grep | ...`). Writing a script file and running it with one plain command worked
  every time.
- Paren-matching rewrites of 27 call sites needed a guard so my own new two-argument calls
  were not rewritten. I caught that before running the script.
