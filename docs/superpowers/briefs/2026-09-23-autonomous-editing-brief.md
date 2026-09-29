# Autonomous run brief — editing (2026-09-23)

## The authorization

Alex, verbatim: "for this session i want you to work for longer accomplish as much as you can by yourself work in autonomous mode".

This was given right after I proposed an order for his request "I also want to be able to edit stuff that is already on my calendar". He answered that he wants to edit **both** his own items **and** linked-calendar events, and that edits to linked events should **change them in Google too**.

## What I will do, in order

1. **Phase 0.** Already built. Committed to `feature/phase0-today-fresh` (036b82b). Not merged.
2. **Project A — edit your own items.** Spec, then plan, then a devil's-advocate review of the plan, then adjudication, then implementation (test-first), then a review sweep. Built on `feature/edit-items`, branched from Phase 0.
3. **Linked events, the cheap part.** Tapping a linked event shows which calendar it came from. Google calendars also get an **"Open in Google Calendar"** link to that day. This rides in Project A's item sheet.
4. **Project B — Google read and write through Google's API.** Research and a written spec only. Building it needs a Google Cloud project, an OAuth client and consent-screen setup under Alex's own Google account, plus Worker secrets. I can't create those, so they get flagged `[AUTONOMOUS-BLOCKED]`.

## Committed assumptions (correct any of these on return)

- **Nothing reaches production.** No merge to `main` (merging is the deploy), no `git push`, no `wrangler deploy`. Everything lands on local feature branches. Undoing any of it is a branch delete.
- **Editable fields in A:** title, date, start time, end time, type and notes. Not project, subject or category. They're rarely wrong, and every extra editable field widens the sync-conflict surface.
- **How edits sync:** whole-record last-write-wins, with `updatedAt` bumped on every edit, and `schemaVersion` staying 1. The known cost gets written down in `merge.js`'s header: if one device edits an item and the other device edits or ticks it before they sync, one of the two changes is lost. Per-field timestamps were considered and rejected for this run. They change what `merge()` means and would need a `schemaVersion` bump coordinated across both devices.
- **Every edit goes through `makeItem`** (plus `normalizeIdea`), so an edit can never store a record that couldn't have been created.
- **Undoing a delete:** the tombstone is written only when the undo toast expires. If the app closes during that window, the item survives, which is the safe direction to fail in.
- **Moving an item:** quick "Tomorrow" and "+1 week" buttons, plus a date field. Drag-to-move is out of scope.
- **Where the sheet opens:** tapping an item in List, Day (timed blocks and "Other tasks"), To-do and Ideas. Month and Week stay as they are: a tap there opens the Day.
- **Linked events are read-only in A.** Changing them means Project B.
- The UI follows the research report's direction (bottom sheet, 44pt targets, 16px inputs). This is not the full visual redesign.

## Out of scope for this run

- Phase 1 (the Today home screen and tab bar)
- Phase 3 (the visual redesign)
- A Completed section on the To-do page
- Search
- Drag-to-move
- Recurring items of your own
- Everything in Project B beyond the spec
