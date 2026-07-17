# plaenicke V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal iPhone home-screen web app that lets you add dated items (by typing, dictating, or a "smart" sentence), shows them as a soonest-first list and a month calendar, and saves them on the phone.

**Architecture:** Plain HTML + CSS + JavaScript ES modules, no frameworks and no build tools. Pure logic (date parsing, item model, storage serialize, calendar math) lives in small importable modules that are unit-tested with Node's built-in test runner. The browser-only glue (DOM, events, localStorage, service worker) is verified manually with checklists.

**Tech Stack:** HTML5, CSS3, vanilla JavaScript (ES modules), Node.js built-in test runner (`node --test`) for tests, Python 3 `http.server` for local preview, a free static host for iPhone install.

## Global Constraints

- Target platform: iPhone Safari, installed via Add to Home Screen (PWA). Mobile-first layout.
- No build tools, no bundlers, no frameworks. Files run as-authored.
- No external/CDN runtime dependencies (must work offline once installed).
- ES modules everywhere (`import`/`export`); browser loads via `<script type="module">`.
- Dates are stored as ISO strings `YYYY-MM-DD`.
- localStorage key: `plaenicke.items`.
- **Zero silent fallback:** if the smart-add can't find a date, the app asks the user to pick one — it never guesses a date.
- Node's test runner only; no test-framework installs.

---

## File Structure

```
plaenicke/
  index.html            # page structure (add box, list view, calendar view, toggle)
  styles.css            # all styling, mobile-first
  manifest.json         # PWA metadata (name, icons, full-screen)
  service-worker.js     # minimal offline/install worker
  icons/
    icon-192.png        # home-screen icon
    icon-512.png        # splash/large icon
  js/
    app.js              # glue: DOM, events, wiring (browser-only, manual test)
    storage.js          # serialize/deserialize (pure, tested) + load/save (browser)
    items.js            # makeItem, sortItemsByDate (pure, tested)
    dateparse.js        # parseSmartAdd, toISO (pure, tested) — the SINGLE spot Claude replaces later
    calendar.js         # buildMonthGrid, groupItemsByDate (pure, tested) + used by app.js render
  tests/
    items.test.js
    dateparse.test.js
    storage.test.js
    calendar.test.js
  package.json          # { "type": "module", "scripts": { "test": "node --test" } }
```

**Responsibility split:** each `js/` module has one job. `app.js` is the only file that touches the DOM. `storage.js` is the only file that touches localStorage. `dateparse.js` is the only file that turns text into a date — that isolation is what makes the later Claude upgrade a one-file change.

---

### Task 1: Project scaffold + test runner works

**Files:**
- Create: `package.json`
- Create: `tests/smoke.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm test` command using `node --test`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "plaenicke",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Write a smoke test at `tests/smoke.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run the test suite**

Run: `cd /Users/ajaenicke25/projects/plaenicke && npm test`
Expected: PASS — output shows `tests 1`, `pass 1`, `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add package.json tests/smoke.test.js
git commit -m "chore: scaffold project and verify node test runner"
```

---

### Task 2: Item model (`items.js`)

**Files:**
- Create: `js/items.js`
- Test: `tests/items.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `makeItem(title: string, date: string, meta: { id: string, createdAt: string }) -> { id, title, date, createdAt }` — trims title, throws `Error('Title is required')` if empty after trim.
  - `sortItemsByDate(items: Item[]) -> Item[]` — new array sorted ascending by `date`, ties broken by `createdAt` then `title`.

- [ ] **Step 1: Write failing tests at `tests/items.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeItem, sortItemsByDate } from '../js/items.js';

test('makeItem builds an item and trims the title', () => {
  const it = makeItem('  Bio midterm  ', '2026-07-02', { id: 'a', createdAt: '2026-07-01' });
  assert.deepEqual(it, { id: 'a', title: 'Bio midterm', date: '2026-07-02', createdAt: '2026-07-01' });
});

test('makeItem rejects an empty title', () => {
  assert.throws(() => makeItem('   ', '2026-07-02', { id: 'a', createdAt: '2026-07-01' }),
    /Title is required/);
});

test('sortItemsByDate orders soonest first without mutating input', () => {
  const input = [
    { id: '1', title: 'B', date: '2026-07-10', createdAt: '2026-07-01' },
    { id: '2', title: 'A', date: '2026-07-02', createdAt: '2026-07-01' },
  ];
  const sorted = sortItemsByDate(input);
  assert.deepEqual(sorted.map(i => i.id), ['2', '1']);
  assert.equal(input[0].id, '1'); // original unchanged
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test`
Expected: FAIL — cannot import from `../js/items.js` (module missing).

- [ ] **Step 3: Implement `js/items.js`**

```js
// items.js — the shape of a saved item and how to order items.

export function makeItem(title, date, meta) {
  const clean = (title || '').trim();
  if (!clean) throw new Error('Title is required');
  return { id: meta.id, title: clean, date, createdAt: meta.createdAt };
}

export function sortItemsByDate(items) {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test`
Expected: PASS — all item tests green.

- [ ] **Step 5: Commit**

```bash
git add js/items.js tests/items.test.js
git commit -m "feat: item model with makeItem and sortItemsByDate"
```

---

### Task 3: Smart-add date parser (`dateparse.js`)

**Files:**
- Create: `js/dateparse.js`
- Test: `tests/dateparse.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toISO(d: Date) -> string` — local-date `YYYY-MM-DD`.
  - `parseSmartAdd(text: string, today: Date) -> { title: string, date: string | null }` — extracts a date and the leftover title. Returns `date: null` when no date is recognized (caller must ask the user). Handles: ISO `YYYY-MM-DD`, `today`, `tomorrow`, `in N days`, and `<month> <day>` where day is a number or an ordinal word ("second", "twenty-first"). A `<month> <day>` in the past resolves to next year.

- [ ] **Step 1: Write failing tests at `tests/dateparse.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmartAdd, toISO } from '../js/dateparse.js';

const JUNE_1 = new Date(2026, 5, 1); // months are 0-based: 5 = June

test('toISO formats a local date', () => {
  assert.equal(toISO(new Date(2026, 6, 2)), '2026-07-02');
});

test('parses the ordinal-word example', () => {
  const r = parseSmartAdd('physics assignment due July second', JUNE_1);
  assert.equal(r.title, 'physics assignment');
  assert.equal(r.date, '2026-07-02');
});

test('parses a numeric month/day', () => {
  const r = parseSmartAdd('Bio midterm on July 2', JUNE_1);
  assert.equal(r.title, 'Bio midterm');
  assert.equal(r.date, '2026-07-02');
});

test('parses tomorrow', () => {
  const r = parseSmartAdd('call mom tomorrow', JUNE_1);
  assert.equal(r.date, '2026-06-02');
});

test('parses in N days', () => {
  const r = parseSmartAdd('gym in 3 days', JUNE_1);
  assert.equal(r.date, '2026-06-04');
});

test('parses an ISO date', () => {
  const r = parseSmartAdd('essay 2026-09-15', JUNE_1);
  assert.equal(r.date, '2026-09-15');
});

test('a past month/day rolls to next year', () => {
  const r = parseSmartAdd('reunion May 1', JUNE_1); // May 1 already passed
  assert.equal(r.date, '2027-05-01');
});

test('no date returns null and keeps the text as the title', () => {
  const r = parseSmartAdd('buy groceries', JUNE_1);
  assert.equal(r.date, null);
  assert.equal(r.title, 'buy groceries');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test`
Expected: FAIL — cannot import from `../js/dateparse.js`.

- [ ] **Step 3: Implement `js/dateparse.js`**

```js
// dateparse.js
// Turns a sentence like "physics assignment due July second" into { title, date }.
// THIS IS THE SINGLE SPOT that Claude-powered parsing will replace later.
// V1 handles: ISO dates, "today", "tomorrow", "in N days", and "<month> <day>".

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const SMALL_ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
const TENS = { twenty: 20, thirty: 30 };

export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// Replace ordinal words ("second", "twenty-first") with digits, preserving other text/case.
function normalizeOrdinals(text) {
  return text
    .replace(/\b(twenty|thirty)[- ](first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/gi,
      (_m, tens, ones) => String(TENS[tens.toLowerCase()] + SMALL_ORD[ones.toLowerCase()]))
    .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)\b/gi,
      (word) => String(SMALL_ORD[word.toLowerCase()]));
}

function monthIndex(name) {
  const n = name.toLowerCase().replace(/\.$/, '');
  const i = MONTHS.indexOf(n);
  return i !== -1 ? i : MONTH_ABBR.indexOf(n);
}

function resolveMonthDay(mIndex, day, today) {
  let candidate = new Date(today.getFullYear(), mIndex, day);
  if (toISO(candidate) < toISO(today)) {
    candidate = new Date(today.getFullYear() + 1, mIndex, day);
  }
  return toISO(candidate);
}

// Find a date expression in text. Returns { iso, index, length } or null.
function findDate(text, today) {
  let m;

  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}`, index: m.index, length: m[0].length };

  m = text.match(/\b(today|tomorrow)\b/i);
  if (m) {
    const d = addDays(today, m[1].toLowerCase() === 'tomorrow' ? 1 : 0);
    return { iso: toISO(d), index: m.index, length: m[0].length };
  }

  m = text.match(/\bin (\d+) days?\b/i);
  if (m) return { iso: toISO(addDays(today, parseInt(m[1], 10))), index: m.index, length: m[0].length };

  const monthPat = MONTHS.concat(MONTH_ABBR).join('|');
  m = text.match(new RegExp(`\\b(${monthPat})\\.?\\s+(\\d{1,2})\\b`, 'i'));
  if (m) {
    const mi = monthIndex(m[1]);
    const day = parseInt(m[2], 10);
    if (mi !== -1 && day >= 1 && day <= 31) {
      return { iso: resolveMonthDay(mi, day, today), index: m.index, length: m[0].length };
    }
  }
  return null;
}

function cleanTitle(s) {
  let out = s.replace(/\s+/g, ' ').trim();
  out = out.replace(/[\s,]*\b(due on|due by|due|on|by|at)\b[\s,]*$/i, '').trim();
  out = out.replace(/^[\s,]*\b(due|on|by|at)\b[\s,]*/i, '').trim();
  return out;
}

export function parseSmartAdd(text, today) {
  const norm = normalizeOrdinals(text);
  const found = findDate(norm, today);
  if (!found) return { title: cleanTitle(norm), date: null };
  const remainder = norm.slice(0, found.index) + ' ' + norm.slice(found.index + found.length);
  return { title: cleanTitle(remainder), date: found.iso };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test`
Expected: PASS — all dateparse tests green.

- [ ] **Step 5: Commit**

```bash
git add js/dateparse.js tests/dateparse.test.js
git commit -m "feat: smart-add date parser (single replaceable spot)"
```

---

### Task 4: Storage (`storage.js`)

**Files:**
- Create: `js/storage.js`
- Test: `tests/storage.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `serializeItems(items) -> string` (JSON).
  - `deserializeItems(json: string | null) -> Item[]` — returns `[]` for null/invalid/corrupt JSON, and drops malformed entries (each kept entry must have string `id`, `title`, `date`).
  - `loadItems() -> Item[]` (browser: reads localStorage key `plaenicke.items`).
  - `saveItems(items) -> void` (browser: writes that key).

Note: `loadItems`/`saveItems` touch `localStorage` and are verified manually in Task 7 (localStorage is browser-only). The pure `serializeItems`/`deserializeItems` are unit-tested here.

- [ ] **Step 1: Write failing tests at `tests/storage.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeItems, deserializeItems } from '../js/storage.js';

const ITEM = { id: 'a', title: 'Bio', date: '2026-07-02', createdAt: '2026-07-01' };

test('serialize then deserialize round-trips', () => {
  assert.deepEqual(deserializeItems(serializeItems([ITEM])), [ITEM]);
});

test('deserialize returns [] for null', () => {
  assert.deepEqual(deserializeItems(null), []);
});

test('deserialize returns [] for corrupt JSON', () => {
  assert.deepEqual(deserializeItems('{not json'), []);
});

test('deserialize drops malformed entries', () => {
  const json = JSON.stringify([ITEM, { id: 5 }, { title: 'no id' }]);
  assert.deepEqual(deserializeItems(json), [ITEM]);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test`
Expected: FAIL — cannot import from `../js/storage.js`.

- [ ] **Step 3: Implement `js/storage.js`**

```js
// storage.js — the ONLY file that touches localStorage.

const STORAGE_KEY = 'plaenicke.items';

export function serializeItems(items) {
  return JSON.stringify(items);
}

export function deserializeItems(json) {
  if (!json) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(it =>
    it &&
    typeof it.id === 'string' &&
    typeof it.title === 'string' &&
    typeof it.date === 'string');
}

export function loadItems() {
  return deserializeItems(localStorage.getItem(STORAGE_KEY));
}

export function saveItems(items) {
  localStorage.setItem(STORAGE_KEY, serializeItems(items));
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test`
Expected: PASS — all storage tests green.

- [ ] **Step 5: Commit**

```bash
git add js/storage.js tests/storage.test.js
git commit -m "feat: storage serialize/deserialize with corruption guards"
```

---

### Task 5: Calendar math (`calendar.js`)

**Files:**
- Create: `js/calendar.js`
- Test: `tests/calendar.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildMonthGrid(year: number, month: number) -> Cell[][]` — `month` is 0-based. Returns weeks of 7 cells. A cell is `null` (blank pad) or `{ day: number, date: string }`.
  - `groupItemsByDate(items) -> { [date: string]: Item[] }`.

- [ ] **Step 1: Write failing tests at `tests/calendar.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthGrid, groupItemsByDate } from '../js/calendar.js';

test('July 2026 grid starts on the right weekday', () => {
  // July 1 2026 is a Wednesday (index 3): three leading blanks.
  const weeks = buildMonthGrid(2026, 6);
  assert.equal(weeks[0][0], null);
  assert.equal(weeks[0][1], null);
  assert.equal(weeks[0][2], null);
  assert.deepEqual(weeks[0][3], { day: 1, date: '2026-07-01' });
});

test('grid weeks are all length 7', () => {
  const weeks = buildMonthGrid(2026, 6);
  for (const w of weeks) assert.equal(w.length, 7);
});

test('grid contains all 31 days of July', () => {
  const days = buildMonthGrid(2026, 6).flat().filter(Boolean).map(c => c.day);
  assert.equal(days.length, 31);
  assert.equal(days[30], 31);
});

test('groupItemsByDate buckets by date', () => {
  const items = [
    { id: '1', title: 'A', date: '2026-07-02', createdAt: 'x' },
    { id: '2', title: 'B', date: '2026-07-02', createdAt: 'x' },
    { id: '3', title: 'C', date: '2026-07-05', createdAt: 'x' },
  ];
  const grouped = groupItemsByDate(items);
  assert.equal(grouped['2026-07-02'].length, 2);
  assert.equal(grouped['2026-07-05'].length, 1);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test`
Expected: FAIL — cannot import from `../js/calendar.js`.

- [ ] **Step 3: Implement `js/calendar.js`**

```js
// calendar.js — pure month-grid math and item bucketing.

export function buildMonthGrid(year, month) {
  const startDow = new Date(year, month, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, date });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function groupItemsByDate(items) {
  const map = {};
  for (const it of items) {
    (map[it.date] = map[it.date] || []).push(it);
  }
  return map;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test`
Expected: PASS — all calendar tests green.

- [ ] **Step 5: Commit**

```bash
git add js/calendar.js tests/calendar.test.js
git commit -m "feat: calendar month-grid math and item bucketing"
```

---

### Task 6: Page shell (`index.html` + `styles.css`)

**Files:**
- Create: `index.html`
- Create: `styles.css`

**Interfaces:**
- Consumes: nothing yet (script wired in Task 7).
- Produces: DOM element IDs that `app.js` relies on: `entry-text`, `entry-date`, `add-btn`, `message`, `show-list`, `show-calendar`, `list-view`, `item-list`, `calendar-view`, `prev-month`, `next-month`, `calendar-label`, `calendar-grid`.

This is a browser/visual task — verified by eye, not by `node --test`.

- [ ] **Step 1: Create `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="default" />
  <title>plaenicke</title>
  <link rel="manifest" href="manifest.json" />
  <link rel="apple-touch-icon" href="icons/icon-192.png" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header>
    <h1>plaenicke</h1>
  </header>

  <section class="add-box">
    <input id="entry-text" type="text" autocomplete="off"
           placeholder="e.g. physics assignment due July second" />
    <div class="add-row">
      <input id="entry-date" type="date" />
      <button id="add-btn" type="button">Add</button>
    </div>
    <p id="message" class="message" role="status"></p>
  </section>

  <nav class="view-toggle">
    <button id="show-list" type="button" class="active">List</button>
    <button id="show-calendar" type="button">Calendar</button>
  </nav>

  <section id="list-view">
    <ul id="item-list"></ul>
  </section>

  <section id="calendar-view" hidden>
    <div class="cal-controls">
      <button id="prev-month" type="button">&larr;</button>
      <span id="calendar-label"></span>
      <button id="next-month" type="button">&rarr;</button>
    </div>
    <div id="calendar-grid" class="calendar-grid"></div>
  </section>

  <script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `styles.css`**

```css
:root {
  --bg: #f6f7f9;
  --card: #ffffff;
  --ink: #1d2129;
  --muted: #6b7280;
  --accent: #2f6fed;
  --danger: #d64545;
  --line: #e3e6ea;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: -apple-system, system-ui, sans-serif;
  background: var(--bg);
  color: var(--ink);
  padding: env(safe-area-inset-top) 16px 40px;
}

header h1 { font-size: 1.6rem; margin: 16px 0; }

.add-box {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px;
  margin-bottom: 16px;
}

#entry-text {
  width: 100%;
  font-size: 1rem;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.add-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

#entry-date {
  flex: 1;
  font-size: 1rem;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
}

button {
  font-size: 1rem;
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
}

.message { color: var(--muted); min-height: 1.2em; margin: 8px 0 0; }

.view-toggle { display: flex; gap: 8px; margin-bottom: 12px; }
.view-toggle button { background: var(--card); color: var(--ink); border: 1px solid var(--line); }
.view-toggle button.active { background: var(--accent); color: #fff; border-color: var(--accent); }

#item-list { list-style: none; padding: 0; margin: 0; }
#item-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 8px;
}
#item-list li.empty { color: var(--muted); justify-content: center; }
button.delete { background: transparent; color: var(--danger); padding: 6px 10px; }

.cal-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.cal-controls span { font-weight: 600; }
.cal-controls button { background: var(--card); color: var(--ink); border: 1px solid var(--line); }

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.cal-head { text-align: center; font-size: 0.75rem; color: var(--muted); padding: 4px 0; }
.cal-cell {
  min-height: 64px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 4px;
  font-size: 0.75rem;
}
.cal-cell.blank { background: transparent; border: none; }
.cal-cell.today { border-color: var(--accent); }
.cal-day { font-weight: 600; margin-bottom: 2px; }
.cal-item {
  background: var(--accent);
  color: #fff;
  border-radius: 4px;
  padding: 1px 4px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 3: Preview in the browser**

Run: `cd /Users/ajaenicke25/projects/plaenicke && python3 -m http.server 8000`
Then open `http://localhost:8000` in Safari.
Expected (manual check):
- [ ] Title "plaenicke" shows.
- [ ] A text box with the placeholder, a date picker, and an "Add" button show.
- [ ] "List" / "Calendar" toggle buttons show; List is highlighted.
- [ ] The list area and (hidden) calendar area exist. (Buttons do nothing yet — that's Task 7.)
Stop the server with Ctrl+C when done.

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat: page shell and mobile-first styles"
```

---

### Task 7: App glue — add, list, delete, persist (`app.js`)

**Files:**
- Create: `js/app.js`

**Interfaces:**
- Consumes: `loadItems`, `saveItems` (storage.js); `makeItem`, `sortItemsByDate` (items.js); `parseSmartAdd`, `toISO` (dateparse.js); `buildMonthGrid`, `groupItemsByDate` (calendar.js — calendar render added in Task 8, imported now).
- Produces: a working add/list/delete/persist loop plus a `showView(which)` and `render()` used by Task 8.

Browser/visual task — verified by checklist.

- [ ] **Step 1: Create `js/app.js`**

```js
import { loadItems, saveItems } from './storage.js';
import { makeItem, sortItemsByDate } from './items.js';
import { parseSmartAdd, toISO } from './dateparse.js';
import { buildMonthGrid, groupItemsByDate } from './calendar.js';

const els = {
  text: document.getElementById('entry-text'),
  date: document.getElementById('entry-date'),
  add: document.getElementById('add-btn'),
  message: document.getElementById('message'),
  showList: document.getElementById('show-list'),
  showCal: document.getElementById('show-calendar'),
  listView: document.getElementById('list-view'),
  list: document.getElementById('item-list'),
  calView: document.getElementById('calendar-view'),
  prev: document.getElementById('prev-month'),
  next: document.getElementById('next-month'),
  calLabel: document.getElementById('calendar-label'),
  calGrid: document.getElementById('calendar-grid'),
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let items = loadItems();
let viewMonth = new Date();

function uid() {
  return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

function setMessage(text) {
  els.message.textContent = text || '';
}

function handleAdd() {
  const raw = els.text.value;
  const parsed = parseSmartAdd(raw, new Date());
  const title = parsed.title || raw.trim();
  const date = parsed.date || els.date.value || '';

  if (!title) { setMessage('Please enter a title.'); return; }
  if (!date) {
    setMessage("I couldn't find a date in that — please pick one below.");
    els.date.focus();
    return;
  }

  items.push(makeItem(title, date, { id: uid(), createdAt: toISO(new Date()) }));
  saveItems(items);
  els.text.value = '';
  els.date.value = '';
  setMessage('Added.');
  render();
}

function deleteItem(id) {
  items = items.filter(it => it.id !== id);
  saveItems(items);
  render();
}

function renderList() {
  const sorted = sortItemsByDate(items);
  els.list.innerHTML = '';
  if (sorted.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Add something above.';
    els.list.appendChild(li);
    return;
  }
  for (const it of sorted) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.textContent = `${it.date} — ${it.title}`;
    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteItem(it.id));
    li.append(info, del);
    els.list.appendChild(li);
  }
}

function renderCalendar() {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  els.calLabel.textContent = `${MONTH_NAMES[month]} ${year}`;

  const weeks = buildMonthGrid(year, month);
  const byDate = groupItemsByDate(items);
  const todayISO = toISO(new Date());

  els.calGrid.innerHTML = '';
  for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    const h = document.createElement('div');
    h.className = 'cal-head';
    h.textContent = d;
    els.calGrid.appendChild(h);
  }
  for (const week of weeks) {
    for (const cell of week) {
      const div = document.createElement('div');
      div.className = 'cal-cell';
      if (!cell) {
        div.classList.add('blank');
        els.calGrid.appendChild(div);
        continue;
      }
      if (cell.date === todayISO) div.classList.add('today');
      const num = document.createElement('div');
      num.className = 'cal-day';
      num.textContent = cell.day;
      div.appendChild(num);
      for (const it of byDate[cell.date] || []) {
        const chip = document.createElement('div');
        chip.className = 'cal-item';
        chip.textContent = it.title;
        div.appendChild(chip);
      }
      els.calGrid.appendChild(div);
    }
  }
}

function render() {
  renderList();
  renderCalendar();
}

function showView(which) {
  const isList = which === 'list';
  els.listView.hidden = !isList;
  els.calView.hidden = isList;
  els.showList.classList.toggle('active', isList);
  els.showCal.classList.toggle('active', !isList);
}

els.add.addEventListener('click', handleAdd);
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdd(); });
els.showList.addEventListener('click', () => showView('list'));
els.showCal.addEventListener('click', () => showView('calendar'));
els.prev.addEventListener('click', () => {
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
  renderCalendar();
});
els.next.addEventListener('click', () => {
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
  renderCalendar();
});

render();
```

- [ ] **Step 2: Preview and verify by checklist**

Run: `cd /Users/ajaenicke25/projects/plaenicke && python3 -m http.server 8000`
Open `http://localhost:8000` in Safari. Check:
- [ ] Type `physics assignment due July second`, click Add → an item `…-07-02 — physics assignment` appears in the list.
- [ ] Reload the page → the item is still there (persistence works).
- [ ] Type `buy groceries` (no date), click Add → message says it couldn't find a date and the date box is focused; pick a date, click Add → item appears.
- [ ] Type a title, leave text and date empty → clicking Add shows "Please enter a title."
- [ ] Click Delete on an item → it disappears and stays gone after reload.
Stop the server with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add js/app.js
git commit -m "feat: add/list/delete/persist glue with smart-add flow"
```

---

### Task 8: Calendar view wiring (verify render + toggle)

**Files:**
- Modify: none (calendar render + toggle already implemented in Task 7).

This task is a dedicated verification gate for the calendar view, so a reviewer can accept/reject calendar behavior independently.

- [ ] **Step 1: Preview and verify the calendar by checklist**

Run: `cd /Users/ajaenicke25/projects/plaenicke && python3 -m http.server 8000`
Open `http://localhost:8000` in Safari. Ensure at least one item exists (add `essay 2026-09-15` if needed). Check:
- [ ] Click the "Calendar" toggle → the list hides, the calendar shows, "Calendar" is highlighted.
- [ ] The month label and weekday headers (Sun…Sat) show; day 1 sits under the correct weekday.
- [ ] An item appears as a chip on its correct day.
- [ ] The ← / → buttons move to the previous/next month and the label updates.
- [ ] Today's cell has a highlighted (accent) border in the current month.
- [ ] Click "List" → the calendar hides and the list returns.
Stop the server with Ctrl+C.

- [ ] **Step 2: Commit (only if any tweak was needed)**

If a fix was required, commit it:
```bash
git add -A
git commit -m "fix: calendar view adjustments from verification"
```
If nothing needed changing, note "calendar verified, no changes" and proceed.

---

### Task 9: Make it installable (PWA)

**Files:**
- Create: `manifest.json`
- Create: `service-worker.js`
- Create: `icons/icon-192.png`, `icons/icon-512.png`
- Modify: `js/app.js` (register the service worker)

**Interfaces:**
- Consumes: existing files.
- Produces: an installable app (Add to Home Screen shows a name + icon; opens full-screen).

- [ ] **Step 1: Create `manifest.json`**

```json
{
  "name": "plaenicke",
  "short_name": "plaenicke",
  "start_url": ".",
  "display": "standalone",
  "background_color": "#f6f7f9",
  "theme_color": "#2f6fed",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 2: Create the two icons**

Generate simple solid-color PNG icons with Python (no design tools needed):
```bash
cd /Users/ajaenicke25/projects/plaenicke && mkdir -p icons && python3 - <<'PY'
import struct, zlib

def png(path, size, rgb):
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    row = b'\x00' + bytes(rgb) * size
    raw = row * size
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))

png('icons/icon-192.png', 192, (47, 111, 237))
png('icons/icon-512.png', 512, (47, 111, 237))
print('icons written')
PY
```
Expected: `icons written`, and `icons/icon-192.png` + `icons/icon-512.png` exist.

- [ ] **Step 3: Create `service-worker.js`**

```js
// Minimal service worker: needed so iOS treats this as an installable app.
// Caches the core files so it opens offline.
const CACHE = 'plaenicke-v1';
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.json',
  'js/app.js', 'js/storage.js', 'js/items.js', 'js/dateparse.js', 'js/calendar.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
```

- [ ] **Step 4: Register the worker — add to the very end of `js/app.js`**

```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js');
  });
}
```

- [ ] **Step 5: Verify install works on the Mac first**

Run: `cd /Users/ajaenicke25/projects/plaenicke && python3 -m http.server 8000`
Open `http://localhost:8000` in Safari. Check:
- [ ] The app still loads and works (add/list/calendar).
- [ ] In Safari, open the Develop or page-info tools and confirm no red console errors, and that a service worker registered. (If Develop menu is off: Safari → Settings → Advanced → "Show features for web developers".)
Stop the server with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add manifest.json service-worker.js icons js/app.js
git commit -m "feat: PWA manifest, icons, and service worker for install"
```

---

### Task 10: Put it on your iPhone

**Files:** none (deployment + on-device verification).

This task has no code — it gets the app onto the phone and confirms the whole thing end-to-end. A free static host is used because iOS requires HTTPS to install a PWA.

- [ ] **Step 1: Push the project to GitHub**

```bash
cd /Users/ajaenicke25/projects/plaenicke
gh repo create plaenicke --private --source=. --remote=origin --push
```
(If `gh` is not set up, the assistant will guide an alternative.)

- [ ] **Step 2: Deploy to a free static host**

Use Cloudflare Pages or Netlify (both free, both give HTTPS):
- Connect the `plaenicke` GitHub repo.
- Framework preset: **None / static**. Build command: **(leave empty)**. Output directory: **`/`** (the repo root).
- Deploy → you get an HTTPS URL like `https://plaenicke.pages.dev`.

- [ ] **Step 3: Install on the iPhone**

- [ ] Open the HTTPS URL in **iPhone Safari**.
- [ ] Tap **Share → Add to Home Screen → Add**.
- [ ] Launch it from the home-screen icon → it opens full-screen (no Safari bar).

- [ ] **Step 4: End-to-end verification on the phone**

- [ ] Tap the text box, tap the keyboard **mic**, say "physics assignment due July second" → it types the sentence; tap Add → the item appears.
- [ ] Close the app fully and reopen from the icon → the item is still there.
- [ ] Switch to Calendar → the item shows on its day; month arrows work.
- [ ] Delete the item → it's gone and stays gone after reopening.

- [ ] **Step 5: Tag the release**

```bash
cd /Users/ajaenicke25/projects/plaenicke
git tag v1.0
git push origin v1.0
```

---

## Self-Review

**Spec coverage:**
- Add item (title + date): Tasks 2, 7. ✓
- Type / dictate / smart-add sentence: dictation is the iOS keyboard mic (Task 10 verify); smart-add parsing Task 3; wiring Task 7. ✓
- List, soonest first: Tasks 2 (`sortItemsByDate`), 7. ✓
- Basic month calendar: Tasks 5, 7, 8. ✓
- Saved on phone: Tasks 4, 7. ✓
- Delete: Task 7. ✓
- Installable to home screen: Task 9, 10. ✓
- Error handling — no silent date fallback: Task 3 (`date: null`) + Task 7 (asks user). ✓ Empty title refused: Task 7. ✓ Corrupt storage → empty list: Task 4. ✓
- Run locally + deploy + install: Tasks 6/7 preview, Task 10 deploy. ✓

**Deviation from spec (intentional, flagged):** the spec named a "vendored date library"; this plan uses a small hand-written parser in `dateparse.js` instead — same interface, same single-replaceable-spot, no build-tool friction, fully unit-tested. Weekday phrases ("next Tuesday") are deferred to a later version.

**Placeholder scan:** none — every step has concrete code or exact commands.

**Type consistency:** `makeItem`, `sortItemsByDate`, `parseSmartAdd`, `toISO`, `serializeItems`, `deserializeItems`, `loadItems`, `saveItems`, `buildMonthGrid`, `groupItemsByDate` are used with the same signatures in Tasks 7–8 as defined in Tasks 2–5. Item shape `{ id, title, date, createdAt }` is consistent across items.js, storage.js, and app.js.
