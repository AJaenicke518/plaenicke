# Desktop templates and display preferences — design (2026-11-18)

Status: **draft for Alex's approval.** Alex approved the scope, the three templates, device-local settings and delivery order B in conversation on 2026-11-18. The two side-rail and capture calls below were made by Claude in autonomous mode, and Alex needs to confirm them. Supersedes the options in `2026-11-13-desktop-layout-options.md`. `desktop-a` (option A) is not merged; this work builds on it.

## Why

plaenicke is a phone app first. Someone on the go opens it, taps the mic at bottom right (where a right thumb rests), says the thing, and it lands on their calendar. Otherwise they glance at Today and put the phone away. **Phone convenience comes first.**

The desktop serves a different job: **looking and organizing.** People sit down to see what's coming up, find free time ("am I free when my friend suggests Thursday?"), and add blocks ("start working on HW A Tuesday night"). Changing an item uses the existing item sheet. Alex's verdict on `desktop-a`: it looks nice, but it "just centered things".

Alex also wants people to be able to fit the app to themselves: pick a desktop layout from templates, choose 12- or 24-hour time and the day the week starts, and pick a colour scheme.

## Goals

1. **Three desktop layout templates**, chosen in Settings (Alex, 2026-11-18: "we can start by having those three"):
   - **Week planner:** left pane Today; right pane the Calendar, defaulting to Week.
   - **Month overview:** left pane Today plus a "Coming up" list; right pane the Calendar, defaulting to Month.
   - **Everything at once:** Today | Calendar (Week) | To-do with Ideas.
   In all three, a slim left rail replaces the bottom tab bar, and a capture box (typing plus mic) sits at the top of the left pane in place of the floating mic button.
2. **Time format:** 12-hour (default, today's behaviour) or 24-hour.
3. **Week starts on:** Sunday (default, today's behaviour) or Monday.
4. **Colour schemes:** a choice of schemes beyond today's single palette.

## Non-goals

- Email integration. Alex dropped it on 2026-11-18 as too big for now.
- Letting people drag panels anywhere or build their own layout. Templates are fixed presets.
- Drag-to-reschedule on the calendar. People rearrange by opening the item sheet, as today.
- Syncing any of these settings between devices (Alex, 2026-11-18: "stay on the device for now").

## Anti-goals: these make it a failure even if it works

- **Any change to the phone layout or to how quickly someone can capture on the phone.** The mic button stays bottom right on the phone.
- Touching the sync blob, `merge()` or `schemaVersion`.
- A flash of the wrong colours or layout on load.
- A colour scheme that fails the contrast checks the existing schemes pass.

## Constraints

- No framework, no build step (CLAUDE.md). Merging to `main` is a production deploy. Every release bumps CACHE and re-pins `CACHE_ON_MAIN`.
- **The desktop gate:** `@media (min-width: 46rem) and (hover: hover) and (pointer: fine)`, from `desktop-a`. It was measured to exclude phones, including 932px landscape. Every template rule lives behind it. Below the gate, or on a touch device, the `data-layout` attribute has no effect.
- **Preferences are device-local `localStorage` keys** under the `plaenicke.` prefix, written only by Settings. Every read and write is wrapped the way `plaenicke.theme` is today (private mode throws).
- **Anything that changes the first paint is applied by the pre-paint script in `index.html`,** which already does this for `plaenicke.theme` and mirrors `js/theme.js`. The pure module is the spec, and the inline script is kept in sync with it.
- `tests/styles.test.js` computes contrast ratios for the colour tokens. Every new scheme passes the same thresholds.

## Approaches considered

**Order of delivery.** Alex chose **B**:
- A, one release with all four parts: one test pass, but a large diff on the phone-critical app, and one faulty part holds up the rest.
- **B, three releases (chosen):** (1) time format plus week start, (2) colour schemes, (3) templates. Each is its own branch and review. Risk rises with each release, and the riskiest part cannot hold up the others.
- C, templates first: the desktop changes soonest, but the riskiest work goes first.

**Templates, technically.** There is one sensible path: one CSS block per template, keyed on `data-layout` on `<html>`, behind the desktop gate, plus a change to `app.js` so that more than one view can be visible at once. Ruled out:
- A separate desktop page duplicates every view.
- Iframes break the shared module state.
- Pure CSS can't work, because `showView()` sets `hidden` on every view but one.

## The design

### Release 1: time format and week start

- **`plaenicke.timeFormat`**: `'12h'` | `'24h'`. Missing or any other value means `'12h'`.
- **`plaenicke.weekStart`**: `'sun'` | `'mon'`. Missing or any other value means `'sun'`.
- **24-hour time** goes through `formatTime` / `formatTimeRange` in `js/timegrid.js`. Known places that format times outside those functions, all to be converted or deliberately excluded:
  - `js/threedayview.js:21` `shortTime` splits on the space before AM/PM, so it breaks under 24h.
  - `js/accountui.js:110` uses `toLocaleTimeString`.
  - The Day view's hour labels go through `formatTime` already.
  The builder lists every remaining time-rendering site first (grep for `formatTime`, `toLocaleTimeString`, `AM`, `PM`).
- **Week start:** Sunday is built into `startOfWeek` in `js/timegrid.js`, the month grid in `js/calendar.js` (`getDay()`, 0 = Sunday), `js/weeklist.js` (documented as "the Sunday of the week shown"), and the weekday headers. `js/ics.js`'s Monday-based week arithmetic is RRULE `WKST` handling. It is unrelated and must not change.
- Both are new rows in Settings, next to the existing theme control.

### Release 2: colour schemes

- **`plaenicke.scheme`**: a scheme id. Missing or unknown means today's palette.
- A scheme is a set of values for the existing colour tokens on `:root` (`--bg`, `--card`, `--ink`, `--muted`, `--accent`, the `--type-*` colours, and so on). It is applied as `data-scheme` on `<html>` by the pre-paint script.
- **Claude's call:** every scheme defines both a light and a dark variant, so the existing Light / Dark / Auto setting keeps working unchanged with every scheme. Today's palette (cream light, near-black dark) becomes the default scheme.
- **Which schemes, and how many:** Alex picks from visual mockups at the start of release 2. This is his taste call.

### Release 3: layout templates

- **`plaenicke.layout`**: `'planner'` | `'month'` | `'all'`. Missing or unknown means `'planner'`. Applied as `data-layout` on `<html>` by the pre-paint script. Only has an effect behind the desktop gate.
- **What shows where:** see Goals 1. The mockups Alex approved are in `.superpowers/brainstorm/82814-1795035938/content/desktop-templates.html` (gitignored, local). **They are wireframes, not a visual target.** Every pane reuses an existing view, restyled: the existing Week page (`#week-view`), Month grid, Today sections, To-do and Ideas. No new calendar view is built. The Week pane's week starts on the `weekStart` setting, not on today as the mockup drew it.
- **Side rail (Claude's call, 2026-11-18, made while Alex was away; option a):**
  - Today stays in the left pane in every template.
  - The rail chooses what the big pane shows: Calendar, To-do or Ideas. The template sets only the big pane's first view: Week for `planner`, Month for `month`.
  - In `all`, To-do and Ideas are already on screen, so their rail items highlight their pane and move focus to it.
  - The rail item of the big pane's view carries `aria-current="page"`.
  - On desktop the rail's gear replaces the header gear. Settings still opens as an overlay.
  - Rejected option b, opening To-do or Ideas full width the way the phone does: it hides Today and the calendar, which is the reason the desktop exists.
- **Capture (Claude's call, 2026-11-18, made while Alex was away; option a):**
  - A one-line box at the top of the left pane. Clicking it, typing into it, or pressing its mic opens the **existing** capture panel as an overlay, with date, type chips, preview and Add.
  - The capture controller (`js/capture.js`, `js/viewport.js`) is not reworked. Only how the panel opens changes, and only behind the desktop gate.
  - The floating mic button is hidden behind the gate.
  - Rejected option b, a full in-pane input: it reworks capture code the phone shares, which puts the anti-goal at risk.
- **"Coming up" (Month overview)** reuses Today's existing sections: "Next 7 days" and the 30-day "Coming up" (`today.later` in `js/todayview.js`, built on `upcomingRows` in `js/today.js`). In `month`, the 30-day section opens by default. Nothing new is built for it.
- **Narrow windows:** below the width where three panes fit, `all` renders as `planner`. Below the 46rem gate, everything is the phone layout. The builder states the width and tests it.
- **`showView()` change:** behind the gate, the template decides which views are visible together. Code that assumes "only one view is visible" must keep working. Known cases: `syncTodayTick` (`app.js:1404`, runs only while Today is shown), the visible checks at `app.js:1254` and `app.js:1277`, and `app.js:1066`. **Speculative:** whether those are all of them. The first task of release 3 lists every visibility check in `app.js` before any code changes.

## Left to the builder

- Exact pane widths and the rail's look within the approved mockups.
- How each template behaves between the 46rem gate and a width where three panes no longer fit, for example by falling back from `all` to `planner` below a stated width. State the width and test it.
- How the settings controls are laid out.
- The test plan. It must include a phone-width check proving the phone layout is byte-for-byte unchanged in computed styles for every template and scheme value.

**Known limit (R1):** native `<input type="time">` pickers follow the phone's locale, not this setting. Out of the app's control.
