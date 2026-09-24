# Plan — editing your own items (Project A)

**Spec:** `docs/superpowers/specs/2026-09-23-plaenicke-edit-items-design.md`. Read it first; this plan does not restate the reasoning.
**Branch:** `feature/edit-items`, branched from `feature/phase0-today-fresh`.
**Global rules for every task:**

- **Test-first.**
  - Write the test, run it and see it fail for the right reason. Then implement.
  - Use `node --test <file>` for one file and `npm test` for the whole suite (it recurses). **Never use `node --test tests/`**: it runs 0 tests.
- **Mutation-check every new assertion.**
  - Plant the wrong implementation, see a test fail, restore, and **verify the restore** with `git diff` against your intended change.
  - Never leave a mutant in the tree. Run tests in the foreground only.
- **Storage-touching tests** need `installFakeLocalStorage()` from `tests/fake-localstorage.js`.
- **Ownership.** `app.js` is the only writer of `plaenicke.items`. View modules and `itemsheet.js` never touch storage.
- **Inputs, fields and classes.**
  - Every input or select in new UI must have a computed font-size of at least 16px.
  - `makeItem` is a 13-key whitelist, so don't add item fields.
  - `itemTypeClass` returns more than one token, so assign it with `className`, never `classList.add`.
- **New modules** go in `service-worker.js` ASSETS. CACHE stays at `plaenicke-v6-2`, which is unreleased and already ahead of main.
- **Commit at the end of each task** with a descriptive message ending in the Co-Authored-By line. **Never** merge, push or deploy.
- **Report back:** the files changed, the test counts before and after, which mutants were killed, and anything you deviated from, with the reason.

---

## Task 1 — `js/edit.js` (pure)

**Interface:**
```js
export const EDITABLE_FIELDS; // ['title','date','time','endTime','type','notes']
export function applyEdit(record, patch, updatedAt) // -> new record; throws makeItem's errors
export function editableSnapshot(record)            // -> { title, date, time, endTime, type, notes }
export function quickMoves(record, todayISO)        // -> [{ label: 'Tomorrow', date }, { label: '+1 week', date }]
```
- `applyEdit` picks only `EDITABLE_FIELDS` keys from `patch`, then builds `merged = { ...record, ...picked }`. It then calls `makeItem(normalizeIdea(merged), { id: record.id, createdAt: record.createdAt, updatedAt })`. `done`, `project`, `subject` and `category` come through `makeItem` from `merged`.
- The `Tomorrow` date is `addDays(todayISO, 1)`. The `+1 week` date is `addDays(record.date, 7)`. Use `js/timegrid.js`'s `addDays`.

**Tests (`tests/edit.test.js`):**
- **Preserved:** `id`, `createdAt`, `done: true`, `project`, `subject` and `category` survive an edit.
- **Timestamp:** `updatedAt` is the value passed in.
- **Ignored keys:** `id`, `createdAt`, `done` and `updatedAt` in the patch have no effect.
- **Rejected:** a `date: ''` patch throws `/Date is required/`; an end time at or before the start throws; an empty title throws.
- **Not mutated:** `record` is unchanged after the call (use `deepEqual` against a copy).
- **Ideas:** an idea edited with `{ title: long, notes: long }` gets `title` derived and `notes` holding the full text.
- **Quick moves:** they cross month and year boundaries correctly.

**Success:** all green, and the mutants are killed. Suggested mutants: spreading `patch` without the key filter; dropping `normalizeIdea`; taking `updatedAt` from `record`.

## Task 2 — `js/toast.js` (DOM)

**Interface:** `showToast(host, text, { undo = null, ms = 5000, onExpire = null })` returns `{ dismiss() }`.
- It renders `<div class="toast" role="status">` containing a text span and, if `undo` is set, a `<button class="toast-undo">Undo</button>`.
- **Undo:** clears the timer, empties the host and calls `undo()`. `onExpire` is not called.
- **Timeout:** empties the host and calls `onExpire()`.
- **Replacing a toast:** a second `showToast` on the same host first runs the previous toast's `onExpire` synchronously, then replaces it. Track the current toast per host in a WeakMap.
- **`dismiss()`:** expires early, running `onExpire`.

**Tests (`tests/toast.test.js`):** use a fake DOM like `tests/v6views.test.js`'s, and `t.mock.timers` for setTimeout.
- expiry after `ms` runs `onExpire` once;
- Undo runs `undo` and never `onExpire`, even after the time passes;
- a second toast expires the first (its `onExpire` runs) before rendering;
- `dismiss()` runs `onExpire`.

**CSS:** `.toast` is fixed at the bottom with `bottom: calc(16px + env(safe-area-inset-bottom))`, uses the card colours and a shadow, and has a 44px-tall Undo button.

## Task 3 — `js/itemsheet.js` (DOM)

**Interface:** `openItemSheet(host, item, { todayISO, calendarName = null, googleDayUrl = null, onSave, onDelete, onClose })`.
- `onSave(patch)` returns `{ ok, error }`.
- **Empties `host`**, then renders `.sheet-backdrop` (role=dialog, aria-modal) containing `.sheet`.
- **Own item** (`!item.external`, and `type !== 'idea'`):
  - Inputs: title (text), date (date), time (time) and end (time), each pre-filled.
  - A type `<select>` from `preview.js`'s `TYPES`, with the item's type selected. **If the type isn't in `TYPES`, throw.** Don't render a select that shows the wrong option.
  - Buttons: Save, Cancel, Delete, plus one button per `quickMoves(item, todayISO)` entry. A quick-move button calls `onSave({ date })` directly.
  - Save builds `{ title, date, time: time||null, endTime: end||null, type }`.
  - Clearing start also clears end, the same as `preview.js` does.
- **Idea:** one textarea with `item.notes ?? item.title`. Save sends `{ title: text, notes: text }`. Cancel and Delete are the same as above; there are no quick moves.
- **External:** read-only. Shows title, `formatDayLabel(date, todayISO)` plus the time range if timed, and "From <calendarName>". If `googleDayUrl` is given, adds `<a href=googleDayUrl target=_blank rel=noopener>Open in Google Calendar</a>`. Has a Close button only.
- **After Save:**
  - On `{ ok: true }`: empty the host and call `onClose()`.
  - On `{ ok: false, error }`: show the error in a `.sheet-error` element inside the sheet and leave the sheet open.
- **Closing:** Delete calls `onDelete()`, then empties the host and calls `onClose()`. Cancel, a backdrop click (the target is the backdrop itself) or Escape empties the host and calls `onClose()`. Remove the keydown listener on close.

**Tests (`tests/itemsheet.test.js`):**
- the form fields are pre-filled;
- Save sends the exact patch;
- a quick move sends `{ date }`;
- an error keeps the sheet open and shows the text;
- an idea gets one textarea and its patch;
- an external item has no inputs, shows the calendar name, and shows the Google link only when a URL is passed;
- an unknown type throws;
- the Escape listener is removed after close.

**CSS test (`tests/styles.test.js`):** every `.sheet` input, select and textarea rule sets a font-size of at least 1rem, and `.sheet button` has a min-height of at least 44px.

## Task 4 — wiring in `app.js`, the views, `index.html` and the service worker

**`index.html`:** add `<div id="sheet-host"></div>` and `<div id="toast-host"></div>` before the script tag.

**`app.js`:**
- **`liveItems()`** returns `items` minus `pendingDeletes`. `visibleItems`, `todoItems` and `ideaItems` use it.
- **`editItem(id, patch)`** returns `{ ok, error }`:
  - Find the index in live `items`. If it's missing, return `{ ok: false, error: 'This item no longer exists.' }`.
  - `const before = items[idx]`, then `const next = applyEdit(before, patch, nowISO())`. Catch `makeItem`'s throw and return `{ ok: false, error: e.message }`.
  - Set `items[idx] = next`, then `saveItems(items)`. On a throw, restore `items[idx] = before` and return `{ ok: false, error }`.
  - `render()`, `scheduleSync()`.
  - Show the toast `Saved`, whose undo calls `editItem(id, editableSnapshot(before))`, with no toast for the undo.
  - Return `{ ok: true }`.
- **`requestDelete(id)`:**
  - Add the id to `pendingDeletes`, `render()`.
  - Show the toast `Deleted` with `undo: () => { pendingDeletes.delete(id); render(); }` and `onExpire: () => commitDelete(id)`.
- **`commitDelete(id)`:** if the id is still pending, remove it from `pendingDeletes` and call the existing `handleDelete(id)`.
- **Backgrounding:** on `visibilitychange` to hidden, commit every pending id.
- **The existing `handleDelete` call sites** (the list Delete, the Day ×, To-do and Ideas) now call `requestDelete`.
- **`openItem(item)`:**
  - An external item gets `feeds.find(f => f.id === item.feedId)`. `calendarName` is that feed's name, or `'a linked calendar'` if the feed is missing. `googleDayUrl` is set when `inferName(feed.url) === 'Google'`.
  - `openItemSheet(els.sheetHost, item, { todayISO, calendarName, googleDayUrl, onSave: (p) => editItem(item.id, p), onDelete: () => requestDelete(item.id), onClose() {} })`.
  - **A feed URL must never be passed into the sheet.**

**Views:** add an `onOpen` option to `renderTodoView`, `renderIdeasView` and `renderDayView`, and use it in `renderList`.
- The title text becomes `<button type="button" class="item-open">`, which calls `onOpen(it)`. Its sibling controls stay siblings.
- In `dayview.js`, the timed block's text goes into an `.item-open` button inside the block, and the × stays a sibling.
- **Missing option:** a view given no `onOpen` throws, the same as `todayISO` does.

**Service worker ASSETS:** add `js/edit.js`, `js/toast.js` and `js/itemsheet.js`.

**Tests (`tests/apply.test.js`, appended; reuse the file's `seed`, `click`, `record` and `allText` helpers):**
- clicking a list item's `.item-open` mounts a `.sheet` in `#sheet-host`, and clicking its Delete does not;
- `editItem` through the sheet's Save writes storage, bumps `updatedAt` and schedules a sync (mock `setTimeout` and tick 2000, as the existing tick test does);
- an invalid Save (a cleared date) leaves storage and `loadItems()` unchanged, and the sheet shows the error;
- Delete hides the item from every view **and** `loadTombstones()` stays empty. After the toast expires (mock timers tick 5000), the tombstone exists and the item is gone from storage;
- Undo before expiry: no tombstone, and the item is visible again;
- `visibilitychange` to hidden commits pending deletes;
- the Undo on an edit restores the previous title in storage;
- an external item's sheet shows the calendar name, and never contains the feed's URL anywhere in its text or attributes.

Update `tests/v6views.test.js` and `tests/dayview.test.js` for the new required `onOpen`, test-first: first a test that a view refuses a missing `onOpen`, then one that the label calls it.

## Task 5 — two-device sync, and invariant docs

**Tests (`tests/editsync.test.js`):** two simulated devices, each with its own fake localStorage snapshot, synced through `merge()`/`toWire()` the way `tests/convergence.test.js` does.
- **Field-level:** an edit on A (a new title and date, with a bumped `updatedAt`) appears on B with exactly those field values after a sync.
- **§ 5.1 pinned:** an edit on A at T1 and a tick on B at T2 > T1 leave both devices with B's record: done is true, and the title is **not** A's edit.
- **§ 5.2 pinned:** a delete on A at T1 and an edit on B at T2 > T1 bring the item back on both devices with B's fields.

**Docs:**
- Rewrite the "AN EDIT PATH NOW EXISTS" block in `js/merge.js`'s header to cover the six editable fields and § 5's consequences.
- Update the project `CLAUDE.md` bullet "The app has an EDIT PATH as of V6" to match.

## Task 6 — real-browser verification (the lead does this, not a subagent)

Serve locally on a free port, in an isolated browser context at 390×844, with seeded items. Then check:
- edit the title and date, and see it move;
- use Tomorrow;
- a cleared date shows the error;
- delete, then undo, then delete and let it expire, and check localStorage for the tombstone;
- open an idea;
- open an external event with a Google feed;
- no console errors.

## Out of scope
Everything in the brief's out-of-scope list. No merge, push or deploy.
