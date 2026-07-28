# plaenicke V3 — Time-of-Day + UI Rehaul — Design

Date: 2026-07-28
Status: approved (brainstormed with Alex; visual direction picked from browser mockups)

## Goal

One combined V3 with two halves:

1. **Time-of-day**: items can carry a time (and optionally an end time); new Week and Day views show the shape of a week and an hour-grid day.
2. **UI rehaul**: the whole app moves to a "paper planner" look with a neutral-dark mode, selectable in a new settings menu.

Approach: retheme + new view modules (approach 1 from brainstorm). Existing structure and logic modules stay; new pure-logic modules follow the V1/V2 pattern (logic TDD'd, rendering thin). The working app never breaks mid-build.

## Decisions made in brainstorm

- One combined project, not two sub-projects.
- Time model: optional `time` + optional `endTime`. No time = "untimed" (not called "all-day").
- Views: **List | Month | Week | Day**. Day + full 7-column week (no 3-day view, no sideways scrolling).
- Week view is NOT an hour grid: 7 squeezed columns of stacked colored blocks (color = type), no titles, no time axis. Tap a day → Day view.
- Month view bug fix (from Alex): cells are fixed-height; busy days show ≤2 chips + "+N more". Tap a day → Day view.
- Day view: hour grid with timed items; **untimed items in an "Other tasks" list at the bottom** (not an all-day banner at top — keeps the grid uncluttered).
- Visual direction: **paper planner** (warm cream, serif, stationery feel) with **neutral dark** ("quiet night" — cool near-black, same serif character) as the dark variant.
- Settings menu (⚙ in header): Appearance Light/Dark/Auto; "Linked calendars" greyed-out placeholder for a future version (no integration in V3).

## Data model (`js/items.js`)

```
{ id, title, date: "YYYY-MM-DD",
  time: "HH:MM" | null,       // 24h; null = untimed
  endTime: "HH:MM" | null,    // only valid when time is set
  createdAt, type, project, subject, category }
```

- `endTime` without `time` → `makeItem` throws. `endTime` must be strictly after `time` (same day; no overnight spans in V3).
- Missing fields on existing localStorage items read as undefined → untimed. **No migration needed.**
- Sort within a date: untimed items first, then timed by time; ties fall back to existing createdAt/title rules.

## Views & navigation

View toggle: **List | Month | Week | Day** (one visible at a time).

### Month (fixed)
- Fixed-height cells. Up to 2 item chips, then a "+N more" line. Rows stay uniform — fixes the current stretching bug.
- Tap a day cell → Day view for that date.

### Week (new)
- 7 equal columns Sun–Sat, always all visible, no horizontal scroll, no hour axis.
- Per column: weekday + date number header (today highlighted), then stacked small colored blocks — one per item, color = type, no titles. Timed and untimed items both appear as blocks.
- Tap a column → Day view for that date. Prev/next arrows step one week.

### Day (new)
- Vertical hour grid; ~07:00–23:00 visible initially, scrollable across the full 24h.
- Timed item with `endTime` → block spanning start→end. Timed item without `endTime` → chip pinned at its start hour.
- Overlap: overlapping items share the width side-by-side (n overlapping → 1/n width each; simple slicing, no packing algorithm).
- Bottom section **"Other tasks"**: the day's untimed items as a plain list.
- Prev/next arrows step one day; header like "Wed, Aug 5".
- Items with visible titles (list, day) can be deleted, as today.

### Logic modules
- `js/calendar.js` keeps `buildMonthGrid` / `groupItemsByDate`; gains month-cell overflow counting if needed.
- New pure `js/timegrid.js`: block position/height from time, overlap column assignment, timed/untimed bucketing. TDD'd.
- Rendering for day/week lives in small render modules so `js/app.js` stays thin.

## Smart add & manual add

### Worker (`worker/src/prompt.js` + `worker/src/normalize.js`)
- Schema gains `time` and `endTime` (nullable `"HH:MM"` strings) per item.
- Prompt additions: extract a time when the note states one ("dentist at 2pm" → `14:00`); extract an end when stated or clearly implied ("2 to 3pm", "meeting 9–10:30"); never invent times — nothing stated → null; "due at midnight" → `23:59`.
- Normalizer validates: `HH:MM` shape, end after start, anything invalid → null (never reject the whole item for a bad time).

### Manual add
- Optional time input next to the date; an end-time input appears once a start time is set. Empty = untimed. Behavior otherwise identical to today.
- Preview/confirm rows (`js/preview.js`) show and allow editing the time fields.

## Theme, settings & rehaul

### Tokens
- `styles.css` rebuilt on CSS variables under `:root` (light) and `[data-theme="dark"]`.
- **Light (paper planner)**: warm cream bg (`#f4f1ea` family), off-white paper cards, warm borders, Georgia/serif headings, italic wordmark; type colors tuned warm (due = brick red, start = slate blue, milestone = ochre, event = moss green, general = warm gray).
- **Dark (neutral dark)**: cool near-black bg (`#14161a` family), slate cards (`#1e2126`), same serif character, brighter type accents.
- All views use tokens only → both themes work everywhere automatically.

### Settings
- ⚙ button in header opens an overlay panel (not a separate page).
- **Appearance**: Light / Dark / Auto. Auto follows `prefers-color-scheme`. Persisted in localStorage; a tiny inline script in `index.html` applies the choice before first paint (no flash).
- **Linked calendars**: greyed-out row, "Coming in a future version". Placeholder only.

### Rehaul reach
- Every existing surface restyled: header, add box, message line, preview card, list items (now with a time line like "2:00–3:00 PM" when timed), month grid, view toggle, mic button.
- `manifest.json` `theme_color` / `background_color` updated to the cream. Icons untouched.

## Testing

- TDD for pure logic: `timegrid.js` geometry/overlap/bucketing, `items.js` time validation + sort, month overflow counting, worker normalizer time-field validation.
- Rendering/theming: `node --check` + live click-through (as V1/V2).
- Worker prompt verified with real calls: "dentist at 2" (time, no end), "meeting 9 to 10:30" (time + end), "essay due friday" (no time → null).

## Out of scope (V3)

- Real calendar linking/integration (placeholder row only).
- Overnight time spans, recurring items, reminders/notifications.
- 3-day view; horizontal scrolling anywhere.
- Icon redesign.
- Migration tooling (not needed — old items read as untimed).
