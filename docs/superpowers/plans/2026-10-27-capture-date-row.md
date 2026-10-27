# Capture date row: plan (2026-10-27)

Alex approved mockup C2 (https://claude.ai/artifact/8BZxdUUFpeCmkCxpay6BkL). Controller rulings Q1-Q5 apply.

## What changes
- The top add box is removed: `.add-box` (`#entry-text`, `#entry-date`, `#entry-time`, `#entry-end`, `#add-btn`, `#entry-types`, the hint) and `#preview`.
- `#message` becomes `#status-line` (`.status-line`, `role="status"`), under `#sync-indicator`. It collapses with `:empty`. Every `setMessage` caller writes to it. It clears on a tab-bar switch (Q4).
- The capture box gets `#capture-when` (hidden; `#capture-date`, `#capture-time` in `.cap-field` labels) and `#capture-types` (the chips, hidden until a date is picked, as on main: Q1 C2). No end time (Q3, a controller default).
- The row shows on typing focus of the field (not while read-only/listening), on field input, inside every focusField tap, and after a smart-add "unavailable" failure. It does not show when a listen ends on its own (Q2).
- x/close hides the row, clears date and time, and resets the chips (Q5).
- `captureTarget` takes the `dates` and `type` that `topTarget` had. `topTarget` is removed. `handleManualAdd` reads from the target and writes to its line; a landed manual add calls `target.onAdded()` so the box closes, as a direct smart add does.
- The `unavailable` text becomes "Smart add is unavailable. Pick a date to save it without smart add."
- `CAPTURE_MAX_SHARE` is unchanged. CACHE is not bumped.

## Tasks
1. capture.js: `els.when` (required) and `clearWhen` (required callback); `showWhen()` on the returned API; show/hide rules above. Test first in tests/capture.test.js.
2. index.html, styles.css, app.js wiring; tests/styles.test.js control lists move from `#entry-*` to `.cap-field input`; tests/apply.test.js tests move from the top box to the capture box's typing mode. Tests whose scenario needs two boxes at once (the top box superseding the capture box, a second Add while the first is pending, the top box's preview) are rewritten to the nearest single-box scenario where one exists, or removed with the reason, and each is listed in the report.
3. Spec § 3 note and the report.

## Not touched
`applySyncedState`, createdAt, press.js, Settings CSS (parallel branches).
