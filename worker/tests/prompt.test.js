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

// =========================================================================
// V6 § 8 — the model classifies to-dos and ideas
// =========================================================================

const schemaOf = () => buildRequestBody('x', '2026-05-01').output_config.format.schema;
const itemProps = () => schemaOf().properties.items.items.properties;

test('the type enum offers task and idea alongside the original four', () => {
  assert.deepEqual(itemProps().type.enum, ['due', 'start', 'milestone', 'event', 'task', 'idea']);
});

// § 8.1: date STAYS a required string. This is the reversal from the previous
// draft — under the capture-date design an idea's date is simply today, and a
// nullable date would reintroduce every break point spec § 3.4 removed,
// starting with deserializeItems silently dropping the record.
test('date is still a required plain string, never nullable', () => {
  assert.deepEqual(itemProps().date, { type: 'string' });
  assert.ok(schemaOf().properties.items.items.required.includes('date'));
});

test('notes is a required nullable string on every item', () => {
  assert.deepEqual(itemProps().notes, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.ok(schemaOf().properties.items.items.required.includes('notes'),
    'a structured-output field that is not required is one the model may simply omit');
});

// additionalProperties is false, so every property must ALSO be in `required`
// or the two lists drift and the model gets a schema it can under-fill.
test('every item property is required, and every required name is a property', () => {
  const props = Object.keys(itemProps()).sort();
  const required = [...schemaOf().properties.items.items.required].sort();
  assert.deepEqual(required, props);
});

test('the prompt distinguishes an event, a task and an idea', () => {
  const { system } = buildRequestBody('x', '2026-05-01');
  assert.match(system, /"task"/, 'the prompt must name the task type');
  assert.match(system, /"idea"/, 'the prompt must name the idea type');
  // The old line lumped personal to-dos in with events; that is what V6 splits.
  assert.doesNotMatch(system, /"event" for anything else \(meetings, appointments, personal to-dos\)/,
    'the old catch-all line must be gone, or the model keeps classifying to-dos as events');
});

// § 8.1/§ 8.2: an idea's date is the capture date. The model must be told, or
// it returns a null-ish or invented date for a schema slot that requires a
// real YYYY-MM-DD string.
test('the prompt tells the model that an idea takes today as its date', () => {
  const { system } = buildRequestBody('x', '2026-05-01');
  assert.match(system, /idea[^\n]*date is today|for an? "?idea"?[^\n]*today/i);
});

test('the prompt explains what notes is for', () => {
  const { system } = buildRequestBody('x', '2026-05-01');
  assert.match(system, /^- notes:/m, 'notes needs a field instruction like every other field');
});

// § 8.3: misclassification is caught by machinery that already exists.
// needsReview routes an uncertain result to the preview UI, where the type can
// be corrected before anything is saved.
test('the prompt forces review when something classified as an idea mentions a time or a date', () => {
  const { system } = buildRequestBody('x', '2026-05-01');
  assert.match(system, /needsReview to true[\s\S]*idea|idea[\s\S]*needsReview to true/i);
});
