# Capture date row: report (2026-10-27)

Branch `capture-date-row`, cut from main at f1d97ea. Mockup: https://claude.ai/artifact/8BZxdUUFpeCmkCxpay6BkL. Alex picked C2.
Plan: `docs/superpowers/plans/2026-10-27-capture-date-row.md` (665a453).

## What changed
- **Top add box removed** on every page: `.add-box` (`#entry-text`, `#entry-date`, `#entry-time`, `#entry-end`, `#add-btn`, `#entry-types`, the hint), `#preview`, `#message`, and their CSS. Today's heading now sits directly under the header. This also closes the punchlist item "Today's heading sits under the add box".
- **`#status-line`** (`role="status"`) sits under `#sync-indicator`. It holds every `setMessage` message: Ideas, ticks, deletes, edits, other-device notices.
  - When empty it collapses through `.status-line:empty` (no margin, padding or border). It is never `display:none` and never `hidden`.
  - A tab-bar switch clears it (Q4), through `switchTab` in `js/app.js`. There is no timer.
- **The capture box's date row** has `#capture-when`, `#capture-date`, `#capture-time`, and `#capture-types` for the chips.
  - The row shows on a typing focus of the field, on input, on every `focusField` tap (voice unsupported or refused, Type instead, a tap on the text while listening), and after a smart-add "unavailable" failure (`captureTarget.onUnavailable` calls `capture.showWhen()`).
  - It hides again on every new listen. It never shows when a listen ends on its own (Q2).
  - The chips show only once a date is picked (Q1, C2).
  - x hides the row, clears the date and time, and resets the chips (Q5).
- **Add with a date picked** saves through the manual path with the chosen type and no smart add. Afterwards the box closes (`target.onAdded()`, the same as a direct smart add) and the chips go back to Event.
  - The date is read only while the row shows. A value the browser restores into a hidden row is never used (DA #2).
- **The failure message** is now "Smart add is unavailable. Pick a date to save it without smart add."
- **End time:** the capture row has none. This is a **controller default (Q3), easy to reverse.** The item sheet still sets an end time.
- **Dead code removed:**
  - the duplicate guard, `pendingSmart`, `supersedePending`, `captureTarget.onSuperseded` and `capture.released()`.
  - Why: with one box, Add and Return are latched while a smart add thinks, so none of this code could run (DA #1). This follows the earlier precedent of "removed rather than kept as a guard that guards nothing".
- **Not changed:** `CAPTURE_MAX_SHARE` and `CACHE`. Nothing was touched in `applySyncedState`, createdAt, press.js or the Settings CSS.
- **Spec § 3:** the reversal is recorded under "The top add box stays".

## Tests
Final gate: `# tests 1752 / # pass 1752 / # fail 0 / # cancelled 0`. Baseline at f1d97ea was 1758.

**New tests:**
- `tests/capture.test.js`, eight new tests:
  - six `date row:` tests: hidden at the start, while listening and after a listen ends on its own; a tap on the text while listening shows it; typing or a typing focus shows it; voice unsupported, refusal and Type instead show it; `showWhen()` shows it; x hides it and calls `clearWhen`;
  - `date row: a new listen after typing hides it again`, added from Task 1 review I1;
  - `createCapture refuses a missing element or callback`, which now also covers `when` and `clearWhen`.
- `tests/apply.test.js`:
  - `capture: a date in the hidden date row is never read, so a spoken add goes to smart add` (DA #2);
  - `status line: a tab switch clears it` (Q4).
  This file also gained a `typeDatedEntry` helper.
- `tests/styles.test.js`:
  - `the status line collapses when empty without leaving the accessibility tree`;
  - `the capture date row restates [hidden] and its fields are 44px targets`.

**Mutation checks** (each mutation planted, the named test failed, then the code was restored):
- the input show;
- the readOnly guard;
- the `clearWhen` call in close;
- `showWhen` in focusField;
- the hidden-row gate in `handleAdd` (fails the new apply test);
- the status line clearing on a tab switch.

The Task 1 reviewer ran ten more mutations on capture.js, and a test caught each one.

**Rewritten tests.** Each now drives the capture box in typing mode with the same assertions, except where noted.
- `tests/apply.test.js`:
  - `manual add creates an event: on the calendar, not on the To-do page`
  - `manual type: the chips show only while a date is picked`
  - `manual type: index.html starts the chip row hidden` (now `#capture-types`)
  - `manual type: a date already in the box when the page is shown again shows the chips`
  - `manual type: a manual Add saves the chosen type, then the chips go back to Event and hide`. The "Added." check became "the box closes and its date row hides", because the landed add closes the box and close() clears its line. It also gained a check that the date is cleared.
  - `manual type: a refused manual Add (no title) keeps the choice; clearing the date resets it`. The refusal is now read on `#capture-message`.
  - `manual type: with no date, smart add keeps the Worker's type`
  - The two `smart add: an Add refused for … does not cancel the pending smart add` tests became `… says why and sends nothing`. A second Add while one is pending cannot happen now; each refusal message, "sends nothing" and "adds nothing" are still asserted.
  - `smart add: a current success / error / preview after the Ideas box said "Kept." …`. "Thinking…" is now read from `#capture-message`. **The "leaves Kept." checks now hold by construction**, because the two lines are separate elements. The items checks keep their force.
  - `smart add: a current result whose save fails still says so after "Kept."`. The quota error is checked on `#capture-message`, and `#status-line` still says "Kept.".
  - `smart add: a direct result clears the text box only if …` and `… still clears …`. The second test's "Added." check became "it was added" plus "the box closes".
  - `smart add: a preview confirm clears the text box only if it still holds the text sent`
  - `smart add: a new smart add hides and clears an earlier request's open preview`
  - `smart add: after an error the same text can be sent again`
  - `smart add: a preview from a superseded request cannot be confirmed or cancelled …`. The newer request is now edited text sent with Return, because the box's Add is hidden while its preview is open.
  - `capture: tap, speak, tap again adds through smart add …`. `#message` is now `#status-line`.
  - `capture: smart add unavailable …` was renamed. It checks the new text and that the date row shows after a voice-only add.
  - `capture: its preview opens in the box … and a typed dated Add closes it`. The top-box Add became a typed dated entry plus Return. **"Preview closed —" is no longer visible**, because the landed manual add closes the box and clears its line. The test now checks that the preview closed, that only the manual item was added, and that the box closes.
  - `capture: its Add is hidden while its preview is open, and back when a typed dated Add or its Cancel closes it`
  - `Today: a tick from a box without focus moves no focus` and `To-do: …`. The "elsewhere" element is now `#idea-text`.
  - Every `getElementById('message')` became `'status-line'`.
- `tests/styles.test.js`:
  - the control-radius and 16px lists have `.cap-field` and `.cap-field input` in place of `#entry-*`;
  - `#entry-` was dropped from `CONTROL_SELECTOR`;
  - `.cap-when`, `.cap-field` and `.status-line` were added to the new-screen type-scale allowlist.
- `tests/capture.test.js`: three setups gained `when` and `clearWhen`.

**Ported (final review I1):** `smart add: two requests that settle out of order — only the latest applies` and `smart add: a superseded error arriving after a newer smart success leaves "Added." alone` became two tests, `smart add: after Cancel and a newer Add, the older request's late {a preview-shaped success | an error} changes nothing`. With one box the older request is made stale by Cancel. Mutation check: removing both `generation !== addGeneration` returns in handleAdd fails both.

**Deleted tests.** Each needed two boxes or a second Add while one was pending, and the code each tested was removed:
- `smart add: a request that times out after a newer manual add leaves "Added." alone`
- `smart add: a second Add of the same text while the first is pending sends nothing`
- `smart add: after a newer manual add the same text can be sent again`
- `smart add: a refused manual add leaves the pending smart add alone`
- `smart add: a manual add closes an open preview from an earlier smart add`
- `smart add: a success arriving after a newer manual add adds nothing`
- `capture: starting a listen closes the top box's open preview, and its line says so`
- `capture: the same words from the other box are sent, not swallowed by the duplicate guard`
- `capture: a top-box Add that supersedes it releases the capture box at once, and x then cancels nothing`
- `capture: a manual add releases it too; a release leaves another action's message alone`
- `capture: never reaches the manual path, whatever the top box's date row …` (replaced by the hidden-row test above)
- `tests/capture.test.js` `released() drops the latch at once and adds nothing`

What is still covered: Cancel making a reply stale is covered by the existing test `capture: Cancel during Thinking adds nothing when the reply comes …`. A newer request superseding a preview is covered by the rewritten superseded-preview test.

## Reviews
- **DA on the plan** (jaeger:devil-advocate-reviewer). Findings and outcomes:
  - #1 remove the dead supersede code: done.
  - #2 a hidden row's date was used: fixed with a gate and a test.
  - #3 the live region with `:empty`: done, with no `display:none`, and pinned by a test.
  - #4 wire `onUnavailable` only on "unavailable": done. `too_long` and a save failure do not show the row; no test pins that.
  - #5 "Added." wiped on a manual add: intended, same as a direct smart add.
  - #6 `.typing` placement when the date picker is open: **speculative, check on the iPhone**.
  - #7 the "empty" outcome does not show the row: deliberate (Q2).
  - #8 end time: done.
  - #9 bump CACHE: **rejected per the controller's rule**. Risk: offline, the service worker can serve the new index.html with an old app.js. The release bump re-caches everything together.
  - #10 clear only on a tab switch: done.
- **Task 1 review** (fresh reviewer, capture.js): I1 was that a re-listen left the row showing. Fixed test-first. No Critical findings.
- **Task 2** (app.js, index.html, CSS, test migration): it had no separate reviewer of its own because of the time limit; the final branch review covers it.
- **Final branch review** (fresh reviewer, whole diff): no Critical findings.
  - I1, two deletions that should have been ports: ported, see above.
  - Minor: the orphaned `#preview` CSS was removed.
  - Minor: a stale assertion message was fixed.
  - Minor: "Added." in handleManualAdd is cleared at once by close(). Kept, because the direct smart add does the same.
  - It found no leftover references to the removed ids or functions.

## Process notes
- **Test-first slipped once.** The tab-switch test was written after the code; it was mutation-checked instead.
- **One stray interactive command.** I ran `git checkout -p`, which waited for input and was killed. The file state was checked afterwards: nothing was discarded.

## Open for Alex
- **End time in the capture row** (controller default: none).
- **Does a date picked before a new listen survive it?** It is kept, hidden and unused while listening, and shows again on typing. Clearing it instead is a one-line change.
- **iPhone checks:**
  - the box's placement while the date or time picker is open;
  - that C2 fits above the keyboard (221px in Chrome against a 238px cap; measured in Chrome, not on a device).
