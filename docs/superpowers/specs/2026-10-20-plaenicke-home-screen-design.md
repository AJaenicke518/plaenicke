# plaenicke — home screen design

**Status:** PROPOSAL — not approved. Sections marked "Decided" are Alex's decisions; sections marked "Claude's call — confirm" are recommendations awaiting his yes/edit. No implementation until he approves the written spec.

Code facts cite file:line on `main` @ 10607b6.

## 0. Scope: three sub-projects

1. **Home screen + bottom tab bar + capture button + the visual foundation it needs.** Designed in full here.
2. **3-day view.** Not designed here. This doc only leaves a slot for it (§ 4).
3. **Visibility controls** (hide a calendar in Settings; per-series "show on calendar" / "show in events list" in the event sheet; per-device). Not designed here. This doc only fixes the seam it plugs into (§ 2.4).

## 1. Intent and success criteria

**Decided (what Alex said):** "calm, uncluttered; refine through use (ship small, iterate)"; in a hurry, open the app, tap the mic, say it (his words as recorded on `capture-placement.html`); classes swamp the events list, so repeating events appear only on their own day.

**Assumed, not said (Claude's call — confirm):** the home screen answers two questions, "what must I do?" and "what's on today?", in that order. That is why to-dos come before events.

**Success criteria (Claude's call — confirm):** on a typical day (2 classes, 1–2 to-dos) Today fits an iPhone screen without scrolling; one tap starts listening and one more adds, with no wait; a weekly class never shows under Next 7 days; no item appears twice; every tap shows feedback on touch-down.

## 2. Home screen (Today tab)

### 2.1 Layout — Decided
Layout A, stacked sections in this order: **Overdue → To do today → Today's events → Next 7 days**. Settings is a gear on Today.

### 2.2 Header — Claude's call — confirm
- "Today", with the date under it, and the gear (the existing `#settings-btn`, `index.html:30`) on the right.
- The `plaenicke` h1 is replaced by each tab's own title. The gear appears only on Today.
- `#sync-indicator` and `#updated-stamp` stay in the app shell on every tab. They are unchanged, including the load-time paint that CLAUDE.md calls load-bearing.

### 2.3 What goes in each section — Claude's call — confirm (the order is Decided)
All of the sections are built by one pure function, `buildToday(ownItems, instances, todayISO, nowMinutes)`, in a new `js/today.js`.

| Section | Own items | Feed instances | Order | Cap |
|---|---|---|---|---|
| Overdue | `isTodo(it) && it.date < today` (`isTodo` already excludes done, `items.js:67`). Shows the age: "2d" in `--danger` | none (feeds have no `type` or `done`, `feeds.js:487-498`) | oldest first | 5, then "+N more" → To-do tab |
| To do today | type ∈ TODO_TYPES (`items.js:62`) and `date === today`. Done ones stay, struck through and greyed, so a tick can be undone | none | `sortItemsByDate`; done last | 8, then "+N more" → To-do tab |
| Today's events | type `event` or `general` and `date === today` | every instance dated today, repeating or not | `sortItemsByDate` (untimed first) | none |
| Next 7 days | not done, scheduled (`isScheduled`, `items.js:58`), date in (today, today+7] | only **one-off** instances (§ 2.4), date in (today, today+7] | grouped by day ("Thu", "Fri"); empty days hidden | 3 per day, then "+N more" → that day in Day view |

- Ideas never appear (`isScheduled`). Own items are single-day.
- **Relative time** only on the next timed event today: "in 42 min" (<60 min), "in 2 h 10 min" (≤12 h), "now" between its start and end. **Past** timed events (end, or start if no end, before now) are greyed. While Today and the page are visible, Today alone re-renders every 60 s; the interval is cleared on hide.
- Row tap → existing item sheet; checkbox → existing `setDone` (`app.js:352`).

**Empty and light days.** A section with no rows is not drawn, including its header. If Overdue, To do today and Today's events are all empty, the screen shows one line: "Nothing due today. Next: Stats quiz · Thu." "Next" is the earliest of two things: the earliest own not-done scheduled item after today, at any distance, and the earliest one-off feed instance within 30 days. If neither exists, it shows "Nothing coming up."

### 2.4 "Repeating", concretely — Claude's call — confirm (the rule itself is Decided)
**Facts:** a ParsedEvent keeps `rrule` (string or `null`) and `recurrenceId` (`ics.js:1009-1012`); emitted instances carry only `{uid, title, date, time, endTime}` (`ics.js:1127`) plus `id, createdAt, feedId, feedColor, external` (`feeds.js:487-498`). Overrides share the master's UID (`ics.js:1293-1296`). **No instance says whether it repeats.**

**Definition.** A series is identified by `(feedId, uid)`. The series repeats if **any** ParsedEvent in that feed's cache with that `uid` has `rrule !== null` or `recurrenceId !== null`.

**New field:** one boolean, `recurring`, set in `instancesForRange` from a per-feed `seriesUids` set built from `entry.events`. `ics.js` is unchanged (avoids churn in `tests/ics.test.js`'s 142 deep-equality asserts). Instances are never stored (`feeds.js:249`) and never pass through `makeItem`: no migration, no whitelist change.

**Known limit (unverified against Alex's real class feed):** a feed that publishes each class meeting as a separate VEVENT, each with its own UID, looks like one-offs and will show in Next 7 days. Sub-project 3's per-series switch is the remedy. Check his feed before building.

**Seam for sub-project 3:** Today's events + Next 7 days are "the events list"; sub-project 3 adds one predicate on `${feedId}:${uid}` in `buildToday`'s instance filter.

### 2.5 The "today" data rule and no-duplicates — Claude's call — confirm
- **Do not build Today from `visibleItems(today, today)` and stop there.** It returns every own item for every date (`app.js:130-134`; code audit § 2). Today calls `visibleItems(today, today+7)` once; `buildToday` separates instances (`external: true`) from own items and date-filters own items itself.
- **Never add `todoItems()` on top.** `visibleItems` already contains the to-dos (research § 3 trap).
- **No duplicates, by construction:**
  - A classifier `sectionOf(item, today)` returns exactly one section, or none, for each own item.
  - Each instance goes to Today's events (when its date is today) or to Next 7 days, never both.
  - A multi-day all-day event emits one instance per day (`ics.js:1131-1134`). Inside Next 7 days, one-off instances are de-duplicated by `${feedId}:${uid}`, so each shows on its first day only, and one already shown today is dropped.
  - A test asserts that every `id` appears at most once in `buildToday`'s output.

## 3. Capture button — the gesture is Decided; the details are Claude's call — confirm

**Decided:** big mic button bottom-right. Tap = start listening, a text box grows out of the button, live words appear; tap again = stop and add. Tap the text box = type instead (listening stops). No double-tap.

**Interaction:**
1. **Tap the mic.** The box opens; a new `voice.js` `listen()` starts recognition with `continuous = true`, `interimResults = true`. The read-only field shows all finals plus the current interim, rebuilt from `e.results` on each `onresult`. The button shows a stop square (no pulsing).
2. **Tap the button while listening.** Take the text currently shown (finals + interim), set `committed`, detach `onresult`/`onend`/`onerror`, call `stop()`, then Add (step 5). **Never wait for a final event** — the spike found none arrives (`textAfterStop=null`) and `onend` may not fire. Empty text: the box stays open with "Didn't catch anything — type it, or tap the mic."
3. **Tap the text box while listening.** Stop as in step 2 without adding; clear `readOnly` and focus the field inside the same tap so iOS raises the keyboard. The text is kept.
4. **Recognition ends on its own.** Text kept, box switches to typing mode: "Stopped listening — tap Add." **Nothing is added without a tap.**
5. **Add** (box's Add button, or step 2) is the existing `handleAdd` (`app.js:249-290`), logic unchanged: chosen date → manual add; else smart add → `decideFlow` → direct `addItems` or `renderPreview`. All paths end in `addItems` (`app.js:207`), so `normalizeIdea` + `makeItem` still apply. Success closes the box; a preview renders inside it and scrolls internally.
6. **×** closes and clears. No backdrop, no tap-outside-to-close.

**Voice unsupported or refused** (each case tells the user; none fails silently):
- No `SpeechRecognition` (`voice.js:7`): the tap opens the box in typing mode and focuses the field. The message reads "Voice isn't available here — type instead."
- `service-not-allowed` (Safari tab, per the spike) or `not-allowed`: same behaviour. The message reads "Voice works in the home-screen app — type instead." For the rest of the session, later taps go straight to typing.
- `no-speech`, `audio-capture`, `network`: the box stays in typing mode with "Didn't catch that — try again or type it."

**Keyboard.** The box is placed by the `followVisualViewport` approach (`itemsheet.js:69-90`). That function moves into a shared `js/viewport.js` and both callers use it. A new module means updating `ASSETS` and bumping `CACHE`.

**The old top add box is removed — Claude's call — confirm.** Two add boxes contradict "calm" and his modified option C (the box comes out of the button). Its ids (`#entry-text`, `#entry-date`, `#entry-time`, `#entry-end`, `#add-btn`, `#message`, `#preview`) **move into the capture box unchanged**, so `els` binding (`app.js:33-41`) and `apply.test.js`'s mount-every-id hold. The date/time row sits behind a small "Date" toggle: it must stay, because it is the offline path smart add's failure message points to (`app.js:266`; wording updated). `#mic-btn` and `dictate()` are retired. **Cost:** typing without voice is two taps (question 1).

The capture button shows on every tab. It is hidden while Settings or the item sheet is open. The Ideas tab keeps its own offline box (`index.html:113-117`).

## 4. Tab bar and navigation

**Decided:** tabs Today | Calendar | To-do | Ideas. Calendar has a Day / 3-day / Week / Month switcher. Tapping a day opens it.

**Claude's call — confirm:**
- The List view is retired. Today plus Calendar replace it, and retiring it removes the 367-day expansion (code audit § 3).
- **Calendar** opens on its last-used sub-view, kept in memory, Day by default.
  - The existing arrows and `openDay` (`app.js:846`) work as they do now. Tapping a Month cell or Week column opens Day.
  - **The 3-day segment is not shown until sub-project 2 ships** (no dead buttons). The switcher is built as a 4-slot segmented control, so adding it changes no layout.
- Tapping Today while already on Today scrolls to the top instantly.
- - **Geometry:** bar fixed at the bottom, 56 px + `padding-bottom: env(safe-area-inset-bottom)` (`viewport-fit=cover` already set, `index.html:5`). Body bottom padding becomes `56px + 72px + inset`. The toast moves from `bottom: 16px + inset` (`styles.css:606`, over the bar) to `56px + 12px + inset` with `right: 88px` to clear the capture button (56 px round, `right: 16px`, `bottom: 56px + 16px + inset`).
- **Layers:** content 0 < tab bar 5 < capture button 6 < capture box 8 < settings backdrop 10 < item sheet 15 < toast 20. The existing 10/15/20 are unchanged (`styles.css:351,614,625`).

## 5. Visual foundation — Claude's call — confirm

**Kept:** the cream, paper and leather tokens and the dark theme (`styles.css:2-72`). The `--feed-palette-N` names are not renamed, because stored colours reference them (`palette.js:13-16`). Every new token is defined in both themes and checked in both on the device.

**Tokens** (from research § 3 Phase 3):
- **Type:** 4 sizes (today 11): 13 px labels/times (labels uppercase, +0.06em, `--muted`), 16 px rows and **every input**, 20 px tab titles, 28 px the Today heading. Georgia for titles; `system-ui` with tabular numerals for times, labels, buttons.
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32.
- **Radii:** 8 (controls), 14 (capture box, sheets), 50% (capture button).
- **One accent,** `--accent` (leather). It is used only for today/now, the active tab, the capture button and the next event's relative time. `--danger` is used only for the overdue age.

**Rows, not cards.** Today's rows are full-width with a 1 px `--line` hairline between them and a minimum height of 44 px. Shadows appear only on floating layers (the capture box, sheets, the toast).

**Press state on touch-down:** one delegated `pointerdown` listener adds `.pressed` to the nearest `button, [data-press]`; `pointerup`/`pointercancel`/`pointerleave` remove it. Rows get `--chip-bg`, buttons opacity 0.7, the capture button `scale(.94)`. `touch-action: manipulation` on `html`; `-webkit-tap-highlight-color: transparent`. A class, not `:active`: iOS `:active` needs touch listeners and can stick during a scroll (WebKit 255277, 221366).

**Motion:** 200 ms ease-out default, 250 ms for the capture box; only `transform`/`opacity`. **Nothing animates** on ticks, tab switches, adds, calendar arrows or re-renders. Under `prefers-reduced-motion: reduce` movement is instant and the box only fades.

**Box growing from the button.**
A CSS transform: `transform-origin` at the button's corner, scale from 0.2 plus opacity, same path back on close. **This departs from View Transitions on purpose:** `startViewTransition` runs its update asynchronously, and a `focus()` outside the tap may stop iOS raising the keyboard (step 3 and the unsupported case both focus) — **speculative**, untested. A transform explains the same motion without that risk. View Transitions stay available later, feature-detected, for the item sheet.

**No haptics.** Safari has no Vibration API; the iOS 18 `<input switch>` trick is undocumented and its status on newer iOS is unclear (smooth-feel research). Feedback that only sometimes fires is worse than none.

## 6. Performance: render only the visible view — Claude's call — confirm

**Now:** `render()` (`app.js:816-819`) rebuilds all six views, including List's 367-day feed expansion. It is called from 16 sites, including every tab switch, resume, sync settle and storage event. Whether this is slow on the phone is **not measured**.

**Change:** `render()` still runs `refreshForToday()` first, then renders only the active view (Today, the active Calendar sub-view, To-do or Ideas). `showView` already renders after switching (`app.js:837`), so a view is fresh when it appears. Today expands feeds over 8 days (30 only for the empty-day "Next"). No memo cache until a measurement asks for one.

**Risk:** anything that reads a **hidden** view's DOM after a change sees stale content. Some `tests/apply.test.js` assertions likely do (**unverified count**); they switch to the view first — a test change, not a behaviour change. Day's auto-scroll (`dayview.js:116`) cannot act while hidden today either; verify on device.

This ships as its own stage so a regression is attributable.

## 7. Errors, and what must not change — Claude's call — confirm

- **Feed URLs are never rendered or logged.** Today rows and the sheet get the calendar name only (`app.js:536-554`).
- **Sync is untouched:** `sync.js`, `merge.js`, `schemaVersion`, the ownership rules, and the visibility gate.
- **Calendar visibility writes (sub-project 3, or any chip):** they go through a `feeds.js` writer that re-reads `loadFeeds()` immediately before saving, as `settings.js:219-225` does. They never save app.js's snapshot (research § 3 trap: a stale snapshot can tombstone a feed and lose its URL for good).
- **No new item fields.** If one appears, it goes in `makeItem`'s 13-key whitelist (`items.js:28-45`).
- **Service worker:** the new modules (`today.js`, `viewport.js`, `tabs.js` if split out) go into `ASSETS`. `CACHE` is bumped. `serviceworker.test.js` gets a re-pin, including the stale `CACHE_ON_MAIN` (code audit § 6).
- **Smart add can hang on "Thinking…".** `smartadd.js` has no timeout (`smartadd.js:17`). Branch `punchlist-fixes-3` adds one. Stage 4 depends on it landing first.
- **The type list is not touched.**

## 8. Testing — Claude's call — confirm

TDD per the existing harness: `npm test`; never `node --test tests/`.

- `tests/today.test.js` (pure): overdue boundaries (yesterday / today / done), done-today kept, ideas excluded, recurring hidden from Next 7 days but shown today, override counts as recurring, multi-day one-off shown once, caps, empty-day "Next", and **every id at most once** — mutation-checked.
- `tests/feeds.test.js`: `recurring` from RRULE, from RECURRENCE-ID only, absent; update the shape asserts at `feeds.test.js:477-541`.
- `tests/voice.test.js` (fake `SpeechRecognition`): stop commits shown text with no final event; a late `onresult` is ignored; an unprompted `onend` adds nothing; `service-not-allowed` and unsupported open typing mode with the message.
- `tests/apply.test.js` (fake DOM, mount new ids): only the active view renders; tab switching; capture → `handleAdd` paths; moved ids not duplicated.
- `tests/styles.test.js`: 16 px inputs everywhere, toast above the bar, z-index order, reduced-motion rule, `touch-action`.

**On-device checklist for Alex** (iPhone home-screen app): a typical day fits without scrolling; mic → live words → stop adds at once; tap the box while listening → keyboard, words kept; box above the keyboard with Add reachable; a Safari tab shows the typing message; toast clears bar and button; bar clears the home indicator; press feedback instant and not stuck after scrolling; dark mode; classes absent from Next 7 days (checks § 2.4's assumption).

## 9. Build stages — Claude's call — confirm

Each stage ships on its own. Merging to `main` is the deploy.

1. **Render only the visible view.** No visual change; perf groundwork; isolated risk.
2. **Visual foundation:** tokens, press state, 16 px inputs, motion rules. Applied to the existing screens.
3. **Today tab + tab bar + Calendar switcher (Day/Week/Month)**, the `recurring` field, and List retired. Toast and body padding are re-placed. The old top add box stays during this stage.
4. **Capture button and box.** The top box's ids move in, `listen()`, and `viewport.js`. Needs the smart-add timeout first.
5. Then sub-project 2 (3-day view), then sub-project 3 (visibility controls), each with its own spec.

## 10. Open questions for Alex (taste calls)

1. **Remove the old add box at the top?** Typing would become "tap the mic button, tap the box". *Recommend yes:* one place to add.
2. **Ticking a to-do on Today:** stays struck through until tomorrow (so you can untick), or disappears at once? *Recommend: stays struck through* (overdue ones disappear, because they are no longer overdue).
3. **Next 7 days:** at most 3 items per day before "+N more"? *Recommend 3.*
4. **Retire the List view?** Today and Calendar cover it. *Recommend yes.*
5. **Show "3-day" in the switcher, greyed, before it exists?** *Recommend: hide it until it works.*
6. **"In 42 min":** only on the next event, and only up to 12 hours ahead? *Recommend yes.*
