# plaenicke V3 — Time-of-Day + UI Rehaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Items gain optional start/end times, the calendar gains Week and Day views (plus a fixed-height Month view), and the whole app is rethemed as a "paper planner" with a neutral-dark mode behind a new settings menu.

**Architecture:** Retheme + new view modules (spec approach 1). Pure logic (time math, grid geometry, bucketing, normalization) lives in TDD'd modules with no DOM; rendering stays in thin modules wired by `js/app.js`. All colors come from CSS variables under `:root` / `[data-theme="dark"]`, so both themes apply to every view automatically.

**Tech Stack:** Vanilla ES modules, `node --test` (zero deps), Cloudflare Worker (smart add, `claude-haiku-4-5`), GitHub Pages PWA.

**Spec:** `docs/superpowers/specs/2026-07-28-plaenicke-v3-design.md` — read it first.

## Global Constraints

- Times are 24h `"HH:MM"` strings; `time: null` = untimed. `endTime` only valid with `time`, and must be strictly after it. No overnight spans.
- Old localStorage items have no time fields and must keep working untouched (read as untimed). No migration code.
- Views: **List | Month | Week | Day**. No horizontal scrolling anywhere. Week view = colored blocks only (no titles, no hour axis).
- Day view: hour grid on top, **"Other tasks"** (untimed) list at the bottom — never an all-day banner at top.
- Month cells fixed-height: ≤2 chips then `+N more`.
- Every color in CSS must be a token (var). Light = paper planner (cream `#f4f1ea` family, Georgia serif); dark = neutral dark (`#14161a` family).
- Worker must NOT send `effort`/`thinking` (Haiku rejects them). Never invent times in extraction — unstated → null.
- Tests: root `npm test` and `cd worker && npm test` must pass at every commit. Style follows existing tests (`node:test` + `assert/strict`).
- Commit after every green task; messages follow existing `feat:`/`fix:`/`docs:` style.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `js/items.js` | modify | Item shape + validation (gains `time`/`endTime`), date+time sort |
| `js/timegrid.js` | create | Pure time/grid math: minutes, 12h formatting, day arithmetic, timed/untimed bucketing, overlap layout |
| `js/calendar.js` | modify | Month grid math; gains `monthCellSummary` (chips + more count) |
| `js/theme.js` | create | Pure theme resolution (`resolveTheme`) + storage key |
| `js/dayview.js` | create | Day view rendering (hour grid + Other tasks) |
| `js/weekview.js` | create | Week view rendering (7 columns of blocks) |
| `js/settings.js` | create | Settings overlay rendering (Appearance control + placeholder) |
| `js/app.js` | modify | Wiring only: state, view switching, delegating renders |
| `js/preview.js` | modify | Preview rows gain time/end-time editing |
| `index.html` | modify | Pre-paint theme script, 4-way toggle, day/week sections, ⚙ + settings panel, time inputs |
| `styles.css` | rewrite | Token-based paper/dark theme, all components incl. new views |
| `manifest.json` | modify | `theme_color`/`background_color` → cream |
| `service-worker.js` | modify | New assets in precache list, cache name bump (LAST task — new files must exist first) |
| `worker/src/normalize.js` | modify | Validate `time`/`endTime` from Claude |
| `worker/src/prompt.js` | modify | Schema + system prompt gain time extraction |
| Tests | create/modify | `tests/timegrid.test.js` (new), `tests/items.test.js`, `tests/calendar.test.js`, `tests/theme.test.js` (new), `worker/tests/normalize.test.js`, `worker/tests/prompt.test.js` |

Task order: pure logic first (1–5), theme foundation (6), settings (7), then views (8–10), add-flow surfaces (11), deploy+verify (12).

---

### Task 1: Item shape — `time` / `endTime`

**Files:**
- Modify: `js/items.js`
- Test: `tests/items.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `makeItem(fields, meta)` → item with `time: "HH:MM"|null`, `endTime: "HH:MM"|null`. Throws `Error` on: bad shape (`Time must be HH:MM` / `End time must be HH:MM`), `End time requires a start time`, `End time must be after start time`. `sortItemsByDate(items)`: same date → untimed first, timed by time ascending; then existing createdAt/title tiebreaks. Later tasks rely on these exact field names.

- [ ] **Step 1: Write the failing tests** — append to `tests/items.test.js`:

```js
test('makeItem stores time and endTime, defaulting both to null', () => {
  const timed = makeItem({ title: 'Dentist', date: '2026-08-04', time: '14:00', endTime: '15:00' },
    { id: 'd', createdAt: 'x' });
  assert.equal(timed.time, '14:00');
  assert.equal(timed.endTime, '15:00');
  const plain = makeItem({ title: 'Buy milk', date: '2026-08-04' }, { id: 'e', createdAt: 'x' });
  assert.equal(plain.time, null);
  assert.equal(plain.endTime, null);
});

test('makeItem rejects malformed times', () => {
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '2pm' }, { id: 'f', createdAt: 'x' }),
    /Time must be HH:MM/);
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '14:00', endTime: '25:00' }, { id: 'g', createdAt: 'x' }),
    /End time must be HH:MM/);
});

test('makeItem rejects endTime without time, and end not after start', () => {
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', endTime: '15:00' }, { id: 'h', createdAt: 'x' }),
    /End time requires a start time/);
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '15:00', endTime: '15:00' }, { id: 'i', createdAt: 'x' }),
    /End time must be after start time/);
});

test('sortItemsByDate: same date puts untimed first, then timed by time', () => {
  const input = [
    { id: 't2', title: 'B', date: '2026-08-04', time: '15:00', endTime: null, createdAt: 'x' },
    { id: 't1', title: 'A', date: '2026-08-04', time: '09:00', endTime: null, createdAt: 'x' },
    { id: 'u1', title: 'C', date: '2026-08-04', createdAt: 'x' },
  ];
  assert.deepEqual(sortItemsByDate(input).map(i => i.id), ['u1', 't1', 't2']);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: the 4 new tests FAIL (time fields undefined / no throw / wrong order); all pre-existing tests still PASS.

- [ ] **Step 3: Implement** — in `js/items.js`, add before `makeItem`:

```js
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
```

Inside `makeItem`, after the date check:

```js
  const time = fields.time || null;
  const endTime = fields.endTime || null;
  if (time && !HHMM.test(time)) throw new Error('Time must be HH:MM');
  if (endTime && !HHMM.test(endTime)) throw new Error('End time must be HH:MM');
  if (endTime && !time) throw new Error('End time requires a start time');
  if (time && endTime && endTime <= time) throw new Error('End time must be after start time');
```

Add `time` and `endTime` to the returned object (after `date`). In `sortItemsByDate`, insert between the date compare and the createdAt compare:

```js
    const at = a.time || null, bt = b.time || null;
    if (at !== bt) {
      if (at === null) return -1;
      if (bt === null) return 1;
      return at < bt ? -1 : 1;
    }
```

(String compare is safe: zero-padded `"HH:MM"` sorts chronologically.)

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm test` — Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add js/items.js tests/items.test.js
git commit -m "feat: items carry optional time and endTime"
```

---

### Task 2: `js/timegrid.js` — pure time/grid math

**Files:**
- Create: `js/timegrid.js`
- Test: `tests/timegrid.test.js`

**Interfaces:**
- Consumes: item objects from Task 1 (`{ time, endTime, title, ... }`).
- Produces (exact signatures later tasks use):
  - `minutesOf(hhmm)` → int minutes since midnight.
  - `formatTime(hhmm)` → `"2:30 PM"` (12h, no leading zero on hour, `12:00` handled: `"00:30"` → `"12:30 AM"`, `"12:30"` → `"12:30 PM"`).
  - `formatTimeRange(start, end)` → `"2:00–3:00 PM"`; period shown on both sides when they differ: `"11:00 AM–1:00 PM"` (en dash, no spaces).
  - `addDays(iso, n)` → ISO date string.
  - `startOfWeek(iso)` → ISO of that week's Sunday.
  - `bucketDayItems(items)` → `{ untimed: [...input order], timed: [...sorted by time] }`.
  - `layoutDayBlocks(timedItems, defaultDurationMin = 30)` → array of `{ item, startMin, endMin, col, cols, pinned }`; `pinned` true when the item has no `endTime` (rendered as a chip; `endMin = startMin + defaultDurationMin` for layout only).

- [ ] **Step 1: Write the failing tests** — create `tests/timegrid.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesOf, formatTime, formatTimeRange, addDays, startOfWeek,
  bucketDayItems, layoutDayBlocks } from '../js/timegrid.js';

test('minutesOf converts HH:MM to minutes since midnight', () => {
  assert.equal(minutesOf('00:00'), 0);
  assert.equal(minutesOf('14:30'), 870);
  assert.equal(minutesOf('23:59'), 1439);
});

test('formatTime renders 12-hour times', () => {
  assert.equal(formatTime('09:05'), '9:05 AM');
  assert.equal(formatTime('14:30'), '2:30 PM');
  assert.equal(formatTime('00:30'), '12:30 AM');
  assert.equal(formatTime('12:30'), '12:30 PM');
});

test('formatTimeRange shares the period when equal, shows both when not', () => {
  assert.equal(formatTimeRange('14:00', '15:00'), '2:00–3:00 PM');
  assert.equal(formatTimeRange('11:00', '13:00'), '11:00 AM–1:00 PM');
});

test('addDays crosses month boundaries', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-08-01', -1), '2026-07-31');
});

test('startOfWeek returns the Sunday of the week', () => {
  assert.equal(startOfWeek('2026-08-05'), '2026-08-02'); // Wed -> Sun
  assert.equal(startOfWeek('2026-08-02'), '2026-08-02'); // Sun -> itself
});

test('bucketDayItems splits untimed from time-sorted timed', () => {
  const items = [
    { id: 'b', time: '15:00' }, { id: 'u' }, { id: 'a', time: '09:00' },
  ];
  const { untimed, timed } = bucketDayItems(items);
  assert.deepEqual(untimed.map(i => i.id), ['u']);
  assert.deepEqual(timed.map(i => i.id), ['a', 'b']);
});

test('layoutDayBlocks: non-overlapping items each get full width', () => {
  const rows = layoutDayBlocks([
    { id: 'a', time: '09:00', endTime: '10:00' },
    { id: 'b', time: '10:00', endTime: '11:00' },
  ]);
  assert.deepEqual(rows.map(r => [r.item.id, r.col, r.cols, r.pinned]),
    [['a', 0, 1, false], ['b', 0, 1, false]]);
  assert.equal(rows[0].startMin, 540);
  assert.equal(rows[0].endMin, 600);
});

test('layoutDayBlocks: overlapping items split the width', () => {
  const rows = layoutDayBlocks([
    { id: 'a', time: '09:00', endTime: '11:00' },
    { id: 'b', time: '10:00', endTime: '12:00' },
  ]);
  assert.deepEqual(rows.map(r => [r.item.id, r.col, r.cols]), [['a', 0, 2], ['b', 1, 2]]);
});

test('layoutDayBlocks: no endTime pins a default-duration chip', () => {
  const rows = layoutDayBlocks([{ id: 'a', time: '09:00' }]);
  assert.equal(rows[0].pinned, true);
  assert.equal(rows[0].endMin, 570); // 09:00 + 30min default
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` — Expected: `tests/timegrid.test.js` FAILS (module not found).

- [ ] **Step 3: Implement** — create `js/timegrid.js`:

```js
// timegrid.js — pure time & day-grid math. No DOM.

export function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

export function formatTimeRange(start, end) {
  const a = formatTime(start), b = formatTime(end);
  const [aTime, aPeriod] = a.split(' ');
  const [bTime, bPeriod] = b.split(' ');
  if (aPeriod === bPeriod) return `${aTime}–${bTime} ${bPeriod}`;
  return `${a}–${b}`;
}

export function addDays(iso, n) {
  const [y, mo, d] = iso.split('-').map(Number);
  const next = new Date(y, mo - 1, d + n);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

export function startOfWeek(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  return addDays(iso, -new Date(y, mo - 1, d).getDay());
}

export function bucketDayItems(items) {
  const untimed = [], timed = [];
  for (const it of items) (it.time ? timed : untimed).push(it);
  timed.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return { untimed, timed };
}

export function layoutDayBlocks(timedItems, defaultDurationMin = 30) {
  const rows = timedItems
    .map((item) => {
      const startMin = minutesOf(item.time);
      const pinned = !item.endTime;
      const endMin = pinned ? startMin + defaultDurationMin : minutesOf(item.endTime);
      return { item, startMin, endMin, pinned, col: 0, cols: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  // Cluster transitively-overlapping rows, then assign each row the first free column.
  let cluster = [], clusterEnd = -1;
  const closeCluster = () => {
    const colEnds = [];
    for (const r of cluster) {
      let c = colEnds.findIndex((end) => end <= r.startMin);
      if (c === -1) { c = colEnds.length; colEnds.push(0); }
      r.col = c;
      colEnds[c] = r.endMin;
    }
    for (const r of cluster) r.cols = colEnds.length;
  };
  for (const r of rows) {
    if (cluster.length && r.startMin >= clusterEnd) { closeCluster(); cluster = []; clusterEnd = -1; }
    cluster.push(r);
    clusterEnd = Math.max(clusterEnd, r.endMin);
  }
  if (cluster.length) closeCluster();
  return rows;
}
```

- [ ] **Step 4: Run tests to verify all pass** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add js/timegrid.js tests/timegrid.test.js
git commit -m "feat: timegrid — pure time math, bucketing, and overlap layout"
```

---

### Task 3: Month cell summary (chips + "+N more")

**Files:**
- Modify: `js/calendar.js`
- Test: `tests/calendar.test.js`

**Interfaces:**
- Produces: `monthCellSummary(dayItems, maxChips = 2)` → `{ chips: [...first ≤maxChips items], more: int }`. Task 8 renders `chips` and, when `more > 0`, a `+N more` line.

- [ ] **Step 1: Write the failing tests** — append to `tests/calendar.test.js` (import `monthCellSummary` alongside the existing imports from `../js/calendar.js`):

```js
test('monthCellSummary passes small days through with no overflow', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(monthCellSummary(items), { chips: items, more: 0 });
});

test('monthCellSummary caps at maxChips and counts the rest', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const s = monthCellSummary(items);
  assert.deepEqual(s.chips.map(i => i.id), ['a', 'b']);
  assert.equal(s.more, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test` → new tests FAIL (not exported).

- [ ] **Step 3: Implement** — append to `js/calendar.js`:

```js
export function monthCellSummary(dayItems, maxChips = 2) {
  if (dayItems.length <= maxChips) return { chips: dayItems, more: 0 };
  return { chips: dayItems.slice(0, maxChips), more: dayItems.length - maxChips };
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add js/calendar.js tests/calendar.test.js
git commit -m "feat: month cell summary with +N more overflow"
```

---

### Task 4: Worker normalizer — time fields

**Files:**
- Modify: `worker/src/normalize.js`
- Test: `worker/tests/normalize.test.js`

**Interfaces:**
- Produces: normalized items gain `time` / `endTime` (`"HH:MM"` or null). Rules: invalid shape → null (item kept, no review flag change); `endTime` without valid `time` → null; `endTime <= time` → endTime null. The frontend (Task 11) passes these straight into `makeItem`, so they must already be valid-or-null here.

- [ ] **Step 1: Write the failing tests** — append to `worker/tests/normalize.test.js`:

```js
test('passes valid time and endTime through', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'Dentist', date: '2026-08-04', time: '14:00', endTime: '15:00',
      type: 'event', project: null, subject: null, category: null },
  ]});
  assert.equal(r.items[0].time, '14:00');
  assert.equal(r.items[0].endTime, '15:00');
});

test('nulls malformed times without dropping the item', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'x', date: '2026-08-04', time: '2pm', endTime: '99:99',
      type: 'event', project: null, subject: null, category: null },
  ]});
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].time, null);
  assert.equal(r.items[0].endTime, null);
});

test('nulls endTime when it is missing a start or not after it', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'no-start', date: '2026-08-04', time: null, endTime: '15:00',
      type: 'event', project: null, subject: null, category: null },
    { title: 'backwards', date: '2026-08-04', time: '15:00', endTime: '14:00',
      type: 'event', project: null, subject: null, category: null },
  ]});
  assert.equal(r.items[0].endTime, null);
  assert.equal(r.items[1].time, '15:00');
  assert.equal(r.items[1].endTime, null);
});

test('items with no time fields at all normalize to nulls', () => {
  const r = normalizeClaudeJson(GOOD);
  assert.equal(r.items[0].time, null);
  assert.equal(r.items[0].endTime, null);
});
```

- [ ] **Step 2: Run tests to verify they fail** — `cd worker && npm test` → new tests FAIL.

- [ ] **Step 3: Implement** — in `worker/src/normalize.js`, add near `ISO`:

```js
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
```

In the item loop, before `items.push`:

```js
    const time = typeof it.time === 'string' && HHMM.test(it.time) ? it.time : null;
    let endTime = typeof it.endTime === 'string' && HHMM.test(it.endTime) ? it.endTime : null;
    if (!time || (endTime && endTime <= time)) endTime = null;
```

Add `time` and `endTime` to the pushed object (after `date`).

- [ ] **Step 4: Run tests** — `cd worker && npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/normalize.js worker/tests/normalize.test.js
git commit -m "feat: worker normalizer validates time and endTime"
```

---

### Task 5: Worker prompt — time extraction

**Files:**
- Modify: `worker/src/prompt.js`
- Test: `worker/tests/prompt.test.js`

**Interfaces:**
- Produces: request schema items include nullable `time`/`endTime` (and both appear in `required` — structured outputs need every property listed); system prompt instructs extraction. Live behavior verified in Task 12.

- [ ] **Step 1: Write the failing tests** — append to `worker/tests/prompt.test.js`:

```js
test('schema includes nullable time and endTime on items', () => {
  const body = buildRequestBody('x', '2026-05-01');
  const props = body.output_config.format.schema.properties.items.items.properties;
  assert.ok(props.time, 'schema has time');
  assert.ok(props.endTime, 'schema has endTime');
  const req = body.output_config.format.schema.properties.items.items.required;
  assert.ok(req.includes('time') && req.includes('endTime'));
});

test('system prompt teaches time extraction without inventing times', () => {
  const body = buildRequestBody('x', '2026-05-01');
  assert.ok(body.system.includes('time'));
  assert.ok(/never (guess|invent)/i.test(body.system));
});
```

- [ ] **Step 2: Run tests to verify they fail** — `cd worker && npm test` → FAIL.

- [ ] **Step 3: Implement** — in `worker/src/prompt.js` SCHEMA, after the `date` property add:

```js
          time: { anyOf: [{ type: 'string' }, { type: 'null' }] },    // HH:MM 24h
          endTime: { anyOf: [{ type: 'string' }, { type: 'null' }] }, // HH:MM 24h
```

Extend `required` to `['title', 'date', 'time', 'endTime', 'type', 'project', 'subject', 'category']`.

In `SYSTEM`, after the `date:` bullet add:

```
- time: the start time as 24-hour "HH:MM" when the note states one (e.g. "at 2pm" -> "14:00"); null when no time is mentioned. Never invent a time. A deadline "at midnight" means "23:59".
- endTime: the end as "HH:MM" when stated or clearly implied ("2 to 3pm", "meeting 9-10:30"); null otherwise. Only set endTime when time is set.
```

- [ ] **Step 4: Run tests** — `cd worker && npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/prompt.js worker/tests/prompt.test.js
git commit -m "feat: smart-add extracts start and end times"
```

---

### Task 6: Theme foundation — tokens, `theme.js`, pre-paint script, manifest

**Files:**
- Create: `js/theme.js`
- Test: `tests/theme.test.js`
- Rewrite: `styles.css`
- Modify: `index.html` (head only), `manifest.json`

**Interfaces:**
- Produces: `resolveTheme(setting, systemPrefersDark)` → `'light'|'dark'` (`'auto'`/unknown follow the flag); `THEME_KEY = 'plaenicke.theme'`. Theme applies via `document.documentElement.dataset.theme = 'dark'` (absent = light). All later tasks style exclusively with the CSS variables defined here, and use these class names for new UI: `.cal-more`, `.day-grid`, `.day-hours`, `.day-hour`, `.day-canvas`, `.day-block`, `.day-pin`, `.other-tasks`, `.week-grid`, `.week-col`, `.week-head`, `.week-block`, `.settings-panel`, `.settings-backdrop`, `.settings-section`, `.seg`, `.seg button`, `.icon-btn`, `.time-line`.

- [ ] **Step 1: Write the failing tests** — create `tests/theme.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, THEME_KEY } from '../js/theme.js';

test('explicit settings win regardless of system', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('auto and unknown settings follow the system', () => {
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('garbage', false), 'light');
});

test('storage key is stable', () => {
  assert.equal(THEME_KEY, 'plaenicke.theme');
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npm test` → FAIL (module not found).

- [ ] **Step 3: Implement `js/theme.js`**

```js
// theme.js — pure theme resolution. Applying it to the DOM happens in app.js/settings.js.

export const THEME_KEY = 'plaenicke.theme';

export function resolveTheme(setting, systemPrefersDark) {
  if (setting === 'light') return 'light';
  if (setting === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Rewrite `styles.css`** with the full token-based theme:

```css
/* ---------- theme tokens ---------- */
:root {
  --bg: #f4f1ea;            /* warm cream */
  --card: #fffdf8;          /* paper */
  --ink: #2b2620;
  --muted: #8a8070;
  --accent: #8a5a3b;        /* leather brown */
  --accent-ink: #fffdf8;    /* text on accent */
  --danger: #b04a3a;
  --line: #e0d8c8;
  --chip-bg: #efe9dc;
  --chip-ink: #6b6152;
  --today: #8a5a3b;
  --grid-line: #e9e2d4;
  /* item type colors (warm-tuned) */
  --type-due: #b04a3a;
  --type-start: #3d6b9e;
  --type-milestone: #c8963e;
  --type-event: #4a7a54;
  --type-general: #8a8070;
  --serif: Georgia, 'Times New Roman', serif;
}

[data-theme="dark"] {
  --bg: #14161a;            /* neutral near-black */
  --card: #1e2126;
  --ink: #e2e5ea;
  --muted: #7d828c;
  --accent: #8fa7c8;
  --accent-ink: #14161a;
  --danger: #e06c5e;
  --line: #33373f;
  --chip-bg: #262a31;
  --chip-ink: #a6acb8;
  --today: #8fa7c8;
  --grid-line: #23262d;
  --type-due: #e06c5e;
  --type-start: #7c9ec9;
  --type-milestone: #e0b356;
  --type-event: #63b57e;
  --type-general: #7d828c;
}

/* ---------- base ---------- */
* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--serif);
  background: var(--bg);
  color: var(--ink);
  padding: env(safe-area-inset-top) 16px 40px;
}

header { display: flex; justify-content: space-between; align-items: center; }
header h1 { font-size: 1.7rem; font-style: italic; font-weight: 700; margin: 16px 0; }

.icon-btn {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--ink);
  border-radius: 6px;
  font-size: 1.1rem;
  padding: 6px 10px;
}

/* ---------- add box ---------- */
.add-box {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 14px;
  margin-bottom: 16px;
  box-shadow: 0 1px 0 var(--line);
}

#entry-text {
  width: 100%;
  font-size: 1rem;
  font-family: inherit;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}

.text-row { display: flex; gap: 8px; align-items: stretch; }
.text-row #entry-text { flex: 1; }
#mic-btn {
  flex: 0 0 auto;
  background: var(--card);
  border: 1px solid var(--line);
  color: var(--ink);
  font-size: 1.2rem;
  padding: 0 14px;
}
#mic-btn.listening { background: var(--danger); border-color: var(--danger); color: var(--accent-ink); }

.hint { color: var(--muted); font-size: 0.8rem; margin: 8px 0 0; }

.add-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
#entry-date, #entry-time, #entry-end {
  flex: 1;
  min-width: 90px;
  font-size: 1rem;
  font-family: inherit;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}

button {
  font-size: 1rem;
  font-family: inherit;
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-ink);
}

.message { color: var(--muted); min-height: 1.2em; margin: 8px 0 0; }

/* ---------- view toggle ---------- */
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

/* ---------- list ---------- */
#item-list { list-style: none; padding: 0; margin: 0; }
#item-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
}
#item-list li.empty { color: var(--muted); justify-content: center; }
button.delete { background: transparent; color: var(--danger); padding: 6px 10px; }
.time-line { color: var(--muted); font-size: 0.8rem; font-style: italic; }

/* ---------- calendar controls (shared by month/week/day) ---------- */
.cal-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.cal-controls span { font-weight: 700; }
.cal-controls button { background: var(--card); color: var(--ink); border: 1px solid var(--line); }

/* ---------- month ---------- */
.calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.cal-head { text-align: center; font-size: 0.75rem; color: var(--muted); padding: 4px 0; }
.cal-cell {
  height: 72px;
  overflow: hidden;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px;
  font-size: 0.72rem;
}
.cal-cell.blank { background: transparent; border: none; }
.cal-cell.today { border-color: var(--today); box-shadow: 0 0 0 1px var(--today) inset; }
.cal-day { font-weight: 700; margin-bottom: 2px; }
.cal-item {
  background: var(--type, var(--type-general));
  color: var(--accent-ink);
  border-radius: 3px;
  padding: 1px 4px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-theme="dark"] .cal-item { color: #14161a; }
.cal-more { color: var(--muted); margin-top: 2px; }

/* ---------- week ---------- */
.week-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
.week-col {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 4px;
  min-height: 180px;
  padding: 3px;
}
.week-col.today { border-color: var(--today); box-shadow: 0 0 0 1px var(--today) inset; }
.week-head { text-align: center; font-size: 0.7rem; color: var(--muted); margin-bottom: 4px; }
.week-head b { display: block; font-size: 0.85rem; color: var(--ink); }
.week-block { height: 8px; border-radius: 2px; margin-top: 3px; background: var(--type, var(--type-general)); }

/* ---------- day ---------- */
.day-grid {
  display: flex;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  max-height: 60vh;
  overflow-y: auto;
}
.day-hours { flex: 0 0 48px; }
.day-hour {
  height: 48px;
  font-size: 0.7rem;
  color: var(--muted);
  text-align: right;
  padding-right: 6px;
  border-top: 1px solid var(--grid-line);
}
.day-canvas { flex: 1; position: relative; border-left: 1px solid var(--grid-line); }
.day-canvas .hour-line { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid var(--grid-line); }
.day-block, .day-pin {
  position: absolute;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 0.75rem;
  overflow: hidden;
  color: #fffdf8;
  background: var(--type, var(--type-general));
}
[data-theme="dark"] .day-block, [data-theme="dark"] .day-pin { color: #14161a; }
.day-pin { border-left: 3px solid rgba(0,0,0,0.25); }
.other-tasks { margin-top: 12px; }
.other-tasks h3 { font-size: 0.9rem; font-style: italic; margin: 0 0 6px; }

/* ---------- settings ---------- */
.settings-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.35);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 15vh;
  z-index: 10;
}
.settings-panel {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 16px;
  width: min(90vw, 360px);
}
.settings-panel h2 { font-size: 1.1rem; font-style: italic; margin: 0 0 12px; }
.settings-section {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
}
.settings-section h3 { font-size: 0.9rem; margin: 0 0 6px; }
.settings-section.disabled { opacity: 0.55; }
.settings-section .note { color: var(--muted); font-size: 0.8rem; margin: 0; }
.seg { display: flex; gap: 6px; }
.seg button {
  flex: 1;
  background: var(--card);
  color: var(--ink);
  border: 1px solid var(--line);
  font-size: 0.85rem;
  padding: 6px 0;
}
.seg button.active { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }

/* ---------- tags & preview (restyled) ---------- */
.tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.tag { font-size: 0.7rem; background: var(--chip-bg); color: var(--chip-ink); border-radius: 999px; padding: 1px 8px; }

#preview { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 14px; margin-bottom: 16px; }
.preview-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; margin-bottom: 8px; }
.preview-row input, .preview-row select {
  padding: 8px; border: 1px solid var(--line); border-radius: 6px;
  font-size: 0.9rem; font-family: inherit; background: var(--card); color: var(--ink);
}
.preview-times { display: flex; gap: 6px; }
.preview-actions { display: flex; gap: 8px; margin-top: 10px; }
.preview-actions .cancel { background: var(--card); color: var(--ink); border: 1px solid var(--line); }

/* item type color hooks (unchanged mechanism) */
.type-due       { --type: var(--type-due); }
.type-start     { --type: var(--type-start); }
.type-milestone { --type: var(--type-milestone); }
.type-event     { --type: var(--type-event); }
.type-general   { --type: var(--type-general); }
#item-list li { border-left: 4px solid var(--type, var(--type-general)); }
```

- [ ] **Step 6: Pre-paint theme script** — in `index.html` `<head>`, immediately after the `<meta>` tags (before the stylesheet link), add:

```html
  <script>
    // Apply the saved theme before first paint so dark mode doesn't flash light.
    (function () {
      var t = null;
      try { t = localStorage.getItem('plaenicke.theme'); } catch (e) {}
      var dark = t === 'dark' || ((t === null || t === 'auto') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (dark) document.documentElement.dataset.theme = 'dark';
    })();
  </script>
```

- [ ] **Step 7: Manifest colors** — in `manifest.json` set `"background_color": "#f4f1ea"` and `"theme_color": "#f4f1ea"`.

- [ ] **Step 8: Verify** — `npm test` (still green), `node --check js/theme.js`, then open the app locally (`python3 -m http.server` or any static server) and confirm: paper look on all existing views, and with `localStorage.setItem('plaenicke.theme','dark')` + reload, the dark look everywhere. (Settings UI comes next task; this manual toggle is just for verification.)

- [ ] **Step 9: Commit**

```bash
git add js/theme.js tests/theme.test.js styles.css index.html manifest.json
git commit -m "feat: paper-planner theme tokens with neutral-dark variant"
```

---

### Task 7: Settings menu (⚙, Appearance, calendar placeholder)

**Files:**
- Create: `js/settings.js`
- Modify: `index.html` (header + settings section), `js/app.js`

**Interfaces:**
- Consumes: `resolveTheme` / `THEME_KEY` from Task 6.
- Produces: `initSettings({ button, host })` from `js/settings.js` — wires the ⚙ button to open/close an overlay rendered into `host`, owns theme persistence and application. `app.js` calls it once at startup.

- [ ] **Step 1: index.html** — replace the `<header>` block with:

```html
  <header>
    <h1>plaenicke</h1>
    <button id="settings-btn" class="icon-btn" type="button" aria-label="Settings">&#9881;</button>
  </header>
```

Add just before `<script type="module" src="js/app.js"></script>`:

```html
  <div id="settings-host"></div>
```

- [ ] **Step 2: Implement `js/settings.js`**

```js
// settings.js — the settings overlay: appearance now, linked calendars later.
import { resolveTheme, THEME_KEY } from './theme.js';

const CHOICES = ['light', 'dark', 'auto'];

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(setting) {
  const resolved = resolveTheme(setting, systemPrefersDark());
  if (resolved === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

function getSetting() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
  return CHOICES.includes(t) ? t : 'auto';
}

export function initSettings({ button, host }) {
  // Follow the phone while in auto.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => applyTheme(getSetting()));

  function close() { host.innerHTML = ''; }

  function open() {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    const h = document.createElement('h2');
    h.textContent = 'Settings';
    panel.appendChild(h);

    const appearance = document.createElement('div');
    appearance.className = 'settings-section';
    const ah = document.createElement('h3');
    ah.textContent = 'Appearance';
    const seg = document.createElement('div');
    seg.className = 'seg';
    const current = getSetting();
    for (const choice of CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = choice[0].toUpperCase() + choice.slice(1);
      if (choice === current) b.classList.add('active');
      b.addEventListener('click', () => {
        try { localStorage.setItem(THEME_KEY, choice); } catch { /* private mode */ }
        applyTheme(choice);
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      });
      seg.appendChild(b);
    }
    appearance.append(ah, seg);

    const calendars = document.createElement('div');
    calendars.className = 'settings-section disabled';
    const ch = document.createElement('h3');
    ch.textContent = 'Linked calendars';
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'Coming in a future version';
    calendars.append(ch, note);

    panel.append(appearance, calendars);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);
  }

  button.addEventListener('click', () => { host.childElementCount ? close() : open(); });
}
```

- [ ] **Step 3: Wire in `js/app.js`** — add to imports:

```js
import { initSettings } from './settings.js';
```

Add to the `els` map: `settingsBtn: document.getElementById('settings-btn'), settingsHost: document.getElementById('settings-host'),` and after the mic-button block:

```js
initSettings({ button: els.settingsBtn, host: els.settingsHost });
```

- [ ] **Step 4: Verify** — `npm test` green; `node --check js/settings.js js/app.js`; manual: open app → ⚙ opens panel; Light/Dark/Auto switch instantly and persist across reload; backdrop tap closes; calendars row greyed.

- [ ] **Step 5: Commit**

```bash
git add js/settings.js js/app.js index.html
git commit -m "feat: settings menu with appearance control and calendar placeholder"
```

---

### Task 8: Four-way view toggle + fixed month cells

**Files:**
- Modify: `index.html`, `js/app.js`

**Interfaces:**
- Consumes: `monthCellSummary` (Task 3).
- Produces: `showView(which)` accepting `'list' | 'month' | 'week' | 'day'`; app state `viewDay` (ISO string, defaults to today) and `viewWeekStart` (ISO Sunday) that Tasks 9–10 read; empty `#week-view` / `#day-view` sections that Tasks 9–10 fill. Month day-cell taps call `openDay(dateISO)` (defined here as: set `viewDay = dateISO`, call `showView('day')`, re-render) — a no-op-ish stub until Task 9 renders the day view.

- [ ] **Step 1: index.html** — replace the `view-toggle` nav and add sections:

```html
  <nav class="view-toggle">
    <button id="show-list" type="button" class="active">List</button>
    <button id="show-month" type="button">Month</button>
    <button id="show-week" type="button">Week</button>
    <button id="show-day" type="button">Day</button>
  </nav>
```

Rename the existing `#show-calendar` references: the calendar section stays `id="calendar-view"`. After it, add:

```html
  <section id="week-view" hidden>
    <div class="cal-controls">
      <button id="prev-week" type="button">&larr;</button>
      <span id="week-label"></span>
      <button id="next-week" type="button">&rarr;</button>
    </div>
    <div id="week-grid" class="week-grid"></div>
  </section>

  <section id="day-view" hidden>
    <div class="cal-controls">
      <button id="prev-day" type="button">&larr;</button>
      <span id="day-label"></span>
      <button id="next-day" type="button">&rarr;</button>
    </div>
    <div id="day-body"></div>
  </section>
```

- [ ] **Step 2: app.js state + toggle** — update `els` (replace `showCal` with the four buttons + new nodes):

```js
  showList: document.getElementById('show-list'),
  showMonth: document.getElementById('show-month'),
  showWeek: document.getElementById('show-week'),
  showDay: document.getElementById('show-day'),
  weekView: document.getElementById('week-view'),
  weekLabel: document.getElementById('week-label'),
  weekGrid: document.getElementById('week-grid'),
  prevWeek: document.getElementById('prev-week'),
  nextWeek: document.getElementById('next-week'),
  dayView: document.getElementById('day-view'),
  dayLabel: document.getElementById('day-label'),
  dayBody: document.getElementById('day-body'),
  prevDay: document.getElementById('prev-day'),
  nextDay: document.getElementById('next-day'),
```

Add imports `import { startOfWeek, addDays } from './timegrid.js';` and state:

```js
let viewDay = toISO(new Date());
let viewWeekStart = startOfWeek(viewDay);
let currentView = 'list';
```

Replace `showView` with:

```js
function showView(which) {
  currentView = which;
  const views = { list: els.listView, month: els.calView, week: els.weekView, day: els.dayView };
  const buttons = { list: els.showList, month: els.showMonth, week: els.showWeek, day: els.showDay };
  for (const [name, el] of Object.entries(views)) el.hidden = name !== which;
  for (const [name, b] of Object.entries(buttons)) b.classList.toggle('active', name === which);
  render();
}

function openDay(dateISO) {
  viewDay = dateISO;
  viewWeekStart = startOfWeek(dateISO);
  showView('day');
}
```

Replace the two old toggle listeners with four (`showView('list' | 'month' | 'week' | 'day')`), and add:

```js
els.prevDay.addEventListener('click', () => { viewDay = addDays(viewDay, -1); render(); });
els.nextDay.addEventListener('click', () => { viewDay = addDays(viewDay, 1); render(); });
els.prevWeek.addEventListener('click', () => { viewWeekStart = addDays(viewWeekStart, -7); render(); });
els.nextWeek.addEventListener('click', () => { viewWeekStart = addDays(viewWeekStart, 7); render(); });
```

(`render()` calls `renderList()`, `renderCalendar()`, and — after Tasks 9–10 — the day/week renders. Rendering hidden views is fine at this size; keep it simple.)

- [ ] **Step 3: Fixed month cells** — in `renderCalendar`, add import `monthCellSummary` from `./calendar.js`, and replace the per-cell item loop with:

```js
      const { chips, more } = monthCellSummary(byDate[cell.date] || []);
      for (const it of chips) {
        const chip = document.createElement('div');
        chip.className = 'cal-item type-' + (it.type || 'general');
        chip.textContent = it.title;
        div.appendChild(chip);
      }
      if (more > 0) {
        const m = document.createElement('div');
        m.className = 'cal-more';
        m.textContent = `+${more} more`;
        div.appendChild(m);
      }
      div.addEventListener('click', () => openDay(cell.date));
```

- [ ] **Step 4: Verify** — `npm test` green; `node --check js/app.js`; manual: four toggle buttons switch sections (Week/Day still empty shells); month cells uniform height with `+N more` on busy days; tapping a month day jumps to the (empty) Day view.

- [ ] **Step 5: Commit**

```bash
git add index.html js/app.js
git commit -m "feat: four-way view toggle and fixed-height month cells"
```

---

### Task 9: Day view

**Files:**
- Create: `js/dayview.js`
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `bucketDayItems`, `layoutDayBlocks`, `formatTime`, `formatTimeRange`, `minutesOf` (Task 2); `.day-*` / `.other-tasks` CSS (Task 6); `viewDay` state + `els.dayBody`/`els.dayLabel` (Task 8).
- Produces: `renderDayView(container, dateISO, dayItems, { onDelete })` — renders hour grid + Other tasks into `container`. Hour row height 48px ⇒ `top = startMin / 60 * 48`, `height = (endMin - startMin) / 60 * 48`.

- [ ] **Step 1: Implement `js/dayview.js`**

```js
// dayview.js — render one day: hour grid of timed items + "Other tasks" below.
import { bucketDayItems, layoutDayBlocks, formatTime, formatTimeRange } from './timegrid.js';

const HOUR_PX = 48;
const SCROLL_TO_HOUR = 7; // grid shows 24h; auto-scroll to 07:00

export function renderDayView(container, dateISO, dayItems, { onDelete }) {
  container.innerHTML = '';
  const { untimed, timed } = bucketDayItems(dayItems);

  const grid = document.createElement('div');
  grid.className = 'day-grid';

  const hours = document.createElement('div');
  hours.className = 'day-hours';
  const canvas = document.createElement('div');
  canvas.className = 'day-canvas';
  canvas.style.height = `${24 * HOUR_PX}px`;

  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'day-hour';
    label.textContent = formatTime(`${String(h).padStart(2, '0')}:00`);
    hours.appendChild(label);
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_PX}px`;
    canvas.appendChild(line);
  }

  for (const row of layoutDayBlocks(timed)) {
    const el = document.createElement('div');
    el.className = (row.pinned ? 'day-pin' : 'day-block') + ' type-' + (row.item.type || 'general');
    el.style.top = `${(row.startMin / 60) * HOUR_PX}px`;
    el.style.height = `${((row.endMin - row.startMin) / 60) * HOUR_PX - 2}px`;
    el.style.left = `${(row.col / row.cols) * 100}%`;
    el.style.width = `calc(${100 / row.cols}% - 4px)`;
    const when = row.item.endTime
      ? formatTimeRange(row.item.time, row.item.endTime)
      : formatTime(row.item.time);
    el.textContent = `${when} ${row.item.title}`;
    el.title = 'Tap to delete';
    el.addEventListener('click', () => {
      if (confirm(`Delete "${row.item.title}"?`)) onDelete(row.item.id);
    });
    canvas.appendChild(el);
  }

  grid.append(hours, canvas);
  container.appendChild(grid);
  grid.scrollTop = SCROLL_TO_HOUR * HOUR_PX;

  if (untimed.length > 0) {
    const other = document.createElement('div');
    other.className = 'other-tasks';
    const h3 = document.createElement('h3');
    h3.textContent = 'Other tasks';
    other.appendChild(h3);
    const ul = document.createElement('ul');
    ul.id = 'item-list'; // reuse list styling
    for (const it of untimed) {
      const li = document.createElement('li');
      li.classList.add('type-' + (it.type || 'general'));
      const span = document.createElement('span');
      span.textContent = it.title;
      const del = document.createElement('button');
      del.className = 'delete';
      del.textContent = 'Delete';
      del.addEventListener('click', () => onDelete(it.id));
      li.append(span, del);
      ul.appendChild(li);
    }
    other.appendChild(ul);
    container.appendChild(other);
  }
}
```

*(Note: reusing `id="item-list"` would duplicate an ID — use a class instead: set `ul.className = 'day-other-list'` and add `#item-list, .day-other-list { list-style: none; padding: 0; margin: 0; }` plus matching `li` rules to `styles.css` by extending the existing selectors: change `#item-list li` selectors to `#item-list li, .day-other-list li`, and `#item-list { … }` to `#item-list, .day-other-list { … }`.)*

- [ ] **Step 2: Wire in `js/app.js`** — imports:

```js
import { renderDayView } from './dayview.js';
```

Add a `renderDay` function and call it from `render()`:

```js
function renderDay() {
  const [y, m, d] = viewDay.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
  els.dayLabel.textContent = label;
  const byDate = groupItemsByDate(items);
  renderDayView(els.dayBody, viewDay, byDate[viewDay] || [], { onDelete: deleteItem });
}

function render() { renderList(); renderCalendar(); renderDay(); }
```

- [ ] **Step 3: Verify** — `npm test` green; `node --check js/dayview.js js/app.js`; manual: add a timed item (via console or manual-add once Task 11 lands — for now temporarily seed one in the console: `localStorage` edit or wait for Task 11 and re-verify): day view shows hour grid scrolled to 7 AM, blocks span durations, pins sit at start hour, overlaps split width, untimed items listed under "Other tasks", arrows step days, month tap opens the right day.

- [ ] **Step 4: Commit**

```bash
git add js/dayview.js js/app.js styles.css
git commit -m "feat: day view — hour grid with Other tasks below"
```

---

### Task 10: Week view

**Files:**
- Create: `js/weekview.js`
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `addDays` (Task 2), `.week-*` CSS (Task 6), `viewWeekStart` state + `els.weekGrid`/`els.weekLabel` (Task 8), `openDay` (Task 8).
- Produces: `renderWeekView(container, weekStartISO, itemsByDate, todayISO, { onSelectDay })` — 7 columns, colored blocks only, tap column → `onSelectDay(dateISO)`.

- [ ] **Step 1: Implement `js/weekview.js`**

```js
// weekview.js — 7 squeezed columns of colored blocks; the "shape of your week".
import { addDays } from './timegrid.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function renderWeekView(container, weekStartISO, itemsByDate, todayISO, { onSelectDay }) {
  container.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const dateISO = addDays(weekStartISO, i);
    const col = document.createElement('div');
    col.className = 'week-col';
    if (dateISO === todayISO) col.classList.add('today');

    const head = document.createElement('div');
    head.className = 'week-head';
    head.textContent = DOW[i];
    const num = document.createElement('b');
    num.textContent = String(Number(dateISO.slice(8)));
    head.appendChild(num);
    col.appendChild(head);

    for (const it of itemsByDate[dateISO] || []) {
      const block = document.createElement('div');
      block.className = 'week-block type-' + (it.type || 'general');
      col.appendChild(block);
    }

    col.addEventListener('click', () => onSelectDay(dateISO));
    container.appendChild(col);
  }
}
```

- [ ] **Step 2: Wire in `js/app.js`** — imports:

```js
import { renderWeekView } from './weekview.js';
```

Add and call from `render()`:

```js
function renderWeek() {
  const end = addDays(viewWeekStart, 6);
  els.weekLabel.textContent = `${viewWeekStart.slice(5).replace('-', '/')} – ${end.slice(5).replace('-', '/')}`;
  renderWeekView(els.weekGrid, viewWeekStart, groupItemsByDate(items), toISO(new Date()),
    { onSelectDay: openDay });
}

function render() { renderList(); renderCalendar(); renderWeek(); renderDay(); }
```

- [ ] **Step 3: Verify** — `npm test` green; `node --check js/weekview.js js/app.js`; manual: week view shows 7 columns with colored blocks matching item types, today outlined, arrows step weeks, tapping a column opens that day.

- [ ] **Step 4: Commit**

```bash
git add js/weekview.js js/app.js
git commit -m "feat: week view — seven columns of colored blocks"
```

---

### Task 11: Times in the add flows (manual, preview, list)

**Files:**
- Modify: `index.html`, `js/app.js`, `js/preview.js`

**Interfaces:**
- Consumes: `makeItem` time validation (Task 1), `formatTime`/`formatTimeRange` (Task 2), `.time-line`/`.preview-times` CSS (Task 6). Worker items now carry `time`/`endTime` (Task 4) — they flow through `addItems` → `makeItem` unchanged.
- Produces: manual add + preview rows can set times; list rows display them.

- [ ] **Step 1: index.html** — replace the `add-row` div with:

```html
    <div class="add-row">
      <input id="entry-date" type="date" />
      <input id="entry-time" type="time" />
      <input id="entry-end" type="time" hidden />
      <button id="add-btn" type="button">Add</button>
    </div>
```

- [ ] **Step 2: app.js manual add** — add `time: document.getElementById('entry-time'), end: document.getElementById('entry-end'),` to `els`. Show the end input once a start time is chosen:

```js
els.time.addEventListener('input', () => { els.end.hidden = !els.time.value; if (!els.time.value) els.end.value = ''; });
```

Update `handleManualAdd`:

```js
function handleManualAdd() {
  const title = els.text.value.trim();
  const date = els.date.value;
  if (!title || !date) { setMessage('For manual add, type a title and pick a date.'); return; }
  try {
    addItems([{ title, date, type: 'general', time: els.time.value || null, endTime: els.end.value || null }]);
  } catch (e) { setMessage(e.message); return; }
  els.text.value = ''; els.date.value = ''; els.time.value = ''; els.end.value = ''; els.end.hidden = true;
  setMessage('Added.');
}
```

(`<input type="time">` yields `"HH:MM"`, matching `makeItem`; an end-before-start still throws and is shown via the message line.)

- [ ] **Step 3: List rows show times** — in `renderList`, after the `info` span:

```js
    if (it.time) {
      const t = document.createElement('div');
      t.className = 'time-line';
      t.textContent = it.endTime ? formatTimeRange(it.time, it.endTime) : formatTime(it.time);
      main.appendChild(t);
    }
```

with `formatTime, formatTimeRange` added to the `./timegrid.js` import in `app.js`.

- [ ] **Step 4: preview.js time editing** — inside the row builder in `renderPreview`, after the `date` input:

```js
    const times = document.createElement('div');
    times.className = 'preview-times';
    const time = document.createElement('input');
    time.type = 'time';
    time.value = it.time || '';
    time.addEventListener('input', () => { draft[i].time = time.value || null; if (!time.value) { end.value = ''; draft[i].endTime = null; } });
    const end = document.createElement('input');
    end.type = 'time';
    end.value = it.endTime || '';
    end.addEventListener('input', () => { draft[i].endTime = end.value || null; });
    times.append(time, end);
```

and change `row.append(title, date, type)` to `row.append(title, date, type, times)` — update `.preview-row` grid in `styles.css` to `grid-template-columns: 1fr auto;` with the times div wrapping (already set in Task 6's CSS; adjust if cramped on iPhone width).

Also guard confirm: in `app.js` `addItems`, wrap the `makeItem` call so one bad row doesn't half-add (validation errors surface via message):

```js
function addItems(list) {
  const made = list.map((it) => makeItem(it, { id: uid(), createdAt: toISO(new Date()) }));
  items.push(...made);
  saveItems(items);
  render();
}
```

(All-or-nothing: `makeItem` throws before anything is pushed. Callers already catch/message.) Wrap the smart-add `direct` branch and preview `onConfirm` in try/catch showing `e.message`, same as manual add.

- [ ] **Step 5: Verify** — `npm test` green; `node --check js/app.js js/preview.js`; manual: add "Dentist" with date + 14:00–15:00 → list shows "2:00–3:00 PM", day view shows the block; preview flow (multi-item smart add) shows editable time boxes; end-before-start shows the validation message and adds nothing.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app.js js/preview.js styles.css
git commit -m "feat: time inputs in manual add, preview editing, and list display"
```

---

### Task 12: Service worker, deploy, end-to-end verification

**Files:**
- Modify: `service-worker.js`

**Interfaces:**
- Consumes: everything. All new files exist by now (precaching a missing file would fail the SW install — this is why this task is last).

- [ ] **Step 1: Update `service-worker.js`** — bump the cache name and add the new modules:

```js
const CACHE = 'plaenicke-v3';
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.json',
  'js/app.js', 'js/storage.js', 'js/items.js', 'js/dateparse.js', 'js/calendar.js',
  'js/config.js', 'js/smartadd.js', 'js/preview.js', 'js/voice.js',
  'js/timegrid.js', 'js/theme.js', 'js/settings.js', 'js/dayview.js', 'js/weekview.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];
```

- [ ] **Step 2: Full local check**

Run: `npm test && (cd worker && npm test) && for f in js/*.js worker/src/*.js service-worker.js; do node --check "$f" || exit 1; done`
Expected: all tests pass, all files parse.

- [ ] **Step 3: Deploy worker**

Run: `cd worker && npx wrangler deploy`
Expected: deploys to plaenicke-worker.lucky-star-0281.workers.dev. (Alex is logged into wrangler; if auth fails, stop and ask him to run it in a real terminal — see handoff Traps re: wrangler + secrets.)

- [ ] **Step 4: Live worker verification** — real calls, check time extraction:

```bash
TODAY=$(date +%F)
for note in "dentist at 2pm tomorrow" "meeting friday 9 to 10:30" "essay due friday"; do
  curl -s https://plaenicke-worker.lucky-star-0281.workers.dev \
    -H 'content-type: application/json' \
    -d "{\"text\": \"$note\", \"today\": \"$TODAY\"}"; echo;
done
```

Expected: first → `"time":"14:00"`, no endTime; second → `"time":"09:00","endTime":"10:30"`; third → `"time":null,"endTime":null`. If Haiku returns wrong shapes, tune `SYSTEM` in `worker/src/prompt.js` (never loosen the normalizer) and redeploy.

- [ ] **Step 5: Commit + push (deploys Pages)**

```bash
git add service-worker.js
git commit -m "feat: precache V3 modules, bump SW cache"
git push
```

- [ ] **Step 6: Live click-through checklist** (with Alex, on the deployed site or his iPhone):
  - Paper theme everywhere; ⚙ → Dark switches instantly, persists after reload; Auto follows the phone.
  - Smart add "dentist at 2pm tomorrow" → item lands with 2:00 PM; day view shows it.
  - Month: busy day shows `+N more`, tap opens Day. Week: colored blocks, tap opens Day. Day: blocks/pins/Other tasks, arrows navigate.
  - Manual add with and without times; delete from list and day view.
  - Old items (added before V3) still visible and untimed.

---

## Self-review notes (done at plan time)

- Spec coverage: data model (T1), timegrid math (T2), month fix (T3+T8), worker (T4+T5), theme+manifest (T6), settings (T7), views (T8–T10), add flows incl. preview + list time display (T11), SW/deploy/E2E (T12). "Out of scope" items have no tasks — correct.
- The `#item-list` ID-reuse bug in dayview was caught and fixed inline (`.day-other-list` class + shared selectors).
- Type consistency: `time`/`endTime` names identical across items.js, normalize.js, prompt schema, preview drafts, and view renderers; `openDay` defined in T8, consumed in T9/T10.
