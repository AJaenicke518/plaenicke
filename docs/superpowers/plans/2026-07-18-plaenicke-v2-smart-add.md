# plaenicke V2 Implementation Plan — Claude-Powered Smart Add

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the on-device parser with Claude (via a Cloudflare Worker) so one messy input becomes multiple typed, tagged, color-coded calendar items, with a confirm step that only appears when the input is complex.

**Architecture:** A new Cloudflare Worker holds the Anthropic API key and calls the Claude Messages API with **structured JSON output**. The existing GitHub Pages frontend sends raw text to the Worker, applies a confirm rule (single confident item → add directly; else → editable preview), and colors items by type. Pure logic (prompt building, response normalizing, the confirm decision, the extended item model) is unit-tested with `node --test`; the Worker HTTP layer and the DOM are verified manually / end-to-end.

**Tech Stack:** Cloudflare Workers (single ES module, deployed with `wrangler`), Anthropic Messages API (`claude-haiku-4-5`, structured outputs), vanilla JS frontend (unchanged stack), Node built-in test runner.

## Global Constraints

- Model: `claude-haiku-4-5` (user-chosen for cost). It does **not** accept the `effort` parameter or adaptive-thinking config — the Worker request must **not** send `output_config.effort` or a `thinking` field.
- Structured output via `output_config: { format: { type: "json_schema", schema: SCHEMA } }`.
- Anthropic auth: header `x-api-key: <secret>` + `anthropic-version: 2023-06-01`. Key stored as a Cloudflare Worker **secret** (`ANTHROPIC_API_KEY`), never in the repo or frontend.
- Item types (fixed): `due`, `start`, `milestone`, `event`. Legacy/absent type renders as `general`.
- Tags: `project`, `subject` (string|null), `category` (`School`|`Work`|`Personal`|null).
- Confirm rule: exactly one item AND `needsReview === false` → add directly; otherwise preview.
- Zero silent fallback: Worker/Claude failure → explicit message, manual inputs stay usable; no guessed dates; zero items → "couldn't find anything," no empty item created.
- Worker enforces a shared passphrase and restricts CORS to `https://ajaenicke518.github.io`.
- Existing V1 `node --test` suite must stay green.

---

## File Structure

```
plaenicke/
  worker/                       # NEW — the Cloudflare Worker (separate mini-project)
    package.json                #   { type: module, scripts: { test: "node --test" } }
    wrangler.toml               #   Worker config
    src/
      prompt.js                 #   pure: build the Anthropic request body (system + schema)
      normalize.js              #   pure: validate/clamp Claude's JSON → { items, needsReview }
      index.js                  #   Worker entry: HTTP, CORS, passphrase, calls Anthropic
    tests/
      prompt.test.js
      normalize.test.js
  js/
    config.js                   # NEW — WORKER_URL + passphrase storage helpers
    smartadd.js                 # NEW — decideFlow (pure) + parseViaWorker (browser fetch)
    preview.js                  # NEW — render the editable preview, collect confirmed items
    items.js                    # MODIFY — makeItem takes the new optional fields
    app.js                      # MODIFY — new add flow, colors, tags, error messaging
  tests/
    items.test.js               # MODIFY — new makeItem signature
    smartadd.test.js            # NEW — decideFlow tests
  index.html                    # MODIFY — passphrase field, preview container
  styles.css                    # MODIFY — type colors, tag chips, preview styling
```

---

### Task 1: Worker pure logic — prompt builder + normalizer

**Files:**
- Create: `worker/package.json`, `worker/src/prompt.js`, `worker/src/normalize.js`
- Test: `worker/tests/prompt.test.js`, `worker/tests/normalize.test.js`

**Interfaces:**
- Produces:
  - `buildRequestBody(text: string, todayISO: string) -> object` — the JSON body for `POST /v1/messages` (model, max_tokens, system, output_config.format schema, messages). No `effort`, no `thinking`.
  - `normalizeClaudeJson(raw: unknown) -> { items: Item[], needsReview: boolean }` — coerces/validates; drops items lacking a valid title or ISO date; clamps `type` to the allowed set (default `event`) and `category` to the allowed set (else `null`); forces `needsReview` true if any item was dropped.

- [ ] **Step 1: Create `worker/package.json`**

```json
{
  "name": "plaenicke-worker",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": { "test": "node --test" }
}
```

- [ ] **Step 2: Write `worker/tests/normalize.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeJson } from '../src/normalize.js';

const GOOD = {
  needsReview: false,
  items: [{ title: 'First draft', date: '2026-05-15', type: 'milestone',
    project: 'Physics paper', subject: 'Physics', category: 'School' }],
};

test('passes a well-formed single item through', () => {
  const r = normalizeClaudeJson(GOOD);
  assert.equal(r.needsReview, false);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, 'milestone');
});

test('drops items missing a valid ISO date and flags review', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'ok', date: '2026-05-15', type: 'due', project: null, subject: null, category: null },
    { title: 'bad', date: 'next week', type: 'due', project: null, subject: null, category: null },
  ]});
  assert.equal(r.items.length, 1);
  assert.equal(r.needsReview, true); // something was dropped
});

test('clamps an unknown type to event and unknown category to null', () => {
  const r = normalizeClaudeJson({ needsReview: false, items: [
    { title: 'x', date: '2026-05-15', type: 'submit', project: null, subject: null, category: 'Gym' },
  ]});
  assert.equal(r.items[0].type, 'event');
  assert.equal(r.items[0].category, null);
});

test('returns empty list for garbage input', () => {
  assert.deepEqual(normalizeClaudeJson(null), { items: [], needsReview: true });
  assert.deepEqual(normalizeClaudeJson({ items: 'nope' }), { items: [], needsReview: true });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `cd /Users/ajaenicke25/projects/plaenicke/worker && npm test`
Expected: FAIL — cannot import `../src/normalize.js`.

- [ ] **Step 4: Write `worker/src/normalize.js`**

```js
// normalize.js — turn Claude's raw JSON into a safe { items, needsReview }.
// Defensive on purpose: never trust the model's output shape blindly.

const TYPES = ['due', 'start', 'milestone', 'event'];
const CATEGORIES = ['School', 'Work', 'Personal'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function cleanStrOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function normalizeClaudeJson(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    return { items: [], needsReview: true };
  }
  const items = [];
  let dropped = false;
  for (const it of raw.items) {
    const title = it && typeof it.title === 'string' ? it.title.trim() : '';
    const date = it && typeof it.date === 'string' ? it.date.trim() : '';
    if (!title || !ISO.test(date)) { dropped = true; continue; }
    items.push({
      title,
      date,
      type: TYPES.includes(it.type) ? it.type : 'event',
      project: cleanStrOrNull(it.project),
      subject: cleanStrOrNull(it.subject),
      category: CATEGORIES.includes(it.category) ? it.category : null,
    });
  }
  const needsReview = raw.needsReview === true || dropped;
  return { items, needsReview };
}
```

- [ ] **Step 5: Run — expect pass**

Run: `cd /Users/ajaenicke25/projects/plaenicke/worker && npm test`
Expected: PASS (normalize tests green).

- [ ] **Step 6: Write `worker/tests/prompt.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestBody } from '../src/prompt.js';

test('builds a Haiku request with structured output and no effort/thinking', () => {
  const body = buildRequestBody('physics paper due may 25', '2026-05-01');
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(body.output_config.effort === undefined, 'must not send effort to Haiku');
  assert.ok(body.thinking === undefined, 'must not send thinking to Haiku');
  assert.ok(body.max_tokens > 0);
});

test('injects the raw text and today into the user message', () => {
  const body = buildRequestBody('call mom tomorrow', '2026-05-01');
  const userText = body.messages[0].content;
  assert.ok(userText.includes('call mom tomorrow'));
  assert.ok(userText.includes('2026-05-01'));
});
```

- [ ] **Step 7: Run — expect failure**

Run: `cd /Users/ajaenicke25/projects/plaenicke/worker && npm test`
Expected: FAIL — cannot import `../src/prompt.js`.

- [ ] **Step 8: Write `worker/src/prompt.js`**

```js
// prompt.js — build the Anthropic Messages API request body.
// Model: claude-haiku-4-5 (no effort / no thinking params — Haiku rejects them).

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    needsReview: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          date: { type: 'string' }, // YYYY-MM-DD
          type: { type: 'string', enum: ['due', 'start', 'milestone', 'event'] },
          project: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          subject: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          category: { anyOf: [{ type: 'string', enum: ['School', 'Work', 'Personal'] }, { type: 'null' }] },
        },
        required: ['title', 'date', 'type', 'project', 'subject', 'category'],
      },
    },
  },
  required: ['needsReview', 'items'],
};

const SYSTEM = `You extract calendar items from a person's note.
Return one or more items. For each item set:
- title: a short label (do not include the date words).
- date: resolve to YYYY-MM-DD using the provided "today". If a plain month/day has already passed this year, use next year.
- type: "due" for a hard deadline (words like due, submit, deadline); "start" for begin/start-working reminders; "milestone" for a draft/checkpoint/partial step; "event" for anything else (meetings, appointments, personal to-dos).
- project: the overarching thing several items belong to (e.g. "Physics paper"); null if none. Items from ONE note that clearly belong together share the same project.
- subject: the topic/course (e.g. "Physics"); null if unknown.
- category: "School", "Work", or "Personal"; null if unclear.
Set needsReview to true when the note is complex or you are unsure about any date or type; set it to false only for a single, clear, unambiguous item.
If there is nothing to add, return an empty items array.`;

export function buildRequestBody(text, todayISO) {
  return {
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `Today is ${todayISO}.\n\nNote: ${text}` }],
  };
}
```

- [ ] **Step 9: Run — expect pass, then commit**

Run: `cd /Users/ajaenicke25/projects/plaenicke/worker && npm test`
Expected: PASS (all worker tests).
```bash
cd /Users/ajaenicke25/projects/plaenicke
git add worker/package.json worker/src/prompt.js worker/src/normalize.js worker/tests
git commit -m "feat(worker): pure prompt builder and response normalizer"
```

---

### Task 2: Worker HTTP entry + config

**Files:**
- Create: `worker/src/index.js`, `worker/wrangler.toml`

**Interfaces:**
- Consumes: `buildRequestBody`, `normalizeClaudeJson`.
- Produces: a Worker that handles `POST /` with JSON `{ text, passphrase }` → `{ items, needsReview }` or an error JSON; `OPTIONS` for CORS preflight.

This task's live behavior (real Claude call) is verified at deploy in Task 7. Here we verify the module parses and the request-shaping is correct via a Node import test.

- [ ] **Step 1: Write `worker/src/index.js`**

```js
// index.js — Cloudflare Worker entry. Holds the Anthropic key (env.ANTHROPIC_API_KEY)
// and the shared passphrase (env.APP_PASSPHRASE), both set as Worker secrets.
import { buildRequestBody } from './prompt.js';
import { normalizeClaudeJson } from './normalize.js';

const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';

function cors(headers = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'content-type': 'application/json',
    ...headers,
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors() });
}

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'bad_json' }, 400);
    }

    if (!payload || payload.passphrase !== env.APP_PASSPHRASE) {
      return json({ error: 'unauthorized' }, 401);
    }
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) return json({ error: 'empty_text' }, 400);

    const body = buildRequestBody(text, todayISO());

    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      return json({ error: 'upstream_unreachable' }, 502);
    }

    if (!claudeRes.ok) return json({ error: 'upstream_error', status: claudeRes.status }, 502);

    const data = await claudeRes.json();
    if (data.stop_reason === 'refusal') return json({ error: 'refused' }, 422);

    // Structured output arrives as JSON text in the first text block.
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    let parsed;
    try {
      parsed = JSON.parse(textBlock ? textBlock.text : 'null');
    } catch {
      return json({ error: 'unparseable_model_output' }, 502);
    }

    return json(normalizeClaudeJson(parsed));
  },
};
```

- [ ] **Step 2: Write `worker/wrangler.toml`**

```toml
name = "plaenicke-worker"
main = "src/index.js"
compatibility_date = "2026-07-18"
```

- [ ] **Step 3: Verify the module imports and shapes a request (structural check)**

Run:
```bash
cd /Users/ajaenicke25/projects/plaenicke/worker
node --input-type=module -e "import('./src/index.js').then(m=>{if(typeof m.default.fetch!=='function')throw new Error('no fetch');console.log('worker module OK')})"
```
Expected: `worker module OK`.

- [ ] **Step 4: Commit**

```bash
cd /Users/ajaenicke25/projects/plaenicke
git add worker/src/index.js worker/wrangler.toml
git commit -m "feat(worker): HTTP entry with CORS, passphrase, Anthropic call"
```

---

### Task 3: Extend the frontend item model

**Files:**
- Modify: `js/items.js`
- Modify: `tests/items.test.js`

**Interfaces:**
- Produces: `makeItem(fields: {title, date, type?, project?, subject?, category?}, meta: {id, createdAt}) -> Item` — trims title, requires title and date (throws otherwise), defaults `type` to `'general'` and tags to `null`. `sortItemsByDate` unchanged.

- [ ] **Step 1: Replace `tests/items.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeItem, sortItemsByDate } from '../js/items.js';

test('makeItem builds an item with type and tags, trims title', () => {
  const it = makeItem(
    { title: '  First draft  ', date: '2026-05-15', type: 'milestone',
      project: 'Physics paper', subject: 'Physics', category: 'School' },
    { id: 'a', createdAt: '2026-07-18' });
  assert.deepEqual(it, {
    id: 'a', title: 'First draft', date: '2026-05-15', createdAt: '2026-07-18',
    type: 'milestone', project: 'Physics paper', subject: 'Physics', category: 'School',
  });
});

test('makeItem defaults type to general and tags to null', () => {
  const it = makeItem({ title: 'Buy milk', date: '2026-05-15' }, { id: 'b', createdAt: '2026-07-18' });
  assert.equal(it.type, 'general');
  assert.equal(it.project, null);
  assert.equal(it.category, null);
});

test('makeItem rejects an empty title', () => {
  assert.throws(() => makeItem({ title: '  ', date: '2026-05-15' }, { id: 'c', createdAt: 'x' }),
    /Title is required/);
});

test('makeItem rejects a missing date', () => {
  assert.throws(() => makeItem({ title: 'x', date: '' }, { id: 'c', createdAt: 'x' }),
    /Date is required/);
});

test('sortItemsByDate orders soonest first without mutating input', () => {
  const input = [
    { id: '1', title: 'B', date: '2026-07-10', createdAt: 'x' },
    { id: '2', title: 'A', date: '2026-07-02', createdAt: 'x' },
  ];
  assert.deepEqual(sortItemsByDate(input).map(i => i.id), ['2', '1']);
  assert.equal(input[0].id, '1');
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd /Users/ajaenicke25/projects/plaenicke && npm test`
Expected: FAIL — old `makeItem(title, date, meta)` signature no longer matches.

- [ ] **Step 3: Update `js/items.js`**

```js
// items.js — the shape of a saved item and how to order items.

export function makeItem(fields, meta) {
  const title = (fields.title || '').trim();
  if (!title) throw new Error('Title is required');
  if (!fields.date) throw new Error('Date is required');
  return {
    id: meta.id,
    title,
    date: fields.date,
    createdAt: meta.createdAt,
    type: fields.type || 'general',
    project: fields.project || null,
    subject: fields.subject || null,
    category: fields.category || null,
  };
}

export function sortItemsByDate(items) {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
```

- [ ] **Step 4: Run — expect pass, then commit**

Run: `npm test`
Expected: PASS (items + all V1 suites still green).
```bash
git add js/items.js tests/items.test.js
git commit -m "feat: extend item model with type and tags"
```

---

### Task 4: Frontend smart-add logic — decideFlow + Worker call

**Files:**
- Create: `js/config.js`, `js/smartadd.js`
- Test: `tests/smartadd.test.js`

**Interfaces:**
- Produces:
  - `decideFlow(result: {items, needsReview}) -> 'direct' | 'preview' | 'empty'` (pure).
  - `parseViaWorker(text: string) -> Promise<{items, needsReview}>` (browser; POSTs to the Worker with the stored passphrase; throws on network/HTTP/401 errors).
  - `config.js`: `WORKER_URL` (filled at deploy), `getPassphrase()/setPassphrase()` (localStorage).

- [ ] **Step 1: Write `tests/smartadd.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFlow } from '../js/smartadd.js';

test('single confident item → direct', () => {
  assert.equal(decideFlow({ items: [{}], needsReview: false }), 'direct');
});

test('single item but needsReview → preview', () => {
  assert.equal(decideFlow({ items: [{}], needsReview: true }), 'preview');
});

test('multiple items → preview', () => {
  assert.equal(decideFlow({ items: [{}, {}], needsReview: false }), 'preview');
});

test('no items → empty', () => {
  assert.equal(decideFlow({ items: [], needsReview: false }), 'empty');
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test`
Expected: FAIL — cannot import `../js/smartadd.js`.

- [ ] **Step 3: Write `js/config.js`**

```js
// config.js — deploy-time constants and the passphrase (kept on the phone).
// Set WORKER_URL to your deployed Worker URL in Task 7.
export const WORKER_URL = 'https://REPLACE-ME.workers.dev';

const PASS_KEY = 'plaenicke.passphrase';
export function getPassphrase() { return localStorage.getItem(PASS_KEY) || ''; }
export function setPassphrase(p) { localStorage.setItem(PASS_KEY, p); }
```

- [ ] **Step 4: Write `js/smartadd.js`**

```js
// smartadd.js — the single spot that turns text into items (now via Claude).
import { WORKER_URL, getPassphrase } from './config.js';

// Pure: decide whether to add directly or show a preview.
export function decideFlow(result) {
  if (!result.items || result.items.length === 0) return 'empty';
  if (result.items.length === 1 && !result.needsReview) return 'direct';
  return 'preview';
}

// Browser: call the Worker. Throws Error with a code-ish message on failure.
export async function parseViaWorker(text) {
  let res;
  try {
    res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, passphrase: getPassphrase() }),
    });
  } catch {
    throw new Error('unreachable');
  }
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error('server');
  return res.json();
}
```

- [ ] **Step 5: Run — expect pass, then commit**

Run: `npm test`
Expected: PASS (decideFlow tests; `parseViaWorker` is browser-only and not imported by the test).
```bash
git add js/config.js js/smartadd.js tests/smartadd.test.js
git commit -m "feat: smart-add flow decision and Worker client"
```

---

### Task 5: Preview UI, colors, and tags (HTML + CSS + preview.js)

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Create: `js/preview.js`

**Interfaces:**
- Produces: `renderPreview(container, items, { onConfirm, onCancel })` — renders one editable row per item (title text input, date input, type `<select>`), plus "Add all" and "Cancel"; `onConfirm` receives the edited items array.

Browser/visual task — verified in Task 6's end-to-end check.

- [ ] **Step 1: Add to `index.html`** — a passphrase field in the add box and a preview container. Insert the passphrase input inside `.add-box` after `#entry-text`, and the preview section after the add box:

```html
      <input id="passphrase" type="password" autocomplete="off" placeholder="Smart-add passphrase" />
```
```html
  <section id="preview" hidden></section>
```

- [ ] **Step 2: Add to `styles.css`** — type colors, tag chips, preview:

```css
/* item type colors */
.type-due     { --type: #d64545; }
.type-start   { --type: #2f6fed; }
.type-milestone { --type: #e0a12f; }
.type-event   { --type: #2fae66; }
.type-general { --type: #6b7280; }
.cal-item, #item-list li .dot { background: var(--type, #6b7280); }
#item-list li { border-left: 4px solid var(--type, #6b7280); }

/* tag chips */
.tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.tag { font-size: 0.7rem; background: #eef1f6; color: #4b5563; border-radius: 999px; padding: 1px 8px; }

/* preview */
#preview { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 16px; }
.preview-row { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; margin-bottom: 8px; }
.preview-row input, .preview-row select { padding: 8px; border: 1px solid var(--line); border-radius: 8px; font-size: 0.9rem; }
.preview-actions { display: flex; gap: 8px; margin-top: 10px; }
.preview-actions .cancel { background: var(--card); color: var(--ink); border: 1px solid var(--line); }
```

- [ ] **Step 3: Write `js/preview.js`**

```js
// preview.js — editable confirmation list for multi/uncertain smart-add results.
const TYPES = ['due', 'start', 'milestone', 'event', 'general'];

export function renderPreview(container, items, { onConfirm, onCancel }) {
  const draft = items.map((it) => ({ ...it }));
  container.hidden = false;
  container.innerHTML = '';

  const heading = document.createElement('p');
  heading.textContent = `Review ${draft.length} item${draft.length === 1 ? '' : 's'} before adding:`;
  container.appendChild(heading);

  draft.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'preview-row';

    const title = document.createElement('input');
    title.type = 'text';
    title.value = it.title;
    title.addEventListener('input', () => { draft[i].title = title.value; });

    const date = document.createElement('input');
    date.type = 'date';
    date.value = it.date;
    date.addEventListener('input', () => { draft[i].date = date.value; });

    const type = document.createElement('select');
    for (const t of TYPES) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      if (t === it.type) opt.selected = true;
      type.appendChild(opt);
    }
    type.addEventListener('change', () => { draft[i].type = type.value; });

    row.append(title, date, type);
    container.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.className = 'preview-actions';
  const add = document.createElement('button');
  add.textContent = 'Add all';
  add.addEventListener('click', () => { container.hidden = true; container.innerHTML = ''; onConfirm(draft); });
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { container.hidden = true; container.innerHTML = ''; onCancel(); });
  actions.append(add, cancel);
  container.appendChild(actions);
}
```

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css js/preview.js
git commit -m "feat: preview UI, type colors, and tag chips"
```

---

### Task 6: Wire the new add flow in app.js

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `parseViaWorker`, `decideFlow` (smartadd.js); `renderPreview` (preview.js); `makeItem`, `sortItemsByDate` (items.js); `getPassphrase/setPassphrase` (config.js); existing storage/calendar modules.

Browser/visual task — verified end-to-end in Task 7.

- [ ] **Step 1: Update `js/app.js`** — replace the V1 imports, the `handleAdd` function, and the item-rendering to use Claude + types/tags. Full replacement file:

```js
import { loadItems, saveItems } from './storage.js';
import { makeItem, sortItemsByDate } from './items.js';
import { toISO } from './dateparse.js';
import { buildMonthGrid, groupItemsByDate } from './calendar.js';
import { parseViaWorker, decideFlow } from './smartadd.js';
import { renderPreview } from './preview.js';
import { getPassphrase, setPassphrase } from './config.js';

const els = {
  text: document.getElementById('entry-text'),
  pass: document.getElementById('passphrase'),
  date: document.getElementById('entry-date'),
  add: document.getElementById('add-btn'),
  message: document.getElementById('message'),
  preview: document.getElementById('preview'),
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

els.pass.value = getPassphrase();
els.pass.addEventListener('change', () => setPassphrase(els.pass.value));

function uid() { return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e6); }
function setMessage(t) { els.message.textContent = t || ''; }

function addItems(list) {
  for (const it of list) {
    items.push(makeItem(it, { id: uid(), createdAt: toISO(new Date()) }));
  }
  saveItems(items);
  render();
}

async function handleAdd() {
  const raw = els.text.value.trim();
  if (!raw) { setMessage('Type something first.'); return; }
  setMessage('Thinking…');
  let result;
  try {
    result = await parseViaWorker(raw);
  } catch (e) {
    if (e.message === 'unauthorized') setMessage('Wrong or missing passphrase — check the field above.');
    else setMessage('Smart add is unavailable — add manually with the date box below.');
    return;
  }
  const flow = decideFlow(result);
  if (flow === 'empty') { setMessage("I couldn't find anything to add — try rephrasing."); return; }
  if (flow === 'direct') {
    addItems(result.items);
    els.text.value = '';
    setMessage('Added.');
    return;
  }
  setMessage('Review the items below.');
  renderPreview(els.preview, result.items, {
    onConfirm: (confirmed) => { addItems(confirmed); els.text.value = ''; setMessage('Added.'); },
    onCancel: () => setMessage('Cancelled.'),
  });
}

// Manual add: title box + date box, type defaults to general.
function handleManualAdd() {
  const title = els.text.value.trim();
  const date = els.date.value;
  if (!title || !date) { setMessage('For manual add, type a title and pick a date.'); return; }
  addItems([{ title, date, type: 'general' }]);
  els.text.value = '';
  els.date.value = '';
  setMessage('Added.');
}

function deleteItem(id) {
  items = items.filter((it) => it.id !== id);
  saveItems(items);
  render();
}

function tagChips(it) {
  const wrap = document.createElement('div');
  wrap.className = 'tags';
  for (const val of [it.project, it.subject, it.category]) {
    if (val) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = val; wrap.appendChild(s); }
  }
  return wrap;
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
    li.classList.add('type-' + (it.type || 'general'));
    const main = document.createElement('div');
    const info = document.createElement('span');
    info.textContent = `${it.date} — ${it.title}`;
    main.appendChild(info);
    main.appendChild(tagChips(it));
    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteItem(it.id));
    li.append(main, del);
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
      if (!cell) { div.classList.add('blank'); els.calGrid.appendChild(div); continue; }
      if (cell.date === todayISO) div.classList.add('today');
      const num = document.createElement('div');
      num.className = 'cal-day';
      num.textContent = cell.day;
      div.appendChild(num);
      for (const it of byDate[cell.date] || []) {
        const chip = document.createElement('div');
        chip.className = 'cal-item type-' + (it.type || 'general');
        chip.textContent = it.title;
        div.appendChild(chip);
      }
      els.calGrid.appendChild(div);
    }
  }
}

function render() { renderList(); renderCalendar(); }

function showView(which) {
  const isList = which === 'list';
  els.listView.hidden = !isList;
  els.calView.hidden = isList;
  els.showList.classList.toggle('active', isList);
  els.showCal.classList.toggle('active', !isList);
}

els.add.addEventListener('click', handleAdd);
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdd(); });
// If a date is set manually, Enter in the date box does a manual add.
els.date.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleManualAdd(); });
els.showList.addEventListener('click', () => showView('list'));
els.showCal.addEventListener('click', () => showView('calendar'));
els.prev.addEventListener('click', () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1); renderCalendar(); });
els.next.addEventListener('click', () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1); renderCalendar(); });

render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('service-worker.js'); });
}
```

- [ ] **Step 2: Update the service worker precache list** — add the new JS files so the installed app has them offline. In `service-worker.js`, extend the `ASSETS` array:

```js
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.json',
  'js/app.js', 'js/storage.js', 'js/items.js', 'js/dateparse.js', 'js/calendar.js',
  'js/config.js', 'js/smartadd.js', 'js/preview.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];
```

- [ ] **Step 3: Syntax-check and confirm the whole suite still passes**

Run:
```bash
cd /Users/ajaenicke25/projects/plaenicke
for f in js/*.js; do node --check "$f"; done && echo "syntax OK"
npm test 2>&1 | grep -E "# (tests|pass|fail)"
```
Expected: `syntax OK`, and `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add js/app.js service-worker.js
git commit -m "feat: wire Claude smart-add flow, colors, tags, manual fallback"
```

---

### Task 7: Deploy the Worker and connect it (user-guided)

**Files:** `js/config.js` (fill `WORKER_URL`); deployment steps.

No automated tests — this stands up the Worker, sets secrets, wires the frontend, and verifies end-to-end on the real app. Requires the user's Cloudflare + Anthropic accounts.

- [ ] **Step 1: Set the Anthropic spend cap** — in the Anthropic Console, set a monthly spend limit (e.g. $5) so cost is bounded.

- [ ] **Step 2: Install wrangler and log in** (user runs):
```bash
npx wrangler login
```

- [ ] **Step 3: Set the two secrets** (from `worker/`):
```bash
cd /Users/ajaenicke25/projects/plaenicke/worker
npx wrangler secret put ANTHROPIC_API_KEY   # paste the Anthropic API key
npx wrangler secret put APP_PASSPHRASE       # choose a passphrase; you'll enter the same one in the app
```

- [ ] **Step 4: Deploy the Worker:**
```bash
npx wrangler deploy
```
Note the printed URL (e.g. `https://plaenicke-worker.<subdomain>.workers.dev`).

- [ ] **Step 5: Smoke-test the Worker** with a real call (replace URL + passphrase):
```bash
node --input-type=module -e "
const r = await fetch('https://plaenicke-worker.SUBDOMAIN.workers.dev', {
  method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ text:'physics paper due may 25 first draft due may 15 start working on may 8', passphrase:'YOUR_PASSPHRASE' })
});
console.log(r.status); console.log(JSON.stringify(await r.json(), null, 2));
"
```
Expected: status 200 and a JSON object with 3 items (types start/milestone/due, shared project), `needsReview: true`.

- [ ] **Step 6: Fill `WORKER_URL`** in `js/config.js` with the deployed URL, commit, and push:
```bash
cd /Users/ajaenicke25/projects/plaenicke
git add js/config.js
git commit -m "chore: point frontend at deployed Worker"
git push
```
(GitHub Pages redeploys automatically; the network-first service worker serves the new version.)

- [ ] **Step 7: End-to-end on the phone / browser**
- [ ] Open the app, enter the passphrase in the new field (saved on the device).
- [ ] Type "buy flowers for mom on July second" → adds directly, one green **event** item.
- [ ] Type the multi-part physics-paper sentence → a **preview** appears with 3 items (start/milestone/due), shared project tag; "Add all" places 3 colored items on the calendar.
- [ ] Type gibberish → "couldn't find anything to add."
- [ ] Temporarily clear the passphrase field → smart add shows the wrong-passphrase message; manual title + date still adds an item.

- [ ] **Step 8: Tag the release**
```bash
git tag v2.0 && git push origin v2.0
```

---

## Self-Review

**Spec coverage:**
- Messy input → multiple items: Task 1 (prompt/schema), Task 2 (Worker), Task 6 (flow). ✓
- Semantic types + colors: Task 1 (schema/system), Task 3 (model), Task 5 (CSS), Task 6 (class per type). ✓
- Project/subject/category tags: Tasks 1, 3, 6 (chips). ✓
- Confirm-on-complexity rule: Task 4 (`decideFlow`), Task 6 (direct vs preview). ✓
- Middleman server holds the key: Tasks 2, 7 (secrets). ✓
- Cost safety (passphrase, CORS, spend cap): Task 2 (passphrase/CORS), Task 7 (cap). ✓
- Zero silent fallback (explicit errors, manual still works, no guessed dates): Task 2 (error JSON), Task 6 (messages + manual add), Task 1 (dropped bad dates). ✓
- V1 regression green: Tasks 3 and 6 run the full suite. ✓

**Placeholder scan:** `WORKER_URL = 'https://REPLACE-ME.workers.dev'` is an intentional deploy-time fill, replaced in Task 7 Step 6 — not a plan gap. No other placeholders.

**Type consistency:** `makeItem(fields, meta)` (Task 3) is called with an item-shaped `fields` object everywhere in Task 6 (`addItems`). `normalizeClaudeJson` output shape (`{items, needsReview}`) matches `decideFlow`'s input (Task 4) and the item fields consumed by `makeItem`. `buildRequestBody`/`normalizeClaudeJson` names match between Task 1 defs and Task 2 imports. Item type strings (`due/start/milestone/event/general`) are consistent across schema (Task 1), normalizer default (`event`), model default (`general`), CSS classes, and preview `<select>`.
