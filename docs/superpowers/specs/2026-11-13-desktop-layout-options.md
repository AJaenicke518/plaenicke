# Desktop layout — options (2026-11-13)

Status: **options for Alex** — the choice is a taste call. No code written. Alex's note (2026-11-11): on the computer the app "uses the phone UI and looks spaceless and bland".

## What the desktop view does today (measured)

Measured with Chrome DevTools on this branch served locally, at 1280×800 and 1440×900, with 10 sample items:

- **There are no width breakpoints at all.** The only `@media` rules in the loaded CSS are `prefers-reduced-motion` (3 rules). So the desktop layout *is* the phone layout, stretched.
- **Every view spans the full window** minus a 16 px gutter: `#today-view` is 1248 px wide at a 1280 px window; no element has a `max-width`.
- **Rows stretch edge to edge.** On Today, a title sits at the left edge and its time at the right edge, ~1,200 px apart, so the eye has to cross the whole screen to pair them. This is most of the "spaceless" impression: not too little space, but space with no structure.
- **The tab bar is phone-shaped:** 4 tabs spread across the full 1280–1440 px bottom bar; the Calendar's Day / 3-day / Week / Month switch is 4 buttons each ~340 px wide.
- **Day view's grid is one column ~1,300 px wide** with 70 px-tall hours; a single event becomes a bar across the whole screen.
- The mic button floats bottom-right, far from the content it adds to.

Body text is 16 px; the type is fine. The problem is width and arrangement, not size.

## Options

### A — Centred column (smallest)
One `@media (min-width: 900px)` block: views, header and the capture box get `max-width: ~44rem; margin-inline: auto`; the tab bar's buttons sit in the same centred width; the Calendar switch becomes a compact segmented control. Week and Month keep the full width (they need it).
- Fixes title↔time distance and the stretched controls.
- Phone layout untouched (the media query never matches a phone).
- Still a phone app in the middle of a big screen: empty margins either side.
- Size: CSS only, a few dozen lines; existing layout tests unaffected. **concrete.**

### B — Two panes (recommended if Alex wants a real desktop layout)
At ≥ 1024 px: left pane (~26rem) shows **Today** (with To-do below it); right pane shows the **Calendar**, defaulting to Week. The bottom tab bar becomes a slim left rail (Today/To-do/Ideas/Calendar icons + Settings). The capture box docks at the top of the left pane instead of a floating button.
- Uses the width for what a laptop is good at: seeing the week while working through today.
- Every view already exists as a self-contained `<section>`; this is arrangement plus routing (which views show together), not new views.
- Needs care with code that assumes one visible view at a time (`syncTodayTick` runs only while Today is shown; view switches in `app.js`). **speculative** how much: the first task would list every "is this view visible" check.
- Size: a CSS grid at the breakpoint plus a view-visibility change in `app.js`; new layout tests at two widths.

### C — Dashboard (largest)
Three columns: Today | Week | To-do + Ideas, all live at once, with a top bar instead of tabs. Most "app-like" on a 1440 px screen, but every view renders at once (render cost: `expandEvents` is already ~85% of render time at 4× CPU throttle, punchlist "render cost"), and it diverges furthest from the phone UI Alex designed.

## Recommendation
Ship **A** first: it is small, removes the stretched rows that cause most of the "spaceless" look, and cannot affect the phone. Then decide on **B** after using A for a few days — B is the real desktop design, and whether it is worth it depends on how much Alex uses the laptop (the launch log in Settings shows that). C is not recommended: the cost lands on render speed, which is already the app's weakest spot.

Not decided here (taste): exact column width, whether the left rail shows labels, and whether the desktop gets a lighter background panel to separate panes.
