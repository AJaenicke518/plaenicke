// Regression coverage for index.js's smart-add route (POST / and OPTIONS).
// index.js becomes a pathname router in Task 5 (adding GET /feed); this file
// pins down that the pre-existing smart-add behavior at '/' is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';
const ENV = { ANTHROPIC_API_KEY: 'test-key' };

test('OPTIONS / returns the CORS preflight response, unchanged', async () => {
  const request = new Request('https://worker.example/', { method: 'OPTIONS' });
  const res = await worker.fetch(request, ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, POST, PUT, DELETE, OPTIONS');
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'content-type, authorization');
  const body = await res.text();
  assert.equal(body, '');
});

test('the allowed origin lives only in cors.js', async () => {
  const { ALLOWED_ORIGIN } = await import('../src/cors.js');
  assert.equal(ALLOWED_ORIGIN, 'https://ajaenicke518.github.io');
  for (const f of ['index.js', 'feed.js']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!src.includes('ajaenicke518.github.io'),
      `${f} still hardcodes the origin`);
  }
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

test('an unknown path returns 404 rather than falling through to smart-add', async () => {
  const request = new Request('https://worker.example/nope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'dentist tuesday' }),
  });
  const res = await worker.fetch(request, ENV);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not_found');
});

test('a GET to an unknown path returns 404, not method_not_allowed', async () => {
  const res = await worker.fetch(new Request('https://worker.example/nope'), ENV);
  assert.equal(res.status, 404);
});

test('OPTIONS on any path still returns the preflight', async () => {
  const res = await worker.fetch(
    new Request('https://worker.example/data', { method: 'OPTIONS' }), ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://ajaenicke518.github.io');
});

// Regression pin: /feed must handle its own OPTIONS preflight (narrower
// method set, its own origin allowlist enforced with 403) rather than being
// intercepted by the shared, wider preflight in the router. This must go
// through worker.fetch — calling handleFeed directly would not catch a
// routing-order regression.
test('OPTIONS /feed keeps feed.js own preflight, not the wide shared one', async () => {
  // index.js reads the Workers-provided global `caches.default`, which does
  // not exist under `node --test` (see feed.js's own comment on this). Stand
  // in a minimal stub for the duration of this test; its match/put are never
  // reached because feed.js's disallowed-origin check returns 403 before the
  // cache is touched.
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    const res = await worker.fetch(new Request('https://worker.example/feed', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    }), ENV);
    assert.equal(res.status, 403);
  } finally {
    globalThis.caches = originalCaches;
  }
});
