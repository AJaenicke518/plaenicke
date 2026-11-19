# Colour schemes: implementation plan (Release 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each device pick a colour scheme. Every scheme has a light and a dark variant, so the existing Light / Dark / Auto setting keeps working.

**Architecture:**
- A scheme is a CSS block keyed on `data-scheme` on `<html>`, behind `[data-scheme="x"]` (light) and `[data-scheme="x"][data-theme="dark"]` (dark).
- It redefines **surface and accent tokens only**. The `--type-*` and `--feed-palette-*` colours carry meaning (item type, calendar), so they stay the same in every scheme. That also keeps the existing `--on-type` contrast test valid unchanged.
- `classic`, today's palette, has no attribute.
- The pre-paint script in `index.html` applies the attribute, and `js/prefs.js` is the spec it mirrors.

**Spec:** `docs/superpowers/specs/2026-11-18-desktop-templates-and-preferences-design.md` (Release 2).

**Branch:** `color-schemes`, stacked on `prefs-time-week`. Both touch the Settings "Appearance" section and the service-worker CACHE.

## Global Constraints

- Key `plaenicke.scheme`, with values `'classic' | 'sage' | 'ocean' | 'plum'`. Missing, unknown or throwing gives `'classic'`.
- The candidate schemes are **Claude's picks, made while Alex was away.** Alex picks or cuts them on review. Removing a scheme must be a one-block CSS deletion plus removing it from the list in `prefs.js`.
- Scheme tokens: exactly `--bg --card --ink --muted --accent --accent-ink --line --chip-bg --chip-ink --today --grid-line --tick-glow`. No other token may appear inside a `[data-scheme…]` block.
- Contrast (the computed WCAG ratio, using `tests/styles.test.js`'s `contrast()`):
  - `--ink`, `--muted`, `--danger` (inherited) and `--overdue-start` (inherited): ≥ 4.5 on both `--bg` and `--card`, in both variants of every scheme.
  - `--accent-ink` on `--accent`: ≥ 4.5.
  - `--chip-ink` on `--chip-bg`: ≥ 4.5.
- CACHE `plaenicke-v7-3`. `CACHE_ON_MAIN` stays unchanged.
- Gate on `# fail 0` and `# cancelled 0`.

Core values, checked with a contrast script during planning (all pass ≥ 4.5 for ink, muted, overdue, danger and accent on bg and card):

| scheme | variant | bg | card | ink | muted | accent | accent-ink |
|---|---|---|---|---|---|---|---|
| sage | light | #eef2ec | #fbfdf9 | #1f2a22 | #5c6b60 | #3f6b4f | #fbfdf9 |
| sage | dark | #121714 | #1b221d | #e0e8e2 | #84928a | #86b897 | #121714 |
| ocean | light | #edf2f7 | #fbfdff | #1c2733 | #56677a | #2f5f8f | #fbfdff |
| ocean | dark | #0f1620 | #18212d | #dfe7f0 | #8193a8 | #7fb0e0 | #0f1620 |
| plum | light | #f5eff4 | #fffbfe | #2c2130 | #6e5f72 | #7a4a7e | #fffbfe |
| plum | dark | #17121a | #211a25 | #ece2ef | #97899c | #c79ccc | #17121a |

The implementer derives `--line`, `--chip-bg`, `--chip-ink`, `--grid-line` and `--tick-glow` in the same hue family as classic's relationships (for example, classic light `--line #e0d8c8` sits a step darker than `--bg`). `--today` equals `--accent`. The tests are the guard.

## Review Focus

1. **A dark-variant block that misses a token** leaks the light scheme's value into dark mode. Every scheme defines all 12 tokens in both variants. *(Task 1 test.)*
2. **Specificity:** with `data-scheme="sage"` and no `data-theme`, the classic dark block must not win. With both set, the sage dark block must win over `[data-theme="dark"]`. The dark selector has two attributes and so wins. *(Task 1 test on selector shape.)*
3. **The pre-paint script and `prefs.js` disagree on the valid list.** A scheme added in one but not the other flashes or is ignored. *(Task 2 static test.)*
4. **Private-mode storage:** the Settings click doesn't throw, and the active swatch does not move. *(Task 2 test.)*
5. **Classic must stay byte-for-byte identical:** `:root` and `[data-theme="dark"]` declarations are unchanged. *(Task 1 test.)*

---

### Task 1: Scheme CSS and its contrast guards

**Files:** modify `styles.css` (new blocks after `[data-theme="dark"]`) and `tests/styles.test.js`.

- [ ] **Step 1: Write failing tests** in `tests/styles.test.js`:
  - `const SCHEMES = ['sage','ocean','plum']` and the `SCHEME_TOKENS` list above.
  - For each scheme and each variant selector (`[data-scheme="${s}"]`, `[data-scheme="${s}"][data-theme="dark"]`):
    - (a) every token in `SCHEME_TOKENS` has a declaration (`declOf` is not null);
    - (b) the block declares no other custom property (parse the rule body: its `--*` names are a subset of `SCHEME_TOKENS`);
    - (c) each contrast pair in Global Constraints is ≥ 4.5. `--danger` and `--overdue-start` are read from `:root` for light and from `[data-theme="dark"]` for dark.
  - The classic values for `--bg`, `--ink` and `--accent` in `:root` and `[data-theme="dark"]` equal today's literals (`#f4f1ea`, `#2b2620`, `#8a5a3b`; `#14161a`, `#e2e5ea`, `#8fa7c8`).
  - Every dark scheme selector contains both `[data-scheme=` and `[data-theme="dark"]`.

- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Add the six blocks** using the table's values plus the derived tokens.
- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`.
- [ ] **Step 5: Commit.** `feat(schemes): sage, ocean and plum colour schemes, light and dark`

### Task 2: Store, pre-paint and Settings control

**Files:** modify `js/prefs.js`, `index.html` (the pre-paint script), `js/settings.js` (an "Colours" row under Appearance) and `service-worker.js` (CACHE `plaenicke-v7-3`). Tests: `tests/prefs.test.js`, `tests/settings.test.js`, and a new `tests/prepaint.test.js`.

**Interfaces (produces):** in `js/prefs.js`:
- `SCHEME_KEY = 'plaenicke.scheme'`
- `SCHEMES = ['classic','sage','ocean','plum']`
- `resolveScheme(raw) -> scheme`
- `getScheme()`
- `setScheme(v) -> boolean` (throws `Error('bad scheme')`)
- `applyScheme(scheme, root = document.documentElement)`: sets `root.dataset.scheme`, or deletes it for `classic`.

- [ ] **Step 1: Write failing tests**
  - prefs: resolve, get, set and throwing storage, as in R1. `applyScheme('classic')` removes the attribute, and `applyScheme('sage')` sets it.
  - `tests/prepaint.test.js`:
    - Read `index.html`, extract the inline pre-paint `<script>` and run it with `new Function` against a stub `document.documentElement`, a stub `localStorage` and `window.matchMedia`.
    - For each of `SCHEMES` plus `'bogus'` and `null`, the resulting `dataset.scheme` matches `resolveScheme` (`'classic'` means absent).
    - The existing theme behaviour is unchanged for `'dark'`, `'light'` and `null` with system dark.
  - settings:
    - The Colours row renders 4 buttons labelled `Classic`, `Sage`, `Ocean` and `Plum`, with the current one `active` and `aria-pressed="true"`.
    - A click writes storage and applies the attribute.
    - Throwing storage means no throw and no change.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Each button shows a small swatch, a 14px circle using that scheme's light `--accent` as an inline literal, next to its label.
- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`.
- [ ] **Step 5: Browser check.** Each scheme in light and dark, at 390×844 and 1280×800, on Today, Week and Month, plus the Settings panel. Save screenshots to the worktree's `screenshots/`.
- [ ] **Step 6: Commit.** `feat(schemes): choose a colour scheme in Settings, applied before first paint`

## Out of scope

- Recolouring item types or calendars.
- Syncing the choice.
- `theme-color` meta. There is none today.

## Amendments from the plan review (2026-11-18, DA adjudication — these OVERRIDE the text above)

**Global Constraints, corrected**
- Scheme tokens are 11: `--bg --card --ink --muted --accent --accent-ink --line --chip-bg --today --grid-line --tick-glow`. `--chip-ink` is dropped: nothing reads it (`var(--chip-ink)` appears nowhere).
- Contrast pairs per variant: `--ink`, `--muted`, `--accent`, inherited `--danger`, inherited `--overdue-start` ≥ 4.5 on `--bg` AND `--card`; `--accent-ink` on `--accent` ≥ 4.5. `--today` must EQUAL `--accent` in every block (asserted).
- Removing a scheme touches: its two CSS blocks, `SCHEMES` in `js/prefs.js`, the pre-paint list in `index.html`, the swatch map in `js/settings.js`. Tests tie all four together (below); `tests/styles.test.js` imports `SCHEMES` from `js/prefs.js` rather than keeping a copy.
- `CACHE_ON_MAIN` must equal main's CACHE at merge time: `v7-1` if R1 and R2 merge together, `v7-2` if R1 lands first. Put that line in the merge checklist.

**Task 1 additions**
- Source order: in `rulesOf(css)`, every rule whose selector contains `data-scheme` has an index greater than the `:root` rule and the `[data-theme="dark"]` rule.
- Every rule whose selector contains `data-scheme` is one of exactly the 2×N known selectors (no `[data-scheme="x"] .foo` rules, no `html[data-scheme]` variants).
- Two-way tie: every non-classic entry of `SCHEMES` has both blocks; every `data-scheme="…"` value in styles.css is in `SCHEMES`.
- Classic snapshot: for every scheme token, `declOf(':root', t)` and `declOf('[data-theme="dark"]', t)` equal their current literal (full list, not three).

**Task 2 additions**
- `initSettings` calls `applyScheme(getScheme())` next to its `applyTheme(getSetting())` re-apply (`js/settings.js:~872-874`); test it.
- In `index.html` the scheme logic runs in its OWN try block, BEFORE the theme logic, so a theme-side throw (e.g. no `matchMedia`) cannot skip it. The prepaint test includes a case where `window.matchMedia` is undefined: the scheme is still applied.
- Swatch: each button's swatch is a 14px circle with `border: 1px solid currentColor` (visible on the selected button whose fill is `--accent`). Test: each swatch hex in settings.js equals `declOf('[data-scheme="x"]', '--accent')` (classic: `declOf(':root','--accent')`).
- On a failed storage write: apply the scheme for this session anyway (matching the theme row, `settings.js:236-237`) AND show a one-line note "Couldn't save this on this device; it will reset next time." Test both.
- Row goes AFTER the theme row and R1's rows (Tab-trap tests expect 'Light' first).
- Browser check also at 375×667 and 320×568: the four buttons fit without overflow (labels may sit under the swatch). Screenshot each.

**Spec note:** `manifest.json` `theme_color`/`background_color` are classic light (`#f4f1ea`); dark mode already mismatches them; schemes don't change that. Known gap.
**For Alex (taste):** each candidate accent sits near one item-type colour (sage≈event, ocean≈start, plum≈task); check Month view on review.
