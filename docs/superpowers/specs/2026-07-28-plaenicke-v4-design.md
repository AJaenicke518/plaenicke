# plaenicke V4 — Linked Calendars — Design

Date: 2026-07-28
Status: DRAFT — awaiting Alex's review (planned autonomously while Alex was away; all
open assumptions are in `docs/superpowers/brief-v4-autonomous-planning.md`)

## Goal

The greyed-out "Linked calendars" row in settings becomes real: Alex pastes calendar
feed URLs (Google, Apple/iCloud, Outlook, Canvas, anything that serves an iCalendar
feed) and their events appear inside plaenicke's List, Month, Week, and Day views as
read-only items alongside his own — one combined planner.

A second section of this doc is the **future-features backlog** (engineering-student
quality-of-life ideas) for V5+.

## Approaches considered

### Approach 1 — ICS feed aggregation via the existing Worker (RECOMMENDED)

Every target provider already exports a tokenized, read-only iCalendar feed URL:

- **Google Calendar**: Settings → Integrate calendar → "Secret address in iCal format"
  (`https://calendar.google.com/calendar/ical/<id>/private-<token>/basic.ics`).
- **Apple/iCloud**: Calendar → share → Public Calendar → `webcal://…icloud.com/published/…`
  (https works with the scheme swapped).
- **Outlook.com**: Settings → Calendar → Shared calendars → Publish →
  `https://outlook.live.com/owa/calendar/<token>/calendar.ics`.
- **Canvas LMS**: Calendar → "Calendar Feed" — includes assignments and due dates for
  every enrolled course. (This is the engineering-student jackpot: deadlines flow in
  automatically.)

plaenicke fetches these feeds through the existing Worker (browsers can't fetch them
directly — the providers don't serve CORS headers for third-party origins, and the
Worker also gives us caching and a single choke point), parses the ICS **client-side
in a pure TDD'd module** (the V1–V3 pattern), and merges the events into every view
as read-only external items.

- **Pros:** No OAuth, no Google Cloud/Azure app registrations, no server-side storage,
  no new accounts, no per-provider API code — one format covers all four providers plus
  anything else that speaks iCalendar (university events, sports teams, holidays feeds).
  Fits the existing architecture exactly.
- **Cons:** Read-only (can't push plaenicke items back out). Provider refresh latency
  is on the provider's side for *their* consumers, but irrelevant here — we fetch their
  feed live. ICS parsing (recurrence, timezones) is real work, but it's pure logic —
  exactly what this codebase TDDs well.

### Approach 2 — Provider APIs with OAuth (Google Calendar API, Microsoft Graph, CalDAV)

Real API integrations: OAuth consent flows, token storage (Worker + KV), per-provider
client code; Apple has no OAuth calendar API at all (CalDAV + app-specific passwords).

- **Pros:** Read-write becomes possible; richer metadata.
- **Cons:** Requires Alex to create and maintain a Google Cloud project and an Azure
  app registration (and their verification processes), a token store, and three
  separate integrations. Weeks of surface area for a personal app whose V4 goal is
  *seeing* everything in one place. **Rejected for V4; the read-write half is on the
  backlog with this cost spelled out.**

### Approach 3 — Publish plaenicke outward (phone's calendar subscribes to plaenicke)

Inverse direction: the Worker serves `plaenicke.ics` and the iPhone's native calendar
subscribes. Requires items to live server-side (KV) with auth — an architectural shift
away from localStorage-only. **Rejected for V4; on the backlog.**

## Design (Approach 1)

### Data model

Two new localStorage keys, both owned by `js/storage.js` (stays the only file touching
localStorage):

```
plaenicke.feeds     → [{ id, url, name, color, hidden }] // color from a fixed palette
plaenicke.feedCache → { [feedId]: { fetchedAt: ISO,
                                    events: [ParsedEvent],   // UNexpanded — rules, not instances
                                    skipped: [{uid, reason}] } }
```

`ParsedEvent` is the compact serializable output of parsing (summary, uid, dtstart/
dtend with their form and TZID, rrule string, exdates, recurrence-id) — **not** raw
ICS text (feeds can be hundreds of KB of ALARMs and DESCRIPTIONs; parsed records keep
the cache far under localStorage limits) and **not** expanded instances (expansion is
lazy per viewed range, below). Expansion output — what views consume — is:

```
EventInstance: { id: "<feedId>:<uid>:<date>:<time>",   // stable, unique per instance
                 uid, title, date: "YYYY-MM-DD", time: "HH:MM"|null,
                 endTime: "HH:MM"|null,
                 createdAt: "<date>T<time or 00:00>",  // derived — keeps sortItemsByDate total
                 feedId, feedColor, external: true }
```

The `id`/`createdAt`/`external` fields are contract requirements, not conveniences:
`sortItemsByDate` compares `createdAt` (a missing field makes the comparator
non-antisymmetric → list order flickers on re-sync), Day view's delete path reads
`item.id`, and every `'type-' + …` class-name site must branch on `external` to use
the feed color instead. (DA review Critical 4.)

**Size budget (checkable claim):** a parsed Canvas event is ≈200 bytes of JSON; the
worst realistic feed (Canvas, ≤1000 items/collection) is ≈400 KB, so four feeds fit
in roughly 1–2 MB against iOS Safari's ~5 MB per-origin ceiling shared with
`plaenicke.items`. Cache writes are wrapped; on `QuotaExceededError` the sync prunes
cached events outside [today−30d, today+366d] per feed, then drops the largest feed's
cache — and **surfaces what it did in that feed's status row** (never silently).

External events are **never** written into `plaenicke.items`. A merge function hands
views `ownItems ++ externalItems`, where external items carry `external: true` and
`feedColor`. Existing items code is untouched.

### Worker: `GET /feed?url=<encoded>`

The Worker gains one route (existing smart-add stays at `POST /`; `POST /` and
`OPTIONS` behavior must not change). Logic lives in a new `worker/src/feed.js`
(`handleFeed(request, {fetchImpl, cache})`, effects injected — same pure-module
pattern as `prompt.js`/`normalize.js`) so it's testable under `node --test`.

This IS a proxy, so it is hardened rather than pretended away (DA Critical 7 / Major
11 — the first draft's "not an open proxy" claim was wrong):

- **Origin check first:** `Origin` header must equal the Pages origin, else 403.
  Browsers can't forge `Origin`; this closes casual/automated relay abuse. A
  Cloudflare dashboard rate-limit rule on `/feed` is the second layer (account-level
  — Alex applies it, see punchlist).
- Accepts only `https:` URLs (client converts `webcal://` first). Rejects
  private/loopback/link-local hosts and non-standard ports → 400.
- **Redirects are followed manually** (`redirect: 'manual'`, max 3 hops) with the
  full URL validation re-run on every hop (iCloud shards genuinely redirect; a
  redirect to `http:` or a private host must die, not be silently followed).
- Response must begin with `BEGIN:VCALENDAR` (after BOM/whitespace strip) or → 422
  `not_an_ics_feed`. Hard size cap 1 MB → 413.
- Success → ICS text passed through with the app's CORS headers
  (`content-type: text/calendar`).
- Edge-cached ~15 minutes (Cache API keyed on target URL) for background refreshes;
  **manual "Sync now" sends `Cache-Control: no-cache`, which the Worker honors by
  bypassing the cache** — otherwise the button is a lie for up to 15 minutes.
- **Privacy:** feed URLs are capability tokens. The Worker must not log them. Honest
  caveat: the edge-cache key necessarily contains the URL; acceptable for a
  personal-zone cache, but it is a conscious trade, not an oversight.

### Client: `js/ics.js` (new, pure, heavily TDD'd)

Parses ICS text → expanded per-day event instances for a requested date range. This
section was reworked after DA review (Criticals 1–3, 5; Majors 9, 10, 16): the
supported subset is now grounded in what the four providers *emit* (see
`docs/superpowers/reviews/2026-07-28-v4-provider-format-notes.md` — notably, Canvas
emits **no RRULEs at all**: pre-expanded VEVENTs, UTC times, `DTSTART==DTEND` for
timed assignments), and every "we don't handle X" case has a written rule.

- **Line unfolding** (CRLF or LF + leading space/tab), property parameters incl.
  quoted values (`DTSTART;TZID=America/New_York:…`, `X-TITLE="a, b"`), escaped text
  (`\,` `\;` `\n` **and `\N`** `\\`). Unknown properties and unknown component
  blocks (VALARM, VTIMEZONE, X-anything) are structurally skipped — they are
  containers/decoration, not event data loss.
- **DTSTART/DTEND/DURATION rules (explicit, total):**
  - Forms: UTC (`…Z`), TZID, floating (= device-local), `VALUE=DATE` (all-day).
  - `DTEND` absent + `DURATION` present → end = start + duration (`P#D`, `PT#H`,
    `PT#H#M`, `P#DT#H#M` forms).
  - Neither → `VALUE=DATE`: one-day untimed; DATE-TIME: `endTime: null` (V3's
    "pinned chip" shape). `DTEND == DTSTART` (Canvas's timed-assignment shape) →
    `endTime: null` too.
  - All-day `DTEND` is exclusive per RFC; multi-day all-day → one untimed instance
    per covered day.
- **Timezone conversion** into an explicit `targetTz` parameter (app passes
  `Intl.DateTimeFormat().resolvedOptions().timeZone`; tests pass fixed zones — no
  `process.env.TZ` games). The core is `zonedWallClockToInstant(parts, tzid)` —
  the *inverse* of what `Intl.DateTimeFormat` gives you, implemented by offset
  probing with two written DST policies: **ambiguous wall time (fall-back hour) →
  first occurrence (DST offset); nonexistent wall time (spring-forward gap) → shift
  forward by the gap width.** Separately exported and tested, including a
  southern-hemisphere zone. Windows timezone names (possible from Outlook) resolve
  through a bundled CLDR `windowsZones` map (~130 entries, `js/tzmap.js`); a TZID in
  neither IANA nor the map → the event is skipped with reason `unknown_tz`.
- **Recurrence** — RRULE parts in three explicit lists (no permissive catch-all):
  - **Supported:** `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`; `INTERVAL` (with cycle phase
    computed from DTSTART — a biweekly rule viewed months later must land on the
    right weeks); `BYDAY` weekly (`MO,WE,FR`) and ordinal monthly/yearly (`2TU`,
    `-1FR`; a "5th Monday" that doesn't exist that month yields no instance);
    single-value `BYMONTHDAY`; `BYMONTH`; `UNTIL`; `COUNT` (iterated from DTSTART,
    bounded by COUNT); `EXDATE` (comma-joined or repeated lines);
    `RECURRENCE-ID` overrides (replace their master instance, matched on the
    original instance time).
  - **Ignorable-when-harmless:** `WKST` (only meaningful for `WEEKLY` with
    `INTERVAL>1` + multi-day `BYDAY`; in that exact combination it is NOT ignorable
    → skip with `unsupported_wkst` unless value is the default `MO`), `X-*` parts.
  - **Skip-triggering (whole event → skipped, with reason):** `BYSETPOS`,
    multi-value `BYMONTHDAY`, `BYWEEKNO`, `BYYEARDAY`, sub-daily FREQ, anything
    unrecognized.
  - `UNTIL` is compared on **absolute instants** (UTC form as-is; DATE form = end of
    that day in the event's zone; naive-local form interpreted in the event's TZID).
    Boundary test required: a `Z`-form UNTIL that lands mid-local-day must not admit
    an extra instance.
  - Expansion is **lazy per requested range** — `expandEvents(parsed, rangeStart,
    rangeEnd, targetTz)`. (Scope of the claim: expansion has no horizon; the
    *provider's data* still ends wherever their feed window ends — e.g. Canvas
    serves −30d→+366d.)
- **Zero fallback:** a skipped event is *counted with its title*, not dropped — the
  parse result carries `skipped: [{uid, summary, reason}]` (persisted in the feed
  cache), surfaced in the feed's settings row ("2 skipped: 'Statics Lecture' —
  unsupported recurrence"). Nothing silently disappears.
- **Events longer than a day on the clock:**
  - Overnight timed events (≤2 days): split into per-day display segments
    (23:00–23:59 day one, 00:00–01:00 day two) so Day view renders truthfully.
  - Timed events spanning **more than 2 days**: rendered as one untimed instance per
    covered day (a week-long "conference" block must not shred Day view's overlap
    layout into 1/n-width slivers).

### Sync behavior

- On app load: any feed whose cache is older than 30 minutes refreshes via async
  fetch; views render immediately from cache and re-render when fresh data lands.
  (Precise claim for iOS: this is a fetch-on-open, NOT background execution — a
  home-screen PWA gets no periodic wakeup; "30 minutes" is a staleness threshold
  checked at open, nothing more.)
- Manual "Sync now" per feed (and implicit on add) in settings — bypasses the
  Worker's edge cache (see Worker section). Status line says **"fetched Xm ago"**,
  not "synced" — the provider's own export can lag its UI, and the wording shouldn't
  claim more than we know.
- Offline / fetch failure: last-good cached events keep rendering; the feed's row
  shows the error. The app never blocks on the network — same offline-first posture
  as V1–V3.

### UI

- **Settings → Linked calendars** (replaces the placeholder): list of feeds — color
  dot, name, status line (fetched Xm ago / skipped titles / error) — each with
  **Show/Hide toggle**, Sync, and Remove; an "Add calendar" flow: paste URL +
  optional name, color auto-assigned from the palette (tap to cycle). Provider is
  inferred for the default name (Google / iCloud / Outlook / Canvas / Calendar) from
  the URL host — cosmetic only, all hosts are treated identically.
  (The toggle is in V4, reversing the first draft's YAGNI call: removing a feed
  destroys its cache and re-adding means re-fetching a secret URL from a desktop
  settings page — that workaround is not cheap. DA Major 14.)
- **Views:** external items render like own items but with the feed's color as their
  accent (V3's type colors keep meaning "type" for own items), and with **no delete ×
  and no editing** — hide or remove the feed instead. List/Month/Week/Day all include
  them through the same merge with two adjustments:
  - **List view's external horizon is today → today+366d** (matches Canvas's own
    window); own items past that still render; the list ends with a small "external
    calendars shown through <date>" note. (Lazy expansion needs a bound; List has no
    natural one. DA Critical 6.)
  - **Month cells guarantee at least one chip for own items** when any exist that
    day; external events fill the rest, `+N more` as before. Week's 8-block cap and
    chronoFirst are unchanged. (Four feeds must not evict Alex's own planner from
    his planner. DA Major 14.)

### Testing

- **Real fixtures first (plan Task 0):** byte-exact captures of real, *non-secret*
  feeds committed to `tests/fixtures/` before any parser code — Google's public
  holiday calendars (genuine Google output), an Apple-official or Alex-owned public
  iCloud calendar, and (with Alex, on his device or with URLs he chooses to share
  into a local uncommitted file) samples of his Canvas and Outlook feeds. Rule,
  learned the hard way: **fixtures come only from provider-official public feeds or
  Alex's own calendars — never from tokenized URLs found in public repos** (those
  are other people's private data). Canvas's format is additionally documented from
  its source code in `docs/superpowers/reviews/2026-07-28-v4-provider-format-notes.md`.
- `tests/ics.test.js` — the bulk of V4's TDD: unfolding, parameter parsing, each
  DTSTART/DTEND/DURATION form, `zonedWallClockToInstant` (incl. DST fall-back,
  spring-forward gap, southern hemisphere), Windows-TZID mapping, the RRULE matrix
  (three-list policy, ordinal BYDAY, INTERVAL phase from DTSTART, UNTIL boundary,
  COUNT, EXDATE forms, RECURRENCE-ID), overnight/multi-day rules, skipped-with-title
  accounting — plus parse runs over the real fixtures asserting `skipped` is empty
  (or exactly the known-unsupported set).
- `worker/tests/feed.test.js` — `handleFeed` with injected fetch/cache: Origin
  enforcement, non-https/private-host rejection, manual redirect loop (good and
  hostile hops), non-ICS rejection, size cap, cache bypass on `no-cache`, and
  regression: `POST /` + `OPTIONS` unchanged.
- Storage round-trip + quota-failure tests; merge-layer tests incl.
  **order-independence of `sortItemsByDate` over mixed own/external arrays**.
- Live verification needs Alex's real feed URLs pasted **on his device** (they're
  secrets; they should never transit chat or this repo).

## Out of scope (V4)

- Writing events *to* Google/Apple/Outlook (Approach 2 on the backlog).
- OAuth, server-side storage, accounts, multi-device sync.
- Editing or hiding individual external events (per-feed show/hide IS in V4).
- Notifications/reminders for external events.
- VTODO/VJOURNAL components (VEVENT only).

---

## Future-features backlog — engineering-student QoL (V5+ candidates)

Ranked within tiers by value-for-cost. Nothing here is committed; this is the
brainstorm Alex asked for.

### Quick wins (each ≈ a small V-release or less)

1. **Syllabus import** — paste a syllabus (or its schedule table) into smart add;
   the Worker already extracts structured items with dates — extend the prompt to
   handle "many deadlines at once" with a bigger preview. One evening of a semester's
   data entry becomes one paste. *Highest value/cost ratio on this list.*
2. **JSON export/import backup** — everything lives in one browser's localStorage; a
   lost phone loses the planner. Settings → "Export data" (share-sheet a JSON file) /
   "Import". Cheap insurance, overdue.
3. **Exam countdown badges** — items typed `due`/`milestone` within N days show a
   "T-4d" chip in List view. Trivial pure logic on existing data.
4. **Week workload meter** — tiny bar per Week-view column scaled by item count/hours,
   so a brutal week is visible at a glance. Pure timegrid math.

### Medium (a focused V-release each)

5. **Recurring own items** ("Statics lecture MWF 9:00 all semester") — V4's RRULE
   expansion engine gets reused for plaenicke's own items; UI needs repeat controls +
   an end-of-semester date. Natural V5: the engine will already exist and be tested.
6. **Course/semester setup** — courses with colors and subjects; auto-tag smart-add
   items to courses; a semester date range that scopes recurring items.
7. **Focus timer** — pick an item, run a pomodoro, log sessions to it; a "studied
   3.5h this week" line. Pairs with the workload meter.
8. **Grade tracker** — per-course grade entries and weight math → current standing.
   Useful, but drifts from "planner" toward "everything app" — decide deliberately.

### Heavy (architectural shifts — each needs its own brainstorm)

9. **Reminders/notifications** — iOS supports Web Push for home-screen PWAs
   (16.4+), but it needs a push service in the Worker + subscription storage (KV) —
   the first server-side state in the app.
10. **Two-way calendar sync** (Approach 2) — OAuth apps, token store, per-provider
    code, Apple only via CalDAV. Only worth it if read-only aggregation proves
    insufficient in practice.
11. **plaenicke as a feed** (Approach 3) — subscribe to plaenicke from the phone's
    native calendar; needs server-side items (KV) + auth, i.e. the end of
    localStorage-only. Would also unlock **multi-device sync** (12) — same
    prerequisite, likely the same release if ever done.
