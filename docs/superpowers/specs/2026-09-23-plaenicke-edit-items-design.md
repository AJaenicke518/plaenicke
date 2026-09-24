# plaenicke — editing your own items (Project A)

**Date:** 2026-09-23
**Status:** Written during an autonomous run. The gates were a devil's-advocate review (on the plan) and an end-of-branch review sweep; Alex has not reviewed it yet.
**Brief:** `docs/superpowers/briefs/2026-09-23-autonomous-editing-brief.md`
**Research:** `docs/superpowers/research/2026-09-23-plaenicke-ui-research.md` (Phase 2)
**Baseline:** branch `feature/phase0-today-fresh` at 036b82b.
**Superseded in detail by the plan (revision 2)**, which folds in the devil's-advocate review. Where they disagree, the plan wins.

## 1. Goal

Alex's words: "I also want to be able to edit stuff that is already on my calendar." Today the only edit is the To-do checkbox. A typo or a wrong date means deleting the item and typing it again. A hand-retyped to-do also comes back as `general`, which drops it from the To-do page.

**Success means:** tap any item you created, change its title, date, time, type or text, and save. Moving it to tomorrow or next week takes one tap. A mistaken delete or edit can be undone for 5 seconds. Tapping a linked-calendar event tells you which calendar it came from, and for Google calendars it offers to open that day in Google Calendar.

**Non-goals:** editing linked events (Project B); drag-to-move; editing project, subject or category; a Completed section; bulk edits; recurrence.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Sync semantics | **Whole-record last-write-wins; bump `updatedAt` on every edit; `schemaVersion` stays 1** | Per-field timestamps change what `merge()` means for a device on old code. That would need a coordinated `schemaVersion` bump and new convergence coverage in the most defect-prone module. The loss case (§ 5) needs the *same* item changed on both devices before either syncs, and there is one user. |
| Validation | **Every edit is rebuilt through `makeItem`** (and `normalizeIdea`) | An in-place patch skips the date/time guards and could store `date: ''` from a cleared date box, the third date state CLAUDE.md warns about. |
| Where the write lands | **`app.js`, on its module-scope `items`**, same shape as `setDone` | The ownership invariant: app.js owns `plaenicke.items`. |
| Undoing a delete | **Deferred commit.** The item is hidden at once; the tombstone is written when the 5 s toast expires, or when the app is backgrounded. | Nothing to un-tombstone. If the app dies inside the window, the item survives, which is the safe direction to fail in. |
| Undoing an edit | **Re-apply the previous field values as a new edit** | Uses the same path; no special case in merge. |
| What opens the sheet | **A label button beside the row's controls, never wrapping them** | The fake DOMs don't bubble events. A handler wrapping a Delete button or checkbox would pass every test and, in a browser, open the sheet on every delete. |
| Linked events | **Read-only sheet: title, time, calendar name. "Open in Google Calendar" when the feed's host is Google.** | Feed URLs are never rendered. Only `inferName(url)` looks at the host, and it already exists. |

## 3. Components

### 3.1 `js/edit.js` (new, pure)
- `EDITABLE_FIELDS = ['title', 'date', 'time', 'endTime', 'type', 'notes']`
- `applyEdit(record, patch, updatedAt)`: keeps only editable keys from `patch`, runs `normalizeIdea` on the merged fields, and rebuilds through `makeItem(merged, { id: record.id, createdAt: record.createdAt, updatedAt })`. It throws exactly what `makeItem` throws. It preserves `done`, `project`, `subject` and `category` from the record. It never mutates `record`.
- `quickMoves(record, todayISO)` returns `[{label:'Tomorrow', date}, {label:'+1 week', date}]`. "+1 week" is relative to the **item's** date; "Tomorrow" is relative to **today**.
- `editableSnapshot(record)` returns the record's editable fields, and is what an edit's undo re-applies.

### 3.2 `js/itemsheet.js` (new, DOM, presentation only)
`openItemSheet(host, item, opts)` mounts a bottom sheet into `host`. It never writes storage.
- **Own item** (`!item.external`): a form with title (text), date, start, end, a type `<select>` (from `preview.js`'s `TYPES`, so the list isn't copied a fifth time), and Save / Cancel / Delete. Also Tomorrow and +1 week buttons, which save immediately.
  - **An idea** shows a single textarea holding the full text (`notes ?? title`) in place of title/time/type. Saving sends `{ title: text, notes: text }` and `normalizeIdea` derives the label.
- **External item:** read-only. Shows title, date, time range, and "From <calendar name>". If `opts.googleDayUrl` is given (it opens the browser's *default* Google account, which may not be the account behind the feed), it adds an `<a target="_blank" rel="noopener">` "Open in Google Calendar".
- **Callbacks:**
  - `opts.onSave(patch)` returns `{ ok: true }` or `{ ok: false, error }`. On failure the sheet stays open and shows the error inline, in the sheet, not in the top `#message`.
  - `opts.onDelete()` and `opts.onClose()`.
- **Closing:** Cancel, a backdrop tap, or Escape. Only one sheet at a time: mounting empties `host`.
- **Sizes:** every input is ≥16px (no iOS zoom) and every button is ≥44px tall.

### 3.3 `js/toast.js` (new, DOM)
`showToast(host, text, { undo, ms = 5000, onExpire })`: one toast at a time. A new toast **expires the previous one first**, running its `onExpire`, so a pending delete is never silently dropped. The Undo button calls `undo` and cancels `onExpire`. The toast is placed above the bottom safe area.

### 3.4 `js/app.js` changes
- `editItem(id, patch)`:
  - Finds the record in live `items`, `applyEdit`s with `nowISO()`, replaces it at the same index, then `saveItems`, `render`, `scheduleSync`.
  - Returns `{ ok, error }` (it catches `makeItem`'s throw).
  - Shows a "Saved" toast whose Undo re-applies the previous `editableSnapshot`.
- **Pending deletes:** a module-scope `Map(id → true)`.
  - Deleting adds the id, re-renders and shows "Deleted · Undo". Expiry calls the existing `deleteItem(id)` (tombstone first, as now).
  - Undo removes the id and re-renders.
  - `visibilitychange → hidden` commits every pending delete.
  - One helper, `liveItems()`, which is `items` minus pending ids. It feeds `visibleItems`, `todoItems` and `ideaItems`, so a pending item disappears from **every** view.
  - The existing per-row Delete buttons and the Day × route through the pending path too.
- `openItem(item)` builds the sheet options:
  - The external calendar name comes from the `feeds` lookup by `feedId`.
  - The Google URL is `https://calendar.google.com/calendar/r/day/Y/M/D`, built only when `inferName(feed.url) === 'Google'`.
- Every view receives `onOpen(item)`: list rows, To-do rows, Ideas rows, Day timed blocks and Day "Other tasks" rows.

### 3.5 Views
`app.js`'s `renderList`, `todoview.js`, `ideasview.js` and `dayview.js` each wrap their title text in `<button type="button" class="item-open">`, which calls `onOpen(item)`. Delete buttons and checkboxes stay siblings of that button. `.item-open` is reset to look like text: transparent background, inherited colour and font, left-aligned, full width, min-height 44px in lists.

### 3.6 Invariant documentation
- `js/merge.js` header: "an edit path exists and it is exactly one boolean" becomes "title, date, time, end time, type and notes are editable". State the consequences in § 5.
- The project CLAUDE.md bullet about the edit path gets the same update.

## 4. Data flow
Tap label → `openItem(item)` → the sheet mounts into `#sheet-host` → Save → `onSave(patch)` → `editItem` → `applyEdit` (makeItem) → replace in `items` → `saveItems` → `render()` → `scheduleSync()` (2 s debounce) → `syncOnce` pushes the whole record with its new `updatedAt`.

## 5. What can go wrong in sync, and what we accept

Traced against `merge.js`. Edits on the **same** item on two devices before either syncs:

1. **Edit on A, tick (or edit) on B.** Last-write-wins on `updatedAt`, so the later one wins whole and the other change is lost. *Accepted.* It needs the same item on both devices inside one sync window.
2. **Delete on A, edit on B after the delete but before syncing.** `applyTombstones` keeps records whose `updatedAt ≥ deletedAt`, so the item comes back, with B's edits, on every device. *Accepted*, the same class as the V6 checkbox. The item is re-deletable, and no data is lost.
3. **Clock skew** decides ties (already documented).
4. **Only the latest action can be undone.** A second toast commits the first action at once, so its delete lands and its Undo is gone.
5. **`deletedAt` is when the delete commits, not when you tapped.** If a sync brings another device's edit to an item during its 5 s window, the commit still deletes it, because the commit is later than the edit.
6. **Edits send only changed fields.** A field that changed through a sync while the sheet was open is not written back.

No new tombstone kinds, no new arrays, no `schemaVersion` change. A device running pre-edit code receives edited records as ordinary newer records. `deserializeItems` and `unionById` pass them through whole.

## 6. Error handling
- A validation failure (empty title, cleared date, end ≤ start, a bad time) shows inline in the sheet, and nothing is written.
- `QuotaError` from `saveItems`: `editItem` returns `{ ok: false, error }`, the sheet shows it, and `items` is restored to the pre-edit record. **The array must not keep an unsaved edit.** A later successful save would write it without the user having seen it succeed.
- An edit whose id vanished (deleted by a sync while the sheet was open) returns `{ ok: false, error: 'This item no longer exists.' }`.

## 7. Testing
- `edit.js`, table-tested:
  - it preserves done, project, subject, category, id and createdAt;
  - it bumps `updatedAt`;
  - it rejects `''` dates, end ≤ start, empty titles;
  - `normalizeIdea` runs on ideas;
  - non-editable keys in the patch are ignored;
  - `record` is not mutated;
  - quick moves (month and year boundaries).
- `itemsheet.js` in a fake DOM:
  - the own-item form versus the idea textarea versus the external read-only sheet;
  - Save builds exactly the patch;
  - an inline error keeps the sheet open;
  - the Google link appears only when given, and never contains a feed URL;
  - every input's font size is ≥16px (checked in styles.css).
- `toast.js`: expiry, undo cancels expiry, a new toast expires the old one.
- `app.js` (apply.test.js harness):
  - an edit writes storage, bumps `updatedAt` and schedules a sync;
  - an invalid edit leaves storage and the array unchanged;
  - a quota failure leaves the array unchanged;
  - a pending delete hides the item from list, day, to-do and ideas views, writes no tombstone until expiry, then writes one;
  - undo leaves no tombstone;
  - backgrounding commits pending deletes;
  - Undo on an edit restores the previous values;
  - the label opens the sheet; the Delete button does not.
- **Two-device sync, through `applySyncedState`, not just `merge()`:**
  - an edit on A reaches B field-for-field;
  - pin § 5.1 and § 5.2 as known behaviour.
- Mutation-check every new assertion. Real-browser check at iPhone size before calling it done.
