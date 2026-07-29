# Provider ICS format notes — research for V4 (2026-07-28)

What each target provider's feed *actually* contains, with evidence tier per claim:
**Concrete** (read from provider source code or official docs), **Provisional**
(reported by a research pass whose capture method was rejected — must be re-verified
in Task 0 against Alex's own calendars or provider-official public feeds), or
**Unverified**.

## Canvas LMS — Concrete (read from `instructure/canvas-lms` source + its spec suite)

The best-behaved feed of the four, and the biggest planning win:

- **No RRULE, ever.** Canvas expands recurring series server-side into individual
  VEVENTs at creation time (capped at 400 per series). Every event in the feed is a
  plain, fully-materialized VEVENT. → The recurrence engine is *not needed* for the
  Canvas path.
- **All times UTC `Z`-suffix** (`DTSTART:20261215T235900Z`), seconds zeroed, no
  VTIMEZONE block, no TZID parameters.
- **Timed assignments:** `DTSTART == DTEND` (both = due_at) — zero-duration events.
  Parser rule: `dtend == dtstart` → `endTime: null` (chip, not a zero-height block).
- **All-day** (assignments due at Canvas's default 23:59): `DTSTART;VALUE=DATE`,
  **DTEND omitted** → one-day untimed.
- **Feed window: 30 days back → 366 days forward**, ≤1000 items per collection
  (assignments / events). Not unbounded.
- **Includes every currently-active course** — the UI's calendar checkboxes do NOT
  filter the feed (`public_feed` passes `codes = nil`). Expect volume; the per-feed
  show/hide toggle and view-cap policy matter here.
- `SUMMARY` = `"Title [COURSE-CODE]"`; `UID` = `event-assignment-<id>` /
  `event-calendar-event-<id>`; DESCRIPTION is HTML-stripped text; `METHOD:PUBLISH`;
  `X-WR-CALNAME: <name> Calendar (Canvas)`.
- Auth is the capability URL alone (no session). CORS/bot-blocking on
  `*.instructure.com`: Unverified — confirm in Task 0.

Sources: `app/models/calendar_event.rb`, `app/models/abstract_assignment.rb`,
`app/controllers/calendar_events_api_controller.rb`, `app/helpers/rrule_helper.rb`,
`spec/apis/v1/calendar_events_api_spec.rb` (github.com/instructure/canvas-lms).

## Apple iCloud published calendars — Provisional

Reported by a research pass that verified format claims against live third-party
published calendars reached via capability tokens leaked in public repos. That
capture method was rejected on review (fetching strangers' calendar data — see the
session security note); none of those URLs or contents are retained. The format
claims below are plausible and specific, but **each must be re-confirmed in Task 0**
from Alex's own iCloud published calendar before the parser treats them as fixed:

- TZID values are standard IANA names (`America/Toronto`); full VTIMEZONE blocks
  included, with deep historical transitions — including **6-digit UTC offsets**
  (`TZOFFSETFROM:-051732`, seconds are RFC-legal). Parser must tolerate ±HHMMSS
  offsets even though we don't evaluate VTIMEZONE.
- `PRODID:-//caldav.icloud.com//CALDAVJ <build>//EN`; `CALSCALE`/`METHOD` may be
  absent (published feed differs from local Calendar.app export).
- Events use DTEND (DURATION not observed); overrides arrive as separate VEVENTs
  sharing the master's UID with `RECURRENCE-ID;TZID=<zone>:<local-time>`.
- VEVENT RRULEs observed: `FREQ=WEEKLY;UNTIL=<utc>Z` form; ordinal BYDAY/BYSETPOS on
  user events not directly observed.
- Transport: hosts `p<N>-caldav.icloud.com` / `p<N>-calendars.icloud.com`; no CORS
  headers (browser fetch impossible — Worker proxy required); no cache headers; gzip
  supported; `X-APPLE-*` properties and unescaped `X-TITLE=` params appear (parser
  must not choke on unknown X- properties).

## Google Calendar (secret iCal address) — Partially concrete

- The secret-address mechanism and URL shape are documented by Google
  (`…/calendar/ical/<id>/private-<token>/basic.ics`).
- DA review asserts (high confidence, unverified byte-level): `WKST` on weekly
  RRULEs, ordinal `BYDAY` (`2TU`) for "monthly on the Nth weekday", VTIMEZONE with
  IANA TZIDs, `UNTIL` in UTC. Task 0 captures Google's public holiday calendars
  (genuine Google output, not secret) to confirm.

## Outlook.com published calendars — Unverified

- The publish mechanism and URL shape (`outlook.live.com/owa/calendar/<token>/calendar.ics`)
  are documented by Microsoft.
- **Open question (highest-risk unknown):** Windows timezone names
  (`W. Europe Standard Time`) vs IANA in TZID; DURATION vs DTEND; RRULE shapes.
  Mitigation already in the design: CLDR windowsZones Windows→IANA map + Task 0
  capture of Alex's real feed before Task 3 hardens. A guarded research pass
  (docs/fixtures only) was dispatched 2026-07-28; results land in this file when in.
