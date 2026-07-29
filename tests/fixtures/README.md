# ICS fixture provenance

All fixtures in this directory were captured with `curl -o` (or `curl --compressed -o`
where the server gzips regardless of request headers) directly from the URL listed
below. No reformatting, re-encoding, or content stripping was applied. Line endings
are the provider's own (both current fixtures use CRLF throughout, confirmed by
`grep -c $'\r' <file>` equalling the file's line count).

**Sourcing rule (hard constraint):** only provider-official public feeds or the
calendar owner's own calendars. Never a tokenized/capability URL sourced from a
public repo or forum — that is a stranger's private calendar data.

## google-holidays.ics

- **Source URL:** `https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics`
- **Nature:** Google's own public holiday calendar (`en.usa#holiday@group.v.calendar.google.com`), published by Google for public subscription — provider-official, no auth, no tokenized capability path.
- **Capture date:** 2026-07-29
- **Capture command:** `curl -sS -o google-holidays.ics <url>`
- **Size / lines:** 120,685 bytes / 4,621 lines (CRLF)
- **Sanity check:** starts `BEGIN:VCALENDAR`, ends `END:VCALENDAR\r\n`, `PRODID:-//Google Inc//Google Calendar 70.9054//EN`.
- **Second Google fixture with recurring events:** not captured. A guess at Google's
  legacy public "Phases of the Moon" calendar ID (`ht3jlfaac5dqoiokdmr6iv1ao@group.v.calendar.google.com`)
  returned HTTP 500 — that calendar ID appears retired (Google now exposes moon
  phases only as a client-side "alternate calendar" toggle, not a subscribable public
  ics). No other Google-hosted public calendar with RRULE-based recurrence was
  identified without resorting to a guessed/unverified calendar ID, so per the task
  brief ("the holiday calendar alone is fine otherwise") no second Google fixture was
  added. **Surprise for the parser/tasks:** this feed contains **zero RRULE, zero
  VTIMEZONE, zero TZID** — every holiday occurrence is pre-materialized as its own
  `VALUE=DATE` all-day `VEVENT` (317 VEVENTs total). This contradicts the
  "Provisional"/DA-review assumption in
  `docs/superpowers/reviews/2026-07-28-v4-provider-format-notes.md` that Google
  feeds exhibit `WKST`/ordinal `BYDAY` RRULEs and VTIMEZONE — that assumption is
  **not confirmed** by this fixture and should be treated as unverified for
  Google's *holiday* feed specifically (a personal Google secret-address feed with
  recurring user events may still behave as originally asserted; this fixture just
  doesn't prove it either way).

## icloud-sample.ics

- **Source URL:** `https://calendars.icloud.com/holidays/us_en-us.ics`
- **Nature:** Apple's own public holiday-calendar generator, hosted on
  `calendars.icloud.com` (Apple/iCloud's official domain). The URL path form
  (`/holidays/<country>_<lang>.ics`) is documented third-party (Apple Community
  threads, osxdaily) as the mechanism Calendar.app itself uses for "Add Calendar
  Subscription" of built-in holiday calendars — it is a stable, unauthenticated,
  provider-published path, not a per-user tokenized capability URL.
- **Capture date:** 2026-07-29
- **Capture command:** `curl -sS --compressed -o icloud-sample.ics <url>` (server
  sends `Content-Encoding: gzip` unconditionally; `--compressed` is needed for curl
  to request/decode it so the captured file is the actual calendar text, not a
  gzip blob — this does not alter the calendar content itself).
- **Size / lines:** 38,460 bytes / 1,312 lines (CRLF)
- **Sanity check:** starts `BEGIN:VCALENDAR`, ends `END:VCALENDAR\r\n`,
  `PRODID:icalendar-ruby`. Refetched a second time in the same session; byte-identical
  (same `ETag`) — feed is stable, not per-request-randomized.
- **What this fixture DOES confirm:** real Apple-hosted ICS output — 76-char line
  folding, CRLF line endings, `RRULE:FREQ=YEARLY;COUNT=5` and
  `RRULE:FREQ=YEARLY;COUNT=5;BYDAY=<ordinal><DOW>;BYMONTH=<n>` forms (e.g.
  `BYDAY=-1MO` last-Monday, `BYDAY=3MO` third-Monday), all `DTSTART;VALUE=DATE`
  with **no `DTEND` at all** (single-day implied duration, not even the
  DTSTART=DTEND-1 pair Google's holiday feed uses), `SUMMARY;LANGUAGE=en:` parameter
  usage, and `X-APPLE-LANGUAGE` / `X-APPLE-REGION` / `X-APPLE-UNIVERSAL-ID`
  extension properties (parser must tolerate unknown `X-` properties, per the
  provider-format-notes doc).
- **What this fixture does NOT confirm** (must stay TODO — see below): this is
  Apple's holiday-calendar-generator service (`PRODID:icalendar-ruby`), a
  **different backend** from a personal iCloud *published calendar*
  (`p<N>-caldav.icloud.com`, `PRODID:-//caldav.icloud.com//CALDAVJ...`). It has
  **zero TZID/VTIMEZONE usage** (all events are all-day, timezone-agnostic), so it
  cannot confirm or refute the provisional claims in
  `docs/superpowers/reviews/2026-07-28-v4-provider-format-notes.md` about personal
  published calendars: 6-digit `TZOFFSETFROM`/`TZOFFSETTO` seconds, `RECURRENCE-ID`
  overrides sharing a master UID, or the `CALDAVJ` `PRODID`. Those remain
  **unverified** pending a capture from Alex's own iCloud published calendar.

## canvas-sample.ics — TODO, not captured this session

Alex's Canvas calendar feed (personal capability URL,
`https://<institution>.instructure.com/feeds/calendars/<token>.ics`) was not
available this session. Per the sourcing rule, this must come from Alex's own
Canvas account — it cannot be sourced from any public repo/forum capability URL.
**Task 3/4 must treat Canvas format claims in
`docs/superpowers/reviews/2026-07-28-v4-provider-format-notes.md` (marked
"Concrete", sourced from `instructure/canvas-lms` source + spec suite) as
code-verified but not yet fixture-verified against Alex's real feed.**

TODO(Alex): provide your Canvas public-feed URL (Canvas → Calendar → Calendar
Feed → "click here to generate a private feed") or the resulting `.ics` file
directly, so it can be captured as `canvas-sample.ics`.

## outlook-sample.ics — TODO, not captured this session

Alex's Outlook.com published-calendar feed (personal capability URL,
`https://outlook.live.com/owa/calendar/<token>/calendar.ics`) was not available
this session. Per the sourcing rule, this must come from Alex's own Outlook
account. This is the highest-risk unknown noted in
`docs/superpowers/reviews/2026-07-28-v4-provider-format-notes.md`: Windows
timezone names (`W. Europe Standard Time`) vs IANA TZIDs, `DURATION` vs `DTEND`,
and RRULE shapes are all **unconfirmed**. Per the task brief, Tasks 3–4 must treat
Outlook TZID behavior as unconfirmed and rely on the CLDR windowsZones map to
cover both outcomes until this fixture exists.

TODO(Alex): in Outlook.com, Settings → Calendar → Shared calendars → "Publish a
calendar" → copy the ICS link (or export/share the resulting `.ics` file
directly), so it can be captured as `outlook-sample.ics`.
