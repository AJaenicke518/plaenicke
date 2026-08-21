# plaenicke V6 — To-dos, Ideas, and the Day-view Reorder

**Date:** 2026-08-20 (revised 2026-08-21 after Alex's review)
**Status:** Approved. All three open questions answered — see § 11.
**Owner:** Alexander Jaenicke
**Baseline:** `main` at `f1a2f0e`.

> **Scope note.** Nothing here touches the sync protocol, the D1 schema, the Worker routes, or the crypto. It does cross an invariant the V5 spec relied on — that every item has a `date` string — and § 7 is the part of this document that matters most. The Worker's smart-add prompt and response schema also change (§ 8); because the Worker deploys globally in one step while clients update per device, that edit is the rollout's tightest constraint rather than an afterthought (§ 9.1).

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
| **Who decides an item is a to-do** | **The smart-add model, via `type`** | Alex's capture path is voice in practice: speak into the phone, Web Speech transcribes, the Worker classifies. So the model decides, and no new UI is needed to declare intent. This makes the prompt load-bearing for correctness — see § 8. |
| Smart-add | **Prompt and schema edit, no new route** | Was scoped as "add `task` to the enum". Because voice is the primary path, smart-add must also be able to produce **ideas**, which means `date` becomes nullable in the response schema. That is a bigger change than a prompt tweak and it reorders the rollout — see § 8 and § 9. |

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

**The pages overlap by design.** A dated to-do appears on the calendar views *and* on the To-do page. In Alex's words: if it has a date it always goes on the calendar, and if it is also something that needs doing it goes on the to-do list as well. Nothing is moved off the calendar by being a to-do.

| Page | Predicate |
|---|---|
| List / Month / Week / Day | `date` is a string (unchanged — undated items are excluded, see § 7.3) |
| To-do | `type ∈ {due, start, milestone, task}` **and** `done !== true` |
| Ideas | `type === 'idea'` |

A completed to-do (`done === true`) leaves the To-do page but **stays on the calendar** — it still happened on that day. Style it as completed rather than hiding it.

**Where `type` comes from.** Almost always the smart-add model: Alex speaks into the phone, `js/voice.js` transcribes to the entry box, and `handleAdd` sends it to the Worker when no date is picked. The model already assigns `type`, so classifying "buy milk" as a `task` and "dentist at 2pm" as an `event` is the model's job and needs no new control.

**Accepted gap:** the manual path (`js/app.js:143`) hard-codes `type: 'general'`, and `general` is not on the To-do predicate. Manual add is the offline/no-Worker fallback — it fires only when Alex picks a date himself. An item added that way lands on the calendar and not the to-do list. This is accepted rather than fixed, because the alternatives are a new control on the add box (rejected — voice makes it unnecessary) or treating every `general` item as a to-do (rejected — it would put birthdays and appointments on the to-do list). If it turns out to bite in practice, the fix is a type selector on the manual path, which is additive.

## 4. Change 1 — day view reorder

`js/dayview.js:61-88` builds the "Other tasks" block inside a trailing `if (untimed.length > 0)` and appends it *after* `container.appendChild(grid)` at line 58. The change is to append it before the grid.

**One ordering trap, concrete:** line 59 sets `grid.scrollTop`, which only takes effect once `grid` is in the document. Building the untimed block first and appending it first is fine; moving the `container.appendChild(grid)` / `grid.scrollTop = …` pair apart is not. Keep those two lines adjacent and after both appends.

This is genuinely a few lines and has no interaction with anything else in V6.

## 5. Change 2 — the To-do page

`index.html:48-53` is a `.view-toggle` nav of four buttons; `index.html:55-84` is four `<section>` elements toggled by the `hidden` attribute. `showView()` (`js/app.js:359-365`) drives both from two parallel object literals. Adding a fifth entry to each is the whole mechanism.

New behaviour beyond the plumbing:

- Each row gets a checkbox that sets `done`. Toggling `done` is the app's **first edit path** — until now `app.js` only adds and deletes. See § 5.1, which is not optional.
- Rows show the date when there is one, and no date otherwise.
- Ordering: dated items first by date ascending, then undated by `createdAt`. This needs the `sortItemsByDate` fix in § 7.2 regardless.
- **No add box on this page.** To-dos are captured by voice through the main entry box like everything else (§ 3.3); the To-do page is a view plus the checkbox.

### 5.1 Toggling `done` is the first edit path, and `merge.js` has a warning about exactly this

`js/merge.js:10-15` says, verbatim, that per-record last-write-wins is tolerable **only** because the app has no edit path — "app.js adds and deletes, nothing rewrites a record — so the same id is almost never written on both devices. Anyone adding an edit feature must revisit this before shipping it."

A `done` checkbox is that edit feature. Two devices can now write the same `id`, and the winner is decided by wall-clock `updatedAt` from two clocks that are never compared.

The honest assessment: for this field the failure is **benign and self-correcting**. The values are `true` and `false`, both devices converge on one of them, and if the wrong one wins Alex sees an unticked box and ticks it again. That is not the case for a future edit path that rewrites `title` or `date`, where the loser's text is gone.

So: ship the checkbox, and **update `merge.js`'s header comment** to say that an edit path now exists, that it is deliberately confined to a boolean, and that the next field to become editable re-opens the question. Leaving the comment claiming "no edit path" while shipping one is how the next person reasons from a false premise.

## 6. Change 3 — the Ideas page

Same nav/section mechanism as § 5. An idea record is `type: 'idea'`, `date: null`, `time: null`, `endTime: null`, `done: false`, with the text split into `title` and `notes`:

- Word count ≤ 15 → `title` is the whole text, `notes` is `null`.
- Word count > 15 → `title` is the first sentence, `notes` is the remainder.

The sentence split is a pure function and belongs in its own module with table tests (empty string, no terminal punctuation, an abbreviation like "e.g.", a single 200-word sentence with no split point). "First sentence" must have a defined fallback when there is no sentence boundary: take the first 15 words as the title and the rest as notes rather than putting the entire text in the title.

**Two capture paths, and the split function is shared.**

1. **The Ideas page's own text box** — offline, no network, deterministic. This is the fallback and the way to add an idea when the Worker is unreachable.
2. **Voice through the main entry box**, which is how Alex actually adds things. The model returns `type: 'idea'` with `date: null`; the client applies the same split to the returned `title` if no `notes` came back.

Path 2 is why § 8 grew. It is also the path that makes the Ideas page reachable in normal use — an ideas feature that can only be typed, on a phone, by someone who captures everything by voice, would not get used.

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

## 8. Smart-add: the classification path

This section was scoped as a two-line prompt tweak. Alex's review changed that: **voice through smart-add is the primary way items get created**, so the model's `type` choice is what decides which page a record lands on. The prompt is now load-bearing for correctness, and smart-add must be able to emit ideas as well as tasks.

### 8.1 Schema changes (`worker/src/prompt.js:4-29`)

- `type` enum gains **`task`** and **`idea`**: `['due', 'start', 'milestone', 'event', 'task', 'idea']`.
- **`date` becomes nullable** — `{ anyOf: [{ type: 'string' }, { type: 'null' }] }`. It is currently `{ type: 'string' }` and listed in `required`. Keep it in `required` so the model must state a date or state its absence explicitly, rather than omitting the key.
- Add **`notes`**: `{ anyOf: [{ type: 'string' }, { type: 'null' }] }`, also required.

### 8.2 Prompt changes (`worker/src/prompt.js:31-42`)

Line 37 currently reads:

> `"event"` for anything else (meetings, appointments, personal to-dos).

Split it three ways: `"event"` for meetings and appointments — something that happens at a place and time; `"task"` for something Alex has to *do*, with or without a fixed time; `"idea"` for a thought to keep, with no date at all.

The `date` instruction needs a matching clause: resolve a date as today, **except** for `type: "idea"`, where `date` must be `null`. And a guard in the other direction — `null` is only correct for an idea; if a note implies something must happen but states no date, it is still a `task` and the model should resolve a date rather than reaching for `null`.

### 8.3 Misclassification is caught by machinery that already exists

The risk of letting the model choose is that a real appointment is classified as an `idea` and disappears from the calendar. `needsReview` already handles this: the prompt sets it true whenever the note is complex or the type is uncertain, and `decideFlow` (`js/smartadd.js:6-10`) routes anything with `needsReview` — or more than one item — to the preview UI for confirmation. Extend the existing instruction so an `idea` classification on a note that mentions any time or date words always sets `needsReview: true`.

### 8.4 `js/preview.js` has a second, hard-coded type list

`js/preview.js:2` is `const TYPES = ['due', 'start', 'milestone', 'event', 'general'];` — a duplicate of the Worker's enum that will silently disagree with it. A returned `task` or `idea` renders a `<select>` with **no option selected**, and the first `change` event rewrites the record's type to whatever the user happens to land on.

Also in that file: `date.value = it.date` on an `<input type="date">` (line 24). Assigning `null` yields `''` rather than the string `"null"` (the IDL attribute is `[LegacyNullToEmptyString]`), so this does not visibly break — but an undated idea and a dated item whose date the model failed to resolve then look **identical** in the review UI. The preview needs to distinguish "intentionally undated" from "no date yet", and it needs a `notes` field, which it does not have at all today.

### 8.5 Deployment

The Worker deploys separately via `wrangler`, with roughly 20 seconds of edge propagation — the first smoke test after a deploy can hit the old prompt and look like a broken release. Note that the Worker and the client deploy through **different mechanisms with different timing**, which is exactly what § 9 has to sequence.

## 9. Rollout order

The ordering is forced by § 7.1 and is not a matter of taste. Alex's decision to ship all three changes together applies to the *user-visible release* — the three pages arrive at once. It does not collapse the two deploy gates below, which exist because the client and the Worker deploy through different mechanisms.

**Step 0 — sync visibility, before any of V6.** Alex's call, and the punchlist already promoted it (`~/punchlists/punchlist-plaenicke.md`, the RE-TRIAGE item). `renderSyncStatus()` looks up `#sync-status`, which exists only inside a mounted settings panel; `index.html` has no such element. So a revoked token, an undecryptable blob, a corrupt stored code, or a device stuck at `adoptionPending` all present as an app that works perfectly and quietly stops agreeing with the other device. V6 sharpens this: the Ideas page's entire content is undated records, which are precisely what goes missing when sync half-works. One dot on the app shell; `sync-status-problem` styling already exists in `paintStatus`.

**Step 1 — client reader-side relaxation, shipped.** `deserializeItems`, `sortItemsByDate`, `groupItemsByDate`, `dedupeState`, `makeItem` — every change that lets a device *tolerate* an undated record. No UI that can create one. `js/preview.js`'s `TYPES` list (§ 8.4) belongs here too: it must accept `task` and `idea` before the Worker can return them.

**Step 2 — confirm both devices are actually running step 1.** GitHub Pages serves `main` directly, so merging is the deploy, but the service worker's `CACHE` name (`service-worker.js:13`, currently `plaenicke-v5-2`) must be bumped or a device keeps serving the old modules from its cache and step 1 has not happened there. Verify by loading each device and checking the served `js/storage.js`. **Observed, not inferred.**

**Step 3 — the three V6 pages together** (§ 4, § 5, § 6). This is the release Alex sees. The Ideas page is the first thing that can create `date: null`, which is why step 2 gates it.

**Step 4 — the Worker prompt and schema change** (§ 8), last.

### 9.1 Why the Worker change goes last, and why it is the sharpest gate

The client deploys per device — each browser picks up new modules on its own schedule, subject to its service-worker cache. **The Worker deploys once, globally, for every device at the same instant.**

So the moment `worker/src/prompt.js` can return `type: 'idea'` with `date: null`, *any* device that uses voice can create an undated record — including a device still serving old client modules from cache. That device's `deserializeItems` drops the record on the next load, and its next sync pushes the shortened list to the account. The item is gone from every device, with no tombstone and no trace.

A device on old code hitting the new Worker fails *loudly* at first — `makeItem` throws `'Date is required'` and `handleAdd` surfaces it via `setMessage`, so nothing is added. That is the good case. The bad case is the same device after it has pulled an undated record created elsewhere, where the loss is silent.

This is why step 4 is last and why step 2 must be observed on both devices rather than assumed.

### 9.2 This assumes the two-device link has been done

As of 2026-08-21 it has not: no part of the client sync has run in a browser or against real D1. If V6 ships to a single unlinked device the rollout rule is vacuous — but it goes live the moment the second device is linked, and **a device linked later while running old code will drop every undated item and push the deletion.** Do the link first. It is also the only way to test step 0's indicator against a real failure.

## 10. Deferred, not foreclosed

**AI summarisation of long ideas.** Alex asked for it and then agreed to keep V6 simple. It needs a new Worker route, which lands on Plan 4's unwritten auth-and-quota work. The record shape is identical either way — `title` plus `notes` — so adding it later is purely additive and costs nothing now.

Also deferred: to-do ordering/priority, recurring to-dos, converting an idea into a dated item, and any notification path.

## 11. Questions asked, and what Alex answered (2026-08-21)

1. **Do the pages overlap, and what makes an item a to-do?** — A dated item *always* stays on the calendar; if it is also something that needs doing it appears on the To-do page as well. The two are not exclusive (§ 3.3).

   On how the app knows: **the model decides.** Alex captures by voice in practice, so smart-add classifies, and no new UI is needed to declare intent. This is the answer that reshaped § 8 — it pulled ideas into the smart-add path, which made `date` nullable in the response schema and turned the Worker deploy into the rollout's sharpest gate (§ 9.1). Both UI alternatives (a to-do capture box, a checkbox on the add box) were considered and rejected as unnecessary given voice.

2. **Ship together or separately?** — **All three together.** § 9 step 3.

3. **V6 before or after the sync-visibility fix?** — **Indicator first.** § 9 step 0.

Nothing here is open. The remaining prerequisite is not a decision but an action: the physical two-device link (§ 9.2).

## 12. Testing

- **Pure functions, table-tested,** in the style of `js/feeds.js` and `js/merge.js`: the idea sentence-split, the relaxed `makeItem`, the fixed `sortItemsByDate` comparator, the to-do and idea predicates.
- **`sortItemsByDate` needs an anti-symmetry test**, not just a "nulls come last" test — assert that `cmp(a,b)` and `cmp(b,a)` have opposite signs for every pairing of dated and undated. The current bug passes a naive expected-order assertion on small arrays.
- **A round-trip test through `deserializeItems`** proving an undated record survives, and that `date: undefined` / `date: 42` are still rejected.
- **A `dedupeState` test** with two distinct undated items sharing a title, asserting both survive and no tombstone is written.
- **A test that `js/preview.js`'s `TYPES` and the Worker's `type` enum cannot drift** (§ 8.4). The two lists are in different deploy units, so a divergence ships silently. Either assert equality across the two modules or derive both from one exported constant — the latter is better, and the repo already set that precedent with `tests/fake-localstorage.js`.
- **Extend the convergence simulation** with undated records, including the case where one side holds an undated item and the other does not, and a `done` toggle racing on both devices (§ 5.1).
- **Mutation-test the new assertions.** Several tests in this repo have passed under implementations that were badly wrong; the V5 ledger records nine occasions where a defect lived in reviewed-and-cleared code and every one was caught by *running* it, not reading it.

Two things in this spec are **not** covered by any test that can run in `node --test`, and should be checked by hand on a real device rather than assumed: that a bumped service-worker `CACHE` actually caused a device to fetch new modules (§ 9 step 2), and that the smart-add prompt classifies Alex's real phrasing into the right `type` (§ 8.2). The second is a prompt-quality question and the only honest way to answer it is to speak a dozen realistic notes at the deployed Worker and read the output.

Run with `npm test` (bare `node --test`, which recurses and already includes `worker/`). `node --test tests/` runs zero tests and reports one spurious failure. Storage-touching tests need `installFakeLocalStorage()` from `tests/fake-localstorage.js`.

## 13. What this document verified rather than assumed

Every file-and-line reference above was read at `f1a2f0e`, and the three JavaScript coercion claims in § 7 were confirmed by execution, not by reading: `cmp(null, str)` and `cmp(str, null)` both return `1`; the `dedupeState` key for two same-titled undated items is byte-identical; `map[null]` produces the key `"null"`.

**First pass** (writing the spec) found four undated-item break points the conversation had not recorded, beyond the known `deserializeItems` filter: `sortItemsByDate` (§ 7.2), `groupItemsByDate` (§ 7.3), `dedupeState` (§ 7.4), `makeItem` (§ 7.5). Three fail silently; one destroys data at link time.

**Second pass** (after Alex's answer that the model decides `type`) found two more, both on the smart-add path that the first pass had treated as a two-line prompt edit: `js/preview.js`'s duplicated `TYPES` list (§ 8.4), and the fact that `date` is `required: string` in the Worker's response schema, so ideas cannot come through smart-add at all without a schema change (§ 8.1).

The second pass also produced the one structural insight in this document: **the Worker deploys globally in a single step while clients update per device.** Making smart-add able to emit undated records therefore arms every device at once, including one still serving old modules from its service-worker cache — which is why the Worker change is now last in the rollout rather than "independent, any time" (§ 9.1).

The pattern is worth naming, because it is the same one the V5 ledger records nine times: each pass over the *actual code* found defects that reading the design did not. V6 is not "two new pages plus a filter relaxation."
