# Plan: manual add chooses a type (option A), 2026-10-26

Design: `.superpowers/sdd/lead-manualtype-report.md` (main checkout), mockup
https://claude.ai/artifact/Av3NUiUFHGNbYUuU5K3VWS, option A. Alex's picks:
Event / Deadline / To-do chips, "More" reveals Start and Milestone, no Idea,
Event default, reset to Event after each manual Add, manual path only,
capture box unchanged. Branch `manual-type` from ae8f0ee (v6-15). No CACHE bump.

## Shape

- `js/itemsheet.js`: `export` the existing `TYPE_LABELS`. No other change.
- New `js/typechips.js`: `createTypeChips(host)` builds the chips into
  `host` from `preview.js` `TYPES` + `itemsheet.js` `TYPE_LABELS`.
  Offered values only: `PRIMARY = ['event', 'due', 'task']`,
  `MORE = ['start', 'milestone']` (values, never labels). Returns
  `{ value(), reset() }`. Buttons are `type="button"` with `aria-pressed`;
  the group is `role="group"` + `aria-label="Type"`. "More" has
  `aria-expanded="false"`; tapping it shows Start and Milestone and hides
  itself (so a selected chip can never be collapsed out of sight). `reset()`
  selects Event and collapses More. Throws at build if an offered type is not
  in `TYPES` or has no label (zero fallback, like `openItemSheet`'s check).
- `index.html`: `<div id="entry-types" class="type-chips" hidden>` inside
  `.add-box`, after `.add-row`.
- `js/app.js`:
  - `topTarget.type = chips` (capture target: `type: null`).
  - `handleManualAdd(type)` saves `type` instead of `'event'`; on 'added'
    it calls `chips.reset()` and re-hides the row (date is cleared).
  - The row is shown while `els.date.value` is non-empty: listeners on the
    date input's `input` and `change`, plus after a manual add clears it.
- `styles.css`: `.type-chips` flex row, wrap, 6px gap; buttons min-height
  44px, `var(--card)` / `var(--ink)` / `var(--line)`, pressed =
  `var(--accent)` / `var(--accent-ink)` (same tokens as `.seg .active`),
  plus a visible focus ring. Selector keyed on `[aria-pressed="true"]` so
  the visual state cannot drift from the ARIA state.

## Tasks (each test-first, mutation-checked, fresh reviewer)

1. Export TYPE_LABELS; `js/typechips.js` with `tests/typechips.test.js`:
   default Event; tap selects one and unpresses others; More reveals
   Start/Milestone and hides itself; reset; every chip's text is
   `TYPE_LABELS[value]` (imported); every offered value is in `TYPES` and
   never `general` or `idea`; a source scan of `js/` finds the label
   literals `'Deadline'`, `'Milestone'` only in `itemsheet.js` (a fifth copy
   fails).
2. Wire into app.js + index.html + styles.css with `tests/apply.test.js`:
   row hidden with no date, shown with one, hidden after Add; manual Add
   saves each chosen type (Deadline lands on the To-do page); reset to Event
   after Add; refused manual add (no title) does not reset; no date ->
   smart add, chips ignored; capture box Add with the top box's date set
   and Deadline chosen still goes to the Worker and never the manual path;
   styles test for 44px and the pressed selector.
3. Phone-width check in Chrome (375px, light and dark).

## Not in scope
- Mockup frame 3's per-type hint line ("Deadlines show on the To-do page…"):
  not among Alex's picks; it would be a second text table per type.
