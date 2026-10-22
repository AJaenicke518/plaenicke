# plaenicke code audit for Today / tab bar / refresh (read-only, main @ 10607b6)

## 1. Views
All six sections are always in the DOM (`index.html:74-119`). `showView` toggles `hidden` (`app.js:821-838`). Day is the default (`index.html:69,96`). The research doc's "opens on List" (§ 2) is out of date.

| View | Render | Data | Feeds | 390px phone (358px content, `styles.css:96`) | Tap |
|---|---|---|---|---|---|
| List | `renderList` `app.js:651` | `sortItemsByDate(visibleItems(today, today+366))` `:657` | yes; instances run today→+366 d (`:100,656`), own items have no range limit, so **past own items list first** | full-width card rows; the title reads "Today — x" (`:681`), time line, tags, Delete | title → sheet (`:683`); Delete → `requestDelete` with Undo (`:699`); feed rows have no Delete (`:694`) |
| Month | `renderCalendar` `:713` | `visibleItems(monthStart, monthEnd)` `:723` | yes | 7 columns about 47px wide, cells 72px tall (`styles.css:258`), 2 chips plus "+N more" (`calendar.js:36`) | the whole cell → `openDay` → Day (`app.js:762`) |
| Week | `renderWeek` `:771` → `weekview.js:8` | `visibleItems(weekStart, +6)` | yes | 7 columns about 48px wide, **8px bars with no text** (`styles.css:295`), capped at 8 (`weekview.js:25`) | the column → `openDay` (`weekview.js:42`) |
| Day | `renderDay` `:781` → `dayview.js:10` | `visibleItems(viewDay, viewDay)`, then `byDate[viewDay]` `:786-788` | yes | "Other tasks" (untimed) above a 24h × 48px grid, capped at 60vh (`styles.css:304`), auto-scrolls to 07:00 (`dayview.js:116`) | block's button → sheet; × → `requestDelete` (`dayview.js:57,65`) |
| To-do | `renderTodos` `:800` → `todoview.js:14` | `todoItems()` = `liveItems().filter(isTodo)` `:141` | **no, by design** (`:137-140`) | checkbox, then "date — title", then Delete | checkbox → `setDone` (`todoview.js:47`); title → sheet |
| Ideas | `renderIdeas` `:806` → `ideasview.js:12` | `ideaItems()` `:143` | no | title plus full notes, date never shown (`ideasview.js:6`) | title → sheet |

The sheet for a feed event receives only the calendar **name** and a Google day link, never the URL (`app.js:536-554`).

## 2. Data functions
- `visibleItems(start,end)` (`app.js:130`) returns **every** live scheduled own item, unbounded, plus feed instances in the range. **Trap for Today:** `visibleItems(today,today)` still returns all own items for every date. Callers bucket by date afterwards (`:786`). Today must filter own items by date itself.
- `liveItems()` hides pending deletes (`:115`).
- `isScheduled` = `type !== 'idea'` (`items.js:58`). `isTodo` = type ∈ {due,start,milestone,task} && `done !== true` (`:62-67`), and `general` is excluded. `isIdea` (`:60`).
- `sortItemsByDate`: date, then untimed first, then time, createdAt, title (`items.js:79`). `chronoFirst` puts timed items first (`calendar.js:71`). `sortIdeasNewestFirst` (`items.js:72`).
- **No overdue notion exists.** The only mention is a comment (`edit.js:95`). `formatDayLabel` returns Today/Tomorrow/Yesterday/date (`freshness.js:42`). An overdue to-do can be derived as `isTodo && date < today`, which is new code.
- Quick moves exist (`edit.js:95`, sheet).
- **ICS instance** (`feeds.js:487-498`): `{id:"feedId:uid:date:time", uid, title, date, time, endTime, createdAt:"dateTtime", feedId, feedColor, external:true}`. It has no calendar name (looked up from `feeds` in `app.js:547`), no `type`, no `done`. An all-day multi-day event emits one instance per day (`ics.js:1131-1134`).
- **Series id:** `uid` is the ICS UID, and RECURRENCE-ID overrides share their master's UID (`ics.js:1293-1296`). So `(feedId, uid)` identifies a series. *Concrete.* The instance does **not** say whether it recurs, because `rrule` stays on the ParsedEvent (`ics.js:1009`). Hidden feeds are skipped (`feeds.js:467`). `hidden`/`color` are device-local and never synced (`feeds.js:553-575`).

## 3. Render cost
`render()` (`app.js:816-819`) rebuilds all six views through `innerHTML=''` on every call. It is called at 16 sites (`:183,233,308,329,363,425,500,519,622,837,869,877,941,1004,1111,1207`), including every tab switch (`:837`), every arrow (`:869`), every resume (`:1207`), every feed settle (`:941`) and every cross-tab storage event (`:1111`).

Per render:
- `visibleItems` 4× → `instancesForRange` 4× → `expandEvents` once per visible feed per call, with no memo (`feeds.js:464-500`). One of those calls covers **367 days** for the hidden List.
- `sortItemsByDate` 6× over `items`.
- DOM: List creates one `<li>` per own scheduled item (all time) plus every instance in a year. Month creates up to 42 cells plus 7 headers. Day creates 48 hour nodes. The other views follow.

The one cache is the localStorage read at load and on change (`:101-102`). Whether this is slow on a phone is **not measured**, so treat it as unverified.

## 4. Styling (`styles.css`, 703 lines)
- **11 font sizes:** 0.65, 0.7, 0.72, 0.75, 0.8, 0.85, 0.9, 1, 1.1, 1.2, 1.7rem.
- **13 spacing values:** 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 40px.
- **9 radii:** 0, 2, 3, 4, 6 (16 uses), 8, 12 top, 50%, 999px.
- **Colour tokens:** 28 per theme, in `:root` (`:2-36`) and `[data-theme="dark"]` (`:38-72`). They are 12 UI, 7 `--type-*`, `--on-type`, shade, scrim, and 6 `--feed-palette-*`. Two raw rgba shadows sit outside the tokens (`:613,646`).
- **No spacing, size or radius tokens. Zero `@media` rules.** There is no `prefers-color-scheme` CSS. Dark mode is set only by the inline script on `<html data-theme>` (`index.html:11-17`) and `settings.js:38`.
- **One font:** Georgia (`:26,93`). Monospace is used only for link codes (`:502`).
- **Type → colour:** `.type-*` sets `--type` (`:526-537`). External items use the inline `--feed-color`. `itemTypeClass` returns **multiple tokens**, so use `className` and never `classList.add` (`calendar.js:59-66`).
- **Feed palette:** the values are CSS var references stored verbatim in `feed.color` (`palette.js:13-16`). Renaming `--feed-palette-N` would break stored colours.
- **What makes a refresh hard:** ID-scoped selectors (`#item-list li`, `#todo-list li` `:228,554`). There are duplicated row rules for list, todo and idea (`:228-237,538,554-563`). `tests/styles.test.js` pins winning declarations (`declOf`, `:102-160`).

## 5. Capture today
- **Add box:** `index.html:47-61`, at the top of the page above the nav, never moved.
  - Enter or Add → `handleAdd` (`app.js:249,854-855`).
  - With a date chosen it is a **manual add**, always `type:'event'` (`:243`), works offline, and there is no type picker.
  - With no date it is **smart add**: `parseViaWorker` (`smartadd.js:14`, plain `fetch`, **no timeout**). `decideFlow` then adds a single item directly or shows the inline `#preview` (`index.html:63`, `preview.js:19`).
- **Voice:** `#mic-btn` appears only when the Web Speech API exists (`app.js:147`, `voice.js:7`), and fills the text box.
- **Ideas box:** `index.html:113-117` → `handleIdeaAdd` (`app.js:632`), offline.
- Every path goes through `addItems` (`:207`), which applies `normalizeIdea` and `makeItem`.
- **Capture from anywhere** touches: moving or duplicating the `#entry-*` and `#preview` nodes. Note that `els` binds by id at load (`:33-41`), ids must stay unique, and `apply.test.js:159` mounts every `index.html` id. It also touches `setMessage`'s single `#message` (`:205`) and the preview, which renders inline rather than in a sheet.

## 6. Constraints
- **Service worker:** each new module goes in `ASSETS`, and `addAll` is all-or-nothing (`service-worker.js:14-23`). `CACHE` must be bumped (`:13`). Both are tested in `serviceworker.test.js`. Its `CACHE_ON_MAIN` is still `'plaenicke-v6-4'` (`:48`) while main ships `v6-5`, so the pin is stale and needs a re-pin.
- **Feed URLs:** never display or log one (CLAUDE.md, `app.js:536-539`, `feeds.js:477`).
- **Calendar chip writes:** `settings.js:219-225` `reapplyFeedField` re-reads `loadFeeds()` before it saves. app.js holds a snapshot (`app.js:101`). A chip must not `saveFeeds` from that snapshot. Move the re-reading writer into `feeds.js` (research § 3 trap). Ownership rule: CLAUDE.md "Ownership".
- **Visibility gate:** `runSync` skips hidden tabs (CLAUDE.md). On resume the app runs `render` + `backgroundSyncFeeds` + `runSync` (`app.js:1192-1213`). On hide it commits pending deletes (`:1194-1197`).
- **Item sheet:** `followVisualViewport` sets top, transform and max-height from `visualViewport` (`itemsheet.js:69-90`), with z-order settings 10 < sheet 15 < toast 20 (`styles.css:601-625`). A tab bar needs a z-index below these.
- **Safe areas:** the body pads the top inset and `96px + bottom inset` for the toast (`styles.css:96-99`). The toast sits at `bottom: 16px + inset` (`:606`) and **would sit over a bottom bar**.
- **Settings:** the backdrop is flex-start at 15vh, and **neither the backdrop nor the panel has an overflow rule** (`styles.css:343-356`). There is no close button, only Esc, a backdrop tap or the gear (`settings.js:102,125,569`).
- **16px inputs:** pinned only for the sheet (`styles.test.js:150-156`). These are still 0.9rem: `.feed-add input` (`:427`), `.link-ui input` (`:476`), preview fields (`:517`). Link codes are 0.7rem (`:503`).
- **Item fields:** `makeItem` is a 13-key whitelist (`items.js:28-45`). A new field such as snooze must be added there, or it is dropped silently.

## 7. Gaps
- **ICS location, description and URL are discarded at parse time** (`ics.js:907-918`, default case). The cache stores ParsedEvents, not raw ICS (`feeds.js:249`), so adding fields needs a parser change and a re-fetch, and it grows the localStorage cache (quota pruning exists at `feeds.js:150`).
- **No recurring flag on instances.** The series key is derivable. There is no store for hidden series: a device-local one would follow the `hidden` pattern, while a synced array means `merge()` work and a `schemaVersion` decision (CLAUDE.md).
- **`createdAt` is date-only** (`app.js:220`), so ideas from the same day sort by random UUID (`items.js:75`, `uid.js:9`), and nothing can show "captured 2h ago".
- **Missing fields and features:** no snooze, priority or overdue field. No "completed" view, because `isTodo` hides done items. No now-line. No `navigator.storage.persist()`.
- **Untyped to-dos:** `general` and `event` items never appear as to-dos (`items.js:62-67`), and manual add cannot create one (`app.js:243`).
- **Smart add can hang** on "Thinking…": there is no timeout (`smartadd.js:17`).
