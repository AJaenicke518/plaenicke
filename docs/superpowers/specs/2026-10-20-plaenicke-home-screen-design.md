# plaenicke — home screen design

**Status:** APPROVED by Alex, 2026-10-21. Implementation plan for stages 1–2: `docs/superpowers/plans/2026-10-21-plaenicke-home-stage1-2.md`.

Sections marked "Decided" are Alex's decisions; sections marked "Claude's call — confirm" are recommendations awaiting his yes/edit. His 2026-10-21 answers are listed in § 9 and applied throughout.

Code facts cite file:line on `main` @ 8b4e819 (f2ff20d plus the voice-spike commits, which add only `voice-test.html`). Revised after a devil's-advocate review; updated 2026-10-21 with Alex's answers to the nine open questions.

## 0. Scope: three sub-projects

1. **Home screen, tab bar, capture button, visual foundation.** Designed here.
2. **3-day view.** § 4 leaves a slot.
3. **Visibility controls** (hide a calendar; per-series switches; per-device). § 2.4 fixes its seam and that seam's limit.

## 1. Intent and success criteria

**Decided (what Alex said):** "calm, uncluttered; refine through use (ship small, iterate)"; in a hurry, open the app, tap the mic, say it (as recorded on `capture-placement.html`); and, on his classes: "i see every single one of my classes for the next 3 months and it overwhelms my list of events" (punchlist, 2026-10-19). Hence: repeating events appear only on their own day.

**Success criteria (Claude's call — confirm):** on a typical day (2 classes, 1–2 to-dos) Today fits an iPhone screen without scrolling; one tap starts listening and one more adds, with no wait; a weekly class never shows under Next 7 days (for an RRULE feed by the rule; for a Canvas-shaped feed only as far as the § 2.4 heuristic detects it); no item appears twice; every tap shows feedback on touch-down.

## 2. Home screen (Today tab)

### 2.1 Layout — Decided
Layout A, stacked: **Overdue → To do today → Today's events → Next 7 days**. Settings is a gear on Today.

### 2.2 Header — Claude's call — confirm
"Today" with the date under it, and the gear (`#settings-btn`, `index.html:31`) on the right, on Today only. The `plaenicke` h1 is replaced by each tab's title. `#sync-indicator` and `#updated-stamp` stay in the shell, unchanged (including the load-bearing load-time paint).

### 2.3 What goes in each section — Claude's call — confirm (the order, no caps, overdue and done-stays are Decided)
One pure function in a new `js/today.js` builds every section, called as `buildToday(liveItems(), instancesForRange(feeds, feedCache, today, today+7, deviceTz), todayISO, nowMinutes)`. Not from `visibleItems` (`app.js:130-134`, every own item for every date), and no `todoItems()` on top (already in `liveItems()`).

| Section | Own items | Feed instances | Order |
|---|---|---|---|
| Overdue | `isTodo(it) && it.date < today` — type `due`, `milestone`, `task` or `start`, not done (`isTodo`, `items.js:62-67`); age "2d" in red or orange (below) | none (no `type`/`done`, `feeds.js:487-498`) | oldest first |
| To do today | type in TODO_TYPES (`items.js:62`), date today; ticked ones stay struck through until tomorrow so a tick can be undone (Decided, question 2) | none | `sortItemsByDate`; done last |
| Today's events | type `event`/`general`, date today | every instance dated today | `sortItemsByDate` (untimed first) |
| Next 7 days | not done, `isScheduled` (`items.js:58`), date in (today, today+7] | **one-off** instances only (§ 2.4) | by day ("Thu"); empty days hidden |

- **No caps and no "+N more", in any section** (Decided, question 3: "just show every one if i dont like it then we can change it to the +N version."). This replaces the earlier caps (Overdue 5, To do today 8, Next 7 days 3 per day). If Alex dislikes the uncapped lists, the "+N more" version is the fallback.
- **Overdue — Decided (question 9):** "just say everything is past due i want to feel like i am behind so i cant procrastinate." Every to-do type whose date has passed counts, `start` included, with no age limit. **Included:** own items of type `due`, `milestone`, `task`, `start` that are not done. **Never included:** ideas, done items, own `event`/`general` items, and feed instances (none has a deadline meaning). **Colour:** past a deadline (`due`, `milestone`, `task`) the age shows in red, `--danger`; past a start date (`start`) it shows in orange, a new token `--overdue-start` (Claude's call — confirm: `#9c5418` light, `#e39a52` dark; computed WCAG contrast 5.04 on `--bg` and 5.59 on `--card` light, 7.77 and 6.93 dark — contrast and red/orange distinguishability must still be checked on the phone in both modes). ~~A ticked overdue item leaves Overdue, since it is no longer overdue.~~ **Amended 2026-10-22 (Alex: "it should stay struck through until tomorrow"):** a ticked overdue item stays in Overdue, struck through, below the undone ones, until tomorrow, so the tick can be undone on Today. Read as: done, and `updatedAt` on today's local date (no field records when an item was ticked, and § 6 allows no new one). Any later write to a done overdue item shows it struck for the rest of that day; an undone item is never hidden. The "Never included: … done items" above means done items not ticked today.
- Ideas never appear. Own items are single-day.
- **Relative time "in N" (time until it starts) only on the next event** (Decided, question 6): the next timed event today shows "in 42 min" (<60 min), "in 2 h 10 min" (≤12 h), "now" during it, beside its time. Every other event shows its date and time only. Past timed events are greyed at render time.
- **The 60 s tick updates only the relative-time text node** and never rebuilds the list. It runs while Today and the page are visible. Greying and "which event is next" refresh on the next ordinary render (resume, add, sync).
- Row tap → item sheet; checkbox → `setDone` (`app.js:352`).

**Empty days.** A section with no rows is not drawn. If the first three are all empty, one line: "Nothing due today. Next: Stats quiz · Thu." — the earlier of the next own not-done scheduled item (any distance) and the next one-off feed instance within 30 days (a 30-day `instancesForRange` call made only then). Else "Nothing coming up."

**No duplicates, by construction.** `sectionOf(item, today)` gives each own item one section or none. A multi-day all-day event emits one instance per day (`ics.js:1131-1134`); Next 7 days de-duplicates one-offs by `${feedId}:${uid}` (first day only; dropped if shown today). A test asserts every `id` appears at most once.

### 2.4 "Repeating", concretely — Claude's call — confirm (the rule, the yearly/monthly answer and the Canvas heuristic are Decided)
**Facts.** A ParsedEvent keeps `rrule` and `recurrenceId` (`ics.js:1009-1012`); instances carry only `{uid, title, date, time, endTime}` (`ics.js:1128`) plus feed fields, so none says whether it repeats. Overrides share the master's UID (`ics.js:1293-1296`).

**Definition.** A series is `(feedId, uid)`. It repeats if an event with that `uid` in that feed's cache has an `rrule` with `FREQ=DAILY` or `FREQ=WEEKLY`. Only these count (Decided, question 7): `FREQ=YEARLY` and `FREQ=MONTHLY` series behave as one-offs and stay in Next 7 days. Its overrides belong to it. An override whose master is missing from the feed (expanded alone, `ics.js:1293-1296`) has no `FREQ` and counts as a one-off.

**New fields:** a boolean `recurring`, set in `instancesForRange` (`feeds.js:464`) from a per-feed set of repeating series, and a boolean `guessedSeries`, true only when that series came from the heuristic below. `ics.js` is unchanged (spares `tests/ics.test.js`'s 142 deep-equality asserts). The cache keeps parsed events (`parseICS`, `feeds.js:249`); instances are built on demand, never stored, never pass through `makeItem`: no migration.

**The rule cannot see a Canvas-shaped feed.** Canvas expands each series server-side into separate VEVENTs, each with its own UID, and never emits RRULE (`docs/superpowers/reviews/2026-07-28-v4-provider-format-notes.md`: "No RRULE, ever"). Every meeting then looks like a one-off and fills Next 7 days — the exact complaint.

**Heuristic for Canvas-shaped feeds — Decided (question 8):** "yeah the app can use its discretion for determining if it is a series." This is Alex's explicit approval of a guessing fallback, which is what lets it stand under the project's zero-fallback rule. Details (Claude's call — confirm):
- **Applies only to a feed with no RRULE at all** in its cache. A feed with any RRULE uses the rule only; its RRULE-less events stay one-offs, never guessed.
- **Guess:** events with the same title, weekday and start time on 3 or more distinct weeks form one series, keyed `(feedId, title, weekday, time)`, and count as repeating (weekly). It can be wrong both ways.
- **A guessed series is labelled** so a wrong grouping is visible: its rows under Today's events and its item sheet read "Repeats weekly (guessed)". A rule-detected series carries no such label.

**Alex's class feed is likely Google-shaped — likely, unverified.** "LMU Classes" is a Google calendar where he created six recurring courses (punchlist, 2026-08-28); Google's ICS normally carries a recurring event as one VEVENT with an RRULE. Nobody has read his feed.

**Precondition for stage 3a: classify his real feed.** Stage 1 adds a read-only line to each Settings feed row — "142 events: 6 repeat (RRULE), 136 single" for a rule feed, or "136 events: no RRULE — 118 in 6 guessed series, 18 single" for a heuristic feed — from a pure, tested `feedShape(entry.events)` over the cache (no network, no URL). The line states which of rule and heuristic that feed uses. Alex reads it for LMU Classes and reports. 3a starts after that, building the rule and, if any of his feeds is Canvas-shaped, the heuristic.

**Seam for sub-project 3, and its limit.** Today's events + Next 7 days are "the events list"; sub-project 3 adds one predicate to `buildToday`'s instance filter. A switch keyed on `${feedId}:${uid}` hides a Google or iCloud series whole, but **cannot hide a Canvas-shaped class** by UID: each meeting has its own UID, so it hides one meeting. That spec must pick another key for such feeds (the heuristic's `(feedId, title, weekday, time)` is one candidate), or rely on whole-calendar hide.

## 3. Capture button — the gesture is Decided; the details are Claude's call — confirm

**Decided:** big mic button bottom-right. Tap = start listening, a text box grows out of the button, live words appear; tap again = stop and add. Tap the text box = type instead (listening stops). No double-tap.

**The top add box stays — Decided (question 1):** "yeah lets try"; refine through use. The round button bottom-right is voice-first. The top box (`#entry-text`, date/time row, `#add-btn`, `#preview`) stays as it is: typing there never starts the mic, and its date row stays the offline path smart add's failure message points to (`app.js:267`). Its small `#mic-btn` and `dictate()` retire in stage 4, leaving one mic.

**Two message lines.** `#message` stays in the shell's top box. It carries messages unrelated to capture: Ideas ("Kept."), a failed tick, a failed delete commit, other-device notices, Undo refused, "can't be edited here" (`app.js:322, 465-639`). The capture box gets its **own** `#capture-message` (`role="status"`) and `#capture-preview`. `handleAdd` (`app.js:249-290`) keeps its logic but takes a target `{field, dateInputs | null, say, previewEl}`; each box passes its own. The capture box has no date row, so its failure text reads "Smart add is unavailable — use the box at the top with a date to add it."

**The field is a new textarea that grows.**

**Interaction:**
1. **Tap the round button (box closed).** The box opens. `voice.js`'s new `listen()` creates a **new `SpeechRecognition` per listen** (`continuous`, `interimResults`). At start the field's text is snapshotted as a **prefix**; each `onresult` shows prefix + all finals + current interim, rebuilt from `e.results`. The button shows a stop square (no pulsing).
2. **Tap it while listening.** **Stop-and-detach:** take the text shown, set `committed`, detach `onresult`/`onend`/`onerror`, call `stop()`, then `abort()`. Then Add (step 6). **Never wait for a final event** — the spike found none arrives (`textAfterStop=null`) and `onend` may not fire. Empty text: "Didn't catch anything — type it, or tap the mic."
3. **Tap the text box while listening.** Stop-and-detach without adding; clear `readOnly` and focus inside the same tap so iOS raises the keyboard. Text kept.
4. **Stop and keep, no tap needed:** on `visibilitychange` → hidden, on opening an item sheet, on opening Settings. Nothing is added.
5. **Recognition ends on its own.** Text kept; typing mode; "Stopped listening — tap Add." **Nothing is added without a tap.** In typing mode the round button shows the mic; tapping it listens again and appends (step 1's prefix).
6. **Add** (the round button while listening, or the box's Add). **Every Add path runs stop-and-detach first**, then sets an `adding` latch. While set, the round button and Add are disabled, the message reads "Thinking…", and **Cancel** replaces Add. The latch clears when `handleAdd` settles (added, failed, or preview shown). Success closes the box; a preview renders in `#capture-preview` and scrolls inside the box.
7. **Cancel during "Thinking…"** (deferred here from the smart-add timeout work). Clears the latch, keeps the text: "Cancelled — nothing was added." The late reply is discarded by the supersede guard on `punchlist-fixes-3` (0131165). The request is not aborted, so it may still spend credit; aborting it is a Later item.
8. **A new capture closes any open preview.** A listen or an Add from either box closes an open preview in **both** containers ("Preview closed — nothing was added from it"). A preview's confirm also checks its request is still the newest and refuses otherwise. So while a preview is open the round button stays enabled: a tap closes the preview and listens. A stale preview cannot be confirmed after a newer request.
9. **×** closes and clears (stop-and-detach first). No backdrop, no tap-outside-to-close.

**Voice unsupported or refused** (each case tells the user):
- No `SpeechRecognition` (`voice.js:7`): known inside the tap, so typing mode opens with the field focused. "Voice isn't available here — type instead."
- Refusals (`service-not-allowed`, `not-allowed`) arrive **asynchronously**, after the tap. **No auto-focus:** the message carries a "Type instead" button that focuses the field within its own tap. `navigator.standalone` picks the wording — Safari tab: "Voice works in the home-screen app."; home-screen app: "Microphone permission is off — Settings → plaenicke." Later taps that session go straight to typing.
- `no-speech`, `audio-capture`, `network`: typing mode, "Didn't catch that — try again or type it."

**Keyboard and placement.** `followVisualViewport` (`itemsheet.js:69-90`) moves into a shared `js/viewport.js` that places the box. The button shows on every tab except while Settings or the item sheet is open. Ideas keeps its own box (`index.html:113-117`).

## 4. Tab bar and navigation

**Decided:** tabs Today | Calendar | To-do | Ideas. Calendar has a Day / 3-day / Week / Month switcher. Tapping a day opens it. **List stays for now** (question 4), as an extra segment of that switcher; it is not retired in any stage and is revisited after Alex has used Today (stage 3d). **3-day is hidden until it is built** (question 5).

**Claude's call — confirm:**
- **List lives in Calendar's switcher:** Day / Week / Month / List until sub-project 2; 3-day then joins after Day. List keeps the 367-day feed expansion, the biggest render cost (code audit § 3) — see Later.
- **Calendar** opens on its last-used sub-view (Day by default); arrows and `openDay` (`app.js:846`) work as now.
- **The switcher fits 5 segments** at iPhone width, so adding 3-day later changes no layout; checked in stage 3c.
- **`focusOpener` (`app.js:599-606`)** learns Today's list in 3b and keeps `els.listView`.
- **Geometry:** bar fixed at the bottom, 56 px + `env(safe-area-inset-bottom)`; body bottom padding `56px + 72px + inset`. The toast moves from `bottom: 16px + inset` (`styles.css:606`) to `56px + 12px + inset`, `right: 88px`, clearing the capture button (56 px, `right: 16px`, `bottom: 56px + 16px + inset`). The narrower toast must still fit its text and Undo.
- **Layers:** content 0 < tab bar 5 < capture button 6 < capture box 8 < settings backdrop 10 < item sheet 15 < toast 20 (existing 10/15/20 unchanged, `styles.css:351,614,625`).

## 5. Visual foundation — Claude's call — confirm

**Kept:** the cream/paper/leather tokens, the dark theme (`styles.css:2-72`) and `--feed-palette-N` names (`palette.js:13-16`). New tokens are defined in both themes.

**Everywhere (stage 2):**
- **Spacing** 4 / 8 / 12 / 16 / 24 / 32. **Radii** 8 (controls), 14 (capture box, sheets), 50% (capture button).
- **One accent,** `--accent`: today/now, the active tab, the capture button, the next event's relative time. `--danger` only for a deadline's overdue age; the new `--overdue-start` (§ 2.3, both themes) only for a passed start date's age.
- **16 px on every input.**
- **Press state:** one delegated `pointerdown` listener adds `.pressed` to the nearest `button, [data-press]`; `pointerup`, `pointercancel`, `pointerleave` and a `pointermove` beyond 10 px (a scroll) remove it. If it still flashes as a scroll starts, add it after a short delay instead — device-check which. Rows get `--chip-bg`, buttons opacity 0.7, the capture button `scale(.94)`; `touch-action: manipulation` on `html`. A class, not `:active`, which can stick during an iOS scroll (WebKit 255277, 221366).

**New screens only** (Today, tab bar, capture box): type scale 13 px labels/times (uppercase, +0.06em, `--muted`), 16 px rows, 20 px tab titles, 28 px the Today heading; Georgia for titles, `system-ui` with tabular numerals elsewhere. **Month and Week keep their compact sizes.** Rows, not cards: full width, 1 px `--line` hairline, at least 44 px. Shadows only on the capture box, sheets and toast.

**Motion:** 200 ms ease-out (capture box 250 ms), `transform`/`opacity` only. Nothing else animates. Under `prefers-reduced-motion` the box only fades.

**Box growing from the button.** An **outer** wrapper is positioned by `viewport.js`; an **inner** panel animates (scale from 0.2 plus opacity, `transform-origin` at the button's corner), so positioning and animation never share a `transform`. Closing reverses the path, **except with the keyboard up**: the button is covered, so the box fades out instead. Not View Transitions: their async update may move `focus()` outside the tap, so iOS might not raise the keyboard — **speculative**.

**No haptics:** Safari has no Vibration API; feedback that only sometimes fires is worse than none.

## 6. Errors, and what must not change — Claude's call — confirm

- **Feed URLs are never rendered or logged.** Today rows, the sheet and the stage-1 readout show the calendar name only (`app.js:536-554`).
- **Sync is untouched** (`sync.js`, `merge.js`, `schemaVersion`, ownership, visibility gate).
- **Calendar visibility writes** re-read `loadFeeds()` just before saving (as `settings.js:219-225`), never app.js's snapshot, which can tombstone a feed and lose its URL.
- **No new item fields;** any that appears goes in `makeItem`'s 13-key whitelist (`items.js:28-45`).
- **Service worker:** new modules into `ASSETS`, `CACHE` bumped, `serviceworker.test.js` re-pinned (incl. stale `CACHE_ON_MAIN`).
- **Smart add can hang on "Thinking…" on `main`** (`smartadd.js:17`). A 60 s timeout is landing on `punchlist-fixes-3` (393f98e, 0131165, 70a7e81), unreleased. Stage 4 depends on it.

## 7. Testing — Claude's call — confirm

TDD per the existing harness: `npm test`; never `node --test tests/`.

- `tests/today.test.js` (pure): overdue boundaries; overdue includes `due`, `milestone`, `task`, `start` and excludes done, ideas, `event`/`general` and feed instances; `start` rows marked for orange, the rest for red; done-today kept; ideas excluded; weekly series hidden from Next 7 days, shown today; its overrides count; yearly/monthly series and master-less overrides act as one-offs; multi-day one-off shown once; **no caps — every row rendered in every section**; relative time on the next event only; empty-day "Next"; **every id at most once** — mutation-checked.
- `tests/feeds.test.js`: `recurring` true for `DAILY`/`WEEKLY`, false for `YEARLY`/`MONTHLY`/no RRULE; heuristic: groups same title + weekday + time on 3+ weeks only in a feed with no RRULE, never runs on a feed with any RRULE, sets `guessedSeries`; `feedShape` counts and names rule or heuristic; update shape asserts at `feeds.test.js:477-541`.
- `tests/voice.test.js` (fake `SpeechRecognition`): new instance per listen; stop commits shown text with no final event; detach → `stop()` → `abort()`; late `onresult` ignored; unprompted `onend` adds nothing; prefix + finals + interim; hidden page stops and keeps; refusals show the right message and never call `focus()`.
- `tests/apply.test.js` (fake DOM): tabs; the `adding` latch; Cancel discards a late reply; a stale preview cannot be confirmed; capture messages go to `#capture-message`, others to `#message`; the 60 s tick changes only the time text.
- `tests/styles.test.js`: 16 px inputs, toast position, z-index order, reduced motion, `touch-action`, `--overdue-start` defined in both themes.

**On-device checklist** (iPhone home-screen app): typical day fits; mic → live words → stop adds at once; **mic → stop → mic again**; **background while listening** (text kept, nothing added); **open a row while listening**; tap the box while listening → keyboard, words kept; box above the keyboard, Add reachable; × with the keyboard up fades; Safari tab shows the home-screen message; mic permission off shows the Settings message; toast clears bar and button and fits Undo; bar clears the home indicator; press feedback instant, no flash on scroll start, never stuck; dark mode; red and orange overdue ages readable and distinguishable in light and dark mode; classes absent from Next 7 days; a guessed series shows its "(guessed)" label.

## 8. Build stages — Claude's call — confirm

Each stage ships on its own. Merging to `main` is the deploy.

1. **Feed-shape readout in Settings** (§ 2.4), naming rule or heuristic per feed. Alex reports LMU Classes' numbers.
2. **Foundation:** tokens (spacing, colour, radii), press state, 16 px inputs everywhere. Existing type sizes kept.
3. **Today, in four steps:**
   - **3a** `recurring` (rule, plus the heuristic if a feed is Canvas-shaped) + `buildToday`: pure, tested, no UI. **Precondition:** stage 1's numbers.
   - **3b** a Today tab beside the existing view buttons; nothing removed.
   - **3c** tab bar + Calendar switcher (Day/Week/Month/List; 3-day hidden); toast and padding re-placed.
   - **3d** revisit List after Alex has used Today. Nothing is removed unless he then decides to.
4. **Capture button and box**, `listen()`, `viewport.js`. Needs the smart-add timeout released.
5. Then sub-project 2 (3-day view), then sub-project 3 (visibility), each with its own spec.

**Later / open items:** measure render cost on the phone (`render()`, `app.js:816-819`, rebuilds every view; never measured; List's 367-day expansion stays since List stays) before any "render only the visible view" work. Check whether `fetchWithTimeout` can take a caller's abort signal (§ 3 step 7). Gratification for completing things (gamification) is Alex's idea for the punchlist only; no design here.

## 9. Alex's answers (2026-10-21) — Decided

No open questions remain. Each answer is applied in the section named.

1. **Typing box stays at the top; voice button bottom-right.** "yeah lets try" — refine through use. (§ 3)
2. **Ticked to-dos stay struck through on Today until tomorrow.** (§ 2.3) Gamification for completing things: punchlist idea only. (§ 8 Later)
3. **No caps and no "+N more" anywhere** — Next 7 days, Overdue and To do today: "just show every one if i dont like it then we can change it to the +N version." (§ 2.3)
4. **Keep the List view for now;** revisit after use, no stage removes it. (§ 4, § 8)
5. **Hide 3-day until it is built.** (§ 4)
6. **Relative time "in N" only on the next event;** every other event shows its date and time. (§ 2.3)
7. **Only `FREQ=DAILY`/`WEEKLY` series repeat;** yearly and monthly behave as one-offs. (§ 2.4)
8. **Canvas-shaped feeds may use the series heuristic:** "yeah the app can use its discretion for determining if it is a series." Explicit approval of the fallback; it applies only to a feed with no RRULE, and a guessed series is labelled. (§ 2.4)
9. **Everything past its date is overdue, `start` included:** "just say everything is past due i want to feel like i am behind so i cant procrastinate." Deadlines (`due`, `milestone`, `task`) in red, start dates in orange; never ideas, done items, events or feed instances. (§ 2.3, § 5)

**Confirmed by Alex, 2026-10-21** (the five "Claude's call — confirm" items, now Decided): past events are never overdue ("i dont want past events included"); the `--overdue-start` orange as specified (check on the phone in both modes); List as a Calendar-switcher segment; the "Repeats weekly (guessed)" label; relative time only within 12 hours of the next event.

**Open risk for stage 3a (found while planning, 2026-10-21; speculative):** if a Canvas-shaped feed gives a weekly assignment the same title, weekday and time every week, the heuristic would group it as a series, and the repeating rule would then keep that DEADLINE out of Next 7 days — the opposite of "see everything I have to do". Resolve in the stage 3a plan, using the stage 1 readout of Alex's real feeds (e.g. never group events whose title marks a deadline, or treat a guessed series' instances as one-offs in Next 7 days when the feed also carries deadlines).

**Stage 1 result (2026-10-21) — the precondition for stage 3a is met.** Alex's Settings line for LMU Classes: "34 events: 7 repeat (RRULE), 27 single. Uses the rule." Read-only check of the same Google calendar (211 instances returned for 2026-01-01..2027-06-30): every regular class is an RRULE series (PHYS 2100 incl. the Tuesday session, MATH 234, ENGR 2001, CLST 1300, MECH 2100 lecture and lab). The 27 one-offs are 8 MATH 234 Standards Exams, 8 PHYS 2100 quizzes, 6 PHYS 2100 reassessments, 2 "no class" days, 2 "class on Zoom" days and 1 club meeting — all things Next 7 days should show. So stage 3a ships the rule only for this feed; the heuristic is not exercised. Alex does not subscribe Brightspace (his LMS) in plaenicke, so the Canvas-deadline risk above has no live feed today; it stays recorded for when one is added.
