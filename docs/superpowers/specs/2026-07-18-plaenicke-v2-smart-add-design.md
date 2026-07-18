# plaenicke V2 Design Spec — Claude-Powered Smart Add

**Date:** 2026-07-18
**Author:** Alexander Jaenicke (with Claude)
**Status:** Approved for planning
**Builds on:** V1 (`2026-07-17-plaenicke-design.md`) — the shipped home-screen PWA with add/list/calendar/persistence.

---

## Context & goal

V1 added dated items with a hand-written on-device date parser. V2 replaces that parser (at
its single designed replacement point, `js/dateparse.js`) with **Claude**, to handle:

1. **Messy natural language** — free-form phrasing the hand-written parser can't handle.
2. **One input → multiple items** — e.g. *"physics paper due may 25, first draft due may 15,
   start working on may 8"* becomes **three** separate calendar items.
3. **Semantic item types** — "due" vs "start working" mean different things; each item is
   classified into a **type** shown in a distinct color.
4. **Tagging** — items carry project / subject / category tags; items from one input share a
   project so they read as a group.

## Chosen architecture

Static frontend (GitHub Pages) **cannot** safely hold an API key. So V2 adds a small server:

```
[ iPhone PWA ]  --raw text-->  [ Cloudflare Worker ]  --API call-->  [ Claude API ]
   (GitHub Pages)               (holds secret key)         |
        ^                                                   v
        +----------------  items[] + needsReview  ----------+
```

- **Frontend** (existing, GitHub Pages): sends the raw sentence to the Worker, receives a
  structured list, applies the confirm rule, colors items by type, shows tags.
- **Cloudflare Worker** (new): holds `ANTHROPIC_API_KEY` as a secret. Validates a shared
  passphrase, builds the extraction prompt, calls Claude, validates and returns the result.
- **Claude**: a small/fast model, called with structured (JSON-schema / tool) output so the
  Worker gets machine-readable items, not prose.

Rationale for Cloudflare Workers over Vercel/Val.town: free tier, first-class secret storage,
single small function, terminal-deployable (consistent with the V1 GitHub Pages flow).

## V2 scope

**In scope:**
- Cloudflare Worker endpoint `POST /parse` that takes `{ text, passphrase }` and returns
  `{ items: Item[], needsReview: boolean }` (or a structured error).
- Claude extraction: from one input, produce 0..N items, each with title, date, type, and
  tags; plus an overall `needsReview` flag.
- **Item type** (fixed set, drives color): `due` (red), `start` (blue), `milestone` (amber),
  `event` (green). Legacy/untyped items render neutral gray.
- **Tags** (all optional strings, may be null): `project`, `subject`, `category`
  (`School` | `Work` | `Personal`). Items extracted from one input share `project`,
  `subject`, and `category` when applicable.
- **Confirm rule:** exactly one item AND `needsReview === false` → add directly. Otherwise →
  show an editable preview; user adjusts title/date/type/tags per row, then "Add all" (or
  cancels).
- **Color by type** on both list rows and calendar chips; **display** tags as small labels.
- **Failure handling:** Worker/Claude unreachable or error → explicit user-visible message;
  the V1 manual title+date inputs remain usable. No silent fallback to a weaker parser, no
  silently-guessed dates.
- **Cost safety:** shared passphrase enforced by the Worker; documented Anthropic console
  spend cap; CORS restricted to the GitHub Pages origin.

**Out of scope (deferred):**
- Filtering / hiding items *by* tag (tags are stored and shown, not yet used as filters).
- Editing an item's tags/type after it's saved (V2 edits happen only in the pre-save preview).
- Notifications, calendar sync, Brightspace (later roadmap items).
- Migrating V1 items to have types (they simply render as neutral "General").

## Data model

V2 extends the V1 item. All new fields are optional so V1-saved items keep loading.

```js
{
  id: "unique-string",
  title: "First draft",
  date: "2026-05-15",          // ISO YYYY-MM-DD
  createdAt: "2026-07-18",
  type: "milestone",           // "due" | "start" | "milestone" | "event"  (absent = general/gray)
  project: "Physics paper",    // optional string | null
  subject: "Physics",          // optional string | null
  category: "School"           // "School" | "Work" | "Personal" | null
}
```

`TYPE_COLORS = { due: red, start: blue, milestone: amber, event: green, general: gray }`.

## Component responsibilities

| Unit | Responsibility |
|------|----------------|
| `worker/parse.js` (Worker entry) | HTTP handling, CORS, passphrase check, orchestration. |
| `worker/prompt.js` | Pure: build the Claude request (system prompt + schema) from input text. |
| `worker/normalize.js` | Pure: validate/normalize Claude's raw JSON into `{ items, needsReview }`; drop malformed items; clamp types/categories to the allowed sets. |
| `js/smartadd.js` (frontend, replaces V1 parser role) | Pure: `decideFlow(result)` → `"direct"` or `"preview"` per the confirm rule; call the Worker; shape items for storage. |
| `js/preview.js` (frontend) | Render the editable preview list and collect the user's confirmed items. |
| `js/app.js` (modify) | Wire the new add flow, direct-add vs preview, error messaging. |
| `js/items.js` (modify) | `makeItem` accepts the new optional fields. |
| `js/calendar.js` + `styles.css` (modify) | Color chips/rows by type; render tag labels. |

## Data flow

1. User types/dictates text, hits Add.
2. `smartadd.js` POSTs `{ text, passphrase }` to the Worker.
3. Worker checks passphrase → `prompt.js` builds the request → calls Claude with structured
   output → `normalize.js` validates → returns `{ items, needsReview }`.
4. `decideFlow` → **direct**: `makeItem` each, save, render. **preview**: `preview.js` shows
   editable rows; on "Add all", save + render.
5. Any Worker/Claude error → `app.js` shows an explicit message; manual inputs remain.

## Error handling (zero silent fallback)

- Worker unreachable / non-200 / malformed body → user sees "Smart add is unavailable — add
  manually below." Manual title+date inputs stay functional. No degraded auto-parse.
- Claude returns zero items → "I couldn't find anything to add — try rephrasing, or add
  manually." No empty/guessed item created.
- Missing passphrase or wrong passphrase → Worker returns 401; app prompts to re-enter it.
- Any item missing a valid date after normalization is dropped and surfaced in the preview as
  needing a date — never saved with a guessed date.

## Security & cost

- `ANTHROPIC_API_KEY` stored as a Cloudflare Worker **secret**, never in the repo or frontend.
- Worker enforces a **shared passphrase** (sent as a header/body field); the app stores it in
  localStorage after first entry. Keeps casual abuse of the public endpoint out.
- Worker sets **CORS** to allow only the GitHub Pages origin.
- User sets a **monthly spend cap** in the Anthropic console as a hard ceiling.
- Model: a small/fast Claude model (final id/params selected during planning via the
  `claude-api` skill), called with structured output to minimize tokens and cost.

## Testing

- **Pure Worker logic** (`prompt.js`, `normalize.js`): `node --test`. Feed representative raw
  Claude JSON (including malformed/edge cases) and assert the normalized output.
- **Frontend decision logic** (`decideFlow`, item shaping): `node --test`.
- **Live Claude call**: manual end-to-end — the physics-paper multi-item case, the simple
  single-item case (direct add), a garbage input (zero items), and a Worker-down case.
- Existing V1 tests must stay green (regression).

## Prerequisites (user-set-up, guided)

1. Anthropic API account + payment method + monthly spend cap.
2. Free Cloudflare account (+ `wrangler` CLI) for the Worker.

## Roadmap after V2

Notifications → calendar sync → Brightspace (feasibility first) → Claude project tracker →
filtering by tag.
