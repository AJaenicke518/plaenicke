# Capture date row: integration into main (2026-11-09)

Branch `capture-date-row` @ 6158670 (cut from f1d97ea) merged into main @ f0b8af5 (v6-21) in worktree `worktree-agent-a64d7547075b418ab`. Not pushed, not merged to main.

Commits:
- `468ebf6` merge (`--no-ff`)
- `11c3395` default 2: a date picked before a new listen is kept (test-first)
- `0dbf090` stale top-box comments; one doubled blank line in index.html
- this report

## Conflicts

Git reported **2 textual conflicts**. Everything else merged automatically, including js/app.js, index.html, styles.css and js/capture.js.

1. **tests/styles.test.js**, at `CONTROL_SELECTOR`.
   - Main had added the `fontShorthandSize` helper and its test next to it. Both are kept.
   - The selector takes the branch's form, without `#entry-`, because those ids are gone.
2. **tests/apply.test.js**, at the end of the capture tests.
   - Both sides added tests at the same spot. Main added the sync-safety tests and the `bsD:` tests (v6-19..21). The branch added `status line: a tab switch clears it` and the two `after Cancel and a newer Add …` ports.
   - All of them are kept. Nothing was dropped from either side.

**service-worker.js** did not conflict, because the branch never changed it. CACHE stays `plaenicke-v6-21`.

**js/app.js** merged with no textual conflict. I checked the merged diff against main by hand:
- The branch's hunks are its own: the `els` ids, `setMessage` pointing at `#status-line`, `handleManualAdd`/`handleAdd`/`captureTarget`, and `switchTab`.
- Main's v6-17..21 code is outside those hunks and unchanged: the Brightspace import, the sync deferral and the Week list ticks. That code calls `setMessage`, so its messages now land on `#status-line`.
- `addItems` and its createdAt code are identical to main's.
- No `els.text/date/time/end/types/add/message/preview`, `topLine`, `topTarget`, `pendingSmart`, `supersedePending`, `onSuperseded` or `released()` is left anywhere in js/.

**Semantic merge defects.** After the textual resolution, 3 of main's tests failed. All three were written on main after the branch point and still used ids the branch removed. I migrated them the same way the branch migrated its own tests, and left their assertions unchanged:
- `bsD: an import whose items write fails says so, …` cleared `#message`. It now clears `#status-line`.
- `bsD: "Remove them" waits for a sync on a linked device and says so` cleared `#message`. It now clears `#status-line`.
- `Week list: unticking saves done false …; a box without focus moves no focus` focused `#entry-text`. It now focuses `#idea-text`, as the branch did for the Today and To-do versions of the same test.

**Where main's behaviour won:** nowhere. No hunk had both sides changing the same behaviour.

## Tests removed or changed

Per-file counts of top-level tests (TAP `ok`/`not ok` lines, one run per file), main → merged → final:
- `tests/apply.test.js`: 300 → 291 → 293
- `tests/capture.test.js`: 37 → 43 → 45
- `tests/styles.test.js`: 158 → 155 → 155
- All other files: unchanged.
- Total: 1905 → 1899 → 1903.

**Missing from main's list after the merge (27).** Every one is on the branch report's list of deleted or renamed tests, and each tested the top box or code the branch removed with it:

- **Renamed and rewritten** (the same scenario through the capture box):
  - `capture: its Add is hidden while its preview is open, … a top-box Add …` became `… a typed dated Add …`
  - `capture: its preview opens in the box, … a top-box Add closes it` became `… a typed dated Add closes it`
  - `capture: smart add unavailable names the top box's date row …` became `… says to pick a date …`
  - `smart add: an Add refused for a time with no date / for an empty box does not cancel the pending smart add` became `… says why and sends nothing` (two tests)
  - `smart add: two requests that settle out of order …` and `… a superseded error arriving after a newer smart success …` became `smart add: after Cancel and a newer Add, the older request's late {a preview-shaped success | an error} changes nothing`
- **Deleted** (two boxes, or a second Add while one was pending):
  - `capture: a manual add releases it too; …`
  - `capture: a top-box Add that supersedes it …`
  - `capture: never reaches the manual path, whatever the top box's date row …`, replaced by `capture: a date in the hidden date row is never read …`
  - `capture: starting a listen closes the top box's open preview …`
  - `capture: the same words from the other box are sent …`
  - `smart add: a manual add closes an open preview …`
  - `smart add: a refused manual add leaves the pending smart add alone`
  - `smart add: a request that times out after a newer manual add …`
  - `smart add: a second Add of the same text while the first is pending sends nothing`
  - `smart add: a success arriving after a newer manual add adds nothing`
  - `smart add: after a newer manual add the same text can be sent again`
  - `capture.test.js`: `released() drops the latch at once and adds nothing`
- **styles.test.js:** 8 generated tests for the `#entry-text/date/time/end` 16px and control-radius checks. 3 replace them, for `.cap-field input` (16px, radius) and `.cap-field` (radius).

No other test of main's is missing. The 21 tests that appeared in the merge are exactly the branch's new and renamed tests.

**Added in this integration (4):**
- `tests/apply.test.js`:
  - `capture: a date picked before a new listen is kept, so the spoken add saves on that date and type`
  - `capture: with no date picked, a new listen after typing hides the date row`
- `tests/capture.test.js`:
  - `date row: a new listen keeps it showing while a date is picked`
  - `date row: a picked date never shows a row that was hidden when the listen starts`
- The capture.test.js fixtures gained `whenPicked`, and the missing-callback test now covers it.

## Alex's defaults

- **No end time in the capture row.** The branch already did this, so nothing changed.
  - index.html has only `#capture-time`.
  - `handleManualAdd` saves `endTime: null`.
  - No test asserts this explicitly.
- **A date picked before a new listen is KEPT.** The branch kept the date's value but hid the row on every listen, and a hidden row is never read. A spoken add after picking a date therefore went to smart add, which ignored the date and chips. Changed in `11c3395`:
  - `createCapture` takes a new required callback, `whenPicked`. app.js passes `() => Boolean(els.captureDate.value)`.
  - `startListening` now hides the row only when no date is picked. A row that is showing stays, and the spoken words become a manual add on that date and type.
  - A listen still never *shows* a hidden row. So a date the browser restores into a row the user never opened stays unread, and the DA #2 test passes unchanged.
  - **Test-first:** the kept-date apply test and the `keeps it showing` unit test failed on the branch code (`the row stays showing while listening`, `true !== false`).
  - The two guard tests (`never shows a hidden row`, `no date picked … hides`) already passed before the change. They pin each side of the rule.
  - **Mutation checks**, each run and then restored:
    - In capture.js, `els.when.hidden = !whenPicked()` fails `never shows a hidden row` and the DA #2 apply test.
    - app.js `whenPicked → false` fails the kept-date apply test.
    - app.js `whenPicked → true` fails `with no date picked …`. No test failed on this mutation before that test was added.

## Runs

`npm test` from the repo root, three runs on the final tree. Each run: `# tests 1903 / # pass 1903 / # fail 0 / # cancelled 0`.

## Self-review (`git diff main...HEAD`)

- **Removed ids:** none is still looked up in js/. The apply test that matches app.js's `getElementById` ids against index.html passes.
- **CSS for removed elements:** none left. `.add-box`, `#entry-*`, `.text-row`, `.add-row`, `.hint` and `#preview` are gone. `.message` stays, because `#capture-message` uses it.
- **Stale comments**, fixed in `0dbf090`:
  - `js/typechips.js` header ("top add box's date row")
  - `js/preview.js` and `tests/preview.test.js` (manual add's `#entry-end`)
  - `closePreviews` ("in EVERY box")
  - the apply.test.js capture section header ("both boxes")
  - `js/voice.js` mentions the top box's mic as retired history. That is accurate, so it was left.

## Concerns

- **Interpretation (speculative).** I read "KEPT" as kept showing *and used* by the spoken add. If Alex meant kept in the box but hidden and unused, that was the branch's behaviour; reverting `11c3395` restores it.
- **Q2 change.** The date row now shows while listening when a date was picked before the listen. The branch's rule was "never while listening". This layout has not been measured on the iPhone (keyboard down, listening, row showing).
- **Time without a date.** `whenPicked` reads only the date. A time picked without a date is still hidden on a new listen, and stays in the box unread, as on the branch.
- **`TARGETS`** is now a one-element array, and `closePreviews` loops over it. It works; I left it as is.
- **Task 2 of the branch** (app.js wiring, index.html, CSS) still has no per-task review of its own. This integration checked leftovers and the merge seams, not the branch's whole wiring.
- **CACHE was not bumped**, per instructions. Until the release bump, a device offline can be served the new index.html with an old app.js.

## Review fixes (2026-11-09, after independent review)

Each was written test-first: the new test failed on the old code, and a mutation check followed. One `npm test` run afterwards: `# tests 1908 / # pass 1908 / # fail 0 / # cancelled 0`.

1. **A time picked with no date is kept on a new listen.**
   - Change: `whenPicked` is now `Boolean(captureDate.value || captureTime.value)`. The spoken add is refused with "Add a date to use that time, …", the same as a typed Add.
   - Mutation checked: with the date-only check, the new apply test fails.
2. **Picking a date while a smart add thinks.** I chose to lock the row; the other option offered was clearing only what was submitted.
   - Change: createCapture takes a new required `lockWhen(on)`, which `setAdding` calls. app.js disables `#capture-date` and `#capture-time`.
   - The chips need no lock: on the smart path no date is picked, so the chips are hidden.
   - Mutation checked: an app.js no-op `lockWhen` fails the apply test, and removing the call in capture.js fails the new capture unit test.
3. **"Unavailable" wording when the row already holds a date.**
   - Change: `unavailable` is now a function. With a date in the row it says "Smart add is unavailable. Tap Add to save it on the date shown."
   - Mutation checked.
4. **"Added." on `#status-line`.** It now appears there for a manual add, a direct smart add and a confirmed preview.
   - A direct smart add writes it only if nothing has spoken on the status line since the send. The "Kept." tests still hold, and an unguarded write fails one of them.
   - Changed assertions: two existing tests asserted that the status line keeps an older message across an add. That was the rule this fix reverses on purpose:
     - `capture: tap, speak, tap again …` (now renamed `… and "Added." on the status line`)
     - `capture: its preview opens in the box … a typed dated Add closes it`
   - Mutation checked: removing each of the three writes fails the new test.
5. **Dead class:** the `cap-types` class is removed from index.html.
6. **`TARGETS`** is removed. `closePreviews` acts on `captureTarget` directly.

There are 5 new tests: 4 in `tests/apply.test.js` and 1 in `tests/capture.test.js`. CACHE was not bumped.
