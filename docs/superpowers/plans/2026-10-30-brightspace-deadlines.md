# Brightspace Deadlines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Brightspace "Due" / "revisions due" calendar entries become ordinary plaenicke Deadline items (Overdue, checkbox, To-do page, synced), kept in step with the live feed, with Alex's own edits preserved.

**Architecture:** A pure module `js/deadlines.js` turns a feed's cached ParsedEvents into deadline records and plans create/update/remove against current items, tombstones and the previous cache. `app.js` (sole writer of `plaenicke.items`) runs the plan after every feed refresh and hides the feed's own copy of tracked deadlines. A synced, optional `trackDeadlines: { from }` field on the feed record turns it on, toggled in Settings.

**Tech Stack:** Vanilla ES modules, no build step. Tests: `node --test` with the repo's fakes (`tests/fake-dom.js`, `tests/fake-localstorage.js`).

**Spec:** `docs/superpowers/specs/2026-10-30-plaenicke-brightspace-deadlines-design.md` (read it first; this plan argues from it). Repo rules: `CLAUDE.md`.

## Global Constraints

- **Test gate:** `npm test` from the repo root (it recurses; never `node --test tests/`). Pass requires `# fail 0` AND `# cancelled 0`.
- **Single test file:** `node --test tests/<file>.test.js`; one test: add `--test-name-pattern="<name>"`.
- **Item ids:** `'bs-' + <VEVENT UID>`.
- **Conversion zone:** `America/Los_Angeles` on every device, never the device zone.
- **Trackable:** non-repeating event whose SUMMARY matches `/(?:^|\s-\s|\s)(?:revisions\s+)?due\s*$/i`, date ≥ `trackDeadlines.from`.
- **Removal guards:** every tracking feed refreshed OK; ≥ 1 event and ≥ 1 trackable event; at most **3** removals per round (more → held, `N deadlines disappeared from Brightspace — not removed` + **Remove them**); only items dated today or later; missing from every tracking feed.
- **Never in an import patch:** `done`, `notes`, `type`.
- **Edits stick:** a field is patched only when Brightspace changed it between the previous and current cache AND the item differs.
- **No `schemaVersion` change.** No new item field (`makeItem`'s 13-key whitelist untouched).
- **Settings copy:** `Track deadlines` / `Stop tracking deadlines`; `Tracking deadlines due from <Mon D>`; `Brightspace returned no deadlines — none removed`; `Remove them`.
- **Privacy:** never commit Alex's real feed. Fixtures are synthetic.
- **Logging:** never log a feed URL; log `err.name` only.
- **Mutation-test claims** (CLAUDE.md "Before you touch sync"): each guard's test must fail when the guard is deleted.

## Review Focus

1. **An item Alex deleted is in its 4 s Undo window (`pendingDeletes`) when a refresh lands** → the import must neither recreate, edit nor tombstone it. Test in Task 3 (planner, `pendingIds`) and Task 5 (wiring).
2. **Alex changed an imported deadline's type (e.g. to To-do)** → updates still apply to title/date/time and the type is kept. Test in Task 3.
3. **Same title in two courses (`HW 4.7 - Due` in MATH and PHYS)** → two items, distinguished by course prefix. Test in Task 2.
4. **Brightspace moves a time while Alex's item has an end time** → `endTime` is cleared with the time patch so the edit validates instead of throwing. Test in Task 3.
5. **The calendar is hidden on this device** → deadlines still import (hide is per-device display only). Test in Task 5.

---

### Task 1: Parser keeps LOCATION

**Files:**
- Modify: `js/ics.js:900-919` (`emptyRawEvent`, `collectProperty`), `js/ics.js:1003-1013` (`buildParsedEvent` return)
- Test: `tests/ics.test.js`

**Interfaces:**
- Produces: every ParsedEvent from `parseICS` has `location: string | null` (unescaped).

- [ ] **Step 1: Write the failing test** (append to `tests/ics.test.js`; `parseICS` is already imported there — confirm with `grep -n "parseICS" tests/ics.test.js | head -2`)

```js
test('parseICS keeps LOCATION, unescaped, and null when absent', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:1-1@brightspace.example',
    'SUMMARY:Essay - Due',
    'DTSTART:20261103T075900Z',
    'DTEND:20261103T075900Z',
    'LOCATION:Fall 2026 Sport\\, Race and Society (CLST-1300-01/02)',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:1-2@brightspace.example',
    'SUMMARY:No place',
    'DTSTART;VALUE=DATE:20261104',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const { events, skipped } = parseICS(ics);
  assert.equal(skipped.length, 0);
  assert.equal(events[0].location, 'Fall 2026 Sport, Race and Society (CLST-1300-01/02)');
  assert.equal(events[1].location, null);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `node --test --test-name-pattern="keeps LOCATION" tests/ics.test.js` → `undefined !== 'Fall 2026 Sport, …'`.

- [ ] **Step 3: Implement.** In `emptyRawEvent` add `location: null,` to the returned object. In `collectProperty` add a case:

```js
    case 'LOCATION': raw.location = unescapeText(value); break;
```

In `buildParsedEvent`'s return add `location: raw.location,` after `title`.

- [ ] **Step 4: Run** `node --test tests/ics.test.js` → all pass. Then `npm test` → `# fail 0`, `# cancelled 0` (some feed-cache fixtures compare ParsedEvents with `deepEqual`; if one fails only because of the new `location: null` key, add `location: null` to that expected object — do not loosen the assertion).

- [ ] **Step 5: Commit**

```bash
git add js/ics.js tests/ics.test.js
git commit -m "ics: keep LOCATION on ParsedEvents (Brightspace puts the course there)"
```

---

### Task 2: Deadline records from a feed (`js/deadlines.js`, part 1)

**Files:**
- Create: `js/deadlines.js`, `tests/deadlines.test.js`, `tests/fixtures/brightspace-shape.ics`
- Modify: `tests/fixtures/README.md` (add one entry)

**Interfaces:**
- Consumes: `parseICS`, `expandEvents` (`js/ics.js`); `addDays(iso, n)` (`js/timegrid.js`); ParsedEvent `location` (Task 1).
- Produces:
  - `DEADLINE_ZONE = 'America/Los_Angeles'`, `DEADLINE_ID_PREFIX = 'bs-'`, `MAX_AUTO_REMOVALS = 3`
  - `isTrackableTitle(title: string) → boolean`
  - `courseCode(location: string|null) → string|null` (`'MATH 234'`)
  - `deadlineTitle(title: string, location: string|null) → string`
  - `deriveDeadlines(events: ParsedEvent[], fromISO: string) → Map<id, { uid, title, date, time }>`

- [ ] **Step 1: Write the synthetic fixture** `tests/fixtures/brightspace-shape.ics` (invented content reproducing the measured shapes: UTC due times, DATE events, one RRULE, LOCATION course codes, `NNNN-NNN@brightspace.lmu.edu` UIDs):

```
BEGIN:VCALENDAR
PRODID:-//D2L//NONSGML v1.0//EN
VERSION:2.0
METHOD:PUBLISH
X-WR-CALNAME:All Courses - Example University
BEGIN:VEVENT
UID:1000-101@brightspace.lmu.edu
SUMMARY:HW 4.7 - Due
DTSTART:20261103T075900Z
DTEND:20261103T075900Z
LOCATION:Fall 2026 Calculus III (MATH-234-01/02)
SEQUENCE:2
END:VEVENT
BEGIN:VEVENT
UID:1000-102@brightspace.lmu.edu
SUMMARY:HW 4.7 - Due
DTSTART:20261031T065900Z
DTEND:20261031T065900Z
LOCATION:Fall 2026 Introduction to Electricity and Magnetism (PHYS-2100-02/03)
SEQUENCE:0
END:VEVENT
BEGIN:VEVENT
UID:1000-103@brightspace.lmu.edu
SUMMARY:IA 4.5 Revisions Due
DTSTART;VALUE=DATE:20261105
DTEND;VALUE=DATE:20261106
LOCATION:Fall 2026 Calculus III (MATH-234-01/02)
SEQUENCE:1
END:VEVENT
BEGIN:VEVENT
UID:1000-104@brightspace.lmu.edu
SUMMARY:PHYS 2100 3.1 Practice Solutions - Available
DTSTART:20261104T170000Z
DTEND:20261104T170000Z
LOCATION:Fall 2026 Introduction to Electricity and Magnetism (PHYS-2100-02/03)
SEQUENCE:0
END:VEVENT
BEGIN:VEVENT
UID:1000-105@brightspace.lmu.edu
SUMMARY:Standard Exam 5
DTSTART;VALUE=DATE:20261106
DTEND;VALUE=DATE:20261107
LOCATION:Fall 2026 Calculus III (MATH-234-01/02)
SEQUENCE:0
END:VEVENT
BEGIN:VEVENT
UID:1000-106@brightspace.lmu.edu
SUMMARY:Online Class
DTSTART;TZID=PST8PDT:20260902T100000
DTEND;TZID=PST8PDT:20260902T110000
RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261209T000000Z
LOCATION:https://example.webex.com/meet/someone (Example University)
SEQUENCE:0
END:VEVENT
BEGIN:VEVENT
UID:1000-107@brightspace.lmu.edu
SUMMARY:Reflection - Due
DTSTART:20261008T065900Z
DTEND:20261008T065900Z
LOCATION:Fall 2026 Sport\, Race and Society (CLST-1300-01/02)
SEQUENCE:0
END:VEVENT
BEGIN:VEVENT
UID:1000-108@brightspace.lmu.edu
SUMMARY:Survey - Due
DTSTART:20261110T075900Z
DTEND:20261110T075900Z
LOCATION:Calculus Knowledge Survey 2026-2027
SEQUENCE:0
END:VEVENT
END:VCALENDAR
```

Add to `tests/fixtures/README.md`, in its list of fixtures:

```
- `brightspace-shape.ics` — SYNTHETIC. Written by hand to reproduce the shapes measured in a real
  Brightspace (D2L) calendar feed on 2026-10-27 (UTC due times, DATE events, one RRULE, the course
  in LOCATION, NNNN-NNN@host UIDs). No real course, person or link. The real feed is never committed.
```

- [ ] **Step 2: Write the failing tests** `tests/deadlines.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseICS } from '../js/ics.js';
import {
  isTrackableTitle, courseCode, deadlineTitle, deriveDeadlines, DEADLINE_ID_PREFIX,
} from '../js/deadlines.js';

const FIXTURE = parseICS(readFileSync(new URL('./fixtures/brightspace-shape.ics', import.meta.url), 'utf8'));

test('fixture check: the synthetic feed parses with nothing skipped', () => {
  assert.equal(FIXTURE.skipped.length, 0);
  assert.equal(FIXTURE.events.length, 8);
});

test('isTrackableTitle: Due and revisions due, any case; nothing else', () => {
  for (const t of ['HW 4.7 - Due', 'TEST #2 - Due', 'IA 4.5 revisions due', 'IA 4.3 Revisions Due', 'Due', 'Essay due ']) {
    assert.equal(isTrackableTitle(t), true, t);
  }
  for (const t of ['PHYS 2100 3.1 Practice Solutions - Available', 'Standard Exam 5', 'Online Class', 'Overdue', 'Due dates explained', '']) {
    assert.equal(isTrackableTitle(t), false, t);
  }
});

test('courseCode: letters and number from the first (XXXX-NNNN…) group', () => {
  assert.equal(courseCode('Fall 2026 Calculus III (MATH-234-01/02)'), 'MATH 234');
  assert.equal(courseCode('Fall 2026 Introduction to Electricity and Magnetism (PHYS-2100-02/03)'), 'PHYS 2100');
  assert.equal(courseCode('Fall 2026 Design and Manufacturing (MECH-2100)'), 'MECH 2100');
  assert.equal(courseCode('University Hall 1000 (Fall 2026 Sport, Race and Society (CLST-1300-01/02))'), 'CLST 1300');
  assert.equal(courseCode('Calculus Knowledge Survey 2026-2027'), null);
  assert.equal(courseCode(null), null);
});

test('deadlineTitle: course prefix, trailing "- Due" dropped, "revisions due" kept', () => {
  assert.equal(deadlineTitle('HW 4.7 - Due', 'Fall 2026 Calculus III (MATH-234-01/02)'), 'MATH 234 · HW 4.7');
  assert.equal(deadlineTitle('IA 4.5 Revisions Due', 'Fall 2026 Calculus III (MATH-234-01/02)'), 'MATH 234 · IA 4.5 Revisions Due');
  assert.equal(deadlineTitle('Survey - Due', 'Calculus Knowledge Survey 2026-2027'), 'Survey');
  assert.equal(deadlineTitle('Due', null), 'Due');
});

test('deriveDeadlines: trackable singles from the start date, in LA time, keyed bs-<uid>', () => {
  const got = deriveDeadlines(FIXTURE.events, '2026-10-15');
  assert.deepEqual([...got.keys()].sort(), [
    'bs-1000-101@brightspace.lmu.edu', // MATH HW, after the 2026-11-01 DST change
    'bs-1000-102@brightspace.lmu.edu', // PHYS HW, same title, before it
    'bs-1000-103@brightspace.lmu.edu', // all-day revisions due
    'bs-1000-108@brightspace.lmu.edu', // no course code
  ]);
  // 1000-107 is before the start date; 104 Available, 105 exam, 106 repeating.
  assert.deepEqual(got.get('bs-1000-101@brightspace.lmu.edu'),
    { uid: '1000-101@brightspace.lmu.edu', title: 'MATH 234 · HW 4.7', date: '2026-11-02', time: '23:59' });
  assert.deepEqual(got.get('bs-1000-102@brightspace.lmu.edu'),
    { uid: '1000-102@brightspace.lmu.edu', title: 'PHYS 2100 · HW 4.7', date: '2026-10-30', time: '23:59' });
  assert.deepEqual(got.get('bs-1000-103@brightspace.lmu.edu'),
    { uid: '1000-103@brightspace.lmu.edu', title: 'MATH 234 · IA 4.5 Revisions Due', date: '2026-11-05', time: null });
  assert.equal(got.get('bs-1000-108@brightspace.lmu.edu').title, 'Survey');
});

test('deriveDeadlines: the start date is inclusive and an empty or missing list gives nothing', () => {
  assert.ok(deriveDeadlines(FIXTURE.events, '2026-11-05').has(`${DEADLINE_ID_PREFIX}1000-103@brightspace.lmu.edu`));
  assert.equal(deriveDeadlines(FIXTURE.events, '2026-11-06').has(`${DEADLINE_ID_PREFIX}1000-103@brightspace.lmu.edu`), false);
  assert.equal(deriveDeadlines([], '2026-10-01').size, 0);
  assert.equal(deriveDeadlines(undefined, '2026-10-01').size, 0);
});
```

- [ ] **Step 3: Run, expect FAIL** — `node --test tests/deadlines.test.js` → `Cannot find module '../js/deadlines.js'`.

- [ ] **Step 4: Implement** `js/deadlines.js`:

```js
// deadlines.js — Brightspace deadlines as own Deadline items (spec:
// docs/superpowers/specs/2026-10-30-plaenicke-brightspace-deadlines-design.md).
//
// PURE: no storage, no DOM, no clock. app.js (the only writer of
// plaenicke.items) feeds it state and applies what it returns.

import { expandEvents } from './ics.js';
import { addDays } from './timegrid.js';

// Every device converts in LMU's zone (spec § 3.4), so two devices always
// derive the same date and time and never overwrite each other.
export const DEADLINE_ZONE = 'America/Los_Angeles';
export const DEADLINE_ID_PREFIX = 'bs-';
export const MAX_AUTO_REMOVALS = 3;
// How far past the start date a deadline is looked for.
const HORIZON_DAYS = 400;

const TRACKABLE = /(?:^|\s-\s|\s)(?:revisions\s+)?due\s*$/i;
const COURSE = /\(([A-Z]{2,5})-(\d{3,4}[A-Z]?)(?=[-/)\s])/;
const TRAILING_DUE = /\s*-\s*due\s*$/i;

export function isTrackableTitle(title) {
  return typeof title === 'string' && TRACKABLE.test(title.trim());
}

export function courseCode(location) {
  if (typeof location !== 'string') return null;
  const m = location.match(COURSE);
  return m ? `${m[1]} ${m[2]}` : null;
}

export function deadlineTitle(title, location) {
  const trimmed = title.trim();
  const base = trimmed.replace(TRAILING_DUE, '').trim() || trimmed;
  const code = courseCode(location);
  return code ? `${code} · ${base}` : base;
}

// deriveDeadlines: one feed's cached ParsedEvents -> Map of item id to the
// fields the import owns. Repeating events and overrides are never a single
// deadline. A multi-day instance contributes its first day only.
export function deriveDeadlines(events, fromISO) {
  const out = new Map();
  if (!Array.isArray(events)) return out;
  const singles = events.filter((ev) => !ev.rrule && !ev.recurrenceId && isTrackableTitle(ev.title));
  if (singles.length === 0) return out;
  const byUid = new Map(singles.map((ev) => [ev.uid, ev]));
  for (const inst of expandEvents(singles, fromISO, addDays(fromISO, HORIZON_DAYS), DEADLINE_ZONE)) {
    const id = DEADLINE_ID_PREFIX + inst.uid;
    if (out.has(id)) continue;
    out.set(id, {
      uid: inst.uid,
      title: deadlineTitle(inst.title, byUid.get(inst.uid).location ?? null),
      date: inst.date,
      time: inst.time,
    });
  }
  return out;
}
```

(`addDays` in `js/timegrid.js` takes and returns `'YYYY-MM-DD'`; confirm with `grep -n "export function addDays" -A6 js/timegrid.js` before relying on it.)

- [ ] **Step 5: Run** `node --test tests/deadlines.test.js` → all pass. Mutation check: delete `!ev.rrule &&` → the deriveDeadlines key test must fail; restore.

- [ ] **Step 6: Commit**

```bash
git add js/deadlines.js tests/deadlines.test.js tests/fixtures/brightspace-shape.ics tests/fixtures/README.md
git commit -m "deadlines: derive Brightspace deadline records from a feed (LA zone, course prefix)"
```

---

### Task 3: The import planner and the hidden-copy filter (`js/deadlines.js`, part 2)

**Files:**
- Modify: `js/deadlines.js`
- Test: `tests/deadlines.test.js`

**Interfaces:**
- Consumes: Task 2's exports.
- Produces:
  - `planDeadlineImport({ feeds, prevCache, cache, items, tombstones, failedFeedIds, pendingIds, todayISO }) → { create: [{ id, title, date, time }], update: [{ id, patch }], remove: [id], held: [id], note: string|null }`
    - `feeds`: feed records; tracking = `f.trackDeadlines && typeof f.trackDeadlines.from === 'string'`
    - `prevCache` / `cache`: feed cache objects `{ [feedId]: { fetchedAt, events, skipped, quotaDropped? } }`
    - `failedFeedIds`, `pendingIds`: `Set<string>`
  - `trackedCopyIds(items, tombstones) → Set<string>` — live `bs-` item ids ∪ `bs-` item tombstone ids
  - `hideTrackedCopies(instances, feeds, hiddenIds: Set) → instances` — drops an instance of a tracking feed whose `bs-` + uid is in `hiddenIds`

- [ ] **Step 1: Write the failing tests** (append to `tests/deadlines.test.js`; add `planDeadlineImport, trackedCopyIds, hideTrackedCopies` to the import from `../js/deadlines.js`):

```js
const FROM = '2026-10-15';
const feed = (o = {}) => ({ id: 'f1', url: 'https://x/f.ics', name: 'BS', color: 'c', hidden: false,
  updatedAt: '2026-10-15T00:00:00.000Z', trackDeadlines: { from: FROM }, ...o });
const entry = (events) => ({ fetchedAt: '2026-10-30T12:00:00.000Z', events, skipped: [] });
const ev = (uid, title, value, o = {}) => ({ uid, title, form: 'UTC', dtstart: { value, tzid: null },
  dtend: null, duration: null, rrule: null, exdates: [], recurrenceId: null,
  location: 'Fall 2026 Calculus III (MATH-234-01/02)', ...o });
const own = (id, o = {}) => ({ id, title: 'MATH 234 · HW 1', date: '2026-11-02', time: '23:59', endTime: null,
  createdAt: '2026-10-20', updatedAt: '2026-10-20T00:00:00.000Z', type: 'due', project: null, subject: null,
  category: null, done: false, notes: null, ...o });
const plan = (o) => planDeadlineImport({ feeds: [feed()], prevCache: {}, cache: {}, items: [], tombstones: [],
  failedFeedIds: new Set(), pendingIds: new Set(), todayISO: '2026-10-30', ...o });
const HW1 = ev('u1', 'HW 1 - Due', '20261103T075900Z'); // 2026-11-02 23:59 LA

test('plan: a new trackable event is created as a Deadline record', () => {
  const p = plan({ cache: { f1: entry([HW1]) } });
  assert.deepEqual(p.create, [{ id: 'bs-u1', title: 'MATH 234 · HW 1', date: '2026-11-02', time: '23:59' }]);
  assert.deepEqual([p.update, p.remove, p.held, p.note], [[], [], [], null]);
});

test('plan: no tracking feed, no work (tracking off keeps items: nothing is removed)', () => {
  const p = plan({ feeds: [feed({ trackDeadlines: null })], cache: { f1: entry([]) }, items: [own('bs-u1')] });
  assert.deepEqual([p.create, p.update, p.remove, p.held], [[], [], [], []]);
});

test('plan: a tombstoned or pending-delete id is never re-created or edited', () => {
  const moved = ev('u1', 'HW 1 - Due', '20261104T075900Z');
  const tomb = plan({ cache: { f1: entry([HW1]) }, tombstones: [{ id: 'bs-u1', kind: 'item', deletedAt: '2026-10-29T00:00:00.000Z' }] });
  assert.deepEqual(tomb.create, []);
  const pend = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([moved]) }, items: [own('bs-u1')], pendingIds: new Set(['bs-u1']) });
  assert.deepEqual([pend.create, pend.update, pend.remove], [[], [], []]);
});

test('plan: Brightspace moved the due date -> only date patched; done/notes/type never in a patch', () => {
  const moved = ev('u1', 'HW 1 - Due', '20261104T075900Z'); // 2026-11-03 23:59
  const p = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([moved]) },
    items: [own('bs-u1', { done: true, notes: 'mine', type: 'task' })] });
  assert.deepEqual(p.update, [{ id: 'bs-u1', patch: { date: '2026-11-03' } }]);
});

test('plan: edits stick — item differs but Brightspace did not change -> no patch', () => {
  const p = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([HW1]) },
    items: [own('bs-u1', { title: 'Calc HW 1', date: '2026-11-01' })] });
  assert.deepEqual(p.update, []);
});

test('plan: Brightspace changes only the date -> Alex\'s custom title is kept', () => {
  const moved = ev('u1', 'HW 1 - Due', '20261104T075900Z');
  const p = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([moved]) },
    items: [own('bs-u1', { title: 'Calc HW 1' })] });
  assert.deepEqual(p.update, [{ id: 'bs-u1', patch: { date: '2026-11-03' } }]);
});

test('plan: no previous cache entry -> no patch (the device that saw the change applies it)', () => {
  const moved = ev('u1', 'HW 1 - Due', '20261104T075900Z');
  const p = plan({ cache: { f1: entry([moved]) }, items: [own('bs-u1')] });
  assert.deepEqual(p.update, []);
});

test('plan: a time change clears an end time Alex set, so the edit validates', () => {
  const earlier = ev('u1', 'HW 1 - Due', '20261102T190000Z'); // 2026-11-02 11:00
  const p = plan({ prevCache: { f1: entry([HW1]) }, cache: { f1: entry([earlier]) },
    items: [own('bs-u1', { time: '23:00', endTime: '23:30' })] });
  assert.deepEqual(p.update, [{ id: 'bs-u1', patch: { time: '11:00', endTime: null } }]);
});

test('plan: a deadline gone from the feed is removed (future only, at most 3)', () => {
  const p = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), own('bs-gone', { date: '2026-11-05' })] });
  assert.deepEqual(p.remove, ['bs-gone']);
});

test('plan: past deadlines are never auto-removed', () => {
  const p = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), own('bs-old', { date: '2026-10-29' })] });
  assert.deepEqual(p.remove, []);
});

test('plan: a failed or quota-dropped refresh removes nothing', () => {
  const items = [own('bs-u1'), own('bs-gone', { date: '2026-11-05' })];
  assert.deepEqual(plan({ cache: { f1: entry([HW1]) }, items, failedFeedIds: new Set(['f1']) }).remove, []);
  assert.deepEqual(plan({ cache: { f1: { ...entry([HW1]), quotaDropped: true } }, items }).remove, []);
  assert.deepEqual(plan({ cache: {}, items }).remove, []);
});

test('plan: an empty feed, or one with no trackable event, removes nothing and says so', () => {
  const items = [own('bs-a', { date: '2026-11-05' })];
  const empty = plan({ cache: { f1: entry([]) }, items });
  assert.deepEqual(empty.remove, []);
  assert.equal(empty.note, 'Brightspace returned no deadlines — none removed');
  const noneTrackable = plan({ cache: { f1: entry([ev('x', 'Standard Exam 5', '20261106T170000Z')]) }, items });
  assert.deepEqual(noneTrackable.remove, []);
  assert.equal(noneTrackable.note, 'Brightspace returned no deadlines — none removed');
});

test('plan: more than 3 removals are held, not applied', () => {
  const gone = ['a', 'b', 'c', 'd'].map((k) => own(`bs-${k}`, { date: '2026-11-05' }));
  const p = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), ...gone] });
  assert.deepEqual(p.remove, []);
  assert.deepEqual(p.held, ['bs-a', 'bs-b', 'bs-c', 'bs-d']);
  assert.equal(p.note, '4 deadlines disappeared from Brightspace — not removed');
  const three = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), ...gone.slice(0, 3)] });
  assert.deepEqual(three.remove, ['bs-a', 'bs-b', 'bs-c']);
});

test('plan: with two tracking feeds, an id listed by either is kept', () => {
  const p = plan({
    feeds: [feed(), feed({ id: 'f2' })],
    cache: { f1: entry([HW1]), f2: entry([ev('u2', 'HW 2 - Due', '20261105T075900Z')]) },
    items: [own('bs-u1'), own('bs-u2', { date: '2026-11-04' })],
  });
  assert.deepEqual(p.remove, []);
});

test('plan: own items without the bs- prefix are never touched', () => {
  const p = plan({ cache: { f1: entry([HW1]) }, items: [own('bs-u1'), own('typed-1', { date: '2026-11-05' })] });
  assert.deepEqual(p.remove, []);
});

test('trackedCopyIds + hideTrackedCopies: a tracked deadline\'s feed copy is dropped, others kept', () => {
  const hidden = trackedCopyIds([own('bs-u1'), own('typed-1')], [{ id: 'bs-u9', kind: 'item', deletedAt: 'x' }, { id: 'f', kind: 'feed', deletedAt: 'x' }]);
  assert.deepEqual([...hidden].sort(), ['bs-u1', 'bs-u9']);
  const inst = (feedId, uid) => ({ id: `${feedId}:${uid}`, feedId, uid });
  const out = hideTrackedCopies(
    [inst('f1', 'u1'), inst('f1', 'u9'), inst('f1', 'u2'), inst('f3', 'u1')],
    [feed(), feed({ id: 'f3', trackDeadlines: null })],
    hidden,
  );
  assert.deepEqual(out.map((i) => i.id), ['f1:u2', 'f3:u1']);
});
```

- [ ] **Step 2: Run, expect FAIL** — `node --test tests/deadlines.test.js` → `planDeadlineImport is not a function` (or an import SyntaxError naming it).

- [ ] **Step 3: Implement** (append to `js/deadlines.js`):

```js
const isTracking = (f) => Boolean(f && f.trackDeadlines && typeof f.trackDeadlines.from === 'string');
const NO_DEADLINES = 'Brightspace returned no deadlines — none removed';
const OWNED_FIELDS = ['title', 'date', 'time'];

// planDeadlineImport: what app.js must write after a feed refresh (spec § 3.5,
// § 4). Never reads the clock, storage or the device zone.
export function planDeadlineImport({ feeds, prevCache, cache, items, tombstones, failedFeedIds, pendingIds, todayISO }) {
  const plan = { create: [], update: [], remove: [], held: [], note: null };
  const tracking = feeds.filter(isTracking);
  if (tracking.length === 0) return plan;

  const dead = new Set(tombstones.filter((t) => t.kind === 'item').map((t) => t.id));
  const byId = new Map(items.map((it) => [it.id, it]));
  const current = new Map();
  let allOk = true;
  let anyEvents = false;

  for (const feed of tracking) {
    const entry = cache[feed.id];
    if (!entry || !Array.isArray(entry.events) || entry.quotaDropped || failedFeedIds.has(feed.id)) {
      allOk = false;
      continue;
    }
    if (entry.events.length > 0) anyEvents = true;
    const prevEntry = prevCache[feed.id];
    const prev = prevEntry && Array.isArray(prevEntry.events) && !prevEntry.quotaDropped
      ? deriveDeadlines(prevEntry.events, feed.trackDeadlines.from)
      : new Map();
    for (const [id, d] of deriveDeadlines(entry.events, feed.trackDeadlines.from)) {
      if (current.has(id)) continue;
      current.set(id, d);
      if (pendingIds.has(id) || dead.has(id)) continue;
      const item = byId.get(id);
      if (!item) {
        plan.create.push({ id, title: d.title, date: d.date, time: d.time });
        continue;
      }
      const was = prev.get(id);
      if (!was) continue; // no record of Brightspace's last value: leave the item alone
      const patch = {};
      for (const k of OWNED_FIELDS) if (was[k] !== d[k] && item[k] !== d[k]) patch[k] = d[k];
      if ('time' in patch && item.endTime) patch.endTime = null;
      if (Object.keys(patch).length > 0) plan.update.push({ id, patch });
    }
  }

  const missing = items
    .filter((it) => it.id.startsWith(DEADLINE_ID_PREFIX) && !current.has(it.id) && !pendingIds.has(it.id)
      && typeof it.date === 'string' && it.date >= todayISO)
    .map((it) => it.id);
  if (missing.length === 0 || !allOk) return plan;
  if (!anyEvents || current.size === 0) {
    plan.note = NO_DEADLINES;
    return plan;
  }
  if (missing.length > MAX_AUTO_REMOVALS) {
    plan.held = missing;
    plan.note = `${missing.length} deadlines disappeared from Brightspace — not removed`;
    return plan;
  }
  plan.remove = missing;
  return plan;
}

export function trackedCopyIds(items, tombstones) {
  const ids = new Set();
  for (const it of items) if (it.id.startsWith(DEADLINE_ID_PREFIX)) ids.add(it.id);
  for (const t of tombstones) if (t.kind === 'item' && t.id.startsWith(DEADLINE_ID_PREFIX)) ids.add(t.id);
  return ids;
}

export function hideTrackedCopies(instances, feeds, hiddenIds) {
  const trackingIds = new Set(feeds.filter(isTracking).map((f) => f.id));
  if (trackingIds.size === 0) return instances;
  return instances.filter((inst) => !(trackingIds.has(inst.feedId) && hiddenIds.has(DEADLINE_ID_PREFIX + inst.uid)));
}
```

- [ ] **Step 4: Run** `node --test tests/deadlines.test.js` → all pass. **Mutation checks** (each must turn a test red; restore after each): delete `|| !allOk`; change `> MAX_AUTO_REMOVALS` to `> 99`; delete `&& it.date >= todayISO`; delete `if (!was) continue;`; delete `was[k] !== d[k] &&`; delete `|| dead.has(id)`; delete `pendingIds.has(id) ||` (the first one). Record which test failed for each in the commit message body.

- [ ] **Step 5: Commit**

```bash
git add js/deadlines.js tests/deadlines.test.js
git commit -m "deadlines: import planner with removal guards; hide tracked feed copies"
```

---

### Task 4: `trackDeadlines` survives storage and sync

**Files:**
- Test: `tests/storage.test.js`, `tests/merge.test.js`
- Modify: none expected (characterization of `js/storage.js:106-122` and `js/merge.js:316-322`). If a test fails, fix the code it names, not the test.

**Interfaces:**
- Produces: guarantee that a feed's `trackDeadlines` field round-trips through `saveFeeds`/`loadFeeds`, `toWire`, and `merge`.

- [ ] **Step 1: Write the tests.** In `tests/storage.test.js` (check its existing imports first: `grep -n "^import" tests/storage.test.js`):

```js
test('feeds: an optional trackDeadlines field round-trips through save/load', () => {
  installFakeLocalStorage();
  const f = { id: 'f1', url: 'https://x/f.ics', name: 'BS', color: 'c', hidden: false,
    updatedAt: '2026-10-30T00:00:00.000Z', trackDeadlines: { from: '2026-10-30' } };
  saveFeeds([f]);
  assert.deepEqual(loadFeeds()[0].trackDeadlines, { from: '2026-10-30' });
});
```

In `tests/merge.test.js` (check imports; it already imports `merge`, `toWire`, `SCHEMA_VERSION` or similar — add what is missing):

```js
test('merge/toWire: a feed\'s trackDeadlines rides through; the newer feed record wins', () => {
  const base = { id: 'f1', url: 'https://x/f.ics', name: 'BS', color: 'c', hidden: false };
  const off = { ...base, updatedAt: '2026-10-29T00:00:00.000Z' };
  const on = { ...base, updatedAt: '2026-10-30T00:00:00.000Z', trackDeadlines: { from: '2026-10-30' } };
  const st = (feeds) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds, tombstones: [] });
  assert.deepEqual(toWire(st([on])).feeds[0].trackDeadlines, { from: '2026-10-30' });
  const merged = merge(st([off]), st([on]), new Date('2026-10-30T12:00:00.000Z'));
  assert.deepEqual(merged.feeds.find((f) => f.id === 'f1').trackDeadlines, { from: '2026-10-30' });
});
```

- [ ] **Step 2: Run** `node --test tests/storage.test.js tests/merge.test.js`. Expected: PASS (the spec's § 3.1 claim). These are characterization tests: to prove they bite, temporarily change `deserializeFeeds`'s `.map` to return `{ id: f.id, url: f.url, name: f.name, color: f.color, hidden: f.hidden, updatedAt: f.updatedAt }` → the storage test must fail; restore.

- [ ] **Step 3: Commit**

```bash
git add tests/storage.test.js tests/merge.test.js
git commit -m "tests: pin that a feed's trackDeadlines survives storage, toWire and merge"
```

---

### Task 5: Wire the import into `app.js`

**Files:**
- Modify: `js/app.js` — imports (`:1-42`), `visibleItems` (`:193-198`), `renderWeek` (`:1049`), `renderToday` (`:1144`, `:1148`), `initSettings({...})` (`:234-260`), `backgroundSyncFeeds`'s `settle` (`:1405-1420`); new functions placed after `handleDelete` (`:~550`)
- Modify: `CLAUDE.md` ("Invariants" — one bullet)
- Test: `tests/apply.test.js`

**Interfaces:**
- Consumes: `planDeadlineImport`, `trackedCopyIds`, `hideTrackedCopies`, `DEADLINE_ID_PREFIX` (Tasks 2–3); `loadTombstones` (`js/storage.js:166`).
- Produces (for Task 6): `initSettings` receives `deadlines: { status: () => ({ note: string|null, held: string[] }), removeHeld: () => void }`.

- [ ] **Step 1: Write the failing wiring tests** (append to `tests/apply.test.js`; ids prefixed `bsD-`; it already imports `saveFeeds`, `loadItems`, `loadTombstones`, `reloadFromStorage`, `resume`, `drainUntil`, `todoList`, `checkboxFor`, `click` — verify with grep and add any missing import):

```js
// --- Brightspace deadlines (spec 2026-10-30) -------------------------------
// Ids prefixed bsD-. The module is imported once for the file: every test puts
// feeds, cache and items back.
const bsFeed = (o = {}) => ({ id: 'bsD-feed', url: 'https://example.com/bsD.ics', name: 'Brightspace',
  color: 'var(--feed-palette-1)', hidden: false, updatedAt: '2026-10-01T00:00:00.000Z',
  trackDeadlines: { from: localISO(new Date()) }, ...o });
// A minimal Brightspace-shaped feed: all-day due entries with a course LOCATION.
function bsIcs(rows) {
  const lines = ['BEGIN:VCALENDAR'];
  for (const r of rows) {
    lines.push('BEGIN:VEVENT', `UID:${r.uid}`, `SUMMARY:${r.summary}`,
      `DTSTART;VALUE=DATE:${r.date.replace(/-/g, '')}`, `LOCATION:${r.location || 'Fall 2026 Calculus III (MATH-234-01/02)'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
async function refreshWith(ics) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/feed?url=')
    ? { ok: true, status: 200, text: async () => ics }
    : original(url));
  try {
    // Make the cache stale so the resume refetches.
    const cache = JSON.parse(localStorage.getItem('plaenicke.feedCache') || '{}');
    for (const k of Object.keys(cache)) cache[k].fetchedAt = '2000-01-01T00:00:00.000Z';
    localStorage.setItem('plaenicke.feedCache', JSON.stringify(cache));
    reloadFromStorage('plaenicke.feeds');
    resume();
    await drainUntil(() => JSON.parse(localStorage.getItem('plaenicke.feedCache') || '{}')['bsD-feed']?.fetchedAt > '2001');
  } finally {
    globalThis.fetch = original;
  }
}
function bsCleanup() {
  saveFeeds([]);
  localStorage.removeItem('plaenicke.feedCache');
  saveItems(loadItems().filter((it) => !it.id.startsWith('bs-')));
  reloadFromStorage('plaenicke.feeds');
  reloadFromStorage('plaenicke.items');
}

test('bsD: a refresh imports Due items as Deadlines; Available stays calendar-only', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  try {
    saveFeeds([bsFeed()]);
    await refreshWith(bsIcs([
      { uid: 'bsD-1', summary: 'HW 1 - Due', date: far(1) },
      { uid: 'bsD-2', summary: 'Solutions - Available', date: far(1) },
    ]));
    await drainUntil(() => loadItems().some((it) => it.id === 'bs-bsD-1'));
    const it = loadItems().find((x) => x.id === 'bs-bsD-1');
    assert.equal(it.type, 'due');
    assert.equal(it.title, 'MATH 234 · HW 1');
    assert.equal(loadItems().some((x) => x.id === 'bs-bsD-2'), false);
  } finally { bsCleanup(); }
});

test('bsD: a moved due date updates the date and keeps the tick', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  try {
    saveFeeds([bsFeed()]);
    await refreshWith(bsIcs([{ uid: 'bsD-3', summary: 'HW 3 - Due', date: far(2) }]));
    await drainUntil(() => loadItems().some((it) => it.id === 'bs-bsD-3'));
    saveItems(loadItems().map((it) => (it.id === 'bs-bsD-3' ? { ...it, done: true } : it)));
    reloadFromStorage('plaenicke.items');
    await refreshWith(bsIcs([{ uid: 'bsD-3', summary: 'HW 3 - Due', date: far(4) }]));
    await drainUntil(() => loadItems().find((it) => it.id === 'bs-bsD-3')?.date === far(4));
    assert.equal(loadItems().find((it) => it.id === 'bs-bsD-3').done, true);
  } finally { bsCleanup(); }
});

test('bsD: a renamed item keeps Alex\'s title across refreshes', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  try {
    saveFeeds([bsFeed()]);
    const ics = bsIcs([{ uid: 'bsD-4', summary: 'HW 4 - Due', date: far(2) }]);
    await refreshWith(ics);
    await drainUntil(() => loadItems().some((it) => it.id === 'bs-bsD-4'));
    saveItems(loadItems().map((it) => (it.id === 'bs-bsD-4' ? { ...it, title: 'Calc HW 4' } : it)));
    reloadFromStorage('plaenicke.items');
    await refreshWith(ics);
    assert.equal(loadItems().find((it) => it.id === 'bs-bsD-4').title, 'Calc HW 4');
  } finally { bsCleanup(); }
});

test('bsD: a deadline deleted in plaenicke is not re-created', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  try {
    saveFeeds([bsFeed()]);
    const ics = bsIcs([{ uid: 'bsD-5', summary: 'HW 5 - Due', date: far(2) }]);
    await refreshWith(ics);
    await drainUntil(() => loadItems().some((it) => it.id === 'bs-bsD-5'));
    saveItems(loadItems().filter((it) => it.id !== 'bs-bsD-5'));
    saveTombstones([...loadTombstones(), { id: 'bs-bsD-5', kind: 'item', deletedAt: new Date(Date.now() + 1000).toISOString() }]);
    reloadFromStorage('plaenicke.items');
    await refreshWith(ics);
    assert.equal(loadItems().some((it) => it.id === 'bs-bsD-5'), false);
  } finally { bsCleanup(); saveTombstones(loadTombstones().filter((t) => t.id !== 'bs-bsD-5')); }
});

test('bsD: tracking off keeps existing items and imports nothing new', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  try {
    saveFeeds([bsFeed()]);
    await refreshWith(bsIcs([{ uid: 'bsD-6', summary: 'HW 6 - Due', date: far(2) }]));
    await drainUntil(() => loadItems().some((it) => it.id === 'bs-bsD-6'));
    saveFeeds([bsFeed({ trackDeadlines: null, updatedAt: '2026-10-02T00:00:00.000Z' })]);
    await refreshWith(bsIcs([{ uid: 'bsD-7', summary: 'HW 7 - Due', date: far(2) }]));
    assert.equal(loadItems().some((it) => it.id === 'bs-bsD-6'), true, 'kept');
    assert.equal(loadItems().some((it) => it.id === 'bs-bsD-7'), false, 'not imported');
  } finally { bsCleanup(); }
});

test('bsD: a calendar hidden on this device still imports its deadlines', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  try {
    saveFeeds([bsFeed({ hidden: true })]);
    await refreshWith(bsIcs([{ uid: 'bsD-8', summary: 'HW 8 - Due', date: far(2) }]));
    await drainUntil(() => loadItems().some((it) => it.id === 'bs-bsD-8'));
  } finally { bsCleanup(); }
});
```

If the hidden-calendar test fails because the background refresh does not fetch a hidden calendar at all (check `syncStale` in `js/feeds.js:314-331`), **stop and report**: whether a hidden tracked calendar should still be fetched is a spec question for Alex, not an implementation choice.

Also add one test that the feed copy is hidden: after importing `bsD-9` dated `far(0)`... use the Day page helpers already in the file (`dayOf(dateISO)` returns the Day page rows for a date — confirm its return shape with `sed -n 656,692p tests/apply.test.js`) and assert the title `HW 9 - Due` (the feed copy) is absent while `MATH 234 · HW 9` (the item) is present:

```js
test('bsD: the feed\'s own copy of a tracked deadline is hidden; the Deadline shows once', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  try {
    saveFeeds([bsFeed()]);
    await refreshWith(bsIcs([{ uid: 'bsD-9', summary: 'HW 9 - Due', date: far(3) }]));
    await drainUntil(() => loadItems().some((it) => it.id === 'bs-bsD-9'));
    const text = stringsOf(dayOf(far(3))).join(' | ');
    assert.match(text, /MATH 234 · HW 9/);
    assert.doesNotMatch(text, /HW 9 - Due/);
  } finally { bsCleanup(); }
});
```

(`far(n)` and `FAR` are defined at `tests/apply.test.js:633`; `far` dates are in the future, so `from` = today keeps them trackable. If `dayOf` does not navigate the Day page, use the same navigation the existing "open: tapping an item on the Day page" test uses.)

- [ ] **Step 2: Run, expect FAIL** — `node --test --test-name-pattern="bsD:" tests/apply.test.js` → the `drainUntil` for `bs-bsD-1` times out (no import yet).

- [ ] **Step 3: Implement in `js/app.js`.**

Imports: add `loadTombstones` to the `./storage.js` import (`:2`), and add:

```js
import { planDeadlineImport, trackedCopyIds, hideTrackedCopies } from './deadlines.js';
```

A feed-instance helper next to `visibleItems` (`:193`), and use it at all four `instancesForRange(` call sites (`:196`, `:1049`, `:1144`, `:1148`) — replace `instancesForRange(feeds, feedCache, A, B, deviceTz)` with `feedInstances(A, B)`:

```js
// feedInstances: every feed instance for [start, end], minus the feed's own
// copy of a tracked Brightspace deadline (the Deadline item shows instead,
// spec § 3.6). A deadline Alex deleted stays hidden too.
function feedInstances(start, end) {
  return hideTrackedCopies(instancesForRange(feeds, feedCache, start, end, deviceTz),
    feeds, trackedCopyIds(items, loadTombstones()));
}
```

The import, after `handleDelete` (`:~550`):

```js
// --- Brightspace deadlines (spec 2026-10-30) --------------------------------
//
// A SECOND ITEMS WRITER PATH, inside app.js on purpose (CLAUDE.md, Ownership):
// the plan comes from js/deadlines.js (pure); the writes land here, in the
// module-scope `items`, saved once. Tombstones first, as deleteItem does.
// prevCache is this device's feed cache BEFORE the refresh: a field is
// patched only when Brightspace changed it between the two (edits stick).
let deadlineStatus = { note: null, held: [] };

function applyDeadlinePlan({ create, update, remove }) {
  if (create.length === 0 && update.length === 0 && remove.length === 0) return;
  const now = nowISO();
  for (const id of remove) {
    const rec = items.find((it) => it.id === id);
    addTombstone(id, 'item', nextStamp(now, rec && rec.updatedAt));
  }
  const gone = new Set(remove);
  const patches = new Map(update.map((u) => [u.id, u.patch]));
  const made = create.map((c) => makeItem({ title: c.title, date: c.date, time: c.time, type: 'due' }, {
    id: c.id, createdAt: localStamp(new Date()), updatedAt: now,
  }));
  const prev = items;
  items = [
    ...items.filter((it) => !gone.has(it.id))
      .map((it) => (patches.has(it.id) ? applyEdit(it, patches.get(it.id), nextStamp(now, it.updatedAt)) : it)),
    ...made,
  ];
  try {
    saveItems(items);
  } catch (e) {
    items = prev;
    throw e;
  }
  render();
  scheduleSync();
}

function importDeadlines(prevCache) {
  try {
    const plan = planDeadlineImport({
      feeds, prevCache, cache: feedCache, items, tombstones: loadTombstones(),
      failedFeedIds, pendingIds: pendingDeletes, todayISO: toISO(new Date()),
    });
    deadlineStatus = { note: plan.note, held: plan.held };
    applyDeadlinePlan(plan);
  } catch (e) {
    // Never swallowed: the top line says why, and the console names the error
    // (never a feed URL). Nothing was saved; the next refresh retries.
    setMessage(e.message);
    console.error('plaenicke: deadline import failed', e && e.name);
  }
}

function removeHeldDeadlines() {
  const live = new Set(items.map((it) => it.id));
  const held = deadlineStatus.held.filter((id) => live.has(id) && !pendingDeletes.has(id));
  deadlineStatus = { note: null, held: [] };
  applyDeadlinePlan({ create: [], update: [], remove: held });
}
```

`makeItem` must be imported from `./items.js` in app.js (check `:10-12`; it is used by `addItems` at `:278`, so it already is).

Run it after a background refresh — in `settle` (`:1405`), capture the old cache first and import after the failure set is updated:

```js
  const settle = (results) => {
    feedBatch = null;
    const prevCache = feedCache;
    feedCache = loadFeedCache();
    render();
    if (results === null) for (const f of feedList) failedFeedIds.add(f.id);
    else for (const [id, r] of Object.entries(results)) { if (r.ok) failedFeedIds.delete(id); else failedFeedIds.add(id); }
    importDeadlines(prevCache);
    stampFromFeeds();
```

And after a Settings fetch or toggle — `onFeedsChanged` in `initSettings({...})` (`:239`):

```js
  onFeedsChanged: () => {
    const prevCache = feedCache;
    feeds = loadFeeds(); feedCache = loadFeedCache();
    importDeadlines(prevCache);
    render();
    stampUpdated(); stampFromFeeds();
  },
```

and add to the same `initSettings({...})` call:

```js
  // Brightspace deadlines: the Settings row's note and its "Remove them".
  deadlines: { status: () => deadlineStatus, removeHeld: removeHeldDeadlines },
```

(Settings ignores this key until Task 6.)

Add to `CLAUDE.md`, under "Invariants that have already caused near-misses", after the Ownership bullet:

```
- **Brightspace deadlines are own items with `bs-<UID>` ids, written by app.js's deadline import** (`importDeadlines`/`applyDeadlinePlan`; the plan is pure, in `js/deadlines.js`). The import never patches `done`, `notes` or `type`, patches title/date/time only when Brightspace changed that field between the previous and current feed cache, never re-creates a tombstoned id, and removes only under the guards in spec 2026-10-30 § 4. Changing any of those is a sync-safety change: run the mutation checks in `tests/deadlines.test.js`'s commit history.
```

- [ ] **Step 4: Run** `node --test --test-name-pattern="bsD:" tests/apply.test.js` → all pass. Then `npm test` → `# fail 0`, `# cancelled 0`. **Mutation checks:** remove `importDeadlines(prevCache);` from `settle` → bsD tests fail; replace `feedInstances(` at `:196` with the old `instancesForRange(…)` → the hidden-copy test fails. Restore.

- [ ] **Step 5: Commit**

```bash
git add js/app.js tests/apply.test.js CLAUDE.md
git commit -m "app: import tracked Brightspace deadlines after each feed refresh; hide the feed copy"
```

---

### Task 6: Settings — turn tracking on/off, show the note, "Remove them"

**Files:**
- Modify: `js/settings.js` — `initSettings` params and guard (`:76-91`), the feed row (`:405-470`)
- Test: `tests/settings.test.js` (update `openPanel` at `:30-58`; add tests)

**Interfaces:**
- Consumes: `initSettings({ ..., deadlines: { status, removeHeld } })` from Task 5; `reapplyFeedField(id, computePatch)` (`js/settings.js:261`); `nowISO`, `toISO` (`js/dateparse.js`).
- Produces: feed records with `trackDeadlines: { from: 'YYYY-MM-DD' }` or `trackDeadlines: null`, each write with a fresh `updatedAt`, followed by `notifySyncedChanged()`.

- [ ] **Step 1: Update the harness and write the failing tests.** In `tests/settings.test.js`'s `openPanel`, add a `deadlines` argument and return it:

```js
function openPanel(feeds, seed = () => {}, deadlineStatus = { note: null, held: [] }) {
  // …unchanged lines…
  const removed = [];
  initSettings({
    // …existing keys…
    deadlines: { status: () => deadlineStatus, removeHeld: () => removed.push('held') },
  });
  button.click();
  return { host, notified, button, fetched, removed };
}
```

Append tests:

```js
const bsRowFeed = (o = {}) => ({ id: 'bsS', url: 'https://example.com/bs.ics', name: 'Brightspace',
  color: 'var(--feed-palette-1)', hidden: false, updatedAt: '2026-10-01T00:00:00.000Z', ...o });

test('settings: initSettings refuses to mount without the deadlines wiring', () => {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  assert.throws(() => initSettings({
    button: document.createElement('button'), host: document.createElement('div'),
    onFeedsChanged() {}, onSyncedDataChanged() {}, onFeedFetched() {}, applyState: (s) => s,
  }), /deadlines/);
});

test('settings: "Track deadlines" turns tracking on from today, synced, with a fresh updatedAt', () => {
  const { host, notified } = openPanel([bsRowFeed()]);
  findButtonByText(host, 'Track deadlines').click();
  const f = loadFeeds()[0];
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.deepEqual(f.trackDeadlines, { from: iso });
  assert.ok(f.updatedAt > '2026-10-01T00:00:00.000Z', 'a synced field change bumps updatedAt');
  assert.ok(notified.includes('synced'), 'the account is told');
  assert.ok(findButtonByText(host, 'Stop tracking deadlines'), 'the button flips');
  assert.match(allText(host), /Tracking deadlines due from /);
});

test('settings: "Stop tracking deadlines" turns it off (null) and is synced', () => {
  const { host, notified } = openPanel([bsRowFeed({ trackDeadlines: { from: '2026-10-30' } })]);
  findButtonByText(host, 'Stop tracking deadlines').click();
  assert.equal(loadFeeds()[0].trackDeadlines, null);
  assert.ok(notified.includes('synced'));
});

test('settings: the deadline note and "Remove them" show on a tracking calendar', () => {
  const { host, removed } = openPanel(
    [bsRowFeed({ trackDeadlines: { from: '2026-10-30' } })], () => {},
    { note: '4 deadlines disappeared from Brightspace — not removed', held: ['bs-a', 'bs-b', 'bs-c', 'bs-d'] },
  );
  assert.match(allText(host), /4 deadlines disappeared from Brightspace — not removed/);
  findButtonByText(host, 'Remove them').click();
  assert.deepEqual(removed, ['held']);
});

test('settings: a calendar without tracking shows no deadline note or Remove them', () => {
  const { host } = openPanel([bsRowFeed()], () => {}, { note: 'x', held: ['bs-a'] });
  assert.equal(findButtonByText(host, 'Remove them'), null);
  assert.doesNotMatch(allText(host), /Tracking deadlines due from/);
});
```

- [ ] **Step 2: Run, expect FAIL** — `node --test tests/settings.test.js` → the refuse-to-mount test fails (no throw) and `Track deadlines` is not found.

- [ ] **Step 3: Implement in `js/settings.js`.** Add `deadlines` to the destructured params and the guard beside the existing two:

```js
  // The Brightspace deadline row reads app.js's import status and asks it to
  // apply a held removal. Missing wiring would hide a held removal silently.
  if (!deadlines || typeof deadlines.status !== 'function' || typeof deadlines.removeHeld !== 'function') {
    throw new Error('initSettings requires deadlines: { status, removeHeld }');
  }
```

Import `toISO` from `./dateparse.js` (check whether `nowISO` is already imported there and add `toISO` to the same import). In the feed row, after `syncBtn` is built and before `removeBtn`:

```js
          // Brightspace deadlines (spec 2026-10-30 § 2): a SYNCED field, so it
          // bumps updatedAt and tells the account, unlike Hide/colour.
          const trackBtn = document.createElement('button');
          trackBtn.type = 'button';
          trackBtn.textContent = feed.trackDeadlines ? 'Stop tracking deadlines' : 'Track deadlines';
          trackBtn.disabled = isBusy();
          trackBtn.addEventListener('click', () => {
            reapplyFeedField(feed.id, (f) => ({
              trackDeadlines: f.trackDeadlines ? null : { from: toISO(new Date()) },
              updatedAt: nowISO(),
            }));
            renderCalendars();
            notifySyncedChanged();
          });
```

Append `trackBtn` to `actions` in the same `append` call that adds `toggle` and `syncBtn` (find it with `grep -n "actions.append" js/settings.js`). Then, where `status` is appended to `row`, add after it:

```js
          if (feed.trackDeadlines) {
            const dl = document.createElement('div');
            dl.className = 'feed-deadlines';
            const from = new Date(`${feed.trackDeadlines.from}T12:00:00`);
            dl.textContent = `Tracking deadlines due from ${from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
            row.appendChild(dl);
            const { note, held } = deadlines.status();
            if (note) {
              const n = document.createElement('p');
              n.className = 'note feed-deadlines-note';
              n.textContent = note;
              row.appendChild(n);
            }
            if (held.length > 0) {
              const rm = document.createElement('button');
              rm.type = 'button';
              rm.textContent = 'Remove them';
              rm.addEventListener('click', () => { deadlines.removeHeld(); renderCalendars(); });
              row.appendChild(rm);
            }
          }
```

(Find where `status` joins the row with `grep -n "row.append" js/settings.js` and keep the existing order for the other children.)

- [ ] **Step 4: Run** `node --test tests/settings.test.js` → all pass. `npm test` → `# fail 0`, `# cancelled 0` (`tests/styles.test.js` checks 44px targets/16px inputs on new classes only if it scans by class; if it flags `.feed-deadlines-note` or the new buttons, follow the existing `.feed-actions button` rule rather than adding new CSS). **Mutation check:** remove `updatedAt: nowISO(),` → the "fresh updatedAt" test fails; restore.

- [ ] **Step 5: Commit**

```bash
git add js/settings.js tests/settings.test.js
git commit -m "settings: Track deadlines toggle, deadline note and Remove them on tracking calendars"
```

---

### Task 7: Two-device convergence and release prep

**Files:**
- Test: `tests/deadlines.test.js`
- Modify: `service-worker.js:13` (CACHE bump), `docs/superpowers/specs/2026-10-30-plaenicke-brightspace-deadlines-design.md` (Status line only)

**Interfaces:**
- Consumes: `planDeadlineImport` (Task 3), `merge`, `SCHEMA_VERSION` (`js/merge.js`).

- [ ] **Step 1: Write the convergence test** (append to `tests/deadlines.test.js`; import `merge, SCHEMA_VERSION` from `../js/merge.js` and `makeItem` from `../js/items.js`):

```js
test('two devices importing the same feed converge to one item; the second writes nothing', () => {
  const cache = { f1: entry([HW1]) };
  const build = (p, stamp) => p.create.map((c) => makeItem({ ...c, type: 'due' }, { id: c.id, createdAt: '2026-10-30', updatedAt: stamp }));
  const a = build(plan({ cache }), '2026-10-30T10:00:00.000Z');
  const b = build(plan({ cache }), '2026-10-30T10:00:05.000Z');
  const st = (items) => ({ schemaVersion: SCHEMA_VERSION, items, feeds: [], tombstones: [] });
  const merged = merge(st(a), st(b), new Date('2026-10-30T10:01:00.000Z'));
  assert.equal(merged.items.filter((it) => it.id === 'bs-u1').length, 1);
  const again = plan({ prevCache: cache, cache, items: merged.items });
  assert.deepEqual([again.create, again.update, again.remove], [[], [], []]);
});
```

- [ ] **Step 2: Run** `node --test tests/deadlines.test.js` → PASS (it exercises Tasks 3's idempotence and merge's id union; if it fails, the defect is in the planner — fix there).

- [ ] **Step 3: Release prep (no deploy).** Read the current CACHE line: `grep -n "const CACHE" service-worker.js`. Bump to the next unused version **at integration time** (CLAUDE.md trap: two branches can claim one name — check `git log --all -S"plaenicke-v6-" --oneline -- service-worker.js | head` and `git branch -a` for branches holding a higher CACHE, e.g. `capture-date-row`). Update `tests/serviceworker.test.js` if it pins the name. Set the spec's Status line to `APPROVED by Alex, 2026-10-30. Plan: docs/superpowers/plans/2026-10-30-brightspace-deadlines.md.`

- [ ] **Step 4: Full gate** — `npm test` → `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Commit**

```bash
git add tests/deadlines.test.js service-worker.js tests/serviceworker.test.js docs/superpowers/specs/2026-10-30-plaenicke-brightspace-deadlines-design.md
git commit -m "deadlines: two-device convergence test; CACHE bump; spec approved"
```

- [ ] **Step 6: Stop.** Release (merge to `main` = production) happens only on Alex's explicit yes. After release, on the phone: add the Brightspace link, tap **Track deadlines**, check three known deadlines against Brightspace, tick one and confirm it on the laptop, confirm Practice Solutions items are calendar-only. Then delete `/private/tmp/claude-502/-Users-ajaenicke25/a9b8fe93-fbf1-4061-97ae-817a50bf0ebc/scratchpad/bs/` (spec § 6).

---

## Deviation from the spec, stated

Spec § 3.5 says updates and removals go "through the existing edit path (`editItem`)" and "the delete path (`deleteItem`)", and § 4 says a failed write "stops at that item". This plan applies the whole plan in one save (`applyDeadlinePlan`), using the same primitives those paths use (`applyEdit` + `nextStamp`, `addTombstone` before the items write), because `editItem`/`deleteItem` each save, render, sync and toast per record. Consequence: a failed save writes **none** of the batch (rolled back, surfaced, retried next refresh) instead of a partial batch. Tombstones for a removal are written before the items save, exactly as `deleteItem` orders them.
