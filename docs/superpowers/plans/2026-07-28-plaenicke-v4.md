# plaenicke V4 — Linked Calendars — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: DRAFT — do not execute until Alex approves the spec and this plan.**

**Goal:** External calendar feeds (Google secret iCal address, iCloud public calendar,
Outlook published calendar, Canvas calendar feed, any ICS URL) render as read-only
events in all four views, managed from Settings → Linked calendars.

**Architecture:** Worker proxies the feed fetch (`GET /feed`); a new pure `js/ics.js`
parses ICS and lazily expands recurrences per viewed range; feeds + parsed caches live
in two new localStorage keys via `js/storage.js`; a merge layer feeds views
`ownItems + externalInstances`. No OAuth, no server-side state.

**Tech Stack:** Vanilla ES modules, `node --test` (zero deps), Cloudflare Worker,
GitHub Pages PWA.

**Spec:** `docs/superpowers/specs/2026-07-28-plaenicke-v4-design.md` — read it first.

> **Post-DA-review revision (2026-07-28):** this plan was reworked against
> `docs/superpowers/reviews/2026-07-28-v4-da-review.md` (all 7 Criticals + 9 Majors
> applied) and `…/2026-07-28-v4-provider-format-notes.md`. Read both with the spec.

## Global Constraints

- **Zero fallback:** unparseable/unsupported events are never silently dropped —
  they land in `skipped: [{uid, summary, reason}]` and surface (with titles) in the
  feed's settings row.
- `js/storage.js` stays the only file touching localStorage (gains feed/cache keys).
- External events NEVER enter `plaenicke.items`. Instances carry `external: true`,
  `feedId`, `feedColor`; no delete ×, no editing anywhere.
- Pure logic modules have zero DOM access; rendering modules stay thin. TDD for all
  pure logic; style follows existing tests (`node:test` + `assert/strict`).
- Times remain 24h `"HH:MM"` strings, `null` = untimed, matching V3. Overnight
  external events are split into per-day segments at expansion time (own items still
  can't span midnight).
- The Worker must never log feed URLs (they're capability tokens). `/feed` requires
  a matching `Origin` header (403 otherwise), accepts https only, rejects
  private-network hosts and non-standard ports, follows redirects manually (≤3 hops,
  revalidating each), rejects non-`BEGIN:VCALENDAR` bodies (422) and bodies over
  1 MB (413), and honors `Cache-Control: no-cache` (manual sync bypasses the edge
  cache). `POST /` and `OPTIONS` behavior must not change (regression-tested).
- All feed-cache localStorage writes are wrapped; `QuotaExceededError` triggers the
  spec's prune policy and surfaces in the feed's status row.
- Test fixtures come ONLY from provider-official public feeds or Alex's own
  calendars — never from tokenized capability URLs found in public repos or
  anywhere else (that is other people's private data).
- Root `npm test` and `cd worker && npm test` green at every commit; commit after
  every green task (`feat:`/`fix:`/`docs:` style).
- App never blocks on the network: views render from cache instantly; sync updates
  arrive via re-render.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tests/fixtures/*.ics` | create | Byte-exact real captures (Task 0) — provider-official/Alex-owned only |
| `js/storage.js` | modify | `plaenicke.feeds` + `plaenicke.feedCache` load/save/validate, quota-wrapped |
| `js/ics.js` | create | Pure ICS: unfold, parse props, dates/TZ (`zonedWallClockToInstant`), VEVENTs, `expandEvents(parsed, start, end, targetTz)` |
| `js/tzmap.js` | create | Static CLDR windowsZones → IANA map (~130 entries) |
| `js/feeds.js` | create | Feed orchestration: sync policy, worker fetch, cache write, status; injected fetch for tests |
| `js/app.js` | modify | Wiring: merged item source for views, background sync on load, re-render on sync |
| `js/settings.js` | modify | Live Linked calendars section (add/remove/sync/status/color) |
| `js/dayview.js` / `js/weekview.js` / `js/calendar.js` | modify | Accept external instances (feed color accent, no ×) |
| `js/config.js` | none | `WORKER_URL` reused for `/feed` |
| `styles.css` | modify | Feed rows in settings, external-item accents (tokens only) |
| `service-worker.js` | modify | Precache new modules, bump cache name (LAST code task) |
| `worker/src/index.js` | modify | Thin wiring only: route `POST /` (smart add) + `GET /feed` → feed.js |
| `worker/src/feed.js` | create | `handleFeed(request, {fetchImpl, cache})` — validation, Origin check, redirect loop, size cap, caching; effects injected (testable, like prompt.js/normalize.js) |
| Tests | create/modify | `tests/ics.test.js` (new, largest), `tests/feeds.test.js` (new), `tests/storage.test.js`, `worker/tests/feed.test.js` (new) |

Task order: fixtures (0) → storage (1) → ICS core (2–4) → worker route (5) → sync
orchestration (6) → merge + views (7) → settings UI (8) → precache/deploy/verify (9).
Tasks 2–4 are the TDD heart; 5 is independent of 2–4.

---

### Task 0: Real feed fixtures (BEFORE any parser code)

**Files:** create `tests/fixtures/google-holidays.ics`, `…/icloud-sample.ics`, plus
(with Alex) `canvas-sample.ics` / `outlook-sample.ics` or local-only equivalents.

**Rules:** provider-official public feeds (e.g. Google's public holiday calendars)
or Alex's own calendars ONLY. Never fetch tokenized capability URLs found in public
repos — that is someone else's private calendar. If Alex's Canvas/Outlook samples
aren't available yet, capture the two public ones now and leave explicit TODO
markers; Tasks 3–4 must then treat Outlook TZID behavior as unconfirmed (the
CLDR map covers both outcomes).

- [ ] Capture fixtures byte-exact (`curl -o`, no reformatting); strip nothing.
- [ ] Record per-fixture provenance (source URL if public, capture date) in a
      `tests/fixtures/README.md`.
- [ ] Skim each against the provider-format notes doc; note surprises there.
- [ ] Commit.

### Task 1: Storage — feeds and feed cache

**Files:** modify `js/storage.js`; test `tests/storage.test.js`

**Interfaces:**
- Produces: `loadFeeds()/saveFeeds(feeds)`, `loadFeedCache()/saveFeedCache(cache)`.
  Deserialize validates shape (feed: string `id`/`url`/`name`/`color`, boolean
  `hidden`; cache entries: `fetchedAt` string, `events` array, `skipped` array) and
  drops invalid records the same defensive way `deserializeItems` does. Corrupt JSON
  → empty default. `saveFeedCache` wraps the write and throws a typed `QuotaError`
  on `QuotaExceededError` so feeds.js (the single prune owner) can react; plain
  `saveFeeds` failures propagate a clear error too.

- [ ] Failing tests: round-trip both keys; corrupt JSON → `[]`/`{}`; invalid records
      filtered; cache entry for an unknown feed id is preserved (pruning is feeds.js's
      job, not storage's); quota failure surfaces as `QuotaError` (fake localStorage
      that throws).
- [ ] Implement; keep `plaenicke.` key prefix convention.
- [ ] `npm test` green; commit.

### Task 2: ICS core — unfolding, properties, escaping

**Files:** create `js/ics.js`; test `tests/ics.test.js`

**Interfaces:**
- Produces (internal but exported for tests): `unfoldLines(text)` — RFC 5545 unfolding
  (CRLF or LF + leading space/tab); `parseProperty(line)` →
  `{ name, params: {TZID?, VALUE?, …}, value }` handling quoted params and multiple
  params; `unescapeText(v)` (`\\,` `\\;` `\\n` `\\\\`).

- [ ] Failing tests: folded SUMMARY across 3 lines; `DTSTART;TZID=America/New_York:20260901T090000`;
      quoted param `CN="Doe, John"`; escaped commas/newlines in SUMMARY; LF-only input.
- [ ] Implement; green; commit.

### Task 3: ICS dates — all DTSTART/DTEND forms → local date/time

**Files:** modify `js/ics.js`; test `tests/ics.test.js`

**Interfaces:**
- Produces (all take an explicit `targetTz` — NO `process.env.TZ`, no ambient zone;
  `app.js` passes `Intl.DateTimeFormat().resolvedOptions().timeZone`, tests pass
  fixed zones):
  - `zonedWallClockToInstant(parts, tzid)` → epoch ms. This is the **inverse** of
    `Intl.DateTimeFormat` (which maps instant → wall clock), implemented by offset
    probing (probe, format into tzid, measure residual, re-probe, verify). Written
    DST policies: ambiguous wall time (fall-back) → **first occurrence / DST
    offset**; nonexistent wall time (spring-forward gap) → **shift forward by the
    gap width**. Separately exported and tested.
  - `resolveTzid(raw)` → IANA name: passthrough if `Intl` accepts it, else CLDR
    windowsZones lookup via `js/tzmap.js` (`"W. Europe Standard Time"` →
    `"Europe/Berlin"`), else throw `UnknownTz` (caller skips the event with reason
    `unknown_tz` — zero fallback, no guessing).
  - `icsDateToLocal(value, params, targetTz)` → `{ date, time }` handling UTC `Z`,
    TZID, floating (= targetTz wall time), `VALUE=DATE` (→ `time: null`).

- [ ] Failing tests: each form; conversion between two fixed zones
      (`America/New_York` event → `America/Los_Angeles` target); DST fall-back
      ambiguity policy; spring-forward gap policy; `Australia/Sydney`
      (southern-hemisphere DST sign); Windows TZID maps correctly; garbage TZID →
      `UnknownTz`.
- [ ] Implement (`js/tzmap.js` generated from CLDR windowsZones, committed static);
      green; commit.

### Task 4: VEVENTs, RRULE expansion, skipped accounting

**Files:** modify `js/ics.js`; test `tests/ics.test.js`

**Interfaces:**
- Produces: `parseICS(text)` → `{ events: [ParsedEvent], skipped: [{uid, summary,
  reason}] }` (ParsedEvent: `uid,title,dtstart,dtend,duration,rrule,exdates,
  recurrenceId,form` — compact, JSON-serializable, per spec).
  `expandEvents(parsed, rangeStartISO, rangeEndISO, targetTz)` → `[EventInstance]`
  (`{uid,title,date,time,endTime}` — feeds.js stamps id/createdAt/feedId/feedColor/
  external).
- **RRULE three-list policy (spec section is normative):** supported = FREQ
  DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL **with cycle phase computed from DTSTART**,
  weekly BYDAY lists, ordinal monthly/yearly BYDAY (`2TU`, `-1FR`), single
  BYMONTHDAY, BYMONTH, UNTIL, COUNT. Ignorable: `WKST` (except WEEKLY+INTERVAL>1+
  multi-BYDAY with non-MO value → skip `unsupported_wkst`), `X-*`. Everything else →
  skip with reason. No permissive catch-all.
- End resolution: DTEND > DURATION > neither (DATE → one day; DATE-TIME →
  `endTime: null`); `DTEND == DTSTART` → `endTime: null` (Canvas's timed shape).
- `UNTIL` compared on absolute instants (UTC form as-is; DATE form = end of that day
  in event zone; naive-local in event TZID). `EXDATE` (comma-joined AND repeated
  lines) removes instances; `RECURRENCE-ID` events replace their master's instance.
- Overnight timed events (≤2 days) split into per-day segments; >2-day timed events
  → one untimed instance per covered day; multi-day all-day → one untimed instance
  per covered day (DTEND exclusive per RFC).
- `COUNT` rules iterate from DTSTART (bounded by COUNT), then filter to range;
  UNTIL/unbounded rules iterate only within the requested range **after phase
  alignment to DTSTART**.

- [ ] Failing tests (the big matrix): single timed event in/out of range; weekly
      `BYDAY=MO,WE,FR` with `UNTIL` **and `WKST=SU` present** (real Google shape —
      must expand, not skip); `COUNT=5` partially before range; `INTERVAL=2` weekly;
      **`INTERVAL=3` weekly with range starting 10 weeks after DTSTART — instances
      on weeks 12 and 15, not 10 and 13** (phase test); monthly on the 31st (months
      without a 31st produce no instance — no clamping); `BYDAY=2TU` monthly;
      `BYDAY=-1FR` monthly; "5th Monday" month with none → no instance; yearly;
      UNTIL `Z`-form landing mid-local-day → boundary instance excluded; EXDATE both
      forms; RECURRENCE-ID moves one; DURATION `PT1H` → end computed;
      `DTEND==DTSTART` → `endTime: null`; overnight 23:00–01:00 → two segments;
      4-day timed → four untimed instances; 3-day all-day → three untimed instances;
      `BYSETPOS` rule → `skipped` with summary present; malformed DTSTART → skipped
      `bad_date`; **parse each Task-0 fixture end-to-end asserting `skipped` is
      empty or exactly the expected set**.
- [ ] Implement; green; commit. This is the largest task — keep expansion functions
      small and separately exported/tested (e.g. `nextWeeklyInstances`,
      `nthWeekdayOfMonth`, `applyExdates`).

### Task 5: Worker — `GET /feed` proxy route

**Files:** create `worker/src/feed.js`; modify `worker/src/index.js` (thin wiring
only); test `worker/tests/feed.test.js` (new)

**Interfaces:**
- `worker/src/feed.js` exports `handleFeed(request, { fetchImpl, cache })` — ALL
  effects injected (there is no precedent for testing `index.js` itself in this
  repo; `caches.default` and Workers `fetch` don't exist under `node --test`, so the
  testable surface must be this pure-ish module, mirroring how `prompt.js`/
  `normalize.js` split out of `index.js`).
- Behavior, in order: `Origin` header must equal `ALLOWED_ORIGIN` → else 403
  `forbidden`; `url` param must parse, be `https:`, standard port, and not
  private/loopback/link-local → else 400 `bad_url`; fetch with
  `redirect: 'manual'`, follow ≤3 hops re-running the FULL validation each hop →
  violating hop 400, >3 hops 400 `too_many_redirects`; 413 `feed_too_large` (>1 MB);
  422 `not_an_ics_feed` (body doesn't start `BEGIN:VCALENDAR` after BOM/ws strip);
  502 `upstream_unreachable`/`upstream_error`; 200 → `content-type: text/calendar`
  passthrough with CORS headers. Cache: `cache` keyed on target URL, TTL ~15 min;
  request `Cache-Control: no-cache` bypasses (manual Sync now). No logging of the
  URL anywhere.
- `index.js`: route on pathname; `POST /` + `OPTIONS` byte-identical to today.

- [ ] Failing tests (injected fetch/cache fakes): Origin missing/wrong → 403; http
      URL → 400; `192.168.1.1`/`localhost`/port `:8080` → 400; redirect https→https
      followed (iCloud shape); redirect to http/private → 400; 4 hops → 400;
      oversize → 413; HTML body → 422; happy path → 200 + cache write; `no-cache` →
      cache skipped; **regression: `POST /` and `OPTIONS` responses unchanged**.
- [ ] Implement; `cd worker && npm test` green; commit. (Deploy happens in Task 9,
      with Alex. Cloudflare dashboard rate-limit rule on `/feed` is Alex's
      account-level step — punchlist.)

### Task 6: Feed sync orchestration — `js/feeds.js`

**Files:** create `js/feeds.js`; test `tests/feeds.test.js`

**Interfaces:**
- Consumes: storage (Task 1), ics (Tasks 2–4), `WORKER_URL`.
- Produces: `syncFeed(feed, {fetchImpl, now, manual})` → fetches `/feed` (manual
  sync sends `Cache-Control: no-cache`), parses, writes cache entry, returns
  `{ok, skipped}` or `{ok:false, error}` (cache untouched on failure — last-good
  stays); on `QuotaError` from storage: prune events outside [today−30d, today+366d]
  across cached feeds, retry once, then drop the largest feed's cache — recording
  what happened in that feed's status. `syncStale(feeds, cache, {maxAgeMin=30,…})`
  syncs only stale feeds; **feeds.js is the single owner of cache pruning** —
  removing a feed calls its `removeFeed(id)` which deletes feed + cache entry
  (settings.js only calls it). `feedStatus(feed, cacheEntry, now)` → display string
  (**"fetched 5m ago"** — not "synced"; "2 skipped: 'Statics Lecture' —
  unsupported recurrence"; quota-prune note; error text).
  `instancesForRange(feeds, cache, start, end, targetTz)` → expanded instances,
  **excluding `hidden` feeds**, stamped with `id`, `createdAt`, `feedId`,
  `feedColor`, `external: true` (per the spec's EventInstance contract);
  `webcalToHttps(url)`; `inferName(url)`. All effects via injected `fetchImpl`/`now`
  so tests are pure.

- [ ] Failing tests: sync success writes cache + preserves others; failure keeps
      last-good and reports error; manual flag sends `no-cache`; quota path prunes →
      retries → drops + surfaces; staleness boundary (29 vs 31 min); hidden feed
      excluded; status strings incl. skipped titles; instance stamping (id/createdAt/
      external); removeFeed removes both; webcal conversion; name inference incl.
      unknown host → "Calendar".
- [ ] Implement; green; commit.

### Task 7: Merge into views

**Files:** modify `js/app.js`, `js/dayview.js`, `js/weekview.js`, `js/calendar.js`
(only if signatures need it); test: existing view logic tests extended where pure
(e.g. `chronoFirst` over mixed own/external), rest via click-through.

**Interfaces:**
- `app.js` builds `visibleItems(range)` = own items + `instancesForRange(...)`; all
  four views consume the merged array. **List view's external range is today →
  today+366d** with a trailing "external calendars shown through <date>" note (own
  items past it still render). External instances render with feed-color accent (new
  CSS tokens; every `'type-' + …` class site branches on `external` — two of the
  five sites are inline in `app.js`'s `renderList`/`renderCalendar`), no × in Day
  view, not deletable in List view; month chips and week blocks use feed color.
  **`monthCellSummary` guarantees ≥1 chip for own items when any exist that day.**
  On-load `syncStale` runs async and re-renders once when syncs settle.

- [ ] Extend pure tests: `sortItemsByDate` over mixed own/external arrays is
      **order-independent** (permutation test — would have caught the comparator
      hole); `chronoFirst`/`monthCellSummary` with external items + own-chip
      guarantee.
- [ ] Wire rendering; `node --check` all modified modules; manual browser sanity
      check with a fixture feed served locally.
- [ ] Green; commit.

### Task 8: Settings — Linked calendars live

**Files:** modify `js/settings.js`, `styles.css`; test: pure helpers already covered
by Task 6; DOM via click-through.

- Replace the placeholder section: feed rows (color dot, name, **Show/Hide
  toggle**, status via `feedStatus`, Sync + Remove buttons), "Add calendar" (URL
  paste + optional name; `webcalToHttps` applied; immediate first manual sync with
  inline result). Color auto-assigned from a fixed 6-color token palette, tap dot
  to cycle. Remove calls `feeds.removeFeed(id)` (single prune owner) and
  re-renders views.

- [ ] Implement; `node --check`; click-through in browser (add fixture feed URL,
      bad URL error path, remove).
- [ ] Green; commit.

### Task 9: Precache, deploy, live verification (WITH ALEX)

**Files:** modify `service-worker.js` (add `js/ics.js`, `js/tzmap.js`,
`js/feeds.js`; bump cache name).

- [ ] Precache + bump; root tests green; commit.
- [ ] Deploy worker (`cd worker && npx wrangler deploy`) — remember ~20s edge
      propagation before verifying.
- [ ] Push `main` → Pages deploy.
- [ ] **On-device with Alex** (feed URLs are secrets — pasted only on his phone):
      add real Google / iCloud / Outlook / Canvas feeds; verify events land in all
      four views; verify skipped-count surfacing; verify offline renders cached
      events; delete + re-add home-screen icon not needed (no manifest change).

## Out of scope

Per spec: no OAuth/two-way sync, no server-side storage, no per-event hide/edit, no
VTODO, no notifications. Backlog lives in the spec's second half.
