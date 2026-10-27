# Sync safety fixes — plan (2026-10-27)

Branch `sync-safety`, base `main` @ f1d97ea. CACHE is not bumped.

## Item 1 — `applySyncedState` half-applied after a storage failure

Verified at f1d97ea (js/app.js 1448-1485): `applyRemoteFeeds(written.feeds)` and
`saveTombstones(written.tombstones)` run bare. If either throws, `items` has already
been saved and assigned, but `feeds`/`feedCache` keep pre-sync values and `render()`
never runs. sync.js catches the throw and records `lastError` from `err.name`
(js/sync.js 274-276 and 359-361); runSync's finally repaints only the sync status, not the page.

Change (app.js only, plus the two `applyState(merged)` call sites in sync.js):

1. `applySyncedState(state, now)`. `now` must be a valid `Date`; anything else throws a
   `TypeError` before any read or write (no `new Date()` default — zero fallback).
   It replaces the `new Date()` passed to `merge()`.
2. sync.js passes its own clock: `applyState(merged, now())` at both call sites
   (main path and CAS retry). In production `now` is `() => new Date()` (app.js 1531),
   so what is merged is unchanged. linkui.js reaches applySyncedState only through
   syncOnce, so it gets the same clock.
3. Order kept exactly: `merge` → `saveItems` → `items = written.items` →
   `try { applyRemoteFeeds; saveTombstones } finally { feeds = loadFeeds(); feedCache = loadFeedCache(); render(); }`
   → `backgroundSyncFeeds(added)` → `return written`. A throw propagates unchanged out
   of the finally, so sync.js still records it. `saveItems` stays outside the try: if
   it throws, nothing was written and nothing in memory changed.
4. `saveAuth` gets the same translation as the other writers:
   `QuotaExceededError` → `QuotaError('Auth code exceeded storage quota')`; any other error
   rethrown unchanged.
5. The 27 direct `applySyncedState(state(...))` calls in tests/apply.test.js gain a
   `new Date()` argument (same clock they had implicitly). The "whatever options it is
   passed" test moves its `{ replace: true }` to a third argument so it still guards
   against a discard option.

Not changed, deliberately: `backgroundSyncFeeds(added)` still runs only on success. On a
throw the newly pulled feed is stored but not fetched until the next load-time /
visibility fetch. Recorded as a known gap in the report, not fixed here (it is a feed-fetch
change, not a data-safety change).

Known edge: if `render()` itself throws inside the finally, that error replaces the
storage error and `lastError` names the render error. Accepted; not observed.

### Tests (written first, seen failing)
- apply.test.js: linked device, Day page for far(0) showing; module feeds empty while the
  feed cache already holds an event on far(0) for feed `ss-pulled`; pulled blob carries
  item `ss-item` on far(0) and feed `ss-pulled`; fake `setItem` throws
  `QuotaExceededError` on `plaenicke.syncTombstones`. After the online trigger:
  `lastError === 'QuotaError'`; reading `#day-body` WITHOUT navigating shows both the
  pulled item and the feed's event. (Navigating would re-render from `items` and hide the
  missing render.)
- apply.test.js: `now` is used: a local tombstone stamped 2020-01-01 with no record, a
  remote item stamped 2020-07-19, `now = 2020-01-11` → the tombstone survives
  (with `new Date()` it would be pruned). And `applySyncedState(state())` with no `now`
  throws TypeError and writes nothing.
- storage.test.js (or the existing storage test file): `saveAuth` with `setItem`
  throwing `QuotaExceededError` throws an error whose `name === 'QuotaError'`; a
  non-quota error is rethrown as-is.

### Mutants (each must fail a named test, then be restored)
- M1 delete the finally's reload+render (bare sequence back) → tombstone-quota test fails.
- M1b keep render() but drop the `feeds`/`feedCache` reload → feed-event assertion fails.
- M2 drop the saveAuth translation → saveAuth test fails.
- M3 `merge(live, state, new Date(), …)` again → `now` test fails.

## Item 2 — `nextStamp` at the maximum Date: BLOCKED, not built

Verified: an edit to a record stamped `+275760-09-13T00:00:00.000Z` is stamped `now` and
merges back to the old copy (scratch reproduction: merged title "old"). But:
- `nextStamp` is also called by `dedupeState` (js/merge.js 400-402), which sync.js runs on
  adoption. Throwing there changes what sync writes (the adoption throws instead of
  writing). The brief says to stop on any such change.
- tests/edit.test.js:437 (sweep F, O1) pins the current behaviour as a deliberate
  decision; the fix inverts it.
- setDone, deleteItem and removeFeed would also change failure behaviour.
Recommendation for Alex in the report.

## Item 3 — doc comment at js/auth.js `isAdoptionPending`
Comment only: callers must check `isLinked()` first (ledger Task 4 contract note: the
cursor-then-credential order can leave adoptionPending true while unlinked).

## Review
- Devil's-advocate on this plan's commit.
- A fresh reviewer per item who runs the tests and the mutants.
