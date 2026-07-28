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
