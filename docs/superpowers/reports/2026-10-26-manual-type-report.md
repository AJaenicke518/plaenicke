# Report: manual add chooses a type (option A), 2026-10-26

Branch `manual-type`, cut from `main` at ae8f0ee (v6-15). CACHE not bumped
(`service-worker.js` still `plaenicke-v6-15`; only `js/typechips.js` was added
to `ASSETS`, which `tests/serviceworker.test.js` requires of every js/ module).

## What was built

- **Chips under the top add box's date row** (`#entry-types`, built by new
  `js/typechips.js`): Event / Deadline / To-do, plus More. More reveals Start
  and Milestone, hides itself, and moves focus to Start. Idea and general are
  not offered.
- **Shown only while a date is picked.** `app.js` re-reads the date box on
  `input`, `change`, `pageshow` and after a manual add; `index.html` starts
  the row `hidden`.
- **Event default. Reset to Event** after every manual Add that lands, and
  whenever the row hides (date cleared), so a choice the user can no longer
  see is never saved or brought back. A refused manual Add (no title) keeps
  the choice.
- **Manual path only.** `handleAdd` reads `target.type` inside the
  `dates && dates.date.value` branch; `captureTarget.type` is `null` and the
  capture box has no date row. Smart add keeps the Worker's type.
- **No fifth copy.** `TYPE_LABELS` is now exported from `js/itemsheet.js`
  (unchanged otherwise) and the chips read it at build time.
  `tests/typechips.test.js` pins this three ways: a test that relabels
  `TYPE_LABELS.due` and sees the chip follow; a scan of every file under
  `js/` (recursive) and `index.html` for the label words Deadline/Milestone
  outside `itemsheet.js`; a scan for any string list of 3+ type values outside
  `preview.js`, `items.js`, `typechips.js`. Limits stated in the test comment:
  concatenated labels, or a relabelled map with under three values, are not
  caught.
- **A11y / phone:** real `<button type="button">`s with `aria-pressed` in a
  `role="group" aria-label="Type"`; More carries `aria-expanded`. Chips are
  44px tall in token colours (`--card`/`--ink`/`--line`, selected
  `--accent`/`--accent-ink`, keyed on `[aria-pressed="true"]`). `[hidden]` is
  restated for the row and each chip. No new inputs (16px rule unaffected).

Files: `js/typechips.js` (new), `js/itemsheet.js` (one `export`), `js/app.js`
(import, `els.types`, `syncTypeRow`, `handleManualAdd(type)`, two target
fields, three listeners), `index.html` (one div), `styles.css` (one block
after the `#entry-date, #entry-time, #entry-end` rule), `service-worker.js` (ASSETS), tests in
`tests/typechips.test.js` (new), `tests/apply.test.js`, `tests/styles.test.js`.

## Tests and mutation checks

Gate at the report commit: `npm test` -> `# tests 1758`, `# pass 1758`,
`# fail 0`, `# cancelled 0` (main at ae8f0ee: 1736). The seven new
`apply.test.js` tests also pass run on their own (`--test-name-pattern`). Every new assertion was
mutation-checked by planting the bug and seeing the named test fail. Killed:
labels hard-coded in typechips.js; pressed state not cleared; More not hiding;
no focus move; chip click folding More; reset not folding; idea offered;
host not cleared; group unnamed; chip not `type="button"`; both
`assertOffered` throws; label and value copies planted in `js/today.js`;
manual add hard-coding `'event'`; no `syncTypeRow()` (hide + reset) after Add; no reset on hide; no
`change` listener; no `pageshow` listener; `index.html` row not hidden; the
capture box reaching the manual path; smart add overwritten with the chip
value; `.type-chips[hidden]` rule removed; selected state keyed on a class.

**Surviving mutants (accepted, stated):**
- `handleManualAdd(typeChips.value())` in place of `target.type.value()`:
  behaviourally identical, since only the top box reaches that branch.
- Removing the `OFFERED_TYPES` guard in `handleManualAdd`: unreachable
  through the UI; it exists so a broken chip value fails loudly instead of
  `makeItem` turning it into `general`.

## Reviews

- **Plan DA** (`jaeger:devil-advocate-reviewer`, on 490a6de): 1 blocker, 4
  important, 3 minor. Adopted: `[hidden]` restated in CSS (blocker); visibility
  re-read on `pageshow`; tests clean up chip state in `finally`; reset when the
  row hides (closes the "hidden Deadline comes back" path, and makes the
  question of whether a smart Add should reset moot: with no date the chips
  are always on Event); relabel test + wider scans; offered-type guard;
  `target.type` read only in the manual branch. Not done: iPhone check of
  Safari's date-picker Reset firing `input` (no device here; see open items).
- **Task 1 reviewer** (fresh, opus): focus loss when More hides (fixed),
  untested "selected Milestone stays visible" (pinned), scan weaknesses
  (comment stripping removed, recursive, index.html, value-list scan),
  untested throws (`assertOffered` exported and tested). Noted only:
  `aria-pressed` vs radio roles (the owner's stated choice).
- **Task 2 reviewer** (fresh, opus, on d4fef09; 12 of 16 mutants killed):
  the first chip test passed only because of earlier tests (fixed: it clears
  the box itself; the seven new apply tests pass run on their own); a
  duplicate `typeChips.reset()` in `handleManualAdd` (removed, `syncTypeRow`
  resets); selected `border-color` unpinned (pinned); the chip CSS sat
  between `.add-row` and the `#entry-date` rule (moved below it to keep off
  lines other branches edit). Its Milestone-alone-on-a-row finding had
  already been fixed in the task 3 commit.
- **Final branch review** (fresh, opus, ae8f0ee..b26f98b; gate 1758/0/0;
  re-ran two mutants, both killed). Verdict: ready to merge once the report
  was complete. Fixed: report placeholders (this section and the gate line);
  the new capture test had split the "LAST of the capture tests" comment from
  the refusal test (moved; the refusal test was and is last);
  `createTypeChips`' doc comment sat on `assertOffered` (moved); the file
  summary named the wrong CSS position (corrected). Stated rather than
  changed: the plan's "visible focus ring" (see deviations) and the
  repo `CLAUDE.md` wording (open item 3; not edited by this lead).

## Deviations from the plan

- No custom focus ring. The plan said "plus a visible focus ring"; no rule
  was added, so chips use the browser's default focus ring, as every other
  button in the app does (styles.css has no focus/outline rule anywhere).
  Seen in Chrome: the focused Start chip shows the default ring.
- `.type-chip` uses `flex: 1 1 24%` rather than equal widths, after the
  375px measurement below.
- The load-time `syncTypeRow()` call was dropped in favour of `pageshow`
  (fires on every load) plus `hidden` in `index.html`; a load-time call
  could not be tested apart from those two.

## Phone-width check (Chrome DevTools, 375px, isolated profile, local server)

- Collapsed: Event/Deadline/To-do 80×44, More 56×44, one row; no horizontal
  scroll (`scrollWidth` 375). First version wrapped Milestone alone onto a
  313px row once More opened; fixed with a 24% flex basis, now Start and
  Milestone 154×44 each on a second row.
- A real Add of "Statics assignment" with Deadline saved `type: "due"`, showed
  on To-do, row hid, chips back on Event.
- Dark mode: selected chip `rgb(143,167,200)` on `rgb(20,22,26)`, unselected
  `--card`/`--ink`. Screenshots taken in both themes.
- Not done: a real iPhone (WebKit's date picker), VoiceOver.

## Open items for Alex

1. Mockup frame 3's per-type hint ("Deadlines show on the To-do page until you
   tick them") was not built: not among the picks, and it would be a second
   text table per type. Recommendation: leave it out.
2. On an iPhone, confirm that clearing the date with the picker's Reset hides
   the chips (Safari has to fire `input` or `change`; unverified).
3. The repo `CLAUDE.md` type-list section still says "manual add creates
   `event` since 2026-10-20" and does not mention `js/typechips.js`.
   Recommendation (controller or Alex to apply at merge): change the clause
   to "manual add saves the type chosen on its chips, Event by default
   (2026-10-26)", and add a bullet: "`js/typechips.js` holds a checked SUBSET
   (`PRIMARY_TYPES`/`MORE_TYPES`), not a fifth copy; it throws at app.js load
   if an offered type leaves `TYPES` or loses its `TYPE_LABELS` entry, and
   `tests/typechips.test.js` fails first."
