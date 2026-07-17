# plaenicke — V1 Design Spec

**Date:** 2026-07-17
**Author:** Alexander Jaenicke (with Claude)
**Status:** Approved for planning

---

## Context & goal

Alex is a **total beginner** to coding and wants to learn how apps work by building a
personal organizational app for their **iPhone**. The long-term vision includes notes,
notifications, a planner, synced calendars, Brightspace assignment tracking, and a Claude
project tracker. That full vision is **six features of widely varying difficulty**, so it is
being built **one small piece at a time**, starting with the smallest genuinely-useful core.

The guiding principle: **ship a tiny working thing on the real phone first, then grow it.**
Momentum from a working app is what keeps a beginner going.

## Chosen platform path

A **home-screen web app (PWA)**, not a native Swift app.

Reasoning: native iOS (Swift + Xcode) means learning a new language *and* a complex tool at
once, plus a $99/yr Apple Developer account to keep a personal app installed. A web app runs
on the iPhone today with no fees, has the gentlest learning curve, and still teaches the real
fundamentals of how apps work. Native remains an option later once the concepts click.

## V1 scope — "What's coming up"

A personal reminders list + basic calendar.

**In scope:**
- **Add an item** with a **title + date**, via three input methods:
  1. Type the title and pick/enter a date.
  2. Dictate the title using the iPhone keyboard's built-in mic (free, no code).
  3. **"Smart add":** type or dictate a whole sentence (e.g. *"physics assignment due July
     second"*) and the app extracts the title (`physics assignment`) and date (`July 2`)
     automatically.
- **View items** two ways:
  - A **list**, sorted soonest-first.
  - A **basic month calendar** with items shown on their day.
- **Delete** an item.
- **Persistence:** items are saved in the phone's browser storage and survive reload/reopen.
- **Installable:** can be added to the iPhone home screen with an icon and full-screen launch.

**Explicitly OUT of V1 (deferred, in this order):**
1. Claude-powered smart add (needs a paid API key + a small server to hold it safely).
2. Real phone notifications / reminders that fire when the app is closed.
3. Syncing Google / Apple calendars.
4. Brightspace assignment watching (speculative — depends on the school's Brightspace
   allowing automated reads; may not be possible).
5. Claude project tracker.

## Architecture

Plain **HTML + CSS + JavaScript**. **No frameworks, no build tools.** Just readable files.

### Components (each with one clear job)

| File | Responsibility |
|------|----------------|
| `index.html` | Page structure: the add box, the list view, the calendar view, view toggle. |
| `styles.css` | All visual styling; mobile-first, sized for a phone screen. |
| `app.js` | App glue: wires up buttons, reads/writes storage, decides what to render. |
| `storage.js` | Load/save the list of items to browser storage. The *only* file that touches storage. |
| `smartadd.js` | Turns a typed/dictated sentence into `{ title, date }`. **The single spot** Claude replaces later. Uses a vendored, offline date-reading helper. |
| `calendar.js` | Draws the month grid and places items on their day. |
| `manifest.json` + icon | Makes the app installable (name, icon, full-screen launch). |
| `service-worker.js` | Minimal worker so the app installs and opens offline. |

### Data model

An item is a small object:

```js
{
  id: "unique-string",     // generated when created
  title: "Bio midterm",    // text
  date: "2026-07-02",      // ISO date string (YYYY-MM-DD)
  createdAt: "2026-07-17"  // ISO date string
}
```

The whole app state is just an **array of these items**, saved as JSON in browser storage
under one key.

### Data flow

1. User enters text (typed, dictated, or a full sentence).
2. If it's a sentence, `smartadd.js` extracts `{ title, date }`.
3. `app.js` creates the item object and asks `storage.js` to save it.
4. `app.js` re-renders the active view (list via `app.js`, calendar via `calendar.js`) from
   the saved array.
5. Delete removes the item from the array and saves again.

### Error handling (beginner-appropriate, but real)

- **Unparseable smart-add sentence** (no date found): do **not** silently guess. Tell the user
  "I couldn't find a date in that — please pick one," and let them set the date manually. No
  silent fallback to today's date.
- **Empty title:** refuse to add; prompt for a title.
- **Storage read returns nothing / corrupt:** start with an empty list rather than crashing,
  and surface a small notice if saved data couldn't be read.

## Running it & getting it on the iPhone

- **During development:** preview in Safari on the Mac (via a simple local server) for instant
  feedback.
- **Onto the phone:** deploy the static files to a **free static host** (e.g. Cloudflare Pages
  / Netlify / GitHub Pages) to get an HTTPS link, open it in iPhone Safari, and
  **Share → Add to Home Screen**. HTTPS is required for install; free hosting provides it.

## Testing approach

Manual, checklist-driven, verified by eye on each feature — appropriate for a first project:

- Add an item → it appears in the list.
- Reload the page → the item is still there.
- Smart-add "physics assignment due July second" → title = "physics assignment", date = July 2.
- Smart-add a sentence with no date → app asks for a date instead of guessing.
- The item shows on the correct calendar day.
- Delete an item → it disappears from both list and calendar, and stays gone after reload.
- Add to Home Screen → launches full-screen with the icon.

## Roadmap after V1

1. Claude-powered smart add (Anthropic API key + small "middleman" server to hold it safely).
2. Real phone notifications.
3. Sync Google / Apple calendars.
4. Brightspace assignment watching (speculative; test feasibility first).
5. Claude project tracker.
