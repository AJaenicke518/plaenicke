# plaenicke V6 — To-dos, Ideas, and the Day-view Reorder

**Date:** 2026-08-20
**Status:** Draft. Design approved in conversation (Approach A); this file is the written form of that decision, pending Alex's review before planning.
**Owner:** Alexander Jaenicke
**Baseline:** `main` at `f1a2f0e`.

> **Scope note.** All three changes are client-only except one prompt edit in the Worker. Nothing here touches the sync protocol, the D1 schema, the Worker routes, or the crypto. It does, however, cross an invariant the V5 spec relied on — that every item has a `date` string — and § 7 is the part of this document that matters most.

## 1. Goal

Three changes to how existing data is presented, plus one new kind of record:

1. **Day view** shows the untimed block *above* the hour grid, not below it.
2. **To-do page** — a fifth view listing actionable items that are not done, independent of date.
3. **Ideas page** — a sixth view for undated notes-to-self, captured as free text.

The unifying constraint: **do this without re-deriving sync correctness.** V5's client sync took ten tasks and roughly forty-five defects to establish, nine of which were found in the plan's own prescribed code after adversarial review had cleared it. The design below is chosen to keep the merge path, the tombstone kinds, and `schemaVersion` untouched.

**Non-goals:** AI summarisation of long ideas (§ 10); recurring to-dos; due-date reminders or notifications; reordering or prioritising to-dos; any change to the merge function, the CAS protocol, the Worker's data routes, or the link flow.

## 2. Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Record shape | **Everything stays an `item`** | A separate `todos`/`ideas` array in the synced blob means a `schemaVersion` bump, a migration, new `merge()` branches and new tombstone kinds. All four are load-bearing sync code. Discriminating on `type` costs nothing. |
| `schemaVersion` | **Stays 1** | No new arrays in the blob. An un-updated device merging a blob it partly ignores would push the data back missing; adding only *fields* avoids that entirely (§ 3.2). |
| New `type` values | `task`, `idea` | Joins the existing `due`, `start`, `milestone`, `event`, `general`. |
| New item fields | `done` (boolean), `notes` (string or null) | Fields, not arrays. Ride through an old device untouched — see § 3.2. |
| Undated items | **`date: null` is now legal** | An idea has no date. The alternative — a sentinel date like `9999-12-31` — keeps `deserializeItems` happy but pollutes every date-ordered view and the month grid, and would need un-picking later. |
| Ideas capture | Free text, split client-side | Under ~15 words the whole text is the title. Longer: first sentence → `title`, remainder → `notes`. No network call, works offline. |
| Smart-add | **Prompt edit only, no new route** | `worker/src/prompt.js:37` currently routes "personal to-dos" to `"event"`, which is why to-dos land on the calendar. Adding `task` to the enum is a two-line change. |

## 3. Data model

### 3.1 The item record after V6

```js
{
  id, title, date, time, endTime, createdAt, updatedAt,
  type,      // 'general' | 'due' | 'start' | 'milestone' | 'event' | 'task' | 'idea'
  project, subject, category,
  done,      // NEW — boolean. Absent on every pre-V6 record; read as false.
  notes,     // NEW — string or null. Absent on every pre-V6 record; read as null.
}
```

`date` may now be `null`. `time` and `endTime` must be `null` whenever `date` is `null` — a time without a day has nowhere to render.

### 3.2 Why adding fields is safe and adding arrays is not

**Verified at `f1a2f0e`:** `deserializeItems` (`js/storage.js:27-37`) filters, then `.map`s each surviving record to *itself* when `updatedAt` is already a string. It does not rebuild from a field whitelist. An old device that pulls a blob containing `done` and `notes` therefore stores those fields verbatim and pushes them back intact on its next sync. The same is true of `merge()`'s `unionById` (`js/merge.js:39-48`), which sets whole records into a Map and never inspects their fields.

The array case is the opposite: `merge()` only merges `items`, `feeds` and `tombstones`, and `toWire()` only serialises those three. A `todos` array added to the blob would be dropped by any device that had not been updated, and that device's next push would write the truncated blob back over the account. That is why `schemaVersion` exists and why `merge()` throws on anything other than 1.

### 3.3 Which page shows which item

| Page | Predicate |
|---|---|
| List / Month / Week / Day | `date` is a string (unchanged — undated items are excluded, see § 7.3) |
| To-do | `type ∈ {due, start, milestone, task}` **and** `done !== true` |
| Ideas | `type === 'idea'` |

**Open question for Alex (§ 11):** manual add sets `type: 'general'` (`js/app.js:143`) and smart-add's catch-all is `'event'`. Neither appears on the To-do page under the predicate above. That is the approved shape, but it means an item typed into the box with a date lands on the calendar and *not* on the to-do list. If the intent is "anything not done and not an idea is a to-do", the predicate should be `type !== 'idea' && done !== true` instead. This needs a one-word answer before implementation.

## 4. Change 1 — day view reorder

`js/dayview.js:61-88` builds the "Other tasks" block inside a trailing `if (untimed.length > 0)` and appends it *after* `container.appendChild(grid)` at line 58. The change is to append it before the grid.

**One ordering trap, concrete:** line 59 sets `grid.scrollTop`, which only takes effect once `grid` is in the document. Building the untimed block first and appending it first is fine; moving the `container.appendChild(grid)` / `grid.scrollTop = …` pair apart is not. Keep those two lines adjacent and after both appends.

This is genuinely a few lines and has no interaction with anything else in V6.

## 5. Change 2 — the To-do page

`index.html:48-53` is a `.view-toggle` nav of four buttons; `index.html:55-84` is four `<section>` elements toggled by the `hidden` attribute. `showView()` (`js/app.js:359-365`) drives both from two parallel object literals. Adding a fifth entry to each is the whole mechanism.

New behaviour beyond the plumbing:

- Each row gets a checkbox that sets `done`. Toggling `done` is the app's **first edit path** — until now `app.js` only adds and deletes. See § 7.4, which is not optional.
- Rows show the date when there is one, and no date otherwise.
- Ordering: dated items first by date ascending, then undated by `createdAt`. This needs the `sortItemsByDate` fix in § 7.2 regardless.

## 6. Change 3 — the Ideas page

Same nav/section mechanism as § 5. An idea is created from a single text box:

- Word count ≤ 15 → `title` is the whole text, `notes` is `null`.
- Word count > 15 → `title` is the first sentence, `notes` is the remainder.
- `type: 'idea'`, `date: null`, `time: null`, `endTime: null`, `done: false`.

The sentence split is a pure function and belongs in its own module with table tests (empty string, no terminal punctuation, an abbreviation like "e.g.", a single 200-word sentence with no split point). "First sentence" must have a defined fallback when there is no sentence boundary: take the first 15 words as the title and the rest as notes rather than putting the entire text in the title.

## 7. The undated-item hazard

This section is the reason V6 is not a small change. `date: null` breaks five call sites, four of which fail **silently**. All five were verified against `f1a2f0e`.

### 7.1 `deserializeItems` drops undated items — and the drop propagates

`js/storage.js:32` filters on `typeof it.date === 'string'`. An item with `date: null` is discarded on load. Worse: the device then holds a state that is missing the record, and `applySyncedState` → `saveItems` → the next push writes that shorter list to the account. The item is gone everywhere.

**The rollout rule is hard and it is stated again in § 9:** the relaxed filter must be live on **both** devices before the first undated record is created. There is no way to recover an item this drops — it never reaches storage, so there is no tombstone and no trace.

The relaxed predicate is `it.date === null || typeof it.date === 'string'`. It must stay a *rejection* of every other type: `undefined`, a number, or an object must still be filtered out, because everything downstream now branches on exactly `null` versus string.

### 7.2 `sortItemsByDate` has no ordering for null — this is not "undated sorts last"

`js/items.js:34` is `if (a.date !== b.date) return a.date < b.date ? -1 : 1;`. With `a.date = null` and `b.date = '2026-08-20'`, the comparison `null < '2026-08-20'` evaluates `0 < NaN` → `false`, so it returns `1`. Reversing the arguments also returns `1`. The comparator claims each item comes after the other, which is not a strict weak ordering, and the resulting array order is whatever the engine's sort happens to produce.

Fix: an explicit branch before the string comparison — both null → fall through to `createdAt`; one null → the null sorts last (or first; pick one and test it).

### 7.3 `groupItemsByDate` buckets undated items under the string `"null"`

`js/calendar.js:23` uses `map[it.date]`, and a `null` key coerces to `"null"`. Nothing ever reads that bucket, so day, week and month views appear to behave correctly — by accident. Make it deliberate: filter undated items out before grouping, so the exclusion is visible in the code rather than a property of object-key coercion.

### 7.4 `dedupeState` can silently merge two distinct ideas — with a tombstone

`js/merge.js:185` collapses items on the key `` `${i.title}${i.date}${i.time || ''}` ``. A null `date` stringifies to the literal `"null"`, so **two different undated ideas with the same title collapse to one, and `dedupeState` writes a real tombstone for the loser** (`js/merge.js:196-201`), which then propagates the deletion to every device.

This runs once, at link time, on the user's explicit choice of Merge — so it is not an every-sync hazard. But ideas are exactly the record most likely to repeat a title ("app idea", "read later"), and the tombstone makes it unrecoverable.

Two candidate fixes, both **concrete**:

- **Exclude undated items from `collapse` entirely.** Dedupe exists to fix the duplicate-feed and duplicate-event problem from linking two devices that were used independently; undated ideas created on two devices are genuinely different records, never the same one seen twice.
- **Include `id` in the key for undated items,** which makes every undated record its own group.

The first is simpler and matches the intent. Either way this must be decided before the link-time path can be trusted with undated data.

### 7.5 `makeItem` rejects undated items outright

`js/items.js:8` throws `'Date is required'`. This is a *loud* failure, not a silent one, and it is the only one of the five that will show up the moment anyone tries to create an idea. It needs a relaxation that keeps the existing guarantees: when `date` is null, `time` and `endTime` must also be null, and the `HHMM` validation still applies whenever a time is present.

### 7.6 `renderList` would print `"null — Buy milk"`

`js/app.js:250` is `` `${it.date} — ${it.title}` ``. Cosmetic, and § 7.3's filter prevents it from ever being reached — but only as long as that filter is actually in place.

## 8. Smart-add prompt change

`worker/src/prompt.js:19` — add `'task'` to the `type` enum.

`worker/src/prompt.js:37` currently reads:

> `"event"` for anything else (meetings, appointments, personal to-dos).

Split it: `"event"` for meetings and appointments; `"task"` for a personal to-do with no fixed time. `date` stays required in the schema — smart-add always resolves a date, and ideas are not created through smart-add.

The Worker deploys separately via `wrangler` with roughly 20 seconds of edge propagation, so the first smoke test after deploy can hit the old prompt.

## 9. Rollout order

The ordering is forced by § 7.1 and is not a matter of taste.

1. **Reader-side relaxation only, shipped and confirmed live on both devices.** `deserializeItems`, `sortItemsByDate`, `groupItemsByDate`, `dedupeState`, `makeItem` — every change that lets a device *tolerate* an undated record. No UI that can create one.
2. **Confirm both devices are running it.** GitHub Pages serves `main` directly, so merging is the deploy; the service worker's `CACHE` name (`service-worker.js:13`, currently `plaenicke-v5-2`) must be bumped or a device keeps serving the old modules from cache and step 1 has not actually happened on that device. Verify by loading each device and checking the served `js/storage.js`, not by assuming.
3. **Day-view reorder** (§ 4) — independent of everything above; can ship in step 1's release or its own.
4. **To-do page** (§ 5). Creates no undated records, but introduces the `done` edit path.
5. **Ideas page** (§ 6) — the first thing that creates `date: null`. Ships last.
6. **Worker prompt change** (§ 8) — independent, any time.

Steps 4 and 5 must not be merged before step 2 has been *observed*, not inferred.

**This assumes the two-device link has actually been done.** As of 2026-08-20 it has not: no part of the client sync has run in a browser or against real D1. If V6 ships to a single unlinked device the rollout rule is vacuous — but it becomes live the moment the second device is linked, and a device linked *later* while running old code will drop every undated item and push the deletion. Prefer doing the link first.

## 10. Deferred, not foreclosed

**AI summarisation of long ideas.** Alex asked for it and then agreed to keep V6 simple. It needs a new Worker route, which lands on Plan 4's unwritten auth-and-quota work. The record shape is identical either way — `title` plus `notes` — so adding it later is purely additive and costs nothing now.

Also deferred: to-do ordering/priority, recurring to-dos, converting an idea into a dated item, and any notification path.

## 11. Open questions for Alex

1. **To-do predicate** (§ 3.3) — is a `general`-typed dated item a to-do or not? One word decides it.
2. **Ship together or separately** — the day-view reorder is a few lines and has no dependency on the rest. Alex leaned "all three, keep it simple" but did not answer directly. § 9 works either way.
3. **V6 before or after the sync-visibility fix.** There is no sync indicator outside the Settings panel, so a broken sync presents as an app that works perfectly and quietly stops agreeing with the other device. The devil's advocate argued a passive indicator should precede Plan 4. V6 adds a page whose whole content is undated records, which are exactly the records that go missing when sync half-works — that argues for the indicator first.

## 12. Testing

- **Pure functions, table-tested,** in the style of `js/feeds.js` and `js/merge.js`: the idea sentence-split, the relaxed `makeItem`, the fixed `sortItemsByDate` comparator, the to-do and idea predicates.
- **`sortItemsByDate` needs an anti-symmetry test**, not just a "nulls come last" test — assert that `cmp(a,b)` and `cmp(b,a)` have opposite signs for every pairing of dated and undated. The current bug passes a naive expected-order assertion on small arrays.
- **A round-trip test through `deserializeItems`** proving an undated record survives, and that `date: undefined` / `date: 42` are still rejected.
- **A `dedupeState` test** with two distinct undated items sharing a title, asserting both survive and no tombstone is written.
- **Extend the convergence simulation** with undated records, including the case where one side holds an undated item and the other does not.
- **Mutation-test the new assertions.** Several tests in this repo have passed under implementations that were badly wrong; the V5 ledger records nine occasions where a defect lived in reviewed-and-cleared code and every one was caught by *running* it, not reading it.

Run with `npm test` (bare `node --test`, which recurses and already includes `worker/`). `node --test tests/` runs zero tests and reports one spurious failure. Storage-touching tests need `installFakeLocalStorage()` from `tests/fake-localstorage.js`.

## 13. What this document verified rather than assumed

Every file-and-line reference above was read at `f1a2f0e`. Four items in § 7 were **not** in the approved design as discussed and were found while writing this spec: `sortItemsByDate`'s broken comparator (§ 7.2), `groupItemsByDate`'s accidental `"null"` bucket (§ 7.3), `dedupeState`'s title collision with a propagating tombstone (§ 7.4), and `makeItem`'s outright rejection (§ 7.5). The conversation had recorded only `deserializeItems`.

That changes the size of the change: V6 is not "two new pages plus a filter relaxation". It is a five-call-site change to the undated-item contract, three of whose failure modes are silent and one of which destroys data at link time.
