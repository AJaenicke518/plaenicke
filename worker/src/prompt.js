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
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `Today is ${todayISO}.\n\nNote: ${text}` }],
  };
}
