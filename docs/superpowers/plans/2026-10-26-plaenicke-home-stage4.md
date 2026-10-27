# plaenicke home screen — stage 4 (the capture button) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Stage 4 of the approved home-screen spec. A big round mic button bottom-right on every page: tap = the capture box grows out of it and listens with live words; tap again = stop and add through smart add; tap the text = type instead. The box has its own message line and preview, an adding latch with Cancel, and stops-and-keeps when the page hides, an item sheet opens or Settings opens. The top add box stays; its small `#mic-btn` and `dictate()` retire, leaving one mic.

**Architecture:**
- `js/viewport.js` (new): the item sheet's `followVisualViewport`, moved out of `js/itemsheet.js` and given two options (`maxShare`, `transform`) so the capture box can use it too. The sheet's behaviour is unchanged; its existing `vv:` tests are the proof.
- `js/voice.js`: a new `listen()` (a new `SpeechRecognition` per listen, `continuous` + `interimResults`, prefix + finals + interim, stop-and-detach) with pure `composeText()` and `errorKind()`. `dictate()` goes in Task 6.
- `js/capture.js` (new): the button and box state machine (closed / listening / typing, the adding latch, refusals, open and close). Presentation only; it is handed `submit`, `cancelSubmit` and `closePreviews` by app.js and never adds an item itself. Its own test file drives it with a fake voice, so `tests/apply.test.js` only has to check the wiring.
- `js/app.js`: `handleAdd` takes a target box `{ field, dates | null, line, preview, unavailable, onAdded }` (spec § 3: "takes a target … each box passes its own"). Each box has its own message line with its own token; `closePreviews()` closes an open preview in every box; a stale preview's confirm is refused. Task 6 creates the capture box's target and wires `createCapture`.
- `index.html` / `styles.css`: the capture box (outer wrapper placed by `viewport.js`, inner panel animated) and the 56 px button, after `#settings-host` and `#sheet-host` so a CSS sibling rule hides the button while either is open.

Nothing is stored, synced or migrated. `sync.js`, `merge.js`, `ics.js`, `schemaVersion` and `makeItem` are untouched.

**Decisions this plan makes where the spec is silent or would not work as written** (each is pinned by a test below; Alex, confirm or edit):

1. **A new module, `js/capture.js`.** The spec names `listen()` in `voice.js` and `viewport.js`; the state machine needs a home that can be tested without app.js's module-scope DOM. app.js only wires it.
2. **Where the box sits.** With the keyboard down its bottom edge is 8 px above the round button (`56px` tab bar + `16px` + `56px` button + `8px` + safe area), so the button stays visible and tappable below it. While the field has focus and is not read-only (`.typing`) it drops to 8 px above the visible bottom, which on the iPhone is the keyboard's top edge. Placement is the sheet's proven mechanism (`top` = visible bottom, `translateY(calc(-100% - var(--capture-lift)))`); only the lift is CSS. **Speculative, phone check:** that "field focused" means "keyboard up" on the iPhone. **Known limit:** in a desktop browser (no on-screen keyboard) a focused field drops the box over the tab bar and button until the field loses focus.
3. **Box height:** at most half the visible height (`CAPTURE_MAX_SHARE = 0.5`, CSS fallback `50dvh`); the panel scrolls inside itself (the preview included).
4. **Closing:** a `.closing` class plays the reverse animation and the box is hidden after `CLOSE_MS = 250` by a timer, not by `animationend` (which never fires when animations are off, and would leave the box up for good). With `.typing` it fades instead (spec § 5). Reopening during those 250 ms cancels the close.
5. **× while "Thinking…"** cancels the request (as Cancel does) and closes. Nothing is added after the user dismissed the box.
6. **Success closes the box only when its field is empty.** Text typed while it was thinking is the next entry, so the box stays open with it (the existing `clearSentText` rule).
7. **The duplicate guard is per box.** A second Add of the same text from the same box still sends nothing; the same words from the other box are a new capture and are sent (newest wins).
8. **A superseded request clears its own "Thinking…"** if that is still on its box's line. With two lines, a request superseded from the other box would otherwise leave "Thinking…" up for good.
9. **A stale preview's confirm** leaves the container alone (it may hold the newer preview). *As executed (polish round):* it is silent, like a stale Cancel — closing the preview already said "Preview closed — nothing was added from it.", and writing on the newer request's line would swallow that request's own message.
10. **Messages, verbatim from the spec where it gives them;** the spec's "Preview closed — nothing was added from it" gains a full stop like its neighbours. No "Listening…" text: the live words and the stop square say it; a new listen clears the line. Placeholder: "Say it, or tap here to type".
11. **The button hides by CSS alone** (`#settings-host:not(:empty) ~ .capture-btn`, same for `#sheet-host`): each host is empty exactly when its panel is closed.
12. **Focus for the keyboard:** inside the tap, `readOnly = false`, then `blur()`, then `focus()` — the tap has already focused the read-only field, and `focus()` on a focused field does not raise the iOS keyboard. **Speculative, phone check.**
13. **A refusal lasts the page's life** ("later taps that session go straight to typing").
14. **Icons:** inline SVG, a mic and a stop square, in `currentColor` on the accent.
15. **Service worker:** `CACHE` → `plaenicke-v6-13`; `CACHE_ON_MAIN` re-pinned to main's `plaenicke-v6-12` (it was stale at `-v6-11`).
16. **A superseded box is told at once** (review I1). When a newer Add from either box (manual or smart) supersedes a smart add in flight, that request's box is told immediately: its "Thinking…" goes (only if still showing) and the capture box drops its adding latch and Cancel. So the capture box's Cancel or × can only ever cancel its own request. This replaces the first draft's "clear Thinking… when the superseded reply finally arrives".
17. **A listen while this box's own preview is open starts from an empty field** (review I2): spec § 3 step 8 calls it a new capture with "nothing was added from it", so the previewed text does not become the new listen's prefix. After Cancel, a failure or recognition ending, the next listen still appends (spec step 5). *As executed (Task 4 fix round):* only while the field still holds exactly the text that produced the preview; an edit made since is kept and becomes the prefix.
18. **Add is always reachable** (review I3): the field grows to at most 120 px (five lines), then scrolls; × moved into the actions row (× left, Cancel/Add right), which is the panel's last child and `position: sticky; bottom: 0`; the preview sits above it.
19. **`.typing` follows any keyboard-raising control in the box** (review I4): the field (not while read-only) or a preview input/select, via `focusin`/`focusout` on the box; moving focus between two of them keeps it. It stays on while the box closes, so a close with the keyboard up fades in place instead of jumping first (review M1).
20. **A closing box lets taps through** (`pointer-events: none`, review M2); **the textarea's height includes its border** (review M3); **a `SpeechRecognition` constructor that throws reports `start-failed`** like `start()` (review M4); **a stale preview's Cancel is refused like its confirm**, through a small `js/preview.js` change: `onCancel` returning `false` leaves the container alone (review M5). The capture box's Cancel is styled secondary and × uses the 20 px title size (review M16).

**Devil's-advocate review of d54cc97 (2026-10-26) — adjudication.** No Critical findings. Every Important and Minor finding:

| Finding | Ruling | Where |
|---|---|---|
| I1 the capture box's Cancel/× cancelled whichever request was newest, even the top box's; its latch stayed up to 60 s after a top-box Add superseded it | **APPLY** | decision 16; Task 6 `supersedePending`, `capture.released()`; tests `capture: a top-box Add that supersedes it …`, `capture: a manual add releases it too …` |
| I2 a listen with this box's preview open re-sent the old text as its prefix | **APPLY** (the spec's "new capture … nothing was added from it"); listed for Alex to confirm | decision 17; Task 4 |
| I3 with the keyboard up, a growing field pushed Add out of the box | **APPLY** | decision 18; Task 3 CSS and markup |
| I4 a preview input raised the keyboard without `.typing` | **APPLY** | decision 19; Task 4 |
| M1 a close with the keyboard up jumped before fading | **APPLY** | decision 19; Task 4 |
| M2 a closing box swallowed taps | **APPLY** | decision 20; Task 3 |
| M3 textarea 2 px short | **APPLY** | decision 20; Task 4 |
| M4 a throwing constructor left the box stuck | **APPLY** | decision 20; Task 2 |
| M5 a stale preview's Cancel wiped the newer preview | **APPLY** | decision 20; Task 5 (`js/preview.js`) |
| M6 "Added." from the capture box is never seen (the box closes) | **DEFER** — blocker: Alex's call (spec § 3 says only "Success closes the box"); open question 1 in the lead report | — |
| M7 return in the capture field makes a newline instead of adding | **DEFER** — blocker: Alex's call (the spec is silent; the textarea default is kept); open question 2 | — |
| M8 a top-box request superseded by a capture just goes blank | **DEFER** — blocker: Alex's call on whether to say more; behaviour now immediate (decision 16); open question 3 | — |
| M9 reopening during the 250 ms close restarts the grow animation | **DISMISS** — a 250 ms window, and the grow it restarts is the open animation the spec asks for; matching mid-animation state needs reading computed transforms, more code than the case is worth | — |
| M10 "Settings → plaenicke" may not be a real path | **DEFER** — blocker: needs the phone; phone check 20 | — |
| M11 duplicated words in continuous mode | **DEFER** — blocker: needs the phone; phone check 17 | — |
| M12 first-time permission prompts may end the first listen | **DEFER** — blocker: needs the phone; phone check 18 | — |
| M13 `.typing` lands before the keyboard has shrunk the viewport | **DEFER** — blocker: needs the phone; phone check 19 | — |
| M14 test fragility: no `closeCapture` in two `finally`s; refusal test must stay last; `installManualTimers` handles | **APPLY** the `finally`s; **DISMISS** the rest: the refusal test fails loudly if moved (its comment says why), and `installManualTimers` handles are objects, not recycled integers (tests/apply.test.js `installManualTimers`) | Task 6 tests |
| M15 desktop: a focused field covers the tab bar and button | **DEFER** — blocker: Alex's call; told in the lead report (decision 2 known limit) | — |
| M16 × off the type scale; Cancel styled primary | **APPLY** | decision 20; Task 3 |

**Tech Stack:** Vanilla ES modules, no framework, no build step, no bundler; `node:test` + `node:assert/strict`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-plaenicke-home-screen-design.md` — § 3 (all of it), § 4 geometry and layers, § 5, § 6, § 7, § 8 stage 4, § 9.

Work in `/Users/ajaenicke25/projects/plaenicke/.claude/worktrees/agent-af1149b0f51112863` on branch `stage4-capture` (cut from `main` cfe7913). Baseline: `npm test` → `# tests 1530`, `# fail 0`, `# cancelled 0`.

**Every step below was applied in order to a throwaway worktree of cfe7913 and run.** The RED lists, the pass counts and the totals are from those runs, and every mutant in the tables failed the named test there. The scripts quote the exact text they replace and stop with an AssertionError if it is not found exactly once.

**Where the code lives for copying:** every file and script below is also at `.superpowers/sdd/stage4/files/` and `.superpowers/sdd/stage4/scripts/` in the worktree (gitignored), byte-identical to the blocks here (the plan is generated from them). Copy from there rather than retyping a block.

---

## Global Constraints

- Tests: "`npm test` is `node --test` with no arguments and it RECURSES." "`node --test tests/` runs ZERO tests … Never use it." One file: `node --test tests/<file>.test.js`.
- Commits: "Gate a commit on `# fail 0` AND `# cancelled 0`." Every commit step uses this gate verbatim: `npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add … && git commit …`
- Every commit message ends with the Co-Authored-By line your own session's attribution reminder gives.
- "Node 22 has no `localStorage`. Any storage-touching test must call `installFakeLocalStorage()`."
- "`tests/fake-dom.js` … `getElementById` returns `null` for an unmounted id. `apply.test.js` mounts every id `index.html` declares before importing app.js." The new ids are mounted automatically.
- "`apply.test.js` installs an offline `fetch` at the top of the file. … Keep it." Every smart add in this plan's tests goes through the existing `smartAddFetch` stub.
- Mock timers in `apply.test.js`: this plan uses the file's existing `installManualTimers()` only (as the smart-add tests do). The capture box's 250 ms close timer goes through it and is fired with `timers.fire(250)`.
- "**Feed URLs are never rendered or logged.**" Nothing here touches feeds.
- "**Sync is untouched** (`sync.js`, `merge.js`, `schemaVersion`, ownership, visibility gate)." The only write path is the existing `addItems`.
- "**No new item fields.**"
- "**Service worker:** new modules into `ASSETS`, `CACHE` bumped, `serviceworker.test.js` re-pinned (incl. stale `CACHE_ON_MAIN`)."
- "**There is no CI workflow. … merging to `main` IS the deploy.**" Never push, never merge, never deploy, never run `npm run smoke:worker`.
- "**16 px on every input.**" "**Layers:** content 0 < tab bar 5 < capture button 6 < capture box 8 < settings backdrop 10 < item sheet 15 < toast 20." "Radii … 14 (capture box, sheets), 50% (capture button)." "the capture button `scale(.94)`". "Shadows only on the capture box, sheets and toast." "**Motion:** 200 ms ease-out (capture box 250 ms), `transform`/`opacity` only. Nothing else animates. Under `prefers-reduced-motion` the box only fades." "An **outer** wrapper is positioned by `viewport.js`; an **inner** panel animates."
- Mutation-check every new assertion: plant the named mutant, see the named test fail, restore it, and confirm with `git diff` that only the task's own changes remain.
- Plan code has been wrong before (CLAUDE.md). If what running shows disagrees with this plan's code, expected output or counts, STOP and report it with the evidence; do not quietly adapt.

---

## Task 1: `js/viewport.js` — the shared visual-viewport follower

**Files:**
- Create: `js/viewport.js`, `tests/viewport.test.js`
- Modify: `js/itemsheet.js` (remove the local `followVisualViewport`, import it), `styles.css` (one comment), `service-worker.js` (ASSETS + CACHE), `tests/serviceworker.test.js` (re-pin `CACHE_ON_MAIN`)

- [ ] **Step 1: Write the failing tests.** Create `tests/viewport.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followVisualViewport, PLACED_PROPS } from '../js/viewport.js';

// js/viewport.js on its own (home-screen spec § 3, § 8 stage 4). The item
// sheet's own placement tests stay in tests/itemsheet.test.js, unchanged:
// they are the proof that moving the function here changed nothing for it.

// Inline style through setProperty/removeProperty only, as a real
// CSSStyleDeclaration is written by property NAME ('max-height').
class FakeStyle {
  setProperty(name, value) { this[name] = String(value); }

  removeProperty(name) { delete this[name]; }
}
const element = () => ({ style: new FakeStyle() });
const inline = (el) => ({ ...el.style });

// An EventTarget-like visualViewport, as tests/itemsheet.test.js has.
function fakeViewport({ height = 800, offsetTop = 0 } = {}) {
  const listeners = {};
  return {
    height,
    offsetTop,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    dispatch(type) { [...(listeners[type] || [])].forEach((fn) => fn({ type })); },
    count() { return Object.values(listeners).reduce((n, l) => n + l.length, 0); },
  };
}

function withViewport(vv, fn) {
  globalThis.visualViewport = vv;
  try { return fn(); } finally { delete globalThis.visualViewport; }
}

test('places the element by its bottom edge on the visible bottom, at maxShare of the visible height', () => {
  withViewport(fakeViewport({ height: 800 }), () => {
    const el = element();
    followVisualViewport(el, { maxShare: 0.5 });
    assert.deepEqual(inline(el), {
      bottom: 'auto', top: '800px', transform: 'translateY(-100%)', 'max-height': '400px',
    });
  });
});

test('a caller\'s transform is used verbatim', () => {
  withViewport(fakeViewport({ height: 600 }), () => {
    const el = element();
    followVisualViewport(el, { maxShare: 0.5, transform: 'translateY(calc(-100% - var(--capture-lift)))' });
    assert.equal(el.style.transform, 'translateY(calc(-100% - var(--capture-lift)))');
  });
});

test('the keyboard: a resize and then a scroll each re-place it inside the visible area', () => {
  const vv = fakeViewport({ height: 800, offsetTop: 0 });
  withViewport(vv, () => {
    const el = element();
    followVisualViewport(el, { maxShare: 0.5 });
    vv.height = 420;
    vv.dispatch('resize');
    assert.equal(el.style.top, '420px');
    assert.equal(el.style['max-height'], '210px');
    vv.offsetTop = 260;
    vv.dispatch('scroll');
    assert.equal(el.style.top, '680px', 'offsetTop + height: the visible bottom in layout-viewport px');
    assert.equal(el.style['max-height'], '210px');
  });
});

test('stop removes both listeners and every inline property it set, and a second stop is harmless', () => {
  assert.deepEqual(PLACED_PROPS, ['bottom', 'top', 'transform', 'max-height']);
  const vv = fakeViewport({ height: 420, offsetTop: 260 });
  withViewport(vv, () => {
    const el = element();
    const stop = followVisualViewport(el, { maxShare: 0.85 });
    assert.equal(vv.count(), 2, 'one resize and one scroll listener while following');
    stop();
    assert.equal(vv.count(), 0);
    assert.deepEqual(inline(el), {});
    stop();
    vv.height = 300;
    vv.dispatch('resize');
    vv.dispatch('scroll');
    assert.deepEqual(inline(el), {}, 'a later keyboard change reaches nothing');
  });
});

test('without visualViewport nothing is set and nothing listens', () => {
  assert.equal(globalThis.visualViewport, undefined);
  const el = element();
  const stop = followVisualViewport(el, { maxShare: 0.5 });
  assert.deepEqual(inline(el), {});
  stop();
  assert.deepEqual(inline(el), {});
});

test('a maxShare that is not a number in (0, 1] is refused before anything listens', () => {
  const vv = fakeViewport();
  withViewport(vv, () => {
    for (const bad of [undefined, 0, -0.5, 1.5, Number.NaN, '0.5']) {
      assert.throws(() => followVisualViewport(element(), { maxShare: bad }), /maxShare/, String(bad));
    }
    assert.throws(() => followVisualViewport(element()), /maxShare/, 'no options at all');
    assert.equal(vv.count(), 0);
  });
});
```

Re-pin `CACHE_ON_MAIN` (main ships `plaenicke-v6-12`; the test still says `-v6-11`) with `scripts/t1_test_edit.py`:

```python
# Task 1 (test side): re-pin CACHE_ON_MAIN to main's released value. Run from the repo root.
import pathlib
p = pathlib.Path('tests/serviceworker.test.js')
s = p.read_text()
old = "const CACHE_ON_MAIN = 'plaenicke-v6-11';"
assert s.count(old) == 1, 'CACHE_ON_MAIN is not plaenicke-v6-11'
p.write_text(s.replace(old, "const CACHE_ON_MAIN = 'plaenicke-v6-12';"))
print('ok')
```

- [ ] **Step 2: Run them; they fail.**

`node --test tests/viewport.test.js` → `# tests 1`, `# fail 1` (`not ok 1 - tests/viewport.test.js`: the module does not exist yet).
`node --test tests/serviceworker.test.js` → `# tests 9`, `# fail 1` (`not ok 3 - the cache name is ahead of the release on main`: CACHE is still `-v6-12`).

- [ ] **Step 3: Implement.** Create `js/viewport.js`:

```js
// viewport.js — keeps a fixed element inside the VISUAL viewport (the part
// of the page the user can actually see). Shared by the item sheet
// (js/itemsheet.js) and the capture box (js/capture.js); moved here from
// itemsheet.js in home-screen stage 4 (spec § 3, § 8), unchanged in
// behaviour for the sheet.
//
// Why: on iOS Safari the keyboard does not resize the layout viewport, which
// is what `position: fixed`, `bottom: 0` and `dvh` measure against. It shrinks
// the visual viewport and scrolls it within the layout viewport instead. An
// element pinned to the layout viewport's bottom then sits behind the
// keyboard, and its top (the sheet's bar with Save and Cancel) is above the
// visible area, where no scroll inside it can bring it.
//
// The element is placed by its bottom edge: `top` is set to the visible
// area's bottom edge in layout-viewport px (offsetTop + height; offsetTop is
// the visual viewport's offset within the layout viewport, which is the fixed
// element's containing block) and the transform lifts it by its own height —
// 'translateY(-100%)' by default; the capture box passes one that also lifts
// it by a CSS variable. That needs neither the layout viewport's height nor a
// measurement of the element. max-height keeps its top edge inside the
// visible area too: `maxShare` of the visible height.
//
// No visualViewport: nothing is set and nothing listens; the stylesheet's own
// rules apply exactly as they did before this module existed.

// The inline properties placement writes, and stop() removes.
export const PLACED_PROPS = ['bottom', 'top', 'transform', 'max-height'];

// followVisualViewport(el, { maxShare, transform }) -> stop()
export function followVisualViewport(el, { maxShare, transform = 'translateY(-100%)' } = {}) {
  if (typeof maxShare !== 'number' || !(maxShare > 0 && maxShare <= 1)) {
    throw new Error(`followVisualViewport: maxShare must be a number in (0, 1], got ${maxShare}`);
  }
  const vv = globalThis.visualViewport;
  if (!vv) return () => {};
  const place = () => {
    el.style.setProperty('bottom', 'auto');
    el.style.setProperty('top', `${vv.offsetTop + vv.height}px`);
    el.style.setProperty('transform', transform);
    el.style.setProperty('max-height', `${Math.floor(vv.height * maxShare)}px`);
  };
  vv.addEventListener('resize', place);
  vv.addEventListener('scroll', place);
  place();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    vv.removeEventListener('resize', place);
    vv.removeEventListener('scroll', place);
    for (const prop of PLACED_PROPS) el.style.removeProperty(prop);
  };
}
```

Then `scripts/t1_impl_edit.py` (itemsheet imports it and passes its 0.85 share; one stale styles.css comment; ASSETS and CACHE):

```python
# Task 1 (implementation side): itemsheet.js imports followVisualViewport from
# js/viewport.js; the service worker precaches it and its CACHE is bumped.
# Run from the repo root, after js/viewport.js is created.
import pathlib

def edit(path, pairs):
    p = pathlib.Path(path)
    s = p.read_text()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected exactly one: {old[:80]!r} (found {s.count(old)})'
        s = s.replace(old, new)
    p.write_text(s)

p = pathlib.Path('js/itemsheet.js')
s = p.read_text()
start = s.index('// Keeps an open sheet inside the VISUAL viewport')
end = s.index('function el(tag, className, text)')
assert 'function followVisualViewport(sheet)' in s[start:end]
s = s[:start] + s[end:]
p.write_text(s)
edit('js/itemsheet.js', [
    ("import { tagColour } from './palette.js';\n",
     "import { tagColour } from './palette.js';\nimport { followVisualViewport } from './viewport.js';\n"),
    ("// The share of the visible height a sheet may take; the rest shows the scrim,\n// so a tap above the sheet can still dismiss it.",
     "// The share of the visible height a sheet may take (js/viewport.js); the rest\n// shows the scrim, so a tap above the sheet can still dismiss it."),
    ("  stopViewport = followVisualViewport(sheet);\n",
     "  stopViewport = followVisualViewport(sheet, { maxShare: SHEET_MAX_SHARE });\n"),
])
edit('styles.css', [
    ("sheet is open, js/itemsheet.js (followVisualViewport) overrides bottom,",
     "sheet is open, js/viewport.js's followVisualViewport overrides bottom,"),
])
edit('service-worker.js', [
    ("const CACHE = 'plaenicke-v6-12';", "const CACHE = 'plaenicke-v6-13';"),
    ("'js/today.js', 'js/todayview.js', 'js/weeklist.js',\n",
     "'js/today.js', 'js/todayview.js', 'js/weeklist.js',\n  'js/viewport.js',\n"),
])
print('ok')
```

- [ ] **Step 4: Run them; they pass.** `node --test tests/viewport.test.js` → `# tests 6`, `# pass 6`. `node --test tests/serviceworker.test.js` → `# tests 9`, `# pass 9`. `node --test tests/itemsheet.test.js` → `# tests 103`, `# pass 103` (unchanged: the sheet's `vv:` tests are the proof the move changed nothing for it).

- [ ] **Step 5: Mutants.** Each must fail the named test; restore after each.

| Mutant | Plant | Fails |
|---|---|---|
| M1 visible bottom ignores offsetTop | `viewport.js`: `` `${vv.offsetTop + vv.height}px` `` → `` `${vv.height}px` `` | viewport `the keyboard: a resize and then a scroll …` |
| M2 no scroll listener | delete `  vv.addEventListener('scroll', place);` | viewport tests 3 and 4 |
| M3 stop leaves inline style | delete the `removeProperty` loop line | viewport `stop removes both listeners …` |
| M4 a string maxShare accepted | delete `typeof maxShare !== 'number' \|\| ` | viewport `a maxShare that is not a number …` |
| M5 the sheet passes the wrong share | `itemsheet.js`: `{ maxShare: SHEET_MAX_SHARE }` → `{ maxShare: 0.5 }` | itemsheet `vv: with the keyboard down …`, `vv: the keyboard opening …` |
| M6 transform option ignored | `setProperty('transform', transform)` → `setProperty('transform', 'translateY(-100%)')` | viewport `a caller's transform is used verbatim` |
| M7 viewport.js missing from ASSETS | `service-worker.js`: delete the `  'js/viewport.js',` line | serviceworker `every js/ module is precached …` |

- [ ] **Step 6: Gate and commit.** Expected tail: `# tests 1536`, `# pass 1536`, `# fail 0`, `# cancelled 0`.

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/viewport.js tests/viewport.test.js js/itemsheet.js styles.css service-worker.js tests/serviceworker.test.js && git commit -m "Stage 4: js/viewport.js — the item sheet's visual-viewport follower, shared

Moved out of itemsheet.js with two options (maxShare, transform) so the
capture box can use it (home-screen spec § 3, § 8 stage 4). The sheet's
behaviour is unchanged; its vv: tests pass untouched. CACHE v6-13;
CACHE_ON_MAIN re-pinned to main's v6-12.

<your Co-Authored-By line>"
```

---

## Task 2: `listen()` in `js/voice.js`

**Files:**
- Create: `tests/voice.test.js`
- Modify: `js/voice.js` (append; `dictate()` stays until Task 6, still used by app.js)

- [ ] **Step 1: Write the failing tests.** Create `tests/voice.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isVoiceSupported, listen, composeText, errorKind, REFUSED_ERRORS,
} from '../js/voice.js';

// js/voice.js's listen() (home-screen spec § 3) against a fake
// SpeechRecognition. The fake records every instance and every call in one
// ordered log; stop() records whether the handlers were already detached when
// it ran, because the spec's order is detach -> stop() -> abort().

let calls;
let instances;
class FakeSR {
  constructor() {
    instances.push(this);
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
  }

  start() {
    calls.push('start');
    if (FakeSR.failStart) throw new Error('InvalidStateError');
  }

  stop() { calls.push(this.onresult === null ? 'stop(detached)' : 'stop(attached)'); }

  abort() { calls.push('abort'); }
}

// A result list as the browser delivers it: array-like results, each an
// array-like of alternatives carrying isFinal.
const results = (...rs) => rs.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
const resultEvent = (...rs) => ({ results: results(...rs) });

function recorder() {
  const log = { text: [], end: 0, error: [] };
  return {
    log,
    cbs: {
      onText: (t) => { log.text.push(t); },
      onEnd: () => { log.end += 1; },
      onError: (c) => { log.error.push(c); },
    },
  };
}

beforeEach(() => {
  calls = [];
  instances = [];
  FakeSR.failStart = false;
  globalThis.window = { SpeechRecognition: FakeSR };
});
afterEach(() => { delete globalThis.window; });

test('isVoiceSupported: true with SpeechRecognition or its webkit name, false with neither', () => {
  assert.equal(isVoiceSupported(), true);
  globalThis.window = { webkitSpeechRecognition: FakeSR };
  assert.equal(isVoiceSupported(), true);
  globalThis.window = {};
  assert.equal(isVoiceSupported(), false);
});

test('listen refuses to run without its three callbacks, or without SpeechRecognition', () => {
  const { cbs } = recorder();
  for (const name of ['onText', 'onEnd', 'onError']) {
    assert.throws(() => listen({ ...cbs, [name]: undefined }), new RegExp(name));
  }
  globalThis.window = {};
  assert.throws(() => listen(cbs), /isVoiceSupported/);
  assert.equal(instances.length, 0, 'nothing was created');
});

test('each listen makes a NEW recognizer: continuous, with live words, started once', () => {
  const { cbs } = recorder();
  listen(cbs);
  listen(cbs);
  assert.equal(instances.length, 2);
  assert.notEqual(instances[0], instances[1]);
  for (const r of instances) {
    assert.equal(r.continuous, true);
    assert.equal(r.interimResults, true);
    assert.equal(r.lang, 'en-US');
  }
  assert.deepEqual(calls, ['start', 'start']);
});

test('each result shows prefix + every final + the current interim, rebuilt from e.results', () => {
  const { log, cbs } = recorder();
  listen({ prefix: 'Shopping:', ...cbs });
  const rec = instances[0];
  rec.onresult(resultEvent(['buy', false]));
  rec.onresult(resultEvent(['buy milk', true], [' and', false]));
  rec.onresult(resultEvent(['buy milk', true], [' and eggs', true]));
  assert.deepEqual(log.text, ['Shopping: buy', 'Shopping: buy milk and', 'Shopping: buy milk and eggs']);
});

test('composeText joins the prefix with one space, and returns the prefix untouched when nothing was said', () => {
  assert.equal(composeText('', results(['  hello', true])), 'hello');
  assert.equal(composeText('Call mom', results(['tomorrow', false])), 'Call mom tomorrow');
  assert.equal(composeText('Call mom ', results(['tomorrow', false])), 'Call mom tomorrow');
  assert.equal(composeText('Call mom', results()), 'Call mom');
  assert.equal(composeText('Call mom', results(['  ', false])), 'Call mom');
  assert.equal(composeText('a', results(['b', true], [' c', false])), 'a b c');
});

test('stop detaches first, then calls stop() and abort(), and nothing arrives afterwards', () => {
  const { log, cbs } = recorder();
  const session = listen(cbs);
  const rec = instances[0];
  // What a browser may still hold after the handlers are replaced.
  const { onresult, onend, onerror } = rec;
  rec.onresult(resultEvent(['hello', false]));
  session.stop();
  assert.deepEqual(calls, ['start', 'stop(detached)', 'abort']);
  assert.equal(rec.onresult, null);
  assert.equal(rec.onend, null);
  assert.equal(rec.onerror, null);
  onresult(resultEvent(['hello world', true]));
  onend();
  onerror({ error: 'no-speech' });
  assert.deepEqual(log.text, ['hello'], 'a late result does not change the text');
  assert.equal(log.end, 0, 'a late end is not reported');
  assert.deepEqual(log.error, []);
  session.stop();
  assert.deepEqual(calls, ['start', 'stop(detached)', 'abort'], 'a second stop does nothing');
});

test('recognition ending on its own is reported once, and nothing after it is', () => {
  const { log, cbs } = recorder();
  const session = listen(cbs);
  const rec = instances[0];
  const { onresult, onerror } = rec;
  rec.onend();
  assert.equal(log.end, 1);
  onresult(resultEvent(['late', true]));
  onerror({ error: 'network' });
  assert.deepEqual(log.text, []);
  assert.deepEqual(log.error, []);
  session.stop();
  assert.deepEqual(calls, ['start'], 'stop after the end calls neither stop() nor abort()');
});

test('an error is reported once with its code, and the end that follows is ignored', () => {
  const { log, cbs } = recorder();
  listen(cbs);
  const rec = instances[0];
  const { onend } = rec;
  rec.onerror({ error: 'not-allowed' });
  onend();
  assert.deepEqual(log.error, ['not-allowed']);
  assert.equal(log.end, 0);
  listen(cbs);
  instances[1].onerror({});
  assert.deepEqual(log.error, ['not-allowed', 'unknown'], 'an error with no code still reports');
});

test('a start() that throws reports start-failed and returns no session', () => {
  const { log, cbs } = recorder();
  FakeSR.failStart = true;
  assert.equal(listen(cbs), null);
  assert.deepEqual(log.error, ['start-failed']);
  assert.equal(instances[0].onresult, null, 'and nothing stays attached');
});

test('a constructor that throws reports start-failed too and returns no session', () => {
  const { log, cbs } = recorder();
  globalThis.window = { SpeechRecognition: function Broken() { throw new Error('nope'); } };
  assert.equal(listen(cbs), null);
  assert.deepEqual(log.error, ['start-failed']);
});

test('errorKind:not-allowed and service-not-allowed are refusals; every other code is retry', () => {
  assert.deepEqual(REFUSED_ERRORS, ['not-allowed', 'service-not-allowed']);
  assert.equal(errorKind('not-allowed'), 'refused');
  assert.equal(errorKind('service-not-allowed'), 'refused');
  for (const code of ['no-speech', 'audio-capture', 'network', 'aborted', 'start-failed', 'unknown']) {
    assert.equal(errorKind(code), 'retry', code);
  }
});
```

- [ ] **Step 2: Run; it fails.** `node --test tests/voice.test.js` → `# tests 1`, `# fail 1` (`not ok 1 - tests/voice.test.js`: `listen`, `composeText`, `errorKind`, `REFUSED_ERRORS` are not exported).

- [ ] **Step 3: Implement.** Append this block to `js/voice.js`, after `dictate()`, separated by one blank line (`scripts/t2_impl_edit.py files/voice_listen_block.js` does exactly that):

```js
// --- listen(): the capture button's listen (home-screen spec § 3) ----------
//
// What the 2026-10-20 iPhone spike (voice-test.html, commits f2ff20d..8b4e819)
// established, and so what this is built around:
//   - a NEW SpeechRecognition per listen, never a reused one;
//   - `continuous` + `interimResults`, so words appear as they are said;
//   - after stop() NO final result arrives (textAfterStop=null) and onend may
//     not fire at all. So the caller never waits for one: the text already
//     on screen IS what gets added, and stop() detaches every handler BEFORE
//     calling stop() and then abort(), so nothing late can change it.
//
// listen({ prefix, onText, onEnd, onError }) -> session | null
//   prefix   the field's text when the listen started; every result shows
//            prefix + all finals + the current interim (composeText).
//   onText   (text) on every result.
//   onEnd    () when recognition ended on its own (not after stop()).
//   onError  (code) on an error — e.error, e.g. 'not-allowed' — or
//            'start-failed' when the constructor or start() throws. Ends the listen.
//   session  { stop() }: detach, then stop(), then abort(). Idempotent.
//   null     only when the constructor or start() threw (onError has already
//            been called).
// Throws when there is no SpeechRecognition: callers check
// isVoiceSupported() inside the tap first, and must not reach here without it.

// The two error codes that mean "voice is refused here", not "try again".
export const REFUSED_ERRORS = ['not-allowed', 'service-not-allowed'];

export function errorKind(code) {
  return REFUSED_ERRORS.includes(code) ? 'refused' : 'retry';
}

// prefix + every final + the current interim, rebuilt from the WHOLE result
// list each time (e.results), joined to the prefix by exactly one space.
// Nothing said yet: the prefix, untouched.
export function composeText(prefix, results) {
  let finals = '';
  let interim = '';
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (r.isFinal) finals += r[0].transcript;
    else interim += r[0].transcript;
  }
  const spoken = `${finals}${interim}`.trim();
  if (!spoken) return prefix;
  if (!prefix || /\s$/.test(prefix)) return `${prefix}${spoken}`;
  return `${prefix} ${spoken}`;
}

export function listen({ prefix = '', onText, onEnd, onError } = {}) {
  for (const [name, fn] of Object.entries({ onText, onEnd, onError })) {
    if (typeof fn !== 'function') throw new Error(`listen: ${name} must be a function`);
  }
  const SR = getRecognizer();
  if (!SR) throw new Error('listen: no SpeechRecognition here — check isVoiceSupported() first');
  // A constructor that throws reports like a start() that throws (DA M4): an
  // escaping throw would leave the box open with nothing listening.
  let rec;
  try {
    rec = new SR();
  } catch {
    onError('start-failed');
    return null;
  }
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  // `live` as well as nulling the handlers: a browser that already holds a
  // reference to a handler can still call it after it was replaced.
  let live = true;
  const detach = () => {
    live = false;
    rec.onresult = null;
    rec.onend = null;
    rec.onerror = null;
  };
  rec.onresult = (e) => { if (live) onText(composeText(prefix, e.results)); };
  rec.onerror = (e) => {
    if (!live) return;
    detach();
    onError((e && e.error) || 'unknown');
  };
  rec.onend = () => {
    if (!live) return;
    detach();
    onEnd();
  };
  try {
    rec.start();
  } catch {
    detach();
    onError('start-failed');
    return null;
  }
  return {
    stop() {
      if (!live) return;
      detach();
      rec.stop();
      rec.abort();
    },
  };
}
```

```python
# Task 2 (implementation side): append listen(), composeText(), errorKind()
# and REFUSED_ERRORS to js/voice.js, after dictate() (which stays until Task 6).
# Usage, from the repo root: python3 t2_impl_edit.py <path to voice_listen_block.js>
import pathlib, sys
block = pathlib.Path(sys.argv[1]).read_text()
p = pathlib.Path('js/voice.js')
s = p.read_text()
assert 'export function listen(' not in s, 'listen() is already there'
assert s.endswith('  return rec;\n}\n'), 'voice.js does not end with dictate()'
p.write_text(s + '\n' + block)
print('ok')
```

- [ ] **Step 4: Run; it passes.** `node --test tests/voice.test.js` → `# tests 11`, `# pass 11`.

- [ ] **Step 5: Mutants.**

| Mutant | Plant | Fails |
|---|---|---|
| V1 not continuous | `rec.continuous = true;` → `false` | `each listen makes a NEW recognizer …` |
| V2 no live guard on results | `rec.onresult = (e) => { if (live) onText(` → `if (true) onText(` | `stop detaches first …`, `recognition ending on its own …` |
| V3 stop before detach | in `stop()`: `detach(); rec.stop(); rec.abort();` → `rec.stop(); detach(); rec.abort();` | `stop detaches first …` |
| V4 no abort | delete `rec.abort();` in `stop()` | `stop detaches first …` |
| V5 joined with no space | `` return `${prefix} ${spoken}`; `` → `` return `${prefix}${spoken}`; `` | `each result shows prefix …`, `composeText joins …` |
| V6 an error does not detach | delete `detach();` in `onerror` | `an error is reported once …` |
| V7 service-not-allowed is retry | `REFUSED_ERRORS = ['not-allowed']` | `errorKind: …` |
| V8 a reused recognizer | inside the try: `rec = new SR();` → `rec = (globalThis.__rec \|\|= new SR());` (corrected during execution: the first table quoted the pre-review line) | `each listen makes a NEW recognizer …` (and others) |
| V9 interim dropped | `else interim += r[0].transcript;` → `else interim += '';` | `each result shows prefix …`, `composeText joins …`, `stop detaches first …` |
| V10 constructor outside the try | the `let rec; try { rec = new SR(); } catch { … }` block → `const rec = new SR();` | `a constructor that throws reports start-failed …` |

- [ ] **Step 6: Gate and commit.** Expected: `# tests 1547`, `# fail 0`, `# cancelled 0`. Message: `Stage 4: listen() in voice.js — a new recognizer per listen, live words, stop-and-detach`, body naming spec § 3 and the 2026-10-20 spike's findings, then your Co-Authored-By line. Files: `js/voice.js tests/voice.test.js`.

---

## Task 3: the capture button and box — markup and CSS

**Files:**
- Modify: `index.html` (the box and button after `#sheet-host`), `styles.css` (the capture block at the end), `tests/styles.test.js`

The box is static here (hidden; nothing drives it until Task 4/6). `apply.test.js` mounts the new ids automatically and app.js does not look them up yet.

- [ ] **Step 1: Write the failing tests** with `scripts/t3_styles_edit.py`. It adds `.capture-text` to the 16 px input rules; replaces the stage-2 test "press state is instant, and the stylesheet declares no motion yet" (whose comment says stage 4 must change it) with three motion tests; lets the capture box read the new type scale (spec § 5: Today, tab bar, capture box are the new screens); extends the layers test with 6 and 8; and adds eleven capture tests:

```python
# Task 3: tests/styles.test.js edits. Run from the repo root.
import pathlib
p = pathlib.Path('tests/styles.test.js')
s = p.read_text()

def rep(old, new):
    global s
    assert s.count(old) == 1, f'expected exactly one: {old[:70]!r} (found {s.count(old)})'
    s = s.replace(old, new)

# 1. .capture-text joins the 16px input rules.
rep("""  '.feed-add input', '.link-ui input', '.preview-row input', '.preview-row select',
];""", """  '.feed-add input', '.link-ui input', '.preview-row input', '.preview-row select',
  '.capture-text',
];""")

# 2. The "no motion yet" test becomes the capture panel's motion tests.
rep("""// Feedback on touch-down means instantly. And stage 2 adds no motion at all,
// so nothing needs a prefers-reduced-motion override yet: stage 4's capture
// box is the first animation, and it must add that override and change this.
test('press state is instant, and the stylesheet declares no motion yet', () => {
  assert.equal(declOf('button.pressed', 'transition'), null);
  assert.equal(declOf('[data-press].pressed', 'transition'), null);
  assert.doesNotMatch(css, /(^|[;{\\s])(transition|animation)(-[a-z-]+)?\\s*:/);
  assert.doesNotMatch(css, /@keyframes/);
});""", """// Feedback on touch-down means instantly. Stage 4's capture box is the one
// animation in the app (spec § 5: "Nothing else animates"), and it carries
// the prefers-reduced-motion override.
//
// The body of the top-level at-rule whose prelude is exactly `prelude`
// (`@media (prefers-reduced-motion: reduce)`, `@keyframes capture-grow`), so
// a test can read declarations inside it alone. Throws when there is none.
function atRuleBody(prelude, source = css) {
  let depth = 0;
  let start = 0;
  let bodyStart = 0;
  let current = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '{') {
      if (depth === 0) { current = source.slice(start, i).trim(); bodyStart = i + 1; }
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        if (current === prelude) return source.slice(bodyStart, i);
        start = i + 1;
      }
    }
  }
  throw new Error(`styles.css has no ${prelude} block`);
}
const CAPTURE_KEYFRAMES = ['capture-fade-in', 'capture-fade-out', 'capture-grow', 'capture-shrink'];

test('press state is instant, nothing transitions, and the only animation is the capture panel\\'s', () => {
  assert.equal(declOf('button.pressed', 'transition'), null);
  assert.equal(declOf('[data-press].pressed', 'transition'), null);
  assert.doesNotMatch(css, /(^|[;{\\s])transition(-[a-z-]+)?\\s*:/);
  const animated = rulesOf(css)
    .filter(({ body }) => /(^|[;{\\s])animation(-[a-z-]+)?\\s*:/.test(body))
    .map(({ sel }) => sel.replace(/\\s+/g, ' '));
  assert.deepEqual([...new Set(animated)].sort(), [
    '.capture-box.closing .capture-panel', '.capture-box.closing.fade .capture-panel', '.capture-panel',
  ]);
  assert.deepEqual([...css.matchAll(/@keyframes\\s+([\\w-]+)/g)].map((m) => m[1]).sort(), CAPTURE_KEYFRAMES);
});

test('the capture panel grows from the button\\'s corner in 250ms and shrinks back; with the keyboard up it fades', () => {
  assert.equal(declOf('.capture-panel', 'animation'), 'capture-grow 250ms ease-out');
  assert.equal(declOf('.capture-panel', 'transform-origin'), 'bottom right');
  assert.equal(declOf('.capture-box.closing .capture-panel', 'animation'), 'capture-shrink 250ms ease-out forwards');
  assert.equal(declOf('.capture-box.closing.fade .capture-panel', 'animation-name'), 'capture-fade-out');
  // transform and opacity only (spec § 5).
  for (const name of CAPTURE_KEYFRAMES) {
    for (const { body } of rulesOf(atRuleBody(`@keyframes ${name}`))) {
      for (const decl of body.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        assert.ok(['transform', 'opacity'].includes(decl.slice(0, i).trim()), `${name} animates ${decl.trim()}`);
      }
    }
  }
});

test('under reduced motion the capture panel only fades', () => {
  const reduced = atRuleBody('@media (prefers-reduced-motion: reduce)');
  assert.equal(declOf('.capture-panel', 'animation-name', reduced), 'capture-fade-in');
  assert.equal(declOf('.capture-box.closing .capture-panel', 'animation-name', reduced), 'capture-fade-out');
});""")

# 3. The layers test gains the capture button (6) and the capture box (8).
rep("""test('layers: tab bar 5 < settings 10 < item sheet 15 < toast 20 (spec § 4)', () => {
  assert.equal(zIndexOf('.tab-bar'), 5);
  assert.equal(zIndexOf('.settings-backdrop'), 10);""", """test('layers: tab bar 5 < capture button 6 < capture box 8 < settings 10 < item sheet 15 < toast 20 (spec § 4)', () => {
  assert.equal(zIndexOf('.tab-bar'), 5);
  assert.equal(zIndexOf('.capture-btn'), 6);
  assert.equal(zIndexOf('.capture-box'), 8);
  assert.equal(zIndexOf('.settings-backdrop'), 10);""")

# 3b. The capture box is one of the spec's new screens (§ 5: "New screens only
# (Today, tab bar, capture box)"), so it may read the new type scale.
rep("""// grid itself (week-) keeps its compact sizes.
const NEW_SCREEN = /\\.(today-|tab-|cal-switch|wlist-|sheet-tags?(?![\\w-]))/;""", """// grid itself (week-) keeps its compact sizes. The capture box (capture-,
// stage 4) is the spec's third new screen.
const NEW_SCREEN = /\\.(today-|tab-|cal-switch|wlist-|capture-|sheet-tags?(?![\\w-]))/;""")

# 4. New tests at the end of the file.
s += """
// --- home-screen stage 4: the capture button and box (spec § 3, § 4, § 5) ---
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the capture button is a 56px accent circle, 16px from the right and 16px above the tab bar', () => {
  assert.equal(declOf('.capture-btn', 'position'), 'fixed');
  assert.equal(declOf('.capture-btn', 'right'), '16px');
  assert.equal(declOf('.capture-btn', 'bottom'), 'calc(56px + 16px + env(safe-area-inset-bottom))');
  assert.equal(declOf('.capture-btn', 'width'), '56px');
  assert.equal(declOf('.capture-btn', 'height'), '56px');
  assert.equal(declOf('.capture-btn', 'border-radius'), 'var(--radius-round)');
  assert.equal(declOf('.capture-btn', 'background'), 'var(--accent)');
  assert.equal(declOf('.capture-btn', 'color'), 'var(--accent-ink)');
  assert.equal(declOf('.capture-btn', 'box-shadow'), null, 'shadows are for the box, sheets and the toast only');
});

test('pressed, the capture button scales instead of dimming', () => {
  assert.equal(declOf('.capture-btn.pressed', 'transform'), 'scale(0.94)');
  assert.equal(declOf('.capture-btn.pressed', 'opacity'), '1');
});

test('listening, the capture button shows a stop square instead of the mic', () => {
  assert.equal(declOf('.capture-btn .icon-stop', 'display'), 'none');
  assert.equal(declOf('.capture-btn.listening .icon-mic', 'display'), 'none');
  assert.equal(declOf('.capture-btn.listening .icon-stop', 'display'), 'block');
});

test('the capture button is not shown while Settings or the item sheet is open', () => {
  assert.equal(declOf('#settings-host:not(:empty) ~ .capture-btn', 'display'), 'none');
  assert.equal(declOf('#sheet-host:not(:empty) ~ .capture-btn', 'display'), 'none');
});

// `~` matches a LATER sibling only, so the rules above depend on the order.
test('index.html puts the capture button after both hosts, as siblings in body', () => {
  const at = (needle) => {
    const i = indexHtml.indexOf(needle);
    assert.ok(i >= 0, `index.html has no ${needle}`);
    return i;
  };
  const btn = at('<button id="capture-btn" class="capture-btn" type="button"');
  assert.ok(btn > at('<div id="settings-host"></div>'));
  assert.ok(btn > at('<div id="sheet-host"></div>'));
  assert.ok(at('<script type="module" src="js/app.js"></script>') > btn);
  assert.match(indexHtml, /<div id="capture-box" class="capture-box" hidden>/, 'the box starts hidden');
});

test('the capture box sits just above the button, and 8px above the keyboard while typing', () => {
  assert.equal(declOf('.capture-box', '--capture-lift'), 'calc(56px + 16px + 56px + 8px + env(safe-area-inset-bottom))');
  assert.equal(declOf('.capture-box', 'bottom'), 'var(--capture-lift)');
  assert.equal(declOf('.capture-box.typing', '--capture-lift'), '8px');
  assert.equal(declOf('.capture-box', 'position'), 'fixed');
  assert.equal(declOf('.capture-box', 'left'), '16px');
  assert.equal(declOf('.capture-box', 'right'), '16px');
  assert.equal(declOf('.capture-box', 'max-height'), '50dvh');
  assert.equal(declOf('.capture-box[hidden]', 'display'), 'none');
});

test('the capture panel has the sheet radius and a shadow, and scrolls inside itself', () => {
  assert.equal(declOf('.capture-panel', 'border-radius'), 'var(--radius-sheet)');
  assert.notEqual(declOf('.capture-panel', 'box-shadow'), null);
  assert.equal(declOf('.capture-panel', 'overflow-y'), 'auto');
  assert.equal(declOf('.capture-panel', 'overscroll-behavior'), 'contain');
  assert.equal(declOf('.capture-panel', 'min-height'), '0');
});

test('every capture control is a 44px target', () => {
  assert.ok(px(declOf('.capture-close', 'min-width')) >= 44);
  assert.ok(px(declOf('.capture-actions button', 'min-height')) >= 44, 'x, Cancel and Add are all in this row');
  assert.ok(px(declOf('.capture-type', 'min-height')) >= 44);
  assert.match(indexHtml, /<div class="capture-actions">\\s*<button id="capture-close"/, 'x is in the actions row');
});

// Add must stay reachable in a box that may be ~200px tall with the keyboard
// up (DA I3): the field stops growing at five lines, and the actions row is
// the panel's last child, stuck to its bottom edge.
test('Add stays reachable: the field stops growing, and the actions row sticks to the bottom', () => {
  assert.equal(declOf('.capture-text', 'max-height'), '120px');
  assert.equal(declOf('.capture-text', 'overflow-y'), 'auto');
  assert.equal(declOf('.capture-actions', 'position'), 'sticky');
  assert.equal(declOf('.capture-actions', 'bottom'), '0');
  assert.equal(declOf('.capture-actions', 'background'), 'var(--card)', 'opaque, so scrolled content does not show through');
  const panel = indexHtml.slice(indexHtml.indexOf('<div class="capture-panel"'), indexHtml.indexOf('<button id="capture-btn"'));
  assert.ok(panel.lastIndexOf('<div class="capture-actions">') > panel.indexOf('id="capture-preview"'),
    'the actions row comes after the preview');
});

test('a closing capture box lets taps through to the page', () => {
  assert.equal(declOf('.capture-box.closing', 'pointer-events'), 'none');
});

test('the capture box\\'s Cancel is secondary, like the preview\\'s and the sheet\\'s', () => {
  assert.match(indexHtml, /<button id="capture-cancel" class="cancel" type="button" hidden>Cancel<\\/button>/);
  assert.equal(declOf('.capture-actions .cancel', 'background'), 'var(--card)');
  assert.equal(declOf('.capture-actions .cancel', 'border'), '1px solid var(--line)');
});
"""
p.write_text(s)
print('ok')
```

- [ ] **Step 2: Run; it fails.** `node --test tests/styles.test.js` → `# tests 132`, `# pass 116`, `# fail 16`: `.capture-text is at least 16px`; the three motion tests; the layers test; the eleven capture tests (`index.html puts the capture button after both hosts …` included).

- [ ] **Step 3: Implement** with `scripts/t3_impl_edit.py files/index_block.html files/capture.css`. It inserts this right after `  <div id="sheet-host"></div>` in `index.html`:

```html
  <!-- The capture box and its round button (home-screen spec § 3), driven by
       js/capture.js. They come AFTER both hosts above on purpose: styles.css
       hides the button with `#settings-host:not(:empty) ~ .capture-btn` and
       `#sheet-host:not(:empty) ~ .capture-btn`, and `~` only matches a LATER
       sibling. The box is not a modal: no backdrop, no tap-outside-to-close. -->
  <div id="capture-box" class="capture-box" hidden>
    <div class="capture-panel" role="region" aria-label="Capture">
      <textarea id="capture-text" class="capture-text" rows="2" autocomplete="off"
                placeholder="Say it, or tap here to type"></textarea>
      <p id="capture-message" class="message" role="status"></p>
      <button id="capture-type" class="capture-type" type="button" hidden>Type instead</button>
      <section id="capture-preview" class="capture-preview" hidden></section>
      <!-- One row, last and sticky at the panel's bottom, so Add stays
           reachable however much text or preview there is: x on the left,
           Cancel / Add on the right. -->
      <div class="capture-actions">
        <button id="capture-close" class="capture-close" type="button" aria-label="Close">&times;</button>
        <button id="capture-cancel" class="cancel" type="button" hidden>Cancel</button>
        <button id="capture-add" type="button">Add</button>
      </div>
    </div>
  </div>
  <button id="capture-btn" class="capture-btn" type="button"
          aria-label="Capture by voice" aria-expanded="false" aria-controls="capture-box">
    <svg class="icon-mic" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"
         fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3"></rect>
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>
    </svg>
    <svg class="icon-stop" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"></rect>
    </svg>
  </button>
```

and appends this to the end of `styles.css` after one blank line:

```css
/* ---------- capture button and box (home-screen spec § 3, § 4, § 5) ---------- */
/* The round button: bottom right on every page, 16px above the tab bar, on
   layer 6. No shadow: shadows are for the capture box, sheets and the toast. */
.capture-btn {
  position: fixed;
  right: 16px;
  bottom: calc(56px + 16px + env(safe-area-inset-bottom));
  z-index: 6;
  width: 56px;
  height: 56px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-round);
  background: var(--accent);
  color: var(--accent-ink);
}
/* Pressed, it scales instead of dimming (spec § 5). */
.capture-btn.pressed { opacity: 1; transform: scale(0.94); }
/* Disabled while a smart add is thinking (the adding latch, js/capture.js). */
.capture-btn:disabled { opacity: 0.5; }
/* The mic, or while listening a stop square (no pulsing). */
.capture-btn .icon-stop { display: none; }
.capture-btn.listening .icon-mic { display: none; }
.capture-btn.listening .icon-stop { display: block; }
/* Not shown while Settings or the item sheet is open (spec § 3). Each host is
   empty exactly when its panel is closed (both close with innerHTML = ''), and
   the button follows both hosts in index.html. */
#settings-host:not(:empty) ~ .capture-btn,
#sheet-host:not(:empty) ~ .capture-btn { display: none; }

/* The box, on layer 8. The OUTER wrapper is placed by js/viewport.js (from
   js/capture.js): its bottom edge sits --capture-lift above the visible
   area's bottom edge, which is just above the button with the keyboard down,
   and 8px above the keyboard while the field has focus (.typing). These
   rules are what applies without visualViewport. The INNER panel animates,
   so placement and animation never share a transform (spec § 5). */
.capture-box {
  --capture-lift: calc(56px + 16px + 56px + 8px + env(safe-area-inset-bottom));
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: var(--capture-lift);
  max-height: 50dvh;
  z-index: 8;
  display: flex;
  flex-direction: column;
}
.capture-box[hidden] { display: none; }
.capture-box.typing { --capture-lift: 8px; }
.capture-panel {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--card);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: var(--radius-sheet);
  padding: var(--space-3);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  transform-origin: bottom right;
  animation: capture-grow 250ms ease-out;
}
/* Closing reverses the path; with the keyboard up the button is covered, so
   the box fades out instead (.fade). js/capture.js hides the box after
   CLOSE_MS, the same 250ms. */
.capture-box.closing .capture-panel { animation: capture-shrink 250ms ease-out forwards; }
.capture-box.closing.fade .capture-panel { animation-name: capture-fade-out; }
@keyframes capture-grow { from { transform: scale(0.2); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes capture-shrink { from { transform: none; opacity: 1; } to { transform: scale(0.2); opacity: 0; } }
@keyframes capture-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes capture-fade-out { from { opacity: 1; } to { opacity: 0; } }
/* Reduced motion: the box only fades (spec § 5). */
@media (prefers-reduced-motion: reduce) {
  .capture-panel { animation-name: capture-fade-in; }
  .capture-box.closing .capture-panel { animation-name: capture-fade-out; }
}
/* A closing box is on its way out: taps go to the page under it. */
.capture-box.closing { pointer-events: none; }
/* The field grows (js/capture.js) up to five lines, then scrolls, so the
   actions row stays inside a box that may be only ~200px tall with the
   keyboard up. */
.capture-text {
  width: 100%;
  max-height: 120px;
  overflow-y: auto;
  font-size: 16px;
  font-family: var(--sans);
  padding: var(--space-3);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--ink);
  resize: none;
}
/* x, Cancel and Add in one row, last in the panel and stuck to its bottom
   edge, so Add is reachable however long the text or the preview. */
.capture-actions {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
  margin-top: var(--space-2);
  background: var(--card);
}
.capture-actions button { min-height: 44px; }
/* x on the left, away from Add. */
.capture-close {
  min-width: 44px;
  margin-right: auto;
  padding: 0;
  background: transparent;
  color: var(--muted);
  font-size: var(--text-title);
}
/* Cancel is secondary, as the preview's and the sheet's are. */
.capture-actions .cancel { background: var(--card); color: var(--ink); border: 1px solid var(--line); }
.capture-type { min-height: 44px; margin-top: var(--space-2); }
.capture-preview { margin-top: var(--space-3); }
```

```python
# Task 3 (implementation side): the capture box and button markup, after
# #sheet-host, and the capture CSS at the end of styles.css.
# Usage, from the repo root: python3 t3_impl_edit.py <index_block.html> <capture.css>
import pathlib, sys
block = pathlib.Path(sys.argv[1]).read_text()
css_block = pathlib.Path(sys.argv[2]).read_text()
p = pathlib.Path('index.html')
s = p.read_text()
anchor = '  <div id="sheet-host"></div>\n'
assert s.count(anchor) == 1
p.write_text(s.replace(anchor, anchor + block))
p = pathlib.Path('styles.css')
s = p.read_text()
assert s.endswith('.sheet-external { padding-bottom: calc(16px + env(safe-area-inset-bottom)); }\n')
p.write_text(s + '\n' + css_block)
print('ok')
```

- [ ] **Step 4: Run; it passes.** `node --test tests/styles.test.js` → `# tests 132`, `# pass 132`.

- [ ] **Step 5: Mutants.**

| Mutant | Plant | Fails |
|---|---|---|
| S1 button on layer 9 | `.capture-btn` `z-index: 6` → `9` | `layers: …` |
| S2 no hide rule for the sheet | drop the `#sheet-host:not(:empty) ~ .capture-btn` selector | `the capture button is not shown while …` |
| S3 a transition on the button | add `transition: transform 100ms;` to `.capture-btn.pressed` | `press state is instant, nothing transitions …` |
| S4 no reduced-motion close fade | delete `.capture-box.closing .capture-panel { animation-name: capture-fade-out; }` inside the `@media` | `under reduced motion …` |
| S5 capture text 15px | `.capture-text` `font-size: 16px` → `15px` | `.capture-text is at least 16px` |
| S6 typing lift 16px | `.capture-box.typing { --capture-lift: 8px; }` → `16px` | `the capture box sits just above the button …` |
| S7 grow animates width | add `width: 0;` to `capture-grow`'s `from` | `the capture panel grows from the button's corner …` |
| S8 button before the hosts | insert `<button id="capture-btn" class="capture-btn" type="button"></button>` before `#settings-host` | `index.html puts the capture button after both hosts …` |
| S9 button gets a shadow | add `box-shadow: 0 2px 4px black;` to `.capture-btn` | `the capture button is a 56px accent circle …` |
| S10 the field grows without bound | delete `max-height: 120px;` from `.capture-text` | `Add stays reachable …` |
| S11 the actions row is not sticky | delete `position: sticky;` and `bottom: 0;` from `.capture-actions` | `Add stays reachable …` |
| S12 a closing box takes taps | delete `.capture-box.closing { pointer-events: none; }` | `a closing capture box lets taps through …` |
| S13 Cancel is primary | `index.html`: drop `class="cancel"` from `#capture-cancel` | `the capture box's Cancel is secondary …` |

- [ ] **Step 6: Gate and commit.** Expected: `# tests 1561`, `# fail 0`, `# cancelled 0`. Message: `Stage 4: capture button and box markup and styles (hidden until wired)`. Files: `index.html styles.css tests/styles.test.js`.

---

## Task 4: `js/capture.js` — the capture state machine

**Files:**
- Create: `js/capture.js`, `tests/capture.test.js`
- Modify: `tests/fake-dom.js` (a `blur()`), `service-worker.js` (ASSETS)

- [ ] **Step 1: Write the failing tests.** `scripts/t4_test_edit.py` gives the shared fake DOM a `blur()`:

```python
# Task 4 (test side): the shared fake DOM gains blur(). Run from the repo root.
import pathlib
p = pathlib.Path('tests/fake-dom.js')
s = p.read_text()
old = """  focus(options) {
    globalThis.document.activeElement = this;
    globalThis.document.lastFocusOptions = options;
  }
"""
assert s.count(old) == 1
p.write_text(s.replace(old, old + """
  // As a browser does: only the focused element gives focus up. Fires no
  // event, as focus() fires none here; a test that needs one fires it.
  blur() {
    if (globalThis.document.activeElement === this) globalThis.document.activeElement = null;
  }
"""))
print('ok')
```

Create `tests/capture.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeElement, makeFakeDocument, fire } from './fake-dom.js';
import {
  createCapture, CAPTURE_MESSAGES as M, CAPTURE_MAX_SHARE, CAPTURE_TRANSFORM, CLOSE_MS,
} from '../js/capture.js';
import { errorKind } from '../js/voice.js';

// js/capture.js on its own (home-screen spec § 3): the capture button's state
// machine against a fake voice, a fake viewport follower and fake timers.
// tests/apply.test.js covers it wired into app.js (smart add, the two message
// lines, the triggers that stop a listen).

globalThis.document = makeFakeDocument();

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const tap = (el) => el.click();

// A fake voice. listen() records each session; the test drives the session's
// callbacks (opts.onText / onEnd / onError). `order` is shared with submit,
// so a test can check that a stop came before an add.
function fakeVoice(order) {
  const v = {
    supported: true,
    failNext: false,
    listens: [],
    isVoiceSupported: () => v.supported,
    errorKind,
    listen(opts) {
      const session = { opts, stops: 0, stop() { session.stops += 1; order.push('stop'); } };
      v.listens.push(session);
      if (v.failNext) { v.failNext = false; opts.onError('start-failed'); return null; }
      return session;
    },
    get current() { return v.listens[v.listens.length - 1]; },
  };
  return v;
}

function setup({ standalone = false } = {}) {
  globalThis.document.activeElement = null;
  const make = (tag) => new FakeElement(tag);
  const els = {
    button: make('button'), box: make('div'), field: make('textarea'), add: make('button'),
    cancel: make('button'), close: make('button'), typeInstead: make('button'), preview: make('section'),
  };
  const message = make('p');
  const order = [];
  const voice = fakeVoice(order);
  const fx = {
    els, message, order, voice, standalone,
    follows: [], timers: [], previews: 0, cancels: 0, submits: 0, settles: [],
    get settle() { return fx.settles[fx.settles.length - 1]; },
  };
  // Records blur/focus on the field in order, then does what the fake does.
  const { blur, focus } = els.field;
  els.field.blur = function spyBlur() { order.push('blur'); return blur.call(this); };
  els.field.focus = function spyFocus(o) { order.push('focus'); return focus.call(this, o); };
  fx.capture = createCapture({
    els,
    line: { set(t) { message.textContent = t || ''; } },
    voice: { isVoiceSupported: voice.isVoiceSupported, listen: voice.listen, errorKind: voice.errorKind },
    isStandalone: () => fx.standalone,
    submit: () => {
      fx.submits += 1;
      order.push('submit');
      return new Promise((resolve) => { fx.settles.push(resolve); });
    },
    cancelSubmit: () => { fx.cancels += 1; },
    closePreviews: () => { fx.previews += 1; },
    later: (fn, ms) => { const h = { fn, ms, cleared: false }; fx.timers.push(h); return h; },
    clearLater: (h) => { h.cleared = true; },
    follow: (target, opts) => {
      const f = { target, opts, stops: 0 };
      fx.follows.push(f);
      return () => { f.stops += 1; };
    },
  });
  return fx;
}

// Opens the box listening and has the voice say `text`.
function listening(fx, text) {
  tap(fx.els.button);
  if (text !== undefined) fx.voice.current.opts.onText(text);
}

test('it starts closed: box hidden, button not expanded, nothing listening', () => {
  const { els, capture } = setup();
  assert.equal(els.box.hidden, true);
  assert.equal(els.button.getAttribute('aria-expanded'), 'false');
  assert.equal(els.button.getAttribute('aria-label'), 'Capture by voice');
  assert.equal(els.field.readOnly, false);
  assert.equal(els.cancel.hidden, true);
  assert.equal(els.typeInstead.hidden, true);
  assert.deepEqual(capture.state(), { mode: 'closed', adding: false, refused: false, open: false });
});

test('a tap opens the box, follows the visual viewport, closes any preview and listens', () => {
  const fx = setup();
  tap(fx.els.button);
  assert.equal(fx.els.box.hidden, false);
  assert.equal(fx.follows.length, 1);
  assert.equal(fx.follows[0].target, fx.els.box);
  assert.deepEqual(fx.follows[0].opts, { maxShare: CAPTURE_MAX_SHARE, transform: CAPTURE_TRANSFORM });
  assert.equal(fx.previews, 1, 'a new capture closes any open preview (spec § 3 step 8)');
  assert.equal(fx.voice.listens.length, 1);
  assert.equal(fx.voice.current.opts.prefix, '');
  assert.ok(fx.els.button.classList.contains('listening'));
  assert.equal(fx.els.button.getAttribute('aria-label'), 'Stop and add');
  assert.equal(fx.els.button.getAttribute('aria-expanded'), 'true');
  assert.equal(fx.els.field.readOnly, true);
  assert.equal(fx.capture.state().mode, 'listening');
});

test('live words fill the field and grow it, border included', () => {
  const fx = setup();
  listening(fx);
  // A border-box textarea: scrollHeight leaves out its 2px of border.
  fx.els.field.scrollHeight = 72;
  fx.els.field.offsetHeight = 50;
  fx.els.field.clientHeight = 48;
  fx.voice.current.opts.onText('lunch with sam');
  assert.equal(fx.els.field.value, 'lunch with sam');
  assert.equal(fx.els.field.style.height, '74px');
});

test('a listen while this box\'s own preview is open is a new capture: the old text is not its prefix', () => {
  const fx = setup();
  listening(fx, 'two things on friday');
  fx.voice.current.opts.onEnd();
  fx.els.preview.appendChild(new FakeElement('div'));
  tap(fx.els.button);
  assert.equal(fx.voice.current.opts.prefix, '');
  assert.equal(fx.els.field.value, '');
  assert.equal(fx.previews, 2, 'and the preview is closed');
});

test('released() drops the latch at once and adds nothing', async () => {
  const fx = setup();
  listening(fx, 'lunch');
  tap(fx.els.button);
  assert.equal(fx.capture.state().adding, true, 'fixture check');
  fx.capture.released();
  assert.equal(fx.capture.state().adding, false);
  assert.equal(fx.els.button.disabled, false);
  assert.equal(fx.els.cancel.hidden, true);
  assert.equal(fx.cancels, 0, 'released is not a cancel');
  assert.equal(fx.els.field.value, 'lunch', 'the text is kept');
});

test('a tap while listening stops first, then adds the text shown, behind the adding latch', async () => {
  const fx = setup();
  listening(fx, 'lunch with sam');
  tap(fx.els.button);
  assert.deepEqual(fx.order, ['stop', 'submit'], 'stop-and-detach runs before the add');
  assert.equal(fx.els.field.value, 'lunch with sam', 'the text on screen is what is added; no wait for a final result');
  assert.equal(fx.capture.state().mode, 'typing');
  assert.equal(fx.els.field.readOnly, false);
  assert.equal(fx.els.button.disabled, true);
  assert.equal(fx.els.add.disabled, true);
  assert.equal(fx.els.add.hidden, true, 'Cancel replaces Add');
  assert.equal(fx.els.cancel.hidden, false);
  tap(fx.els.button);
  tap(fx.els.add);
  await tick();
  assert.equal(fx.submits, 1, 'the latch refuses a second add');
  fx.settle('preview');
  await tick();
  assert.equal(fx.capture.state().adding, false);
  assert.equal(fx.els.button.disabled, false);
  assert.equal(fx.els.add.hidden, false);
  assert.equal(fx.els.cancel.hidden, true);
});

test('a tap while listening with nothing heard adds nothing and says so', () => {
  const fx = setup();
  listening(fx, '   ');
  tap(fx.els.button);
  assert.deepEqual(fx.order, ['stop']);
  assert.equal(fx.submits, 0);
  assert.equal(fx.message.textContent, M.nothing);
  assert.equal(fx.capture.state().adding, false);
});

test("the box's own Add stops a listen first too", () => {
  const fx = setup();
  listening(fx, 'call the bank');
  tap(fx.els.add);
  assert.deepEqual(fx.order, ['stop', 'submit']);
});

test('tapping the text while listening stops without adding and focuses it for the keyboard', () => {
  const fx = setup();
  listening(fx, 'dentist');
  fire(fx.els.field, 'click');
  assert.deepEqual(fx.order, ['stop', 'blur', 'focus'], 'blur first: the tap has already focused the read-only field');
  assert.equal(fx.submits, 0);
  assert.equal(fx.els.field.readOnly, false);
  assert.equal(globalThis.document.activeElement, fx.els.field);
  assert.equal(fx.els.field.value, 'dentist', 'text kept');
  assert.equal(fx.capture.state().mode, 'typing');
});

test('recognition ending on its own keeps the text and adds nothing; the next tap appends', () => {
  const fx = setup();
  listening(fx, 'call mom');
  fx.voice.current.opts.onEnd();
  assert.equal(fx.message.textContent, M.stopped);
  assert.equal(fx.capture.state().mode, 'typing');
  assert.equal(fx.submits, 0, 'nothing is added without a tap');
  tap(fx.els.button);
  assert.equal(fx.voice.listens.length, 2);
  assert.equal(fx.voice.current.opts.prefix, 'call mom', 'the new listen appends to the text');
  assert.equal(fx.previews, 2);
  assert.equal(fx.message.textContent, '', 'a new listen clears the old message');
});

test('stopAndKeep stops a listen and keeps its text; when not listening it changes nothing', () => {
  const fx = setup();
  fx.capture.stopAndKeep();
  assert.deepEqual(fx.order, []);
  assert.equal(fx.message.textContent, '');
  listening(fx, 'pick up keys');
  fx.capture.stopAndKeep();
  assert.deepEqual(fx.order, ['stop']);
  assert.equal(fx.message.textContent, M.stopped);
  assert.equal(fx.els.field.value, 'pick up keys');
  assert.equal(fx.submits, 0);
  assert.equal(fx.els.box.hidden, false, 'the box stays open');
});

for (const [standalone, text] of [[false, M.safari], [true, M.permission]]) {
  test(`a refusal in ${standalone ? 'the home-screen app' : 'a Safari tab'} says why, offers Type instead, and never focuses`, () => {
    const fx = setup({ standalone });
    listening(fx, 'half a thought');
    fx.order.length = 0;
    fx.voice.current.opts.onError('service-not-allowed');
    assert.equal(fx.message.textContent, text);
    assert.equal(fx.els.typeInstead.hidden, false);
    assert.equal(fx.capture.state().mode, 'typing');
    assert.deepEqual(fx.order, [], 'no focus from an asynchronous error');
    assert.equal(globalThis.document.activeElement, null);
    tap(fx.els.typeInstead);
    assert.equal(fx.els.typeInstead.hidden, true);
    assert.equal(globalThis.document.activeElement, fx.els.field, 'Type instead focuses within its own tap');
    // Later taps this session go straight to typing.
    tap(fx.els.button);
    assert.equal(fx.voice.listens.length, 1, 'no second listen');
    assert.equal(fx.message.textContent, text);
    assert.equal(globalThis.document.activeElement, fx.els.field);
    assert.equal(fx.capture.state().refused, true);
  });
}

test('no-speech, audio-capture and network say try again, with no Type instead and no focus', () => {
  for (const code of ['no-speech', 'audio-capture', 'network']) {
    const fx = setup();
    listening(fx);
    fx.order.length = 0;
    fx.voice.current.opts.onError(code);
    assert.equal(fx.message.textContent, M.retry, code);
    assert.equal(fx.els.typeInstead.hidden, true, code);
    assert.deepEqual(fx.order, [], code);
    assert.equal(fx.capture.state().mode, 'typing', code);
    assert.equal(fx.capture.state().refused, false, code);
  }
});

test('a start() that fails reads as try again', () => {
  const fx = setup();
  fx.voice.failNext = true;
  tap(fx.els.button);
  assert.equal(fx.message.textContent, M.retry);
  assert.equal(fx.capture.state().mode, 'typing');
});

test('without SpeechRecognition a tap opens the box to type in, focused, and says so', () => {
  const fx = setup();
  fx.voice.supported = false;
  tap(fx.els.button);
  assert.equal(fx.els.box.hidden, false);
  assert.equal(fx.voice.listens.length, 0);
  assert.equal(fx.message.textContent, M.unsupported);
  assert.equal(globalThis.document.activeElement, fx.els.field);
  assert.equal(fx.capture.state().mode, 'typing');
});

test('Cancel during Thinking clears the latch and keeps the text; a late settle changes nothing', async () => {
  const fx = setup();
  listening(fx, 'dentist on may 15');
  tap(fx.els.button);
  const firstSettle = fx.settle;
  tap(fx.els.cancel);
  assert.equal(fx.cancels, 1);
  assert.equal(fx.message.textContent, M.cancelled);
  assert.equal(fx.capture.state().adding, false);
  assert.equal(fx.els.button.disabled, false);
  assert.equal(fx.els.field.value, 'dentist on may 15');
  tap(fx.els.add);
  await tick();
  assert.equal(fx.submits, 2);
  firstSettle('superseded');
  await tick();
  assert.equal(fx.capture.state().adding, true, 'the newer add keeps its latch through the older settle');
  assert.equal(fx.els.button.disabled, true);
  fx.settle('failed');
  await tick();
  assert.equal(fx.capture.state().adding, false);
});

test('added() clears the latch and closes an empty box; text typed meanwhile keeps it open', async () => {
  const fx = setup();
  listening(fx, 'lunch');
  tap(fx.els.button);
  fx.els.field.value = '';
  fx.capture.added();
  assert.equal(fx.capture.state().adding, false);
  assert.equal(fx.cancels, 0, 'a success is not a cancel');
  assert.ok(fx.els.box.classList.contains('closing'));
  const fx2 = setup();
  listening(fx2, 'lunch');
  tap(fx2.els.button);
  fx2.els.field.value = 'and the next thing';
  fx2.capture.added();
  assert.equal(fx2.capture.state().adding, false);
  assert.equal(fx2.els.box.classList.contains('closing'), false);
  assert.equal(fx2.capture.state().mode, 'typing');
});

test('x stops listening, clears everything, and closes with the grow-back animation', () => {
  const fx = setup();
  listening(fx, 'never mind');
  fx.els.preview.appendChild(new FakeElement('div'));
  fx.els.preview.hidden = false;
  fx.els.field.style.height = '72px';
  tap(fx.els.close);
  assert.deepEqual(fx.order.filter((x) => x !== 'blur'), ['stop']);
  assert.equal(fx.els.field.value, '');
  assert.equal(fx.els.field.style.height, '');
  assert.equal(fx.message.textContent, '');
  assert.equal(fx.els.preview.children.length, 0);
  assert.equal(fx.els.preview.hidden, true);
  assert.ok(fx.els.box.classList.contains('closing'));
  assert.equal(fx.els.box.classList.contains('fade'), false);
  assert.equal(fx.els.box.hidden, false, 'still showing while it animates');
  assert.equal(fx.els.button.getAttribute('aria-expanded'), 'false');
  assert.equal(fx.timers.length, 1);
  assert.equal(fx.timers[0].ms, CLOSE_MS);
  fx.timers[0].fn();
  assert.equal(fx.els.box.hidden, true);
  assert.equal(fx.els.box.classList.contains('closing'), false);
  assert.equal(fx.follows[0].stops, 1, 'and stops following the viewport');
});

// focusin/focusout as a browser sends them to the box: they bubble from the
// control, and focusout names where focus is going (relatedTarget).
function focusEvent(fx, type, target, relatedTarget = null) {
  for (const fn of fx.els.box._listeners[type] || []) fn({ target, relatedTarget });
}

test('the box drops to the keyboard while the field or a preview input has focus, and not for a read-only field', () => {
  const fx = setup();
  listening(fx, 'typed');
  const box = fx.els.box;
  focusEvent(fx, 'focusin', fx.els.field);
  assert.equal(box.classList.contains('typing'), false, 'a read-only focus raises no keyboard');
  fx.voice.current.opts.onEnd();
  focusEvent(fx, 'focusin', fx.els.field);
  assert.ok(box.classList.contains('typing'));
  // Into the preview's title input: still typing, no flicker.
  const input = new FakeElement('input');
  fx.els.preview.appendChild(input);
  fx.els.box.appendChild(fx.els.preview);
  focusEvent(fx, 'focusout', fx.els.field, input);
  assert.ok(box.classList.contains('typing'), 'moving between two inputs in the box keeps it');
  focusEvent(fx, 'focusin', input);
  assert.ok(box.classList.contains('typing'));
  // Out to a button (no keyboard): the box goes back above the round button.
  focusEvent(fx, 'focusout', input, fx.els.add);
  assert.equal(box.classList.contains('typing'), false);
  // A preview input alone raises it too.
  focusEvent(fx, 'focusin', input);
  assert.ok(box.classList.contains('typing'));
  focusEvent(fx, 'focusout', input, null);
  assert.equal(box.classList.contains('typing'), false);
});

test('x with the keyboard up fades where it is, keeping its place until it is hidden', () => {
  const fx = setup();
  listening(fx, 'typed');
  fx.voice.current.opts.onEnd();
  focusEvent(fx, 'focusin', fx.els.field);
  tap(fx.els.close);
  focusEvent(fx, 'focusout', fx.els.field, null); // the blur close() causes
  assert.ok(fx.els.box.classList.contains('fade'));
  assert.ok(fx.els.box.classList.contains('closing'));
  assert.ok(fx.els.box.classList.contains('typing'), 'no jump up before the fade');
  fx.timers[0].fn();
  assert.equal(fx.els.box.classList.contains('typing'), false);
  assert.equal(fx.els.box.hidden, true);
});

test('x during Thinking discards the request', () => {
  const fx = setup();
  listening(fx, 'lunch');
  tap(fx.els.button);
  tap(fx.els.close);
  assert.equal(fx.cancels, 1);
  assert.equal(fx.capture.state().adding, false);
  assert.ok(fx.els.box.classList.contains('closing'));
});

test('a tap while the box is closing reopens it without a second viewport follow', () => {
  const fx = setup();
  listening(fx, 'x');
  fx.voice.current.opts.onEnd();
  focusEvent(fx, 'focusin', fx.els.field);
  tap(fx.els.close);
  tap(fx.els.button);
  assert.equal(fx.timers[0].cleared, true);
  assert.equal(fx.els.box.classList.contains('closing'), false);
  assert.equal(fx.els.box.classList.contains('fade'), false);
  assert.equal(fx.els.box.classList.contains('typing'), false, 'the field lost focus as the box began to close');
  assert.equal(fx.els.box.hidden, false);
  assert.equal(fx.follows.length, 1);
  assert.equal(fx.voice.listens.length, 2);
  assert.equal(fx.voice.current.opts.prefix, '', 'x cleared the text');
});

test('createCapture refuses a missing element or callback', () => {
  const base = setup();
  const ok = {
    els: base.els, line: { set() {} },
    voice: { isVoiceSupported: () => true, listen() {}, errorKind },
    isStandalone: () => false, submit: async () => {}, cancelSubmit() {}, closePreviews() {},
  };
  for (const name of ['button', 'box', 'field', 'add', 'cancel', 'close', 'typeInstead', 'preview']) {
    assert.throws(() => createCapture({ ...ok, els: { ...ok.els, [name]: null } }), new RegExp(name));
  }
  for (const name of ['isStandalone', 'submit', 'cancelSubmit', 'closePreviews']) {
    assert.throws(() => createCapture({ ...ok, [name]: undefined }), new RegExp(name));
  }
  assert.throws(() => createCapture({ ...ok, line: null }), /line/);
  assert.throws(() => createCapture({ ...ok, voice: { listen() {} } }), /voice/);
});

test('the transform names the variable styles.css sets', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(CAPTURE_TRANSFORM, /var\(--capture-lift\)/);
  assert.match(css, /\.capture-box \{[^}]*--capture-lift:/);
  assert.match(css, /capture-shrink 250ms/, `CLOSE_MS (${CLOSE_MS}) is the close animation's length`);
  assert.equal(CLOSE_MS, 250);
});
```

- [ ] **Step 2: Run; it fails.** `node --test tests/capture.test.js` → `# tests 1`, `# fail 1` (`not ok 1 - tests/capture.test.js`: no `js/capture.js`).

- [ ] **Step 3: Implement.** Create `js/capture.js`:

```js
// capture.js — the round capture button and the box that grows out of it
// (home-screen spec § 3). Presentation and the listen state machine only:
// it never adds an item, and holds no storage or app state. `submit` (app.js's
// handleAdd for the capture box) adds, and calls `added()` back on success;
// `cancelSubmit` makes a smart add in flight superseded; `closePreviews`
// closes an open preview in BOTH boxes (spec § 3 step 8).
//
// The gesture (Decided): tap = start listening, the box opens and live words
// appear; tap again = stop and add; tap the text = type instead (listening
// stops). No double-tap.
//
// Modes: 'closed' (box hidden) | 'listening' | 'typing' (box open, not
// listening). Separately, `adding` is the latch while a smart add thinks.
//
// Every stop is STOP-AND-DETACH (voice.js's session.stop()): the text on
// screen is what counts, and nothing that arrives after the stop changes it.
// Nothing is ever added without a tap: recognition ending on its own, the page
// hiding, a sheet or Settings opening all stop and KEEP the text.
//
// Focus: the field is focused only inside a tap (iOS raises the keyboard only
// from a user gesture). An asynchronous refusal never focuses; it offers
// "Type instead", whose own tap focuses.

import { followVisualViewport } from './viewport.js';

// The box may take half the visible height; it sits above the button (or the
// keyboard), and its panel scrolls inside itself (styles.css).
export const CAPTURE_MAX_SHARE = 0.5;
// Lifts the box's bottom edge --capture-lift above the visible bottom
// (styles.css sets it: above the button, or 8px above the keyboard).
export const CAPTURE_TRANSFORM = 'translateY(calc(-100% - var(--capture-lift)))';
// The close animation's length (styles.css: 250ms); the box hides after it.
export const CLOSE_MS = 250;

export const CAPTURE_MESSAGES = Object.freeze({
  stopped: 'Stopped listening — tap Add.',
  nothing: "Didn't catch anything — type it, or tap the mic.",
  retry: "Didn't catch that — try again or type it.",
  unsupported: "Voice isn't available here — type instead.",
  safari: 'Voice works in the home-screen app.',
  permission: 'Microphone permission is off — Settings → plaenicke.',
  cancelled: 'Cancelled — nothing was added.',
});
const M = CAPTURE_MESSAGES;

const REQUIRED_ELS = ['button', 'box', 'field', 'add', 'cancel', 'close', 'typeInstead', 'preview'];

export function createCapture({
  els, line, voice, isStandalone, submit, cancelSubmit, closePreviews,
  later = (fn, ms) => setTimeout(fn, ms),
  clearLater = (handle) => clearTimeout(handle),
  follow = followVisualViewport,
} = {}) {
  // A missing wire would be a dead button, found only on the phone.
  for (const name of REQUIRED_ELS) {
    if (!els || !els[name]) throw new Error(`createCapture: missing element ${name}`);
  }
  if (!line || typeof line.set !== 'function') throw new Error('createCapture: line.set must be a function');
  if (!voice || !['isVoiceSupported', 'listen', 'errorKind'].every((k) => typeof voice[k] === 'function')) {
    throw new Error('createCapture: voice needs isVoiceSupported, listen and errorKind');
  }
  for (const [name, fn] of Object.entries({ isStandalone, submit, cancelSubmit, closePreviews })) {
    if (typeof fn !== 'function') throw new Error(`createCapture: ${name} must be a function`);
  }

  let mode = 'closed';
  let session = null; // voice.js's session while listening
  let adding = null; // a fresh token while a smart add thinks, else null
  let refused = false; // voice refused once: later taps this session type instead
  let closeTimer = null;
  let stopFollow = null;

  function setMode(next) {
    mode = next;
    els.button.classList.toggle('listening', next === 'listening');
    els.button.setAttribute('aria-label', next === 'listening' ? 'Stop and add' : 'Capture by voice');
    els.button.setAttribute('aria-expanded', String(next !== 'closed'));
    // Read-only while listening, so a tap on the text does not raise the
    // keyboard by itself; the tap's handler decides (spec § 3 step 3).
    els.field.readOnly = next === 'listening';
  }

  // The field grows with its text (spec § 3: "a new textarea that grows"), up
  // to styles.css's max-height, after which it scrolls. scrollHeight leaves
  // out the border, which border-box sizing counts: offsetHeight - clientHeight
  // adds it back, or the last line is clipped (DA M3).
  function grow() {
    els.field.style.height = 'auto';
    els.field.style.height = `${els.field.scrollHeight + els.field.offsetHeight - els.field.clientHeight}px`;
  }

  // A control that raises the keyboard: the field unless it is read-only
  // (listening), and the preview's inputs and selects (DA I4).
  const raisesKeyboard = (node) => !!node && (node === els.field
    ? !els.field.readOnly
    : ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));
  const inBox = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === els.box) return true;
    return false;
  };

  function open() {
    if (closeTimer !== null) {
      // Reopened while closing: the box is still showing and still placed,
      // so it only stops closing. Its field lost focus when it began to.
      clearLater(closeTimer);
      closeTimer = null;
      els.box.classList.remove('closing');
      els.box.classList.remove('fade');
      els.box.classList.remove('typing');
    }
    if (!els.box.hidden) return;
    els.box.hidden = false;
    stopFollow = follow(els.box, { maxShare: CAPTURE_MAX_SHARE, transform: CAPTURE_TRANSFORM });
  }

  function finishClose() {
    closeTimer = null;
    els.box.hidden = true;
    els.box.classList.remove('closing');
    els.box.classList.remove('fade');
    els.box.classList.remove('typing');
    if (stopFollow) { stopFollow(); stopFollow = null; }
  }

  // Stop-and-detach. True when it stopped a listen.
  function stopListening() {
    if (!session) return false;
    const s = session;
    session = null;
    s.stop();
    setMode('typing');
    return true;
  }

  // Inside a tap only. blur() first: a tap on the read-only field has already
  // focused it, and focus() on a focused field would not raise the keyboard.
  function focusField() {
    els.field.readOnly = false;
    els.field.blur();
    els.field.focus();
  }

  function setAdding(on) {
    els.button.disabled = on;
    els.add.disabled = on;
    els.add.hidden = on;
    els.cancel.hidden = !on;
  }

  const refusedText = () => (isStandalone() ? M.permission : M.safari);

  function onVoiceError(code) {
    session = null;
    setMode('typing');
    if (voice.errorKind(code) === 'refused') {
      refused = true;
      line.set(refusedText());
      els.typeInstead.hidden = false;
      return;
    }
    line.set(M.retry);
  }

  function startListening() {
    line.set('');
    els.typeInstead.hidden = true;
    // A listen while this box's own preview is open is a NEW capture (spec
    // § 3 step 8): the text that made the preview goes with it, or it would
    // be the new listen's prefix and be sent again (DA I2).
    if (els.preview.children.length > 0) els.field.value = '';
    // After clearing the line: closing this box's own preview says so here.
    closePreviews();
    const s = voice.listen({
      prefix: els.field.value,
      onText: (text) => { els.field.value = text; grow(); },
      onEnd: () => { session = null; setMode('typing'); line.set(M.stopped); },
      onError: onVoiceError,
    });
    if (s === null) return; // start() threw; onError has already said so
    session = s;
    setMode('listening');
  }

  function cancel() {
    if (adding === null) return;
    adding = null;
    setAdding(false);
    cancelSubmit();
    line.set(M.cancelled);
  }

  // Every Add path runs stop-and-detach first (spec § 3 step 6). `spoken`:
  // the round button stopped a listen, so empty text means nothing was heard.
  async function add({ spoken = false } = {}) {
    if (adding !== null) return;
    stopListening();
    if (spoken && !els.field.value.trim()) { line.set(M.nothing); return; }
    const token = {};
    adding = token;
    setAdding(true);
    try {
      await submit();
    } finally {
      // Only this add's own latch: a Cancel and a newer add may have come since.
      if (adding === token) { adding = null; setAdding(false); }
    }
  }

  function close() {
    if (mode === 'closed') return;
    stopListening();
    if (adding !== null) cancel(); // x while thinking discards the request
    // With the keyboard up the button is covered, so the box fades out.
    // .closing goes on BEFORE the blur, and .typing stays until finishClose:
    // the box fades where it is instead of jumping up first (DA M1).
    if (els.box.classList.contains('typing')) els.box.classList.add('fade');
    els.box.classList.add('closing');
    els.field.blur();
    els.field.value = '';
    els.field.style.height = '';
    line.set('');
    els.typeInstead.hidden = true;
    els.preview.hidden = true;
    els.preview.innerHTML = '';
    setMode('closed');
    closeTimer = later(finishClose, CLOSE_MS);
  }

  function tapButton() {
    if (adding !== null) return;
    if (mode === 'listening') {
      add({ spoken: true }); // stops the listen first
      return;
    }
    open();
    if (!voice.isVoiceSupported()) {
      setMode('typing');
      line.set(M.unsupported);
      focusField();
      return;
    }
    if (refused) {
      setMode('typing');
      line.set(refusedText());
      focusField();
      return;
    }
    startListening();
  }

  els.button.addEventListener('click', tapButton);
  els.add.addEventListener('click', () => { add(); });
  els.cancel.addEventListener('click', cancel);
  els.close.addEventListener('click', close);
  els.typeInstead.addEventListener('click', () => {
    els.typeInstead.hidden = true;
    focusField();
  });
  els.field.addEventListener('click', () => {
    if (mode !== 'listening') return;
    stopListening();
    focusField();
  });
  els.field.addEventListener('input', grow);
  // .typing lowers the box to just above the keyboard (styles.css) while any
  // control in it that raises the keyboard has focus: the field (not while
  // read-only: no keyboard comes up for that) or an input of its preview
  // (DA I4). Moving focus between two such controls keeps it, and a closing
  // box keeps it until it is hidden (DA M1).
  els.box.addEventListener('focusin', (e) => { if (raisesKeyboard(e.target)) els.box.classList.add('typing'); });
  els.box.addEventListener('focusout', (e) => {
    if (els.box.classList.contains('closing')) return;
    if (raisesKeyboard(e.relatedTarget) && inBox(e.relatedTarget)) return;
    els.box.classList.remove('typing');
  });

  els.box.hidden = true;
  els.cancel.hidden = true;
  els.typeInstead.hidden = true;
  setMode('closed');

  return {
    // Stop a listen and keep its text (page hidden, a sheet or Settings opening).
    stopAndKeep() { if (stopListening()) line.set(M.stopped); },
    // A newer Add from the other box superseded this box's smart add: its
    // reply will change nothing, so the latch goes now, not when the reply
    // comes up to a minute later (DA I1). app.js clears the line.
    released() {
      if (adding !== null) { adding = null; setAdding(false); }
    },
    // A capture was added (direct, or from its preview).
    added() {
      if (adding !== null) { adding = null; setAdding(false); }
      // Text typed while it was thinking is the next entry: the box stays.
      if (els.field.value.trim()) return;
      close();
    },
    state: () => ({ mode, adding: adding !== null, refused, open: !els.box.hidden }),
  };
}
```

Then `scripts/t4_impl_edit.py` (ASSETS):

```python
# Task 4 (implementation side): the service worker precaches js/capture.js.
# Run from the repo root, after js/capture.js is created.
import pathlib
p = pathlib.Path('service-worker.js')
s = p.read_text()
old = "  'js/viewport.js',\n"
assert s.count(old) == 1
p.write_text(s.replace(old, "  'js/viewport.js', 'js/capture.js',\n"))
print('ok')
```

- [ ] **Step 4: Run; it passes.** `node --test tests/capture.test.js` → `# tests 25`, `# pass 25`. `node --test tests/serviceworker.test.js` → `# pass 9`.

- [ ] **Step 5: Mutants.**

| Mutant | Plant | Fails |
|---|---|---|
| K1 add() does not stop | in `add()`, delete the `stopListening();` before `if (spoken` | `the box's own Add stops a listen first too` |
| K2 a refusal focuses | add `focusField();` after `els.typeInstead.hidden = false;` in `onVoiceError` | both `a refusal in …` tests |
| K3 Cancel does not cancel the request | delete `cancelSubmit();` in `cancel()` | `Cancel during Thinking …`, `x during Thinking …` |
| K4 added() closes over typed text | delete `if (els.field.value.trim()) return;` in `added()` | `added() clears the latch …` |
| K5 latch cleared without its token | `if (adding === token) { adding = null; setAdding(false); }` → `adding = null; setAdding(false);` | `Cancel during Thinking …` |
| K6 never fades | delete `if (els.box.classList.contains('typing')) els.box.classList.add('fade');` | `x with the keyboard up fades where it is …` |
| K7 a listen leaves previews open | delete `closePreviews();` in `startListening()` | `a tap opens the box …`, `recognition ending on its own …` |
| K8 no blur before focus | delete `els.field.blur();` in `focusField()` | `tapping the text while listening …` |
| K9 a refusal is forgotten | delete `refused = true;` | both `a refusal in …` tests |
| K10 stopAndKeep adds | `stopAndKeep() { if (stopListening()) { line.set(M.stopped); add(); } }` | `stopAndKeep stops a listen …` |
| K11 a tap on the text does not stop | delete `stopListening();` in the field's click listener | `tapping the text while listening …` |
| K13 x keeps the request | delete `if (adding !== null) cancel();` in `close()` | `x during Thinking discards the request` |
| K14 not read-only while listening | `els.field.readOnly = next === 'listening';` → `= false;` | `a tap opens the box …`, `the box drops to the keyboard while …` (corrected during execution) |
| K15 empty spoken text submitted | delete the `if (spoken && !els.field.value.trim())` line | `a tap while listening with nothing heard …` |
| K16 capture.js missing from ASSETS | `'js/viewport.js', 'js/capture.js',` → `'js/viewport.js',` | serviceworker `every js/ module is precached …` |
| K17 grow leaves out the border | `scrollHeight + offsetHeight - clientHeight` → `scrollHeight` | `live words fill the field and grow it, border included` |
| K18 the old preview's text becomes the prefix | delete `if (els.preview.children.length > 0) els.field.value = '';` | `a listen while this box's own preview is open …` |
| K19 moving between inputs drops typing | delete the `relatedTarget` line in the `focusout` listener | `the box drops to the keyboard while …` |
| K20 the close blur drops typing | delete `if (els.box.classList.contains('closing')) return;` in `focusout` | `x with the keyboard up fades where it is …` |
| K21 a preview input raises nothing | `['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)` → `false` | `the box drops to the keyboard while …` |
| K22 released() keeps the latch | `if (adding !== null)` in `released()` → `if (false)` | `released() drops the latch at once …` |
| K23 reopening keeps typing | delete `els.box.classList.remove('typing');` in `open()`'s closing branch | `a tap while the box is closing reopens it …` |
| K24 finishClose keeps typing | delete `els.box.classList.remove('typing');` in `finishClose()` | `x with the keyboard up fades where it is …` |

(No K12: an explicit `return` after cancelling a close and a second `stopListening()` in `tapButton` were found redundant in the trial run — their mutants survived as equivalents — and were removed from the code above.)

- [ ] **Step 6: Gate and commit.** Expected: `# tests 1586`, `# fail 0`, `# cancelled 0`. Message: `Stage 4: js/capture.js — the capture button's state machine`. Files: `js/capture.js tests/capture.test.js tests/fake-dom.js service-worker.js`.

---

## Task 5: `handleAdd` takes a target box

**Files:**
- Modify: `js/app.js`, `js/preview.js` (a refused Cancel leaves the container alone), `tests/apply.test.js` (append one test)

Only the top box exists as a target here; Task 6 adds the capture box. Every existing smart-add test must pass unchanged: that is the proof the top box behaves as before.

- [ ] **Step 1: Write the failing test.** Append to the end of `tests/apply.test.js`:

```js

// --- stage 4: a stale preview cannot be confirmed (home-screen spec § 3 step 8)
//
// Every Add closes every open preview, but a button of a closed preview can
// still be tapped (a tap already on its way when the newer Add landed). Its
// confirm checks that its request is still the newest and refuses otherwise,
// and it must leave the container alone: by then it may hold the NEWER
// request's preview.
test('smart add: a preview from a superseded request cannot be confirmed or cancelled, and the newer preview is left alone', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const doc = globalThis.document;
  const preview = doc.getElementById('preview');
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    typeIntoAddBox('two things on may 1');
    click(doc.getElementById('add-btn'));
    await settle();
    held[0](previewReply([
      { title: 'Old one', date: '2099-05-01', type: 'task' },
      { title: 'Old two', date: '2099-05-01', type: 'task' },
    ]));
    await settle();
    const [staleAddAll, staleCancel] = preview.querySelector('.preview-actions').children;
    assert.equal(staleAddAll.textContent, 'Add all', 'fixture check: the old preview\'s Add all');
    assert.equal(staleCancel.textContent, 'Cancel', 'fixture check: and its Cancel');
    typeIntoAddBox('two other things on may 2');
    click(doc.getElementById('add-btn'));
    await settle();
    assert.equal(preview.children.length, 0, 'fixture check: the newer Add closed the old preview');
    held[1](previewReply([
      { title: 'New one', date: '2099-05-02', type: 'task' },
      { title: 'New two', date: '2099-05-02', type: 'task' },
    ]));
    await settle();
    const newer = preview.children.length;
    assert.ok(newer > 0, 'fixture check: the newer preview is open');

    click(staleAddAll);
    assert.deepEqual(loadItems().map((it) => it.title), [], 'nothing from the stale preview is added');
    assert.equal(messageText(), 'Preview closed — nothing was added from it.');
    assert.equal(preview.children.length, newer, 'the newer preview is untouched');
    assert.equal(preview.hidden, false);

    click(staleCancel);
    assert.equal(preview.children.length, newer, 'a stale Cancel leaves the newer preview too');
    assert.equal(preview.hidden, false);
    assert.equal(messageText(), 'Preview closed — nothing was added from it.', 'and says nothing new');
  } finally {
    timers.restore();
    net.restore();
    preview.hidden = true;
    preview.innerHTML = '';
  }
  seed([]);
});
```

- [ ] **Step 2: Run; it fails.** `node --test tests/apply.test.js` → `# tests 214`, `# fail 1`: `not ok 214 - smart add: a preview from a superseded request cannot be confirmed or cancelled, and the newer preview is left alone` (on `main` the stale Add all adds its items).

- [ ] **Step 3: Implement** with `scripts/t5_app_edit.py`:

```python
# Task 5: js/app.js — handleAdd takes a target box. Run from the repo root.
import pathlib
p = pathlib.Path('js/app.js')
s = p.read_text()

def rep(old, new):
    global s
    assert s.count(old) == 1, f'expected exactly one: {old[:80]!r} (found {s.count(old)})'
    s = s.replace(old, new)

# 1. One message line per box, made right after `els` (setMessage is called
#    from callbacks wired below it, so the line must exist before them).
rep("""const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
""", """const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// A message line, with a token bumped by EVERY message on it, so a smart add
// can tell whether the "Thinking…" it set is still the one on screen (see
// handleAdd). Each capture box has its own line (home-screen spec § 3): the
// top box's #message, which also carries every message unrelated to capture,
// and from stage 4 the capture box's #capture-message.
function messageLine(el) {
  let token = 0;
  return {
    set(text) { token += 1; el.textContent = text || ''; },
    token: () => token,
  };
}
const topLine = messageLine(els.message);
""")

rep("""// messageToken is bumped by EVERY message, so a smart add can tell whether
// the "Thinking…" it set is still the one on screen (see handleAdd).
let messageToken = 0;
function setMessage(t) { messageToken += 1; els.message.textContent = t || ''; }
""", """// The top box's line: Ideas, ticks, deletes, edits and the top box's own adds.
function setMessage(t) { topLine.set(t); }
""")

# 2. handleManualAdd reports how it ended.
rep("""  if (!title || !date) { setMessage('For manual add, type a title and pick a date.'); return; }
  try {
    addItems([{ title, date, type: 'event', time: els.time.value || null, endTime: els.end.value || null }]);
  } catch (e) { setMessage(e.message); return; }
  els.text.value = ''; els.date.value = ''; els.time.value = ''; els.end.value = ''; els.end.hidden = true;
  setMessage('Added.');
}""", """  if (!title || !date) { setMessage('For manual add, type a title and pick a date.'); return 'refused'; }
  try {
    addItems([{ title, date, type: 'event', time: els.time.value || null, endTime: els.end.value || null }]);
  } catch (e) { setMessage(e.message); return 'failed'; }
  els.text.value = ''; els.date.value = ''; els.time.value = ''; els.end.value = ''; els.end.hidden = true;
  setMessage('Added.');
  return 'added';
}""")

# 3. handleAdd takes the box it was called from.
old_start = s.index("// Whether a CURRENT request may still change the message is separate: only\n// if the message is still the \"Thinking…\" it set (messageToken).")
old_end = s.index("function deleteItem(id) {")
s = s[:old_start] + """// Whether a CURRENT request may still change the message is separate: only
// if its box's line still shows the "Thinking…" it set (the line's token).
// Another action's message — the Ideas box's "Kept." — is left alone, while
// the request still adds its items (the Ideas box does not cancel them). The
// one exception is a failed save of those items: that is shown regardless,
// since nothing else would tell the user the capture was lost.
let addGeneration = 0;
// The box, trimmed text and generation of the smart add in flight, so a second
// Add of the same text from the same box sends no second (paid) request.
let pendingSmart = null;

// THE BOXES THAT ADD (home-screen spec § 3). handleAdd keeps one logic and
// takes the box it was called from: its field, its date row (null for a box
// without one: smart add only), its message line, its preview container, its
// "unavailable" text (each names the way that box's user can still add), and
// what to do once an add from it has landed.
const topTarget = {
  field: els.text,
  dates: { date: els.date, time: els.time, end: els.end },
  line: topLine,
  preview: els.preview,
  unavailable: 'Smart add is unavailable — pick a date below and tap Add to add it manually.',
  onAdded() {},
};
const TARGETS = [topTarget];

// A new capture closes any open preview, in EVERY box (spec § 3 step 8), and
// that box's line says so. A preview is open while its container has content
// (renderPreview fills it; every close empties it). Called by every Add that
// passes validation, before its own message, so in the box that started it
// the newer message replaces this one.
const PREVIEW_CLOSED = 'Preview closed — nothing was added from it.';
function closePreviews() {
  for (const t of TARGETS) {
    if (t.preview.children.length === 0) continue;
    t.preview.hidden = true;
    t.preview.innerHTML = '';
    t.line.set(PREVIEW_CLOSED);
  }
}

// Resolves to how it ended: 'refused' (validation; nothing started),
// 'duplicate' (the same text from the same box is already in flight),
// 'added', 'preview', 'empty', 'failed', or 'superseded' (a newer Add, or a
// Cancel, came first, so this request changed nothing).
async function handleAdd(target) {
  const { field, dates, line } = target;
  if (dates && dates.time.value && !dates.date.value) {
    line.set('Add a date to use that time, or clear the time to use smart add.');
    return 'refused';
  }
  // If a date is picked, treat Add as an explicit MANUAL add — no Worker needed.
  // This is the always-available fallback (works offline and on iPhone). Only
  // the top box has a date row.
  if (dates && dates.date.value) {
    // Refused here, before the bump, so a refused manual add (no title) starts
    // nothing and leaves a pending smart add alone; a landed one supersedes it
    // and closes any open preview.
    if (!field.value.trim()) { line.set('For manual add, type a title and pick a date.'); return 'refused'; }
    addGeneration += 1;
    closePreviews();
    return handleManualAdd();
  }

  const raw = field.value.trim();
  if (!raw) { line.set('Type something first.'); return 'refused'; }
  if (pendingSmart && pendingSmart.generation === addGeneration
    && pendingSmart.target === target && pendingSmart.raw === raw) return 'duplicate';
  const generation = ++addGeneration;
  pendingSmart = { generation, raw, target };
  // An earlier request's preview must not stay confirmable under a new one.
  closePreviews();
  line.set('Thinking…');
  const thinking = line.token();
  const say = (t) => { if (line.token() === thinking) line.set(t); };
  // Only clear the box if it still holds what was sent: text typed while
  // waiting (or reviewing) is the user's next entry.
  const clearSentText = () => { if (field.value.trim() === raw) field.value = ''; };

  let result;
  try {
    result = await parseViaWorker(raw);
  } catch (e) {
    if (generation !== addGeneration) return 'superseded';
    pendingSmart = null;
    if (e.message === 'too_long') say('That was a lot at once — try adding fewer items in one go.');
    else say(target.unavailable);
    return 'failed';
  }
  if (generation !== addGeneration) return 'superseded';
  pendingSmart = null;

  const flow = decideFlow(result);
  if (flow === 'empty') { say("I couldn't find anything to add — try rephrasing."); return 'empty'; }
  if (flow === 'direct') {
    try {
      addItems(result.items);
    } catch (e) { line.set(e.message); return 'failed'; }
    clearSentText();
    say('Added.');
    target.onAdded();
    return 'added';
  }
  say('Review the items below.');
  renderPreview(target.preview, result.items, {
    onConfirm: (confirmed) => {
      // A preview's confirm checks its request is still the newest (spec § 3
      // step 8). A newer Add closed this preview, but a button of it can still
      // be tapped (a tap already on its way). false: renderPreview then leaves
      // the container alone, which may now hold the NEWER request's preview.
      if (generation !== addGeneration) { line.set(PREVIEW_CLOSED); return false; }
      try { addItems(confirmed); } catch (e) { line.set(e.message); return false; }
      clearSentText();
      line.set('Added.');
      target.onAdded();
      return true;
    },
    // The same check for its Cancel: a stale Cancel changes nothing, and
    // returns false so renderPreview leaves the container alone (DA M5).
    onCancel: () => {
      if (generation !== addGeneration) return false;
      line.set('Cancelled.');
      return true;
    },
  });
  return 'preview';
}

""" + s[old_end:]

# 4. The top box's Add and Enter pass their box.
rep("""els.add.addEventListener('click', handleAdd);
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdd(); });""",
"""els.add.addEventListener('click', () => { handleAdd(topTarget); });
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdd(topTarget); });""")

p.write_text(s)

# 5. preview.js: a Cancel that its caller refuses (returns false) leaves the
#    container alone, as a refused confirm already does.
p = pathlib.Path('js/preview.js')
s = p.read_text()
rep("""  cancel.addEventListener('click', () => { container.hidden = true; container.innerHTML = ''; onCancel(); });""",
"""  // onCancel returning false (a stale preview's Cancel, js/app.js) leaves the
  // container alone: by then it may hold a newer preview.
  cancel.addEventListener('click', () => {
    if (onCancel() === false) return;
    container.hidden = true;
    container.innerHTML = '';
  });""")
p.write_text(s)
print('ok')
```

- [ ] **Step 4: Run; it passes.** `node --test tests/apply.test.js` → `# tests 214`, `# pass 214`.

- [ ] **Step 5: Mutants.**

| Mutant | Plant | Fails |
|---|---|---|
| P1 stale confirm not checked | delete the `if (generation !== addGeneration) { line.set(PREVIEW_CLOSED); return false; }` line | the new test |
| P2 stale confirm clears the container | that line's `return false` → `return true` | the new test |
| P3 a smart add leaves the old preview open | delete `closePreviews();` after `// An earlier request's preview …` | `a new smart add hides and clears …`, the new test |
| P4 a manual add leaves it open | delete `closePreviews();` in the manual branch | `a manual add closes an open preview …` |
| P5 say ignores the token | `const say = (t) => { line.set(t); };` | the three `… after the Ideas box said "Kept."` tests |
| P6 duplicate guard dropped | `&& pendingSmart.target === target && pendingSmart.raw === raw)` → `&& false)` | `a second Add of the same text …` |
| P7 stale Cancel not checked | delete `if (generation !== addGeneration) return false;` in `onCancel` | the new test |
| P8 preview.js ignores a refused Cancel | clear the container first, then call `onCancel()` (the old order) | the new test |

- [ ] **Step 6: Gate and commit.** Expected: `# tests 1587`, `# fail 0`, `# cancelled 0`. Message: `Stage 4: handleAdd takes a target box; a stale preview cannot be confirmed or cancelled`. Files: `js/app.js js/preview.js tests/apply.test.js`.

---

## Task 6: wire the capture button; retire `#mic-btn` and `dictate()`

**Files:**
- Modify: `js/app.js`, `js/voice.js`, `index.html`, `styles.css`, `tests/apply.test.js` (append fourteen tests)

- [ ] **Step 1: Write the failing tests.** Append to the end of `tests/apply.test.js` (after Task 5's test). The refusal test stays LAST: a refusal lasts the session.

```js

// --- stage 4: the capture button, wired into app.js (home-screen spec § 3) --
//
// js/capture.js's state machine is tested on its own in tests/capture.test.js.
// These check the wiring: it adds through handleAdd with the capture box's own
// target (its line, its preview, its failure text), Cancel makes the request
// superseded, previews close across both boxes, and the page hiding, an item
// sheet or Settings opening stop a listen and keep its text.
//
// A fake SpeechRecognition is installed on the fake window for each test and
// removed after; voice.js reads it at each tap. app.js is imported once, so
// every test leaves the box closed (closeCapture). The refusal test is LAST:
// a refusal lasts the session, and every later tap would go straight to typing.
class AppFakeSR {
  constructor() {
    AppFakeSR.instances.push(this);
    this.calls = [];
  }

  start() { this.calls.push('start'); }

  stop() { this.calls.push('stop'); }

  abort() { this.calls.push('abort'); }

  // One final result, as the browser delivers it.
  say(text) { this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
}
AppFakeSR.instances = [];
function withVoice() {
  AppFakeSR.instances = [];
  globalThis.window.SpeechRecognition = AppFakeSR;
  return {
    last: () => AppFakeSR.instances[AppFakeSR.instances.length - 1],
    count: () => AppFakeSR.instances.length,
    restore: () => { delete globalThis.window.SpeechRecognition; },
  };
}
const capEl = (id) => globalThis.document.getElementById(id);
const captureMessage = () => capEl('capture-message').textContent;
// x, then its close timer: a manual timers object fires it; otherwise it is
// a real 250 ms timeout, and the box finishes closing on its own.
function closeCapture(timers) {
  click(capEl('capture-close'));
  if (timers) timers.fire(250);
}

test('capture: tap, speak, tap again adds through smart add, with its messages in the capture box only', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const doc = globalThis.document;
  const voice = withVoice();
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    doc.getElementById('message').textContent = 'top line';
    click(capEl('capture-btn'));
    assert.equal(capEl('capture-box').hidden, false, 'the box opens');
    assert.equal(voice.count(), 1, 'and listens');
    voice.last().say('lunch with sam tomorrow');
    assert.equal(capEl('capture-text').value, 'lunch with sam tomorrow', 'live words appear');
    click(capEl('capture-btn'));
    await settle();
    assert.deepEqual(voice.last().calls, ['start', 'stop', 'abort']);
    assert.deepEqual(net.posts, ['lunch with sam tomorrow']);
    assert.equal(captureMessage(), 'Thinking…');
    assert.equal(messageText(), 'top line', '#message is not the capture box\'s line');
    assert.equal(capEl('capture-btn').disabled, true);
    assert.equal(capEl('capture-cancel').hidden, false);
    held[0](smartReply([{ title: 'Lunch with Sam', date: '2099-06-01', type: 'event' }]));
    await settle();
    assert.deepEqual(loadItems().map((it) => it.title), ['Lunch with Sam']);
    assert.ok(capEl('capture-box')._classes.has('closing'), 'success closes the box');
    timers.fire(250);
    assert.equal(capEl('capture-box').hidden, true);
    assert.equal(capEl('capture-btn').disabled, false);
    assert.equal(messageText(), 'top line');
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('capture: Cancel during Thinking adds nothing when the reply comes, and the same words can be sent again', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const voice = withVoice();
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    click(capEl('capture-btn'));
    voice.last().say('dentist on may 15');
    click(capEl('capture-btn'));
    await settle();
    assert.equal(captureMessage(), 'Thinking…', 'fixture check');
    click(capEl('capture-cancel'));
    assert.equal(captureMessage(), 'Cancelled — nothing was added.');
    assert.equal(capEl('capture-btn').disabled, false);
    assert.equal(capEl('capture-text').value, 'dentist on may 15', 'the text is kept');
    held[0](smartReply([{ title: 'Dentist', date: '2099-05-15', type: 'event' }]));
    await settle();
    assert.deepEqual(loadItems().map((it) => it.title), [], 'the late reply is discarded');
    assert.equal(captureMessage(), 'Cancelled — nothing was added.');
    click(capEl('capture-add'));
    await settle();
    assert.equal(net.posts.length, 2, 'after a Cancel the same text can be sent again');
    held[1](smartReply([]));
    await settle();
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('capture: smart add unavailable names the top box\'s date row, in the capture box\'s line', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const doc = globalThis.document;
  const voice = withVoice();
  const net = smartAddFetch(() => Promise.reject(new TypeError('offline')));
  const timers = installManualTimers();
  try {
    doc.getElementById('message').textContent = 'top line';
    click(capEl('capture-btn'));
    voice.last().say('call the plumber');
    click(capEl('capture-btn'));
    await settle();
    assert.equal(captureMessage(), 'Smart add is unavailable — use the box at the top with a date to add it.');
    assert.equal(messageText(), 'top line');
    assert.equal(capEl('capture-text').value, 'call the plumber', 'nothing is lost');
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('capture: starting a listen closes the top box\'s open preview, and its line says so', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const doc = globalThis.document;
  const voice = withVoice();
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    typeIntoAddBox('two things on may 1');
    click(doc.getElementById('add-btn'));
    await settle();
    held[0](previewReply([
      { title: 'One', date: '2099-05-01', type: 'task' },
      { title: 'Two', date: '2099-05-01', type: 'task' },
    ]));
    await settle();
    assert.ok(doc.getElementById('preview').children.length > 0, 'fixture check: the top preview is open');
    click(capEl('capture-btn'));
    assert.equal(doc.getElementById('preview').children.length, 0);
    assert.equal(doc.getElementById('preview').hidden, true);
    assert.equal(messageText(), 'Preview closed — nothing was added from it.');
    assert.equal(voice.count(), 1, 'and it listens');
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('capture: its preview opens in the box, the button stays enabled, and a top-box Add closes it', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const doc = globalThis.document;
  const voice = withVoice();
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    click(capEl('capture-btn'));
    voice.last().say('two things on friday');
    click(capEl('capture-btn'));
    await settle();
    held[0](previewReply([
      { title: 'One', date: '2099-05-01', type: 'task' },
      { title: 'Two', date: '2099-05-01', type: 'task' },
    ]));
    await settle();
    assert.ok(capEl('capture-preview').children.length > 0, 'the preview renders in #capture-preview');
    assert.equal(doc.getElementById('preview').children.length, 0, 'not in the top box\'s');
    assert.equal(captureMessage(), 'Review the items below.');
    assert.equal(capEl('capture-btn').disabled, false, 'the latch cleared when the preview was shown');
    typeIntoAddBox('Manual dinner', '2099-03-04');
    click(doc.getElementById('add-btn'));
    assert.equal(capEl('capture-preview').children.length, 0);
    assert.equal(captureMessage(), 'Preview closed — nothing was added from it.');
    assert.equal(messageText(), 'Added.');
    assert.deepEqual(loadItems().map((it) => it.title), ['Manual dinner']);
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('capture: confirming its preview adds and closes the box', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const voice = withVoice();
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    click(capEl('capture-btn'));
    voice.last().say('two things on friday');
    click(capEl('capture-btn'));
    await settle();
    held[0](previewReply([
      { title: 'One', date: '2099-05-01', type: 'task' },
      { title: 'Two', date: '2099-05-01', type: 'task' },
    ]));
    await settle();
    click(capEl('capture-preview').querySelector('.preview-actions').children[0]);
    assert.deepEqual(loadItems().map((it) => it.title), ['One', 'Two']);
    assert.ok(capEl('capture-box')._classes.has('closing'), 'a confirmed preview is a success');
    timers.fire(250);
    assert.equal(capEl('capture-box').hidden, true);
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('capture: going to the background while listening stops, keeps the words, and adds nothing', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const voice = withVoice();
  const net = smartAddFetch(() => new Promise(() => {}));
  const timers = installManualTimers();
  try {
    click(capEl('capture-btn'));
    voice.last().say('call the bank');
    globalThis.document.visibilityState = 'hidden';
    try {
      resume();
    } finally {
      globalThis.document.visibilityState = 'visible';
    }
    assert.deepEqual(voice.last().calls, ['start', 'stop', 'abort']);
    assert.equal(capEl('capture-text').value, 'call the bank');
    assert.equal(captureMessage(), 'Stopped listening — tap Add.');
    assert.deepEqual(net.posts, [], 'nothing is added without a tap');
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('capture: opening an item while listening stops and keeps the words', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'cap-open', title: 'Cap open me', date: far(0) })]);
  const voice = withVoice();
  const net = smartAddFetch(() => new Promise(() => {}));
  const timers = installManualTimers();
  try {
    const opener = openControlFor(dayOf(far(0)), 'Cap open me');
    click(capEl('capture-btn'));
    voice.last().say('buy stamps');
    click(opener);
    assert.ok(sheetHost().querySelector('.sheet'), 'fixture check: the sheet opened');
    assert.deepEqual(voice.last().calls, ['start', 'stop', 'abort']);
    assert.equal(capEl('capture-text').value, 'buy stamps');
    assert.equal(captureMessage(), 'Stopped listening — tap Add.');
    assert.deepEqual(net.posts, []);
  } finally {
    forceCloseSheet();
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('capture: opening Settings while listening stops and keeps the words', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const settingsBtn = globalThis.document.getElementById('settings-btn');
  const settingsHost = globalThis.document.getElementById('settings-host');
  if (settingsHost.childElementCount) click(settingsBtn); // left open by an earlier test
  const voice = withVoice();
  const net = smartAddFetch(() => new Promise(() => {}));
  const timers = installManualTimers();
  try {
    click(capEl('capture-btn'));
    voice.last().say('renew passport');
    click(settingsBtn);
    assert.ok(settingsHost.childElementCount > 0, 'fixture check: Settings opened');
    assert.deepEqual(voice.last().calls, ['start', 'stop', 'abort']);
    assert.equal(capEl('capture-text').value, 'renew passport');
    assert.equal(captureMessage(), 'Stopped listening — tap Add.');
    assert.deepEqual(net.posts, []);
  } finally {
    if (settingsHost.childElementCount) click(settingsBtn);
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

// The duplicate guard stops a second paid request for a double-tapped Add in
// ONE box. The same words from the other box are a new capture: sent, and
// newest wins, as any newer Add does.
test('capture: the same words from the other box are sent, not swallowed by the duplicate guard', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const doc = globalThis.document;
  const voice = withVoice();
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    typeIntoAddBox('lunch at noon');
    click(doc.getElementById('add-btn'));
    await settle();
    click(capEl('capture-btn'));
    voice.last().say('lunch at noon');
    click(capEl('capture-btn'));
    await settle();
    assert.deepEqual(net.posts, ['lunch at noon', 'lunch at noon']);
    assert.equal(messageText(), '', 'the superseded top box stops saying "Thinking…" at once');
    held[1](smartReply([{ title: 'Lunch', date: '2099-06-02', type: 'event' }]));
    held[0](smartReply([{ title: 'Lunch (old)', date: '2099-06-02', type: 'event' }]));
    await settle();
    assert.deepEqual(loadItems().map((it) => it.title), ['Lunch'], 'the newer capture wins');
    assert.equal(messageText(), '', 'the superseded top box does not keep saying "Thinking…"');
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

// DA I1: a top-box Add that supersedes the capture box's smart add releases
// the capture box at once (no "Thinking…", no Cancel, the button enabled), so
// its Cancel or x can never cancel the top box's newer request.
test('capture: a top-box Add that supersedes it releases the capture box at once, and x then cancels nothing', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const doc = globalThis.document;
  const voice = withVoice();
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    click(capEl('capture-btn'));
    voice.last().say('dentist friday');
    click(capEl('capture-btn'));
    await settle();
    assert.equal(captureMessage(), 'Thinking…', 'fixture check');
    typeIntoAddBox('dentist on friday at 3');
    click(doc.getElementById('add-btn'));
    await settle();
    assert.equal(captureMessage(), '', 'the capture box stops saying "Thinking…"');
    assert.equal(capEl('capture-btn').disabled, false);
    assert.equal(capEl('capture-cancel').hidden, true);
    assert.equal(capEl('capture-add').hidden, false);
    assert.equal(capEl('capture-text').value, 'dentist friday', 'its text is kept');
    click(capEl('capture-close'));
    held[1](smartReply([{ title: 'Dentist', date: '2099-05-15', time: '15:00', type: 'event' }]));
    await settle();
    assert.deepEqual(loadItems().map((it) => it.title), ['Dentist'], 'the top box\'s request still lands');
    assert.equal(messageText(), 'Added.');
    held[0](smartReply([{ title: 'Dentist (voice)', date: '2099-05-15', type: 'event' }]));
    await settle();
    assert.deepEqual(loadItems().map((it) => it.title), ['Dentist']);
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

// The release is for any newer Add, a manual one included, and it clears a
// line only while that line still shows its own request's "Thinking…".
test('capture: a manual add releases it too; a release leaves another action\'s message alone', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const doc = globalThis.document;
  const voice = withVoice();
  const held = [];
  const net = smartAddFetch(() => new Promise((resolve) => { held.push(resolve); }));
  const timers = installManualTimers();
  try {
    click(capEl('capture-btn'));
    voice.last().say('call the vet');
    click(capEl('capture-btn'));
    await settle();
    typeIntoAddBox('Vet', '2099-07-01');
    click(doc.getElementById('add-btn'));
    assert.equal(messageText(), 'Added.', 'fixture check: the manual add landed');
    assert.equal(captureMessage(), '', 'a manual add releases the capture box too');
    assert.equal(capEl('capture-btn').disabled, false);

    typeIntoAddBox('lunch with sam tomorrow');
    click(doc.getElementById('add-btn'));
    await settle();
    ideaText().value = 'An idea meanwhile';
    click(ideaAdd());
    assert.equal(messageText(), 'Kept.', 'fixture check');
    click(capEl('capture-add'));
    await settle();
    assert.equal(messageText(), 'Kept.', 'the release does not clear a message the top request did not set');
  } finally {
    closeCapture(timers);
    timers.restore();
    net.restore();
    voice.restore();
  }
  seed([]);
});

test('stage 4 retires the small mic: no #mic-btn, no dictate(), one mic', async () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.doesNotMatch(read('../index.html'), /mic-btn/);
  assert.doesNotMatch(read('../styles.css'), /#mic-btn/);
  assert.doesNotMatch(read('../js/app.js'), /dictate|mic-btn|els\.mic\b/);
  const voice = await import('../js/voice.js');
  assert.equal('dictate' in voice, false);
});

// LAST of the capture tests: a refusal lasts the session (js/capture.js).
test('capture: a refusal in the home-screen app points to Settings and offers Type instead', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const voice = withVoice();
  const timers = installManualTimers();
  Object.defineProperty(globalThis.navigator, 'standalone', { value: true, configurable: true });
  try {
    click(capEl('capture-btn'));
    voice.last().onerror({ error: 'not-allowed' });
    assert.equal(captureMessage(), 'Microphone permission is off — Settings → plaenicke.');
    assert.equal(capEl('capture-type').hidden, false);
  } finally {
    delete globalThis.navigator.standalone;
    closeCapture(timers);
    timers.restore();
    voice.restore();
  }
  seed([]);
});
```

- [ ] **Step 2: Run; they fail.** `node --test tests/apply.test.js` → `# tests 228`, `# pass 214`, `# fail 14`: every new test (215–228).

- [ ] **Step 3: Implement** with `scripts/t6_edit.py`. It: imports `listen`, `errorKind` and `createCapture`; drops `els.mic` and adds the nine capture elements; makes the capture box's line and target (failure text names the top box's date row; `onAdded` calls `capture.added()`); adds `cancelAdd()` and `supersedePending()` (a newer Add tells the superseded box at once: decision 16); stops-and-keeps in `openItem`, on `visibilitychange` → hidden and on the Settings button; creates the capture after the other controls are wired; removes the dictation block, `#mic-btn` and its CSS, and `dictate()` with the old voice.js header.

```python
# Task 6: wire the capture button into app.js; retire #mic-btn and dictate().
# Run from the repo root.
import pathlib, re

def edit(path, pairs):
    p = pathlib.Path(path)
    s = p.read_text()
    for old, new in pairs:
        assert s.count(old) == 1, f'{path}: expected exactly one: {old[:80]!r} (found {s.count(old)})'
        s = s.replace(old, new)
    p.write_text(s)

edit('js/app.js', [
    # imports
    ("import { isVoiceSupported, dictate } from './voice.js';\n",
     "import { isVoiceSupported, listen, errorKind } from './voice.js';\n"),
    ("import { renderTodayView } from './todayview.js';\n",
     "import { renderTodayView } from './todayview.js';\nimport { createCapture } from './capture.js';\n"),
    # els: the small mic goes, the capture box's elements come
    ("  mic: document.getElementById('mic-btn'),\n", ""),
    ("  calSwitch: document.getElementById('cal-switch'),\n};",
     """  calSwitch: document.getElementById('cal-switch'),
  // Home-screen stage 4 — the capture button and its box.
  captureBtn: document.getElementById('capture-btn'),
  captureBox: document.getElementById('capture-box'),
  captureText: document.getElementById('capture-text'),
  captureAdd: document.getElementById('capture-add'),
  captureCancel: document.getElementById('capture-cancel'),
  captureClose: document.getElementById('capture-close'),
  captureType: document.getElementById('capture-type'),
  captureMessage: document.getElementById('capture-message'),
  capturePreview: document.getElementById('capture-preview'),
};"""),
    # the capture box's own line
    ("const topLine = messageLine(els.message);\n",
     "const topLine = messageLine(els.message);\nconst captureLine = messageLine(els.captureMessage);\n"),
    # the old dictation block goes
    ("""// In-app dictation — only surface the mic where the browser supports it.
// (On iPhone, the keyboard's own mic is always available regardless.)
if (els.mic && isVoiceSupported()) {
  els.mic.hidden = false;
  let listening = false;
  els.mic.addEventListener('click', () => {
    if (listening) return;
    dictate({
      onStart: () => { listening = true; els.mic.classList.add('listening'); setMessage('Listening — speak now.'); },
      onResult: (text) => { els.text.value = text; },
      onEnd: () => { listening = false; els.mic.classList.remove('listening'); if (els.text.value) setMessage('Got it — tap Add.'); },
      onError: () => { listening = false; els.mic.classList.remove('listening'); setMessage("Didn't catch that — try again or type it."); },
    });
  });
}

""", ""),
    # the capture box joins the boxes that add; each box is told at once when
    # a newer Add supersedes its smart add (DA I1)
    ("""  onAdded() {},
};
const TARGETS = [topTarget];""", """  onAdded() {},
  onSuperseded() {},
};
// The capture box has no date row, so its failure names the top box's.
// `capture` is created below; these run only after an Add, long after.
const captureTarget = {
  field: els.captureText,
  dates: null,
  line: captureLine,
  preview: els.capturePreview,
  unavailable: 'Smart add is unavailable — use the box at the top with a date to add it.',
  onAdded() { capture.added(); },
  onSuperseded() { capture.released(); },
};
const TARGETS = [topTarget, captureTarget];"""),
    # Cancel, and telling a superseded box at once
    ("""// Resolves to how it ended: 'refused' (validation; nothing started),""",
     """// Makes the smart add in flight superseded, as a newer Add would: its reply,
// whenever it comes, changes nothing (spec § 3 step 7: the capture box's
// Cancel). The same text can then be sent again: the duplicate guard above
// only holds for the current generation. The request itself is not aborted,
// so it may still spend credit (spec § 8, Later). Only the capture box calls
// this, and only while its latch is set; a newer Add from the top box
// releases that latch at once (supersedePending), so its Cancel can never
// reach the top box's request.
function cancelAdd() {
  addGeneration += 1;
}

// A newer Add (either box, manual or smart) is about to supersede the smart
// add in flight. Its reply will change nothing, so its box is told NOW, not
// when the reply comes up to SMART_ADD_TIMEOUT_MS later: its "Thinking…" goes
// (if still showing) and the capture box drops its adding latch. Without this
// a request superseded from the OTHER box left "Thinking…" up, and the
// capture box's Cancel then cancelled the NEWER request (DA I1).
function supersedePending() {
  if (pendingSmart && pendingSmart.generation === addGeneration) pendingSmart.release();
}

// Resolves to how it ended: 'refused' (validation; nothing started),"""),
    ("""    if (!field.value.trim()) { line.set('For manual add, type a title and pick a date.'); return 'refused'; }
    addGeneration += 1;""", """    if (!field.value.trim()) { line.set('For manual add, type a title and pick a date.'); return 'refused'; }
    supersedePending();
    addGeneration += 1;"""),
    ("""  const generation = ++addGeneration;
  pendingSmart = { generation, raw, target };
  // An earlier request's preview must not stay confirmable under a new one.
  closePreviews();
  line.set('Thinking…');
  const thinking = line.token();
  const say = (t) => { if (line.token() === thinking) line.set(t); };
""", """  supersedePending();
  const generation = ++addGeneration;
  // An earlier request's preview must not stay confirmable under a new one.
  closePreviews();
  line.set('Thinking…');
  const thinking = line.token();
  const say = (t) => { if (line.token() === thinking) line.set(t); };
  pendingSmart = { generation, raw, target, release: () => { say(''); target.onSuperseded(); } };
"""),
    # opening an item stops a listen and keeps its text
    ("""function openItem(item) {
  // Only the latest action can be undone,""", """function openItem(item) {
  // Opening a sheet stops a listen and keeps its text (spec § 3 step 4).
  capture.stopAndKeep();
  // Only the latest action can be undone,"""),
    # the page hiding does too
    ("""  if (document.visibilityState === 'hidden') {
    if (activeToast) activeToast.dismiss();""", """  if (document.visibilityState === 'hidden') {
    // A listen stops and keeps its text; nothing is added (spec § 3 step 4).
    capture.stopAndKeep();
    if (activeToast) activeToast.dismiss();"""),
    # create it, after the other controls are wired
    ("els.ideaAdd.addEventListener('click', handleIdeaAdd);\n",
     """els.ideaAdd.addEventListener('click', handleIdeaAdd);

// The capture button and its box (home-screen spec § 3, js/capture.js). It
// adds through handleAdd with the capture box's own target, so its messages
// go to #capture-message and its preview to #capture-preview.
const capture = createCapture({
  els: {
    button: els.captureBtn, box: els.captureBox, field: els.captureText, add: els.captureAdd,
    cancel: els.captureCancel, close: els.captureClose, typeInstead: els.captureType, preview: els.capturePreview,
  },
  line: captureLine,
  voice: { isVoiceSupported, listen, errorKind },
  // The home-screen app and a Safari tab need different words when voice is
  // refused (spec § 3).
  isStandalone: () => navigator.standalone === true,
  submit: () => handleAdd(captureTarget),
  cancelSubmit: cancelAdd,
  closePreviews,
});
// Opening Settings stops a listen and keeps its text (spec § 3 step 4).
// settings.js's own listener on this button opens or closes the panel.
els.settingsBtn.addEventListener('click', () => { capture.stopAndKeep(); });
"""),
])

# index.html: the small mic goes; the top box keeps its field, date row, Add.
edit('index.html', [
    ("""      <input id="entry-text" type="text" autocomplete="off"
             placeholder="e.g. physics assignment due July second" />
      <button id="mic-btn" type="button" hidden aria-label="Dictate">&#127908;</button>
""", """      <input id="entry-text" type="text" autocomplete="off"
             placeholder="e.g. physics assignment due July second" />
"""),
])

edit('styles.css', [
    ("""#mic-btn {
  flex: 0 0 auto;
  background: var(--card);
  border: 1px solid var(--line);
  color: var(--ink);
  font-size: 1.2rem;
  padding: 0 14px;
}
#mic-btn.listening { background: var(--danger); border-color: var(--danger); color: var(--accent-ink); }
""", ""),
])

# voice.js: dictate() goes, and the header says what the module is now.
p = pathlib.Path('js/voice.js')
s = p.read_text()
start = s.index('// Starts one listen. Calls back with the transcript.')
end = s.index('// --- listen(): the capture button')
s = s[:start] + s[end:]
old_header = """// voice.js — in-app dictation via the browser Web Speech API.
// Supported on desktop Chrome/Safari; unreliable on iOS Safari, so callers
// should hide the mic button when isVoiceSupported() is false and fall back
// to the built-in keyboard microphone.
"""
assert s.count(old_header) == 1
s = s.replace(old_header, """// voice.js — the capture button's speech recognition (Web Speech API).
// isVoiceSupported() is read inside each tap (home-screen spec § 3), and
// listen() is the one way to listen; the top box's small mic and dictate()
// retired in stage 4, leaving one mic.
""")
p.write_text(s)
print('ok')
```

- [ ] **Step 4: Run; they pass.** `node --test tests/apply.test.js` → `# tests 228`, `# pass 228`.

- [ ] **Step 5: Mutants.**

| Mutant | Plant | Fails |
|---|---|---|
| W1 backgrounding does not stop | delete `capture.stopAndKeep();` in the hidden branch | `capture: going to the background …` |
| W2 opening an item does not stop | delete `capture.stopAndKeep();` in `openItem` | `capture: opening an item …` |
| W3 Settings does not stop | delete the `els.settingsBtn.addEventListener(…stopAndKeep…)` line | `capture: opening Settings …` |
| W4 the top box's failure text | capture target's `unavailable` → the top box's text | `capture: smart add unavailable …` |
| W5 the guard ignores the box | delete `pendingSmart.target === target && ` | `capture: the same words from the other box …` |
| W6 Cancel does not supersede | `cancelAdd`'s body emptied | `capture: Cancel during Thinking …` |
| W7 only the top preview closes | `const TARGETS = [topTarget];` | `capture: its preview opens in the box …` |
| W8 never standalone | `isStandalone: () => false,` | `capture: a refusal in the home-screen app …` |
| W9 capture adds through the top box | `submit: () => handleAdd(topTarget),` | five capture tests |
| W10 success does not close the box | `onAdded() {},` on the capture target | `capture: tap, speak, tap again …`, `capture: confirming its preview …` |
| W14 a supersede tells nobody | empty `supersedePending()`'s body | `capture: a top-box Add that supersedes it …` and others |
| W15 the capture box is not released | captureTarget `onSuperseded() {},` | `capture: a top-box Add that supersedes it …` |
| W16 the release keeps "Thinking…" | `release: () => { target.onSuperseded(); }` | `capture: the same words from the other box …` |
| W17 a manual add releases nothing | delete `supersedePending();` in the manual branch | `capture: a manual add releases it too …` |
| W18 the release clears whatever is shown | `say('')` → `line.set('')` in `release` | `capture: a manual add releases it too …` |

(In the trial run, `pendingSmart = null` inside `cancelAdd` survived as an equivalent mutant — the guard already compares generations — and was removed.)

- [ ] **Step 6: Gate and commit.** Expected: `# tests 1601`, `# fail 0`, `# cancelled 0`. Message: `Stage 4: the capture button, wired; the small mic and dictate() retire`. Files: `js/app.js js/voice.js index.html styles.css tests/apply.test.js`.

---

## Execution record (added after execution, 2026-10-26)

What ran differs from the tasks above in these places; the code on the branch is the reference.

- **Table corrections:** V8's plant text quoted the pre-review constructor line; K14 also fails `the box drops to the keyboard while …` rather than `x with the keyboard up …`; V9 also fails `stop detaches first …`; S8 also fails `Add stays reachable …`. The rows above are corrected.
- **Task 4 fix round (bacb623),** from its fresh review: a listen over its own preview clears the field only while it still holds the text that produced the preview (an edit made since is kept; decision 17 narrowed); after a refusal, a tap on the round button hides "Type instead"; a submit that rejects says "Could not add: …", clears the latch and is logged with `console.error` (the click handlers catch it; `node:test` counts an unhandled rejection as a failure). +3 tests, K25–K29.
- **Polish round,** from the per-task reviews: the panel's bottom padding moves onto the sticky actions row (content showed under it); the panel shadow uses `--shade`; **a stale preview's confirm is silent**, like a stale Cancel (decision 9 amended: writing on the newer request's line swallowed its own "Added."); a test pins the catch path's own-latch guard; `capture.stopAndKeep()` runs last on backgrounding and in `openItem`; Task 6's manual-release test releases its held requests; the SHEET_MAX_SHARE comment is re-wrapped. +3 tests, Q1–Q5.
- **Totals:** Task 6 gate 1604 (the plan's 1601 + the fix round's 3); after the polish round 1607.

## Task 7 (lead, docs only): record the result

Append a "Stage 4 result" paragraph to spec § 8 (what shipped, the decisions above, the phone checklist below, still unverified on the phone). No code.

---

## Alex's phone checklist (iPhone home-screen app; none of this is verified by the tests)

1. Mic → live words appear → tap again adds at once (no wait).
2. Mic → stop → mic again: the second listen appends to the first words.
3. Background the app while listening: on return the words are kept and nothing was added.
4. Open a row (item sheet) while listening: listening stops, words kept; the round button is hidden while the sheet is open.
5. Open Settings while listening: same; the button is hidden while Settings is open.
6. Tap the text while listening: the keyboard comes up in that same tap, words kept (decision 12, speculative).
7. With the keyboard up the box sits just above it and Add is reachable (decision 2, speculative); with it down, the box sits just above the round button, which stays tappable.
8. × with the keyboard up: the box fades (no shrink toward a covered button).
9. Safari tab (not the home-screen app): a refusal says "Voice works in the home-screen app."
10. Mic permission off: "Microphone permission is off — Settings → plaenicke.", and "Type instead" raises the keyboard.
11. The box grows from the button (250 ms) and shrinks back; with Reduce Motion on, it only fades.
12. The round button clears the home indicator and the tab bar; the toast (Undo) still fits beside it.
13. Press feedback on the round button (scale) is instant and never sticks.
14. Dark mode: the button, box and its text read correctly.
15. "Thinking…" → Cancel → the late reply adds nothing.
16. A long dictation: the field grows to five lines then scrolls; Add stays visible at the box's bottom.
17. Continuous mode: no repeated words in the live text after pauses (review M11, speculative — WebKit has repeated finals before), and no words run together across pauses ("buy milkand eggs"): `composeText` joins finals as the browser sends them (Task 2 review, speculative).
18. The very first listen: the iOS microphone and speech-recognition prompts do not end the listen (if they hide the page, the listen stops and keeps its words: review M12).
19. Typing in the box: the box moves from above the round button to above the keyboard without an ugly jump (review M13); with a preview open, editing a preview field also keeps the box above the keyboard (decision 19).
20. "Settings → plaenicke" is a real path to the microphone switch for the home-screen app (review M10, speculative; the wording is the spec's).
