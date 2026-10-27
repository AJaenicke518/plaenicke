# Daily-use fixes — plan (2026-10-27)

Branch `daily-fixes` from `main` @ f1d97ea. No CACHE bump. app.js edits stay inside `addItems` (+ one import) so they do not meet the parallel `capture-date-row` branch (handleAdd/handleManualAdd, index.html).

## Task 1 — Settings panel can scroll (styles.css `.settings-backdrop`)
Verified: `position: fixed; inset: 0; padding-top: 15vh`, no overflow rule; `js/scrolllock.js` sets `body.style.overflow = 'hidden'` while Settings is open, so a panel taller than the viewport cannot be reached.
- Test first (`tests/styles.test.js`): `.settings-backdrop` has `overflow-y: auto`, `overscroll-behavior: contain` (as `.sheet` does; stops iOS chaining the scroll to the locked page), and a `padding-bottom` containing `env(safe-area-inset-bottom)`.
- Fix: add those three declarations.
- Mutant: delete the declarations; the test must fail.
- Browser: Chrome 375x667, fresh isolated context, check no link code in storage before seeding; seed several feeds + hidden series; open Settings; scroll the backdrop to its end; the last section is fully visible.

## Task 2 — same-day ideas in creation order
Verified: `addItems` stamps `createdAt: toISO(new Date())` (date only); `sortIdeasNewestFirst` tie-breaks equal createdAt on the random `uid()`.
Readers of `createdAt` (grep over js/ and worker/):
- `makeItem` copies it (no validation); `updatedAt` falls back to it only when absent (addItems always passes updatedAt).
- `deserializeItems` (storage.js) reads it only to backfill a missing `updatedAt` on pre-V5 records; its check is `typeof === 'string'`.
- `edit.js applyEdit` carries `record.createdAt` through unchanged.
- `sortIdeasNewestFirst`, `sortItemsByDate`, `feeds.js compareInstances`: plain string `<` comparisons.
- Worker: no reference to `createdAt` anywhere in `worker/` (sync stores an encrypted blob; the parse endpoint never sees records). Nothing to STOP on.
- `formatDayLabel` is called with `item.date`, never createdAt. Nothing slices createdAt.
- Behaviour change to note: in `sortItemsByDate`, two own items with the same date and time, created the same day, now order by creation time instead of title; an own item created on the same day as a feed instance's date compares against the feed's `"<date>T<time|00:00>"` by its real clock time, rather than always sorting first (a date-only string is a prefix, so it used to sort first).
- Fix: `localStamp(d)` in `js/dateparse.js` -> local `YYYY-MM-DDTHH:MM:SS.sss`; `addItems` uses it. Update the stale "createdAt stays a local calendar date" comment.
- Tests first: dateparse unit test for `localStamp` (TZ pinned America/Los_Angeles); apply test with mocked Date: add idea A, advance 5 min, add idea B; the Ideas page shows B before A, repeated so a random-uid tie-break cannot pass by luck. Update the existing `idea.date === idea.createdAt` assertion to the date prefix.
- Mutant: revert to `toISO(new Date())`.

## Task 3 — leftovers
a. `press.js` pointerleave: require `e.pointerId === pointerId`. Test: a second pointer's leave on the pressed element keeps the press. Mutant: drop the id check.
b. `tests/press.test.js` fake `removeEventListener` honours the capture flag (boolean or `{capture}`) as the DOM does. New test: uninstall removes the capture-phase listeners; mutant: `uninstall` removes without opts -> fails.
c. The 16px scan also reads the `font:` shorthand's size token; CSS-wide keywords (inherit etc.) carry no size and are skipped explicitly; a shorthand with no readable size is reported as an offender (no silent skip). Mutant: plant `input { font: 14px x }`.

## Review
Fresh reviewer subagent per task; final whole-branch review. Gate: `npm test` with `# fail 0` and `# cancelled 0`.
