# Desktop layout templates: implementation plan (Release 3), v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

v2 rewrites v1 after the devil's-advocate review (2026-11-18). That review found 4 Critical and 9 Important issues. The findings each change answers are cited in brackets.

**Goal:** On a computer, show plaenicke as one of three side-by-side layouts (`planner`, `month`, `all`), chosen in Settings. The phone is unchanged.

**Architecture:**
- **Visibility stays truthful.** Every view re-renders on every change (`render()` in `js/app.js` ~1421), and being visible is only the `hidden` attribute.
  - A pure `paneViews()` decides which views are visible together.
  - `showView()` applies it at load, on navigation, on a resize across the gate, on a Settings layout change, and on a cross-tab layout change [C1–C3].
- **Markup:** a new `<div class="panes">` wraps the panes in `index.html`. It holds three pane wrappers:
  - `div.pane-left`: the new `#capture-dock` button, then `#today-view`;
  - `div.pane-main`: `#cal-switch` and the four calendar sections;
  - `div.pane-right`: `#todo-view` and `#ideas-view`.
- **On the phone the wrappers are inert.** Outside the gate, `.panes, .pane-left, .pane-main, .pane-right { display: contents }`, so the phone's layout and computed styles are unchanged. `#cal-switch` moves after `#today-view` in document order, which is invisible on the phone, because they are never shown together.
- **On desktop, behind the gate:**
  - `.panes` is a grid of independently scrolling columns.
  - The `.tab-bar` is a rail fixed to the left edge, and `body` gets `padding-left` equal to the rail width.
  - The header, `#sync-indicator`, `#account-banner` and `#status-line` stay normal blocks above `.panes` [I1, I2].
- **Capture stays an overlay,** as in the spec's option a. On desktop, `#capture-box` is fixed near the top-left of the left pane, and `createCapture` gets a no-op `follow` [C4].

**Spec:** `docs/superpowers/specs/2026-11-18-desktop-templates-and-preferences-design.md` (Release 3).

**Branch:** `desktop-templates`, stacked on `color-schemes`. It starts by cherry-picking `desktop-a`'s four commits (`49f2270`, `184e80d`, `5a539a1` and `94fd3ee`).

## Global Constraints

- **Desktop gate:** `(min-width: 46rem) and (hover: hover) and (pointer: fine)`, exported as `DESKTOP_QUERY` from `js/layout.js`. A test pins the CSS gate prelude to exactly this string [I8].
- **Wide query:** `WIDE_QUERY = DESKTOP_QUERY + ' and (min-width: 80rem)'`. Its CSS block uses this exact full string. Below it, `all` behaves as `planner`, in both CSS and `paneViews`.
- **Key `plaenicke.layout`:** values `'planner' | 'month' | 'all'`. Missing, unknown or throwing gives `'planner'`. Device-local. Applied as `data-layout` on `<html>` by the pre-paint script (in its own try block), at Settings mount, on a Settings change, and on a cross-tab change [C3].
- **Phone untouched:** below the gate, computed styles and `hidden` states equal `main`'s. Pinned by desktop-a's phone-value tests, plus `paneViews({isDesktop:false})` giving `[main]`, plus a test that the wrappers are `display: contents` outside the gate.
- **The CSS tests read rules in context:** they use `rulesInContext` (`tests/styles.test.js` ~674, filtered by `at`), never the flattening `declOf`, for any selector the gate also styles [I8].
- **Sections keep `[hidden]` working:** any gate rule that sets `display` on a section also has `[hidden] { display: none }` restated for that selector, and a test checks it [O3]. Selectors name ids or `.pane-* > section`, never a bare `section` [O4].
- **`matchMedia` listeners** use `addEventListener` when it is a function, otherwise `addListener` [O7].
- No sync, `merge()` or `schemaVersion` changes. New `js/` files go in `ASSETS`. CACHE is bumped one past `color-schemes`. `CACHE_ON_MAIN` equals main's CACHE at merge time.
- Gate every commit on `# fail 0` **and** `# cancelled 0`.

## Review Focus

1. **First load on desktop** shows the template's panes, not Today alone [C1]. *(Task 2 test: the `matchMedia` stub is installed before app.js's first import.)*
2. **Every way the layout can change** (Settings, another tab, resizing across either gate) leaves `hidden` and `data-layout` in agreement [C2, C3]. *(Task 2 tests assert both.)*
3. **Opening capture from the dock on desktop Chrome:** typing mode with no microphone prompt, no inline `transform` on the box, and `aria-expanded` on the dock [C4, I3]. *(Task 4 tests, with a fake `visualViewport`.)*
4. **An item shown in two panes** (a to-do due today): closing its sheet returns focus to the pane it was opened from [I6]. *(Task 2 test.)*
5. **Layout chrome a phone user would notice:** the toast, the sheet, body padding and the Day/3-day inner scroll get desktop gate rules. Phone values stay unchanged [O1, O2, O5]. *(Task 3 tests plus Task 5.)*

---

### Task 1: Base: desktop-a, wrappers, layout preference and pane rules

**Files:**
- Cherry-pick desktop-a. Resolve `service-worker.js` (CACHE: this branch's bump), `tests/serviceworker.test.js` and `tests/styles.test.js`.
- Delete desktop-a's centred-column rules, but keep the gate block and the test helpers.
- `index.html`: add the wrappers and `#capture-dock` (`<button id="capture-dock" class="capture-dock" type="button">Say or type something…</button>`, first child of `.pane-left`).
- `styles.css`: `display: contents` for the wrappers outside the gate; `.capture-dock { display: none }` outside the gate.
- Create `js/layout.js` and `tests/layout.test.js`.
- Modify `js/prefs.js`, the pre-paint script in `index.html`, `js/settings.js` and `service-worker.js`.

**Interfaces (produces):**
- `js/prefs.js`: `LAYOUT_KEY`, `LAYOUTS`, `resolveLayout`, `getLayout`, `setLayout(v) -> boolean` (throws `Error('bad layout')`), and `applyLayout(layout, root = document.documentElement)`.
- `js/layout.js`:
  - `DESKTOP_QUERY`, `WIDE_QUERY`.
  - `CALENDAR_VIEWS = ['day','3day','week','month']`.
  - `defaultMain(layout) -> 'week'|'month'` (`all` gives `week`).
  - `paneViews({ layout, main, lastCalendar, isDesktop, isWide }) -> { visible: string[], calendar: string|null }` [I4]. `visible` is in document order (`today`, the calendar view, `todo`, `ideas`), and `calendar` is the calendar view shown, or `null`. Rules:
    - `!isDesktop` gives `[main]`. `calendar` is `main` if `main` is a calendar view, otherwise `null`.
    - `planner` and `month` give `today` plus one big-pane view. The big pane is `main` when `main !== 'today'`, otherwise `lastCalendar`.
    - `all` with `isWide` gives `today`, a calendar view (`main` if it is one, else `lastCalendar`), `todo` and `ideas`.
    - `all` without `isWide` behaves as `planner`.
- `js/settings.js`: a "Computer layout" row after the Colours row, with `Week planner`, `Month overview` and `Everything`. A new **required** `initSettings` option `onLayoutChanged: () => void`, guarded after the existing guards, called after a successful `setLayout` + `applyLayout` [C2]. A failed write applies for the session and shows the note (R2 pattern). Also `applyLayout(getLayout())` at mount.

- [ ] **Step 1: Write failing tests**
  - The full `paneViews` truth table: 3 layouts × `isDesktop` × `isWide` × main in `{today, day, week, month, todo, ideas}` × `lastCalendar` in `{day, week}`.
  - prefs layout tests.
  - prepaint layout cases, including `matchMedia` missing.
  - settings row tests, including the callback and the missing-callback guard (every other option supplied).
  - styles: the wrappers are `display: contents` outside the gate; `.capture-dock` is `display: none` outside the gate; the gate prelude equals `DESKTOP_QUERY`; desktop-a's phone pins still pass.
  - An `index.html` structure test: `.pane-left` holds `#capture-dock` and `#today-view`; `.pane-main` holds `#cal-switch` and the four calendar sections; `.pane-right` holds `#todo-view` and `#ideas-view`; the hosts, `#capture-box` and `#capture-btn` stay body-level, after `.panes`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`.
- [ ] **Step 5: Commit.** `feat(layout): pane wrappers, desktop layout preference and pane rules`

### Task 2: `app.js` applies the panes everywhere

**Files:** `js/app.js` and `tests/apply.test.js`. First, list every `.hidden` read and every `showView` caller (`grep -n "\.hidden\|showView(" js/app.js`), and put the list in the commit body.

**Behaviour:**
- `let mainView = 'today'`. `showView(which)` sets `mainView` (and `lastCalendarView` when `which` is a calendar view), computes `paneViews` from `getLayout()`, `matchMedia(DESKTOP_QUERY).matches`, `matchMedia(WIDE_QUERY).matches` and `lastCalendarView`, and sets every view's `hidden` from `visible`.
- When `paneViews` returns a `calendar` that differs from `lastCalendarView`, record it [I4].
- **Load** calls `showView(mainView)` in place of the bare `render()` [C1].
- **On desktop at load and on a layout change,** seed `lastCalendarView = defaultMain(layout)` [I4].
- `els.calSwitch.hidden = (calendar === null)`, and its segments mark `calendar` [I5].
- Tabs and rail: `aria-current="page"` marks `mainView`'s tab, as today. Each visible pane section gets `aria-label` naming its view (Today, Calendar, To-do, Ideas) on desktop only, and the label is removed off desktop [O9].
- The `matchMedia` `change` listeners on both queries call `showView(mainView)`. `onLayoutChanged` (Settings) seeds `lastCalendarView` and calls `showView(mainView)`.
- The `storage` handler for `LAYOUT_KEY` sits **before** the `CROSS_TAB_KEYS` early return (~1833). It does `applyLayout(getLayout()); seed; showView(mainView)` and schedules no sync [C3].
- `openItem` records `openedFrom`, the visible pane section containing `document.activeElement`. `focusOpener` searches `openedFrom` first, then the other visible sections in order [I6].
- **`laterOpen` default:** wherever app.js resets `laterOpen` (load, new day ~1340, layout change), set it to `getLayout() === 'month' && isDesktop`. `toggleLater` stays the authority after that [I9].

- [ ] **Step 1: Write failing tests** in `tests/apply.test.js`. A controllable `matchMedia` stub (with `matches` per query, a `change` dispatch, and `addEventListener`) is installed **before** the file's first `import('../js/app.js')`, defaulting to `matches: false`.
  - **Load:** a separate test file, `tests/layout-load.test.js`, is needed because app.js loads once per file. It installs the stub with desktop true and `planner` before importing app.js, then asserts `#today-view` and `#week-view` are visible and every other view is hidden [C1].
  - **Navigation:** in planner, `showView('todo')` shows `#today-view` and `#todo-view`, with `aria-current` on `#tab-todo`. A non-desktop `change` gives only `#todo-view`. The calendar switch is visible exactly when a calendar pane is visible.
  - **`all`:** wide off behaves as planner. Firing wide on adds To-do and Ideas.
  - **Settings layout click:** the panes change and `dataset.layout` changes [C2].
  - **Storage event:** the panes change, `dataset.layout` changes, and no sync is scheduled [C3].
  - **Focus:** a to-do due today, opened from `#todo-view` and closed, puts focus in `#todo-view` [I6].
  - **The Today tick** is armed while Today is a side pane.
  - **`laterOpen`:** Month overview on desktop opens Coming up, and "Show less" then closes it and keeps it closed on re-render [I9].
  - Every test ends with the stub back at `matches: false` and `planner`.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`. Mutation-check:
  - (a) `showView` ignores `isDesktop`: the phone test fails;
  - (b) `syncTodayTick` keyed on `mainView`: the tick test fails;
  - (c) the storage handler without `applyLayout`: the storage test fails;
  - (d) a first-match `focusOpener`: the focus test fails.
- [ ] **Step 5: Commit.** `feat(layout): show the template's panes together on desktop`

### Task 3: Grid, rail and desktop chrome (CSS, inside the gate only)

**Files:** `styles.css` and `tests/styles.test.js` (context-aware readers).

- [ ] **Step 1: Write failing tests**
  - Gate: `.panes` is `display: grid`. Per `[data-layout]`, the columns are `.pane-left`, `.pane-main` and (`all`, in the `WIDE_QUERY` block only) `.pane-right`. Below wide, `[data-layout="all"] .pane-right` is not a column.
  - Each pane is a flex column with its own `overflow: auto`, `min-width: 0` and `min-height: 0`.
  - `.tab-bar` in the gate:
    - `position: fixed` with `top: 0`, `bottom: 0` and `left: 0`;
    - `width: 4.5rem`;
    - `flex-direction: column`;
    - the bottom-bar `height` and `padding-bottom` overridden [I7].
  - `body`: `padding-left: 4.5rem`, and the bottom padding reset from `calc(56px + 80px + …)` [O2].
  - `.toast`: `bottom` and `left` clear the rail, with no bottom-bar offset. `.sheet` has a desktop `max-width` [O1].
  - Day and 3-day grids: `max-height: none` inside panes [O5].
  - Every gate rule that sets `display` on a section restates `[hidden] { display: none }` [O3].
  - No selector in the gate is a bare `section` [O4]. No rule outside the gate mentions `data-layout` or `.pane-`, except the `display: contents` rule.
  - The phone pins pass.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Columns: left `minmax(20rem, 26rem)`, main `1fr`, `all`'s right `minmax(18rem, 22rem)`.
  - `.panes` height is the viewport minus the header block. Use `height: calc(100dvh - var(--desktop-top))` with the header height in a custom property, or a flex column on `body`. State which.
  - Week and Month fill `.pane-main`.
- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`.
- [ ] **Step 5: Commit.** `feat(layout): desktop grid, side rail and desktop chrome`

### Task 4: The docked capture line

**Files:** `js/capture.js`, `js/app.js`, `styles.css`, and tests in `tests/capture.test.js`, `tests/apply.test.js` and `tests/styles.test.js`.

**Interfaces:** `createCapture({ …, openers = [] })`, where `openers` are extra elements that mirror the button's `aria-expanded` and disabled state.
- `setMode` and `setAdding` update `els.button` **and** every opener [I3].
- `openTyping()` is returned from `createCapture`: it does `open(); setMode('typing'); focusField()`. It never starts voice [I3].
- The phone path is unchanged: the default `openers = []`, and `tapButton` is untouched.

- [ ] **Step 1: Write failing tests**
  - capture: `openTyping()` opens the box in typing mode and never calls the recognizer, even when voice is supported. With `openers: [dock]`, the dock's `aria-expanded` follows open and close, and it is disabled while adding. With no openers, behaviour is identical to today (the existing capture tests are unchanged).
  - apply, with the desktop stub and a fake `window.visualViewport`: clicking `#capture-dock` calls `openTyping`, the box opens, and `els.captureBox.style.transform` is empty [C4]. With the stub off, a `#capture-btn` click still follows the viewport as today.
  - styles (gate):
    - `.capture-btn` is `display: none`;
    - `.capture-dock` is visible and styled as a full-width input-like button at the top of `.pane-left`;
    - `.capture-box` is `position: fixed`, anchored to the left pane's top-left (`top`/`left` from the rail and header), with width ≤ the left column. No `transform` is set in CSS.
- [ ] **Step 2: Run `npm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.** app.js passes `openers: [els.captureDock]` and `follow: (el, o) => matchMedia(DESKTOP_QUERY).matches ? () => {} : followVisualViewport(el, o)`. The dock click calls `capture.openTyping()`.
- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`. Mutation-check: `openTyping` calling `tapButton` fails the no-recognizer test.
- [ ] **Step 5: Commit.** `feat(layout): docked capture line on desktop`

### Task 5: Browser check and fixes

Serve the branch and seed items with the scratchpad seed page's item list (`/private/tmp/claude-502/-Users-ajaenicke25/d5fecb07-fe05-4f3e-9f20-88af0fec9423/scratchpad/serve-desktop-a/seed.html`). Use chrome-devtools with an isolated context.
- Desktop at 1024×768, 1280×800 and 1440×900: each layout, light and dark, with one non-classic scheme. Also at 736px wide, and at 1270px for `all` (just under 80rem).
- Phone at 390×844 and 932×430, with touch emulation (`hasTouch`, and coarse pointer if available): compare against `main` side by side.
- Check:
  - first load shows the panes;
  - capture opens from the dock with no microphone prompt;
  - opening capture does not move the main column;
  - Settings and the sheet open over the grid;
  - the toast clears the rail;
  - a long title does not stretch the left pane;
  - no console errors.
- Screenshots go in the worktree's `screenshots/`. Fix findings test-first, then commit.

## Known limits (not fixed here)

- The scroll lock sets `body` overflow, so on desktop a focused pane behind an open sheet can still scroll by keyboard [O6].
- Tab order follows document order: the rail comes after the panes [O8].
- Clicking a Month cell opens Day in the main pane, the same as on the phone. This is Claude's call, made while Alex was away, and goes on Alex's review list [O10].

## Out of scope

- Dragging panes, custom layouts, or resizable columns.
- New calendar views.
- Syncing the layout.
- Touch tablets.
