# plaenicke home screen — stage 3 (Today) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Stage 3a — every feed instance says whether its series repeats (`recurring`, by RRULE `FREQ=DAILY`/`WEEKLY`, or by the Canvas heuristic for a feed with no RRULE, flagged `guessedSeries`), and a pure, tested `buildToday(...)` decides Overdue / To do today / Today's events / Next 7 days exactly as spec § 2.3 says. Stage 3b — a Today page beside the existing view buttons, drawn from `buildToday`, with the gear on it, a 60 s tick that changes only the "in N" text, and the new type scale. Stage 3c — the bottom tab bar Today | Calendar | To-do | Ideas replaces the six view buttons; Calendar gets a Day / Week / Month / List switcher (no 3-day); the toast and padding move above the bar. Stage 3d — record that List stays.

**Architecture:** 3a adds `seriesIndex(events, targetTz)` to `js/feeds.js` — the one place the rule and the heuristic are decided — read by `instancesForRange` (two new boolean instance fields) and, through a shared `guessedGroups` helper, by `feedShape` (the Settings line), so the readout and Today cannot disagree. A new pure module `js/today.js` holds `sectionOf`, `daysBetween`, `dayWord`, `relativeLabel`, `isPastEvent` and `buildToday`. 3b adds `js/todayview.js` (presentation only, like `todoview.js`), a `#today-view` section in `index.html`, and `renderToday`/`syncTodayTick` in `js/app.js`. 3c rewrites `showView` around a tab and a Calendar sub-view. Nothing is stored, synced or migrated: instances are built on demand and never pass through `makeItem`; `ics.js`, `sync.js`, `merge.js` and `schemaVersion` are untouched.

Decisions this plan makes where the spec is silent or would not work as written (each is a test below; Alex, confirm or edit):

- **The Canvas-deadline risk is closed structurally: the heuristic never groups an event with no length.** Canvas writes a timed assignment as `DTSTART == DTEND` and an untimed one as an all-day `DATE` (provider-format notes, "Canvas LMS — Concrete"); all-day events were already never grouped (stage 1). So an event with no DTEND/DURATION, or a DTEND not after DTSTART, is never part of a guessed series, and a weekly deadline always stays a one-off in Next 7 days. Not a title rule: matching "due"/"quiz" in titles is permissive guessing, and it fails both ways. The cost: a class meeting a feed writes with no end is never guessed, so it stays in Next 7 days — the direction that shows too much, never hides a deadline. Task 2.
- **`feedShape` uses the same grouping, so the Settings line changes for a no-RRULE feed:** zero-length events now count as `single`. LMU Classes uses the rule, so its line ("34 events: 7 repeat (RRULE), 27 single. Uses the rule.") does not change. Three stage-1 test fixtures gain a 50-minute `DURATION` so they still describe classes (Task 2 lists them).
- **`buildToday` takes a fifth argument, `lookahead`**, a function returning the 30-day instances. The spec writes four arguments and also says the 30-day call is "made only then" (first three sections empty); a function is how a pure `buildToday` can make that call conditional. A test pins that it is called only then.
- **`buildToday` throws on an instance without a boolean `recurring`**, rather than treating it as a one-off (zero-fallback). Every instance from `instancesForRange` carries it after Task 1.
- **Overdue age is always whole days, `Nd`** ("1d", "142d"), counted on calendar dates so DST cannot change it. Spec gives only "2d".
- **Day names:** "Tomorrow", then the weekday ("Thu") up to today + 7, then `formatDayLabel`'s date ("Thu, Oct 29"). Used for Next 7 days' day headings and the empty-day line.
- **Relative time:** "in 42 min" under an hour; "in 2 h 10 min", or "in 2 h" on the hour, up to exactly 12 h; "now" while it runs — for an event with no end, during its start minute only. The next event is the first timed event today that has not ended. A finished timed event is "past" (greyed) once its end has passed, or once its start minute has, with no end. Between renders the tick empties the label of an event that has ended; the next render greys it.
- **The checkbox decision (punchlist carry-over 1):** a Today row's pressable part is its open `<button data-press>`; the checkbox is its sibling, so nothing above a checkbox is pressable and a tick never presses the row. `button[data-press].pressed` keeps opacity 1, so a pressed row is tinted (`--chip-bg`), not dimmed. Checkboxes are on Overdue and To do today rows only; Today's events and Next 7 days rows open the sheet and have none.
- **Rows show the title and time, never the calendar's name.** An untimed event shows "All day". A feed row is coloured by its calendar (`--feed-color`, the existing mechanism).
- **3b opens the app on Today** (it opened on Day), so Alex uses Today as the home screen from 3b on. The gear moves from the shell header into Today's header (spec § 2.2), so in 3b Settings is reached through the Today button. The seventh nav button fits at 390 px: measured in Chrome at 390×844, the nav's scrollWidth is 358 of 358 px, with "To-do" wrapping to two lines. It is temporary: 3c removes the row.
- **3b keeps the toast where it is.** The spec's new toast geometry is relative to the tab bar and the capture button; it moves in 3c, with the bar.
- **The 60 s tick is a `setInterval`** while Today and the page are both visible, synced on load, on `showView` and on `visibilitychange`. In `tests/apply.test.js` every interval is recorded and never scheduled: measured on Node 22.18, a real interval left running keeps that file's process alive after its last test.
- **3c ids:** tabs are `tab-today`, `tab-calendar`, `tab-todo`, `tab-ideas`; the switcher keeps `show-day`, `show-week`, `show-month`, `show-list`, so every test that taps those keeps working; `show-today`, `show-todo`, `show-ideas` are removed. Calendar opens on the view last used there in this session (Day at launch); it is not stored. The shell `<h1>` becomes `#tab-title` ("Calendar", "To-do", "Ideas", 20 px) and is hidden on Today, whose own 28 px heading names the day.
- **3c reserves the capture button's row now.** Body bottom padding is the spec's `56px + 72px + inset`, and the toast's `right: 88px`, although the button arrives in stage 4. Measured in Chrome at 375×667: the toast is 271 px wide and two lines (66 px) tall for `Deleted "Physics problem set 4"` with a 71 px Undo; Calendar's switcher with a fifth segment inserted is 343 of 343 px, five 65 px segments, so adding 3-day later changes no layout.
- **3a is not released on its own.** It has no visible effect; it ships with 3b (Task 10).

**Amendment 2026-10-22 (Alex's answers; brief: `docs/superpowers/plans/2026-10-22-plaenicke-home-stage3-autonomous-brief.md`):**

- **A ticked overdue item stays in Overdue, struck through, until tomorrow** (Alex: "it should stay struck through until tomorrow"; overrides spec § 2.3 "A ticked overdue item leaves Overdue"). No item records when it was ticked, and § 6 forbids new item fields, so "ticked today" is read as **`updatedAt` falls on today's local date**: `handleToggleDone` bumps `updatedAt` on every tick. Known cost: any later write to a done overdue item (a note edit, on any device) shows it again, struck, for the rest of that local day; it can never hide an undone item. No readable `updatedAt` → not shown. Under clock skew `nextStamp` can stamp a tick on a later local day (the row then leaves at once, or shows struck tomorrow); it can still never hide an undone item. In Overdue, undone rows come first (oldest first), then ticked ones (oldest first) — the "done last" rule To do today already has. A ticked overdue row keeps its age and colour and its checked checkbox, so unticking it on Today works exactly as in To do today. Tasks 3 and 4 below carry the code and the tests; Task 5/7/9 need no change (they draw `done` the same in every section).
- **A "no class" one-off shows next to the class** — as planned. **Display formats approved** as planned.
- **DA review of this amendment (2026-10-22), applied:** `tests/today.test.js` pins `process.env.TZ = 'America/Los_Angeles'` (node --test runs each file in its own process; the new tests need a zone west of UTC−6, and the `daysBetween` mutant needs a DST zone); spec § 2.3 carries the amendment so reviewers do not "fix" it back; Task 7 gains one `apply.test.js` test that ticks an overdue item through the app (below); Task 13 ships from the stacked branch `home-screen-3c` (rewritten below); subagents work in the main checkout on the named branch, never an isolated worktree (those are cut from `main`).
- **Test counts:** the amendment adds one test to Task 3 and one to Task 4, and one more to `apply.test.js` in Task 7. Every `Expected` total from Task 3 Step 4 on is therefore one higher (Task 3) or two higher (Task 4 onwards) than written; the `today.test.js` file counts likewise; from Task 7 on, three higher (`apply.test.js` +1). A different difference is a finding, not noise.

**Tech Stack:** Vanilla ES modules, no framework, no build step, no bundler; `node:test` + `node:assert/strict`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-plaenicke-home-screen-design.md` (§ 2.1–2.4, § 4, § 5, § 6, § 7, § 8 stage 3, the end-of-doc confirmations, the Canvas-deadline risk and the stage 1 result).

Work in `/Users/ajaenicke25/projects/plaenicke` on branch `home-screen-design` (HEAD 94dec6a, which contains `main` e6c4d00 with stages 1–2 live). The baseline is `npm test` → `# tests 1345`, `# fail 0`, `# cancelled 0`. Line numbers are on that baseline for Tasks 1–6 and on the branch at the start of the task after that; every edit quotes the exact text it replaces, and the Python edits stop with an AssertionError if a quoted text is not found exactly once.

Every code step below was applied in order to a throwaway worktree of 94dec6a and run: the failure lists, the pass counts and the totals are from those runs, and every mutant in the tables failed the named tests.

---

## Global Constraints

- Tests: "`npm test` is `node --test` with no arguments and it RECURSES." "`node --test tests/` runs ZERO tests … Never use it." One file: `node --test tests/<file>.test.js`.
- Commits: "Gate a commit on `# fail 0` AND `# cancelled 0`." Every commit step uses this gate verbatim: `npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add … && git commit …`
- Every commit message ends `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- "Node 22 has no `localStorage`. Any storage-touching test must call `installFakeLocalStorage()` from `tests/fake-localstorage.js`."
- "`tests/fake-dom.js` is the shared fake DOM, and its `getElementById` returns `null` for an unmounted id. `apply.test.js` mounts every id `index.html` declares before importing app.js." New ids in `index.html` are therefore mounted automatically; `index.html mounts every element app.js looks up by id` checks the other direction.
- "`apply.test.js` installs an offline `fetch` at the top of the file. … Keep it." `import './offline-fetch.js'` stays its first import. No test in this plan reaches the network; Task 7's calendar test uses a seeded cache.
- Mock timers in `apply.test.js`: "use `enableMockTimers(t, …)` / `await resetMockTimers(t)` … not `t.mock.timers.enable`/`reset` directly" for `setTimeout`. Tests here that mock only `Date` use `t.mock.timers.enable({ apis: ['Date'], … })` / `reset()`, as the existing sweep-D tests do. No test mocks `setInterval`; Task 8 records intervals instead.
- "**Feed URLs are never rendered or logged.** Today rows, the sheet and the stage-1 readout show the calendar name only" (spec § 6). Today rows show neither the URL nor the name (Task 4 and Task 7 test the URL).
- "**Calendar visibility writes** re-read `loadFeeds()` just before saving" (spec § 6): this plan writes no feed and no visibility; `instancesForRange` only reads.
- "**No new item fields**" (spec § 6): `recurring` and `guessedSeries` are instance fields, built on demand, never stored, never passed through `makeItem`.
- "**Sync is untouched** (`sync.js`, `merge.js`, `schemaVersion`, ownership, visibility gate)" (spec § 6). The only write path used is the existing `setDone` through `handleToggleDone`.
- "**Service worker:** new modules into `ASSETS`, `CACHE` bumped, `serviceworker.test.js` re-pinned (incl. stale `CACHE_ON_MAIN`)" (spec § 6). "RE-PIN THIS TO main's VALUE ON EVERY RELEASE" (`tests/serviceworker.test.js:48`, today `'plaenicke-v6-7'` while main is `'plaenicke-v6-8'`).
- "**There is no CI workflow. GitHub Pages serves `main` directly, so merging to `main` IS the deploy.**" No merge to `main` and no push without Alex's explicit go-ahead in the conversation (Tasks 10 and 13).
- "**16 px on every input.**" and "Rows, not cards: full width, 1 px `--line` hairline, at least 44 px" and the type scale "13 px labels/times (uppercase, +0.06em, `--muted`), 16 px rows, 20 px tab titles, 28 px the Today heading; Georgia for titles, `system-ui` with tabular numerals elsewhere. **Month and Week keep their compact sizes.**" (spec § 5).
- "**One accent,** `--accent`: today/now, the active tab, the capture button, the next event's relative time. `--danger` only for a deadline's overdue age; the new `--overdue-start` … only for a passed start date's age." (spec § 5).
- "**Layers:** content 0 < tab bar 5 < capture button 6 < capture box 8 < settings backdrop 10 < item sheet 15 < toast 20" and "bar fixed at the bottom, 56 px + `env(safe-area-inset-bottom)`; body bottom padding `56px + 72px + inset`. The toast moves … to `56px + 12px + inset`, `right: 88px`" (spec § 4).
- "**No caps and no "+N more", in any section**" (spec § 2.3, question 3).
- "`ics.js` is unchanged" (spec § 2.4). This plan does not edit it.
- "Vanilla ES modules — **no framework, no build step, no bundler.**" No new dependencies.
- Mutation-check every new assertion: plant the named mutant, see the named test fail, restore it, and confirm with `git diff` that only the task's own changes remain. "Reading finds shape errors; running finds real ones."

---

## Review Focus

Five inputs the spec implies that the ordinary tests of each task would probably not cover, and that are most likely to catch Alex out first. Each one's test is written into the task that owns it.

1. **A class with a cancelled meeting (EXDATE), a moved meeting (RECURRENCE-ID override), and a "no class" one-off on a class day.** LMU Classes is rule-shaped and its 27 one-offs include 2 "no class" days (stage 1 result). The class must never appear under Next 7 days, a moved meeting must show at its new time on its own day, a cancelled one must simply not be there, and the "no class" event must show on its day. Because his calendar carries no EXDATE for those days, the class also still shows that day: Today shows what the feed says. Tests, all through real ICS text → `parseICS` → `instancesForRange` → `buildToday`: Task 4 `Review Focus: a moved class shows at its new time today, and no class is ever under Next 7 days`, `… on a day with no class, the coming week's classes still stay out of Next 7 days`, `… after the DST change the class keeps its 10:00, and a "no class" day shows both`, `… a cancelled class (EXDATE) is simply not on its day`.
2. **An all-day multi-day event, and a timed event across midnight.** Each emits one instance per day (`ics.js` `emitOccurrence`). Shown under Today's events if it covers today, else once under Next 7 days on its first day. Tests: Task 4 `buildToday: a one-off over several days is shown once — today if it covers today, else on its first day`; `Review Focus: … on a day with no class …` (a three-day break from today).
3. **An overdue item from months ago.** Alex: "just say everything is past due". No age limit; "142d", not hidden or capped. Tests: Task 3 `daysBetween counts calendar days …` (112 days), Task 4 `buildToday: an overdue item from months ago is still overdue, with its whole age`.
4. **The DST week (1 Nov 2026).** A 23- or 25-hour day must not move Next 7 days' edge, shorten an overdue age, split a UTC-stamped Canvas class into two guessed series, or move a TZID class off 10:00. Tests: Task 2 `instancesForRange: a guessed UTC-stamped class stays one series across the DST change`; Task 3 `daysBetween counts calendar days, so a DST change or months between cannot skew it`; Task 4 `Review Focus: the DST week moves neither the Next 7 days edge nor an overdue age`, `Review Focus: after the DST change the class keeps its 10:00 …`.
5. **A day with only classes.** Nothing is overdue or due, so the first two sections are empty, but classes are events: Today's events holds them, nothing else is drawn, and no "Nothing due today" line appears, so the 30-day look-ahead never runs. Test: Task 4 `buildToday: a day with only classes shows them, draws nothing else, and says nothing about "due"` (its `lookahead` throws if called).

---

# Stage 3a — repeating events and `buildToday` (spec § 8, 3a)

### Task 1: `recurring` — the rule, per feed, on every instance

**Files:**
- Modify: `js/feeds.js:541-543` (insert a `seriesIndex` section before the `instancesForRange` header), `js/feeds.js:567` (the instance contract comment), `js/feeds.js:584-586` (the expansion `try`), `js/feeds.js:609-610` (the pushed instance)
- Modify: append to `tests/feeds.test.js` (after line 1084)

**Interfaces:**
- Consumes: `REPEATING_FREQS`, `freqOf(rrule)` (`js/feeds.js`, stage 1); ParsedEvent `{ uid, rrule: string|null, recurrenceId: {value, tzid}|null, … }`; `expandEvents` instances `{ uid, title, date, time, endTime }` (overrides carry the master's uid, `js/ics.js` `expandEvents`).
- Produces:
  - `export function seriesIndex(events) -> { repeating: Set<uid>, guessed: Set<uid> }` (Task 2 adds the `targetTz` argument and fills `guessed`)
  - every `instancesForRange` instance gains `recurring: boolean` and `guessedSeries: boolean`; its key set is exactly `createdAt, date, endTime, external, feedColor, feedId, guessedSeries, id, recurring, time, title, uid`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `tests/feeds.test.js` (it reuses the stage-1 `pe` helper defined above it):

```js
// --- recurring: which instances repeat (home-screen spec § 2.4, stage 3a) ----
//
// Today shows a repeating event only on its own day and keeps it out of Next 7
// days. A series is (feedId, uid); it repeats if that feed's cache holds a
// master with FREQ=DAILY or FREQ=WEEKLY. Every instance says so in a boolean
// `recurring`, and `guessedSeries` says whether the heuristic decided it.

const RFEED = { id: 'feedR', url: 'https://example.com/r.ics', name: 'Classes', color: '#00f', hidden: false };
const SFEED = { id: 'feedS', url: 'https://example.com/s.ics', name: 'Other', color: '#0ff', hidden: false };
const cacheFor = (byFeed) => Object.fromEntries(Object.entries(byFeed)
  .map(([id, events]) => [id, { fetchedAt: '2026-08-01T00:00:00.000Z', events, skipped: [] }]));
const flagsByUid = (instances) => {
  const out = {};
  for (const i of instances) (out[i.uid] ||= []).push([i.recurring, i.guessedSeries]);
  return out;
};

test('instancesForRange: every instance carries recurring and guessedSeries, both booleans', () => {
  const events = [pe({ uid: 'one', value: '20260825T170000Z' }), pe({ uid: 'w', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' })];
  const out = instancesForRange([RFEED], cacheFor({ feedR: events }), '2026-08-24', '2026-08-30', 'UTC');
  assert.equal(out.length, 2, 'fixture check');
  for (const inst of out) {
    assert.deepEqual(Object.keys(inst).sort(), [
      'createdAt', 'date', 'endTime', 'external', 'feedColor', 'feedId', 'guessedSeries', 'id',
      'recurring', 'time', 'title', 'uid',
    ]);
    assert.equal(typeof inst.recurring, 'boolean');
    assert.equal(typeof inst.guessedSeries, 'boolean');
  }
});

test('instancesForRange: only a DAILY or WEEKLY series is recurring; YEARLY, MONTHLY and one-offs are not', () => {
  const events = [
    pe({ uid: 'weekly', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }),
    pe({ uid: 'daily', value: '20260824T080000Z', rrule: 'freq=daily;COUNT=3' }),
    pe({ uid: 'yearly', value: '20260826T120000Z', rrule: 'FREQ=YEARLY' }),
    pe({ uid: 'monthly', value: '20260827T120000Z', rrule: 'FREQ=MONTHLY' }),
    pe({ uid: 'once', value: '20260828T120000Z' }),
  ];
  const flags = flagsByUid(instancesForRange([RFEED], cacheFor({ feedR: events }), '2026-08-24', '2026-08-30', 'UTC'));
  assert.deepEqual(flags, {
    weekly: [[true, false]],
    daily: [[true, false], [true, false], [true, false]],
    yearly: [[false, false]],
    monthly: [[false, false]],
    once: [[false, false]],
  }, 'a rule-detected series is never labelled guessed');
});

test('instancesForRange: an override belongs to its weekly series, wherever it moved; a master-less override is a one-off', () => {
  const rid = (value) => ({ value, tzid: null });
  const events = [
    pe({ uid: 'class', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }),
    // Monday 31 Aug moved to Wednesday 2 Sep.
    pe({ uid: 'class', value: '20260902T180000Z', recurrenceId: rid('20260831T170000Z') }),
    pe({ uid: 'orphan', value: '20260901T170000Z', recurrenceId: rid('20260901T170000Z') }),
  ];
  const out = instancesForRange([RFEED], cacheFor({ feedR: events }), '2026-08-31', '2026-09-06', 'UTC');
  assert.deepEqual(out.map((i) => [i.uid, i.date, i.recurring]), [
    ['orphan', '2026-09-01', false],
    ['class', '2026-09-02', true],
  ]);
});

test('instancesForRange: a series is per feed — the same uid in another feed is not recurring', () => {
  const out = instancesForRange([RFEED, SFEED], cacheFor({
    feedR: [pe({ uid: 'x', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' })],
    feedS: [pe({ uid: 'x', value: '20260825T170000Z' })],
  }), '2026-08-24', '2026-08-30', 'UTC');
  assert.deepEqual(out.map((i) => [i.feedId, i.recurring]), [['feedR', true], ['feedS', false]]);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/feeds.test.js`
Expected: `# tests 67`, `# fail 4` — `every instance carries recurring and guessedSeries, both booleans` (the key list lacks both), `only a DAILY or WEEKLY series is recurring…`, `an override belongs to its weekly series…`, `a series is per feed…` (each reads `undefined`).

- [ ] **Step 3: Implement**

Run from the repo root:

```bash
python3 - <<'PY'
p = 'js/feeds.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep("""// ---------------------------------------------------------------------------
// instancesForRange
// ---------------------------------------------------------------------------
""", """// ---------------------------------------------------------------------------
// seriesIndex — which of a feed's series repeat (spec § 2.4, stage 3a)
// ---------------------------------------------------------------------------

// seriesIndex: the repeating series of ONE feed's cached ParsedEvents.
//   repeating  uids that repeat: their master has FREQ=DAILY or FREQ=WEEKLY.
//              A RECURRENCE-ID override shares its master's uid, so it
//              belongs to the series wherever it moved; a master-less
//              override has no FREQ and is a one-off. MONTHLY and YEARLY
//              series are one-offs (spec § 2.4, question 7).
//   guessed    the subset of `repeating` the heuristic decided (empty for now)
// A series is (feedId, uid): instancesForRange calls this per feed, so the
// same uid in another feed is another series.
export function seriesIndex(events) {
  const repeating = new Set();
  for (const ev of events) {
    if (!ev.recurrenceId && REPEATING_FREQS.has(freqOf(ev.rrule))) repeating.add(ev.uid);
  }
  return { repeating, guessed: new Set() };
}

// ---------------------------------------------------------------------------
// instancesForRange
// ---------------------------------------------------------------------------
""")
rep("""//   feedId, feedColor, external: true
""", """//   feedId, feedColor, external: true
//   recurring      true if the instance's series repeats (seriesIndex): Today
//                  shows it only on its own day, never under Next 7 days
//   guessedSeries  true if the heuristic, not an RRULE, decided that
""")
rep("""    let expanded;
    try {
      expanded = expandEvents(entry.events, start, end, targetTz);""", """    let expanded;
    let series;
    try {
      expanded = expandEvents(entry.events, start, end, targetTz);
      series = seriesIndex(entry.events);""")
rep("""        feedColor: feed.color,
        external: true,
      });""", """        feedColor: feed.color,
        external: true,
        recurring: series.repeating.has(inst.uid),
        guessedSeries: series.guessed.has(inst.uid),
      });""")
open(p, 'w').write(s)
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/feeds.test.js` → `# tests 67`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

Plant each in `js/feeds.js`, run `node --test tests/feeds.test.js`, see the named test fail, restore:

| Mutant | Must fail |
|---|---|
| `recurring: series.repeating.has(inst.uid),` → `recurring: true,` | `only a DAILY or WEEKLY series…`, `an override belongs…`, `a series is per feed…` |
| `REPEATING_FREQS.has(freqOf(ev.rrule))` → `freqOf(ev.rrule) !== null` (any FREQ repeats) | `only a DAILY or WEEKLY series is recurring…` |
| `if (!ev.recurrenceId && …)` → `if (ev.recurrenceId \|\| …)` (every override repeats) | `an override belongs to its weekly series…; a master-less override is a one-off` |
| one module-level `Set` shared by every call instead of `new Set()` per feed | `a series is per feed — the same uid in another feed is not recurring` |
| `guessedSeries: series.guessed.has(inst.uid),` → `series.repeating.has(inst.uid)` | `only a DAILY or WEEKLY series is recurring…` (a rule series is never labelled guessed) |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/feeds.js tests/feeds.test.js && git commit -m "feat(feeds): every instance says whether its series repeats" -m "Home-screen spec § 2.4, stage 3a: recurring is true for a (feedId, uid) series whose master has FREQ=DAILY or WEEKLY; overrides belong to it; YEARLY, MONTHLY and master-less overrides are one-offs. guessedSeries is false until the heuristic lands. Built on demand, never stored." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1349`, `# fail 0`, `# cancelled 0`, then the commit.

---

### Task 2: the Canvas heuristic at render time — and never for a deadline

**Files:**
- Modify: `js/feeds.js` — insert the shared grouping before `// feedShape: counts over one feed's cached ParsedEvents` (line 453), the `method:` line (474), the heuristic branch of `feedShape` (500-520), `seriesIndex` (Task 1), the `seriesIndex(...)` call in `instancesForRange`
- Modify: `tests/feeds.test.js` — three stage-1 fixtures (`pe` at 899-905, `canvasWeekly` at 914-924, the DST test's `events.push` at 1060), then append

**Interfaces:**
- Consumes: `icsDateToLocal(value, params, targetTz)` and `parseDuration` (already imported in `js/feeds.js`); `GUESS_MIN_WEEKS` (3).
- Produces:
  - `export function seriesIndex(events, targetTz)` — for a feed with no RRULE at all, `guessed` = the uids of every event in a (title, local weekday, local start time) group on ≥ 3 distinct dates, and `repeating === guessed`; for a feed with any RRULE, Task 1's rule and an empty `guessed`.
  - module-private `guessKeyOf(ev, targetTz)`, `guessedGroups(events, targetTz)`, `usesRule(events)`, shared by `feedShape` and `seriesIndex`.
  - `feedShape`'s counts change only for events with no length, which are now `single`.

These three stage-1 fixtures change on purpose: the heuristic no longer groups an event with no length, and the stage-1 fixtures modelled classes with none. Each now lasts 50 minutes (`DURATION: PT50M`), which is what a class is. The fixture change alone changes no result — Step 2 shows the file still green before the new tests are added:

- `pe(...)` takes `dtend` and `duration` (both default `null`, as before).
- `canvasWeekly(...)` gives every meeting `duration: 'PT50M'`.
- `feedShape: a UTC-stamped weekly class stays one series across the DST change` gives its meetings `duration: 'PT50M'`.

- [ ] **Step 1: Update the stage-1 fixtures**

```bash
python3 - <<'PY'
p = 'tests/feeds.test.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep("""// A ParsedEvent as parseICS stores it (ics.js buildParsedEvent).
function pe({ uid, title = uid, form = 'UTC', value, tzid = null, rrule = null, recurrenceId = null }) {
  return {
    uid, title, form, dtstart: { value, tzid }, dtend: null, duration: null,
    rrule, exdates: [], recurrenceId,
  };
}""", """// A ParsedEvent as parseICS stores it (ics.js buildParsedEvent).
function pe({
  uid, title = uid, form = 'UTC', value, tzid = null, rrule = null, recurrenceId = null, dtend = null, duration = null,
}) {
  return {
    uid, title, form, dtstart: { value, tzid }, dtend, duration,
    rrule, exdates: [], recurrenceId,
  };
}""")
rep("""// `weeks` separate VEVENTs, one per week, each with its own UID and no RRULE:
// the Canvas shape (provider-format notes: "No RRULE, ever").
function canvasWeekly(title, firstISO, weeks, hhmm, tzid = 'America/Los_Angeles') {
  const out = [];
  for (let i = 0; i < weeks; i += 1) {
    out.push(pe({
      uid: `${title}-${i}`, title, form: 'TZID', tzid, value: `${weeksAfter(firstISO, i)}T${hhmm}00`,
    }));
  }
  return out;
}""", """// `weeks` separate VEVENTs, one per week, each with its own UID and no RRULE:
// the Canvas shape (provider-format notes: "No RRULE, ever"). Each meeting
// lasts 50 minutes: stage 3a's heuristic never groups an event with no length
// (a Canvas deadline is DTSTART == DTEND).
function canvasWeekly(title, firstISO, weeks, hhmm, tzid = 'America/Los_Angeles') {
  const out = [];
  for (let i = 0; i < weeks; i += 1) {
    out.push(pe({
      uid: `${title}-${i}`, title, form: 'TZID', tzid, value: `${weeksAfter(firstISO, i)}T${hhmm}00`, duration: 'PT50M',
    }));
  }
  return out;
}""")
rep("""    events.push(pe({ uid: `stats-${i}`, title: 'Stats 101', value: `${day}T${hour}0000Z` }));""",
    """    events.push(pe({ uid: `stats-${i}`, title: 'Stats 101', value: `${day}T${hour}0000Z`, duration: 'PT50M' }));""")
open(p, 'w').write(s)
PY
```

- [ ] **Step 2: Run them; nothing changes yet**

Run: `node --test tests/feeds.test.js` → `# tests 67`, `# fail 0`.

- [ ] **Step 3: Write the failing tests**

Append to the end of `tests/feeds.test.js`:

```js
// --- guessedSeries: the Canvas heuristic at render time (spec § 2.4) ---------
//
// A feed with no RRULE at all (the Canvas shape) has each meeting as its own
// VEVENT. The same title, weekday and start time on 3+ distinct weeks is
// guessed to be one weekly series. feedShape (the Settings line) and
// instancesForRange (Today) read the same grouping, so they cannot disagree.
//
// THE CANVAS-DEADLINE RISK (spec, end notes): a weekly assignment with the
// same title, weekday and time would be grouped, and the repeating rule would
// then keep that DEADLINE out of Next 7 days. Canvas writes a timed assignment
// as DTSTART == DTEND and an untimed one as an all-day DATE (provider-format
// notes). So the heuristic groups only events with a length: a point in time
// is never part of a guessed series.

const TZ_LA = 'America/Los_Angeles';
const guessIn = (events, start, end) => instancesForRange([RFEED], cacheFor({ feedR: events }), start, end, TZ_LA);

test('instancesForRange: in a feed with no RRULE, a class on 3+ weeks is a guessed repeating series', () => {
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 4, '1000'),
    pe({ uid: 'midterm', title: 'Midterm', form: 'TZID', tzid: TZ_LA, value: '20260916T100000', duration: 'PT2H' }),
  ];
  const out = guessIn(events, '2026-09-14', '2026-09-20');
  assert.deepEqual(out.map((i) => [i.title, i.date, i.recurring, i.guessedSeries]), [
    ['Stats 101', '2026-09-14', true, true],
    ['Midterm', '2026-09-16', false, false],
  ]);
});

test('instancesForRange: two weeks is not a series, so both meetings stay one-offs', () => {
  const out = guessIn(canvasWeekly('Stats 101', '2026-08-24', 2, '1000'), '2026-08-24', '2026-09-06');
  assert.deepEqual(out.map((i) => [i.recurring, i.guessedSeries]), [[false, false], [false, false]]);
});

test('instancesForRange: one RRULE anywhere in the feed switches the heuristic off for all of it', () => {
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 4, '1000'),
    pe({ uid: 'bday', form: 'DATE', value: '20260301', rrule: 'FREQ=YEARLY' }),
  ];
  const stats = guessIn(events, '2026-09-14', '2026-09-14');
  assert.equal(stats.length, 1, 'fixture check');
  assert.equal(stats[0].recurring, false, 'its RRULE-less events stay one-offs, never guessed (spec § 2.4)');
  assert.equal(stats[0].guessedSeries, false);
});

test('instancesForRange: a weekly deadline (DTSTART == DTEND, the Canvas assignment shape) is never guessed', () => {
  const quiz = [0, 1, 2, 3].map((i) => {
    const value = `${weeksAfter('2026-08-28', i)}T235900`;
    return pe({ uid: `quiz-${i}`, title: 'Reading quiz', form: 'TZID', tzid: TZ_LA, value, dtend: { value, tzid: TZ_LA } });
  });
  const noEnd = [0, 1, 2, 3].map((i) => pe({
    uid: `essay-${i}`, title: 'Weekly essay', form: 'TZID', tzid: TZ_LA, value: `${weeksAfter('2026-08-27', i)}T170000`,
  }));
  const out = guessIn([...quiz, ...noEnd], '2026-09-10', '2026-09-18');
  assert.deepEqual(out.map((i) => [i.title, i.date, i.recurring]), [
    ['Weekly essay', '2026-09-10', false],
    ['Reading quiz', '2026-09-11', false],
    ['Weekly essay', '2026-09-17', false],
    ['Reading quiz', '2026-09-18', false],
  ], 'every deadline stays a one-off, so Next 7 days shows it');
  const shape = feedShape([...quiz, ...noEnd], TZ_LA);
  assert.equal(shape.guessedSeries, 0, 'and the Settings line says the same');
  assert.equal(shape.single, 8);
});

test('instancesForRange: a class written with DTEND after DTSTART is guessable, like one with a DURATION', () => {
  const events = [0, 1, 2].map((i) => {
    const day = weeksAfter('2026-08-25', i);
    return pe({
      uid: `lab-${i}`, title: 'Physics lab', form: 'TZID', tzid: TZ_LA, value: `${day}T140000`,
      dtend: { value: `${day}T165000`, tzid: TZ_LA },
    });
  });
  const out = guessIn(events, '2026-09-08', '2026-09-08');
  assert.deepEqual(out.map((i) => [i.recurring, i.guessedSeries]), [[true, true]]);
});

// Four Monday meetings, two each side of 1 Nov 2026: in UTC that is two
// 2-week groups (17:00Z, then 18:00Z), neither a series; in the device zone it
// is one 4-week series at 10:00.
test('instancesForRange: a guessed UTC-stamped class stays one series across the DST change', () => {
  const events = [];
  for (let i = 0; i < 4; i += 1) {
    const day = weeksAfter('2026-10-19', i);
    const hour = day < '20261101' ? '17' : '18';
    events.push(pe({ uid: `stats-${i}`, title: 'Stats 101', value: `${day}T${hour}0000Z`, duration: 'PT50M' }));
  }
  const out = guessIn(events, '2026-10-26', '2026-11-08');
  assert.deepEqual(out.map((i) => [i.date, i.time, i.recurring]), [
    ['2026-10-26', '10:00', true],
    ['2026-11-02', '10:00', true],
  ]);
});

test('feedShape and instancesForRange agree on which events are in guessed series', () => {
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 5, '1000'),
    ...canvasWeekly('Physics', '2026-08-25', 2, '0900'),
    pe({ uid: 'due', title: 'Problem set', form: 'TZID', tzid: TZ_LA, value: '20260901T235900' }),
  ];
  const shape = feedShape(events, TZ_LA);
  const out = guessIn(events, '2026-08-24', '2026-09-30');
  assert.equal(out.length, events.length, 'fixture check: every event expanded once');
  assert.equal(out.filter((i) => i.guessedSeries).length, shape.inGuessedSeries);
  assert.equal(out.filter((i) => !i.recurring).length, shape.single);
});
```

- [ ] **Step 4: Run them and see them fail**

Run: `node --test tests/feeds.test.js`
Expected: `# tests 74`, `# fail 5` — `in a feed with no RRULE, a class on 3+ weeks is a guessed repeating series`, `a weekly deadline (DTSTART == DTEND, the Canvas assignment shape) is never guessed` (`and the Settings line says the same`: `2 !== 0` — stage 1's feedShape groups both deadlines), `a class written with DTEND after DTSTART is guessable…`, `a guessed UTC-stamped class stays one series across the DST change`, `feedShape and instancesForRange agree…`. `two weeks is not a series…` and `one RRULE anywhere…` pass already; they are guards, checked by mutation in Step 7.

- [ ] **Step 5: Implement**

```bash
python3 - <<'PY'
p = 'js/feeds.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep("""// feedShape: counts over one feed's cached ParsedEvents (`entry.events`).""", """// The heuristic's grouping (spec § 2.4), shared by feedShape (the Settings
// line) and seriesIndex (Today), so the two can never disagree.
//
// guessKeyOf: an event's (title, weekday, start time) key in targetTz, and
// its local date; or null when the event can never be guessed:
//   - an untimed (all-day) event has no start time;
//   - an event with no length — no DTEND or DURATION, or a DTEND that is not
//     after DTSTART — is a point in time. That is how Canvas writes a timed
//     assignment (DTSTART == DTEND; its untimed ones are all-day), so a
//     weekly deadline is never folded into a series that Today would keep
//     out of Next 7 days (the stage 3a "Canvas-deadline" risk in the spec).
//     A class meeting has a length.
const tzParams = (ref) => (ref.tzid ? { TZID: ref.tzid } : {});

function guessKeyOf(ev, targetTz) {
  if (ev.form === 'DATE') return null;
  const start = icsDateToLocal(ev.dtstart.value, tzParams(ev.dtstart), targetTz);
  let hasLength = false;
  if (ev.dtend) {
    const end = icsDateToLocal(ev.dtend.value, tzParams(ev.dtend), targetTz);
    hasLength = `${end.date}T${end.time}` > `${start.date}T${start.time}`;
  } else if (ev.duration) {
    hasLength = parseDuration(ev.duration) > 0;
  }
  if (!hasLength) return null;
  const weekday = new Date(`${start.date}T00:00:00Z`).getUTCDay();
  return { key: JSON.stringify([ev.title, weekday, start.time]), date: start.date };
}

// guessedGroups: the groups of events on GUESS_MIN_WEEKS or more distinct
// dates, each { dates: Set, events: [ParsedEvent] }. Only meaningful for a
// feed with no RRULE; the callers check that first.
function guessedGroups(events, targetTz) {
  const groups = new Map();
  for (const ev of events) {
    const g = guessKeyOf(ev, targetTz);
    if (!g) continue;
    let group = groups.get(g.key);
    if (!group) { group = { dates: new Set(), events: [] }; groups.set(g.key, group); }
    group.dates.add(g.date);
    group.events.push(ev);
  }
  return [...groups.values()].filter((group) => group.dates.size >= GUESS_MIN_WEEKS);
}

// The heuristic runs only on a feed with no RRULE of any FREQ (spec § 2.4).
const usesRule = (events) => events.some((ev) => typeof ev.rrule === 'string');

// feedShape: counts over one feed's cached ParsedEvents (`entry.events`).""")
rep("""//     guessedSeries     (title, weekday, start time) groups on >= 3 weeks
//     inGuessedSeries   events in those groups
//     single            everything else, untimed (all-day) events included""", """//     guessedSeries     (title, weekday, start time) groups on >= 3 weeks
//     inGuessedSeries   events in those groups
//     single            everything else: untimed (all-day) events and events
//                       with no length (deadlines) included""")
rep("""    method: events.some((ev) => typeof ev.rrule === 'string') ? 'rule' : 'heuristic',""",
    """    method: usesRule(events) ? 'rule' : 'heuristic',""")
rep("""  const groups = new Map();
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
  return shape;""", """  const groups = guessedGroups(events, targetTz);
  shape.guessedSeries = groups.length;
  shape.inGuessedSeries = groups.reduce((n, group) => n + group.events.length, 0);
  shape.single = events.length - shape.inGuessedSeries;
  return shape;""")
rep("""//   guessed    the subset of `repeating` the heuristic decided (empty for now)
// A series is (feedId, uid): instancesForRange calls this per feed, so the
// same uid in another feed is another series.
export function seriesIndex(events) {
  const repeating = new Set();
  for (const ev of events) {
    if (!ev.recurrenceId && REPEATING_FREQS.has(freqOf(ev.rrule))) repeating.add(ev.uid);
  }
  return { repeating, guessed: new Set() };
}""", """//   guessed    the subset of `repeating` the heuristic decided. Only a feed
//              with no RRULE at all is guessed (Alex's approval, spec § 2.4,
//              question 8); there every member of a guessed group repeats.
// A series is (feedId, uid): instancesForRange calls this per feed, so the
// same uid in another feed is another series. `targetTz` is the zone the
// heuristic reads weekdays and start times in, as feedShape does.
export function seriesIndex(events, targetTz) {
  if (!usesRule(events)) {
    const guessed = new Set();
    for (const group of guessedGroups(events, targetTz)) for (const ev of group.events) guessed.add(ev.uid);
    return { repeating: guessed, guessed };
  }
  const repeating = new Set();
  for (const ev of events) {
    if (!ev.recurrenceId && REPEATING_FREQS.has(freqOf(ev.rrule))) repeating.add(ev.uid);
  }
  return { repeating, guessed: new Set() };
}""")
rep("""      series = seriesIndex(entry.events);""", """      series = seriesIndex(entry.events, targetTz);""")
open(p, 'w').write(s)
PY
```

- [ ] **Step 6: Run them and see them pass**

Run: `node --test tests/feeds.test.js` → `# tests 74`, `# fail 0`. Run: `node --test tests/settings.test.js` → `# fail 0` (the stage-1 Settings line tests are unchanged).

- [ ] **Step 7: Mutation-check**

| Mutant (in `js/feeds.js`) | Must fail |
|---|---|
| delete `  if (!hasLength) return null;` | `a weekly deadline (DTSTART == DTEND…) is never guessed` |
| `` `${end.date}T${end.time}` > `` → `>=` (DTEND == DTSTART counts as a length) | `a weekly deadline … is never guessed` |
| `if (!usesRule(events)) {` → `if (true) {` in `seriesIndex` | `only a DAILY or WEEKLY series…`, `an override belongs…`, `a series is per feed…`, `one RRULE anywhere in the feed switches the heuristic off…` |
| `group.dates.size >= GUESS_MIN_WEEKS` → `group.events.length >= GUESS_MIN_WEEKS` | `feedShape: the heuristic needs 3 distinct weeks, not 3 events` |
| `seriesIndex(entry.events, targetTz)` → `seriesIndex(entry.events, 'UTC')` | `a guessed UTC-stamped class stays one series across the DST change` |
| `return { repeating: guessed, guessed };` → `return { repeating: guessed, guessed: new Set() };` | `in a feed with no RRULE…`, `a class written with DTEND after DTSTART…`, `feedShape and instancesForRange agree…` |

- [ ] **Step 8: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/feeds.js tests/feeds.test.js && git commit -m "feat(feeds): the Canvas heuristic marks guessed series; a deadline is never guessed" -m "Home-screen spec § 2.4: a feed with no RRULE groups same title, weekday and start time on 3+ dates in the device zone into a guessed weekly series (recurring and guessedSeries). An event with no length (Canvas writes a timed assignment as DTSTART == DTEND) is never grouped, so a weekly deadline stays in Next 7 days. feedShape reads the same grouping; three stage-1 fixtures gain a 50-minute DURATION." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1356`, `# fail 0`, `# cancelled 0`.

---

### Task 3: `js/today.js` — sections, days, and relative time (pure)

**Files:**
- Create: `js/today.js`
- Create: `tests/today.test.js`
- Modify: `js/items.js:67` (`isTodo`, plus `isTodoType`)
- Modify: `tests/items.test.js:3-5` (import), append after line 277
- Modify: `service-worker.js:21` (`ASSETS`)

**Interfaces:**
- Consumes: `isScheduled(it)`, `sortItemsByDate` (`js/items.js`); `addDays`, `minutesOf` (`js/timegrid.js`); `formatDayLabel` (`js/freshness.js`).
- Produces:
  - `export function isTodoType(it) -> boolean` in `js/items.js` — `TODO_TYPES.has(it.type)`, done or not; `isTodo` now calls it, so `TODO_TYPES` is still written once.
  - `js/today.js`: `export const NEXT_DAYS = 7`, `export const RELATIVE_MAX_MIN = 720`, `export function sectionOf(item, todayISO) -> 'overdue'|'todo'|'events'|'next'|null`, `export function daysBetween(fromISO, toISO) -> integer`, `export function dayWord(dateISO, todayISO) -> string`, `export function relativeLabel(item, nowMinutes) -> string|null`, `export function isPastEvent(item, nowMinutes) -> boolean`.

- [ ] **Step 1: Write the failing tests**

Create `tests/today.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionOf, daysBetween, dayWord, relativeLabel, isPastEvent, NEXT_DAYS,
} from '../js/today.js';

// The "ticked today" tests turn UTC instants into local days, and the
// daysBetween mutant needs a DST zone: pin Alex's zone instead of trusting the
// machine's. node --test runs each file in its own process, and Node re-reads
// TZ when it is assigned, so this reaches today.js's Date calls and no other
// test file.
process.env.TZ = 'America/Los_Angeles';

// today.js is pure: every input is passed in, so every boundary is a plain
// value here. TODAY is a Wednesday.
const TODAY = '2026-10-21';

const own = (id, o = {}) => ({
  id, title: `t-${id}`, date: TODAY, time: null, endTime: null, type: 'task',
  createdAt: '2026-10-01', updatedAt: '2026-10-01T00:00:00.000Z',
  project: null, subject: null, category: null, done: false, notes: null, ...o,
});

// --- sectionOf: each own item belongs to one section, or none ---------------

test('sectionOf: a to-do is overdue the day after its date, due today on it, and next within 7 days', () => {
  assert.equal(sectionOf(own('a', { date: '2026-10-20' }), TODAY), 'overdue');
  assert.equal(sectionOf(own('a', { date: TODAY }), TODAY), 'todo');
  assert.equal(sectionOf(own('a', { date: '2026-10-22' }), TODAY), 'next');
  assert.equal(sectionOf(own('a', { date: '2026-10-28' }), TODAY), 'next', 'today + 7 is still in Next 7 days');
  assert.equal(sectionOf(own('a', { date: '2026-10-29' }), TODAY), null, 'today + 8 is not');
  assert.equal(NEXT_DAYS, 7);
});

test('sectionOf: every to-do type past its date is overdue — start included; nothing else is', () => {
  for (const type of ['due', 'milestone', 'task', 'start']) {
    assert.equal(sectionOf(own('a', { type, date: '2026-10-19' }), TODAY), 'overdue', type);
  }
  for (const type of ['event', 'general', 'idea']) {
    assert.equal(sectionOf(own('a', { type, date: '2026-10-19' }), TODAY), null, `${type}: past events are never overdue`);
  }
  assert.equal(sectionOf(own('a', { type: 'due', date: '2026-10-19', done: true }), TODAY), null,
    'ticked on an earlier day (own() writes updatedAt 1 Oct): gone from Overdue');
});

// Amendment 2026-10-22, Alex: "it should stay struck through until tomorrow".
// No field says when an item was ticked; a tick bumps updatedAt, so "ticked
// today" is "updatedAt is on today's LOCAL date". 03:00Z on the 22nd is 20:00
// on the 21st in America/Los_Angeles (pinned at the top of this file), which
// pins local over UTC.
test('sectionOf: a to-do ticked today after its date stays in Overdue until tomorrow', () => {
  const ticked = (updatedAt) => own('a', { type: 'due', date: '2026-10-19', done: true, updatedAt });
  assert.equal(sectionOf(ticked('2026-10-21T19:00:00.000Z'), TODAY), 'overdue', 'ticked at noon today');
  assert.equal(sectionOf(ticked('2026-10-22T03:00:00.000Z'), TODAY), 'overdue', 'ticked at 20:00 today, already the 22nd in UTC');
  assert.equal(sectionOf(ticked('2026-10-21T06:00:00.000Z'), TODAY), null, '23:00 yesterday local, though the 21st in UTC');
  assert.equal(sectionOf(ticked('2026-10-20T19:00:00.000Z'), TODAY), null, 'ticked yesterday');
  for (const updatedAt of [undefined, null, '', 'soon']) {
    assert.equal(sectionOf(ticked(updatedAt), TODAY), null, `no readable updatedAt: ${JSON.stringify(updatedAt)}`);
  }
  assert.equal(sectionOf(own('e', { type: 'event', date: '2026-10-19', done: true, updatedAt: '2026-10-21T19:00:00.000Z' }), TODAY),
    null, 'a past event is never overdue, ticked or not');
});

test('sectionOf: a to-do ticked today stays in To do today; a ticked future one leaves Next 7 days', () => {
  assert.equal(sectionOf(own('a', { done: true }), TODAY), 'todo', 'struck through until tomorrow');
  assert.equal(sectionOf(own('a', { done: true, date: '2026-10-23' }), TODAY), null);
});

test('sectionOf: events and general items go under Today\'s events today and Next 7 days after', () => {
  assert.equal(sectionOf(own('a', { type: 'event' }), TODAY), 'events');
  assert.equal(sectionOf(own('a', { type: 'general' }), TODAY), 'events');
  assert.equal(sectionOf(own('a', { type: 'event', date: '2026-10-24' }), TODAY), 'next');
});

test('sectionOf: an idea is never on Today, whatever its date', () => {
  for (const date of ['2026-10-01', TODAY, '2026-10-23']) {
    assert.equal(sectionOf(own('a', { type: 'idea', date }), TODAY), null, date);
  }
});

// deserializeItems tolerates `date: null` (CLAUDE.md), and '' is what a cleared
// date box yields. Neither has a day, and '' sorts before every real date, so
// without the check it would read as overdue.
test('sectionOf: a record with no readable date belongs to no section', () => {
  for (const date of [null, '', 'soon', '2026-1-2']) {
    assert.equal(sectionOf(own('a', { type: 'due', date }), TODAY), null, JSON.stringify(date));
  }
});

// --- dates ------------------------------------------------------------------

test('daysBetween counts calendar days, so a DST change or months between cannot skew it', () => {
  assert.equal(daysBetween('2026-10-30', '2026-11-03'), 4, 'across the 1 Nov 2026 change');
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2, 'across the 8 Mar 2026 change');
  assert.equal(daysBetween('2026-07-01', TODAY), 112);
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1);
});

test('dayWord: Tomorrow, then the weekday up to a week out, then the date', () => {
  assert.equal(dayWord('2026-10-22', TODAY), 'Tomorrow');
  assert.equal(dayWord('2026-10-23', TODAY), 'Fri');
  assert.equal(dayWord('2026-10-28', TODAY), 'Wed', 'today + 7');
  assert.equal(dayWord('2026-10-29', TODAY), 'Thu, Oct 29');
  assert.equal(dayWord('2027-01-04', TODAY), 'Mon, Jan 4, 2027');
});

// --- the next event's relative time (spec § 2.3, question 6) -----------------

const at = (hh, mm) => hh * 60 + mm;
const ev = (time, endTime = null) => own('e', { type: 'event', time, endTime });

test('relativeLabel: minutes under an hour, hours and minutes up to 12 h, "now" during it', () => {
  const tenToEleven = ev('10:00', '11:00');
  const cases = [
    [at(9, 18), 'in 42 min'],
    [at(9, 59), 'in 1 min'],
    [at(9, 0), 'in 1 h'],
    [at(7, 50), 'in 2 h 10 min'],
    [at(10, 0), 'now'],
    [at(10, 59), 'now'],
    [at(11, 0), null],
  ];
  for (const [now, want] of cases) assert.equal(relativeLabel(tenToEleven, now), want, `at ${now}`);
});

test('relativeLabel: exactly 12 h ahead is shown, a minute more is not', () => {
  assert.equal(relativeLabel(ev('22:00', '23:00'), at(10, 0)), 'in 12 h');
  assert.equal(relativeLabel(ev('22:00', '23:00'), at(9, 59)), null);
});

test('relativeLabel: an event with no end is "now" only in its start minute; an untimed one never has one', () => {
  assert.equal(relativeLabel(ev('10:00'), at(10, 0)), 'now');
  assert.equal(relativeLabel(ev('10:00'), at(10, 1)), null);
  assert.equal(relativeLabel(ev(null), at(10, 0)), null);
});

test('isPastEvent: over once its end has passed (its start, with no end); untimed never', () => {
  assert.equal(isPastEvent(ev('10:00', '11:00'), at(10, 59)), false);
  assert.equal(isPastEvent(ev('10:00', '11:00'), at(11, 0)), true);
  assert.equal(isPastEvent(ev('10:00'), at(10, 0)), false);
  assert.equal(isPastEvent(ev('10:00'), at(10, 1)), true);
  assert.equal(isPastEvent(ev(null), at(23, 59)), false);
});
```

Then add the `isTodoType` test to `tests/items.test.js`:

```bash
python3 - <<'PY'
p = 'tests/items.test.js'
s = open(p).read()
a = """  makeItem, sortItemsByDate, isScheduled, isTodo, isIdea, sortIdeasNewestFirst,
} from '../js/items.js';"""
b = """  makeItem, sortItemsByDate, isScheduled, isTodo, isTodoType, isIdea, sortIdeasNewestFirst,
} from '../js/items.js';"""
assert s.count(a) == 1
s = s.replace(a, b)
s += """
// Today's "To do today" keeps a ticked to-do until tomorrow (home-screen spec
// § 2.3), so it asks the type question without isTodo's `done` half.
test('isTodoType is the four to-do types, done or not', () => {
  for (const type of ['due', 'start', 'milestone', 'task']) {
    assert.equal(isTodoType({ type, done: false }), true, type);
    assert.equal(isTodoType({ type, done: true }), true, `${type}, done`);
  }
  for (const type of ['event', 'general', 'idea', undefined]) assert.equal(isTodoType({ type }), false, String(type));
});
"""
open(p, 'w').write(s)
PY
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/today.test.js` → `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/js/today.js'`, `# tests 1`, `# fail 1`.
Run: `node --test tests/items.test.js` → `SyntaxError: The requested module '../js/items.js' does not provide an export named 'isTodoType'`, `# fail 1`.

- [ ] **Step 3: Implement**

Create `js/today.js`:

```js
// today.js — what the Today screen shows (home-screen spec § 2.3). Pure: no
// DOM, no storage, no clock of its own. app.js passes the items, the feed
// instances, today's date and the minute of the day in; js/todayview.js draws
// the result.

import { isScheduled, isTodoType } from './items.js';
import { addDays, minutesOf } from './timegrid.js';
import { formatDayLabel } from './freshness.js';
import { toISO } from './dateparse.js';

// Next 7 days is (today, today + NEXT_DAYS].
export const NEXT_DAYS = 7;
// "in N" is shown only within this many minutes of the next event's start
// (Alex, 2026-10-21: "relative time only within 12 hours of the next event").
export const RELATIVE_MAX_MIN = 12 * 60;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// Own items that are events on Today. 'general' is every pre-V6 record's type.
const EVENT_TYPES = new Set(['event', 'general']);
const DAY_MS = 24 * 60 * 60 * 1000;
const utcOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });

// sectionOf: the one section an OWN item belongs to on `todayISO`, or null.
// One answer per item is what makes "no item twice" true by construction.
//   'overdue' every to-do type (due, milestone, task, start) whose date has
//             passed and that is not done — no age limit (Alex, question 9) —
//             or that was ticked today: it stays, struck through, until
//             tomorrow (Alex, 2026-10-22; see tickedToday)
//   'todo'    every to-do type dated today, done or not: a ticked one stays,
//             struck through, until tomorrow (question 2)
//   'events'  an event or general item dated today
//   'next'    anything scheduled and not done, dated (today, today + 7]
// Never: ideas, done items outside today, past events (Alex: "i dont want
// past events included"), or a record with no readable date — '' sorts
// before every real date and would otherwise read as overdue.
export function sectionOf(item, todayISO) {
  if (!isScheduled(item)) return null;
  if (typeof item.date !== 'string' || !ISO_DAY.test(item.date)) return null;
  const done = item.done === true;
  if (item.date < todayISO) {
    if (!isTodoType(item)) return null;
    return !done || tickedToday(item, todayISO) ? 'overdue' : null;
  }
  if (item.date === todayISO) {
    if (isTodoType(item)) return 'todo';
    return EVENT_TYPES.has(item.type) ? 'events' : null;
  }
  return item.date <= addDays(todayISO, NEXT_DAYS) && !done ? 'next' : null;
}

// tickedToday: no item records when it was ticked, and the spec allows no new
// item field (§ 6). handleToggleDone bumps updatedAt on every tick, so a done
// item whose updatedAt is on today's LOCAL date was ticked today — or edited
// today after being ticked, which shows it struck for the rest of the day
// (the accepted cost). An unreadable updatedAt is no evidence: not today —
// an invalid Date's toISO is 'NaN-NaN-NaN', which no todayISO equals.
function tickedToday(item, todayISO) {
  return typeof item.updatedAt === 'string' && toISO(new Date(item.updatedAt)) === todayISO;
}

// daysBetween: whole calendar days from one 'YYYY-MM-DD' to another, counted
// on UTC midnights so a 23- or 25-hour DST day cannot change the answer.
// (Its parameters are not named fromISO/toISO: `toISO` is imported.)
export function daysBetween(fromDay, toDay) {
  return Math.round((utcOf(toDay) - utcOf(fromDay)) / DAY_MS);
}

// dayWord: how Today names a coming day — "Tomorrow", then the weekday
// ("Thu") up to a week out, then the date ("Thu, Oct 29").
export function dayWord(dateISO, todayISO) {
  const diff = daysBetween(todayISO, dateISO);
  if (diff === 1) return 'Tomorrow';
  if (diff >= 2 && diff <= NEXT_DAYS) return WEEKDAY.format(utcOf(dateISO));
  return formatDayLabel(dateISO, todayISO);
}

// relativeLabel: the next event's "in N" text at `nowMinutes` (minutes since
// local midnight), or null. "now" while it runs — for an event with no end,
// during its start minute only. Over 12 h away, or over: null.
export function relativeLabel(item, nowMinutes) {
  if (!item.time) return null;
  const start = minutesOf(item.time);
  const end = item.endTime ? minutesOf(item.endTime) : start + 1;
  if (nowMinutes >= start && nowMinutes < end) return 'now';
  const ahead = start - nowMinutes;
  if (ahead <= 0 || ahead > RELATIVE_MAX_MIN) return null;
  if (ahead < 60) return `in ${ahead} min`;
  const h = Math.floor(ahead / 60);
  const m = ahead % 60;
  return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
}

// isPastEvent: a timed event is over once its end has passed — with no end,
// once its start minute has. Untimed events are never greyed.
export function isPastEvent(item, nowMinutes) {
  if (!item.time) return false;
  const end = item.endTime ? minutesOf(item.endTime) : minutesOf(item.time) + 1;
  return nowMinutes >= end;
}
```

In `js/items.js`:

```bash
python3 - <<'PY'
p = 'js/items.js'
s = open(p).read()
a = """export function isTodo(it) { return TODO_TYPES.has(it.type) && it.done !== true; }"""
b = """export function isTodo(it) { return isTodoType(it) && it.done !== true; }

// isTodoType: a to-do TYPE, done or not. Today's "To do today" keeps a ticked
// to-do until tomorrow (home-screen spec § 2.3), so it needs the type test
// without isTodo's `done` half. The one reader of TODO_TYPES besides isTodo,
// so the list is still written once.
export function isTodoType(it) { return TODO_TYPES.has(it.type); }"""
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, b))
PY
```

- [ ] **Step 4: Run them, then the suite, and see the ASSETS guard fail**

Run: `node --test tests/today.test.js tests/items.test.js` → `# tests 38`, `# fail 0`.
Run: `npm test > "$TMPDIR/plaenicke-test.log" 2>&1; grep -E "^not ok|^# (tests|fail|cancelled)" "$TMPDIR/plaenicke-test.log"`
Expected: `not ok … - every js/ module is precached — a missing one white-screens a cold offline start` (`service-worker ASSETS is missing js/today.js`), `# tests 1369`, `# fail 1`.

- [ ] **Step 5: Add the module to ASSETS**

```bash
python3 - <<'PY'
p = 'service-worker.js'
s = open(p).read()
a = "'js/scrolllock.js', 'js/fetchtimeout.js', 'js/palette.js', 'js/press.js',"
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, "'js/scrolllock.js', 'js/fetchtimeout.js', 'js/palette.js', 'js/press.js', 'js/today.js',"))
PY
```

`CACHE` is not bumped here; it is bumped once per release (Tasks 10 and 13).

- [ ] **Step 6: Mutation-check**

Plant each, run `node --test tests/today.test.js tests/items.test.js`, restore:

| Mutant | Must fail |
|---|---|
| delete the `ISO_DAY` date check in `sectionOf` | `sectionOf: a record with no readable date belongs to no section` |
| overdue → `isTodoType(item) && item.type !== 'start' && !done` | `sectionOf: every to-do type past its date is overdue — start included…` |
| overdue → `!done ? 'overdue' : null` (past events overdue) | `sectionOf: every to-do type past its date is overdue…` |
| `if (isTodoType(item)) return 'todo';` → `return done ? null : 'todo';` | `sectionOf: a to-do ticked today stays in To do today…` |
| `item.date <= addDays(todayISO, NEXT_DAYS)` → `<` | `sectionOf: a to-do is overdue the day after its date…` |
| `daysBetween` body → `Math.floor((new Date(\`${toDay}T00:00\`) - new Date(\`${fromDay}T00:00\`)) / DAY_MS)` | `daysBetween counts calendar days…` (fails in a DST zone; the Mac runs `America/Los_Angeles`, where 7→9 Mar 2026 is 47 hours) |
| `ahead > RELATIVE_MAX_MIN` → `ahead >= RELATIVE_MAX_MIN` | `relativeLabel: exactly 12 h ahead is shown, a minute more is not` |
| `nowMinutes < end` → `nowMinutes <= end` in `relativeLabel` | `relativeLabel: minutes under an hour…`, `relativeLabel: an event with no end is "now" only in its start minute…` |
| `isPastEvent` → `if (!item.endTime) return false;` before the end check | `isPastEvent: over once its end has passed…` |
| `diff <= NEXT_DAYS` → `diff < NEXT_DAYS` in `dayWord` | `dayWord: Tomorrow, then the weekday up to a week out, then the date` |
| `isTodoType` → `TODO_TYPES.has(it.type) && it.done !== true` | `isTodoType is the four to-do types, done or not`, `sectionOf: a to-do ticked today stays…` |
| `!done \|\| tickedToday(item, todayISO)` → `!done` (ticked leaves at once) | `sectionOf: a to-do ticked today after its date stays in Overdue until tomorrow` |
| `!done \|\| tickedToday(…)` → `true` (every done overdue stays) | `sectionOf: every to-do type past its date is overdue…`, `sectionOf: a to-do ticked today after its date stays…` |
| `toISO(at) === todayISO` → `item.updatedAt.slice(0, 10) === todayISO` (UTC day) | `sectionOf: a to-do ticked today after its date stays…` |
| delete `typeof item.updatedAt === 'string' &&` | `sectionOf: a to-do ticked today after its date stays…` (`new Date(null)` is 1 Jan 1970 — not today either; if this mutant survives, say so in the report: the guard is then explicit, not load-bearing) |

- [ ] **Step 7: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/today.js js/items.js tests/today.test.js tests/items.test.js service-worker.js && git commit -m "feat(today): sectionOf, calendar-day ages, day names and the next event's relative time" -m "Home-screen spec § 2.3, pure: each own item gets one section or none (every to-do type past its date is overdue, start included; a ticked to-do stays today; ideas, past events and unreadable dates never). isTodoType keeps TODO_TYPES written once. Precached in ASSETS." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1369`, `# fail 0`, `# cancelled 0`.

---

### Task 4: `buildToday` (pure)

**Files:**
- Modify: `js/today.js` (append; import line)
- Modify: `tests/today.test.js` (import; append)

**Interfaces:**
- Consumes: Task 3's helpers; instances from `instancesForRange` (Tasks 1–2); `parseICS` (`js/ics.js`) in the tests only.
- Produces: `export const LOOKAHEAD_DAYS = 30`; `export function buildToday(items, instances, todayISO, nowMinutes, lookahead) -> { overdue: [{item, age, tone}], todo: [{item}], events: [{item, past, relative}], next: [{date, label, rows: [{item}]}], emptyLine: string|null }`. Throws on a malformed `todayISO`, a `nowMinutes` outside the integers 0..1439, a missing `lookahead`, or an instance without a boolean `recurring`.

- [ ] **Step 1: Write the failing tests**

```bash
python3 - <<'PY'
p = 'tests/today.test.js'
s = open(p).read()
a = """import {
  sectionOf, daysBetween, dayWord, relativeLabel, isPastEvent, NEXT_DAYS,
} from '../js/today.js';"""
b = """import {
  sectionOf, daysBetween, dayWord, relativeLabel, isPastEvent, buildToday, NEXT_DAYS,
} from '../js/today.js';
import { parseICS } from '../js/ics.js';
import { instancesForRange } from '../js/feeds.js';
import { addDays } from '../js/timegrid.js';"""
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, b))
PY
```

Append to the end of `tests/today.test.js`:

```js
// --- buildToday (spec § 2.3) --------------------------------------------------
//
// Fixtures: own items as makeItem stores them, feed instances as
// instancesForRange stamps them (recurring/guessedSeries included).

const inst = (uid, date, o = {}) => {
  const time = o.time || null;
  return {
    id: `feedR:${uid}:${date}:${time}`, uid, title: `i-${uid}`, date, time, endTime: null,
    createdAt: `${date}T${time || '00:00'}`, feedId: 'feedR', feedColor: '#00f', external: true,
    recurring: false, guessedSeries: false, ...o,
  };
};
const none = () => [];
const ids = (rows) => rows.map((r) => r.item.id);
const allRowIds = (t) => [
  ...ids(t.overdue), ...ids(t.todo), ...ids(t.events), ...t.next.flatMap((d) => ids(d.rows)),
];

test('buildToday: the four sections, each in the order the spec gives', () => {
  const items = [
    own('essay', { type: 'due', date: '2026-10-15', title: 'Essay' }),
    own('reading', { type: 'start', date: '2026-10-18', title: 'Start reading' }),
    own('chore', { type: 'task', date: '2026-10-01', title: 'Old chore' }),
    own('ticked', { type: 'task', title: 'Done one', done: true }),
    own('bank', { type: 'task', time: '09:00', title: 'Call bank' }),
    own('form', { type: 'due', title: 'Submit form' }),
    own('dentist', { type: 'event', time: '14:00', endTime: '15:00', title: 'Dentist' }),
    own('bday', { type: 'general', title: 'Birthday' }),
    own('dinner', { type: 'event', date: '2026-10-23', time: '19:00', title: 'Dinner' }),
    own('prep', { type: 'due', date: '2026-10-22', title: 'Quiz prep' }),
  ];
  const instances = [
    inst('club', '2026-10-22', { time: '08:00', title: 'Club meeting' }),
    inst('phys', TODAY, { time: '10:00', endTime: '11:15', title: 'PHYS 2100', recurring: true }),
    inst('phys', '2026-10-23', { time: '10:00', endTime: '11:15', title: 'PHYS 2100', recurring: true }),
  ];
  const t = buildToday(items, instances, TODAY, at(8, 0), none);
  assert.deepEqual(ids(t.overdue), ['chore', 'essay', 'reading'], 'oldest first');
  assert.deepEqual(ids(t.todo), ['form', 'bank', 'ticked'], 'by time, untimed first, done last');
  assert.deepEqual(ids(t.events), ['bday', 'feedR:phys:2026-10-21:10:00', 'dentist'], 'untimed first');
  assert.deepEqual(t.next.map((d) => [d.date, d.label, ids(d.rows)]), [
    ['2026-10-22', 'Tomorrow', ['prep', 'feedR:club:2026-10-22:08:00']],
    ['2026-10-23', 'Fri', ['dinner']],
  ], 'a repeating class is never under Next 7 days');
  assert.equal(t.emptyLine, null);
});

test('buildToday: an overdue age is in days, red for a deadline and orange for a start', () => {
  const t = buildToday([
    own('d', { type: 'due', date: '2026-10-19' }),
    own('m', { type: 'milestone', date: '2026-10-19' }),
    own('k', { type: 'task', date: '2026-10-20' }),
    own('s', { type: 'start', date: '2026-10-20' }),
  ], [], TODAY, at(8, 0), none);
  assert.deepEqual(t.overdue.map((r) => [r.item.id, r.age, r.tone]), [
    ['d', '2d', 'deadline'], ['m', '2d', 'deadline'], ['k', '1d', 'deadline'], ['s', '1d', 'start'],
  ]);
});

test('buildToday: a to-do ticked today stays in Overdue, after the undone ones, with its age and tone', () => {
  const t = buildToday([
    own('tick', { type: 'start', date: '2026-10-10', done: true, updatedAt: '2026-10-21T19:00:00.000Z' }),
    own('late', { type: 'due', date: '2026-10-19' }),
    own('older', { type: 'task', date: '2026-10-12' }),
    own('gone', { type: 'due', date: '2026-10-11', done: true, updatedAt: '2026-10-20T19:00:00.000Z' }),
  ], [], TODAY, at(8, 0), none);
  assert.deepEqual(t.overdue.map((r) => [r.item.id, r.age, r.tone]), [
    ['older', '9d', 'deadline'], ['late', '2d', 'deadline'], ['tick', '11d', 'start'],
  ], 'undone oldest first, then ticked; ticked yesterday is gone');
  assert.equal(t.emptyLine, null);
});

test('buildToday: an overdue item from months ago is still overdue, with its whole age', () => {
  const t = buildToday([own('old', { type: 'due', date: '2026-06-01', title: 'Lab report' })], [], TODAY, at(8, 0), none);
  assert.deepEqual(t.overdue.map((r) => [r.item.title, r.age]), [['Lab report', '142d']], 'no age limit (question 9)');
});

test('buildToday: no caps and no "+N more" — every row is returned in every section', () => {
  const items = [];
  for (let i = 0; i < 30; i += 1) {
    items.push(own(`o${i}`, { type: 'due', date: '2026-09-01' }));
    items.push(own(`t${i}`, { type: 'task' }));
    items.push(own(`n${i}`, { type: 'event', date: '2026-10-25' }));
  }
  const instances = Array.from({ length: 30 }, (_, i) => inst(`one-${i}`, '2026-10-26'));
  const t = buildToday(items, instances, TODAY, at(8, 0), none);
  assert.equal(t.overdue.length, 30);
  assert.equal(t.todo.length, 30);
  assert.deepEqual(t.next.map((d) => d.rows.length), [30, 30]);
  assert.equal('more' in t, false);
});

test('buildToday: a repeating series shows on its own day only — rule or guessed', () => {
  const instances = [
    inst('lec', TODAY, { time: '10:00', recurring: true }),
    inst('lec', '2026-10-22', { time: '10:00', recurring: true }),
    inst('lab', '2026-10-23', { time: '14:00', recurring: true, guessedSeries: true }),
    inst('lab', TODAY, { time: '14:00', recurring: true, guessedSeries: true }),
    // A seminar that does not meet today: nothing on today hides it.
    inst('sem', '2026-10-22', { time: '16:00', recurring: true }),
    inst('sem', '2026-10-27', { time: '16:00', recurring: true }),
  ];
  const t = buildToday([], instances, TODAY, at(8, 0), none);
  assert.deepEqual(ids(t.events), ['feedR:lec:2026-10-21:10:00', 'feedR:lab:2026-10-21:14:00']);
  assert.deepEqual(t.next, []);
});

test('buildToday: a one-off over several days is shown once — today if it covers today, else on its first day', () => {
  const instances = [
    inst('trip', TODAY), inst('trip', '2026-10-22'), inst('trip', '2026-10-23'),
    inst('conf', '2026-10-24'), inst('conf', '2026-10-25'), inst('conf', '2026-10-26'),
    inst('late', '2026-10-22', { time: '23:00', endTime: '23:59' }),
    inst('late', '2026-10-23', { time: '00:00', endTime: '01:00' }),
  ];
  const t = buildToday([], instances, TODAY, at(8, 0), none);
  assert.deepEqual(ids(t.events), ['feedR:trip:2026-10-21:null']);
  assert.deepEqual(t.next.map((d) => [d.date, ids(d.rows)]), [
    ['2026-10-22', ['feedR:late:2026-10-22:23:00']],
    ['2026-10-24', ['feedR:conf:2026-10-24:null']],
  ]);
});

test('buildToday: Next 7 days stops at today + 7 and hides empty days', () => {
  const items = [
    own('plus3', { type: 'event', date: '2026-10-24' }),
    own('plus7', { type: 'event', date: '2026-10-28' }),
    own('plus8', { type: 'event', date: '2026-10-29' }),
  ];
  const t = buildToday(items, [inst('late', '2026-10-29')], TODAY, at(8, 0), none);
  assert.deepEqual(t.next.map((d) => [d.label, ids(d.rows)]), [['Sat', ['plus3']], ['Wed', ['plus7']]]);
});

test('buildToday: only the next timed event says "in N"; finished ones are greyed', () => {
  const instances = [
    inst('allday', TODAY, { title: 'Fair' }),
    inst('gym', TODAY, { time: '08:00', endTime: '09:00' }),
    inst('lec', TODAY, { time: '09:00', endTime: '10:00' }),
    inst('lunch', TODAY, { time: '11:00' }),
  ];
  const at930 = buildToday([], instances, TODAY, at(9, 30), none);
  assert.deepEqual(at930.events.map((r) => [r.item.uid, r.past, r.relative]), [
    ['allday', false, null], ['gym', true, null], ['lec', false, 'now'], ['lunch', false, null],
  ]);
  const at1030 = buildToday([], instances, TODAY, at(10, 30), none);
  assert.deepEqual(at1030.events.map((r) => [r.item.uid, r.past, r.relative]), [
    ['allday', false, null], ['gym', true, null], ['lec', true, null], ['lunch', false, 'in 30 min'],
  ]);
  const late = buildToday([], instances, TODAY, at(22, 0), none);
  assert.deepEqual(late.events.map((r) => r.relative), [null, null, null, null], 'nothing left today');
});

test('buildToday: own events take part in "next" and in greying too', () => {
  const t = buildToday([own('call', { type: 'event', time: '09:45', endTime: '10:00' })],
    [inst('lec', TODAY, { time: '11:00', endTime: '12:00' })], TODAY, at(9, 3), none);
  assert.deepEqual(t.events.map((r) => [r.item.id, r.relative]), [['call', 'in 42 min'], ['feedR:lec:2026-10-21:11:00', null]]);
});

test('buildToday: with nothing overdue, due or on today, one line names the next thing', () => {
  const calls = [];
  const lookahead = () => { calls.push(1); return [inst('phys', '2026-10-23', { recurring: true }), inst('club', '2026-10-29', { title: 'Club' })]; };
  const t = buildToday([own('quiz', { type: 'event', date: '2026-10-30', title: 'Stats quiz' })], [], TODAY, at(8, 0), lookahead);
  assert.equal(t.emptyLine, 'Nothing due today. Next: Club · Thu, Oct 29.', 'the earlier of the two; a repeating class is skipped');
  assert.equal(calls.length, 1);
  const own2 = buildToday([own('quiz', { type: 'event', date: '2026-10-23', title: 'Stats quiz' })], [], TODAY, at(8, 0), lookahead);
  assert.equal(own2.emptyLine, 'Nothing due today. Next: Stats quiz · Fri.');
});

test('buildToday: the 30-day look-ahead runs only when the first three sections are empty', () => {
  let calls = 0;
  const lookahead = () => { calls += 1; return []; };
  buildToday([own('t', { type: 'task' })], [], TODAY, at(8, 0), lookahead);
  buildToday([own('o', { type: 'due', date: '2026-10-01' })], [], TODAY, at(8, 0), lookahead);
  buildToday([], [inst('e', TODAY)], TODAY, at(8, 0), lookahead);
  assert.equal(calls, 0);
  buildToday([], [inst('later', '2026-10-24')], TODAY, at(8, 0), lookahead);
  assert.equal(calls, 1, 'Next 7 days alone does not count as "something today"');
});

test('buildToday: the "Next" line skips done items, ideas and anything past 30 days', () => {
  const items = [
    own('done', { type: 'task', date: '2026-10-22', done: true }),
    own('idea', { type: 'idea', date: '2026-10-22' }),
    own('far', { type: 'event', date: '2027-03-01', title: 'Spring trip' }),
  ];
  const t = buildToday(items, [], TODAY, at(8, 0), () => [inst('x', '2026-11-21', { title: 'Too far' })]);
  assert.equal(t.emptyLine, 'Nothing due today. Next: Spring trip · Mon, Mar 1, 2027.', 'an own item at any distance counts');
  const nothing = buildToday([], [], TODAY, at(8, 0), () => [inst('x', '2026-11-21')]);
  assert.equal(nothing.emptyLine, 'Nothing coming up.');
});

test('buildToday: every item appears at most once', () => {
  const items = [
    own('a', { type: 'due', date: '2026-10-01' }), own('b', { type: 'task' }), own('c', { type: 'task', done: true }),
    own('d', { type: 'event' }), own('e', { type: 'event', date: '2026-10-22' }), own('f', { type: 'start', date: '2026-10-25' }),
    own('g', { type: 'idea' }),
  ];
  const instances = [
    inst('trip', TODAY), inst('trip', '2026-10-22'), inst('conf', '2026-10-24'), inst('conf', '2026-10-25'),
    inst('lec', TODAY, { time: '10:00', recurring: true }), inst('lec', '2026-10-23', { time: '10:00', recurring: true }),
    inst('one', '2026-10-27'),
  ];
  const all = allRowIds(buildToday(items, instances, TODAY, at(8, 0), none));
  assert.equal(new Set(all).size, all.length, `duplicates in ${all}`);
  assert.equal(all.length, 10, 'fixture check: a-f, trip, lec, conf and one; the idea g is never on Today');
});

test('buildToday: a day with only classes shows them, draws nothing else, and says nothing about "due"', () => {
  const instances = [
    inst('math', TODAY, { time: '09:00', endTime: '09:50', recurring: true }),
    inst('phys', TODAY, { time: '10:00', endTime: '11:15', recurring: true }),
    inst('math', '2026-10-23', { time: '09:00', endTime: '09:50', recurring: true }),
  ];
  const t = buildToday([], instances, TODAY, at(8, 0), () => { throw new Error('not needed'); });
  assert.deepEqual(t.overdue, []);
  assert.deepEqual(t.todo, []);
  assert.equal(t.events.length, 2);
  assert.deepEqual(t.next, []);
  assert.equal(t.emptyLine, null);
});

test('buildToday: refuses input it cannot place, loudly', () => {
  assert.throws(() => buildToday([], [], '2026-10-21T00:00', at(8, 0), none), /todayISO/);
  for (const bad of [-1, 1440, 1.5, '480']) {
    assert.throws(() => buildToday([], [], TODAY, bad, none), /nowMinutes/, String(bad));
  }
  assert.throws(() => buildToday([], [], TODAY, at(8, 0)), /lookahead/);
  const unstamped = inst('x', TODAY);
  delete unstamped.recurring;
  assert.throws(() => buildToday([], [unstamped], TODAY, at(8, 0), none), /recurring/,
    'an instance instancesForRange did not stamp cannot be placed');
});
```

and then:

```js
// --- Review Focus: a real class calendar, end to end ---------------------------
//
// ICS text -> parseICS -> instancesForRange -> buildToday, in Alex's zone,
// across the 1 Nov 2026 DST change. The class repeats by RRULE (LMU Classes is
// rule-shaped, stage 1 result); one meeting is moved (an override), one is
// cancelled (EXDATE), and the calendar also carries a "no class" one-off on a
// class day, an exam and a three-day all-day break.

const CLASS_ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:phys2100@google.com', 'SUMMARY:PHYS 2100',
  'DTSTART;TZID=America/Los_Angeles:20260825T100000', 'DTEND;TZID=America/Los_Angeles:20260825T111500',
  'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261211T000000Z',
  'EXDATE;TZID=America/Los_Angeles:20261105T100000',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:phys2100@google.com', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261029T100000',
  'SUMMARY:PHYS 2100 (room change)',
  'DTSTART;TZID=America/Los_Angeles:20261029T130000', 'DTEND;TZID=America/Los_Angeles:20261029T141500',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:noclass-1103@google.com', 'SUMMARY:No class — PHYS 2100',
  'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:exam@google.com', 'SUMMARY:MATH 234 Standards Exam',
  'DTSTART;TZID=America/Los_Angeles:20261102T090000', 'DTEND;TZID=America/Los_Angeles:20261102T100000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:fallbreak@google.com', 'SUMMARY:Fall break',
  'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261102', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const CLASS_FEED = { id: 'lmu', url: 'https://calendar.google.com/calendar/ical/secret-token/basic.ics', name: 'LMU Classes', color: '#00f', hidden: false };
const LA = 'America/Los_Angeles';

function todayFromIcs(todayISO, nowMin, ownItems = []) {
  const { events, skipped } = parseICS(CLASS_ICS);
  assert.deepEqual(skipped, [], 'fixture check: every VEVENT parsed');
  const cache = { lmu: { fetchedAt: '2026-10-20T00:00:00.000Z', events, skipped } };
  return buildToday(
    ownItems,
    instancesForRange([CLASS_FEED], cache, todayISO, addDays(todayISO, NEXT_DAYS), LA),
    todayISO, nowMin,
    () => instancesForRange([CLASS_FEED], cache, addDays(todayISO, 1), addDays(todayISO, 30), LA),
  );
}
const titles = (rows) => rows.map((r) => `${r.item.title}${r.item.time ? ` ${r.item.time}` : ''}`);

test('Review Focus: a moved class shows at its new time today, and no class is ever under Next 7 days', () => {
  const t = todayFromIcs('2026-10-29', at(8, 0)); // Thursday; DST ends Sunday 1 Nov
  assert.deepEqual(titles(t.events), ['PHYS 2100 (room change) 13:00'], 'the 10:00 slot it replaced is gone');
  assert.equal(t.events[0].item.recurring, true, 'an override belongs to its series');
  assert.deepEqual(t.next.map((d) => [d.label, titles(d.rows)]), [
    ['Tomorrow', ['Fall break']],
    ['Mon', ['MATH 234 Standards Exam 09:00']],
    ['Tue', ['No class — PHYS 2100']],
  ], 'the break once, on its first day; the Tue and Thu classes never');
});

test('Review Focus: on a day with no class, the coming week\'s classes still stay out of Next 7 days', () => {
  const t = todayFromIcs('2026-10-30', at(8, 0)); // Friday
  assert.deepEqual(titles(t.events), ['Fall break']);
  assert.deepEqual(t.next.map((d) => [d.label, titles(d.rows)]), [
    ['Mon', ['MATH 234 Standards Exam 09:00']],
    ['Tue', ['No class — PHYS 2100']],
  ], 'Tue 3 Nov\'s class is not here, and the break is not repeated on Sat and Sun');
});

test('Review Focus: after the DST change the class keeps its 10:00, and a "no class" day shows both', () => {
  const t = todayFromIcs('2026-11-03', at(9, 0)); // Tuesday, after the change
  assert.deepEqual(titles(t.events), ['No class — PHYS 2100', 'PHYS 2100 10:00'],
    'the calendar has no EXDATE for 3 Nov, so the class is still on it: Today shows what the feed says');
  assert.equal(t.events[1].relative, 'in 1 h');
  assert.deepEqual(t.next.map((d) => d.label), [], 'Thursday 5 Nov is cancelled (EXDATE) and classes are never here anyway');
});

test('Review Focus: a cancelled class (EXDATE) is simply not on its day', () => {
  const t = todayFromIcs('2026-11-05', at(8, 0));
  assert.deepEqual(t.events, []);
  assert.equal(t.emptyLine, 'Nothing coming up.', 'no one-off in the next 30 days, and the classes are not "next"');
});

test('Review Focus: the DST week moves neither the Next 7 days edge nor an overdue age', () => {
  const t = todayFromIcs('2026-10-29', at(8, 0), [
    own('edge', { type: 'event', date: '2026-11-05', title: 'Edge' }),
    own('past-edge', { type: 'event', date: '2026-11-06', title: 'Past the edge' }),
    own('due', { type: 'due', date: '2026-10-25', title: 'Problem set' }),
  ]);
  assert.deepEqual(t.next.at(-1).rows.map((r) => r.item.title), ['Edge'], 'today + 7 is 5 Nov, DST or not');
  assert.equal(t.next.flatMap((d) => d.rows).some((r) => r.item.title === 'Past the edge'), false);
  const later = todayFromIcs('2026-11-03', at(9, 0), [own('due', { type: 'due', date: '2026-10-25', title: 'Problem set' })]);
  assert.deepEqual(later.overdue.map((r) => r.age), ['9d'], '25 Oct to 3 Nov, across the 25-hour day');
});

test('Review Focus: no Today row carries the calendar link', () => {
  const t = todayFromIcs('2026-10-29', at(8, 0));
  const json = JSON.stringify(t);
  assert.ok(t.events.length > 0, 'fixture check');
  assert.equal(json.includes('secret-token'), false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/today.test.js`
Expected: `SyntaxError: The requested module '../js/today.js' does not provide an export named 'buildToday'`, `# tests 1`, `# fail 1`.

- [ ] **Step 3: Implement**

Append to the end of `js/today.js`:

```js
// The "Next" line looks this far ahead for a one-off feed instance (spec § 2.3).
export const LOOKAHEAD_DAYS = 30;

// buildToday: every section of the Today screen (spec § 2.3), from
//   items       own items — app.js passes liveItems(), so a delete waiting
//               for its Undo is already gone
//   instances   instancesForRange(..., today, today + NEXT_DAYS, deviceTz)
//   todayISO    'YYYY-MM-DD', the device's today
//   nowMinutes  minutes since local midnight, 0..1439
//   lookahead   () => instancesForRange(..., today + 1, today + 30, ...);
//               called only when the first three sections are all empty
// and returns
//   overdue    [{ item, age: '3d', tone: 'deadline' | 'start' }]  oldest first
//   todo       [{ item }]   by time, untimed first; done ones last
//   events     [{ item, past, relative }]   untimed first; `relative` ("in
//              42 min", "now") on the next timed event only, `past` on every
//              timed one that is over
//   next       [{ date, label, rows: [{ item }] }]  one entry per day that
//              has rows; days without rows are left out
//   emptyLine  the one line shown when Overdue, To do today and Today's
//              events are all empty; otherwise null
// No section is capped (Alex, question 3). No item appears twice: an own
// item is in sectionOf's one section; a feed instance is under Today's events
// on today, or under Next 7 days once — on its first day there, and not at
// all if it is also on today (a multi-day one-off emits one instance per
// day). A repeating instance (`recurring`) is never under Next 7 days.
export function buildToday(items, instances, todayISO, nowMinutes, lookahead) {
  if (typeof todayISO !== 'string' || !ISO_DAY.test(todayISO)) throw new Error('buildToday requires todayISO');
  if (!Number.isInteger(nowMinutes) || nowMinutes < 0 || nowMinutes > 1439) {
    throw new Error('buildToday requires nowMinutes, 0..1439');
  }
  if (typeof lookahead !== 'function') throw new Error('buildToday requires lookahead');
  for (const inst of instances) {
    if (typeof inst.recurring !== 'boolean') throw new Error('buildToday: an instance has no recurring flag');
  }

  const own = { overdue: [], todo: [], events: [], next: [] };
  for (const item of items) {
    const section = sectionOf(item, todayISO);
    if (section) own[section].push(item);
  }

  // Undone first, then the ones ticked today (amendment 2026-10-22).
  const overdueSorted = sortItemsByDate(own.overdue);
  const overdue = [
    ...overdueSorted.filter((it) => it.done !== true), ...overdueSorted.filter((it) => it.done === true),
  ].map((item) => ({
    item,
    age: `${daysBetween(item.date, todayISO)}d`,
    tone: item.type === 'start' ? 'start' : 'deadline',
  }));

  const todoSorted = sortItemsByDate(own.todo);
  const todo = [...todoSorted.filter((it) => it.done !== true), ...todoSorted.filter((it) => it.done === true)]
    .map((item) => ({ item }));

  const onToday = instances.filter((inst) => inst.date === todayISO);
  const events = sortItemsByDate([...own.events, ...onToday])
    .map((item) => ({ item, past: isPastEvent(item, nowMinutes), relative: null }));
  const upcoming = events.find((row) => row.item.time && !row.past);
  if (upcoming) upcoming.relative = relativeLabel(upcoming.item, nowMinutes);

  const nextEnd = addDays(todayISO, NEXT_DAYS);
  const seen = new Set(onToday.map(seriesKey));
  const nextInstances = [];
  for (const inst of sortItemsByDate(instances)) {
    if (inst.recurring || inst.date <= todayISO || inst.date > nextEnd) continue;
    const key = seriesKey(inst);
    if (seen.has(key)) continue;
    seen.add(key);
    nextInstances.push(inst);
  }
  const next = [];
  for (const item of sortItemsByDate([...own.next, ...nextInstances])) {
    let day = next[next.length - 1];
    if (!day || day.date !== item.date) {
      day = { date: item.date, label: dayWord(item.date, todayISO), rows: [] };
      next.push(day);
    }
    day.rows.push({ item });
  }

  let emptyLine = null;
  if (overdue.length === 0 && todo.length === 0 && events.length === 0) {
    const lookEnd = addDays(todayISO, LOOKAHEAD_DAYS);
    const candidates = [
      ...items.filter((it) => isScheduled(it) && it.done !== true
        && typeof it.date === 'string' && ISO_DAY.test(it.date) && it.date > todayISO),
      ...lookahead().filter((inst) => inst.recurring === false && inst.date > todayISO && inst.date <= lookEnd),
    ];
    const first = sortItemsByDate(candidates)[0];
    emptyLine = first
      ? `Nothing due today. Next: ${first.title} · ${dayWord(first.date, todayISO)}.`
      : 'Nothing coming up.';
  }

  return { overdue, todo, events, next, emptyLine };
}

// A feed series, for Next 7 days' "once" rule (spec § 2.3).
function seriesKey(inst) { return `${inst.feedId}:${inst.uid}`; }
```

and change its first import:

```bash
python3 - <<'PY'
p = 'js/today.js'
s = open(p).read()
a = "import { isScheduled, isTodoType } from './items.js';"
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, "import { isScheduled, isTodoType, sortItemsByDate } from './items.js';"))
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/today.test.js` → `# tests 33`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

Plant each in `js/today.js`, run `node --test tests/today.test.js`, restore:

| Mutant | Must fail |
|---|---|
| `if (inst.recurring \|\| inst.date <= todayISO …` → drop `inst.recurring \|\|` | `buildToday: a repeating series shows on its own day only — rule or guessed`, `Review Focus: on a day with no class, the coming week's classes still stay out of Next 7 days` |
| delete `if (seen.has(key)) continue;` | `a one-off over several days is shown once…`, `every item appears at most once`, `Review Focus: a moved class shows at its new time today…` |
| `const seen = new Set(onToday.map(seriesKey));` → `new Set()` | `a one-off over several days is shown once…`, `every item appears at most once` |
| `if (upcoming) upcoming.relative = …` → every timed row gets `relativeLabel(...)` | `only the next timed event says "in N"…`, `own events take part in "next"…` |
| `events.find((row) => row.item.time && !row.past)` → `events.find((row) => row.item.time)` | `only the next timed event says "in N"; finished ones are greyed` |
| `todo` → `todoSorted.map((item) => ({ item }))` (done not last) | `the four sections, each in the order the spec gives` |
| `tone: item.type === 'start' ? 'start' : 'deadline'` → `tone: 'deadline'` | `an overdue age is in days, red for a deadline and orange for a start` |
| `overdue` → `overdueSorted.map(…)` (ticked not last) | `a to-do ticked today stays in Overdue, after the undone ones…` |
| call `lookahead()` before the empty-sections check | `with nothing overdue…`, `the 30-day look-ahead runs only when…`, `a day with only classes…` |
| ~~look-ahead filter drops `inst.recurring === false &&`~~ *(2026-10-22, final review A5: the exclusion is gone — repeating instances are look-ahead candidates. The mutant is now the reverse:)* look-ahead filter adds `inst.recurring === false &&` | `with nothing overdue…`, `Review Focus: a cancelled class (EXDATE) is simply not on its day`, `A5: with only a weekly class starting tomorrow, the "Next" line names it` |
| look-ahead filter drops `&& inst.date <= lookEnd` | `the "Next" line skips done items, ideas and anything past 30 days` |
| empty-line condition adds `&& next.length === 0` | `with nothing overdue…`, `the 30-day look-ahead runs only when…` |
| delete the `recurring` flag guard | `buildToday: refuses input it cannot place, loudly` |
| `nowMinutes > 1439` → `> 1440` | `buildToday: refuses input it cannot place, loudly` |
| return `overdue.slice(0, 5)` and `todo.slice(0, 8)` (the old caps) | `no caps and no "+N more" — every row is returned in every section` |
| `sortItemsByDate([...own.events, ...onToday])` → `sortItemsByDate([...onToday])` | `the four sections…`, `own events take part in "next"…`, `every item appears at most once` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/today.js tests/today.test.js && git commit -m "feat(today): buildToday — Overdue, To do today, Today's events, Next 7 days" -m "Home-screen spec § 2.3, pure and uncapped: repeating instances only on their own day; one-offs once, on their first day, dropped if shown today; relative time on the next timed event only; finished events marked past; the empty-day line with a 30-day look-ahead made only when the first three sections are empty. Pinned end to end on a real class ICS across the DST week." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1390`, `# fail 0`, `# cancelled 0`.

---

# Stage 3b — the Today page beside the view buttons (spec § 8, 3b)

### Task 5: `js/todayview.js` — drawing Today

**Files:**
- Create: `js/todayview.js`
- Create: `tests/todayview.test.js`
- Modify: `service-worker.js:21` (`ASSETS`)

**Interfaces:**
- Consumes: `buildToday`'s result (Task 4); `itemTypeClass` (`js/calendar.js`); `formatTime`, `formatTimeRange` (`js/timegrid.js`); `makeFakeDocument`, `allText`, `findAll`, `fire` (`tests/fake-dom.js`).
- Produces: `export function renderTodayView(container, today, { onOpen, onToggleDone }) -> { relative: { node, item } | null }`. DOM: an optional `p.today-empty` first; one `section.today-section` per non-empty section with `h3.today-label` and `ul.today-list`; Next 7 days has `h4.today-day` per day. A row is `li.today-row <itemTypeClass>` (`past` added for a finished event), holding `input.today-check` (Overdue and To do today only) and `button.item-open.today-open[data-press][data-item-id]` with `span.today-text` and meta spans `.today-age.<tone>`, `.today-time`, `.today-rel`, `.today-guess`.

- [ ] **Step 1: Write the failing tests**

Create `tests/todayview.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeDocument, allText, findAll, fire } from './fake-dom.js';
import { buildToday } from '../js/today.js';
import { renderTodayView } from '../js/todayview.js';

// todayview.js draws buildToday's result. Presentation only: the checkbox
// reports up through onToggleDone and the title through onOpen; app.js
// writes. The shared fake DOM is enough: nothing here looks anything up by id.
globalThis.document = makeFakeDocument();

const TODAY = '2026-10-21';
const at = (hh, mm) => hh * 60 + mm;
const own = (id, o = {}) => ({
  id, title: `t-${id}`, date: TODAY, time: null, endTime: null, type: 'task',
  createdAt: '2026-10-01', updatedAt: '2026-10-01T00:00:00.000Z',
  project: null, subject: null, category: null, done: false, notes: null, ...o,
});
const inst = (uid, date, o = {}) => {
  const time = o.time || null;
  return {
    id: `feedR:${uid}:${date}:${time}`, uid, title: `i-${uid}`, date, time, endTime: null,
    createdAt: `${date}T${time || '00:00'}`, feedId: 'feedR', feedColor: 'var(--feed-palette-2)', external: true,
    recurring: false, guessedSeries: false, ...o,
  };
};

function draw(items, instances = [], now = at(9, 18), handlers = {}) {
  const host = document.createElement('div');
  const calls = { open: [], toggle: [] };
  const out = renderTodayView(host, buildToday(items, instances, TODAY, now, () => []), {
    onOpen: (it) => calls.open.push(it.id),
    onToggleDone: (id, done) => calls.toggle.push([id, done]),
    ...handlers,
  });
  return { host, calls, out };
}
const byClass = (root, cls) => {
  const found = [];
  const walk = (n) => { for (const c of n.children) { if (c._classes.has(cls)) found.push(c); walk(c); } };
  walk(root);
  return found;
};
const rowOf = (host, title) => byClass(host, 'today-row').find((li) => allText(li).includes(title));

const DAY = [
  own('late', { type: 'due', date: '2026-10-18', title: 'Essay' }),
  own('start', { type: 'start', date: '2026-10-20', title: 'Start reading' }),
  own('bank', { type: 'task', time: '09:00', title: 'Call bank' }),
  own('ticked', { type: 'task', title: 'Water plants', done: true }),
  own('dinner', { type: 'event', date: '2026-10-23', time: '19:00', title: 'Dinner' }),
];
const DAY_FEED = [
  inst('gym', TODAY, { time: '08:00', endTime: '09:00', title: 'Gym' }),
  inst('lec', TODAY, { time: '10:00', endTime: '11:15', title: 'PHYS 2100', recurring: true }),
  inst('lab', TODAY, { time: '14:00', endTime: '16:50', title: 'Physics lab', recurring: true, guessedSeries: true }),
  inst('fair', TODAY, { title: 'Career fair' }),
  inst('club', '2026-10-22', { time: '08:00', title: 'Club meeting' }),
];

test('Today: the four sections in order, each under its label; an empty one is not drawn', () => {
  const { host } = draw(DAY, DAY_FEED);
  const sections = byClass(host, 'today-section');
  assert.deepEqual(sections.map((s) => byClass(s, 'today-label')[0].textContent),
    ['Overdue', 'To do today', "Today's events", 'Next 7 days']);
  assert.deepEqual(byClass(sections[3], 'today-day').map((h) => h.textContent), ['Tomorrow', 'Fri']);
  const { host: light } = draw([own('only', { type: 'task' })]);
  assert.deepEqual(byClass(light, 'today-label').map((h) => h.textContent), ['To do today']);
  assert.equal(byClass(light, 'today-empty').length, 0, 'no empty line when something is due');
});

test('Today: the empty line is drawn first, and only when buildToday gives one', () => {
  const { host } = draw([own('fri', { type: 'event', date: '2026-10-23', title: 'Stats quiz' })]);
  assert.equal(host.children[0]._classes.has('today-empty'), true);
  assert.equal(host.children[0].textContent, 'Nothing due today. Next: Stats quiz · Fri.');
  assert.deepEqual(byClass(host, 'today-label').map((h) => h.textContent), ['Next 7 days']);
});

test('Today: each title is a button that opens its item and carries its id', () => {
  const { host, calls } = draw(DAY, DAY_FEED);
  const openers = byClass(host, 'today-open');
  assert.equal(openers.length, 10, 'fixture check: one per row');
  for (const b of openers) {
    assert.equal(b.tagName, 'BUTTON');
    assert.equal(b.type, 'button');
    assert.ok(b._classes.has('item-open'), 'focusOpener finds it by .item-open');
  }
  const essay = byClass(rowOf(host, 'Essay'), 'today-open')[0];
  assert.equal(essay.getAttribute('data-item-id'), 'late');
  fire(essay, 'click');
  assert.deepEqual(calls.open, ['late']);
});

// The punchlist's carry-over (1): press.js presses the nearest
// `button, [data-press]` above the touch. A checkbox inside a pressable row
// would press the whole row on a tick. So the pressable part is the open
// button, and the checkbox is its sibling, outside it.
test('Today: the open button is the pressable part; nothing above a checkbox is, so a tick never presses the row', () => {
  const { host } = draw(DAY, DAY_FEED);
  for (const b of byClass(host, 'today-open')) assert.notEqual(b.getAttribute('data-press'), null);
  const boxes = findAll(host, 'INPUT');
  assert.equal(boxes.length, 4, 'fixture check: Overdue and To do today rows have one each');
  for (const box of boxes) {
    for (let n = box; n && n !== host; n = n.parentNode) {
      assert.equal(n.getAttribute('data-press'), null, `${n.tagName}.${n.className} is pressable above a checkbox`);
      assert.notEqual(n.tagName, 'BUTTON', 'a checkbox inside a button presses the button');
    }
  }
});

test('Today: a tick reports what the box now holds', () => {
  const { host, calls } = draw(DAY, DAY_FEED);
  const bank = findAll(rowOf(host, 'Call bank'), 'INPUT')[0];
  assert.equal(bank.type, 'checkbox');
  assert.equal(bank.getAttribute('aria-label'), 'Mark "Call bank" done');
  bank.checked = true;
  fire(bank, 'change');
  const ticked = findAll(rowOf(host, 'Water plants'), 'INPUT')[0];
  assert.equal(ticked.checked, true, 'a ticked to-do shows ticked');
  ticked.checked = false;
  fire(ticked, 'change');
  assert.deepEqual(calls.toggle, [['bank', true], ['ticked', false]]);
});

test('Today: only Overdue and To do today rows have a checkbox', () => {
  const { host } = draw(DAY, DAY_FEED);
  const [overdue, todo, events, next] = byClass(host, 'today-section');
  assert.equal(findAll(overdue, 'INPUT').length, 2);
  assert.equal(findAll(todo, 'INPUT').length, 2);
  assert.equal(findAll(events, 'INPUT').length, 0);
  assert.equal(findAll(next, 'INPUT').length, 0);
});

test('Today: a ticked to-do keeps its row, marked done, so the tick can be undone until tomorrow', () => {
  const { host } = draw(DAY, DAY_FEED);
  const row = rowOf(host, 'Water plants');
  assert.ok(row._classes.has('done'));
  assert.ok(row._classes.has('type-task'));
});

test('Today: an overdue age is red for a deadline and orange for a start', () => {
  const { host } = draw(DAY, DAY_FEED);
  const essayAge = byClass(rowOf(host, 'Essay'), 'today-age')[0];
  assert.equal(essayAge.textContent, '3d');
  assert.ok(essayAge._classes.has('deadline'));
  const startAge = byClass(rowOf(host, 'Start reading'), 'today-age')[0];
  assert.equal(startAge.textContent, '1d');
  assert.ok(startAge._classes.has('start'));
});

test('Today: the next event\'s "in N" is one node, handed back for the 60 s tick', () => {
  const { host, out } = draw(DAY, DAY_FEED, at(9, 18));
  const rels = byClass(host, 'today-rel');
  assert.equal(rels.length, 1);
  assert.equal(rels[0].textContent, 'in 42 min');
  assert.ok(allText(rowOf(host, 'PHYS 2100')).includes('in 42 min'));
  assert.equal(out.relative.node, rels[0]);
  assert.equal(out.relative.item.uid, 'lec');
  const none = draw(DAY, DAY_FEED, at(23, 0));
  assert.equal(byClass(none.host, 'today-rel').length, 0);
  assert.equal(none.out.relative, null);
});

test('Today: a finished event is greyed; one still to come is not', () => {
  const { host } = draw(DAY, DAY_FEED, at(9, 18));
  assert.ok(rowOf(host, 'Gym')._classes.has('past'));
  assert.ok(!rowOf(host, 'PHYS 2100')._classes.has('past'));
  assert.ok(!rowOf(host, 'Career fair')._classes.has('past'), 'an all-day event is never greyed');
});

test('Today: a guessed series says so; a rule series does not', () => {
  const { host } = draw(DAY, DAY_FEED);
  assert.deepEqual(byClass(rowOf(host, 'Physics lab'), 'today-guess').map((s) => s.textContent), ['Repeats weekly (guessed)']);
  assert.equal(byClass(rowOf(host, 'PHYS 2100'), 'today-guess').length, 0);
});

test('Today: an event shows its time or "All day"; a feed row takes its calendar\'s colour', () => {
  const { host } = draw(DAY, DAY_FEED);
  assert.equal(byClass(rowOf(host, 'PHYS 2100'), 'today-time')[0].textContent, '10:00–11:15 AM');
  assert.equal(byClass(rowOf(host, 'Career fair'), 'today-time')[0].textContent, 'All day');
  assert.equal(byClass(rowOf(host, 'Club meeting'), 'today-time')[0].textContent, '8:00 AM');
  const fair = rowOf(host, 'Career fair');
  assert.ok(fair._classes.has('type-external'));
  assert.equal(fair.style['--feed-color'], 'var(--feed-palette-2)');
});

test('Today: a re-render replaces the rows rather than adding to them', () => {
  const host = document.createElement('div');
  const handlers = { onOpen() {}, onToggleDone() {} };
  renderTodayView(host, buildToday(DAY, DAY_FEED, TODAY, at(9, 0), () => []), handlers);
  renderTodayView(host, buildToday(DAY, DAY_FEED, TODAY, at(9, 0), () => []), handlers);
  assert.equal(byClass(host, 'today-row').length, 10);
});

test('renderTodayView refuses to draw rows that would do nothing on tap', () => {
  const host = document.createElement('div');
  const model = buildToday(DAY, [], TODAY, at(9, 0), () => []);
  assert.throws(() => renderTodayView(host, model, { onToggleDone() {} }), /onOpen/);
  assert.throws(() => renderTodayView(host, model, { onOpen() {} }), /onToggleDone/);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/todayview.test.js` → `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/js/todayview.js'`, `# fail 1`.

- [ ] **Step 3: Implement**

Create `js/todayview.js`:

```js
// todayview.js — draws the Today screen (home-screen spec § 2.3) from
// js/today.js's buildToday result.
//
// Presentation only. It NEVER writes: the checkbox reports upward through
// onToggleDone and the title through onOpen, and app.js performs the write
// against its own `items` (CLAUDE.md's ownership invariant).
//
// THE PRESSABLE PART OF A ROW IS ITS OPEN BUTTON, never the <li>. press.js
// presses the nearest `button, [data-press]` above a touch, so a checkbox
// inside a pressable row would press the whole row on every tick. The
// checkbox is the button's sibling. Rows are styled through classes only:
// an id selector would outrank `[data-press].pressed` (styles.css).
import { itemTypeClass } from './calendar.js';
import { formatTime, formatTimeRange } from './timegrid.js';

const SECTIONS = [
  ['overdue', 'Overdue', true],
  ['todo', 'To do today', true],
  ['events', "Today's events", false],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeText(item) {
  if (!item.time) return null;
  return item.endTime ? formatTimeRange(item.time, item.endTime) : formatTime(item.time);
}

// renderTodayView(container, today, { onOpen, onToggleDone }) -> { relative }
// `relative` is { node, item } for the one "in N" label (the next event), so
// app.js's 60 s tick can update that text node and nothing else; or null.
export function renderTodayView(container, today, { onOpen, onToggleDone } = {}) {
  // Required: a missing one would draw rows that do nothing on tap.
  if (typeof onOpen !== 'function') throw new Error('renderTodayView requires onOpen');
  if (typeof onToggleDone !== 'function') throw new Error('renderTodayView requires onToggleDone');
  container.innerHTML = '';
  let relative = null;

  function row(item, { check = false, meta = [] } = {}) {
    // className, NOT classList.add: itemTypeClass can return two tokens.
    const li = el('li', `today-row ${itemTypeClass(item)}`);
    if (item.external) li.style.setProperty('--feed-color', item.feedColor);
    if (check) {
      const box = el('input', 'today-check');
      box.type = 'checkbox';
      box.checked = item.done === true;
      box.setAttribute('aria-label', `Mark "${item.title}" done`);
      // What the control now holds, never a hard-coded true.
      box.addEventListener('change', () => onToggleDone(item.id, box.checked === true));
      li.appendChild(box);
    }
    const open = el('button', 'item-open today-open');
    open.type = 'button';
    open.setAttribute('data-press', '');
    // How app.js's focusOpener finds this button again.
    open.setAttribute('data-item-id', item.id);
    open.addEventListener('click', () => onOpen(item));
    open.append(el('span', 'today-text', item.title), ...meta);
    li.appendChild(open);
    return li;
  }

  function section(label) {
    const s = el('section', 'today-section');
    s.appendChild(el('h3', 'today-label', label));
    container.appendChild(s);
    return s;
  }

  if (today.emptyLine) container.appendChild(el('p', 'today-empty', today.emptyLine));

  for (const [key, label, check] of SECTIONS) {
    const rows = today[key];
    if (rows.length === 0) continue;
    const list = el('ul', 'today-list');
    for (const r of rows) {
      const meta = [];
      if (key === 'overdue') meta.push(el('span', `today-age ${r.tone}`, r.age));
      if (key === 'todo' && timeText(r.item)) meta.push(el('span', 'today-time', timeText(r.item)));
      if (key === 'events') {
        meta.push(el('span', 'today-time', timeText(r.item) || 'All day'));
        if (r.relative) {
          const rel = el('span', 'today-rel', r.relative);
          relative = { node: rel, item: r.item };
          meta.push(rel);
        }
        if (r.item.guessedSeries === true) meta.push(el('span', 'today-guess', 'Repeats weekly (guessed)'));
      }
      const li = row(r.item, { check, meta });
      if (key === 'events' && r.past) li.classList.add('past');
      list.appendChild(li);
    }
    section(label).appendChild(list);
  }

  if (today.next.length > 0) {
    const s = section('Next 7 days');
    for (const day of today.next) {
      s.appendChild(el('h4', 'today-day', day.label));
      const list = el('ul', 'today-list');
      for (const r of day.rows) {
        const t = timeText(r.item);
        list.appendChild(row(r.item, { meta: t ? [el('span', 'today-time', t)] : [] }));
      }
      s.appendChild(list);
    }
  }

  return { relative };
}
```

- [ ] **Step 4: Run them, then the suite, and see the ASSETS guard fail**

Run: `node --test tests/todayview.test.js` → `# tests 14`, `# fail 0`.
Run: `npm test > "$TMPDIR/plaenicke-test.log" 2>&1; grep -E "^not ok|^# (tests|fail|cancelled)" "$TMPDIR/plaenicke-test.log"` → `not ok … - every js/ module is precached…` (`missing js/todayview.js`), `# tests 1404`, `# fail 1`.

- [ ] **Step 5: Add the module to ASSETS**

```bash
python3 - <<'PY'
p = 'service-worker.js'
s = open(p).read()
a = "'js/press.js', 'js/today.js',"
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, "'js/press.js', 'js/today.js', 'js/todayview.js',"))
PY
```

- [ ] **Step 6: Mutation-check**

Plant each in `js/todayview.js`, run `node --test tests/todayview.test.js`, restore:

| Mutant | Must fail |
|---|---|
| after creating `li`, add `li.setAttribute('data-press', '');` (the whole row pressable) | `the open button is the pressable part; nothing above a checkbox is…` |
| delete `open.setAttribute('data-press', '');` | `the open button is the pressable part…` |
| `onToggleDone(item.id, box.checked === true)` → `onToggleDone(item.id, true)` | `a tick reports what the box now holds` |
| `['events', "Today's events", false]` → `true` | `the open button is the pressable part…`, `only Overdue and To do today rows have a checkbox` |
| delete `relative = { node: rel, item: r.item };` | `the next event's "in N" is one node, handed back for the 60 s tick` |
| delete the `past` class line | `a finished event is greyed; one still to come is not` |
| `r.item.guessedSeries === true` → `r.item.recurring === true` | `a guessed series says so; a rule series does not` |
| `` `today-age ${r.tone}` `` → `'today-age'` | `an overdue age is red for a deadline and orange for a start` |
| delete `container.innerHTML = '';` | `a re-render replaces the rows rather than adding to them` |
| delete the `today.emptyLine` line | `the empty line is drawn first, and only when buildToday gives one` |

- [ ] **Step 7: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/todayview.js tests/todayview.test.js service-worker.js && git commit -m "feat(todayview): draw Today; the open button is the pressable part, the checkbox its sibling" -m "Home-screen spec § 2.3 and the stage 1–2 punchlist carry-over: press.js presses the nearest button or [data-press] above a touch, so nothing above a checkbox is pressable and a tick never presses the row. Checkboxes on Overdue and To do today; one relative-time node handed back for the tick. Precached in ASSETS; not yet mounted." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1404`, `# fail 0`, `# cancelled 0`.

---

### Task 6: the item sheet says "Repeats weekly (guessed)"

**Files:**
- Modify: `js/itemsheet.js:251` (external branch, after `sheet-when`)
- Modify: `styles.css:739` (`.sheet-when, .sheet-source`)
- Modify: append to `tests/itemsheet.test.js` (after line 1025) and to `tests/styles.test.js` (after line 522)

**Interfaces:**
- Consumes: `item.guessedSeries` (Task 2); `tests/itemsheet.test.js`'s `open`, `external`, `one`, `byClass`; `tests/styles.test.js`'s `declOf`.
- Produces: `p.sheet-repeat` "Repeats weekly (guessed)" directly under `p.sheet-when` on an external sheet whose item has `guessedSeries === true`; none otherwise. Spec § 2.4: "its rows under Today's events and its item sheet read 'Repeats weekly (guessed)'" (the rows are Task 5).

- [ ] **Step 1: Write the failing tests**

Append to `tests/itemsheet.test.js`:

```js
// Home-screen spec § 2.4: a series the heuristic guessed is labelled, so a
// wrong grouping is visible. A series found by its RRULE carries no label.
test('an external item from a guessed series says so; one from an RRULE series does not', () => {
  let { host } = open(external({ recurring: true, guessedSeries: true }), { calendarName: 'Canvas' });
  assert.equal(one(host, 'sheet-repeat').textContent, 'Repeats weekly (guessed)');
  const children = one(host, 'sheet').children;
  assert.equal(children.indexOf(one(host, 'sheet-repeat')), children.indexOf(one(host, 'sheet-when')) + 1,
    'directly under the day and time');
  ({ host } = open(external({ recurring: true, guessedSeries: false }), { calendarName: 'Work' }));
  assert.equal(byClass(host, 'sheet-repeat').length, 0);
});
```

Append to `tests/styles.test.js`:

```js
// --- home-screen stage 3b: the guessed-series line on the sheet (spec § 2.4) --
test('the sheet\'s "Repeats weekly (guessed)" line reads like its other details', () => {
  assert.equal(declOf('.sheet-repeat', 'color'), 'var(--muted)');
  assert.equal(declOf('.sheet-repeat', 'margin'), '0 0 6px');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/itemsheet.test.js tests/styles.test.js`
Expected: `# fail 2` — `an external item from a guessed series says so…` (`expected exactly one .sheet-repeat, found 0`) and `the sheet's "Repeats weekly (guessed)" line reads like its other details` (`null !== 'var(--muted)'`).

- [ ] **Step 3: Implement**

```bash
python3 - <<'PY'
p = 'js/itemsheet.js'
s = open(p).read()
a = """    sheet.appendChild(el('p', 'sheet-when', when));
    if (calendarName)"""
b = """    sheet.appendChild(el('p', 'sheet-when', when));
    // A series the heuristic guessed says so, so a wrong grouping is visible
    // (home-screen spec § 2.4). An RRULE series carries no label.
    if (item.guessedSeries === true) sheet.appendChild(el('p', 'sheet-repeat', 'Repeats weekly (guessed)'));
    if (calendarName)"""
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, b))
p = 'styles.css'
s = open(p).read()
a = ".sheet-when, .sheet-source { margin: 0 0 6px; color: var(--muted); }"
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, ".sheet-when, .sheet-source, .sheet-repeat { margin: 0 0 6px; color: var(--muted); }"))
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/itemsheet.test.js tests/styles.test.js` → `# fail 0` (`itemsheet` 98 tests, `styles` 84).

- [ ] **Step 5: Mutation-check**

| Mutant (in `js/itemsheet.js`) | Must fail |
|---|---|
| `item.guessedSeries === true` → `item.recurring === true` | `an external item from a guessed series says so; one from an RRULE series does not` |
| move the line below the `sheet-source` line | `an external item from a guessed series says so…` (`directly under the day and time`) |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/itemsheet.js styles.css tests/itemsheet.test.js tests/styles.test.js && git commit -m "feat(itemsheet): a guessed series says \"Repeats weekly (guessed)\"" -m "Home-screen spec § 2.4: a wrong grouping must be visible. An RRULE series carries no label." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1406`, `# fail 0`, `# cancelled 0`.

---

### Task 7: the Today page in the app — opens on Today, gear on Today

**Files:**
- Modify: `index.html:25-32` (header loses the gear), `index.html:65-72` (nav gains `#show-today` first, active; `#show-day` loses `active`), insert `#today-view` before `#list-view` (line 74), `index.html:96` (`#day-view` gains `hidden`)
- Modify: `js/app.js:32` (imports), `js/app.js:78` (`els`), `js/app.js:648-650` (`focusOpener` pages), after `js/app.js:856` (`renderToday`), `js/app.js:866` (`render`), `js/app.js:869-886` (`showView` tables), `js/app.js:904` (listener)
- Modify: `tests/apply.test.js` — six existing tests and two helpers, listed below; append new tests

**Interfaces:**
- Consumes: `buildToday`, `NEXT_DAYS`, `LOOKAHEAD_DAYS` (Task 4); `renderTodayView` (Task 5); `liveItems()`, `openItem`, `handleToggleDone`, `instancesForRange(feeds, feedCache, …, deviceTz)` (`js/app.js`).
- Produces: `els.showToday`, `els.todayView`, `els.todayBody`, `els.todayDate`; `renderToday()` (first in `render()`); `showView('today')`; `focusOpener` checks Today first. `#today-date` reads e.g. "Wednesday, October 21".

Existing tests changed on purpose in this task (each because Today is a new page, or is now the page at load):

- `each nav button reveals exactly its own page, and marks itself active` — `['show-today', 'today-view']` added to its table.
- `index.html opens on the Day view, not the List` → `index.html opens on Today`.
- `a11y: index.html marks the Day button pressed and every other nav button not` → `… the Today button pressed …`, with `show-today` in its list.
- `a11y: each nav button reports itself pressed, and only itself` — `show-today` added.
- The `PAGES` table (used by `sweep U: after a Save, focus returns to the re-rendered opener on the page that is showing`) gains `['Today', 'show-today', 'today-view', () => todayBody()]`, which is the test that pins `focusOpener` learning Today; `visiblePageButton` gains `['show-today', 'today-view']`.
- The helper `openControlFor` reads `allText(c)` instead of `c.textContent`: a real button's `textContent` includes its children's, and Today's button holds its title in a child span. Every other page's opener has no children, so for them the two are the same.

- [ ] **Step 1: Write the failing tests**

```bash
python3 - <<'PY'
p = 'tests/apply.test.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep("""  const pages = [
    ['show-list', 'list-view'],
    ['show-month', 'calendar-view'],""", """  const pages = [
    ['show-today', 'today-view'],
    ['show-list', 'list-view'],
    ['show-month', 'calendar-view'],""")
rep("""test('index.html opens on the Day view, not the List', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="show-day"[^>]*class="active"/, 'the Day button must be the active one on load');
  assert.doesNotMatch(html, /<button id="show-list"[^>]*class="active"/, 'List must no longer be the default');
  assert.match(html, /<section id="day-view"(?![^>]*hidden)[^>]*>/, 'the Day section must be visible on load');
  assert.match(html, /<section id="list-view"[^>]*hidden/, 'the List section must start hidden');
});""", """// Home-screen stage 3b: the app opens on Today (it opened on Day before).
test('index.html opens on Today', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="show-today"[^>]*class="active"/, 'the Today button must be the active one on load');
  assert.doesNotMatch(html, /<button id="show-(list|month|week|day|todo|ideas)"[^>]*class="active"/, 'and no other');
  assert.match(html, /<section id="today-view"(?![^>]*hidden)[^>]*>/, 'the Today section must be visible on load');
  for (const id of ['list-view', 'calendar-view', 'week-view', 'day-view', 'todo-view', 'ideas-view']) {
    assert.match(html, new RegExp(`<section id="${id}"[^>]*hidden`), `#${id} must start hidden`);
  }
});""")
rep("""const PAGES = [
  ['List', 'show-list', 'list-view', () => itemList()],""", """const todayBody = () => globalThis.document.getElementById('today-body');
const PAGES = [
  ['Today', 'show-today', 'today-view', () => todayBody()],
  ['List', 'show-list', 'list-view', () => itemList()],""")
rep("""  for (const [buttonId, sectionId] of [
    ['show-list', 'list-view'], ['show-month', 'calendar-view'], ['show-week', 'week-view'],""", """  for (const [buttonId, sectionId] of [
    ['show-today', 'today-view'],
    ['show-list', 'list-view'], ['show-month', 'calendar-view'], ['show-week', 'week-view'],""")
rep("""test('a11y: index.html marks the Day button pressed and every other nav button not', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['show-list', 'show-month', 'show-week', 'show-day', 'show-todo', 'show-ideas']) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(tag, `fixture check: #${id}`);
    assert.match(tag[0], new RegExp(`aria-pressed="${id === 'show-day'}"`), `#${id}`);
  }
});""", """test('a11y: index.html marks the Today button pressed and every other nav button not', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['show-today', 'show-list', 'show-month', 'show-week', 'show-day', 'show-todo', 'show-ideas']) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(tag, `fixture check: #${id}`);
    assert.match(tag[0], new RegExp(`aria-pressed="${id === 'show-today'}"`), `#${id}`);
  }
});""")
rep("""  const ids = ['show-list', 'show-month', 'show-week', 'show-day', 'show-todo', 'show-ideas'];
  try {
    for (const id of ids) {""", """  const ids = ['show-today', 'show-list', 'show-month', 'show-week', 'show-day', 'show-todo', 'show-ideas'];
  try {
    for (const id of ids) {""")
rep("""// The .item-open control of the first row under `root` whose text mentions `title`.
function openControlFor(root, title) {
  const found = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (c.tagName === 'BUTTON' && c._classes.has('item-open') && (c.textContent || '').includes(title)) found.push(c);""", """// The .item-open control of the first row under `root` whose text mentions `title`.
// allText, as a real button's textContent includes its children's: Today's
// open button holds its title in a child span (js/todayview.js).
function openControlFor(root, title) {
  const found = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (c.tagName === 'BUTTON' && c._classes.has('item-open') && allText(c).includes(title)) found.push(c);""")
open(p, 'w').write(s)
PY
```

Append to the end of `tests/apply.test.js`:

```js
// =========================================================================
// Home-screen stage 3b — the Today page, through the real app
// =========================================================================
//
// Ids are prefixed `td-`. Each test puts the page it found back, and leaves
// no items or calendars behind.

test('Today: the gear is on the Today page, and nowhere else', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const today = html.match(/<section id="today-view"[\s\S]*?<\/section>/);
  assert.ok(today, 'fixture check: index.html has a Today section');
  assert.match(today[0], /<button id="settings-btn"/);
  assert.equal(html.match(/id="settings-btn"/g).length, 1);
  assert.doesNotMatch(html.match(/<header>[\s\S]*?<\/header>/)[0], /settings-btn/, 'the shell header no longer holds it');
});

test('Today: the page names the day and lists live items in their sections', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const restore = visiblePageButton();
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 21, 9, 18).getTime() });
  try {
    seed([
      record({ id: 'td-late', type: 'due', title: 'td Essay', date: '2026-10-18' }),
      record({ id: 'td-task', type: 'task', title: 'td Call bank', date: '2026-10-21' }),
      record({ id: 'td-class', type: 'event', title: 'td Lecture', date: '2026-10-21', time: '10:00', endTime: '11:00' }),
      record({ id: 'td-fri', type: 'event', title: 'td Dinner', date: '2026-10-23', time: '19:00' }),
      record({ id: 'td-idea', type: 'idea', title: 'td Shelves', date: '2026-10-21' }),
    ]);
    click(globalThis.document.getElementById('show-today'));
    assert.equal(globalThis.document.getElementById('today-view').hidden, false);
    assert.equal(labelText('today-date'), 'Wednesday, October 21');
    const text = allText(todayBody());
    assert.match(text,
      /Overdue[\s\S]*td Essay[\s\S]*To do today[\s\S]*td Call bank[\s\S]*Today's events[\s\S]*td Lecture[\s\S]*in 42 min[\s\S]*Next 7 days[\s\S]*Fri[\s\S]*td Dinner/);
    assert.doesNotMatch(text, /td Shelves/, 'an idea is never on Today');
  } finally {
    t.mock.timers.reset();
    seed([]);
    if (restore) click(restore);
  }
  resume();
});

// Amendment 2026-10-22 (DA I3) — WRITE THIS TEST in this task, next to the one
// below: 'Today: an overdue to-do ticked on Today stays in Overdue, struck
// through, below the undone ones, and unticks back above them'. Mock only Date
// (t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 21, 9, 18).getTime() })
// / reset() in finally, as the sweep-D tests do); seed an undone overdue `due`
// dated 2026-10-15 and an undone overdue `task` dated 2026-10-19 (record(),
// whose updatedAt is 2026-08-19); open Today; tick the older one through its
// checkbox ('change'). Assert: storage has done === true; the row is still in
// Overdue (the first today-section), checked, its li has class `done`, and it is
// now AFTER the 2026-10-19 row; untick it: storage done === false and it is
// back first. Mutation-check: in app.js setDone, keep `before.updatedAt`
// instead of nextStamp(...) → this test fails (and so does the existing
// "a tick moves updatedAt forward" test). Restore.
test('Today: a tick on Today is saved, and the row stays, struck through, until tomorrow', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const restore = visiblePageButton();
  seed([record({ id: 'td-tick', type: 'task', title: 'td Water plants', date: localISO(new Date()) })]);
  try {
    click(globalThis.document.getElementById('show-today'));
    const box = checkboxFor(todayBody(), 'td Water plants');
    assert.ok(box, 'fixture check: the row has a checkbox');
    box.checked = true;
    fire(box, 'change');
    assert.equal(storedById('td-tick').done, true, 'the tick reached storage');
    const again = checkboxFor(todayBody(), 'td Water plants');
    assert.ok(again && again.checked, 'still on Today, ticked');
    assert.ok(again.parentNode._classes.has('done'));
    assert.doesNotMatch(allText(todoList()), /td Water plants/, 'while the To-do page drops it');
  } finally {
    if (restore) click(restore);
  }
  seed([]);
});

test('Today: a delete waiting for its Undo is already gone from Today, and Undo brings it back', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'td-del', type: 'task', title: 'td Delete me', date: localISO(new Date()) })]);
  enableMockTimers(t, { apis: ['setTimeout'] });
  try {
    assert.match(allText(todayBody()), /td Delete me/, 'fixture check');
    click(deleteControlFor(todoList(), 'td Delete me'));
    assert.doesNotMatch(allText(todayBody()), /td Delete me/);
    click(toastHost().querySelector('.toast-undo'));
    assert.match(allText(todayBody()), /td Delete me/);
  } finally {
    await resetMockTimers(t);
  }
  seed([]);
});

test('Today: a calendar event is shown by its title; the calendar\'s link never reaches the page', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seedFeed(sdFeed('td-feed', { url: 'https://calendar.google.com/calendar/ical/td-private-token/basic.ics' }));
  try {
    assert.match(allText(todayBody()), /Standup from the feed/, 'fixture check: the feed event is on Today');
    assert.equal(stringsOf(todayBody()).some((x) => x.includes('td-private-token')), false);
  } finally {
    unseedFeeds();
  }
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/apply.test.js`
Expected: `# tests 188`, `# fail 18`. Three fail on their assertions (`ERR_ASSERTION`): `index.html opens on Today`, `a11y: index.html marks the Today button pressed…`, `Today: the gear is on the Today page, and nowhere else`. The other fifteen fail with a `TypeError` on `null` (`ERR_TEST_FAILURE`), because `#show-today`, `#today-view` and `#today-body` do not exist yet and these tests call `visiblePageButton()`, click `#show-today` or read `todayBody()`: `each nav button reveals…`, the three `sweep U` focus tests, `sF: an Undo across the idea line…`, `sF: an Undo whose rebuild…`, `sF: focus goes back to the opener without scrolling`, `sF: the page stays locked…`, both `a11y: … open their day from the keyboard` tests, `a11y: each nav button reports itself pressed…`, and the four other new `Today:` tests.

- [ ] **Step 3: Implement**

In `index.html`:

```bash
python3 - <<'PY'
p = 'index.html'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep("""    <span id="updated-stamp" class="stamp"></span>
    <button id="settings-btn" class="icon-btn" type="button" aria-label="Settings">&#9881;</button>
  </header>""", """    <span id="updated-stamp" class="stamp"></span>
  </header>""")
rep("""  <nav class="view-toggle">
    <button id="show-list" type="button" aria-pressed="false">List</button>
    <button id="show-month" type="button" aria-pressed="false">Month</button>
    <button id="show-week" type="button" aria-pressed="false">Week</button>
    <button id="show-day" type="button" class="active" aria-pressed="true">Day</button>""", """  <nav class="view-toggle">
    <button id="show-today" type="button" class="active" aria-pressed="true">Today</button>
    <button id="show-list" type="button" aria-pressed="false">List</button>
    <button id="show-month" type="button" aria-pressed="false">Month</button>
    <button id="show-week" type="button" aria-pressed="false">Week</button>
    <button id="show-day" type="button" aria-pressed="false">Day</button>""")
rep("""  <section id="list-view" hidden>""", """  <!-- Today (home-screen spec § 2): js/today.js decides what is on it and
       js/todayview.js draws it into #today-body. Settings opens from the gear
       here, on Today only (spec § 2.2). -->
  <section id="today-view">
    <div class="today-head">
      <div>
        <h2 class="today-title">Today</h2>
        <p id="today-date" class="today-date"></p>
      </div>
      <button id="settings-btn" class="icon-btn" type="button" aria-label="Settings">&#9881;</button>
    </div>
    <div id="today-body"></div>
  </section>

  <section id="list-view" hidden>""")
rep("""  <section id="day-view">""", """  <section id="day-view" hidden>""")
open(p, 'w').write(s)
PY
```

In `js/app.js`:

```bash
python3 - <<'PY'
p = 'js/app.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep("""import { installPress } from './press.js';
""", """import { installPress } from './press.js';
import { buildToday, NEXT_DAYS, LOOKAHEAD_DAYS } from './today.js';
import { renderTodayView } from './todayview.js';
""")
rep("""  updatedStamp: document.getElementById('updated-stamp'),
};""", """  updatedStamp: document.getElementById('updated-stamp'),
  // Home-screen stage 3b — the Today page.
  showToday: document.getElementById('show-today'),
  todayView: document.getElementById('today-view'),
  todayBody: document.getElementById('today-body'),
  todayDate: document.getElementById('today-date'),
};""")
rep("""  const pages = [
    [els.listView, els.list], [els.dayView, els.dayBody],""", """  const pages = [
    [els.todayView, els.todayBody], [els.listView, els.list], [els.dayView, els.dayBody],""")
rep("""function renderIdeas() {
  renderIdeasView(els.ideaList, ideaItems(), { onOpen: openItem, onDelete: requestDelete });
}
""", """function renderIdeas() {
  renderIdeasView(els.ideaList, ideaItems(), { onOpen: openItem, onDelete: requestDelete });
}

// The Today page (home-screen spec § 2.3). Own items come from liveItems(),
// so a delete waiting for its Undo is already gone; feed instances are
// expanded for today .. today + 7, and the 30-day look-ahead for the "Next"
// line only when buildToday asks for it. One clock reading for the whole page.
const minutesNow = (d) => d.getHours() * 60 + d.getMinutes();

function renderToday() {
  const now = new Date();
  const todayISO = toISO(now);
  els.todayDate.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const today = buildToday(
    liveItems(),
    instancesForRange(feeds, feedCache, todayISO, addDays(todayISO, NEXT_DAYS), deviceTz),
    todayISO,
    minutesNow(now),
    () => instancesForRange(feeds, feedCache, addDays(todayISO, 1), addDays(todayISO, LOOKAHEAD_DAYS), deviceTz),
  );
  renderTodayView(els.todayBody, today, { onOpen: openItem, onToggleDone: handleToggleDone });
}
""")
rep("""  renderList(); renderCalendar(); renderWeek(); renderDay(); renderTodos(); renderIdeas();
}""", """  renderToday(); renderList(); renderCalendar(); renderWeek(); renderDay(); renderTodos(); renderIdeas();
}""")
rep("""  const views = {
    list: els.listView, month: els.calView, week: els.weekView, day: els.dayView,
    todo: els.todoView, ideas: els.ideasView,
  };
  const buttons = {
    list: els.showList, month: els.showMonth, week: els.showWeek, day: els.showDay,
    todo: els.showTodo, ideas: els.showIdeas,
  };""", """  const views = {
    today: els.todayView, list: els.listView, month: els.calView, week: els.weekView, day: els.dayView,
    todo: els.todoView, ideas: els.ideasView,
  };
  const buttons = {
    today: els.showToday, list: els.showList, month: els.showMonth, week: els.showWeek, day: els.showDay,
    todo: els.showTodo, ideas: els.showIdeas,
  };""")
rep("""els.showList.addEventListener('click', () => showView('list'));""", """els.showToday.addEventListener('click', () => showView('today'));
els.showList.addEventListener('click', () => showView('list'));""")
open(p, 'w').write(s)
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/apply.test.js` → `# tests 188`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

Plant each in `js/app.js`, run `node --test tests/apply.test.js`, restore:

| Mutant | Must fail |
|---|---|
| `focusOpener` pages without `[els.todayView, els.todayBody], ` | `sweep U: after a Save, focus returns to the re-rendered opener on the page that is showing` |
| `buildToday(liveItems(), …` → `buildToday(items, …` | `Today: a delete waiting for its Undo is already gone from Today, and Undo brings it back` |
| `render()` without `renderToday();` | `sweep U: after a Save, focus returns…`, and the four `Today:` page tests |
| `views` without `today: els.todayView,` | `each nav button reveals…`, the three `sweep U` focus tests, `sF: focus goes back to the opener without scrolling` |
| `onToggleDone: handleToggleDone` → `onToggleDone: () => {}` | `Today: a tick on Today is saved, and the row stays, struck through, until tomorrow` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add index.html js/app.js tests/apply.test.js && git commit -m "feat(app): a Today page beside the view buttons; the app opens on it; the gear lives there" -m "Home-screen spec § 2, stage 3b: renderToday draws buildToday from liveItems() and the next 7 days of feed instances (the 30-day look-ahead only on demand); a tick goes through setDone; focus returns to a Today row after the sheet closes. Nothing removed." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1411`, `# fail 0`, `# cancelled 0`.

---

### Task 8: the 60 s tick changes only the "in N" text

**Files:**
- Modify: `js/app.js` — the `today.js` import, the `renderToday` block (Task 7), the end of `showView`, the load-time `render();` (line 925 on the baseline), the `visibilitychange` listener
- Modify: `tests/apply.test.js` — an interval recorder after the imports (after line 22); append two tests

**Interfaces:**
- Consumes: `relativeLabel(item, nowMinutes)` (Task 3); `renderTodayView(...).relative` (Task 5).
- Produces: module-scope `todayRelative`, `TODAY_TICK_MS = 60000`, `todayTick`, `tickToday()`, `syncTodayTick()`. In `tests/apply.test.js`: `intervals` (a Map of recorded intervals) and `liveIntervals(ms)`.

- [ ] **Step 1: Write the failing tests**

```bash
python3 - <<'PY'
p = 'tests/apply.test.js'
s = open(p).read()
a = """import { formatDayLabel } from '../js/freshness.js';
"""
b = """import { formatDayLabel } from '../js/freshness.js';

// INTERVALS ARE RECORDED, NEVER SCHEDULED, in this file. app.js's Today tick
// is a 60 s setInterval (home-screen spec § 2.3), armed while Today is shown,
// and every page here is "shown" at load (the fake DOM ignores index.html's
// `hidden`). A real interval left running keeps this file's process alive
// after its last test: measured on Node 22.18, with a last test that leaves
// Today showing, `node --test tests/apply.test.js` never exits. Installed
// before app.js is imported (the first test), and no test here mocks
// setInterval, so app.js only ever sees these. A test runs one by calling
// its `fn`.
const intervals = new Map();
let intervalSeq = 0;
globalThis.setInterval = (fn, ms) => {
  intervalSeq += 1;
  const id = `interval-${intervalSeq}`;
  intervals.set(id, { fn, ms });
  return id;
};
globalThis.clearInterval = (id) => { intervals.delete(id); };
const liveIntervals = (ms) => [...intervals.values()].filter((i) => i.ms === ms);
"""
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, b))
PY
```

Append to the end of `tests/apply.test.js`:

```js
// --- the 60 s tick (spec § 2.3) ----------------------------------------------
// It updates the one "in N" text node and never rebuilds the list. It runs
// only while Today and the page are both visible.

test('Today: the tick runs only while Today and the page are both visible, and never twice', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const restore = visiblePageButton();
  const doc = globalThis.document;
  try {
    click(doc.getElementById('show-day'));
    assert.equal(liveIntervals(60000).length, 0);
    click(doc.getElementById('show-today'));
    assert.equal(liveIntervals(60000).length, 1);
    click(doc.getElementById('show-today'));
    assert.equal(liveIntervals(60000).length, 1, 'tapping Today again arms no second one');
    click(doc.getElementById('show-week'));
    assert.equal(liveIntervals(60000).length, 0, 'leaving Today stops it');
    click(doc.getElementById('show-today'));
    doc.visibilityState = 'hidden';
    resume();
    assert.equal(liveIntervals(60000).length, 0, 'a hidden page does not tick');
    doc.visibilityState = 'visible';
    resume();
    assert.equal(liveIntervals(60000).length, 1, 'and starts again on return');
  } finally {
    doc.visibilityState = 'visible';
    if (restore) click(restore);
  }
});

test('Today: the tick changes the "in N" text, and no other node', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const restore = visiblePageButton();
  const nodesOf = (root) => {
    const out = [];
    const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
    walk(root);
    return out;
  };
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 21, 9, 18).getTime() });
  try {
    seed([
      record({ id: 'td-rel', type: 'event', title: 'td Lecture', date: '2026-10-21', time: '10:00', endTime: '11:00' }),
      record({ id: 'td-rel-gym', type: 'event', title: 'td Gym', date: '2026-10-21', time: '08:00', endTime: '09:00' }),
      record({ id: 'td-rel-task', type: 'task', title: 'td Pay rent', date: '2026-10-21' }),
    ]);
    click(globalThis.document.getElementById('show-today'));
    const before = nodesOf(todayBody());
    const texts = before.map((n) => n.textContent);
    const rel = before.find((n) => n._classes.has('today-rel'));
    assert.equal(rel.textContent, 'in 42 min', 'fixture check');
    const [tick] = liveIntervals(60000);
    assert.ok(tick, 'fixture check: Today is ticking');
    t.mock.timers.tick(12 * 60 * 1000); // 09:30
    tick.fn();
    assert.equal(rel.textContent, 'in 30 min');
    const after = nodesOf(todayBody());
    assert.equal(after.length, before.length, 'nothing added or removed');
    after.forEach((n, i) => {
      assert.equal(n, before[i], 'the same nodes: nothing was rebuilt');
      if (n !== rel) assert.equal(n.textContent, texts[i], 'and no other text changed');
    });
    t.mock.timers.tick(30 * 60 * 1000); // 10:00
    tick.fn();
    assert.equal(rel.textContent, 'now');
    t.mock.timers.tick(60 * 60 * 1000); // 11:00
    tick.fn();
    assert.equal(rel.textContent, '', 'over: the label empties; the next render greys the row');
  } finally {
    t.mock.timers.reset();
    seed([]);
    if (restore) click(restore);
  }
  resume();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/apply.test.js`
Expected: `# tests 190`, `# fail 2` — `Today: the tick runs only while Today and the page are both visible, and never twice` (`0 !== 1`) and `Today: the tick changes the "in N" text, and no other node` (`fixture check: Today is ticking`).

- [ ] **Step 3: Implement**

```bash
python3 - <<'PY'
p = 'js/app.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a
    s = s.replace(a, b)
rep("""import { buildToday, NEXT_DAYS, LOOKAHEAD_DAYS } from './today.js';""",
    """import { buildToday, relativeLabel, NEXT_DAYS, LOOKAHEAD_DAYS } from './today.js';""")
rep("""// line only when buildToday asks for it. One clock reading for the whole page.
const minutesNow = (d) => d.getHours() * 60 + d.getMinutes();
""", """// line only when buildToday asks for it. One clock reading for the whole page.
//
// todayRelative is the one "in N" label on the page and its event, kept for
// the 60 s tick below.
let todayRelative = null;
const minutesNow = (d) => d.getHours() * 60 + d.getMinutes();
""")
rep("""  renderTodayView(els.todayBody, today, { onOpen: openItem, onToggleDone: handleToggleDone });
}
""", """  todayRelative = renderTodayView(els.todayBody, today, { onOpen: openItem, onToggleDone: handleToggleDone }).relative;
}

// THE 60 s TICK (spec § 2.3) updates that one text node and never rebuilds
// the page. Greying, and which event is next, change on the next ordinary
// render (resume, add, sync); an event that has ended leaves an empty label
// until then. It runs only while Today AND the page are visible:
// syncTodayTick is called wherever either can change (load, showView,
// visibilitychange).
const TODAY_TICK_MS = 60 * 1000;
let todayTick = null;

function tickToday() {
  if (!todayRelative) return;
  todayRelative.node.textContent = relativeLabel(todayRelative.item, minutesNow(new Date())) || '';
}

function syncTodayTick() {
  const wanted = !els.todayView.hidden && document.visibilityState !== 'hidden';
  if (wanted && todayTick === null) todayTick = setInterval(tickToday, TODAY_TICK_MS);
  if (!wanted && todayTick !== null) {
    clearInterval(todayTick);
    todayTick = null;
  }
}
""")
rep("""    b.setAttribute('aria-pressed', String(name === which));
  }
  render();
}""", """    b.setAttribute('aria-pressed', String(name === which));
  }
  render();
  syncTodayTick();
}""")
rep("""render();
noteLaunch();
stampUpdated();
""", """render();
syncTodayTick();
noteLaunch();
stampUpdated();
""")
rep("""    for (const id of [...pendingDeletes]) commitDelete(id);
    return;
  }
  if (document.visibilityState !== 'visible') return;
  noteLaunch();
  render(); // refreshForToday runs first, inside render""", """    for (const id of [...pendingDeletes]) commitDelete(id);
    syncTodayTick();
    return;
  }
  if (document.visibilityState !== 'visible') return;
  noteLaunch();
  render(); // refreshForToday runs first, inside render
  syncTodayTick();""")
open(p, 'w').write(s)
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/apply.test.js` → `# tests 190`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant (in `js/app.js`) | Must fail |
|---|---|
| `tickToday` body → `renderToday();` (rebuild on every tick) | `Today: the tick changes the "in N" text, and no other node` |
| `const wanted = !els.todayView.hidden;` (ignores a hidden page) | `Today: the tick runs only while Today and the page are both visible…` |
| `if (wanted && todayTick === null)` → `if (wanted)` | `Today: the tick runs only while…, and never twice` |
| delete `syncTodayTick();` from `showView` | both tick tests |
| delete `syncTodayTick();` from the hidden branch of `visibilitychange` | `Today: the tick runs only while…` |
| `\|\| ''` → `\|\| todayRelative.node.textContent` (a stale "now" stays after the event) | `Today: the tick changes the "in N" text, and no other node` |

Also, once: delete the two `globalThis.setInterval`/`clearInterval` assignments from the recorder, append `test('leave Today showing', async () => { await import('../js/app.js'); click(globalThis.document.getElementById('show-today')); });` and run `node --test tests/apply.test.js` with a 40 s watchdog. Observed while planning: it never exits. Restore the file (`git diff tests/apply.test.js` shows only this task's changes).

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add js/app.js tests/apply.test.js && git commit -m "feat(app): the 60 s tick updates only the next event's relative time" -m "Home-screen spec § 2.3: a setInterval while Today and the page are both visible, synced on load, showView and visibilitychange; it writes one text node and never rebuilds the list. apply.test.js records intervals instead of scheduling them: a real one left running keeps the file's process alive." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1413`, `# fail 0`, `# cancelled 0`.

---

### Task 9: Today's styles — the type scale, 44 px rows, red and orange, dark mode

**Files:**
- Modify: `styles.css` after `.time-line` (line 282 on the baseline), which is after `.item-open`
- Modify: `tests/styles.test.js` — the stage-2 test `no existing rule reads the new type scale yet` (line 492 on the baseline) is replaced; append

**Interfaces:**
- Consumes: the stage-2 tokens `--text-label`, `--text-row`, `--text-hero`, `--label-tracking`, `--sans`, `--serif`, `--space-*`, `--danger`, `--overdue-start`, `--accent`, `--muted`, `--line`, `--chip-bg`; `declOf`, `px`, `css` (`tests/styles.test.js`).
- Produces: the `.today-*` rules and `button[data-press].pressed { opacity: 1 }`.

The stage-2 test `no existing rule reads the new type scale yet` is replaced on purpose: Today is the "first consumer" it named. Its replacement, `only the new screens read the new type scale`, keeps the guard that matters: every rule reading the scale names a new screen (`NEW_SCREEN`, here `.today-`); Month, Week and Day never read it, and stage 2's size pins on them are unchanged.

- [ ] **Step 1: Write the failing tests**

```bash
python3 - <<'PY'
p = 'tests/styles.test.js'
s = open(p).read()
a = """test('no existing rule reads the new type scale yet', () => {
  const body = css.replace(/:root\\s*\\{[^}]*\\}/, '');
  assert.doesNotMatch(body, /var\\(--(text-label|text-row|text-title|text-hero|label-tracking|sans)\\)/,
    'stage 3 is the first consumer; Month, Week and Day never are');
});"""
b = """// Stage 3b is the first consumer. Every rule that reads the scale belongs to
// a new screen (its selectors all name one); Month, Week and Day never do.
const NEW_SCREEN = /\\.today-/;
test('only the new screens read the new type scale', () => {
  const readers = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\\{([^}]*)\\}/g)) {
    if (/var\\(--(text-label|text-row|text-title|text-hero|label-tracking|sans)\\)/.test(body)) readers.push(sel.trim());
  }
  assert.ok(readers.length >= 3, `fixture check: found ${readers.length} readers`);
  for (const sel of readers) {
    for (const part of sel.split(',')) assert.match(part.trim(), NEW_SCREEN, `${part.trim()} is not a new screen`);
  }
});"""
assert s.count(a) == 1, 'guard'
s = s.replace(a, b)
s += """
// --- home-screen stage 3b: the Today page (spec § 2.3, § 5) -----------------
test('Today rows are full-width hairline rows, at least 44px, in 16px type', () => {
  assert.equal(declOf('.today-row', 'min-height'), '44px');
  assert.equal(declOf('.today-row', 'border-bottom'), '1px solid var(--line)');
  assert.equal(declOf('.today-open', 'font-size'), 'var(--text-row)');
  assert.equal(declOf(':root', '--text-row'), '16px', 'fixture check');
  assert.ok(px(declOf('.item-open', 'min-height')) >= 44, 'the open button is a 44px target too');
});

test('Today labels are 13px, uppercase, tracked and muted; the heading is 28px Georgia', () => {
  for (const sel of ['.today-label', '.today-day', '.today-date']) {
    assert.equal(declOf(sel, 'font-size'), 'var(--text-label)', sel);
    assert.equal(declOf(sel, 'text-transform'), 'uppercase', sel);
    assert.equal(declOf(sel, 'letter-spacing'), 'var(--label-tracking)', sel);
    assert.equal(declOf(sel, 'color'), 'var(--muted)', sel);
    assert.equal(declOf(sel, 'font-family'), 'var(--sans)', sel);
  }
  assert.equal(declOf('.today-title', 'font-size'), 'var(--text-hero)');
  assert.equal(declOf('.today-title', 'font-family'), 'var(--serif)');
  assert.equal(declOf('.today-text', 'font-family'), 'var(--serif)', 'titles in Georgia');
  for (const sel of ['.today-time', '.today-age', '.today-rel']) {
    assert.equal(declOf(sel, 'font-family'), 'var(--sans)', sel);
    assert.equal(declOf(sel, 'font-variant-numeric'), 'tabular-nums', sel);
  }
});

test('an overdue age is red past a deadline and orange past a start date', () => {
  assert.equal(declOf('.today-age.deadline', 'color'), 'var(--danger)');
  assert.equal(declOf('.today-age.start', 'color'), 'var(--overdue-start)');
});

test('the next event\\'s "in N" is in the accent; a finished event is greyed; a ticked to-do is struck through', () => {
  assert.equal(declOf('.today-rel', 'color'), 'var(--accent)');
  assert.equal(declOf('.today-row.past .today-open', 'color'), 'var(--muted)');
  assert.equal(declOf('.today-row.done .today-text', 'text-decoration'), 'line-through');
});

test('a pressed Today row is tinted, not dimmed like a pressed button', () => {
  assert.equal(declOf('button[data-press].pressed', 'opacity'), '1');
  assert.equal(declOf('[data-press].pressed', 'background'), 'var(--chip-bg)', 'fixture check: the tint');
});

// The punchlist's carry-over (2): [data-press].pressed is (0,2,0). An id
// selector on a Today row would outrank it, and a pressed row would show
// nothing.
test('no rule styles Today through an id', () => {
  const sels = [...css.matchAll(/([^{}]+)\\{/g)].map((m) => m[1].trim()).filter((sel) => /today/.test(sel));
  assert.ok(sels.length >= 10, `fixture check: found ${sels.length} Today rules`);
  for (const sel of sels) assert.doesNotMatch(sel, /#/, sel);
});

test('every Today colour is a theme token, so dark mode follows', () => {
  let seen = 0;
  for (const [, sel, body] of css.matchAll(/([^{}]+)\\{([^}]*)\\}/g)) {
    if (!/\\.today-/.test(sel)) continue;
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      if (!/^(color|background|border)/.test(prop)) continue;
      seen += 1;
      assert.match(value, /var\\(--/, `${sel.trim()} { ${prop}: ${value} }`);
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}\\b|rgba?\\(|hsla?\\(/i, `${sel.trim()} { ${prop}: ${value} }`);
    }
  }
  assert.ok(seen >= 8, `fixture check: ${seen} colour declarations`);
});
"""
open(p, 'w').write(s)
PY
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/styles.test.js`
Expected: `# tests 91`, `# fail 8` — `only the new screens read the new type scale` (`fixture check: found 0 readers`), `Today rows are full-width hairline rows…`, `Today labels are 13px…`, `an overdue age is red…`, `the next event's "in N" is in the accent…`, `a pressed Today row is tinted…`, `no rule styles Today through an id` (`fixture check: found 0 Today rules`), `every Today colour is a theme token…` (`fixture check: 0 colour declarations`).

- [ ] **Step 3: Implement**

```bash
python3 - <<'PY'
p = 'styles.css'
s = open(p).read()
a = """.time-line { color: var(--muted); font-size: 0.8rem; font-style: italic; }
"""
b = """.time-line { color: var(--muted); font-size: 0.8rem; font-style: italic; }

/* ---------- Today (home-screen spec § 2.3, § 5) ---------- */
/* Rows, not cards: full width, a 1px hairline, at least 44px. Classes only,
   never an id: an id selector would outrank [data-press].pressed (0,2,0) and
   a pressed row would show nothing (tests/styles.test.js). Every colour is a
   token, so dark mode follows. After .item-open, whose `font: inherit` the
   row size below must override. */
.today-head { display: flex; justify-content: space-between; align-items: flex-start; margin: 0 0 var(--space-4); }
.today-title { font-family: var(--serif); font-size: var(--text-hero); line-height: 1.2; margin: 0; }
.today-date, .today-label, .today-day {
  font-family: var(--sans);
  font-size: var(--text-label);
  letter-spacing: var(--label-tracking);
  text-transform: uppercase;
  color: var(--muted);
}
.today-date { margin: var(--space-1) 0 0; }
.today-label { margin: 0 0 var(--space-2); }
.today-day { margin: var(--space-3) 0 var(--space-1); }
.today-section { margin-bottom: var(--space-5); }
.today-list { list-style: none; margin: 0; padding: 0; }
.today-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 44px;
  padding-left: var(--space-2);
  border-bottom: 1px solid var(--line);
  border-left: 3px solid var(--type, var(--type-general));
}
/* 20px box; the row's padding and gap make the left edge the target. */
.today-check { width: 20px; height: 20px; flex: 0 0 auto; margin: 0; }
.today-open {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
  font-size: var(--text-row);
}
.today-text { flex: 1; min-width: 0; font-family: var(--serif); }
.today-time, .today-age, .today-rel, .today-guess {
  flex: 0 0 auto;
  font-family: var(--sans);
  font-size: var(--text-label);
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
/* Past a deadline: red. Past a start date: orange (spec § 2.3). */
.today-age.deadline { color: var(--danger); }
.today-age.start { color: var(--overdue-start); }
/* The one accent on the page: the next event's "in N". */
.today-rel { color: var(--accent); }
.today-guess { font-style: italic; }
.today-row.past .today-open { color: var(--muted); }
.today-row.done .today-text { text-decoration: line-through; }
.today-empty { color: var(--muted); font-size: var(--text-row); margin: 0 0 var(--space-5); }
/* A pressed row is tinted (--chip-bg, above), not dimmed like a button. */
button[data-press].pressed { opacity: 1; }
"""
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, b))
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/styles.test.js` → `# tests 91`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant (in `styles.css`) | Must fail |
|---|---|
| `.cal-cell` `font-size: var(--text-label);` | `.cal-cell keeps its compact font-size (0.72rem)`, `only the new screens read the new type scale` |
| add `#today-body .today-row { background: var(--card); }` | `no rule styles Today through an id` |
| `.today-age.start { color: #9c5418; }` | `an overdue age is red past a deadline and orange past a start date`, `every Today colour is a theme token, so dark mode follows` |
| `.today-age.start { color: var(--danger); }` | `an overdue age is red past a deadline and orange past a start date` |
| delete `button[data-press].pressed { opacity: 1; }` | `a pressed Today row is tinted, not dimmed like a pressed button` |
| `.today-open` `font-size: 0.875rem;` | `Today rows are full-width hairline rows, at least 44px, in 16px type` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add styles.css tests/styles.test.js && git commit -m "style: Today — 13px labels, 16px rows, 28px heading, red and orange ages, token colours only" -m "Home-screen spec § 2.3, § 5: hairline rows at least 44px; the next event's time in the accent; finished events greyed; ticked to-dos struck through. Classes only, never an id, so [data-press].pressed wins; a pressed row is tinted, not dimmed. The stage-2 'no consumer yet' guard becomes 'only new screens read the scale'." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1420`, `# fail 0`, `# cancelled 0`.

---

### Task 10: ship 3a + 3b — REQUIRES ALEX'S EXPLICIT GO-AHEAD

Merging to `main` deploys to GitHub Pages. Without an explicit yes from Alex in this conversation for this merge, stop after Step 1 and leave 3a–3b on the branch.

**Files:**
- Modify: `service-worker.js:13` (`CACHE`)
- Modify: `tests/serviceworker.test.js:48` (`CACHE_ON_MAIN`)

**Interfaces:**
- Consumes: `CACHE` on `main` (`plaenicke-v6-8` at e6c4d00).
- Produces: `CACHE = 'plaenicke-v6-9'`; `CACHE_ON_MAIN = 'plaenicke-v6-8'`. `ASSETS` already lists `js/today.js` and `js/todayview.js` (Tasks 3 and 5).

- [ ] **Step 1: Ask Alex, and wait**

Send: "Stage 3a–3b (Today) is ready on `home-screen-design`: `npm test` 1420 pass, 0 fail, 0 cancelled. Visible changes: the app opens on a new Today page (Overdue, To do today, Today's events, Next 7 days); the gear moves onto Today; a seventh 'Today' button joins the view row ('To-do' wraps to two lines there until 3c); repeating classes show only on their own day. Shipping bumps the cache to v6-9, merges into `main` and pushes — a production deploy. Go ahead?" Go on to Step 2 only after an explicit yes.

- [ ] **Step 2: Check that main has not moved**

```bash
git fetch origin && git rev-parse main origin/main && git show main:service-worker.js | grep "const CACHE"
```

Expected: the two SHAs are identical (e6c4d00…), and `const CACHE = 'plaenicke-v6-8';`. If either differs, stop and report: the pins below assume v6-8.

- [ ] **Step 3: Re-pin the guard to main's value (the failing test)**

In `tests/serviceworker.test.js`, change line 48 to:

```js
const CACHE_ON_MAIN = 'plaenicke-v6-8';
```

- [ ] **Step 4: Run it and see it fail**

Run: `node --test tests/serviceworker.test.js`
Expected: `not ok 3 - the cache name is ahead of the release on main` (`… main's 'plaenicke-v6-8' …; got 'plaenicke-v6-8'`), `# pass 8`, `# fail 1`.

- [ ] **Step 5: Bump CACHE**

In `service-worker.js`, change line 13 to:

```js
const CACHE = 'plaenicke-v6-9';
```

- [ ] **Step 6: Run it and see it pass; mutation-check**

Run: `node --test tests/serviceworker.test.js` → `# pass 9`, `# fail 0`.
Mutant: remove `'js/todayview.js'` from ASSETS → `every js/ module is precached…` fails. Restore it.

- [ ] **Step 7: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add service-worker.js tests/serviceworker.test.js && git commit -m "release: bump service-worker CACHE to plaenicke-v6-9" -m "Re-pins the test's CACHE_ON_MAIN to main's v6-8 so the guard can fail." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Merge, re-test on main, push**

```bash
git checkout main && git merge --no-ff home-screen-design -m "merge: home screen stage 3a–3b — the Today page" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git push origin main && git checkout home-screen-design
```

Expected: `# tests 1420`, `# fail 0`, `# cancelled 0`, the push succeeds, and the branch is `home-screen-design` again. If the gate fails on main, do not push: report it.

- [ ] **Step 9: Live check**

With the Monitor tool (an until-loop; foreground `sleep` is blocked):

```bash
until curl -s https://ajaenicke518.github.io/plaenicke/service-worker.js | grep -q "plaenicke-v6-9"; do sleep 15; done; echo live
```

Then:

```bash
curl -s -o /dev/null -w "%{http_code} " https://ajaenicke518.github.io/plaenicke/js/today.js; curl -s -o /dev/null -w "%{http_code}\n" https://ajaenicke518.github.io/plaenicke/js/todayview.js
```

Expected: `live`, then `200 200`.

- [ ] **Step 10: On-device check (Alex, iPhone home-screen app, light and dark)**

Ask Alex to open the app twice (the network-first worker serves the new files on the launch after it activates), then check:

- The app opens on Today, with today's date under the heading and the gear on the right.
- A typical day (2 classes, 1–2 to-dos) fits the screen without scrolling below the add box (spec § 1 success criterion; the add box stays on top until stage 4).
- LMU classes appear under Today's events on their own days and never under Next 7 days; an exam, a quiz or a "no class" day appears under Next 7 days on its day.
- The next event shows "in N min" / "in N h N min" / "now", and it counts down over a few minutes without the list jumping.
- An overdue deadline's age is red and an overdue start's age is orange; **the two are readable and tell apart in light and in dark mode** (punchlist carry-over 4). Also check that the next event's "in N" (the accent: leather brown in light mode) does not read as the orange start age — in Chrome's light-mode render the two browns look close.
- Ticking a to-do on Today keeps the row, struck through — in To do today and in Overdue (it moves below the undone overdue rows); ticking it again unticks it. With the app left open over midnight, yesterday's Today stays until the next render (reopen, sync or any write) — "until tomorrow" means until the first render tomorrow. A tick does not flash the whole row; tapping a row's title flashes the row (tinted, not dimmed) and opens its sheet.
- Settings opens from the gear.
- Dark mode: every Today colour follows the theme.

If anything here fails, stop: the fix becomes a new task with its own failing test.

---

# Stage 3c — the tab bar and Calendar's switcher (spec § 8, 3c)

### Task 11: four tabs; Day / Week / Month / List; the tab title

**Files:**
- Modify: `index.html` — the header `<h1>`, the `.view-toggle` nav (replaced by `#cal-switch`), the tab bar before `#settings-host`
- Modify: `js/app.js` — `els` (`showTodo`, `showIdeas`, `showToday` removed; six added), `showView`, the nav listeners
- Modify: `tests/apply.test.js` — four existing tests rewritten, every `'show-today'`/`'show-todo'`/`'show-ideas'` literal renamed; append

**Interfaces:**
- Consumes: Tasks 7–8.
- Produces: `#tab-title` (`h1`), `#cal-switch` (`div[role=group]`, hidden unless Calendar), `#tab-today`, `#tab-calendar`, `#tab-todo`, `#tab-ideas`; `CALENDAR_VIEWS`, `TAB_TITLES`, `lastCalendarView` in `js/app.js`. `showView(which)` takes the same seven names; `openDay` (unchanged) lands in Calendar's Day.

Existing tests changed on purpose (each taps the old view buttons):

- `each nav button reveals exactly its own page, and marks itself active` → `each tab and each Calendar segment reveals exactly its own page, and marks itself active`, driven by a new `NAV` table (control, section, active tab) that also checks the switcher's visibility.
- `index.html opens on Today` — now checks `#tab-today` is the active control and `#cal-switch` starts hidden.
- `a11y: index.html marks the Today button pressed…` → `a11y: index.html marks the Today tab pressed and every other tab and segment not`.
- `a11y: each nav button reports itself pressed, and only itself` → `a11y: each tab and segment reports itself pressed — a segment with Calendar, and nothing else`.
- Renamed literals, `'show-today'` → `'tab-today'`, `'show-todo'` → `'tab-todo'`, `'show-ideas'` → `'tab-ideas'`, in: `PAGES`, `visiblePageButton`, `sF: an Undo across the idea line…`, `sF: an Undo whose rebuild would change a skipped field…`, `Today: the page names the day…`, `Today: a tick on Today is saved…`, both tick tests. `show-day`, `show-week`, `show-month` and `show-list` keep their ids (they are the switcher's segments), so every other test that taps them is unchanged.

- [ ] **Step 1: Write the failing tests**

```bash
python3 - <<'PY'
p = 'tests/apply.test.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a[:80]
    s = s.replace(a, b)
rep("""test('each nav button reveals exactly its own page, and marks itself active', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const pages = [
    ['show-today', 'today-view'],
    ['show-list', 'list-view'],
    ['show-month', 'calendar-view'],
    ['show-week', 'week-view'],
    ['show-day', 'day-view'],
    ['show-todo', 'todo-view'],
    ['show-ideas', 'ideas-view'],
  ];
  for (const [buttonId, sectionId] of pages) {
    click(globalThis.document.getElementById(buttonId));
    for (const [otherButton, otherSection] of pages) {
      const section = globalThis.document.getElementById(otherSection);
      const button = globalThis.document.getElementById(otherButton);
      const isTarget = otherSection === sectionId;
      assert.equal(section.hidden, !isTarget,
        `after clicking #${buttonId}, #${otherSection} should be ${isTarget ? 'visible' : 'hidden'}`);
      assert.equal(button._classes.has('active'), isTarget,
        `after clicking #${buttonId}, #${otherButton} should${isTarget ? '' : ' not'} be active`);
    }
  }
  click(globalThis.document.getElementById('show-list')); // leave the default view selected
});""", """// Home-screen stage 3c: four tabs, and Calendar's four segments. Each control
// reveals exactly its own page; the active tab is the page's tab (Calendar
// for its four), and the active segment is the page itself.
const NAV = [
  // [control, section, tab that is active]
  ['tab-today', 'today-view', 'tab-today'],
  ['show-day', 'day-view', 'tab-calendar'],
  ['show-week', 'week-view', 'tab-calendar'],
  ['show-month', 'calendar-view', 'tab-calendar'],
  ['show-list', 'list-view', 'tab-calendar'],
  ['tab-todo', 'todo-view', 'tab-todo'],
  ['tab-ideas', 'ideas-view', 'tab-ideas'],
];
const TABS = ['tab-today', 'tab-calendar', 'tab-todo', 'tab-ideas'];
const SEGMENTS = ['show-day', 'show-week', 'show-month', 'show-list'];

test('each tab and each Calendar segment reveals exactly its own page, and marks itself active', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const doc = globalThis.document;
  for (const [control, sectionId, tab] of NAV) {
    click(doc.getElementById(control));
    for (const [, otherSection] of NAV) {
      assert.equal(doc.getElementById(otherSection).hidden, otherSection !== sectionId,
        `after #${control}, #${otherSection}`);
    }
    for (const t of TABS) assert.equal(doc.getElementById(t)._classes.has('active'), t === tab, `after #${control}, #${t}`);
    for (const seg of SEGMENTS) {
      assert.equal(doc.getElementById(seg)._classes.has('active'), seg === control, `after #${control}, #${seg}`);
    }
    assert.equal(doc.getElementById('cal-switch').hidden, tab !== 'tab-calendar', `after #${control}, the switcher`);
  }
  click(doc.getElementById('tab-today'));
});""")
rep("""test('index.html opens on Today', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="show-today"[^>]*class="active"/, 'the Today button must be the active one on load');
  assert.doesNotMatch(html, /<button id="show-(list|month|week|day|todo|ideas)"[^>]*class="active"/, 'and no other');""", """test('index.html opens on Today', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="tab-today"[^>]*class="active"/, 'the Today tab must be the active one on load');
  assert.doesNotMatch(html, /<button id="(tab-calendar|tab-todo|tab-ideas|show-[a-z]+)"[^>]*class="active"/, 'and no other');
  assert.match(html, /<div id="cal-switch"[^>]*hidden/, 'the Calendar switcher starts hidden');""")
rep("""test('a11y: index.html marks the Today button pressed and every other nav button not', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['show-today', 'show-list', 'show-month', 'show-week', 'show-day', 'show-todo', 'show-ideas']) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(tag, `fixture check: #${id}`);
    assert.match(tag[0], new RegExp(`aria-pressed="${id === 'show-today'}"`), `#${id}`);
  }
});""", """test('a11y: index.html marks the Today tab pressed and every other tab and segment not', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of [...TABS, ...SEGMENTS]) {
    const tag = html.match(new RegExp(`<button id="${id}"[^>]*>`));
    assert.ok(tag, `fixture check: #${id}`);
    assert.match(tag[0], new RegExp(`aria-pressed="${id === 'tab-today'}"`), `#${id}`);
  }
});""")
rep("""test('a11y: each nav button reports itself pressed, and only itself', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const restore = visiblePageButton();
  const ids = ['show-today', 'show-list', 'show-month', 'show-week', 'show-day', 'show-todo', 'show-ideas'];
  try {
    for (const id of ids) {
      click(globalThis.document.getElementById(id));
      for (const other of ids) {
        assert.equal(globalThis.document.getElementById(other).getAttribute('aria-pressed'), String(other === id),
          `after #${id}, #${other}`);
      }
    }
  } finally {
    if (restore) click(restore);
  }
});""", """test('a11y: each tab and segment reports itself pressed — a segment with Calendar, and nothing else', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const restore = visiblePageButton();
  try {
    for (const [control, , tab] of NAV) {
      click(globalThis.document.getElementById(control));
      for (const other of [...TABS, ...SEGMENTS]) {
        assert.equal(globalThis.document.getElementById(other).getAttribute('aria-pressed'),
          String(other === control || other === tab), `after #${control}, #${other}`);
      }
    }
  } finally {
    if (restore) click(restore);
  }
});""")
for a, b in [("'show-today'", "'tab-today'"), ("'show-todo'", "'tab-todo'"), ("'show-ideas'", "'tab-ideas'")]:
    s = s.replace(a, b)
open(p, 'w').write(s)
PY
```

Append to the end of `tests/apply.test.js`:

```js
// =========================================================================
// Home-screen stage 3c — the tab bar and Calendar's switcher (spec § 4)
// =========================================================================

test('tabs: the bar is Today | Calendar | To-do | Ideas, and Calendar\'s switcher is Day / Week / Month / List', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const bar = html.match(/<nav class="tab-bar"[\s\S]*?<\/nav>/);
  assert.ok(bar, 'fixture check: index.html has the tab bar');
  assert.deepEqual([...bar[0].matchAll(/<button id="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]), [
    ['tab-today', 'Today'], ['tab-calendar', 'Calendar'], ['tab-todo', 'To-do'], ['tab-ideas', 'Ideas'],
  ]);
  const sw = html.match(/<div id="cal-switch"[\s\S]*?<\/div>/);
  assert.ok(sw, 'fixture check: index.html has the switcher');
  assert.deepEqual([...sw[0].matchAll(/<button id="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]), [
    ['show-day', 'Day'], ['show-week', 'Week'], ['show-month', 'Month'], ['show-list', 'List'],
  ], 'List stays (question 4); 3-day is hidden until it is built (question 5)');
  assert.doesNotMatch(html, /class="view-toggle"|id="show-(today|todo|ideas|3day)"|>3-day</i,
    'the six view buttons are gone, and no 3-day control exists');
});

test('tabs: Calendar opens on the view last used there, Day by default', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const doc = globalThis.document;
  const restore = visiblePageButton();
  try {
    click(doc.getElementById('show-day'));
    click(doc.getElementById('tab-today'));
    click(doc.getElementById('tab-calendar'));
    assert.equal(doc.getElementById('day-view').hidden, false, 'Day');
    click(doc.getElementById('show-month'));
    click(doc.getElementById('tab-todo'));
    click(doc.getElementById('tab-calendar'));
    assert.equal(doc.getElementById('calendar-view').hidden, false, 'back on Month');
    assert.ok(doc.getElementById('show-month')._classes.has('active'));
  } finally {
    click(doc.getElementById('show-day'));
    if (restore) click(restore);
  }
});

test('tabs: tapping a day in Month or Week opens Day inside Calendar', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const doc = globalThis.document;
  const restore = visiblePageButton();
  try {
    click(doc.getElementById('show-week'));
    click(doc.getElementById('week-grid').children[3]);
    assert.equal(doc.getElementById('day-view').hidden, false);
    assert.ok(doc.getElementById('tab-calendar')._classes.has('active'));
    assert.ok(doc.getElementById('show-day')._classes.has('active'));
    assert.equal(doc.getElementById('cal-switch').hidden, false);
  } finally {
    click(doc.getElementById('show-month'));
    openDayForToday();
    if (restore) click(restore);
  }
});

test('tabs: the shell title names the tab; on Today the Today heading stands alone', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const doc = globalThis.document;
  const title = doc.getElementById('tab-title');
  const restore = visiblePageButton();
  try {
    for (const [tab, text] of [['tab-calendar', 'Calendar'], ['tab-todo', 'To-do'], ['tab-ideas', 'Ideas']]) {
      click(doc.getElementById(tab));
      assert.equal(title.hidden, false, tab);
      assert.equal(title.textContent, text, tab);
    }
    click(doc.getElementById('tab-today'));
    assert.equal(title.hidden, true);
  } finally {
    if (restore) click(restore);
  }
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<h1 id="tab-title"[^>]*hidden/, 'hidden at load, when Today is showing');
  assert.doesNotMatch(html, />plaenicke<\/h1>/, 'the plaenicke h1 is replaced by the tab titles');
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/apply.test.js`
Expected: `# tests 194`, `# fail 15` — the four rewritten tests, the four new `tabs:` tests, `sweep U: after a Save, focus returns…`, both `sF: an Undo …` tests, `Today: the page names the day…`, `Today: a tick on Today is saved…` and both tick tests: the `tab-*` and `cal-switch` ids do not exist yet (`TypeError: Cannot read properties of null`) or the markup does not match.

- [ ] **Step 3: Implement**

In `index.html`:

```bash
python3 - <<'PY'
p = 'index.html'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a[:60]
    s = s.replace(a, b)
rep("""  <header>
    <h1>plaenicke</h1>""", """  <header>
    <!-- The tab's title (home-screen spec § 2.2), set by js/app.js's
         showView. Hidden on Today, whose own heading names the day. -->
    <h1 id="tab-title" hidden>Today</h1>""")
rep("""  <nav class="view-toggle">
    <button id="show-today" type="button" class="active" aria-pressed="true">Today</button>
    <button id="show-list" type="button" aria-pressed="false">List</button>
    <button id="show-month" type="button" aria-pressed="false">Month</button>
    <button id="show-week" type="button" aria-pressed="false">Week</button>
    <button id="show-day" type="button" aria-pressed="false">Day</button>
    <button id="show-todo" type="button" aria-pressed="false">To-do</button>
    <button id="show-ideas" type="button" aria-pressed="false">Ideas</button>
  </nav>
""", """  <!-- Calendar's switcher (spec § 4), shown on the Calendar tab only. List
       stays (question 4); 3-day joins after Day once it is built
       (question 5). -->
  <div id="cal-switch" class="cal-switch" role="group" aria-label="Calendar view" hidden>
    <button id="show-day" type="button" aria-pressed="false">Day</button>
    <button id="show-week" type="button" aria-pressed="false">Week</button>
    <button id="show-month" type="button" aria-pressed="false">Month</button>
    <button id="show-list" type="button" aria-pressed="false">List</button>
  </div>
""")
rep("""  <div id="settings-host"></div>""", """  <!-- The tab bar (spec § 4), fixed at the bottom. -->
  <nav class="tab-bar" aria-label="Pages">
    <button id="tab-today" type="button" class="active" aria-pressed="true">Today</button>
    <button id="tab-calendar" type="button" aria-pressed="false">Calendar</button>
    <button id="tab-todo" type="button" aria-pressed="false">To-do</button>
    <button id="tab-ideas" type="button" aria-pressed="false">Ideas</button>
  </nav>

  <div id="settings-host"></div>""")
open(p, 'w').write(s)
PY
```

In `js/app.js`:

```bash
python3 - <<'PY'
p = 'js/app.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a[:60]
    s = s.replace(a, b)
rep("""  // V6 — the To-do and Ideas pages.
  showTodo: document.getElementById('show-todo'),
  showIdeas: document.getElementById('show-ideas'),
  todoView""", """  // V6 — the To-do and Ideas pages.
  todoView""")
rep("""  // Home-screen stage 3b — the Today page.
  showToday: document.getElementById('show-today'),
  todayView""", """  // Home-screen stage 3b — the Today page.
  todayView""")
rep("""  todayDate: document.getElementById('today-date'),
};""", """  todayDate: document.getElementById('today-date'),
  // Home-screen stage 3c — the tab bar, the tab title and Calendar's switcher.
  tabToday: document.getElementById('tab-today'),
  tabCalendar: document.getElementById('tab-calendar'),
  tabTodo: document.getElementById('tab-todo'),
  tabIdeas: document.getElementById('tab-ideas'),
  tabTitle: document.getElementById('tab-title'),
  calSwitch: document.getElementById('cal-switch'),
};""")
rep("""function showView(which) {
  const views = {
    today: els.todayView, list: els.listView, month: els.calView, week: els.weekView, day: els.dayView,
    todo: els.todoView, ideas: els.ideasView,
  };
  const buttons = {
    today: els.showToday, list: els.showList, month: els.showMonth, week: els.showWeek, day: els.showDay,
    todo: els.showTodo, ideas: els.showIdeas,
  };
  for (const [name, el] of Object.entries(views)) el.hidden = name !== which;
  // aria-pressed says which page is showing to assistive tech, which does not
  // read the class. index.html carries the load-time values.
  for (const [name, b] of Object.entries(buttons)) {
    b.classList.toggle('active', name === which);
    b.setAttribute('aria-pressed', String(name === which));
  }
  render();
  syncTodayTick();
}""", """// The tab bar (home-screen spec § 4): Today | Calendar | To-do | Ideas.
// Calendar holds four views, chosen by its switcher, and opens on the one
// last used there (Day until another is picked; this session only).
const CALENDAR_VIEWS = ['day', 'week', 'month', 'list'];
const TAB_TITLES = { today: 'Today', calendar: 'Calendar', todo: 'To-do', ideas: 'Ideas' };
let lastCalendarView = 'day';

function showView(which) {
  const views = {
    today: els.todayView, list: els.listView, month: els.calView, week: els.weekView, day: els.dayView,
    todo: els.todoView, ideas: els.ideasView,
  };
  const tabs = { today: els.tabToday, calendar: els.tabCalendar, todo: els.tabTodo, ideas: els.tabIdeas };
  const segments = { day: els.showDay, week: els.showWeek, month: els.showMonth, list: els.showList };
  const tab = CALENDAR_VIEWS.includes(which) ? 'calendar' : which;
  if (tab === 'calendar') lastCalendarView = which;
  for (const [name, el] of Object.entries(views)) el.hidden = name !== which;
  // aria-pressed says which page is showing to assistive tech, which does not
  // read the class. index.html carries the load-time values.
  const mark = (b, on) => { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); };
  for (const [name, b] of Object.entries(tabs)) mark(b, name === tab);
  for (const [name, b] of Object.entries(segments)) mark(b, name === which);
  els.calSwitch.hidden = tab !== 'calendar';
  els.tabTitle.textContent = TAB_TITLES[tab];
  els.tabTitle.hidden = tab === 'today';
  render();
  syncTodayTick();
}""")
rep("""els.showToday.addEventListener('click', () => showView('today'));
els.showList.addEventListener('click', () => showView('list'));
els.showMonth.addEventListener('click', () => showView('month'));
els.showWeek.addEventListener('click', () => showView('week'));
els.showDay.addEventListener('click', () => showView('day'));
els.showTodo.addEventListener('click', () => showView('todo'));
els.showIdeas.addEventListener('click', () => showView('ideas'));""", """els.tabToday.addEventListener('click', () => showView('today'));
els.tabCalendar.addEventListener('click', () => showView(lastCalendarView));
els.tabTodo.addEventListener('click', () => showView('todo'));
els.tabIdeas.addEventListener('click', () => showView('ideas'));
els.showList.addEventListener('click', () => showView('list'));
els.showMonth.addEventListener('click', () => showView('month'));
els.showWeek.addEventListener('click', () => showView('week'));
els.showDay.addEventListener('click', () => showView('day'));""")
open(p, 'w').write(s)
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/apply.test.js` → `# tests 194`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant (in `js/app.js`) | Must fail |
|---|---|
| `els.tabCalendar…showView(lastCalendarView)` → `showView('day')` | `tabs: Calendar opens on the view last used there, Day by default` |
| `els.calSwitch.hidden = tab !== 'calendar';` → `= false;` | `each tab and each Calendar segment reveals exactly its own page…` |
| tabs marked with `name === which` instead of `name === tab` | `each tab and each Calendar segment…`, `a11y: each tab and segment reports itself pressed…`, `tabs: tapping a day in Month or Week opens Day inside Calendar` |
| `els.tabTitle.hidden = tab === 'today';` → `= false;` | `tabs: the shell title names the tab; on Today the Today heading stands alone` |
| `if (tab === 'calendar') lastCalendarView = which;` → `… && which !== 'month'` | `tabs: Calendar opens on the view last used there…` |

- [ ] **Step 6: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add index.html js/app.js tests/apply.test.js && git commit -m "feat(app): tabs Today | Calendar | To-do | Ideas; Calendar's Day / Week / Month / List" -m "Home-screen spec § 4, stage 3c: the six view buttons are replaced; List stays as a segment and 3-day stays hidden; Calendar reopens on its last view (Day at launch); tapping a day opens Day; the shell h1 is the tab's title, hidden on Today. Tests that tapped the old buttons are updated (listed in the plan)." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1424`, `# fail 0`, `# cancelled 0`.

---

### Task 12: geometry — the bar, safe areas, the toast above it, layers

**Files:**
- Modify: `styles.css` — `body`'s `padding-bottom` (line 128 on the baseline), the `/* ---------- view toggle ---------- */` block (lines 220-230 on the baseline, replaced), the `.toast` rule (line 644 on the baseline)
- Modify: `index.html` — `#tab-title` gains `class="tab-title"`
- Modify: `tests/styles.test.js` — `body leaves room at the bottom for the toast` rewritten; `NEW_SCREEN` widened; append

**Interfaces:**
- Consumes: `declOf`, `ruleExists`, `px`, `zIndexOf` (`tests/styles.test.js`).
- Produces: `.tab-bar` (fixed, `z-index: 5`, `height: calc(56px + env(safe-area-inset-bottom))`), `.tab-bar button`, `.tab-title`, `.cal-switch`, `.cal-switch[hidden]`; `body` `padding-bottom: calc(56px + 72px + env(safe-area-inset-bottom))`; `.toast` `bottom: calc(56px + 12px + env(safe-area-inset-bottom)); right: 88px`.

Existing tests changed on purpose: `body leaves room at the bottom for the toast` (asserted `calc(96px + …)`) → `body leaves room at the bottom for the tab bar, the capture button and the toast`; `NEW_SCREEN` (Task 9) becomes `/\.(today-|tab-|cal-switch)/`, because the tab bar and the switcher are new screens too.

- [ ] **Step 1: Write the failing tests**

```bash
python3 - <<'PY'
p = 'tests/styles.test.js'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a[:60]
    s = s.replace(a, b)
rep("""test('body leaves room at the bottom for the toast', () => {
  assert.equal(declOf('body', 'padding-bottom'), 'calc(96px + env(safe-area-inset-bottom))');
});""", """// Home-screen stage 3c (spec § 4): the bar (56px), the capture button's row
// (72px, stage 4) and the home indicator.
test('body leaves room at the bottom for the tab bar, the capture button and the toast', () => {
  assert.equal(declOf('body', 'padding-bottom'), 'calc(56px + 72px + env(safe-area-inset-bottom))');
});""")
rep("""const NEW_SCREEN = /\\.today-/;""", """const NEW_SCREEN = /\\.(today-|tab-|cal-switch)/;""")
s += """
// --- home-screen stage 3c: the tab bar and the switcher (spec § 4) ----------
test('the tab bar is fixed at the bottom, 56px plus the home-indicator inset', () => {
  assert.equal(declOf('.tab-bar', 'position'), 'fixed');
  assert.equal(declOf('.tab-bar', 'bottom'), '0');
  assert.equal(declOf('.tab-bar', 'left'), '0');
  assert.equal(declOf('.tab-bar', 'right'), '0');
  assert.equal(declOf('.tab-bar', 'height'), 'calc(56px + env(safe-area-inset-bottom))');
  assert.equal(declOf('.tab-bar', 'padding-bottom'), 'env(safe-area-inset-bottom)');
  assert.equal(declOf('.tab-bar', 'background'), 'var(--card)');
  assert.equal(declOf('.tab-bar', 'border-top'), '1px solid var(--line)');
});

test('layers: tab bar 5 < settings 10 < item sheet 15 < toast 20 (spec § 4)', () => {
  assert.equal(zIndexOf('.tab-bar'), 5);
  assert.equal(zIndexOf('.settings-backdrop'), 10);
  assert.equal(zIndexOf('.sheet-backdrop'), 15);
  assert.equal(zIndexOf('.toast'), 20);
});

test('the toast sits above the tab bar and clears the capture button\\'s corner', () => {
  assert.equal(declOf('.toast', 'bottom'), 'calc(56px + 12px + env(safe-area-inset-bottom))');
  assert.equal(declOf('.toast', 'right'), '88px');
  assert.equal(declOf('.toast', 'left'), '16px');
});

test('a tab is a 44px target; the active one is in the accent', () => {
  assert.ok(px(declOf('.tab-bar button', 'min-height')) >= 44);
  assert.equal(declOf('.tab-bar button', 'font-size'), 'var(--text-label)');
  assert.equal(declOf('.tab-bar button.active', 'color'), 'var(--accent)');
});

test('the tab title is 20px; Today\\'s own heading stays 28px', () => {
  assert.equal(declOf('.tab-title', 'font-size'), 'var(--text-title)');
  assert.equal(declOf(':root', '--text-title'), '20px', 'fixture check');
  assert.equal(declOf('.today-title', 'font-size'), 'var(--text-hero)');
});

// .cal-switch sets display: flex, which beats the `hidden` attribute's
// display: none. Without this rule the switcher would show on every tab.
test('a hidden switcher is not displayed', () => {
  assert.equal(declOf('.cal-switch', 'display'), 'flex', 'fixture check');
  assert.equal(declOf('.cal-switch[hidden]', 'display'), 'none');
});

test('the six-button view toggle is gone from the stylesheet', () => {
  assert.equal(ruleExists('.view-toggle'), false);
  assert.equal(ruleExists('.view-toggle button'), false);
});
"""
open(p, 'w').write(s)
PY
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test tests/styles.test.js`
Expected: `# tests 98`, `# fail 8` — the rewritten `body leaves room…` and the seven new tests (`the tab bar is fixed at the bottom…`, `layers: tab bar 5 < …` (`expected a .tab-bar rule`), `the toast sits above the tab bar…`, `a tab is a 44px target…`, `the tab title is 20px…`, `a hidden switcher is not displayed`, `the six-button view toggle is gone from the stylesheet`).

- [ ] **Step 3: Implement**

```bash
python3 - <<'PY'
p = 'styles.css'
s = open(p).read()
def rep(a, b):
    global s
    assert s.count(a) == 1, a[:60]
    s = s.replace(a, b)
rep("""  /* Room for the fixed .toast (edit-items Task 4b): without it the last row,
     often the very item a delete offers to undo, sits under the toast. */
  padding-bottom: calc(96px + env(safe-area-inset-bottom));""", """  /* Room under the content for the fixed tab bar (56px) and the capture
     button's row (72px, stage 4), above the home indicator (home-screen
     spec § 4). The toast sits inside it, so the last row, often the very
     item a delete offers to undo, is never under the toast. */
  padding-bottom: calc(56px + 72px + env(safe-area-inset-bottom));""")
rep("""/* ---------- view toggle ---------- */
.view-toggle { display: flex; gap: 6px; margin-bottom: 12px; }
.view-toggle button {
  flex: 1;
  background: var(--card);
  color: var(--ink);
  border: 1px solid var(--line);
  padding: 8px 4px;
  font-size: 0.9rem;
}
.view-toggle button.active { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
""", """/* ---------- tab bar and Calendar's switcher (home-screen spec § 4) ---------- */
/* Layers: content 0 < tab bar 5 < capture button 6 < capture box 8 (stage 4)
   < settings 10 < item sheet 15 < toast 20. */
.tab-bar {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 5;
  display: flex;
  height: calc(56px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: var(--card);
  border-top: 1px solid var(--line);
}
.tab-bar button {
  flex: 1;
  min-height: 44px;
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--sans);
  font-size: var(--text-label);
}
.tab-bar button.active { color: var(--accent); font-weight: 600; }
.tab-title { font-size: var(--text-title); font-style: normal; }
.cal-switch { display: flex; gap: var(--space-1); margin-bottom: var(--space-3); }
.cal-switch[hidden] { display: none; }
.cal-switch button {
  flex: 1;
  padding: 8px 4px;
  background: var(--card);
  color: var(--ink);
  border: 1px solid var(--line);
  font-family: var(--sans);
  font-size: var(--text-label);
}
.cal-switch button.active { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
""")
rep("""/* Above .settings-backdrop (z-index 10) so an Undo raised while a panel is
   open is still reachable; bottom inset clears the iPhone home indicator. */
.toast {
  position: fixed;
  left: 16px; right: 16px;
  bottom: calc(16px + env(safe-area-inset-bottom));""", """/* Above .settings-backdrop (z-index 10) so an Undo raised while a panel is
   open is still reachable. Above the tab bar, and clear of the capture
   button's corner (56px wide at right: 16px, stage 4; spec § 4). */
.toast {
  position: fixed;
  left: 16px; right: 88px;
  bottom: calc(56px + 12px + env(safe-area-inset-bottom));""")
open(p, 'w').write(s)
p = 'index.html'
s = open(p).read()
a = '<h1 id="tab-title" hidden>Today</h1>'
assert s.count(a) == 1
open(p, 'w').write(s.replace(a, '<h1 id="tab-title" class="tab-title" hidden>Today</h1>'))
PY
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/styles.test.js` → `# tests 98`, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Mutation-check**

| Mutant (in `styles.css`) | Must fail |
|---|---|
| delete `.cal-switch[hidden] { display: none; }` | `a hidden switcher is not displayed` |
| `.tab-bar` `z-index: 12;` | `layers: tab bar 5 < settings 10 < item sheet 15 < toast 20 (spec § 4)` |
| `.tab-bar` `height: 56px;` without the `padding-bottom` line | `the tab bar is fixed at the bottom, 56px plus the home-indicator inset` |
| `.toast` `bottom: calc(16px + env(safe-area-inset-bottom));` | `the toast sits above the tab bar and clears the capture button's corner` |

- [ ] **Step 6: Browser check (Chrome, the throwaway way it was planned)**

Serve the branch read-only on localhost (`python3 -m http.server 8765 --bind 127.0.0.1` from the repo root, in the background), open `http://127.0.0.1:8765/index.html` in an isolated Chrome context at 375×667 (mobile, touch) — HARD REQUIREMENT: a fresh, isolated profile; first confirm `localStorage` holds no sync/link code for that origin, since a linked profile would push the seeded items to the real account — seed a few items through `localStorage.setItem('plaenicke.items', …)`, reload, and measure:

- `#cal-switch` with a fifth `<button>3-day</button>` inserted after Day: `scrollWidth === clientWidth` (planned: 343 = 343, five 65 px segments). Remove the button.
- `.tab-bar`'s rect: top 611, height 56 at 667 high.
- Delete a to-do with a long title: the toast's right edge is 287 (375 − 88), its Undo visible (planned: 271 × 66 px, Undo 71 px wide).
- `document.documentElement.scrollWidth === 375` (no sideways scroll).

Stop the server. This step changes no file.

- [ ] **Step 7: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add styles.css index.html tests/styles.test.js && git commit -m "style: the tab bar fixed above the home indicator; the toast above the bar; layers per spec" -m "Home-screen spec § 4: bar 56px + safe-area inset at z-index 5; body bottom padding 56 + 72 + inset (the 72px is the stage-4 capture button's row); toast at 56 + 12 + inset, right 88px. The switcher fits five segments at 375px (measured). The view-toggle rules are gone." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1431`, `# fail 0`, `# cancelled 0`.

---

### Task 13: ship 3c — REQUIRES ALEX'S EXPLICIT GO-AHEAD

Merging to `main` deploys. Without an explicit yes from Alex in this conversation for this merge, stop after Step 1.

**Branch amendment (2026-10-22, DA I4):** 3c lives on `home-screen-3c`, cut from Task 9's commit, so it lacks Task 10's v6-9 bump and any 3b phone-check fixes. Before Step 2, after Task 10 has shipped: `git checkout home-screen-3c && git merge --no-ff main` (expect `service-worker.js` CACHE → v6-9 and `CACHE_ON_MAIN` → v6-8 from main; resolve any conflict to main's values), then run the commit gate. Do Steps 3–7 on `home-screen-3c`. In Step 1's message and Step 8, every `home-screen-design` reads `home-screen-3c`.

**Files:**
- Modify: `service-worker.js:13` (`CACHE`)
- Modify: `tests/serviceworker.test.js:48` (`CACHE_ON_MAIN`)

**Interfaces:**
- Consumes: `CACHE` on `main` after Task 10 (`plaenicke-v6-9`).
- Produces: `CACHE = 'plaenicke-v6-10'`; `CACHE_ON_MAIN = 'plaenicke-v6-9'`. No new module: `ASSETS` is unchanged. (`version()` in the test compares numbers, so 10 > 9; checked while planning.)

- [ ] **Step 1: Ask Alex, and wait**

Send: "Stage 3c (tab bar) is ready on `home-screen-3c`: `npm test` 1431 pass, 0 fail, 0 cancelled. Visible changes: the row of view buttons is replaced by a bottom bar — Today | Calendar | To-do | Ideas; Calendar has Day / Week / Month / List at its top and reopens on the one you used last; the page title names the tab; the Undo toast sits above the bar, narrower, leaving the bottom-right corner free for the mic button (stage 4). Shipping bumps the cache to v6-10, merges into `main` and pushes — a production deploy. Go ahead?" Go on only after an explicit yes.

- [ ] **Step 2: Check that main has not moved**

```bash
git fetch origin && git rev-parse main origin/main && git show main:service-worker.js | grep "const CACHE"
```

Expected: identical SHAs, and `const CACHE = 'plaenicke-v6-9';`. Otherwise stop and report.

- [ ] **Step 3: Re-pin the guard (the failing test)**

In `tests/serviceworker.test.js`, change line 48 to:

```js
const CACHE_ON_MAIN = 'plaenicke-v6-9';
```

- [ ] **Step 4: Run it and see it fail**

Run: `node --test tests/serviceworker.test.js` → `not ok 3 - the cache name is ahead of the release on main` (`got 'plaenicke-v6-9'`).

- [ ] **Step 5: Bump CACHE**

In `service-worker.js`, change line 13 to:

```js
const CACHE = 'plaenicke-v6-10';
```

- [ ] **Step 6: Run it and see it pass; mutation-check**

Run: `node --test tests/serviceworker.test.js` → `# pass 9`, `# fail 0`.
Mutant: `CACHE` back to `'plaenicke-v6-9'` → `the cache name is ahead of the release on main` fails. Restore `'plaenicke-v6-10'`.

- [ ] **Step 7: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add service-worker.js tests/serviceworker.test.js && git commit -m "release: bump service-worker CACHE to plaenicke-v6-10" -m "Re-pins the test's CACHE_ON_MAIN to main's v6-9 so the guard can fail." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Merge, re-test on main, push**

```bash
git checkout main && git merge --no-ff home-screen-3c -m "merge: home screen stage 3c — tab bar and Calendar switcher" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>" && npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git push origin main && git checkout home-screen-3c
```

Expected: `# tests 1431`, `# fail 0`, `# cancelled 0`, the push succeeds. If the gate fails on main, do not push.

- [ ] **Step 9: Live check**

With the Monitor tool:

```bash
until curl -s https://ajaenicke518.github.io/plaenicke/service-worker.js | grep -q "plaenicke-v6-10"; do sleep 15; done; echo live
```

Then:

```bash
curl -s https://ajaenicke518.github.io/plaenicke/index.html | grep -c 'id="tab-calendar"'
```

Expected: `live`, then `1`.

- [ ] **Step 10: On-device check (Alex, iPhone home-screen app, light and dark)**

Ask Alex to open the app twice, then check:

- The bar sits above the home indicator, never under it, and its four tabs are easy to hit.
- Calendar shows Day / Week / Month / List; no 3-day. It reopens on the last one used; tapping a day in Week or Month opens Day.
- The last row of a long page scrolls clear of the bar.
- Delete something: the toast sits above the bar, its text and Undo fit, and Undo works.
- Settings and the item sheet open above the bar; the toast stays above both.
- The title at the top names the tab; on Today it is the Today heading.
- Dark mode.

If anything fails, stop: the fix becomes a new task with its own failing test.

---

# Stage 3d — revisit List after use (spec § 8, 3d)

### Task 14: record that List stays

Nothing is removed (spec § 4: "it is not retired in any stage"; § 8 3d: "Nothing is removed unless he then decides to").

**Files:**
- Modify: `docs/superpowers/specs/2026-10-20-plaenicke-home-screen-design.md` (append one paragraph after the "Stage 1 result" paragraph)

- [ ] **Step 1: Ask Alex, after he has used Today, whether List stays**

Send: "You've had Today and the tab bar for a while. List is still a segment in Calendar. Keep it as it is?" Record his answer word for word. If he wants it removed or changed, stop: that is a new spec change, not this task.

- [ ] **Step 2: Record it**

Append to the spec (replace `<date>` and `<his words>`):

```markdown
**Stage 3d result (<date>):** Alex, after using Today: "<his words>". List stays as Calendar's fourth segment; nothing is removed. Its 367-day feed expansion stays with it (§ 8 Later: measure render cost before any "render only the visible view" work).
```

- [ ] **Step 3: Commit**

```bash
npm test > "$TMPDIR/plaenicke-test.log" 2>&1; tail -8 "$TMPDIR/plaenicke-test.log"; grep -qx '# fail 0' "$TMPDIR/plaenicke-test.log" && grep -qx '# cancelled 0' "$TMPDIR/plaenicke-test.log" && git add docs/superpowers/specs/2026-10-20-plaenicke-home-screen-design.md && git commit -m "docs: stage 3d — List stays in Calendar's switcher" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Expected: `# tests 1431`. No merge is needed for a docs-only change; it goes out with the next release.

---

## Self-review against the spec

**Coverage of stage 3:**

| Spec item | Task |
|---|---|
| § 2.4 `recurring` set in `instancesForRange` from a per-feed set of repeating series; `FREQ=DAILY`/`WEEKLY` only; overrides belong; master-less overrides and yearly/monthly are one-offs; `ics.js` unchanged; no migration | 1 |
| § 2.4 heuristic only for a feed with no RRULE; same title + weekday + time on 3+ weeks; `guessedSeries`; Alex's approval (question 8) | 2 |
| End notes: the Canvas-deadline risk, resolved in the 3a plan | 2 (no length → never guessed), tested on instances and on the Settings line |
| § 2.3 one pure `buildToday` in `js/today.js`, from `liveItems()` and `instancesForRange(…, today, today+7, deviceTz)`, not `visibleItems` | 3, 4, 7 (fifth argument: see Architecture) |
| § 2.3 Overdue: every to-do type incl. `start`, no age limit; never ideas, done, events, feed instances; red / orange; ticked stays struck through until tomorrow (amendment 2026-10-22); oldest first, ticked last | 3, 4, 5, 9 |
| § 2.3 To do today: done stays struck through until tomorrow; `sortItemsByDate`, done last | 3, 4, 5, 7, 9 |
| § 2.3 Today's events: own `event`/`general` + every instance today; untimed first | 4 |
| § 2.3 Next 7 days: not done, scheduled, (today, today+7]; one-off instances only; by day; empty days hidden; one-offs once by `${feedId}:${uid}`, dropped if shown today | 3, 4 |
| § 2.3 no caps, no "+N more" | 4 |
| § 2.3 "in N" on the next event only, within 12 h (confirmed); "now" during it; past events greyed | 3, 4, 5, 9 |
| § 2.3 60 s tick updates only the relative-time node, while Today and the page are visible | 8 |
| § 2.3 empty days: the "Nothing due today. Next: … · Thu." line, 30-day look-ahead only then; "Nothing coming up." | 4, 5 |
| § 2.3 no duplicates, by construction; a test that every id appears at most once | 3, 4 |
| § 2.3 row tap → sheet; checkbox → `setDone` | 5, 7 |
| § 2.4 "Repeats weekly (guessed)" on rows and the sheet | 5, 6 |
| § 2.1–2.2 layout A; "Today" with the date under it, the gear on Today only; the `plaenicke` h1 replaced by tab titles | 7, 11 |
| § 4 tabs Today / Calendar / To-do / Ideas; switcher Day / Week / Month / List, 3-day hidden; last-used sub-view; tapping a day opens it; `focusOpener` learns Today | 7, 11 |
| § 4 geometry: bar 56 px + inset; body padding; toast `56px + 12px + inset`, `right: 88px`; layers; switcher fits 5 segments | 12 |
| § 5 type scale on the new screens only; 16 px rows; ≥ 44 px; one accent; dark mode | 9, 12 |
| § 6 feed URLs never rendered; no new item fields; sync untouched; ASSETS, CACHE, `CACHE_ON_MAIN` | 4, 7, 3, 5, 10, 13 |
| § 7 `tests/today.test.js` items (boundaries, types, orange vs red marking, done kept, ideas excluded, weekly hidden from Next 7 days, overrides, yearly/monthly/master-less, multi-day once, no caps, relative on next only, empty-day Next, every id once) | 3, 4 |
| § 7 `tests/feeds.test.js` items (`recurring` true/false; heuristic only with no RRULE; `guessedSeries`; shape asserts updated) | 1, 2 |
| § 7 `tests/apply.test.js` items for 3b/3c (tabs; the 60 s tick changes only the time text) | 7, 8, 11 |
| § 7 `tests/styles.test.js` items for 3b/3c (toast position, z-index order) | 9, 12 |
| § 7 on-device checklist items for stage 3 (typical day fits; dark mode; red/orange in both modes; classes absent from Next 7 days; toast clears the bar and fits Undo; bar clears the home indicator) | 10, 13 |
| § 8 3d revisit List; nothing removed | 14 |
| Punchlist carry-overs: (1) checkbox in a `[data-press]` row; (2) no id-selector row styling; (3) Canvas-deadline risk; (4) red vs orange on the phone | 5; 9; 2; 10 |

**Placeholders:** none in code. Task 14's `<date>` and `<his words>` are Alex's answer, recorded when he gives it.

**Names, checked across tasks:** `seriesIndex(events, targetTz)` (Tasks 1–2; Task 1 introduces it with one argument and Task 2 adds the zone); instance fields `recurring`, `guessedSeries` (1, 2, 4, 5, 6); `isTodoType` (3); `sectionOf`, `daysBetween`, `dayWord`, `relativeLabel`, `isPastEvent`, `NEXT_DAYS`, `RELATIVE_MAX_MIN`, `LOOKAHEAD_DAYS`, `buildToday` (3, 4, 7, 8); `renderTodayView(container, today, { onOpen, onToggleDone }) -> { relative }` (5, 7, 8); classes `today-row`, `today-open`, `today-check`, `today-text`, `today-age`, `today-time`, `today-rel`, `today-guess`, `today-label`, `today-day`, `today-empty`, `today-section`, `today-list`, `past`, `sheet-repeat`, `tab-bar`, `tab-title`, `cal-switch` (5, 6, 9, 11, 12); ids `today-view`, `today-body`, `today-date`, `show-today` (3b only), `tab-today`, `tab-calendar`, `tab-todo`, `tab-ideas`, `tab-title`, `cal-switch` (7, 11); cache names v6-8 → v6-9 (Task 10) → v6-10 (Task 13).

**Review Focus:** each of the five has a named test inside its owning task (Tasks 2, 3, 4).

**Spec gaps found while planning (for Alex):**
- ~~A ticked Overdue row vanishes with no way back on Today.~~ **Decided 2026-10-22: it stays struck through until tomorrow** (see the amendment at the top).
- **"Nothing due today. Next: …" shows above Next 7 days even when Next 7 days has rows,** and may name the first of them. That is what § 2.3 says ("If the first three are all empty, one line"). Confirm.
- **The `${feedId}:${uid}` "once" key drops a second occurrence of a monthly or yearly series (or one of its overrides) that falls in the same week.** § 2.3 names that key; only a monthly rule with several days a week can do it, and LMU Classes has none. **Fixed 2026-10-22 (Task 4 fix round 1):** the key is now `spanKey`, set by `instancesForRange` only where a uid is one plain event, so events that merely share a uid are never merged.
- **A "no class" one-off on a class day shows next to the class.** Alex's calendar has no EXDATE for those days (stage 1), so the feed says both. Hiding the class would need a title rule or the visibility work of sub-project 3.
- **§ 1's "Today fits an iPhone screen without scrolling" cannot hold below the add box** while the top add box stays (question 1) and the 3b view row sits above Today; it becomes checkable once stage 4 moves capture to the button. Task 10 asks Alex what he sees.
- **In light mode the accent (leather brown, the next event's "in N") and `--overdue-start` (orange) are close in hue** (Chrome render, 375 px). Added to Task 10's phone check.
- **3c reserves the capture button's 72 px row and the toast's 88 px right margin before stage 4 exists,** as § 4's geometry specifies; until then that space is empty.

**Not done in stage 3 (by design):**
- The capture button and box (stage 4); retiring `#mic-btn` (stage 4).
- 3-day (sub-project 2) and visibility controls (sub-project 3). The § 2.4 seam is in place: one predicate added to `buildToday`'s instance filter.
- Memoizing `seriesIndex` per cache entry: it runs on each `instancesForRange` call (five per render). A heuristic feed classifies with `icsDateToLocal` per event — 34 ms per 3000 events on the Mac for `feedShape` (punchlist). No live feed uses the heuristic; measure before optimizing (§ 8 Later).
