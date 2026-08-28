# plaenicke V6 — To-dos, Ideas, and the Day-view Reorder

**Date:** 2026-08-20 (revised 2026-08-21 after Alex's review; revised again 2026-08-22 after adversarial + constructive review)
**Status:** Approved. Design questions all answered (§ 11); the second revision changed the *mechanism*, not the shape.
**Owner:** Alexander Jaenicke
**Baseline:** `main` at `83b1774`.

> **What the 2026-08-22 review changed.** The previous draft made `date` nullable for ideas. Two independent reviews rejected that, and one found that the draft's own prescribed fix for `dedupeState` would have **tombstoned every idea on the account** — strictly worse than the bug it cured, which is the V5 ledger's most-repeated failure shape. `date` is now never null. § 13 records what was verified by execution and what changed.

## 1. Goal

Three changes:

1. **Day view** shows the untimed block *above* the hour grid, not below it.
2. **To-do page** — a fifth view listing actionable items that are not done.
3. **Ideas page** — a sixth view for notes-to-self with no scheduled date.

The unifying constraint: **do this without re-deriving sync correctness.** V5's client sync took ten tasks and roughly forty-five defects to establish, nine of them found in the plan's own prescribed code *after* adversarial review had cleared it. Every decision below is made to keep the merge function, the tombstone kinds, `schemaVersion`, and the deploy sequence untouched.

**Non-goals:** AI summarisation of long ideas (§ 10); recurring to-dos; reminders; to-do ordering or priority; any change to `merge()`'s protocol, the CAS loop, the Worker's data routes, the D1 schema, or the crypto.

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Record shape | **Everything stays an `item`** | Separate `todos`/`ideas` arrays mean new `merge()` branches, new `toWire()` entries, new tombstone kinds and new convergence coverage — all load-bearing sync code, for zero user-visible benefit. |
| `schemaVersion` | **Stays 1** | See § 3.2, and note the corrected reasoning there — the usual justification for this is false. |
| New `type` values | `task`, `idea` | Joins `due`, `start`, `milestone`, `event`, `general`. |
| New item fields | `done` (boolean), `notes` (string or null) | Fields, not arrays. They ride through an old device untouched (§ 3.2). |
| **Unscheduled records** | **`date` is NEVER null. An idea carries its capture date, and `type === 'idea'` is the discriminator.** | This is the reversal. See § 3.4 — it removes five of six break points and the entire multi-step rollout gate. |
| Who decides an item is a to-do | **The smart-add model, via `type`** | Alex captures by voice, so the model classifies and no new UI is needed. |
| Smart-add | **Prompt + enum edit only** | With no nullable date, the Worker's response schema keeps `date` as required `string`. Only the `type` enum and the instructions change. |

## 3. Data model

### 3.1 The item record after V6

```js
{
  id, title, date, time, endTime, createdAt, updatedAt,
  type,      // 'general' | 'due' | 'start' | 'milestone' | 'event' | 'task' | 'idea'
  project, subject, category,
  done,      // NEW — boolean. Absent on pre-V6 records; read as `it.done === true`.
  notes,     // NEW — string or null. Absent on pre-V6 records; read as null.
}
```

`date` is **always** a `YYYY-MM-DD` string, as it is today. For an idea it is the capture date and is never displayed.

### 3.2 Why adding fields is safe — and the usual reason for keeping `schemaVersion` at 1 is wrong

**Verified:** `deserializeItems` (`js/storage.js:27-37`) filters, then maps each surviving record to *itself*. It does not rebuild from a whitelist. `unionById` (`js/merge.js:39-48`) sets whole records into a Map without inspecting fields. So `done` and `notes` genuinely survive a round trip through a device running old code.

**But `makeItem` (`js/items.js:17-29`) IS a whitelist rebuilder.** It returns an object literal with eleven fixed keys. Passing `notes` into it today returns a record with no `notes`. This was missed by the previous draft and would have shipped ideas with their body text silently discarded at creation. `makeItem` must carry `done` and `notes`.

**The correction to the `schemaVersion` argument.** Earlier drafts (and CLAUDE.md) said a new array is dangerous because "an un-updated device merges while ignoring it and pushes the data back missing." That is only true if you add the array *without* bumping the version. If you bump it, `requireKnownVersion` (`js/merge.js:31-35`) **throws**, `syncOnce` applies nothing and pushes nothing, and the device surfaces an error. A version bump is a loud, non-destructive halt — the codebase's own fail-closed idiom.

`schemaVersion` still stays 1, but for the honest reason: the cost is *code surface* in the sync layer, not data loss. The next person must not reason from the false premise.

### 3.3 Which page shows which item

**The pages overlap by design.** A dated to-do appears on the calendar views *and* on the To-do page. In Alex's words: if it has a date it always goes on the calendar, and if it is also something that needs doing it goes on the to-do list as well.

| Page | Predicate |
|---|---|
| List / Month / Week / Day | `isScheduled(it)` — i.e. `it.type !== 'idea'` |
| To-do | `type ∈ {due, start, milestone, task}` **and** `it.done !== true` |
| Ideas | `type === 'idea'` |

A completed to-do leaves the To-do page but **stays on the calendar** — it still happened that day. Style it as completed; `itemTypeClass` (`js/calendar.js:53`) is the documented home for that class rule and this is the only V6 change that lands there.

The To-do and Ideas pages read `items` directly, **not** `visibleItems()` — external feed instances carry no `type`, so they would fail the predicates by accident rather than by design.

**Accepted gap:** manual add hard-codes `type: 'general'` (`js/app.js:143`), which is not on the To-do predicate. Manual add is the offline fallback, used only when Alex picks a date himself. Rejected alternatives: a control on the add box (unnecessary given voice), and treating every `general` item as a to-do (would put birthdays on the to-do list).

### 3.4 Why `date` is never null

An idea's `date` is the day it was captured — the same `toISO(new Date())` value `addItems` already writes to `createdAt`. `type === 'idea'` is what marks it unscheduled, exported from `items.js` as:

```js
export function isScheduled(it) { return it.type !== 'idea'; }
```

This works because under § 8, **`idea` is the only unscheduled record kind that exists** — the model resolves a real date for every `task`. A second "is it scheduled" signal would be redundant with `type`.

What this buys, against the previous draft's own list of break points:

| Break point | Under `date: null` | Under capture-date |
|---|---|---|
| `deserializeItems` drops the record | **Silent loss** | Avoided — `date` is a string |
| `sortItemsByDate` is not a strict weak ordering | Broken (verified) | Avoided — no null reaches it |
| `groupItemsByDate` buckets under `"null"` | Accidentally correct | One explicit filter in `visibleItems()` |
| `dedupeState` collapses same-titled ideas | Any two ideas sharing a title | Narrowed to same title *and* same capture day — still fixed (§ 6.1) |
| `makeItem` throws `'Date is required'` | Must be relaxed | Avoided |
| `renderList` prints `"null — …"` | Reachable (verified) | Avoided |
| **The whole staged rollout gate** | Required, human-executed | **Dissolved** |

The decisive argument is what happens on a device running old code. Under nulls, it silently drops the record. Under a capture date, it keeps the idea and merely renders it on the calendar on its capture day — **ugly, never destructive.** Given that no part of this sync has ever run against a real browser or real D1, deleting a correctness gate that a non-programmer has to execute correctly across two devices is worth more than the semantic tidiness of a null.

**The honest cost:** `date` on an idea means "captured on", not "happens on". That is contained by `isScheduled()` and a comment on `makeItem`. The real debt is that unscheduled-ness is not composable — a genuinely undated *task* would need real nulls. § 8 forecloses that for V6.

**Ship the tolerance anyway.** Relax `deserializeItems` to `it.date === null || typeof it.date === 'string'` in V6 as **deliberate dead code**, with no record relying on it. Then a future version can adopt real nulls with the tolerance already provably deployed on both devices, instead of gating a user-visible feature on a rollout executed by hand. The relaxed predicate must still *reject* `undefined`, numbers and objects.

**Watch the empty string.** `''` passes `typeof x === 'string'`, is falsy, and is exactly what a cleared `<input type="date">` yields (`js/preview.js:25`). It is a third state that behaves like neither. `makeItem` must keep rejecting it — the guard is `if (!fields.date) throw`, which is correct today and must not be loosened to a null check.

## 4. Change 1 — day view reorder

`js/dayview.js:61-88` builds the "Other tasks" block and appends it *after* `container.appendChild(grid)` at line 58. Append it before the grid instead.

**One ordering trap:** line 59 sets `grid.scrollTop`, which only takes effect once `grid` is in the document. Keep `container.appendChild(grid)` and the `grid.scrollTop` assignment adjacent, and after both appends.

No data-model or sync surface. Genuinely a few lines.

## 5. Change 2 — the To-do page

`index.html:48-53` is a four-button `.view-toggle`; `index.html:55-84` is four `<section>`s toggled by `hidden`. `showView()` (`js/app.js:359-365`) drives both from two parallel object literals. Adding entries to each is the whole mechanism.

- Each row gets a checkbox that sets `done`.
- Rows show the date.
- Ordering: by date ascending, then `createdAt`.
- **No add box.** To-dos are captured by voice through the main entry box (§ 3.3).

**Where the write lands.** CLAUDE.md's ownership invariant: `app.js` owns `plaenicke.items` and writes from its module-scope snapshot. The checkbox handler must mutate the record inside that array, then `saveItems(items)`, `render()`, `scheduleSync()` — the same shape as `deleteItem`. A writer anywhere else fails silently.

### 5.1 The checkbox is the first edit path, and it can resurrect a deleted item

`js/merge.js:10-15` says per-record last-write-wins is tolerable **only** because the app has no edit path: "app.js adds and deletes, nothing rewrites a record… Anyone adding an edit feature must revisit this before shipping it." The checkbox is that feature. Both reviews independently found the same consequence, and it is not the one the previous draft analysed.

**The previous draft's argument was wrong.** It reasoned that because `done` is a boolean, a race is self-correcting. That is about which *value* wins. It never asked what bumping `updatedAt` does. Both answers are load-bearing:

- **If the toggle does not bump `updatedAt`:** `unionById` ties go to remote (`>=`, line 45), so the tick is silently reverted on the next sync. Self-*reverting*, not self-correcting. Verified.
- **If the toggle does bump `updatedAt`:** `applyTombstones` (`js/merge.js:99-101`) keeps any record whose `updatedAt` is at or after the deletion, on the documented assumption that a later `updatedAt` means "re-created after the deletion". With an edit path that assumption is false. Verified: item deleted on the laptop at 09:00, ticked on the phone at 12:00 → **the item comes back on every device**, with `done: true`, so it is off the To-do page and reappears only on the calendar.

**Decision: bump `updatedAt` (the second horn) and accept the resurrection.** It is the only horn that converges. The failure needs a delete on one device racing a tick on another before they sync; the result is a reappearing calendar entry, which is annoying and re-deletable, not lost data. The alternative — teaching `applyTombstones` to distinguish an edit from a re-creation — is a change to the single most defect-prone function in the codebase, on the eve of a first real link. The ledger records four occasions where exactly that kind of fix introduced a worse defect than the one it cured.

Required alongside shipping it:
- **Update `merge.js`'s header comment.** Leaving it claiming "no edit path" while shipping one is how the next person reasons from a false premise. It must say an edit path now exists, that it is deliberately confined to a boolean, that deletions are losable to a concurrent edit, and that the next editable field re-opens the question.
- **Pin the behaviour with a test** so it is a known property rather than a surprise (§ 12).

## 6. Change 3 — the Ideas page

Same nav/section mechanism. An idea record is `type: 'idea'`, `date` = capture date, `time: null`, `endTime: null`, `done: false`.

**Text handling — simplified from the previous draft.** `notes` holds the **complete original text**; `title` is a derived display label (first sentence, or the first 15 words when there is no sentence boundary). Short text (≤ 15 words) sets `title` to the whole text and `notes` to `null`.

The previous draft had `notes` hold "the remainder" after the split, which means a split bug can lose words. Keeping the full text in `notes` makes that structurally impossible: the title is only ever a label, and no information depends on getting the split right. This also collapses the edge-case list — an abbreviation like "e.g." producing an early split is now cosmetic.

Two capture paths sharing one pure split function:

1. **The Ideas page's text box** — offline, deterministic, and the fallback when the Worker is unreachable.
2. **Voice through the main entry box** — how Alex actually adds things. The model returns `type: 'idea'`; the client applies the same split.

### 6.1 `dedupeState` — and the trap in the previous draft's fix

`js/merge.js:185` collapses items on `` `${title}${date}${time || ''}` `` (a literal U+0001 separator). Two ideas captured on the same day with the same title collapse to one, and the loser gets a **real tombstone** (`js/merge.js:196-201`) that propagates the deletion everywhere. This runs once, at link time, on an explicit Merge.

**The previous draft recommended excluding undated items from `collapse` and called it "simpler". That fix destroys every idea on the account.** `survivingItemIds` is derived from `collapse`'s *output* (line 195); anything filtered out of its input is absent from that set, so line 199 writes a tombstone for it. Verified by execution: the naive fix produced zero survivors and two tombstones, where the bug itself produced one survivor and one tombstone.

**The fix is to include `id` in the collapse key for ideas.** Every idea then forms its own group, survives `collapse`, lands in `survivingItemIds`, and generates no tombstone. The safety comes precisely from the records still passing *through* `collapse` rather than around it.

## 7. Break points that survive the redesign

Dropping nulls removes most of the previous § 7. What remains:

1. **`visibleItems()`** (`js/app.js:76-78`) must filter on `isScheduled`. This is the single chokepoint feeding list, month, week and day, so one filter covers all four. Forgetting it is *visible* — an idea shows up on the calendar — rather than silently correct.
2. **`renderList` is not gated by `groupItemsByDate`.** `js/app.js:236` calls `sortItemsByDate(visibleItems(...))` directly and iterates it at line 244; `groupItemsByDate` is never involved. List is the default view (`index.html:49`). The `visibleItems` filter in (1) is what covers it — nothing else does.
3. **`makeItem` must carry `done` and `notes`** (§ 3.2) and must keep rejecting `''` (§ 3.4).
4. **`dedupeState`** (§ 6.1).
5. **`js/preview.js:2`** — a second hard-coded `TYPES` list, `['due','start','milestone','event','general']`, that omits `task` and `idea`. A returned `task` renders a `<select>` with nothing selected while `draft[i].type` still holds `'idea'`; the first `change` event overwrites the record's type. The two lists live in different deploy units and can diverge silently.
6. **`js/feeds.js:424-434`** is a second copy of the `sortItemsByDate` comparator, commented "same ordering as items.js's sortItemsByDate". It cannot receive unscheduled input today. Drift risk only — noted so a future change to one is made to both.

## 8. Smart-add

### 8.1 Schema (`worker/src/prompt.js:4-29`)

- `type` enum gains **`task`** and **`idea`**.
- Add **`notes`**: `{ anyOf: [{ type: 'string' }, { type: 'null' }] }`, required.
- **`date` stays `{ type: 'string' }` and required.** This is the change from the previous draft. For an `idea` the model returns today's date, which the client treats as the capture date.

### 8.2 Prompt (`worker/src/prompt.js:31-42`)

Line 37 currently reads: *`"event"` for anything else (meetings, appointments, personal to-dos).*

Split it three ways: `"event"` for meetings and appointments — something that happens at a place and time; `"task"` for something Alex has to *do*; `"idea"` for a thought to keep. For `idea`, `date` is today.

**The task/idea boundary is ACTION vs THOUGHT, and this wording matters — the first attempt got it wrong in production.** The deployed prompt originally offered "a thing to look into" as an *idea* cue, and "look into utilities for housing" — an errand — was duly classified `idea`. That is worse than the `event` misclassification it replaced: `isScheduled()` excludes ideas, so the record leaves the calendar entirely instead of merely missing the To-do page.

Investigating something is an action. `"task"` must explicitly claim looking into, researching, finding out, checking, calling, emailing and buying, **even when vague and undated**; `"idea"` must be restricted to thoughts that are *not* something to do, with signposted examples ("idea for the app: …", "maybe we should …", "remember that …"). Do not let the model split on vague-vs-specific — a vague errand is still an errand. Ambiguous notes prefer `task`, because a stray task on the To-do page is visible and dismissible while a stray idea is off the calendar and easy to miss. `worker/tests/prompt.test.js` pins all three of those properties.

### 8.3 Misclassification is caught by machinery that exists

`needsReview` already routes uncertain results to the preview UI via `decideFlow` (`js/smartadd.js:6-10`). Extend the instruction so an `idea` classification on a note mentioning any time or date words always sets `needsReview: true`. Under the capture-date design a misclassification is recoverable — the record still exists and its type can be changed in the preview.

## 9. Rollout order

The previous draft's four-step gate existed entirely to manage null dates. It is gone. What remains is ordinary sequencing.

**Step 0 — sync visibility, before V6.** Alex's call, and the punchlist had already promoted it. `renderSyncStatus()` looks up `#sync-status`, which exists only inside a mounted settings panel; `index.html` has no such element, so a revoked token, an undecryptable blob, a corrupt code or a stuck adoption all present as an app that works perfectly and quietly stops agreeing with the other device.

> **Implementation note:** the settings panel mounts its own `#sync-status`. Two elements cannot share an id — `getElementById` returns one of them and the other never updates. Resolve this explicitly rather than discovering it at runtime.

**Step 1 — all three V6 changes, one release** (§ 4, § 5, § 6), together with the reader-side work in § 7 and the deliberate dead-code filter in § 3.4.

**Step 2 — the Worker prompt and enum change** (§ 8).

### 9.1 The Worker still deploys differently, and it still goes last

The client deploys per device; the **Worker deploys once, globally, for every device at the same instant.** Under the previous design that made the Worker a data-loss gate. It no longer is — an old client receiving `type: 'idea'` keeps the record and renders it on the calendar. But the ordering still holds for a plainer reason: a Worker that returns `task`/`idea` to a client whose `preview.js` does not know those types produces a `<select>` that misreports the record (§ 7.5). Ship the client first.

Note also that `service-worker.js` is **network-first** (see its own header comment) — an online device already fetches new modules. Bumping `CACHE` purges stale caches; it is not what causes the fetch. The genuine staleness risk is an iOS home-screen PWA that is *resumed rather than reloaded*, which keeps its old module graph in memory while `app.js:527-528` runs a full sync on `visibilitychange`. Under this design that is cosmetic; it would not have been under the previous one.

### 9.2 The two-device link

Still not done as of 2026-08-22, and no part of the client sync has run in a browser or against real D1. This no longer gates V6's correctness. It remains the right thing to do first, because it is the only way to test step 0's indicator against a real failure instead of a simulated one.

## 10. Deferred, not foreclosed

AI summarisation of long ideas — needs a new Worker route, which lands on Plan 4's unwritten auth-and-quota work. The record shape (`title` + `notes`) is identical either way, so it stays purely additive.

Also deferred: genuinely undated records (§ 3.4 ships the tolerance for it); to-do priority; recurring to-dos; converting an idea into a scheduled item; notifications.

## 11. Questions asked, and what Alex answered (2026-08-21)

1. **Do the pages overlap, and what makes an item a to-do?** — A dated item always stays on the calendar; if it also needs doing it appears on the To-do page too. On how the app knows: **the model decides**, because capture is by voice. Both UI alternatives were rejected.
2. **Ship together or separately?** — **All three together.**
3. **V6 before or after the sync-visibility fix?** — **Indicator first.**

The 2026-08-22 revision changed no answer here. It changed how unscheduled records are represented, which is an internal mechanism none of these answers depended on.

## 12. Testing

- **Pure functions, table-tested:** the idea text split, `isScheduled`, the To-do and Ideas predicates, `makeItem` with `done`/`notes`.
- **`makeItem` must be pinned against the whitelist regression** — assert `notes` and `done` survive. This is the defect that would have shipped.
- **A `dedupeState` test with two same-title, same-capture-day ideas**, asserting both survive **and no tombstone is written**. Assert on tombstone *contents*, not just counts: the ledger flags this exact path as previously unpinned.
- **A `done`-toggle-races-a-delete convergence case** (§ 5.1), pinning the resurrection as known behaviour. The existing convergence sim compares **id sets only**, so a race case added there proves the devices agree, not that they agree on the right value — this test needs field-level assertions.
- **A drift test between `js/preview.js`'s `TYPES` and the Worker's `type` enum.** `npm test` already recurses into `worker/`, so a test importing both and asserting set equality is airtight without coupling two deploy units through a shared import.
- **Re-pin `tests/serviceworker.test.js:32`.** It holds `CACHE_ON_MAIN = 'plaenicke-v5-1'` while `main` is at `plaenicke-v5-2`, so its `got > base` assertion is satisfied forever and **cannot fail for V6** — the exact vacuity the test's own comment was written to prevent.
- **Mutation-test every new assertion.** Tests here have passed under implementations that were badly wrong.

`npm test` is bare `node --test` and recurses (root count already includes `worker/`). `node --test tests/` runs zero tests. Storage-touching tests need `installFakeLocalStorage()`.

Two things no `node --test` can settle, to be checked by hand: that a device actually picked up new modules, and that the prompt classifies Alex's real phrasing correctly — the only honest test of the second is speaking a dozen realistic notes at the deployed Worker.

## 13. Review history and what was verified by execution

**Pass 1 — writing the spec.** Found four undated-item break points the conversation had not recorded, beyond the known `deserializeItems` filter.

**Pass 2 — Alex's answer that the model classifies.** Pulled ideas onto the smart-add path, exposing that `date` was `required: string` in the response schema and that `js/preview.js` keeps a duplicate type list.

**Pass 3 — devil's advocate and constructive sparring, 2026-08-22.** Changed the design. Findings acted on, each verified by executing the real modules rather than reading them:

- **The draft's own `dedupeState` fix would tombstone every idea on the account** — worse than the bug (§ 6.1). This is the ledger's most-repeated failure shape and it was in prescribed text that had already been through two passes.
- **The draft's central data-loss claim was false.** It asserted that a device dropping an undated record "pushes the deletion to every other device". Verified false: `merge()` is a monotone union for items and a deserializer drop writes no tombstone. Traced end-to-end, the old device pushes `['d1','n1','idea1']` — the account keeps the idea. The real damage is local invisibility plus a genuinely destructive *adoption* path, not global deletion. **CLAUDE.md carries the same false claim and is corrected alongside this document.**
- **`makeItem` is a whitelist rebuilder** and would have discarded `notes` and `done` at creation (§ 3.2).
- **The `done` checkbox loses deletions, not just checkbox states** (§ 5.1). The draft's "benign because boolean" argument examined neither horn.
- **`renderList` is not gated by `groupItemsByDate`** (§ 7.2); the draft claimed it was.
- **`''` is a third date state** that behaves like neither null nor a date (§ 3.4).
- **The service-worker cache-bump test is self-satisfied at HEAD** and the worker is network-first, so the draft's step-2 mechanism was wrong twice over (§ 9.1, § 12).
- **The `schemaVersion` justification was a conflation** — a version bump is a loud halt, not silent truncation (§ 3.2).

The pattern across all three passes is the one the V5 ledger names: reading the design finds shape errors; **executing the code finds real ones.** Pass 3 was the first to run anything, and it is the pass that changed the design.
