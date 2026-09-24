# Plan — fixes from the end-of-branch review sweep (edit-items)

The sweep covered `main...7814470` with five reviewers: sync, dates, UI, secrets and test honesty. The Critical (an undated record crashing the app) is already fixed in 0864d8d. The global rules of `2026-09-23-plaenicke-edit-items.md` apply unchanged:

- test-first;
- mutation-check every new assertion;
- no test-only code;
- commit per batch.

Each batch runs as one implementer, one after another.

## Batch S — sync and data integrity

1. **F1/F2, clock skew.** A new `updatedAt` (in `editItem`, `setDone` and Undo) and a new tombstone `deletedAt` must be **strictly later than the record's current `updatedAt`**. Use `stamp = max(nowISO(), record.updatedAt + 1 ms)`, with one helper in `edit.js` so it isn't copied.
   - Tests: seed a record stamped 60 s in the future. Edit it and let the toast expire, then run `applySyncedState` with the original. The edit must survive. Then the same for a delete: it must stay deleted.
2. **F3, Undo over a newer synced value.** Undo restores a field **only if its current value still equals what the edit wrote** (`next[k]`). If any field is skipped, say so: "Some changes from your other device were kept."
   - Test: save "mine", sync "theirs" (newer), then Undo. The title stays "theirs" and the message is shown.
3. **F4, type changed underneath an open sheet.** Pass the type the sheet opened with (`openItem` knows `item.type`) into `editItem` as `{ openedType }`. If the current record's type differs, refuse: "This item changed on your other device — close and reopen it."
4. **F5, rollback.** `setDone` and `addItems` must not leave an unsaved change in `items` when `saveItems` throws. Restore the previous state, as `editItem` does.
   - Test: a tick fails on quota, then an unrelated edit succeeds. Storage must not hold `done: true`.
5. **F6, prefix boundary.** In `typeChangePatch`, treat the notes as already containing the title only if `notes === title` or the notes start with the title **followed by whitespace**.
   - Test: title "Call" with notes "Calloway about the invoice" keeps both.
6. **Test S-3 (E8).** An idea's text is edited **and** its type switched in one save: the new text wins. Pin this at the unit level (`record.notes` non-null and different from `patch.notes`) and through the real sheet in apply.test.js.
7. **Test S-5.** When going to the background commits a pending delete, the tombstone is written exactly once. Mock `Date` and assert a single `deletedAt`.

## Batch D — dates and staying current

1. **"Updated" stamp.** Stamp from what actually refreshed.
   - After `backgroundSyncFeeds` settles, paint "Updated h:mm" from the **oldest `fetchedAt` across visible feeds**, or "Couldn't refresh calendars" when a fetch failed.
   - With no feeds, keep the render-time stamp.
   - Pin the exact local time with a mocked `Date` (S-9).
2. **Launch log metric.** In Settings, show "Opened on N of the last 7 days" (distinct local days) plus "Last opened <day> <time>". Keep `describeLaunches` pure, and test it across a DST day.
3. **The sheet's "today".** Quick moves compute today at click time, via an injected `today()` function rather than a captured string.
4. **Refresh while on screen.** Call `refreshForToday()` at the top of `render()`. It returns early when nothing changed.
5. **Time zone.** Re-read `DEVICE_TZ` in `refreshForToday`.
6. **Feed fetch guard.** Add an in-flight guard to `backgroundSyncFeeds`, so two quick resumes don't fetch everything twice.
7. **List footer.** Show a human date instead of raw ISO.
8. **Comment** the `read().date || item.date` fallback in `itemsheet.js`, which is intentional.
9. **Tests:**
   - the timezone assertion in `freshness.test.js` runs in a child process with `TZ=Pacific/Kiritimati` (review #10);
   - S-1: week and month cursors follow a resume, and a navigated one stays put;
   - S-2: the Google URL is tested on a fixed date with a single-digit month and day;
   - S-4: a hidden visibilitychange changes no label and no stamp, and fetches nothing;
   - S-12: the launch tests assert differences, not absolute counts;
   - S-8: a stored `{}` reads as `[]`, and Settings opens.
10. **Launch log on a full device:** trim it on `QuotaError` instead of failing.

## Batch U — UI, from the real-browser review

1. **Delete.** Make it readable: `.sheet-delete` gets `background: transparent`, a danger border and danger text.
2. **Button priority.** Save is primary. Cancel, Close, Tomorrow and +1 week are secondary, like `.preview-actions .cancel`.
3. **Link colour.** `.sheet-google` gets `color: var(--accent)`.
4. **Dark mode.** `color-scheme: dark` under `[data-theme="dark"]`, and a darker `--scrim` for dark mode.
5. **Scroll.** While a sheet is open, lock page scroll the same way settings.js does, and restore it on every close path. The sheet gets `overscroll-behavior: contain`.
6. **Focus.** On open, focus the sheet's first control, or its heading for an external item, and keep Tab inside the sheet. On close, focus the re-rendered opener, found by item id.
7. **Backdrop.** It closes only when the pointerdown **also** started on the backdrop. A drag out of an input must not discard the edit.
8. **A real `<form>`,** so Enter saves.
9. **Day blocks.** `.day-block .item-open` and `.day-pin .item-open` align their content to the top-left.
10. **List rows.** The List's `main` div gets `flex: 1`, so the whole row width is tappable.
11. **Type labels.** Human labels in the sheet's type select (Deadline, Start, Milestone, Event, General, To-do, Idea), with values unchanged. Keep `preview.js`'s `TYPES` as the value list.
12. **Dialog.** `role="dialog"` moves onto `.sheet`, with a visible heading. The error sits directly under the top bar, and the sheet scrolls to it on failure.
13. **Toast.**
    - It pauses while it has focus or the pointer is over it.
    - The live region announces only the message, not "Undo".
    - The Undo button is still 44px.
14. **Google link.**
    - `rel="noopener noreferrer"`.
    - The link is offered only for a host of exactly `calendar.google.com` or one ending in `.google.com`.
15. **External sheet.** Bottom margin after the last element.
16. **Tests:**
    - S-10: `#toast-host`'s role and `aria-live`, and `.sheet-error`'s `role="alert"`, are pinned;
    - a malformed onSave result throws;
    - S-11: the `styles.test.js` helpers read the **winning** declaration (the last in cascade order, including shorthands), with `.toast-undo` 44px and `.sheet-error:empty` pinned;
    - secrets F4: the feed-URL scan also covers `#message` and `#toast-host`.

## Deferred (each names its blocker; all go to the punchlist)

- **The iOS keyboard against the bottom sheet, and empty time inputs collapsing in WebKit.** Blocker: needs the physical iPhone. This session has no WebKit engine.
- **The Day × stays 19px.** Blocker: it can't reach 44px inside a 22px block without a layout redesign. That is Phase 1/3 design, which Alex hasn't decided.
- **Tapping items in the Month and Week views.** Blocker: outside the approved spec's scope (§ 3.4); it's a new feature.
- **Rejecting a feed name that is a URL** (secrets F3). Blocker: it's settings.js code outside this diff, and only reachable if the user pastes the URL into the name box.
- **The two-tab race on the timer-driven commit** (sync F8). Blocker: speculative. It can't be reproduced without a real browser `storage` event, and there's no multi-tab harness.
- **Pausing the toast timer for keyboard users** is in Batch U. Full WCAG 2.2.1 compliance (an adjustable time limit) is **not** attempted.
