# plaenicke home screen — stages 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Stage 1 — a read-only line on every Settings calendar row that says how that calendar's cached events repeat and whether stage 3a would read it by RRULE or by the Canvas heuristic, so Alex can report LMU Classes' numbers (the stage 3a precondition). Stage 2 — the visual foundation: colour, spacing and radius tokens, a press state on touch-down, 16 px on every input, and the new screens' type scale defined without touching Month, Week or Day.

**Architecture:** Stage 1 adds two pure functions to `js/feeds.js` — `feedShape(events, targetTz)` (counts) and `describeFeedShape(shape)` (the line) — and one render site in `js/settings.js` that reads only `feedCache[feed.id].events`. Nothing is stored, synced or fetched. Stage 2 is `styles.css` tokens and rules, pinned by `tests/styles.test.js` through its `declOf`/`ruleExists`/`px` helpers (which read the WINNING declaration), plus one new module `js/press.js` installed once by `js/app.js`.

Decisions this plan makes where the spec is silent or would not work as written (each is a test below; confirm or edit):

- **`feedShape` takes a second argument, `targetTz`.** The spec writes `feedShape(entry.events)`. Canvas stamps every time in UTC (`DTSTART:...Z`, `docs/superpowers/reviews/2026-07-28-v4-provider-format-notes.md`), so a 10:00 Pacific class is 17:00Z until 1 Nov 2026 and 18:00Z after. Read in UTC it splits into two guessed series; read in the device zone (the zone `instancesForRange` already expands in, `app.js:99`) it is one. Settings passes `Intl.DateTimeFormat().resolvedOptions().timeZone`, as `app.js:99` does.
- **How yearly and monthly RRULEs are counted in the readout:** as their own count, `N yearly/monthly (shown as one-offs)`, left out when zero. They are not counted as "repeat", because § 2.4 says only `FREQ=DAILY`/`WEEKLY` repeat. RECURRENCE-ID overrides of a daily or weekly series are counted as `N changed instances` (left out when zero). Overrides of a yearly or monthly series go in the yearly/monthly count. A master-less override is `single`. Every event is counted exactly once, so the counts add up to the total.
- **"Uses the rule" means the feed has an RRULE of any FREQ.** § 2.4: the heuristic "applies only to a feed with no RRULE at all". So a Canvas-shaped feed with one `FREQ=YEARLY` birthday uses the rule, and its weekly classes show as single.
- **The heuristic never groups an untimed (all-day) event.** § 2.4 groups on "same title, weekday and start time"; an all-day event has no start time.
- **Wording.** The line ends `Uses the rule.` or `Uses the heuristic.`; a synced empty calendar reads `No events to classify.`; a calendar that has never synced, or whose cache was quota-dropped, gets no line.
- **Stage 2 defines the spacing tokens but does not re-space existing rules.** Re-spacing every padding would move Month/Week/Day layouts, which § 5 keeps compact. Radii are applied to controls (`button`, `.icon-btn` and every input, select and textarea rule) and to `.sheet`. Containers (cards, list rows, panels, the day grid) keep their own radius.
- **The tap highlight is made transparent on `button, [data-press]` only**, the elements `.pressed` replaces it on. Links (`.sheet-google`) and checkboxes keep the native highlight; it is their only tap feedback.
- **The type scale ships in stage 2 as tokens only.** Its first consumer is stage 3b.

**Tech Stack:** Vanilla ES modules, no framework, no build step, no bundler; `node:test` + `node:assert/strict`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-plaenicke-home-screen-design.md` (§ 2.4 and § 8 stage 1; § 5 and § 8 stage 2).

Work in `/Users/ajaenicke25/projects/plaenicke` on branch `home-screen-design` (main d7b3b30 merged in at f25d72a). The baseline is `npm test` → `# tests 1265`, `# fail 0`, `# cancelled 0`.

---

## Global Constraints

- Tests: "`npm test` is `node --test` with no arguments and it RECURSES." "`node --test tests/` runs ZERO tests … Never use it." One file: `node --test tests/<file>.test.js`.
- Commits: "Gate a commit on `# fail 0` AND `# cancelled 0`." Every commit step below uses this gate verbatim: `npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add … && git commit …`
- Every commit message ends `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- "Node 22 has no `localStorage`. Any storage-touching test must call `installFakeLocalStorage()` from `tests/fake-localstorage.js`." (`tests/settings.test.js`'s `openPanel` already does.)
- "`tests/fake-dom.js` is the shared fake DOM, and its `getElementById` returns `null` for an unmounted id." It has no `closest()` and no event dispatch, so `tests/press.test.js` keeps its own fakes.
- "`apply.test.js` installs an offline `fetch` at the top of the file. … Keep it." `import './offline-fetch.js'` stays its first import; the one test this plan adds there goes at the end of the file. No new test file here reaches the network.
- Mock timers in `apply.test.js`: "use `enableMockTimers(t, …)` / `await resetMockTimers(t)` … not `t.mock.timers.enable`/`reset` directly." No task here uses them; a task that starts to must follow this.
- "**Feed URLs are never rendered or logged.** Today rows, the sheet and the stage-1 readout show the calendar name only" (spec § 6). Errors are logged "by error NAME only" (`feeds.js` `instancesForRange`).
- "**Service worker:** new modules into `ASSETS`, `CACHE` bumped, `serviceworker.test.js` re-pinned (incl. stale `CACHE_ON_MAIN`)" (spec § 6). "RE-PIN THIS TO main's VALUE ON EVERY RELEASE" (`tests/serviceworker.test.js:48`).
- "**There is no CI workflow. GitHub Pages serves `main` directly, so merging to `main` IS the deploy.** Treat a merge as a production release." No merge to `main` and no push without Alex's explicit go-ahead in the conversation.
- Per-device, never synced: "the feed cache is not synced at all", and `color`/`hidden` "are per-device preferences that toWire strips" (`settings.js`). "**No new item fields**" and "**Sync is untouched** (`sync.js`, `merge.js`, `schemaVersion`, ownership, visibility gate)" (spec § 6).
- "**16 px on every input.**" (spec § 5) — "a form control under 16px makes Safari zoom the whole page on focus" (`tests/styles.test.js`).
- "**Month and Week keep their compact sizes.**" (spec § 5); "Existing type sizes kept" (spec § 8 stage 2).
- "**Press state:** one delegated `pointerdown` listener adds `.pressed` to the nearest `button, [data-press]`; `pointerup`, `pointercancel`, `pointerleave` and a `pointermove` beyond 10 px (a scroll) remove it. … Rows get `--chip-bg`, buttons opacity 0.7 … `touch-action: manipulation` on `html`. A class, not `:active`" (spec § 5).
- "`--overdue-start` (… `#9c5418` light, `#e39a52` dark …)" and "New tokens are defined in both themes" (spec § 2.3, § 5) — colour tokens; spacing and radii are theme-independent and defined once (Task 5 pins that).
- Reduced motion: "Motion: 200 ms ease-out (capture box 250 ms), `transform`/`opacity` only. Nothing else animates. Under `prefers-reduced-motion` the box only fades." Stages 1–2 add no motion; Task 9 pins that the stylesheet declares none.
- "Vanilla ES modules — **no framework, no build step, no bundler.**" No new dependencies.
- `ics.js` keeps its behaviour ("`ics.js` is unchanged (spares `tests/ics.test.js`'s 142 deep-equality asserts)"). Task 1 edits one stale comment there and nothing else.
- Mutation-check every new assertion: plant the named mutant, see the named test fail, restore it, and confirm with `git diff` that nothing is left over. "Reading finds shape errors; running finds real ones."

---

## Review Focus

Five inputs or conditions the spec implies but that the ordinary tests of each task would probably not cover. These are the ones most likely to catch Alex out first. Each one's test is already written into the task that owns it.

1. **A calendar with no events to classify: synced but empty, quota-dropped, or never synced.** All three have `events: []` or no entry, and only the first is really an empty calendar. A quota drop empties the events "to free storage" (`feeds.js` `dropLargestFeed`), and a line counting them would say the calendar is empty. Tests: Task 1 `feedShape: an empty cache has nothing to classify, and says so`; Task 2 `settings: a synced calendar with no events says there is nothing to classify`, `settings: no shape line after a quota drop — the empty cache is not the calendar`, `settings: no shape line before a calendar's first sync`.
2. **An RRULE written in another form, and FREQ=YEARLY/MONTHLY next to FREQ=WEEKLY.** `ev.rrule` is the raw RRULE text as the feed wrote it (`ics.js:913`, `:984`). `parseRRule` upper-cases the key and the value (`ics.js:510`, `:515`), so `freq=weekly` and `INTERVAL=2;FREQ=WEEKLY` are both stored and both mean weekly. A yearly override must not count as a weekly change, and one yearly RRULE switches a Canvas-shaped feed to the rule. Tests: Task 1 `feedShape: only FREQ=DAILY and FREQ=WEEKLY repeat, however the RRULE is written`, `feedShape: overrides belong to their series; a master-less override is single`, `feedShape: one RRULE of any FREQ switches the heuristic off for the whole feed`.
3. **A UTC-stamped Canvas class across the 1 Nov 2026 DST change.** It is one class to Alex but two UTC times. Test: Task 1 `feedShape: a UTC-stamped weekly class stays one series across the DST change`.
4. **Dark-mode contrast of the new orange, and orange ≠ red.** `--overdue-start` has no consumer until stage 3b, so nothing on screen would show a bad value before then. Tests: Task 4 `[data-theme="dark"]: --overdue-start reads at WCAG AA (4.5:1) on --bg and on --card` (computed from the declared values), `… is not --danger`. Telling red from orange apart by eye stays on the on-device checklist (Task 10).
5. **Press state during a scroll.** A finger that lands on a button and then scrolls must not leave it dimmed. A 10 px wobble is still a tap, a second finger must not end the first one's press, and a non-passive listener would block scrolling. Tests: Task 8 `press: a move of exactly 10px keeps the press; past it, the press ends`, `press: pointercancel ends the press`, `press: only the pointer that pressed can end it`, `press: listens in the capture phase and passively, so it can never block a scroll`.

---

# Stage 1 — feed-shape readout (spec § 8 stage 1)

### Task 1: `feedShape` and `describeFeedShape` (pure)

**Files:**
- Modify: `js/feeds.js:16` (import), insert a new section between `feedStatus` (ends `js/feeds.js:426`) and the `instancesForRange` section header (`js/feeds.js:428-430`)
- Modify: `js/ics.js:352` (one stale comment)
- Modify: `tests/feeds.test.js:3-6` (import), append after `tests/feeds.test.js:891`

**Interfaces:**
- Consumes: `icsDateToLocal(value, params, targetTz) -> { date: 'YYYY-MM-DD', time: 'HH:MM' | null }` from `js/ics.js:353`; ParsedEvent `{ uid, title, form: 'DATE'|'UTC'|'TZID'|'FLOATING', dtstart: { value, tzid }, dtend, duration, rrule: string|null, exdates, recurrenceId: { value, tzid }|null }` (`js/ics.js:1004-1013`).
- Produces:
  - `export const REPEATING_FREQS` — `Set(['DAILY', 'WEEKLY'])`
  - `export const GUESS_MIN_WEEKS` — `3`
  - `export function feedShape(events, targetTz) -> { total, method: 'rule'|'heuristic', repeatingSeries, repeatingChanged, otherRuleEvents, guessedSeries, inGuessedSeries, single }` — the counts other than `guessedSeries` always sum to `total`.
  - `export function describeFeedShape(shape) -> string`

- [ ] **Step 1: Write the failing tests**

In `tests/feeds.test.js`, change the import at lines 3–6 to:

```js
import {
  syncFeed, syncStale, feedStatus, instancesForRange, removeFeed,
  webcalToHttps, inferName, applyRemoteFeeds, feedShape, describeFeedShape,
} from '../js/feeds.js';
```

Append to the end of `tests/feeds.test.js`:

```js

// --- feedShape (home-screen spec § 2.4, stage 1) -----------------------------
//
// A read-only classification of one feed's cache: which method stage 3a would
// use for it (the RRULE, or the Canvas heuristic) and what each counts. Alex
// reads its Settings line for LMU Classes before 3a starts.

// A ParsedEvent as parseICS stores it (ics.js buildParsedEvent).
function pe({ uid, title = uid, form = 'UTC', value, tzid = null, rrule = null, recurrenceId = null }) {
  return {
    uid, title, form, dtstart: { value, tzid }, dtend: null, duration: null,
    rrule, exdates: [], recurrenceId,
  };
}

// '2026-08-24' + n weeks -> 'YYYYMMDD'
function weeksAfter(firstISO, n) {
  const d = new Date(`${firstISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// `weeks` separate VEVENTs, one per week, each with its own UID and no RRULE:
// the Canvas shape (provider-format notes: "No RRULE, ever").
function canvasWeekly(title, firstISO, weeks, hhmm, tzid = 'America/Los_Angeles') {
  const out = [];
  for (let i = 0; i < weeks; i += 1) {
    out.push(pe({
      uid: `${title}-${i}`, title, form: 'TZID', tzid, value: `${weeksAfter(firstISO, i)}T${hhmm}00`,
    }));
  }
  return out;
}

const sumOf = (s) => s.repeatingSeries + s.repeatingChanged + s.otherRuleEvents + s.inGuessedSeries + s.single;

test('feedShape: an empty cache has nothing to classify, and says so', () => {
  const shape = feedShape([], 'UTC');
  assert.deepEqual(shape, {
    total: 0, method: 'heuristic', repeatingSeries: 0, repeatingChanged: 0, otherRuleEvents: 0,
    guessedSeries: 0, inGuessedSeries: 0, single: 0,
  });
  assert.equal(describeFeedShape(shape), 'No events to classify.');
});

test('feedShape: a rule feed reads as the spec\'s example line', () => {
  const events = [];
  for (let i = 0; i < 6; i += 1) {
    events.push(pe({ uid: `course-${i}`, value: '20260824T170000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' }));
  }
  for (let i = 0; i < 136; i += 1) events.push(pe({ uid: `one-${i}`, value: '20260901T170000Z' }));
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.method, 'rule');
  assert.equal(shape.repeatingSeries, 6);
  assert.equal(shape.single, 136);
  assert.equal(describeFeedShape(shape), '142 events: 6 repeat (RRULE), 136 single. Uses the rule.');
});

test('feedShape: only FREQ=DAILY and FREQ=WEEKLY repeat, however the RRULE is written', () => {
  const events = [
    pe({ uid: 'w-lower', value: '20260824T170000Z', rrule: 'freq=weekly' }),
    pe({ uid: 'w-second', value: '20260824T170000Z', rrule: 'INTERVAL=2;FREQ=WEEKLY' }),
    pe({ uid: 'd', value: '20260824T170000Z', rrule: 'FREQ=DAILY;COUNT=5' }),
    pe({ uid: 'y', value: '20260824T170000Z', rrule: 'FREQ=YEARLY' }),
    pe({ uid: 'm', value: '20260824T170000Z', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' }),
  ];
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.repeatingSeries, 3, 'lower-case, not-first and DAILY all count');
  assert.equal(shape.otherRuleEvents, 2, 'YEARLY and MONTHLY are one-offs (spec § 2.4, question 7)');
  assert.equal(shape.single, 0);
  assert.equal(describeFeedShape(shape),
    '5 events: 3 repeat (RRULE), 2 yearly/monthly (shown as one-offs), 0 single. Uses the rule.');
});

test('feedShape: overrides belong to their series; a master-less override is single', () => {
  const rid = (value) => ({ value, tzid: null });
  const events = [
    pe({ uid: 'class', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }),
    pe({ uid: 'class', value: '20260901T180000Z', recurrenceId: rid('20260831T170000Z') }),
    pe({ uid: 'class', value: '20260908T180000Z', recurrenceId: rid('20260907T170000Z') }),
    pe({ uid: 'bday', value: '20260824', form: 'DATE', rrule: 'FREQ=YEARLY' }),
    pe({ uid: 'bday', value: '20260825', form: 'DATE', recurrenceId: rid('20260824') }),
    pe({ uid: 'orphan', value: '20260910T170000Z', recurrenceId: rid('20260910T170000Z') }),
  ];
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.repeatingSeries, 1);
  assert.equal(shape.repeatingChanged, 2);
  assert.equal(shape.otherRuleEvents, 2, 'a yearly override is a yearly one-off too');
  assert.equal(shape.single, 1, 'expanded alone (ics.js), it has no FREQ');
  assert.equal(describeFeedShape(shape),
    '6 events: 1 repeat (RRULE), 2 changed instances, 2 yearly/monthly (shown as one-offs), 1 single. Uses the rule.');
});

test('feedShape: one RRULE of any FREQ switches the heuristic off for the whole feed', () => {
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 5, '1000'),
    pe({ uid: 'bday', value: '20260824', form: 'DATE', rrule: 'FREQ=YEARLY' }),
  ];
  const shape = feedShape(events, 'America/Los_Angeles');
  assert.equal(shape.method, 'rule');
  assert.equal(shape.guessedSeries, 0, 'its RRULE-less events stay one-offs, never guessed');
  assert.equal(shape.single, 5);
  assert.equal(shape.otherRuleEvents, 1);
});

test('feedShape: a Canvas-shaped feed reads as the spec\'s heuristic example line', () => {
  const tz = 'America/Los_Angeles';
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 20, '1000'),
    ...canvasWeekly('Stats 101', '2026-08-26', 20, '1000'),
    ...canvasWeekly('Physics', '2026-08-25', 20, '0900'),
    ...canvasWeekly('Physics lab', '2026-08-27', 20, '1400'),
    ...canvasWeekly('Writing', '2026-08-28', 20, '1100'),
    ...canvasWeekly('Seminar', '2026-08-24', 18, '1500'),
  ];
  for (let i = 0; i < 18; i += 1) events.push(pe({ uid: `quiz-${i}`, title: `Quiz ${i}`, value: '20260903T170000Z' }));
  const shape = feedShape(events, tz);
  assert.equal(shape.method, 'heuristic');
  assert.equal(shape.guessedSeries, 6, 'Stats on Monday and on Wednesday are two series');
  assert.equal(shape.inGuessedSeries, 118);
  assert.equal(shape.single, 18);
  assert.equal(describeFeedShape(shape),
    '136 events: no RRULE — 118 in 6 guessed series, 18 single. Uses the heuristic.');
});

test('feedShape: the heuristic needs 3 distinct weeks, not 3 events', () => {
  const twoWeeks = canvasWeekly('Stats 101', '2026-08-24', 2, '1000');
  const doubled = [...twoWeeks, ...twoWeeks.map((ev) => ({ ...ev, uid: `${ev.uid}-copy` }))];
  const shape = feedShape(doubled, 'America/Los_Angeles');
  assert.equal(shape.guessedSeries, 0, 'four events on two dates is two weeks');
  assert.equal(shape.single, 4);
  const three = feedShape(canvasWeekly('Stats 101', '2026-08-24', 3, '1000'), 'America/Los_Angeles');
  assert.equal(three.guessedSeries, 1, 'three weeks is a series');
  assert.equal(three.inGuessedSeries, 3);
});

test('feedShape: the heuristic groups on title, weekday and start time — all three', () => {
  const tz = 'America/Los_Angeles';
  const base = canvasWeekly('Stats 101', '2026-08-24', 2, '1000');
  const cases = [
    ['another title', canvasWeekly('Stats 102', '2026-09-07', 1, '1000')],
    ['another weekday', canvasWeekly('Stats 101', '2026-09-08', 1, '1000')],
    ['another time', canvasWeekly('Stats 101', '2026-09-07', 1, '1100')],
  ];
  for (const [label, third] of cases) {
    const shape = feedShape([...base, ...third.map((ev) => ({ ...ev, uid: `${ev.uid}-x` }))], tz);
    assert.equal(shape.guessedSeries, 0, `${label}: no 3-week group`);
    assert.equal(shape.single, 3, label);
  }
});

test('feedShape: an untimed event has no start time, so it is never guessed', () => {
  const events = [0, 1, 2, 3].map((i) => pe({
    uid: `reading-${i}`, title: 'Reading response', form: 'DATE', value: weeksAfter('2026-08-28', i),
  }));
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.guessedSeries, 0);
  assert.equal(shape.single, 4);
});

// Canvas writes every time in UTC (`DTSTART:...Z`, provider-format notes). A
// 10:00 Pacific class is 17:00Z until 1 Nov 2026 and 18:00Z after it. Read in
// UTC that is two series with a gap; read in the device zone it is one.
test('feedShape: a UTC-stamped weekly class stays one series across the DST change', () => {
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    const day = weeksAfter('2026-09-21', i); // Mondays, 21 Sep .. 7 Dec
    const hour = day < '20261101' ? '17' : '18';
    events.push(pe({ uid: `stats-${i}`, title: 'Stats 101', value: `${day}T${hour}0000Z` }));
  }
  const local = feedShape(events, 'America/Los_Angeles');
  assert.equal(local.guessedSeries, 1, 'one class, one series');
  assert.equal(local.inGuessedSeries, 12);
  const utc = feedShape(events, 'UTC');
  assert.equal(utc.guessedSeries, 2, 'fixture check: the zone is what joins them');
});

test('feedShape: every event is counted exactly once', () => {
  const fixtures = [
    [...canvasWeekly('A', '2026-08-24', 4, '1000'), pe({ uid: 'x', value: '20260901', form: 'DATE' })],
    [pe({ uid: 'w', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }), pe({ uid: 'o', value: '20260824T170000Z' })],
  ];
  for (const events of fixtures) {
    const shape = feedShape(events, 'America/Los_Angeles');
    assert.equal(sumOf(shape), shape.total);
    assert.equal(shape.total, events.length);
  }
});

test('describeFeedShape: one event is singular', () => {
  assert.equal(describeFeedShape(feedShape([pe({ uid: 'o', value: '20260824T170000Z' })], 'UTC')),
    '1 event: no RRULE — 0 in 0 guessed series, 1 single. Uses the heuristic.');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/feeds.test.js`
Expected: the file fails to load — `SyntaxError: The requested module '../js/feeds.js' does not provide an export named 'describeFeedShape'`, `# tests 1`, `# fail 1`.

- [ ] **Step 3: Implement**

In `js/feeds.js`, change line 16 to:

```js
import { parseICS, expandEvents, parseDuration, icsDateToLocal } from './ics.js';
```

Insert this between the closing `}` of `feedStatus` (line 426) and the `// ----` line that opens the `instancesForRange` section (line 428):

```js
// ---------------------------------------------------------------------------
// feedShape — what kind of repeating events a feed's cache holds (spec § 2.4)
// ---------------------------------------------------------------------------

// Only these count as repeating (spec § 2.4, Decided, question 7). A MONTHLY
// or YEARLY series behaves as a one-off and stays in Next 7 days.
export const REPEATING_FREQS = new Set(['DAILY', 'WEEKLY']);
// The heuristic's threshold: same title, weekday and start time on this many
// distinct weeks or more (spec § 2.4).
export const GUESS_MIN_WEEKS = 3;

// freqOf: the FREQ value of a stored RRULE string, upper-cased, or null.
// ics.js stores the raw RRULE value (`ev.rrule`, already validated by
// parseRRule, which upper-cases both the key and the value before checking
// them), so 'freq=weekly' and 'INTERVAL=2;FREQ=WEEKLY' are both stored as
// written and both mean WEEKLY.
function freqOf(rrule) {
  if (typeof rrule !== 'string') return null;
  for (const segment of rrule.split(';')) {
    const eq = segment.indexOf('=');
    if (eq > 0 && segment.slice(0, eq).toUpperCase() === 'FREQ') return segment.slice(eq + 1).toUpperCase();
  }
  return null;
}

// feedShape: counts over one feed's cached ParsedEvents (`entry.events`).
// Pure: no storage, no network, no URL. `targetTz` is the device zone, the
// same one instancesForRange expands in: the heuristic's weekday and start
// time are read in it, so a Canvas class at 10:00 local stays one series
// across a DST change even though its UTC time moves by an hour.
//
//   method 'rule'       — the feed has at least one RRULE (any FREQ). The
//                         heuristic never runs on it (spec § 2.4).
//     repeatingSeries   masters with FREQ=DAILY or FREQ=WEEKLY
//     repeatingChanged  RECURRENCE-ID overrides whose master is one of those
//     otherRuleEvents   MONTHLY/YEARLY masters and their overrides (one-offs)
//     single            everything else, master-less overrides included
//   method 'heuristic'  — no RRULE anywhere in the cache.
//     guessedSeries     (title, weekday, start time) groups on >= 3 weeks
//     inGuessedSeries   events in those groups
//     single            everything else, untimed (all-day) events included
//
// The counts always sum to `total`.
export function feedShape(events, targetTz) {
  const shape = {
    total: events.length,
    method: events.some((ev) => typeof ev.rrule === 'string') ? 'rule' : 'heuristic',
    repeatingSeries: 0,
    repeatingChanged: 0,
    otherRuleEvents: 0,
    guessedSeries: 0,
    inGuessedSeries: 0,
    single: 0,
  };

  if (shape.method === 'rule') {
    // A series is (feedId, uid); this is one feed, so the uid alone.
    const freqByUid = new Map();
    for (const ev of events) {
      if (!ev.recurrenceId && typeof ev.rrule === 'string') freqByUid.set(ev.uid, freqOf(ev.rrule));
    }
    for (const ev of events) {
      const freq = freqByUid.get(ev.uid);
      const isMaster = !ev.recurrenceId && typeof ev.rrule === 'string';
      if (freq === undefined) shape.single += 1;
      else if (!REPEATING_FREQS.has(freq)) shape.otherRuleEvents += 1;
      else if (isMaster) shape.repeatingSeries += 1;
      else shape.repeatingChanged += 1;
    }
    return shape;
  }

  const groups = new Map();
  for (const ev of events) {
    if (ev.form === 'DATE') { shape.single += 1; continue; }
    const params = ev.dtstart.tzid ? { TZID: ev.dtstart.tzid } : {};
    const { date, time } = icsDateToLocal(ev.dtstart.value, params, targetTz);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const key = JSON.stringify([ev.title, weekday, time]);
    let group = groups.get(key);
    if (!group) { group = { dates: new Set(), count: 0 }; groups.set(key, group); }
    group.dates.add(date);
    group.count += 1;
  }
  for (const group of groups.values()) {
    if (group.dates.size >= GUESS_MIN_WEEKS) {
      shape.guessedSeries += 1;
      shape.inGuessedSeries += group.count;
    } else {
      shape.single += group.count;
    }
  }
  return shape;
}

// describeFeedShape: the Settings line for one feed (spec § 2.4). Names the
// calendar's method in words; never carries a URL (it has none to carry).
export function describeFeedShape(shape) {
  if (shape.total === 0) return 'No events to classify.';
  const events = `${shape.total} event${shape.total === 1 ? '' : 's'}`;
  if (shape.method === 'rule') {
    const parts = [`${shape.repeatingSeries} repeat (RRULE)`];
    if (shape.repeatingChanged > 0) {
      parts.push(`${shape.repeatingChanged} changed instance${shape.repeatingChanged === 1 ? '' : 's'}`);
    }
    if (shape.otherRuleEvents > 0) parts.push(`${shape.otherRuleEvents} yearly/monthly (shown as one-offs)`);
    parts.push(`${shape.single} single`);
    return `${events}: ${parts.join(', ')}. Uses the rule.`;
  }
  return `${events}: no RRULE — ${shape.inGuessedSeries} in ${shape.guessedSeries} guessed series, `
    + `${shape.single} single. Uses the heuristic.`;
}

```

In `js/ics.js`, replace line 352:

```js
// Test entry point into live code: nothing in js/ calls it; it wraps parseIcsDateValue + instantOfWallClock + formatZonedParts.
```

with:

```js
// Called by js/feeds.js's feedShape (the heuristic's local weekday and start time); it wraps parseIcsDateValue + instantOfWallClock + formatZonedParts.
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/feeds.test.js`
Expected: `# pass 63`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

Plant each mutant in `js/feeds.js`, run `node --test tests/feeds.test.js`, check that the named test fails, then restore the file (`git diff js/feeds.js` shows only this task's additions):

| Mutant | Must fail |
|---|---|
| `new Set(['DAILY', 'WEEKLY', 'YEARLY'])` | `only FREQ=DAILY and FREQ=WEEKLY repeat…`, `overrides belong to their series…`, `one RRULE of any FREQ…` |
| `method:` test becomes `events.some((ev) => REPEATING_FREQS.has(freqOf(ev.rrule)))` | `one RRULE of any FREQ switches the heuristic off…` |
| `group.dates.size >= GUESS_MIN_WEEKS` → `group.count >= GUESS_MIN_WEEKS` | `the heuristic needs 3 distinct weeks, not 3 events` |
| `icsDateToLocal(…, params, targetTz)` → `icsDateToLocal(…, params, 'UTC')` | `a Canvas-shaped feed reads as the spec's heuristic example line`, `a UTC-stamped weekly class stays one series across the DST change` |
| `freqOf` body → `if (segment.startsWith('FREQ=')) return segment.slice(5);` | `only FREQ=DAILY and FREQ=WEEKLY repeat…` |
| `else shape.repeatingChanged += 1;` → `else shape.single += 1;` | `overrides belong to their series…` |
| delete `if (ev.form === 'DATE') { shape.single += 1; continue; }` | `an untimed event has no start time…` |
| key `[ev.title, weekday, time]` → `[ev.title, weekday]` | `the heuristic groups on title, weekday and start time — all three` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/feeds.js js/ics.js tests/feeds.test.js && git commit -m "feat(feeds): feedShape — classify a feed's cache by RRULE or the Canvas heuristic" -m "Pure counts over entry.events in the device zone (home-screen spec § 2.4, stage 1). Only FREQ=DAILY/WEEKLY repeat; yearly/monthly are counted as one-offs; the heuristic runs only on a feed with no RRULE and never groups untimed events." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1277`, `# fail 0`, `# cancelled 0`, then the commit.

---

### Task 2: the per-feed Settings line

**Files:**
- Modify: `js/settings.js:13-15` (import), insert after `statusFor` (ends `js/settings.js:239`), modify `js/settings.js:389-395` (row assembly)
- Modify: `styles.css:411` (add one rule after `.feed-status`)
- Modify: append to `tests/settings.test.js` after line 653

**Interfaces:**
- Consumes: `feedShape(events, targetTz)`, `describeFeedShape(shape)` (Task 1); the panel's `feedCache` binding (`js/settings.js` `open()`); cache entry `{ fetchedAt, events, skipped, quotaPruned?, quotaDropped? }` (`js/feeds.js` `syncFeed`/`dropLargestFeed`).
- Produces: in each `li.feed-row`, a `div.feed-shape` directly after `div.feed-status`, when the feed has a cache entry that was not quota-dropped. No new export.

- [ ] **Step 1: Write the failing tests**

Append to `tests/settings.test.js`:

```js

// --- the feed-shape readout (home-screen spec § 2.4, stage 1) ---------------
//
// One read-only line per calendar row: how its cached events repeat and which
// method stage 3a would use. Alex reads it for LMU Classes.

const SHAPE_FEED = {
  id: 'feedS', url: 'https://calendar.example/private-token-abc/basic.ics', name: 'LMU Classes',
  color: 'var(--feed-palette-1)', hidden: false, updatedAt: '2026-07-01T00:00:00.000Z',
};

function shapeEvent(uid, value, rrule = null) {
  return {
    uid, title: uid, form: 'UTC', dtstart: { value, tzid: null }, dtend: null, duration: null,
    rrule, exdates: [], recurrenceId: null,
  };
}

function cacheWith(entry) {
  return () => saveFeedCache({ feedS: { fetchedAt: new Date().toISOString(), skipped: [], ...entry } });
}

function byClass(el, cls) {
  const out = [];
  const walk = (node) => { for (const c of node.children) { if (c._classes.has(cls)) out.push(c); walk(c); } };
  walk(el);
  return out;
}

test('settings: a synced calendar row says how its events repeat and which method it uses', () => {
  const events = [
    shapeEvent('stats', '20260824T170000Z', 'FREQ=WEEKLY;BYDAY=MO,WE'),
    shapeEvent('midterm', '20261015T170000Z'),
    shapeEvent('final', '20261210T170000Z'),
  ];
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events }));
  const lines = byClass(host, 'feed-shape');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, '3 events: 1 repeat (RRULE), 2 single. Uses the rule.');
  const row = byClass(host, 'feed-row')[0];
  const status = byClass(row, 'feed-status')[0];
  assert.equal(row.children.indexOf(lines[0]), row.children.indexOf(status) + 1, 'directly under the status line');
});

test('settings: the shape line never shows the calendar link', () => {
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events: [shapeEvent('a', '20260824T170000Z')] }));
  assert.ok(byClass(host, 'feed-shape').length === 1, 'fixture check: the line is there');
  const text = allText(host);
  assert.ok(!text.includes('private-token-abc'), 'the capability token is never rendered');
  assert.ok(!text.includes('calendar.example'), 'nor the host');
});

test('settings: no shape line before a calendar\'s first sync', () => {
  const { host } = openPanel([SHAPE_FEED]);
  assert.match(allText(host), /not yet synced/, 'fixture check');
  assert.equal(byClass(host, 'feed-shape').length, 0);
});

test('settings: a synced calendar with no events says there is nothing to classify', () => {
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events: [] }));
  assert.equal(byClass(host, 'feed-shape')[0].textContent, 'No events to classify.');
});

test('settings: no shape line after a quota drop — the empty cache is not the calendar', () => {
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events: [], quotaDropped: true }));
  assert.match(allText(host), /storage limit reached/, 'fixture check: the status explains the drop');
  assert.equal(byClass(host, 'feed-shape').length, 0);
});

test('settings: a cache the readout cannot read says so on its row, logs the error name only, and the panel still works', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const other = { ...SHAPE_FEED, id: 'feedO', name: 'Other' };
  const { host } = openPanel([SHAPE_FEED, other], () => saveFeedCache({
    feedS: { fetchedAt: new Date().toISOString(), skipped: [], events: [{ uid: 'broken', title: 'Broken' }] },
    feedO: { fetchedAt: new Date().toISOString(), skipped: [], events: [shapeEvent('a', '20260824T170000Z')] },
  }));
  const lines = byClass(host, 'feed-shape');
  assert.equal(lines.length, 2, 'both rows still render');
  assert.equal(lines[0].textContent, "Couldn't classify this calendar's events.");
  assert.match(lines[1].textContent, /Uses the heuristic\.$/);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0].arguments.length, 1, 'one string, no error object or feed');
  assert.match(errors.mock.calls[0].arguments[0], /^plaenicke: feed shape failed \(TypeError\)$/);
  assert.equal(host.querySelectorAll('button').filter((b) => b.textContent === 'Sync').length, 2);
});

test('settings: the shape line stays while the row asks to confirm a Remove', () => {
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events: [shapeEvent('a', '20260824T170000Z')] }));
  findButtonByText(host, 'Remove').click();
  assert.ok(findButtonByText(host, 'Remove from every device'), 'fixture check: asking');
  assert.equal(byClass(host, 'feed-shape').length, 1);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/settings.test.js`
Expected: `# fail 5` — `a synced calendar row says how its events repeat…`, `the shape line never shows the calendar link` (fixture check), `a synced calendar with no events…`, `a cache the readout cannot read…`, `the shape line stays while the row asks…`. The two "no shape line" tests pass already; they guard against regressions and are checked by mutation in Step 5.

- [ ] **Step 3: Implement**

In `js/settings.js`, change line 14 to:

```js
  syncFeed, feedStatus, removeFeed, webcalToHttps, inferName, feedShape, describeFeedShape,
```

Insert after the closing `}` of `statusFor` (line 239):

```js

    // The stage-1 readout (home-screen spec § 2.4): how this calendar's cached
    // events repeat, and whether stage 3a reads it by RRULE or by the
    // heuristic. Cache only — no network, and the feed URL is never read. No
    // line before a first sync (no entry), and none after a quota drop: those
    // events were emptied to free storage (feedStatus says so), and counting
    // the empty list would describe a calendar that is not there. A throw is
    // shown on the row and logged by error name only, never swallowed.
    function shapeLineFor(feed) {
      const entry = feedCache[feed.id];
      if (!entry || entry.quotaDropped || !Array.isArray(entry.events)) return null;
      const line = document.createElement('div');
      line.className = 'feed-shape';
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        line.textContent = describeFeedShape(feedShape(entry.events, tz));
      } catch (err) {
        line.textContent = "Couldn't classify this calendar's events.";
        console.error(`plaenicke: feed shape failed (${err && err.name ? err.name : 'unknown'})`);
      }
      return line;
    }
```

Replace lines 389–395:

```js
          if (confirmingRemoveId === feed.id) {
            actions.append(confirmRemoveBtn, cancelRemoveBtn);
            row.append(main, status, confirmNote, actions);
          } else {
            actions.append(toggle, syncBtn, removeBtn);
            row.append(main, status, actions);
          }
```

with:

```js
          const shapeLine = shapeLineFor(feed);
          const head = shapeLine ? [main, status, shapeLine] : [main, status];
          if (confirmingRemoveId === feed.id) {
            actions.append(confirmRemoveBtn, cancelRemoveBtn);
            row.append(...head, confirmNote, actions);
          } else {
            actions.append(toggle, syncBtn, removeBtn);
            row.append(...head, actions);
          }
```

In `styles.css`, after line 411 (`.feed-status { … }`) add:

```css
/* The stage-1 feed-shape readout (home-screen spec § 2.4), under the status. */
.feed-shape { color: var(--muted); font-size: 0.75rem; margin: 0 0 6px; }
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/settings.test.js`
Expected: `# pass 31`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

Plant each mutant in `js/settings.js`, run `node --test tests/settings.test.js`, check that the named test fails, then restore:

| Mutant | Must fail |
|---|---|
| guard → `if (!entry \|\| !Array.isArray(entry.events)) return null;` | `no shape line after a quota drop…` |
| log → `console.error('plaenicke: feed shape failed', err, feed);` | `a cache the readout cannot read…` |
| catch body → `return null;` (a silent skip) | `a cache the readout cannot read…` |
| `line.textContent = describeFeedShape(…) + ' ' + feed.url;` | `the shape line never shows the calendar link` |
| confirm branch → `row.append(main, status, confirmNote, actions);` | `the shape line stays while the row asks to confirm a Remove` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/settings.js styles.css tests/settings.test.js && git commit -m "feat(settings): each calendar row says how its events repeat and which method it uses" -m "Read-only, from the cache, never the URL (home-screen spec § 2.4, stage 1). No line before a first sync or after a quota drop; a classification failure is shown on the row and logged by error name only." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1284`, `# fail 0`, `# cancelled 0`, then the commit.

---

### Task 3: ship stage 1 — REQUIRES ALEX'S EXPLICIT GO-AHEAD

Merging to `main` deploys to GitHub Pages. Without an explicit yes from Alex in this conversation for this merge, stop after Step 1 and leave stage 1 on the branch.

**Files:**
- Modify: `service-worker.js:13` (`CACHE`)
- Modify: `tests/serviceworker.test.js:48` (`CACHE_ON_MAIN`)

**Interfaces:**
- Consumes: `CACHE` on `main` (`plaenicke-v6-6` at d7b3b30, and `plaenicke-v6-6` live at https://ajaenicke518.github.io/plaenicke/service-worker.js on 2026-10-21).
- Produces: `CACHE = 'plaenicke-v6-7'`; `CACHE_ON_MAIN = 'plaenicke-v6-6'`. `ASSETS` is unchanged: stage 1 adds no module (the `every js/ module is precached` test confirms).

- [ ] **Step 1: Ask Alex, and wait**

Send: "Stage 1 (feed-shape readout) is ready on `home-screen-design`: `npm test` 1284 pass, 0 fail, 0 cancelled. Shipping means bumping the service-worker cache to v6-7, merging into `main` and pushing — that is a production deploy to GitHub Pages. Go ahead?" Go on to Step 2 only after an explicit yes.

- [ ] **Step 2: Check that main has not moved**

```bash
git fetch origin && git rev-parse main origin/main && git show main:service-worker.js | grep "const CACHE"
```

Expected: the two SHAs are identical, and `const CACHE = 'plaenicke-v6-6';`. If either differs, stop and report: the pins below assume v6-6.

- [ ] **Step 3: Re-pin the guard to main's value (the failing test)**

In `tests/serviceworker.test.js`, change line 48 to:

```js
const CACHE_ON_MAIN = 'plaenicke-v6-6';
```

- [ ] **Step 4: Run it and see it fail**

Run: `node --test tests/serviceworker.test.js`
Expected: `not ok 3 - the cache name is ahead of the release on main` with `CACHE must be a later version than main's 'plaenicke-v6-6' so stale caches are purged; got 'plaenicke-v6-6'`.

- [ ] **Step 5: Bump CACHE**

In `service-worker.js`, change line 13 to:

```js
const CACHE = 'plaenicke-v6-7';
```

- [ ] **Step 6: Run it and see it pass; mutation-check**

Run: `node --test tests/serviceworker.test.js` → `# pass 9`, `# fail 0`.
Mutant: put `CACHE` back to `'plaenicke-v6-6'` → `the cache name is ahead of the release on main` fails. Restore `'plaenicke-v6-7'`.

- [ ] **Step 7: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add service-worker.js tests/serviceworker.test.js && git commit -m "release: bump service-worker CACHE to plaenicke-v6-7" -m "Re-pins the test's CACHE_ON_MAIN to main's v6-6 so the guard can fail." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Merge, re-test on main, push**

```bash
git checkout main && git merge --no-ff home-screen-design -m "merge: home screen stage 1 — feed-shape readout in Settings" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git push origin main && git checkout home-screen-design
```

Expected: `# tests 1284`, `# fail 0`, `# cancelled 0`, the push succeeds, and the branch is `home-screen-design` again. If the gate fails on main, do not push: report it.

- [ ] **Step 9: Live check**

With the Monitor tool (an until-loop; foreground `sleep` is blocked):

```bash
until curl -s https://ajaenicke518.github.io/plaenicke/service-worker.js | grep -q "plaenicke-v6-7"; do sleep 15; done; echo live
```

Then:

```bash
curl -s https://ajaenicke518.github.io/plaenicke/js/feeds.js | grep -c "export function feedShape"
```

Expected: `live`, then `1`.

- [ ] **Step 10: Alex reads his numbers (the precondition for stage 3a)**

Ask Alex to open the home-screen app on his iPhone twice (the network-first worker serves the new files on the launch after it activates). Then he goes to Settings → Linked calendars and reports each calendar's line word for word, LMU Classes first. Check that no row shows a link. Stage 3a does not start until those lines are in hand (spec § 2.4, "Precondition for stage 3a").

---

# Stage 2 — foundation (spec § 8 stage 2)

Stage 2 starts on `home-screen-design` after Task 3, so the branch already contains `main`. Line numbers below are on the branch at the start of the task. Each edit quotes the exact text it replaces.

### Task 4: the `--overdue-start` colour token, both themes

**Files:**
- Modify: `styles.css:9-10` (`:root`, after `--danger`), `styles.css:48-49` (`[data-theme="dark"]`, after `--danger`)
- Modify: append to `tests/styles.test.js` after line 352

**Interfaces:**
- Consumes: `declOf(selector, prop)` (`tests/styles.test.js:69`).
- Produces: CSS custom property `--overdue-start` — `#9c5418` in `:root`, `#e39a52` in `[data-theme="dark"]`. No consumer until stage 3b.

- [ ] **Step 1: Write the failing tests**

Append to `tests/styles.test.js`:

```js

// --- home-screen stage 2: the overdue-start colour (spec § 2.3, § 5) --------
// Two themes, two surfaces each. The contrast is COMPUTED from the declared
// values, so a later tweak that makes the orange unreadable fails here
// rather than on the phone. Red/orange distinguishability is not computable
// this way and stays on the on-device checklist.
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  assert.ok(m, `cannot read a #rrggbb colour from ${JSON.stringify(hex)}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('--overdue-start is the spec\'s orange in both themes', () => {
  assert.equal(declOf(':root', '--overdue-start'), '#9c5418');
  assert.equal(declOf('[data-theme="dark"]', '--overdue-start'), '#e39a52');
});

for (const theme of [':root', '[data-theme="dark"]']) {
  test(`${theme}: --overdue-start reads at WCAG AA (4.5:1) on --bg and on --card`, () => {
    const fg = declOf(theme, '--overdue-start');
    for (const surface of ['--bg', '--card']) {
      const ratio = contrast(fg, declOf(theme, surface));
      assert.ok(ratio >= 4.5, `${theme} ${surface}: ${ratio.toFixed(2)} < 4.5`);
    }
  });
  test(`${theme}: --overdue-start is not --danger`, () => {
    assert.notEqual(declOf(theme, '--overdue-start').toLowerCase(), declOf(theme, '--danger').toLowerCase());
  });
}

test('contrast() reproduces the spec\'s computed ratios (fixture check on the helper)', () => {
  assert.equal(contrast('#9c5418', '#f4f1ea').toFixed(2), '5.04');
  assert.equal(contrast('#9c5418', '#fffdf8').toFixed(2), '5.59');
  assert.equal(contrast('#e39a52', '#14161a').toFixed(2), '7.77');
  assert.equal(contrast('#e39a52', '#1e2126').toFixed(2), '6.93');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/styles.test.js`
Expected: 5 failures — `--overdue-start is the spec's orange in both themes`, and both `reads at WCAG AA` and both `is not --danger` (each with `cannot read a #rrggbb colour from null` or a `null` TypeError). The helper fixture check passes.

- [ ] **Step 3: Implement**

In `styles.css` `:root`, replace:

```css
  --danger: #b04a3a;
  --line: #e0d8c8;
```

with:

```css
  --danger: #b04a3a;
  /* A passed START date's age on Today's Overdue (home-screen spec § 2.3);
     --danger stays the passed-deadline red. Light: 5.04 on --bg, 5.59 on
     --card (tests/styles.test.js computes them). */
  --overdue-start: #9c5418;
  --line: #e0d8c8;
```

In `[data-theme="dark"]`, replace:

```css
  --danger: #e06c5e;
  --line: #33373f;
```

with:

```css
  --danger: #e06c5e;
  /* Dark: 7.77 on --bg, 6.93 on --card. */
  --overdue-start: #e39a52;
  --line: #33373f;
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/styles.test.js` → `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant | Must fail |
|---|---|
| dark `--overdue-start: #8a5a3b;` (the light accent: 2.9:1 on near-black) | `--overdue-start is the spec's orange…`, `[data-theme="dark"]: --overdue-start reads at WCAG AA…` |
| dark `--overdue-start: #e06c5e;` (= dark `--danger`) | `[data-theme="dark"]: --overdue-start is not --danger` |
| delete the dark `--overdue-start` line | `--overdue-start is the spec's orange…`, both dark tests |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add styles.css tests/styles.test.js && git commit -m "style: --overdue-start orange in both themes, contrast computed in the test" -m "Home-screen spec § 2.3/§ 5. No consumer until stage 3b." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1290`.

---

### Task 5: spacing and radius tokens; control and sheet radii

**Files:**
- Modify: `styles.css` `:root` closing (after `--feed-palette-6`), `.icon-btn`, `#entry-text`, `#entry-date, #entry-time, #entry-end`, `button`, `.feed-add input`, `.link-ui input`, `.preview-row input, .preview-row select`, `.idea-add textarea`, `.sheet`, `.sheet input, .sheet select, .sheet textarea`
- Modify: append to `tests/styles.test.js`

**Interfaces:**
- Consumes: `declOf`, `ruleExists` (`tests/styles.test.js:69`, `:139`).
- Produces: `--space-1`…`--space-6` (4/8/12/16/24/32 px), `--radius-control: 8px`, `--radius-sheet: 14px`, `--radius-round: 50%`, defined in `:root` only.

- [ ] **Step 1: Write the failing tests**

Append to `tests/styles.test.js`:

```js

// --- home-screen stage 2: spacing and radii (spec § 5) ----------------------
const SPACING = { '--space-1': '4px', '--space-2': '8px', '--space-3': '12px', '--space-4': '16px', '--space-5': '24px', '--space-6': '32px' };
const RADII = { '--radius-control': '8px', '--radius-sheet': '14px', '--radius-round': '50%' };

test('the spacing and radius scales are the spec\'s values', () => {
  for (const [name, value] of Object.entries({ ...SPACING, ...RADII })) {
    assert.equal(declOf(':root', name), value, name);
  }
});

test('spacing and radii are theme-independent: dark mode never redefines them', () => {
  for (const name of Object.keys({ ...SPACING, ...RADII })) {
    assert.equal(declOf('[data-theme="dark"]', name), null, `${name} must have one definition`);
  }
});

// Every form control and button rule that sets a corner. Containers (cards,
// panels, list rows, the day grid) keep their own radius.
const CONTROL_RULES = [
  'button', '.icon-btn', '#entry-text', '#entry-date', '#entry-time', '#entry-end',
  '.feed-add input', '.link-ui input', '.preview-row input', '.preview-row select',
  '.idea-add textarea', '.sheet input', '.sheet select', '.sheet textarea',
];
for (const sel of CONTROL_RULES) {
  test(`${sel} uses the control radius`, () => {
    assert.ok(ruleExists(sel), `no rule for ${sel}`);
    assert.equal(declOf(sel, 'border-radius'), 'var(--radius-control)');
  });
}

test('the item sheet uses the sheet radius on its top corners', () => {
  assert.equal(declOf('.sheet', 'border-radius'), 'var(--radius-sheet) var(--radius-sheet) 0 0');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/styles.test.js`
Expected: 16 failures — the scale test, all 14 `uses the control radius` (each `'6px' !== 'var(--radius-control)'`), and the sheet radius (`'12px 12px 0 0'`). `theme-independent` passes already; it is checked by mutation in Step 5.

- [ ] **Step 3: Implement**

Run this from the repo root. Each pair must match exactly once, or it stops with an AssertionError naming the pair:

```bash
python3 - <<'PY'
p = 'styles.css'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep("""  --feed-palette-6: #b3654a;  /* terracotta */
}""", """  --feed-palette-6: #b3654a;  /* terracotta */
  /* Spacing and radii (home-screen spec § 5). Theme-independent: defined
     here only, never in [data-theme="dark"], so the two cannot drift. */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius-control: 8px;
  --radius-sheet: 14px;
  --radius-round: 50%;
}""")
rep("""  color: var(--ink);
  border-radius: 6px;
  font-size: 1.1rem;""", """  color: var(--ink);
  border-radius: var(--radius-control);
  font-size: 1.1rem;""")
rep("""  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}

.text-row""", """  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--ink);
}

.text-row""")
rep("""  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}

button {""", """  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--ink);
}

button {""")
rep("""  border: none;
  border-radius: 6px;
  background: var(--accent);""", """  border: none;
  border-radius: var(--radius-control);
  background: var(--accent);""")
rep("""  padding: 8px;
  margin-bottom: 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}
.feed-add-msg""", """  padding: 8px;
  margin-bottom: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--ink);
}
.feed-add-msg""")
rep("""  padding: 8px;
  margin-bottom: 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}
.link-ui button""", """  padding: 8px;
  margin-bottom: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--ink);
}
.link-ui button""")
rep("""  padding: 8px; border: 1px solid var(--line); border-radius: 6px;""",
    """  padding: 8px; border: 1px solid var(--line); border-radius: var(--radius-control);""")
rep("""  border: 1px solid var(--line);
  border-radius: 6px;
  font: inherit;""", """  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  font: inherit;""")
rep("""  border-radius: 12px 12px 0 0;""", """  border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;""")
rep("""  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--ink);
}
.sheet textarea""", """  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  background: var(--bg);
  color: var(--ink);
}
.sheet textarea""")
open(p, 'w').write(s)
PY
grep -c "border-radius: 6px" styles.css
```

Expected: no AssertionError, and `7` (the containers that keep 6px: `.add-box`, the two list-row rules, `.day-grid`, `.settings-section`, `.feed-row`, `#preview`).

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/styles.test.js` → `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant | Must fail |
|---|---|
| add `--space-2: 10px;` inside `[data-theme="dark"]` | `spacing and radii are theme-independent…` |
| `--radius-control: 6px;` | `the spacing and radius scales are the spec's values` |
| `.preview-row input, .preview-row select` back to `border-radius: 6px` | `.preview-row input uses the control radius`, `.preview-row select uses the control radius` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add styles.css tests/styles.test.js && git commit -m "style: spacing and radius tokens; controls take the 8px radius, the sheet 14px" -m "Home-screen spec § 5. Spacing is defined, not yet applied: existing rules keep their padding so Month/Week/Day stay compact. Containers keep their radius." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1307`.

---

### Task 6: 16 px on every input

**Files:**
- Modify: `styles.css` — `.feed-add input` (`font-size: 0.9rem`), `.link-ui input` (`font-size: 0.9rem`), `.link-code-input, .link-code-output, .link-token-input` (`font-size: 0.7rem`), `.preview-row input, .preview-row select` (`font-size: 0.9rem`)
- Modify: append to `tests/styles.test.js`

**Interfaces:**
- Consumes: `declOf`, `ruleExists`, `px` (`tests/styles.test.js:69`, `:139`, `:146`), and `css` (the stylesheet with its comments stripped, `tests/styles.test.js:26`).
- Produces: every rule that targets an `input`, `select` or `textarea` declares a font-size of at least 16px, or none.

Observed while planning, and not changed here: `.link-ui input` (specificity 0,1,1) beats `.link-code-input, .link-code-output, .link-token-input` (0,1,0). So the link-code fields already render in `.link-ui input`'s size and `font-family: inherit`, and that rule's monospace never applies. This task sets both rules to 1rem, so the bigger size holds whichever one wins. Making the monospace actually apply is a separate change.

- [ ] **Step 1: Write the failing tests**

Append to `tests/styles.test.js`:

```js

// --- home-screen stage 2: 16px on every input (spec § 5) --------------------
// Under 16px, iOS Safari zooms the whole page when the field takes focus.
// Two checks: every known control rule resolves to >= 16px, and NO rule
// anywhere that targets a form control declares a smaller font-size — so a
// control added later with a small size fails here without being listed.
// (The item sheet's three are pinned by the edit-items tests above.)
const INPUT_RULES = [
  '#entry-text', '#entry-date', '#entry-time', '#entry-end', '.idea-add textarea',
  '.feed-add input', '.link-ui input', '.preview-row input', '.preview-row select',
];
for (const sel of INPUT_RULES) {
  test(`${sel} is at least 16px`, () => {
    assert.ok(ruleExists(sel), `no rule for ${sel}`);
    const fs = declOf(sel, 'font-size');
    assert.ok(fs !== null, `${sel} declares no font-size`);
    assert.ok(px(fs) >= 16, `expected ${sel} font-size >= 16px, got ${fs}`);
  });
}

const CONTROL_SELECTOR = /(^|[\s>+~])(input|select|textarea)\b|#entry-|#idea-text|\.link-(code|token)-/;
test('no rule that targets a form control sets a font-size under 16px', () => {
  const offenders = [];
  let seen = 0;
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = sel.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (!selectors.some((s) => CONTROL_SELECTOR.test(s))) continue;
    seen += 1;
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0 || decl.slice(0, i).trim().toLowerCase() !== 'font-size') continue;
      const value = decl.slice(i + 1).trim();
      if (px(value) < 16) offenders.push(`${sel.trim()}: ${value}`);
    }
  }
  assert.ok(seen >= 10, `fixture check: the scan found only ${seen} control rules`);
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/styles.test.js`
Expected: 5 failures — `.feed-add input is at least 16px`, `.link-ui input…`, `.preview-row input…`, `.preview-row select…` (each `got 0.9rem`), and `no rule that targets a form control…`, whose offender list holds the three 0.9rem rules and `.link-code-input, .link-code-output, .link-token-input: 0.7rem`.

- [ ] **Step 3: Implement**

```bash
python3 - <<'PY'
p = 'styles.css'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep(""".feed-add input {
  display: block;
  width: 100%;
  font-size: 0.9rem;""", """.feed-add input {
  display: block;
  width: 100%;
  font-size: 1rem;              /* under 16px iOS zooms the page on focus */""")
rep(""".link-ui input {
  display: block;
  width: 100%;
  font-size: 0.9rem;""", """.link-ui input {
  display: block;
  width: 100%;
  font-size: 1rem;              /* under 16px iOS zooms the page on focus */""")
rep("""  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
}""", """  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1rem;              /* under 16px iOS zooms the page on focus */
}""")
rep("""  font-size: 0.9rem; font-family: inherit; background: var(--card); color: var(--ink);""",
    """  font-size: 1rem; font-family: inherit; background: var(--card); color: var(--ink);""")
open(p, 'w').write(s)
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/styles.test.js` → `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant | Must fail |
|---|---|
| `.link-code-input, …` back to `font-size: 0.7rem;` (a rule not in `INPUT_RULES`) | `no rule that targets a form control sets a font-size under 16px` |
| add `.feed-add input[type="search"] { font-size: 14px; }` at the end of styles.css | `no rule that targets a form control…` |
| `#entry-text` `font-size: 0.95rem;` | `#entry-text is at least 16px`, `no rule that targets a form control…` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add styles.css tests/styles.test.js && git commit -m "style: 16px on every input, pinned by a scan of every form-control rule" -m "Home-screen spec § 5: Settings' calendar fields, the link-code fields and the preview fields were 0.9rem/0.7rem, so iOS zoomed the page on focus." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1317`.

---

### Task 7: the type scale for new screens; Month, Week and Day keep theirs

**Files:**
- Modify: `styles.css` `:root` (after `--radius-round: 50%;`, added in Task 5)
- Modify: append to `tests/styles.test.js`

**Interfaces:**
- Consumes: `declOf`, `css`.
- Produces: `--text-label: 13px`, `--text-row: 16px`, `--text-title: 20px`, `--text-hero: 28px`, `--label-tracking: 0.06em`, `--sans: system-ui, -apple-system, sans-serif` (the serif for titles is the existing `--serif`). First consumer: stage 3b.

- [ ] **Step 1: Write the failing tests**

Append to `tests/styles.test.js`:

```js

// --- home-screen stage 2: the type scale is for NEW screens only (spec § 5) --
test('the new screens\' type scale is defined', () => {
  assert.equal(declOf(':root', '--text-label'), '13px');
  assert.equal(declOf(':root', '--text-row'), '16px');
  assert.equal(declOf(':root', '--text-title'), '20px');
  assert.equal(declOf(':root', '--text-hero'), '28px');
  assert.equal(declOf(':root', '--label-tracking'), '0.06em');
  assert.equal(declOf(':root', '--sans'), 'system-ui, -apple-system, sans-serif');
});

// Month, Week and Day keep their compact sizes. Pinned at their values on
// main (d7b3b30) so a "consistency" pass that moves them onto the new scale
// fails here: a 13px label in a 72px month cell or a 22px Day block clips.
const CALENDAR_SIZES = {
  '.cal-head': '0.75rem', '.cal-cell': '0.72rem',
  '.week-head': '0.7rem', '.week-head b': '0.85rem', '.week-more': '0.65rem',
  '.day-hour': '0.7rem', '.day-block': '0.75rem', '.day-pin': '0.75rem',
};
for (const [sel, size] of Object.entries(CALENDAR_SIZES)) {
  test(`${sel} keeps its compact font-size (${size})`, () => {
    assert.equal(declOf(sel, 'font-size'), size);
  });
}

test('no existing rule reads the new type scale yet', () => {
  const body = css.replace(/:root\s*\{[^}]*\}/, '');
  assert.doesNotMatch(body, /var\(--(text-label|text-row|text-title|text-hero|label-tracking|sans)\)/,
    'stage 3 is the first consumer; Month, Week and Day never are');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/styles.test.js`
Expected: 1 failure — `the new screens' type scale is defined` (`null !== '13px'`). The eight size pins and the no-consumer test pass already; they are guards, checked by mutation in Step 5.

- [ ] **Step 3: Implement**

In `styles.css` `:root`, replace:

```css
  --radius-round: 50%;
}
```

with:

```css
  --radius-round: 50%;
  /* Type scale for the NEW screens only — Today, the tab bar, the capture box
     (spec § 5). Month, Week and Day keep their compact sizes and never read
     these; tests/styles.test.js pins theirs. */
  --text-label: 13px;
  --text-row: 16px;
  --text-title: 20px;
  --text-hero: 28px;
  --label-tracking: 0.06em;
  --sans: system-ui, -apple-system, sans-serif;
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/styles.test.js` → `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant | Must fail |
|---|---|
| `.cal-cell` `font-size: var(--text-label);` | `.cal-cell keeps its compact font-size (0.72rem)`, `no existing rule reads the new type scale yet` |
| `.week-head` `font-size: 13px;` | `.week-head keeps its compact font-size (0.7rem)` |
| `--text-label: 12px;` | `the new screens' type scale is defined` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add styles.css tests/styles.test.js && git commit -m "style: type-scale tokens for the new screens; Month, Week and Day sizes pinned" -m "Home-screen spec § 5 and § 8 stage 2 (existing type sizes kept). Tokens only; stage 3b is the first consumer." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1327`.

---

### Task 8: `js/press.js` — the press state

**Files:**
- Create: `js/press.js`
- Create: `tests/press.test.js`
- Modify: `service-worker.js:21` (`ASSETS`)

**Interfaces:**
- Consumes: a root with `addEventListener(type, fn, opts)`/`removeEventListener(type, fn, opts)`; event targets with `closest(selector)`, `classList.add/remove`, `disabled`.
- Produces:
  - `export const PRESS_SELECTOR = 'button, [data-press]'`
  - `export const PRESS_MOVE_PX = 10`
  - `export const PRESS_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave']`
  - `export function installPress(root) -> uninstall()` — `uninstall()` removes every listener and clears a press in progress.

- [ ] **Step 1: Write the failing tests**

Create `tests/press.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installPress, PRESS_SELECTOR, PRESS_MOVE_PX, PRESS_EVENTS,
} from '../js/press.js';

// press.js is DOM glue over five pointer events. tests/fake-dom.js has no
// closest() and no event dispatch, so this file keeps its own two fakes: an
// element with a parent chain, and a root that records its listeners.

function el(tag, { parent = null, press = false, disabled = false } = {}) {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    parent,
    disabled,
    press,
    classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    // Element.closest: this element first, then each ancestor.
    closest(selector) {
      assert.equal(selector, PRESS_SELECTOR);
      for (let n = this; n; n = n.parent) if (n.tagName === 'BUTTON' || n.press) return n;
      return null;
    },
  };
}

function fakeRoot() {
  const listeners = {};
  const options = {};
  return {
    listeners,
    options,
    addEventListener(type, fn, opts) { (listeners[type] ||= []).push(fn); options[type] = opts; },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire(type, ev) { for (const fn of listeners[type] || []) fn({ pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0, ...ev }); },
  };
}

function setup() {
  const root = fakeRoot();
  const uninstall = installPress(root);
  return { root, uninstall };
}

test('press: pointerdown on a button marks it pressed at once — no timer, no wait', () => {
  const { root } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b });
  assert.ok(b.classList.contains('pressed'));
});

test('press: a tap on a button\'s inner text presses the button', () => {
  const { root } = setup();
  const b = el('button');
  const span = el('span', { parent: b });
  root.fire('pointerdown', { target: span });
  assert.ok(b.classList.contains('pressed'));
  assert.ok(!span.classList.contains('pressed'));
});

test('press: a [data-press] row is pressable; plain content is not', () => {
  const { root } = setup();
  const row = el('li', { press: true });
  root.fire('pointerdown', { target: el('span', { parent: row }) });
  assert.ok(row.classList.contains('pressed'));
  const plain = el('p');
  root.fire('pointerdown', { target: plain });
  assert.ok(!plain.classList.contains('pressed'));
  assert.ok(!row.classList.contains('pressed'), 'the next touch-down cleared the row');
});

for (const end of ['pointerup', 'pointercancel']) {
  test(`press: ${end} ends the press`, () => {
    const { root } = setup();
    const b = el('button');
    root.fire('pointerdown', { target: b });
    root.fire(end, { target: b });
    assert.ok(!b.classList.contains('pressed'));
  });
}

// iOS: a touch that turns into a scroll. A small wobble is still a tap.
test(`press: a move of exactly ${PRESS_MOVE_PX}px keeps the press; past it, the press ends`, () => {
  const { root } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b, clientX: 100, clientY: 200 });
  root.fire('pointermove', { target: b, clientX: 106, clientY: 208 }); // 10px
  assert.ok(b.classList.contains('pressed'), '10px is a tap');
  root.fire('pointermove', { target: b, clientX: 100, clientY: 211 }); // 11px from the start
  assert.ok(!b.classList.contains('pressed'), '11px is a scroll');
  root.fire('pointermove', { target: b, clientX: 100, clientY: 200 });
  assert.ok(!b.classList.contains('pressed'), 'coming back does not re-press it');
});

test('press: only the pointer that pressed can end it', () => {
  const { root } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b, pointerId: 7 });
  root.fire('pointermove', { target: b, pointerId: 8, clientX: 50, clientY: 50 });
  root.fire('pointerup', { target: b, pointerId: 8 });
  root.fire('pointercancel', { target: b, pointerId: 8 });
  assert.ok(b.classList.contains('pressed'));
  root.fire('pointerup', { target: b, pointerId: 7 });
  assert.ok(!b.classList.contains('pressed'));
});

test('press: a second finger or a right click presses nothing', () => {
  const { root } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b, isPrimary: false });
  root.fire('pointerdown', { target: b, button: 2 });
  assert.ok(!b.classList.contains('pressed'));
});

test('press: a disabled button never looks pressed', () => {
  const { root } = setup();
  const b = el('button', { disabled: true });
  root.fire('pointerdown', { target: b });
  assert.ok(!b.classList.contains('pressed'));
});

test('press: leaving the pressed element ends the press; leaving its child does not', () => {
  const { root } = setup();
  const b = el('button');
  const span = el('span', { parent: b });
  root.fire('pointerdown', { target: span });
  root.fire('pointerleave', { target: span });
  assert.ok(b.classList.contains('pressed'));
  root.fire('pointerleave', { target: b });
  assert.ok(!b.classList.contains('pressed'));
});

test('press: never two pressed at once', () => {
  const { root } = setup();
  const a = el('button');
  const b = el('button');
  root.fire('pointerdown', { target: a });
  root.fire('pointerdown', { target: b, pointerId: 2 });
  assert.ok(!a.classList.contains('pressed'));
  assert.ok(b.classList.contains('pressed'));
});

test('press: listens in the capture phase and passively, so it can never block a scroll', () => {
  const { root } = setup();
  assert.deepEqual(Object.keys(root.options).sort(), [...PRESS_EVENTS].sort());
  for (const type of PRESS_EVENTS) {
    assert.deepEqual(root.options[type], { capture: true, passive: true }, type);
  }
});

test('press: uninstall removes every listener and clears a press in progress', () => {
  const { root, uninstall } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b });
  uninstall();
  assert.ok(!b.classList.contains('pressed'));
  for (const type of PRESS_EVENTS) assert.equal(root.listeners[type].length, 0, type);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/press.test.js`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/js/press.js'`, `# fail 1`.

- [ ] **Step 3: Implement**

Create `js/press.js`:

```js
// press.js — touch-down feedback for every tap (home-screen spec § 5).
//
// One delegated listener set on `root` (app.js passes `document`) adds
// `.pressed` to the nearest `button` or `[data-press]` element on pointerdown,
// and removes it on pointerup, pointercancel, pointerleave of that element, or
// a pointermove more than PRESS_MOVE_PX from where the press started (the
// finger is scrolling, not tapping). A class rather than `:active`, which can
// stick during an iOS scroll (WebKit 255277, 221366); styles.css styles it.
//
// Capture phase, so a handler that stops propagation cannot strand a press,
// and so pointerleave (which does not bubble) still reaches the root.
// Passive: this never calls preventDefault, so it can never block a scroll.
// Only the pointer that started the press can end it.

export const PRESS_SELECTOR = 'button, [data-press]';
export const PRESS_MOVE_PX = 10;
export const PRESS_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave'];

// installPress(root) -> uninstall(): wires the listeners; the returned
// function removes them and clears any press in progress.
export function installPress(root) {
  let pressed = null;
  let pointerId = null;
  let startX = 0;
  let startY = 0;

  function clear() {
    if (pressed) pressed.classList.remove('pressed');
    pressed = null;
    pointerId = null;
  }

  const handlers = {
    pointerdown(e) {
      // A second finger, or a mouse button other than the main one, is not a tap.
      if (e.isPrimary === false || (typeof e.button === 'number' && e.button !== 0)) return;
      clear();
      const t = e.target && typeof e.target.closest === 'function' ? e.target.closest(PRESS_SELECTOR) : null;
      if (!t || t.disabled) return;
      pressed = t;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      t.classList.add('pressed');
    },
    pointermove(e) {
      if (!pressed || e.pointerId !== pointerId) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > PRESS_MOVE_PX) clear();
    },
    pointerup(e) { if (pressed && e.pointerId === pointerId) clear(); },
    pointercancel(e) { if (pressed && e.pointerId === pointerId) clear(); },
    // Leaving a child of the pressed element is not leaving it.
    pointerleave(e) { if (pressed && e.target === pressed) clear(); },
  };

  const opts = { capture: true, passive: true };
  for (const type of PRESS_EVENTS) root.addEventListener(type, handlers[type], opts);
  return function uninstall() {
    for (const type of PRESS_EVENTS) root.removeEventListener(type, handlers[type], opts);
    clear();
  };
}
```

- [ ] **Step 4: Run the file, then the suite, and see the ASSETS guard fail**

Run: `node --test tests/press.test.js` → `# pass 13`, `# fail 0`.
Run: `npm test > "$TMPDIR/plaenicke-test.log" 2>&1; grep -E "^not ok|^# (fail|cancelled)" "$TMPDIR/plaenicke-test.log"`
Expected: `not ok … - every js/ module is precached — a missing one white-screens a cold offline start` (`service-worker ASSETS is missing js/press.js`), `# fail 1`.

- [ ] **Step 5: Add the module to ASSETS**

In `service-worker.js`, change line 21:

```js
  'js/scrolllock.js', 'js/fetchtimeout.js', 'js/palette.js',
```

to:

```js
  'js/scrolllock.js', 'js/fetchtimeout.js', 'js/palette.js', 'js/press.js',
```

`CACHE` is not bumped here; it is bumped once, at release (Task 10).

- [ ] **Step 6: Mutation-check**

Plant each in `js/press.js`, run `node --test tests/press.test.js`, then restore:

| Mutant | Must fail |
|---|---|
| `> PRESS_MOVE_PX` → `>= PRESS_MOVE_PX` | `a move of exactly 10px keeps the press; past it, the press ends` |
| `pointercancel(e) {…}` → `pointercancel() {},` | `pointercancel ends the press` |
| `if (!t \|\| t.disabled) return;` → `if (!t) return;` | `a disabled button never looks pressed` |
| `{ capture: true, passive: true }` → `{ capture: true }` | `listens in the capture phase and passively…` |
| `pointerup(e) {…}` → `pointerup() { clear(); },` | `only the pointer that pressed can end it` |
| `pointerleave(e) {…}` → `pointerleave() { clear(); },` | `leaving the pressed element ends the press; leaving its child does not` |
| delete the `clear();` at the top of `pointerdown` | `a [data-press] row is pressable…`, `never two pressed at once` |
| delete the `Math.hypot(…)` line | `a move of exactly 10px…` |

- [ ] **Step 7: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/press.js tests/press.test.js service-worker.js && git commit -m "feat(press): touch-down press state on buttons and [data-press] rows" -m "Home-screen spec § 5: .pressed on pointerdown; up, cancel, leave or a >10px move clears it. Capture-phase and passive, so it never blocks a scroll. Precached in ASSETS; not yet installed." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1340`.

---

### Task 9: press styles, `touch-action`, and installing the press state

**Files:**
- Modify: `styles.css` — after `* { box-sizing: border-box; }` (`html` rule), after `.message { … }` (press rules)
- Modify: `js/app.js:31` (import), insert before `js/app.js:1243` (`document.addEventListener('visibilitychange', …)`)
- Modify: append to `tests/styles.test.js`; append to `tests/apply.test.js` after line 5649

**Interfaces:**
- Consumes: `installPress(root)`, `PRESS_EVENTS` (Task 8); `tests/fake-dom.js` `makeFakeDocument()._listeners` (the document `apply.test.js:158` installs before importing app.js).
- Produces: `html { touch-action: manipulation }`; `button, [data-press] { -webkit-tap-highlight-color: transparent }`; `button.pressed { opacity: 0.7 }`; `[data-press].pressed { background: var(--chip-bg) }`; `installPress(document)` called once at app.js module load.

- [ ] **Step 1: Write the failing tests**

Append to `tests/styles.test.js`:

```js

// --- home-screen stage 2: press state (spec § 5) ----------------------------
test('every tap skips the double-tap-zoom wait', () => {
  assert.equal(declOf('html', 'touch-action'), 'manipulation');
});

test('pressed buttons dim and pressed rows take the chip background', () => {
  assert.equal(declOf('button.pressed', 'opacity'), '0.7');
  assert.equal(declOf('[data-press].pressed', 'background'), 'var(--chip-bg)');
});

test('the grey iOS tap highlight is off exactly where .pressed replaces it', () => {
  assert.equal(declOf('button', '-webkit-tap-highlight-color'), 'transparent');
  assert.equal(declOf('[data-press]', '-webkit-tap-highlight-color'), 'transparent');
  assert.equal(declOf('html', '-webkit-tap-highlight-color'), null, 'links and checkboxes keep the native highlight');
});

// Feedback on touch-down means instantly. And stage 2 adds no motion at all,
// so nothing needs a prefers-reduced-motion override yet: stage 4's capture
// box is the first animation, and it must add that override and change this.
test('press state is instant, and the stylesheet declares no motion yet', () => {
  assert.equal(declOf('button.pressed', 'transition'), null);
  assert.equal(declOf('[data-press].pressed', 'transition'), null);
  assert.doesNotMatch(css, /(^|[;{\s])(transition|animation)(-[a-z-]+)?\s*:/);
  assert.doesNotMatch(css, /@keyframes/);
});
```

Append to `tests/apply.test.js`:

```js

// --- home-screen stage 2: the press state is wired (spec § 5) ---------------
// js/press.js's behaviour is pinned in tests/press.test.js; this pins that the
// app actually installs it, on the document, exactly once.
test('app.js installs the press listeners on the document, once each', async () => {
  await import('../js/app.js');
  const { PRESS_EVENTS } = await import('../js/press.js');
  for (const type of PRESS_EVENTS) {
    assert.equal((globalThis.document._listeners[type] || []).length, 1, type);
  }
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/styles.test.js`
Expected: 3 failures — `every tap skips the double-tap-zoom wait`, `pressed buttons dim…`, `the grey iOS tap highlight…`. `press state is instant…` passes already (a guard; checked by mutation in Step 5).
Run: `node --test tests/apply.test.js`
Expected: `not ok … - app.js installs the press listeners on the document, once each` (`pointerdown`: `0 !== 1`).

- [ ] **Step 3: Implement**

In `styles.css`, replace:

```css
/* ---------- base ---------- */
* { box-sizing: border-box; }
```

with:

```css
/* ---------- base ---------- */
* { box-sizing: border-box; }

/* No double-tap-to-zoom delay on any tap (home-screen spec § 5). */
html { touch-action: manipulation; }
```

Replace:

```css
.message { color: var(--muted); min-height: 1.2em; margin: 8px 0 0; }
```

with:

```css
.message { color: var(--muted); min-height: 1.2em; margin: 8px 0 0; }

/* ---------- press state (home-screen spec § 5) ---------- */
/* js/press.js adds .pressed on pointerdown and removes it on pointerup,
   pointercancel, pointerleave or a move past 10px (a scroll). A class, not
   :active, which can stick during an iOS scroll (WebKit 255277, 221366).
   Instant on purpose: no transition. The grey iOS tap highlight is turned off
   only where .pressed replaces it; links and checkboxes keep it. */
button, [data-press] { -webkit-tap-highlight-color: transparent; }
button.pressed { opacity: 0.7; }
[data-press].pressed { background: var(--chip-bg); }
```

In `js/app.js`, after line 31 (`import { fetchWithTimeout } from './fetchtimeout.js';`) add:

```js
import { installPress } from './press.js';
```

Immediately before `document.addEventListener('visibilitychange', () => {` (line 1243 before the import was added; 1244 after), insert:

```js
// Touch-down feedback on every button and [data-press] row (home-screen spec
// § 5, js/press.js). Once, for the page's lifetime: never uninstalled.
installPress(document);

```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/styles.test.js` → `# fail 0`, `# cancelled 0`.
Run: `node --test tests/apply.test.js` → `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant | Must fail |
|---|---|
| delete `installPress(document);` from app.js | `app.js installs the press listeners on the document, once each` |
| call `installPress(document);` twice | `app.js installs the press listeners…` (`2 !== 1`) |
| `button.pressed { opacity: 0.7; transition: opacity 120ms; }` | `press state is instant, and the stylesheet declares no motion yet` |
| `html { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }` | `the grey iOS tap highlight is off exactly where .pressed replaces it` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add styles.css js/app.js tests/styles.test.js tests/apply.test.js && git commit -m "feat(app): install the press state; touch-action manipulation; press styles" -m "Home-screen spec § 5: buttons dim to 0.7 and [data-press] rows take --chip-bg on touch-down; the iOS tap highlight is off only where .pressed replaces it. No motion added." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1345`, `# fail 0`, `# cancelled 0`.

---

### Task 10: ship stage 2 — REQUIRES ALEX'S EXPLICIT GO-AHEAD

Merging to `main` deploys. Without an explicit yes from Alex in this conversation for this merge, stop after Step 1.

**Files:**
- Modify: `service-worker.js:13` (`CACHE`)
- Modify: `tests/serviceworker.test.js:48` (`CACHE_ON_MAIN`)

**Interfaces:**
- Consumes: `CACHE` on `main` after Task 3 (`plaenicke-v6-7`).
- Produces: `CACHE = 'plaenicke-v6-8'`; `CACHE_ON_MAIN = 'plaenicke-v6-7'`. `ASSETS` already lists `js/press.js` (Task 8).

- [ ] **Step 1: Ask Alex, and wait**

Send: "Stage 2 (tokens, press state, 16px inputs) is ready on `home-screen-design`: `npm test` 1345 pass, 0 fail, 0 cancelled. Visible changes: buttons and inputs get 8px corners, the item sheet 14px; the Settings calendar fields, link-code fields and smart-add preview fields go from 0.9rem/0.7rem to 16px; every button dims while pressed. Shipping bumps the cache to v6-8, merges into `main` and pushes — a production deploy. Go ahead?" Go on to Step 2 only after an explicit yes.

- [ ] **Step 2: Check that main has not moved**

```bash
git fetch origin && git rev-parse main origin/main && git show main:service-worker.js | grep "const CACHE"
```

Expected: the two SHAs are identical, and `const CACHE = 'plaenicke-v6-7';`. If either differs, stop and report.

- [ ] **Step 3: Re-pin the guard (the failing test)**

In `tests/serviceworker.test.js`, change line 48 to:

```js
const CACHE_ON_MAIN = 'plaenicke-v6-7';
```

- [ ] **Step 4: Run it and see it fail**

Run: `node --test tests/serviceworker.test.js`
Expected: `not ok 3 - the cache name is ahead of the release on main` with `… main's 'plaenicke-v6-7' …; got 'plaenicke-v6-7'`.

- [ ] **Step 5: Bump CACHE**

In `service-worker.js`, change line 13 to:

```js
const CACHE = 'plaenicke-v6-8';
```

- [ ] **Step 6: Run it and see it pass; mutation-check**

Run: `node --test tests/serviceworker.test.js` → `# pass 9`, `# fail 0`.
Mutant: remove `'js/press.js', ` from ASSETS → `every js/ module is precached…` fails. Restore it.

- [ ] **Step 7: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add service-worker.js tests/serviceworker.test.js && git commit -m "release: bump service-worker CACHE to plaenicke-v6-8" -m "Re-pins the test's CACHE_ON_MAIN to main's v6-7 so the guard can fail." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Merge, re-test on main, push**

```bash
git checkout main && git merge --no-ff home-screen-design -m "merge: home screen stage 2 — tokens, press state, 16px inputs" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git push origin main && git checkout home-screen-design
```

Expected: `# tests 1345`, `# fail 0`, `# cancelled 0`, the push succeeds. If the gate fails on main, do not push.

- [ ] **Step 9: Live check**

With the Monitor tool:

```bash
until curl -s https://ajaenicke518.github.io/plaenicke/service-worker.js | grep -q "plaenicke-v6-8"; do sleep 15; done; echo live
```

Then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://ajaenicke518.github.io/plaenicke/js/press.js
```

Expected: `live`, then `200`.

- [ ] **Step 10: On-device check (Alex, iPhone home-screen app, light and dark)**

Ask Alex to open the app twice, then check:

- Press feedback is instant on a button. It does not flash when a scroll starts over a button, and it never stays stuck after a scroll.
- Tapping into Settings → Add calendar link, Settings → Sync link-code fields, and the smart-add preview fields does not zoom the page.
- The 8px corners on buttons and inputs and the 14px item-sheet corners look right in light and dark.
- Month, Week and Day look the same as before.

If he sees a flash at scroll start, stop: the delayed-press variant (spec § 5, "add it after a short delay instead") becomes a new task with its own failing test, not a patch to this one. The red-and-orange overdue readability check waits for stage 3b, the first screen that shows `--overdue-start`.

---

## Self-review against the spec

**Coverage of stages 1–2:**

| Spec item | Task |
|---|---|
| § 8.1 feed-shape readout naming rule or heuristic per feed | 1, 2 |
| § 2.4 pure, tested `feedShape(entry.events)` over the cache, no network, no URL | 1 (signature takes `targetTz` too — see Architecture), 2 |
| § 2.4 only `FREQ=DAILY`/`WEEKLY` repeat; yearly/monthly are one-offs; overrides belong to the series; master-less override is a one-off | 1 |
| § 2.4 heuristic only for a feed with no RRULE; same title + weekday + time on 3+ distinct weeks | 1 |
| § 2.4 the two example lines | 1 (`142 events: 6 repeat (RRULE), 136 single`; `136 events: no RRULE — 118 in 6 guessed series, 18 single`, each with the method sentence added) |
| § 6 feed URLs never rendered or logged | 2 (render and log tests) |
| § 6 service worker: ASSETS, CACHE, re-pin incl. `CACHE_ON_MAIN` | 3, 8, 10 |
| § 8 "Merging to `main` is the deploy" | 3, 10 (gated on Alex) |
| § 5 colour: `--overdue-start` light `#9c5418` / dark `#e39a52`, both themes | 4 |
| § 5 spacing 4/8/12/16/24/32; radii 8 / 14 / 50% | 5 |
| § 5 16 px on every input | 6 |
| § 5 type scale for new screens only; Month and Week keep their sizes | 7 |
| § 5 press state: delegated pointerdown, `.pressed` on `button, [data-press]`, cleared on up/cancel/leave/>10px | 8 |
| § 5 rows `--chip-bg`, buttons 0.7, `touch-action: manipulation` on `html`, a class not `:active` | 9 |
| § 7 `tests/styles.test.js`: 16 px inputs, reduced motion, `touch-action`, `--overdue-start` in both themes | 6, 9, 9, 4 |

**Placeholders:** none. Every code step has the code that was run against a copy of this branch (f25d72a). That copy passed 1345/1345 with every mutant in the tables killed. The test counts are from those runs.

**Names, checked across tasks:** `feedShape(events, targetTz)` and `describeFeedShape(shape)` (Tasks 1 and 2). The shape fields are `total`, `method`, `repeatingSeries`, `repeatingChanged`, `otherRuleEvents`, `guessedSeries`, `inGuessedSeries` and `single` (Tasks 1 and 2). The class is `feed-shape` (Task 2 CSS and tests). `installPress`, `PRESS_SELECTOR`, `PRESS_MOVE_PX` and `PRESS_EVENTS` are in Tasks 8 and 9. The tokens are `--overdue-start`, `--space-1..6`, `--radius-control`, `--radius-sheet`, `--radius-round`, `--text-label`, `--text-row`, `--text-title`, `--text-hero`, `--label-tracking` and `--sans` (Tasks 4, 5, 7). Cache names are v6-6 → v6-7 (Task 3) → v6-8 (Task 10).

**Review Focus:** each of the five has a named test inside its owning task (Tasks 1, 2, 4, 8). Item 4's eye check (telling red from orange) is moved to stage 3b's on-device check, because nothing renders the token before then.

**Fixed inline during this review:**
- The 16 px list repeated the item sheet's three selectors, which the edit-items tests already pin. They are dropped from `INPUT_RULES`.
- The Task 3 version pins were checked against main and against the live site.
- The tap-highlight scope was narrowed from `html` to `button, [data-press]`.

**Not done in stages 1–2 (by design):**
- The capture button's `scale(.94)` press style: the button does not exist until stage 4.
- `[data-press]` on any existing row: no current row carries it, and stage 3b's Today rows are the first.
- Applying the spacing tokens to existing rules: see Architecture.
