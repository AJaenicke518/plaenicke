// prompt.js — build the Anthropic Messages API request body.
// Model: claude-haiku-4-5 (no effort / no thinking params — Haiku rejects them).

// THE type LIST LIVES HERE AND NOWHERE ELSE IN THE WORKER. normalize.js
// imports it rather than keeping its own copy, because it used to keep its own
// copy and the two drifted: V6 added `task` and `idea` to the schema below, the
// model returned them correctly, and normalize's stale allowlist rewrote every
// one of them to 'event' on the way out — so nothing ever reached the To-do or
// Ideas page. That was found in production, not by any of V6's three review
// passes, because normalize's clamp is a COERCING allowlist: an unlisted type
// is not rejected loudly, it is silently replaced.
//
// js/preview.js keeps a separate list ON PURPOSE — different deploy unit, and
// it must additionally carry 'general' for manual adds. tests/preview.test.js
// pins the two together as subset-plus-stated-difference.
export const ITEM_TYPES = ['due', 'start', 'milestone', 'event', 'task', 'idea'];

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
          time: { anyOf: [{ type: 'string' }, { type: 'null' }] },    // HH:MM 24h
          endTime: { anyOf: [{ type: 'string' }, { type: 'null' }] }, // HH:MM 24h
          // V6 § 8.1. `task` and `idea` join the four original kinds.
          //
          // THIS LIST HAS A TWIN in js/preview.js, in a DIFFERENT DEPLOY UNIT:
          // the client ships by merging to main, this ships through wrangler.
          // A type here that preview.js does not know renders a <select> with
          // no option selected and the first change event writes the wrong
          // type into the record. tests/preview.test.js pins the two together.
          // Ship the CLIENT FIRST (§ 9.1).
          type: { type: 'string', enum: ITEM_TYPES },
          project: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          subject: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          category: { anyOf: [{ type: 'string', enum: ['School', 'Work', 'Personal'] }, { type: 'null' }] },
          // V6 § 8.1. The idea's full text; null for everything else. The
          // client re-derives the title/notes split from whatever lands here
          // (js/ideas.js), so nothing depends on the model splitting well.
          notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        // `date` STAYS a required plain string — no null branch. That is the
        // V6 reversal: an idea's date is its CAPTURE date, so the model
        // returns today. A nullable date would put back every break point
        // spec § 3.4 removed, starting with deserializeItems silently dropping
        // the record on any device.
        required: ['title', 'date', 'time', 'endTime', 'type', 'project', 'subject', 'category', 'notes'],
      },
    },
  },
  required: ['needsReview', 'items'],
};

const SYSTEM = `You extract calendar items from a person's note.
Return one or more items. For each item set:
- title: a short label (do not include the date words).
- date: resolve to YYYY-MM-DD using the provided "today". If a plain month/day has already passed this year, use next year.
- time: the start time as 24-hour "HH:MM" when the note states one (e.g. "at 2pm" -> "14:00"); null when no time is mentioned. Never invent a time. A deadline "at midnight" means "23:59".
- endTime: the end as "HH:MM" when stated or clearly implied ("2 to 3pm", "meeting 9-10:30"); null otherwise. Only set endTime when time is set.
- type: "due" for a hard deadline (words like due, submit, deadline); "start" for begin/start-working reminders; "milestone" for a draft/checkpoint/partial step; "event" for a meeting or appointment — something that happens at a place and time; "task" for something the person has to DO — an action or errand, including looking into, researching, finding out, checking, calling, emailing or buying something, even when it is vague and has no date; "idea" ONLY for a thought to keep that is NOT something to do — a concept, a suggestion, a thing to remember ("idea for the app: …", "maybe we should …", "remember that …"). The split is ACTION vs THOUGHT, never vague vs specific: "look into housing utilities" is vague but it is still an action, so it is a "task". When a note could be read either way, prefer "task". For an "idea", set date to today.
- project: the overarching thing several items belong to (e.g. "Physics paper"); null if none. Items from ONE note that clearly belong together share the same project.
- subject: the topic/course (e.g. "Physics"); null if unknown.
- category: "School", "Work", or "Personal"; null if unclear.
- notes: for an "idea", the person's COMPLETE original wording for that thought, verbatim; null for every other type. Never shorten it — the title is only a label and the full text is kept here.
Set needsReview to true when the note is complex or you are unsure about any date or type; set it to false only for a single, clear, unambiguous item.
Always set needsReview to true when you classify something as an "idea" and the note mentions any time or date words at all (today, tomorrow, a weekday, a month, "next week", a clock time) — that is the case where "idea" is most likely the wrong call, and the person can correct it before anything is saved.
If there is nothing to add, return an empty items array.`;

export function buildRequestBody(text, todayISO) {
  return {
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `Today is ${todayISO}.\n\nNote: ${text}` }],
  };
}
