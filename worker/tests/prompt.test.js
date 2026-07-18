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
