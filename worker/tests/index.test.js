// Regression coverage for index.js's smart-add route (POST / and OPTIONS).
// index.js becomes a pathname router in Task 5 (adding GET /feed); this file
// pins down that the pre-existing smart-add behavior at '/' is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';
const ENV = { ANTHROPIC_API_KEY: 'test-key' };

test('OPTIONS / returns the CORS preflight response, unchanged', async () => {
  const request = new Request('https://worker.example/', { method: 'OPTIONS' });
  const res = await worker.fetch(request, ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'content-type');
  const body = await res.text();
  assert.equal(body, '');
});

test('POST / with empty text returns 400 empty_text, unchanged', async () => {
  const request = new Request('https://worker.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  });
  const res = await worker.fetch(request, ENV);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'empty_text');
});

test('POST / with bad JSON returns 400 bad_json, unchanged', async () => {
  const request = new Request('https://worker.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  const res = await worker.fetch(request, ENV);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_json');
});

test('GET / (unsupported method) returns 405 method_not_allowed, unchanged', async () => {
  const request = new Request('https://worker.example/', { method: 'GET' });
  const res = await worker.fetch(request, ENV);
  assert.equal(res.status, 405);
  const body = await res.json();
  assert.equal(body.error, 'method_not_allowed');
});

test('POST / calls out to the real fetch and propagates upstream_unreachable, unchanged', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const request = new Request('https://worker.example/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'call mom tomorrow' }),
    });
    const res = await worker.fetch(request, ENV);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'upstream_unreachable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
