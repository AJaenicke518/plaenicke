# Rewards 1 + 2: build report (2026-10-26)

Branch `rewards`, cut from `main` at 013af41. Alex picked concepts 1 and 2 of the rewards
design on 2026-10-26 (design: `.superpowers/sdd/lead-rewards-report.md`, mockup
https://claude.ai/artifact/EXDnKT7FYfxhiyWiMdYJu8). Concept 3 (the streak) and any new item
field are out. `CACHE` is not bumped; the controller does that at release.

## Controller rulings recorded (2026-10-26)

- **Concept 1, tick moment:** it plays where the row lands after the re-render, and no code
  holds the reorder. It respects `prefers-reduced-motion` and plays on Today and on To-do.
- **Concept 2, count:** it counts only the rows shown in Overdue and To do today, which are the
  struck rows on screen. A to-do finished early with a later date does not count. The count is
  hidden until the first tick of the day. "ALL N DONE" appears only when both sections are fully
  ticked.

## What was built

**The count**
- `js/today.js` `tally(today)`: a pure function over the `buildToday` result. `done` is the
  number of ticked rows in `overdue` + `todo`; `left` is the rest. It returns `null` when nothing
  is ticked.
- `js/todayview.js` `renderTally(node, tally)`: `null` empties the node and hides it. With nothing
  left it shows `<b>All N done</b>`; otherwise `<b>N done</b> · <span class="today-tally-left">M left</span>`.
  CSS sets the upper case.
- `index.html`: `<p id="today-tally" class="today-tally" hidden>` is the head's right-hand slot.
- `js/app.js` `renderToday` paints it on every render, from the same `buildToday` result as the
  rows, so the count and the rows cannot disagree.
- `styles.css`: the mockup's values are used, and `.today-tally[hidden] { display: none; }` guards
  the hidden state.

**The tick moment**
- `js/app.js`: a module-scope `justTicked` holds the id. It is set only after `setDone` saves a
  tick to done, for the one `render()` that follows, and cleared in `finally`. An untick, a failed
  save and every later render (sync, tab switch) carry no id.
- `js/todayview.js` and `js/todoview.js`, option `justTicked` (default `null`; any other non-string
  throws): the done row with that id, and with a checkbox, gets `tick-just`. Its title text is
  wrapped in `span.tick-strike`.
- `styles.css`: every rule sits inside `@media (prefers-reduced-motion: no-preference)`, so with
  Reduce Motion on the page is exactly what it was before. The moment has three parts:
  - a wash: an inset box-shadow in the new `--tick-glow` token (both themes) that fades out over
    900 ms;
  - a 260 ms pop of the box;
  - the strike, drawn left to right in 320 ms.

  The line-through is turned off on the element that carries it, one class above the `.done` rule.
- **Deviation from the mockup.** The mockup drew the strike as a background on `.today-text`. That
  element is `flex: 1`, so the line would run past the title to the meta, then jump to the text
  width on the next render. A span drawn across the text alone avoids that. On To-do the span
  covers the whole button label ("Today — title"), which is what the static strike covers there.

## Tests (test-first; every new assertion mutation-checked)

- `today.test.js`, with TZ pinned:
  - nothing ticked;
  - 2 of 5;
  - an overdue item ticked today;
  - an item ticked yesterday, and an early finish dated later;
  - one overdue item left;
  - a to-do dated today that was ticked earlier.
- `todayview.test.js`: the count's text, hidden state and re-render. For the moment: the class
  and span go on the right row only; there is no moment with no id, with an undone row, or with a
  checkbox-less done event; a bad id throws.
- `v6views.test.js`: the To-do moment.
- `apply.test.js`, through the real app:
  - The count is hidden, then "1 done · 1 left", then "All 2 done", and back to hidden on untick.
  - The count follows every render: a stored tick, a pending delete, and Undo.
  - The moment plays on Today where the row lands, plays nothing on a later render or an untick,
    plays on To-do, and plays nothing on a failed save.
  - The `deleteControlFor` helper now reads `allText`, because the fake DOM's `textContent` does
    not include child elements.
- `styles.test.js`:
  - The count's CSS.
  - The old test "the stylesheet declares no motion yet" became "every animation is inside a
    no-preference block, and the only keyframes are the tick moment's". It is backed by a new
    context-keeping parser, `rulesInContext`.
  - The moment's values and tokens.
- **Mutation results.** About 30 planted mutants were run, and all but two failed a named test.
  The two survivors are equivalent: setting `justTicked` on an untick, or before `setDone`. The
  views also require `done === true`, and both cases leave the item undone, so nothing renders
  differently.

Gate at HEAD: `# tests 1561`, `# pass 1561`, `# fail 0`, `# cancelled 0`.

## Reviews

- **Plan, devil's advocate** (jaeger:devil-advocate-reviewer). Adjudicated:
  - C1 (the override must target the element that carries the line-through): accepted. The
    selectors are pinned in a test.
  - I1 (a ruling conflict): accepted as an open question below, with a test pinning the current
    behaviour.
  - I2 (the reduced-motion test needs a parser that keeps the prelude): accepted.
  - I3 (`hidden` versus `display`): accepted, with a guard rule and a test.
  - I4 (the default `null`): already planned.
  - O4: declined. Events have no checkbox, and the "events counted" mutant is already caught.
- **Task 1, fresh reviewer** (general-purpose, opus). No Critical findings.
  - Important: a version that painted the count only after a tick passed every test. Fixed with
    the "follows every render" test, which is mutation-checked.
  - Minor findings fixed: the `[hidden]` guard and a misplaced comment.
- **Task 2, fresh reviewer** (general-purpose, opus). No Critical or Important findings.
  - Minor 1 (the `check &&` guard was untested): a test was added and mutation-checked.
- **Whole branch, fresh reviewer** (general-purpose, opus). No Critical or Important findings.
  - Minor 1 (a wrong timing comment): fixed.
  - The merge surface is noted below.

## Rendered check

The app was served locally from a `git archive` of 903673f and checked in Chrome DevTools with
mobile emulation at 390×844.
- Today, light theme, sampled mid-animation: the wash, the pop and a partly drawn strike.
- After the animation finished, the drawn line covered the text only, and the tally read
  "1 DONE · 4 LEFT".
- After a re-render, the static line-through looked the same at screenshot scale.
- To-do, dark theme: the dark wash showed, and the strike was drawn across a two-line label.

This was **not tested on an iPhone**, and **Reduce Motion was not emulated** (the
`styles.test.js` contract covers it). A small offset between the drawn 1.5px line and the font's
line-through is possible on iOS. That is speculative and needs Alex's phone.

## Merge surface for the controller

Several branches will touch the same places:
- `js/app.js`: the import lines 34–35 (edited in place), `els`, `renderToday`, `renderTodos`, and
  `handleToggleDone`.
- `index.html`: `.today-head`.
- `styles.css`: the `:root` and dark tokens (one line each), the count rules after `.today-date`,
  and the tick block appended at the end of the file.
- Tests: the new tests sit in the middle of `apply.test.js`, and `deleteControlFor` changed.
- `styles.test.js`: the old "no motion yet" test was replaced. **Another branch that adds motion
  (stage 4's capture box) must put its animations inside the same no-preference block, or this
  test fails. That is intended.**

## Open questions for Alex

1. **A to-do finished on an earlier day, dated today.** It is a struck row in To do today, so
   under "match the struck rows" it counts as done. The count can therefore show ("1 DONE ·
   3 LEFT") before the first tick of the day, which conflicts with "hidden until the first tick".
   As built, the screen-matching rule wins.
   **Recommendation:** keep it. The count stays honest to what is on screen, and the case needs
   an early finish.
2. **The count changes silently for VoiceOver users**: `#today-tally` has no live region.
   **Recommendation:** leave it silent. A live region would announce on every sync render.
3. **The moment can be cut short.** A sync render that lands inside the 900 ms wash rebuilds the
   rows and ends it. This follows from the "no reorder hold" ruling; noted only.
