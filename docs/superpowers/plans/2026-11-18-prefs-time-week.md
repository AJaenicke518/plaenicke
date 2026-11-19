# Time format and week start: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each device choose 12- or 24-hour time and a Sunday or Monday week start, in Settings, with today's behaviour as the default.

**Architecture:**
- A new pure-plus-storage module, `js/prefs.js`, owns the two `localStorage` keys.
- `js/timegrid.js` and `js/calendar.js` take the preference as an explicit parameter whose default is today's behaviour, so every existing call and test keeps working.
- Render sites read the preference at render time and pass it in.
- Settings writes the preference and calls back into `app.js`, which re-anchors the visible week and re-renders.

**Tech Stack:** Vanilla ES modules, `node --test`, `tests/fake-dom.js`, `tests/fake-localstorage.js`.

**Spec:** `docs/superpowers/specs/2026-11-18-desktop-templates-and-preferences-design.md` (Release 1).

**Branch:** `prefs-time-week`, from `main` at `a6bc35f`.

## Global Constraints

- Keys: `plaenicke.timeFormat` with values `'12h' | '24h'`, and `plaenicke.weekStart` with values `'sun' | 'mon'`. A missing key, an unknown value, or a throwing `localStorage` gives `'12h'` / `'sun'`.
- Device-local only. Nothing touches the sync blob, `merge()`, `schemaVersion`, `js/sync.js` or `js/linkui.js`.
- `js/ics.js` week arithmetic (RRULE `WKST`) must not change.
- Every `js/` module must be listed in `service-worker.js` `ASSETS`, which `tests/serviceworker.test.js` enforces. Bump `CACHE` to `plaenicke-v7-2`. `CACHE_ON_MAIN` stays `plaenicke-v7-0` until main moves. `desktop-a` also uses v7-2, so whichever branch merges second re-pins and bumps.
- Gate every commit on `npm test` showing `# fail 0` **and** `# cancelled 0`. Never run `node --test tests/`.
- 24-hour format is zero-padded `HH:MM` (`07:05`, `13:00`, `00:00`). A range is `07:00–09:15` (en dash, no period suffix).

## Review Focus

1. **Midnight and noon:** in 24h, `00:00` and `12:00` render as `00:00` and `12:00`. In 12h they stay `12:00 AM` and `12:00 PM`. *(Task 1 test.)*
2. **A month whose 1st is a Sunday, with a Monday start,** gets 6 leading blanks, not 0. A month whose 1st is a Monday gets 0. *(Task 1 test.)*
3. **A Monday-start week across New Year:** `startOfWeek('2027-01-01', 'mon')` is `'2026-12-28'`, and the week label shows both years. *(Task 1 test.)*
4. **Switching week start while viewing a non-current week** keeps that week on screen (re-anchored around its midpoint), not a jump to today. *(Task 3 test.)*
5. **A private-mode `localStorage` that throws on get and set:** reading gives the defaults, and setting does not throw out of the Settings click handler. *(Task 1 and Task 3 tests.)*

---

### Task 1: Preference store and pure formatting

**Files:**
- Create: `js/prefs.js`, `tests/prefs.test.js`
- Modify: `js/timegrid.js` (`formatTime`, `formatTimeRange`, `startOfWeek`, new `weekdayNames`), `js/calendar.js:3` (`buildMonthGrid`), `service-worker.js` (add `'js/prefs.js'` to `ASSETS`, CACHE `plaenicke-v7-2`)
- Test: `tests/prefs.test.js`, `tests/timegrid.test.js`, `tests/calendar.test.js`

**Interfaces (produces):**
- `js/prefs.js`:
  - `TIME_FORMAT_KEY = 'plaenicke.timeFormat'` and `WEEK_START_KEY = 'plaenicke.weekStart'`
  - `resolveTimeFormat(raw: unknown) -> '12h'|'24h'` and `resolveWeekStart(raw: unknown) -> 'sun'|'mon'` (pure)
  - `getTimeFormat() -> '12h'|'24h'` and `getWeekStart() -> 'sun'|'mon'` (read storage, never throw)
  - `setTimeFormat(v) -> boolean` and `setWeekStart(v) -> boolean`: they throw `Error('bad time format')` / `Error('bad week start')` on an invalid value, and return `false` when storage throws.
- `js/timegrid.js`:
  - `formatTime(hhmm, fmt = '12h')`
  - `formatTimeRange(start, end, fmt = '12h')`
  - `startOfWeek(iso, weekStart = 'sun')`
  - `weekdayNames(weekStart = 'sun') -> string[7]` (`['Sun',…]` or `['Mon',…,'Sun']`)
  - `hourLabel(h: 0..23, fmt = '12h') -> string` (`'7 AM'` / `'07'`). It moves here from `threedayview.js:23`.
- `js/calendar.js`: `buildMonthGrid(year, month, weekStart = 'sun')`.

- [ ] **Step 1: Write failing tests**
  - `tests/prefs.test.js`, using `installFakeLocalStorage()`:
    - resolve: `resolveTimeFormat('24h') === '24h'`, and `resolveTimeFormat(null|'' |'24'|42) === '12h'`; the same pattern for week start.
    - get with an empty store gives defaults.
    - set and get round trip.
    - `setTimeFormat('25h')` throws `/bad time format/`.
    - With `getItem` and `setItem` stubbed to throw: get gives defaults, and set returns `false`.
  - `tests/timegrid.test.js`:
    - `formatTime('00:00','24h') === '00:00'`, `formatTime('07:05','24h') === '07:05'`, `formatTime('12:00','24h') === '12:00'`, `formatTime('23:59','24h') === '23:59'`.
    - 12h is unchanged: `formatTime('00:00') === '12:00 AM'`, `formatTime('12:00') === '12:00 PM'`.
    - `formatTimeRange('07:00','09:15','24h') === '07:00–09:15'`, `formatTimeRange('11:00','13:00','24h') === '11:00–13:00'`.
    - `startOfWeek('2026-11-18','mon') === '2026-11-16'`, `startOfWeek('2026-11-22','mon') === '2026-11-16'` (Sunday goes back 6 days), `startOfWeek('2026-11-16','mon') === '2026-11-16'`, `startOfWeek('2027-01-01','mon') === '2026-12-28'`. The existing Sunday tests stay.
    - `weekdayNames('mon')` deep-equals `['Mon','Tue','Wed','Thu','Fri','Sat','Sun']`, and `weekdayNames()` starts with `'Sun'`.
    - `hourLabel(0) === '12 AM'`, `hourLabel(13) === '1 PM'`, `hourLabel(0,'24h') === '00'`, `hourLabel(13,'24h') === '13'`.
  - `tests/calendar.test.js`:
    - March 2026 (1st is a Sunday): `buildMonthGrid(2026, 2, 'mon')[0]` has 6 leading `null`s and `[0][6].day === 1`.
    - June 2026 (1st is a Monday): `buildMonthGrid(2026, 5, 'mon')[0][0].day === 1`.
    - Every week has length 7.

- [ ] **Step 2: Run `npm test`.** Expected: the new tests FAIL (missing module or exports). Everything else passes.

- [ ] **Step 3: Implement.**
  - `prefs.js` mirrors `js/theme.js`: pure resolvers, and storage wrapped in try/catch.
  - `startOfWeek` offset for Monday is `(getDay() + 6) % 7`.
  - `buildMonthGrid` leading blanks are `(getDay() - (weekStart === 'mon' ? 1 : 0) + 7) % 7`.
  - Add `'js/prefs.js'` to `ASSETS` and set `CACHE = 'plaenicke-v7-2'`.

- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Commit.** `feat(prefs): device-local time format and week start, pure formatting`

---

### Task 2: Every rendered time honours the time format

**Files:**
- Modify: `js/dayview.js:29,46-47`, `js/threedayview.js:21,23,94`, `js/itemsheet.js:279`, `js/todayview.js`, `js/weeklist.js`, `js/freshness.js:56`, `js/app.js:1881`
- Test: `tests/styles.test.js` style static check in a new `tests/timeformat.test.js`, plus one rendered check per view in its existing test file

**Interfaces:** consumes `getTimeFormat()`, `formatTime`, `formatTimeRange` and `hourLabel` from Task 1.

- [ ] **Step 1: Write failing tests**
  - `tests/timeformat.test.js` (a static source check that reads every `js/*.js` with `readFileSync`):
    - (a) No file except `js/timegrid.js` contains the regex `/['"]\s?[AP]M['"]/`.
    - (b) Every call `formatTime(` / `formatTimeRange(` / `hourLabel(` outside `timegrid.js` passes a format argument: no call matches `/formatTime\([^,()]*\)/`, `/formatTimeRange\([^,()]*,[^,()]*\)/`, or `/hourLabel\([^,()]*\)/`.
    - (c) `js/threedayview.js` does not contain `.split(' ')`.
  - Rendered checks, with `localStorage['plaenicke.timeFormat'] = '24h'` set before render:
    - `tests/dayview.test.js`: an item at `13:30–14:00` renders the text `13:30–14:00`, and the 13:00 hour label reads `13:00`.
    - `tests/threedayview.test.js`: a `13:30` item's short time reads `13:30`, and its hour label reads `13`.
    - `tests/todayview.test.js`: a timed row reads `13:30–14:00`.
    - `tests/itemsheet.test.js`: the "when" line contains `13:30–14:00`.
    - `tests/freshness.test.js`: the stamp clock for 13:05 reads `13:05`.
  - In each file, one existing 12h assertion stays as the default case.

- [ ] **Step 2: Run `npm test`.** Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - Each site calls `getTimeFormat()` once per render and passes it in.
  - `threedayview.js`:
    - `shortTime(hhmm, fmt)` returns the hour-and-minute part without a period: in 12h, `formatTime` without the suffix (computed, not split); in 24h, `formatTime(hhmm,'24h')`.
    - It imports `hourLabel` from timegrid instead of its local copy.
  - Leave `js/accountui.js:110` (the lockout retry time) as is: it uses `toLocaleTimeString` on a timestamp and is excluded on purpose. Document that exclusion in a one-line comment.

- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Commit.** `feat(prefs): render every time through the chosen format`

---

### Task 3: Week start everywhere, plus the Settings controls

**Files:**
- Modify:
  - `js/app.js`: lines 148, 1173, 1477 and 1852 (`startOfWeek` and the month header), the `buildMonthGrid` call, and the `initSettings` wiring at line 294.
  - `js/weekview.js:6,19`: the column head name is derived from the date, not from a `DOW[i]` index.
  - `js/weeklist.js:25`: comment only, "the first day of the week shown".
  - `js/settings.js`: two new segmented rows under "Appearance".
- Test: `tests/apply.test.js`, `tests/settings.test.js`, `tests/v6views.test.js` (or whichever file renders Week; the implementer checks), `tests/weeklist.test.js`

**Interfaces:**
- Consumes `getWeekStart`, `setWeekStart`, `getTimeFormat`, `setTimeFormat`, `startOfWeek`, `weekdayNames` and `buildMonthGrid` from Task 1.
- Produces a new **required** `initSettings` option `onDisplayPrefsChanged: () => void`. A missing callback throws `Error('initSettings requires an onDisplayPrefsChanged callback')`, matching the existing wiring guards.
- `app.js` implements it as follows: `viewWeekStart = startOfWeek(addDays(viewWeekStart, 3), getWeekStart()); render();`

- [ ] **Step 1: Write failing tests**
  - `tests/settings.test.js`:
    - The panel renders a "Time" segment (`12-hour`, `24-hour`) and a "Week starts" segment (`Sunday`, `Monday`) with the current value marked `active` and `aria-pressed="true"`.
    - Clicking `24-hour` sets `localStorage['plaenicke.timeFormat'] === '24h'` and calls `onDisplayPrefsChanged` once.
    - Clicking with a throwing `setItem` does not throw. The callback is still not called, and the old button stays active.
    - `initSettings` without `onDisplayPrefsChanged` throws the message above.
  - Week render test: with `weekStart = 'mon'`, the Week view's first column head reads `Mon` and its date is the Monday. With `'sun'`, it reads `Sun`, as today.
  - Month header test: with `'mon'`, the first `.cal-head` reads `Mon` and the last reads `Sun`, and November 2026 (1st is a Sunday) places day 1 in the 7th column.
  - `tests/apply.test.js` (the re-anchor test from Review Focus 4): from a Sunday-start week beginning `2026-11-29`, call the settings callback after setting `'mon'`. The Week label shows `11/30 – 12/06`. The `followToday` path at line 1852 uses `getWeekStart()`.

- [ ] **Step 2: Run `npm test`.** Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Wire `getWeekStart()` into every `startOfWeek` call in `app.js`, the month header (`weekdayNames`) and `buildMonthGrid`. The Settings rows copy the theme segment's pattern (`js/settings.js:225-242`).

- [ ] **Step 4: Run `npm test`.** Expected: `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Browser check.**
  - Serve the worktree locally.
  - At 390×844 and 1280×800, switch both settings and screenshot Day, 3-day, Week, Month and Today. There should be no console errors.
  - Save the screenshots under the worktree's untracked `screenshots/`.

- [ ] **Step 6: Commit.** `feat(prefs): week start setting and Settings controls`

## Out of scope

- Syncing these preferences.
- Locale-driven formats.
- Any `js/ics.js` change.
- Colour schemes and templates (later releases).

## Amendments from the plan review (2026-11-18, DA adjudication — these OVERRIDE the tasks above where they conflict)

**Task 1**
- Re-pin `CACHE_ON_MAIN` in `tests/serviceworker.test.js` to `'plaenicke-v7-1'` (main already ships v7-1). CACHE becomes `plaenicke-v7-2`.
- `js/freshness.js` stays pure: `describeLaunches(launches, now, fmt = '12h')` and its `localClock` take the format as a parameter; settings.js passes `getTimeFormat()`.

**Task 2**
- Static check (b) is a parenthesis-balanced scan, not a regex: for each `formatTime(` / `formatTimeRange(` / `hourLabel(` outside `timegrid.js`, walk to the matching `)` (tracking nesting and template-literal `${}`), count top-level commas; `formatTime` and `hourLabel` need ≥1, `formatTimeRange` ≥2. Include a fixture assertion that the scanner flags ``formatTime(`${String(h).padStart(2, '0')}:00`)``.
- Rendered 24h checks for BOTH stamps: `describeLaunches(..., '24h')` in `tests/freshness.test.js`, and `#updated-stamp` text in `tests/apply.test.js`.
- `tests/threedayview.test.js`: under 24h, a 13:30–14:00 block's hidden span text is `'–14:00 '`.
- Each rendered test renders twice in one test (12h then 24h, or the reverse) to prove no module caches the preference at load.

**Task 3**
- The callback (and the storage-listener handler below) is:
  ```js
  refreshForToday();
  const t = toISO(new Date());
  const pivot = (t >= viewWeekStart && t <= addDays(viewWeekStart, 6)) ? t : addDays(viewWeekStart, 3);
  viewWeekStart = startOfWeek(pivot, getWeekStart());
  render(); stampUpdated(); stampFromFeeds();
  ```
- Tests with the clock on a Sunday (mock Date) in both directions: today stays on screen. Non-current-week test uses dates computed relative to now (pattern: `far(3)` near `tests/apply.test.js:9847`), asserts a jump-to-today implementation would fail, and ends by restoring 'sun' + current week ("restored for later tests").
- The `storage` listener (`js/app.js:1829-1839`) handles `TIME_FORMAT_KEY` and `WEEK_START_KEY` with the same handler and schedules NO sync; add both keys to the no-sync list in the test near `tests/apply.test.js:5830`.
- `initSettings`: the `onDisplayPrefsChanged` guard goes AFTER the `onSignedIn` guard; add the callback to the existing `initSettings` calls in `tests/settings.test.js` (lines ~64, ~480, ~533); the new throw test supplies every other required option.
- New rows go AFTER the theme row (Tab-trap tests expect 'Light' first), each in its own container; the throwing-write test asserts the theme row is unchanged. On a failed write, show a short inline note in the row ("Couldn't save this setting on this device.") — no silent no-op.
- After a successful time-format write, Settings repaints the usage line (`js/settings.js:245-248`).
- `renderCalendar` reads `getWeekStart()` once and passes it to both `weekdayNames` and `buildMonthGrid`. Line refs: `buildMonthGrid` call ~1164, header loop 1173, weekview `DOW[i]` at line 18.
