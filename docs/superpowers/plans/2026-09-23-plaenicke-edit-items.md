# Plan — editing your own items (Project A)

**Spec:** `docs/superpowers/specs/2026-09-23-plaenicke-edit-items-design.md`. Read it first; this plan does not restate the reasoning.
**Revision 2.** This version folds in the devil's-advocate review (1 Critical, 11 Important, all applied except one partial deferral). Where this plan and the spec disagree, **this plan wins**.
**Branch:** `feature/edit-items`, branched from `feature/phase0-today-fresh`.

## Global rules for every task

- **Test-first.** Write the test, run it and see it fail for the right reason, then implement.
  - One file: `node --test <file>`. Whole suite: `npm test` (it recurses).
  - **Never** run `node --test tests/`; it runs 0 tests.
- **Mutation-check every new assertion.** Plant the wrong implementation and see a test fail. Then restore it and verify the restore with `git diff`. Never leave a mutant in the tree. Run tests in the foreground only.
- **Storage-touching tests** need `installFakeLocalStorage()` from `tests/fake-localstorage.js`.
- **Ownership.** `app.js` is the only writer of `plaenicke.items`. View modules, `itemsheet.js` and `toast.js` never touch storage.
- **No test-only code in production modules.**
- **Constraints to respect:**
  - `makeItem` is a 13-key whitelist, so don't add item fields.
  - `itemTypeClass` returns more than one token, so assign it with `className`.
  - The fake DOMs **do not bubble events**, so a "clicking X does not trigger Y" test cannot fail from bubbling. Structure the code so that no handler wraps another control. Don't rely on tests to prove it.
- **Service worker.** New modules go in `service-worker.js` ASSETS. CACHE stays `plaenicke-v6-2`.
- **Commits.** Commit at the end of each task with a descriptive message ending in:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
  **Never** merge, push or deploy.
- **Report back:**
  - the files changed;
  - the test counts before and after;
  - the mutants killed;
  - any deviation, with the reason.

---

## Task 1 — `js/edit.js` (pure)

**Interface:**
```js
export const EDITABLE_FIELDS; // ['title','date','time','endTime','type','notes']
export function applyEdit(record, patch, updatedAt)      // -> new record; throws makeItem's errors
export function diffPatch(opened, current)                // -> only the EDITABLE_FIELDS keys whose values differ
export function snapshotOf(record, keys)                  // -> { [k]: record[k] } for the given keys
export function quickMoves(record, todayISO)              // -> [{ label:'Tomorrow', date }, { label:'+1 week', date }]
export function typeChangePatch(record, patch)            // -> patch adjusted for idea <-> non-idea switches
```

**`applyEdit`:**
- Keeps only the `EDITABLE_FIELDS` keys from `patch`, then merges: `merged = { ...record, ...picked }`.
- Returns `makeItem(normalizeIdea(merged), { id: record.id, createdAt: record.createdAt, updatedAt })`.
- **Error wording:** if `merged.type === 'idea'` and `makeItem` throws `Title is required`, rethrow as `The idea is empty.`

**`diffPatch`:** compares each editable key with `===`, treating `null`, `undefined` and `''` as equal to each other **except for `date`**. A date of `''` is a real value that must reach `makeItem` so it can be rejected.

**`typeChangePatch`**, applied by the caller **before** `applyEdit`:
- **Switching to idea** (the record is not an idea, and `patch.type === 'idea'`): the idea text is the effective notes (`patch.notes`, else `record.notes`) when they are non-empty, otherwise the effective title. Set `notes` to that text, plus `time: null` and `endTime: null`.
  - *Amended after Task 1.* The first version threw existing notes away. Notes are now a visible field on every sheet (Task 3), so they are never hidden text.
- **Switching from idea** (the record is an idea, and `patch.type` is set and isn't `'idea'`): the text is `patch.notes ?? patch.title ?? (record.notes ?? record.title)`.
  - Set `title` to `splitIdeaText(text).title`, taken from `js/ideas.js`.
  - Set `notes` to `splitIdeaText(text).notes`.
- **Otherwise:** return `patch` unchanged.

**`quickMoves`:** `Tomorrow` is `addDays(todayISO, 1)`. `+1 week` is `addDays(record.date, 7)`. Both use `js/timegrid.js`'s `addDays`.

**Tests (`tests/edit.test.js`):**
- **Preservation:** `id`, `createdAt`, `done: true`, `project`, `subject` and `category` all survive an edit.
- **Timestamps:** `updatedAt` equals the value passed in.
- **Ignored keys:** non-editable patch keys have no effect.
- **Rejection:** a date of `''` throws; an end time at or before the start throws; an empty title throws. An empty idea throws `/The idea is empty/`.
- **No mutation:** `record` is unchanged after the call.
- **Ideas:** a long idea edit derives the title and keeps the full text in notes.
- **`diffPatch`:** only changed keys come back, and a date of `''` counts as a change.
- **`typeChangePatch` (both directions):** a task with stale notes switched to idea gets the typed title as its text, with times cleared. An idea switched to task gets a derived title and keeps the full notes.
- **Quick moves:** month and year boundaries are handled.

**Mutants to kill:**
- no key filter;
- no `normalizeIdea`;
- `updatedAt` taken from `record`;
- `diffPatch` treating `''` as null for `date`;
- `typeChangePatch` not setting `notes`.

## Task 2 — `js/toast.js` (DOM)

**Interface:** `showToast(host, text, { undo = null, ms = 5000, onExpire = null })` returns `{ dismiss() }`.

**Rendering:** a `<div class="toast" role="status">` containing a text span. If `undo` is set, add `<button type="button" class="toast-undo">Undo</button>`.

**Behaviour:**
- **Undo** clears the timer, empties the host and calls `undo()`. `onExpire` never runs.
- **Expiry** after `ms` empties the host and calls `onExpire()`.
- **`dismiss()`** expires early, so `onExpire` runs.
- **A second `showToast` on the same host** first runs the previous toast's `onExpire` synchronously, then replaces the toast. Track the current toast per host in a WeakMap.
- **Idempotent:** `onExpire` and `undo` together run at most once in total.

**Tests (`tests/toast.test.js`):** use a fake DOM modelled on `tests/v6views.test.js`, plus `t.mock.timers` for `setTimeout`.
- expiry calls `onExpire` once;
- Undo calls `undo` and never `onExpire`;
- a second toast expires the first one;
- `dismiss()` calls `onExpire`;
- calling `dismiss()` twice calls `onExpire` once.

**CSS:**
- `.toast`: fixed position, `bottom: calc(16px + env(safe-area-inset-bottom))`, left and right 16px, card colours, a shadow, `z-index` above `.settings-backdrop` (which is 10).
- `.toast-undo`: min-height 44px.

## Task 3 — `js/itemsheet.js` (DOM)

**Interface:** `openItemSheet(host, item, { todayISO, calendarName = null, googleDayUrl = null, onSave, onDelete, onClose })`.
- `onSave(patch)` returns `{ ok, error }`.

**Structure:**
- Empty `host`, then render `.sheet-backdrop` (role=dialog, aria-modal=true) containing `.sheet`.
- `.sheet` has a **top bar** holding Cancel on the left and Save on the right, so both stay above the keyboard. The form sits below it.
- The sheet is sized so it scrolls internally (CSS below).

**Own item, non-idea:**
- Inputs: title (text), date (date), time (time), end (time), and a **Notes** textarea (`notes`, empty when null). *Amended after Task 1: notes are visible on every sheet, so no edit is ever driven by hidden text.*
- A type `<select>` built from `js/preview.js`'s `TYPES`.
- If `item.type` isn't in `TYPES`, **throw `Error('Unknown type: …')`**. The caller catches it (Task 4a).
- Clearing the start time also clears the end time.
- Below the form: one button per `quickMoves(item, todayISO)` entry, plus a Delete button.

**Own idea:**
- A textarea holding `item.notes ?? item.title`, plus the same type select.
- No time inputs and no quick moves. Delete is present.

**Save and quick moves:**
- The sheet remembers the values it opened with.
- **Save** builds `current` from the inputs:
  - non-idea: `{ title, date, time: time||null, endTime: end||null, type, notes: notesText||null }`;
  - idea: `{ title: text, notes: text, type }`.
- It then sends `onSave(typeChangePatch(item, diffPatch(opened, current)))`.
- **If the diff is empty**, close without calling `onSave`.
- **A quick move** does the same with `date` overridden. It saves any typed changes along with the move.

**External item:**
- Read-only: the title, then `formatDayLabel(date, todayISO)` plus the time range if the item has times, then "From <calendarName>".
- If `googleDayUrl` is set, add `<a href target="_blank" rel="noopener">Open in Google Calendar</a>`.
- A Close button only.

**Closing:**
- On `{ ok: true }`: empty the host, then call `onClose()`.
- On `{ ok: false, error }`: put the error in `.sheet-error` inside the sheet and keep the sheet open.
- **Delete** calls `onDelete()`, empties the host and calls `onClose()`.
- **Cancel, a backdrop click (target === backdrop) or Escape** empty the host and call `onClose()`.
- Remove the `keydown` listener on every close path.

**Tests (`tests/itemsheet.test.js`):**
- fields are prefilled;
- Save sends only the changed fields;
- an unchanged Save closes without calling `onSave`;
- a quick move sends date + typed changes;
- an error keeps the sheet open and shows the text;
- an idea gets a textarea and the right patch;
- idea → task sends a derived title;
- external: no inputs, the calendar name is shown, and the Google link appears only when given;
- an unknown type throws;
- the keydown listener is removed after close.

**CSS:**
- `.sheet`: fixed to the bottom, `max-height: 85dvh`, `overflow-y: auto`, `padding-bottom: env(safe-area-inset-bottom)`.
- `.sheet input, .sheet select, .sheet textarea`: `font-size: 1rem` or more.
- `.sheet button`: `min-height: 44px`.

**CSS tests (`tests/styles.test.js`):**
- First **assert that rules exist** matching `.sheet input`, `.sheet select` and `.sheet textarea`. Then check each font-size is ≥1rem (or ≥16px).
- Assert that `.sheet button` has `min-height ≥ 44px`.

## Task 4a — opening items (views, `index.html`, the sheet)

**`index.html`:** add `<div id="sheet-host"></div>` and `<div id="toast-host" role="status" aria-live="polite"></div>` before the script tag. The live region sits on the persistent host (Task 2 review, O2), and `toast.js` then drops `role` from the toast div.

**Views:**
- Add an `onOpen` option to `renderTodoView`, `renderIdeasView` and `renderDayView`, and use it in app.js's `renderList`.
- The title text becomes `<button type="button" class="item-open">`, which calls `onOpen(it)`. Checkboxes and Delete buttons remain **siblings** of it, never children.
- **Day timed blocks:** the block's text goes in an `.item-open` button inside the block, and the × stays a sibling.
- Each view throws if `onOpen` is not a function. This is a new guard: todoview.js already guards `todayISO`, while dayview and ideasview have no guard today.

**Existing tests:**
- Update `tests/v6views.test.js` and `tests/dayview.test.js` for the required option, test-first.
- **Switch every positional button selector to a class selector.** This covers dayview.test.js:183 and v6views.test.js:155 and :219, and any others you find.

**`app.js` `openItem(item)`:**
- For an external item, look up `feeds.find(f => f.id === item.feedId)`:
  - `calendarName` is `feed ? feed.name : 'a linked calendar'`;
  - `googleDayUrl` is `https://calendar.google.com/calendar/r/day/Y/M/D` (no zero padding) when `feed && inferName(feed.url) === 'Google'`.
- **Before opening, dismiss the active toast** (`if (activeToast) activeToast.dismiss()`), so no Undo can sit over the sheet's buttons (Task 2 review, I3). This follows the rule that only the latest action can be undone. Declare `let activeToast = null` here in 4a; 4b and 4c assign it.
- Wrap `openItemSheet(...)` in `try`. On a throw, call `setMessage(\`This item can't be edited here (${e.message}).\`)`.
- **No feed URL may be passed into the sheet.**
- For now: `onSave` returns `{ ok: false, error: 'Editing arrives in the next step.' }`, and `onDelete` calls the existing `handleDelete`. Tasks 4b and 4c replace both.

**CSS:**
- `.item-open`: reset to look like text. Transparent background, `color: inherit`, `font: inherit`, `text-align: left`, `padding: 0`, `width: 100%`.
- In lists, `min-height: 44px`.
- **`.day-block .item-open, .day-pin .item-open`:** `min-height: 0; line-height: inherit;`, so the title stays visible inside a block about 22px tall.
- Add a styles test for that override.

**Tests (apply.test.js, appended, unique ids):**
- clicking a list item's `.item-open` mounts a `.sheet` in `#sheet-host`;
- an external item's sheet shows the calendar name, and **never** contains the feed URL anywhere in its text or attributes (walk the tree);
- an item with an unknown type shows the message and mounts no sheet.

**Service worker:** add `js/edit.js`, `js/toast.js` and `js/itemsheet.js` to ASSETS. They exist after Tasks 1–3.

## Task 4b — deleting with undo

**`app.js`:**
- `const pendingDeletes = new Set()`.
- `liveItems()` returns `items.filter(it => !pendingDeletes.has(it.id))`. `visibleItems`, `todoItems` and `ideaItems` use it.
- Keep a module-scope `let activeToast = null`, holding the handle from `showToast`.

**`requestDelete(id)`:**
- `pendingDeletes.add(id)`, then `render()`.
- ``activeToast = showToast(els.toastHost, `Deleted "${title}"`, { undo: () => undoDelete(id), onExpire: () => commitDelete(id) })``.

**`undoDelete(id)`:**
- If `pendingDeletes.has(id)`: delete it from the set and `render()`.
- Otherwise: `setMessage("Too late to undo — that delete was already saved.")`.

**`commitDelete(id)`:**
- If `pendingDeletes.has(id)`: delete it from the set and call the existing `handleDelete(id)`. That writes the tombstone first, as it does today.

**Backgrounding:**
- On `visibilitychange` to **hidden**: `if (activeToast) activeToast.dismiss()`. Dismissing runs `onExpire`, which is `commitDelete`, so no stale Undo remains.
- Then commit any ids still pending, as a safety net.
- The visible branch stays as Phase 0 made it.

**CSS (Task 2 review, O1):** give `body` a bottom padding of `calc(96px + env(safe-area-inset-bottom))`, so a toast never covers the last row.

**Call sites:** every existing call site of `handleDelete` in the views (the list Delete, the Day ×, "Other tasks", To-do and Ideas) and the sheet's `onDelete` now call `requestDelete`.

**Tests (unique ids; every test ends with the pending set resolved, by expiry or undo):**
- a delete hides the item from list, day, to-do and ideas, and `loadTombstones()` stays empty;
- after `t.mock.timers.tick(5000)` the tombstone exists and the item is gone from storage;
- Undo before expiry: no tombstone, and the item is visible again;
- **Critical C1:** delete, then fire hidden. The tombstone now exists and the toast host is empty, so there is no stale Undo to click;
- calling `undoDelete` after a commit shows the "Too late" message;
- deleting A, then deleting B, commits A immediately and leaves B pending.

## Task 4c — editing

**`app.js` `editItem(id, patch, { toast = true } = {})`** returns `{ ok, error }`. The steps, in order:
1. If `pendingDeletes.has(id)`, return `{ ok: false, error: 'This item is being deleted.' }`.
2. `const idx = items.findIndex(it => it.id === id)`. Search **`items`, not `liveItems()`**. If `idx < 0`, return `{ ok: false, error: 'This item no longer exists.' }`.
3. `const before = items[idx]`.
4. `let next`, then `try { next = applyEdit(before, typeChangePatch(before, patch), nowISO()) } catch (e) { return { ok: false, error: e.message } }`. **`typeChangePatch` runs HERE, against the current record, not in the sheet.** *Task 3 review I1:* in the sheet it filled missing title/notes from the record as it was when the sheet OPENED, so a type change wrote stale text back over a sync that arrived while the sheet was open. The sheet now sends the raw diff only.
5. `items[idx] = next`, then `try { saveItems(items) } catch (e) { items[idx] = before; return { ok: false, error: e.message } }`.
6. `render()`, then `scheduleSync()`.
7. If `toast`:
   - the undo snapshot is `snapshotOf(before, Object.keys(patch))`;
   - `activeToast = showToast(els.toastHost, 'Saved', { undo: () => { const r = editItem(id, undoSnap, { toast: false }); if (!r.ok) setMessage(r.error); } })`.
8. Return `{ ok: true }`.

**Wiring:** the sheet's `onSave` becomes `(p) => editItem(item.id, p)`.

**Tests (unique ids):**
- a Save through the sheet writes storage, bumps `updatedAt` and schedules a sync (mock `setTimeout`, tick 2000);
- a cleared date leaves storage and `loadItems()` unchanged, and the sheet shows the error;
- **I1:** with an earlier item pending deletion, editing a later item leaves every other record byte-identical, and the edited one correct;
- editing a pending item is refused;
- Undo on an edit restores only the edited field. A field changed by a sync in between is kept: simulate it by saving a changed `date` directly and reloading through the storage listener before clicking Undo;
- a quota failure (a stubbed `setItem` that throws a `QuotaExceededError`) leaves the in-memory list unchanged, shown by re-rendering, and returns the error;
- **Task 3 review I1:** open a task's sheet, change the record's notes via a simulated sync (save + storage listener), then switch the type to idea and Save. The resulting idea text contains the SYNCED notes, not the ones the sheet opened with;
- **I8, the app-level sync test:** after an edit, call `applySyncedState` with a remote copy of that record carrying an older `updatedAt`. Storage and the screen keep the edit.

## Task 5 — two-device sync tests, and invariant docs

**Tests (`tests/editsync.test.js`):** use `merge()`/`toWire()`, like `tests/convergence.test.js`.
- A's edit reaches B **field for field**.
- **Spec § 5.1:** A edits at T1, B ticks at T2 > T1. Both devices end with B's record: `done` is true, and the title is not A's edit.
- **Spec § 5.2:** A deletes at T1, B edits at T2 > T1. The item comes back on both devices with B's fields.

**Docs:**
- Rewrite the "AN EDIT PATH NOW EXISTS" block in `js/merge.js`'s header. It must cover the six editable fields, § 5, the rule that edits send only changed fields, and that `deletedAt` is commit time.
- Update the project `CLAUDE.md` bullet "The app has an EDIT PATH as of V6" to match.

## Task 6 — real-browser verification (the lead does this)

**Setup:** a Chromium isolated context at 390×844 with seeded items.

**Check:**
- editing a title and date moves the item;
- Tomorrow keeps a typed title change;
- a cleared date shows the error;
- delete then undo; delete then expire, then check the tombstone;
- delete, then a hidden `visibilitychange` (dispatched), shows no stale Undo;
- an idea, and changing idea → task;
- an external event on a Google feed shows the link, and a non-Google feed doesn't;
- a Day block title is visible;
- tapping an input inside the sheet doesn't close it;
- no console errors.

**Not coverable here** (no WebKit, no soft keyboard): these go on Alex's return checklist and the punchlist.

## Out of scope

Everything in the brief's out-of-scope list. No merge, push or deploy.
