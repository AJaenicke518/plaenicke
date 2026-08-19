// Coverage for index.js as a whole: the smart-add route (POST / and OPTIONS),
// the pathname routing added in Task 2, and the /data and /admin/device
// routes wired up in Task 6. /feed predates this branch and has its own
// tests in feed.test.js; what is pinned here is that the router dispatches it
// before the shared preflight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { makeD1 } from './fake-d1.js';
import { mintDevice } from '../src/auth.js';

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

// --- /data and /admin/device (Task 6) ---------------------------------

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('/data requires a device token', async () => {
  const env = { ...ENV, DB: makeD1() };
  const res = await worker.fetch(new Request('https://worker.example/data'), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

test('/data with a valid token returns the seeded state', async () => {
  const env = { ...ENV, DB: makeD1() };
  const token = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');
  const res = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: `Bearer ${token}` },
  }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 0, blob: '' });
});

test('/data rejects an unsupported method', async () => {
  const env = { ...ENV, DB: makeD1() };
  const token = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');
  const res = await worker.fetch(new Request('https://worker.example/data', {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  }), env);
  assert.equal(res.status, 405);
});

test('/admin/device requires the admin secret, not a device token', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const deviceToken = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');

  const asDevice = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone' }),
  }), env);
  assert.equal(asDevice.status, 401);

  const asAdmin = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone' }),
  }), env);
  assert.equal(asAdmin.status, 200);
  const body = await asAdmin.json();
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.name, 'phone');
});

test('a minted token immediately works against /data', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const minted = await (await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone' }),
  }), env)).json();

  const res = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: `Bearer ${minted.token}` },
  }), env);
  assert.equal(res.status, 200);
});

// --- DELETE /admin/device: the revoke wiring itself. auth.js's own unit
// tests cover revokeDevice() in isolation; what they cannot cover is this
// route actually calling it, with the right hash, such that a revoked
// token is actually cut off. Revocation is the only control that turns off
// a leaked token, so a route that silently reports success without ever
// revoking is the worst kind of bug here.
test('DELETE /admin/device revokes a minted token, and the token then fails on /data', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const minted = await (await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone' }),
  }), env)).json();
  const row = await env.DB.prepare('SELECT token_hash FROM devices WHERE name = ?')
    .bind('phone').first();

  const del = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'DELETE',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ token_hash: row.token_hash }),
  }), env);
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { revoked: true });

  // The assertion that kills a silent-success mutant: without this, a
  // handler that always returns {revoked: true} without ever calling
  // revokeDevice would still pass the assertion above.
  const res = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: `Bearer ${minted.token}` },
  }), env);
  assert.equal(res.status, 401);
});

test('DELETE /admin/device with an unknown hash reports revoked: false', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const res = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'DELETE',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ token_hash: 'not-a-real-hash' }),
  }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revoked: false });
});

test('DELETE /admin/device without a token_hash returns 400 bad_request', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const res = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'DELETE',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
});

test('smart-add is still public — this plan does not flip it', async () => {
  const env = { ...ENV, DB: makeD1() };
  const res = await worker.fetch(new Request('https://worker.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '   ' }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'empty_text');
});

// --- Controller override 1: method dispatch must precede body parsing ---
// The brief's handleAdminDevice parses the JSON body before checking the
// method, so a bodiless GET with a valid admin secret would fall through to
// `bad_json` (400) and the trailing 405 branch would be unreachable dead
// code. This pins the corrected ordering: unsupported methods are rejected
// with 405 before any body is read.
test('GET /admin/device with a valid admin secret returns 405, not 400', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const res = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'GET',
    headers: { authorization: 'Bearer adm1n' },
  }), env);
  assert.equal(res.status, 405);
});

// --- Reverse-privilege check: the admin secret must not authenticate /data
// (the brief already pins the other direction — a device token rejected by
// /admin/device — in the test above).
test('the admin secret does not authenticate against /data', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const res = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: 'Bearer adm1n' },
  }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

// --- Controller override 2: pin the clock boundary end-to-end -----------
// nowISO() reads the real clock, so these assert on shape and freshness
// rather than an exact value. They must go through worker.fetch — the point
// is to prove index.js's real nowISO() actually reaches data.js/auth.js,
// not just that data.js/auth.js accept a `now` argument (already covered by
// their own unit tests using a fixed NOW).
test('PUT /data stamps updated_at with the router\'s real clock, not the seeded epoch', async () => {
  const env = { ...ENV, DB: makeD1() };
  const token = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');
  const before = Date.now();

  const res = await worker.fetch(new Request('https://worker.example/data', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 0, blob: 'cipher' }),
  }), env);
  assert.equal(res.status, 200);

  const row = await env.DB.prepare('SELECT updated_at FROM data WHERE id = 1').first();
  assert.match(row.updated_at, ISO_INSTANT);
  assert.notEqual(row.updated_at, '1970-01-01T00:00:00.000Z');
  assert.ok(Math.abs(Date.parse(row.updated_at) - before) < 5000,
    `updated_at not close to now: ${row.updated_at}`);
});

test('POST /admin/device with a blank name returns 400 bad_request', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const res = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ name: '  ' }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
});

// --- The headline property, at the router ------------------------------
// Every other /data correctness test either calls data.js directly or goes
// through worker.fetch for a write OR a read, never both. This is the test to
// point at when asked whether V5 does what it exists to do: device A writes,
// device B reads what A wrote.
test('two devices share one blob: A writes through the router, B reads it back', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const mint = async (name) => (await (await worker.fetch(
    new Request('https://worker.example/admin/device', {
      method: 'POST',
      headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }), env)).json()).token;

  const laptop = await mint('laptop');
  const phone = await mint('phone');
  assert.notEqual(laptop, phone);

  const wrote = await worker.fetch(new Request('https://worker.example/data', {
    method: 'PUT',
    headers: { authorization: `Bearer ${laptop}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 0, blob: 'ciphertext-from-laptop' }),
  }), env);
  assert.equal(wrote.status, 200);
  assert.deepEqual(await wrote.json(), { version: 1 });

  const read = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: `Bearer ${phone}` },
  }), env);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { version: 1, blob: 'ciphertext-from-laptop' });
});

// --- The top-level error handler ---------------------------------------
// An escaping exception becomes Cloudflare's 1101 page, which carries NO
// Access-Control-Allow-Origin — so the browser sees an opaque TypeError
// indistinguishable from being offline, the one state the client tolerates
// silently. These pin a 500 that carries CORS instead.

// Mints a token against a working DB, then swaps in one that throws, so the
// failure lands inside the route rather than at authentication setup.
async function envWithBrokenDB() {
  const env = { ...ENV, DB: makeD1() };
  const token = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');
  env.DB = { prepare() { throw new Error('D1_ERROR: network failure'); } };
  return { env, token };
}

// console.error is the ONLY signal left once the handler catches (catching
// suppresses Cloudflare's automatic exception logging), so capture rather
// than silence it — and assert on what it contains.
async function captureErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  try { return { result: await fn(), lines }; } finally { console.error = original; }
}

test('a D1 failure on GET /data returns 500 internal_error WITH CORS headers', async () => {
  const { env, token } = await envWithBrokenDB();
  const { result: res, lines } = await captureErrors(() => worker.fetch(
    new Request('https://worker.example/data', {
      headers: { authorization: `Bearer ${token}` },
    }), env));

  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal_error' });
  // The whole point: without this header the browser cannot read the 500 at
  // all and reports an opaque network error instead.
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  // Proof the `await`s inside the try are present — without them the promise
  // escapes, nothing is caught, and nothing is logged.
  assert.deepEqual(lines, ['Error D1_ERROR: network failure']);
});

test('a D1 failure on PUT /data leaks neither the blob nor the request', async () => {
  const { env, token } = await envWithBrokenDB();
  // A realistic capability token: a published-calendar URL, the exact kind of
  // secret that lives inside the blob.
  const secret = 'https://calendar.google.com/private-abc123/basic.ics';
  const { result: res, lines } = await captureErrors(() => worker.fetch(
    new Request('https://worker.example/data', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 0, blob: secret }),
    }), env));

  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);

  const body = await res.text();
  for (const fragment of ['private-abc123', 'basic.ics', 'calendar.google.com', token]) {
    assert.ok(!body.includes(fragment), `500 body leaked ${fragment}`);
    assert.ok(!lines.join('\n').includes(fragment), `console.error leaked ${fragment}`);
  }
});

// A `throw null` would make `err.name` itself throw INSIDE the catch, which
// escapes fetch() and lands back on the 1101 page this handler exists to
// avoid — so the logging must not assume an Error was thrown.
test('a non-Error throw is still caught, with CORS intact', async () => {
  for (const thrown of [null, undefined, 'D1_ERROR: string', { code: 7500 }]) {
    const env = { ...ENV, DB: { prepare() { throw thrown; } } };
    const { result: res } = await captureErrors(() => worker.fetch(
      new Request('https://worker.example/data', {
        headers: { authorization: 'Bearer whatever' },
      }), env));
    assert.equal(res.status, 500, `threw ${String(thrown)}`);
    assert.deepEqual(await res.json(), { error: 'internal_error' });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  }
});

test('an unhandled failure on POST / is caught too, and stays public', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw { nope: true }; }; // eslint-disable-line no-throw-literal
  try {
    const { result: res } = await captureErrors(() => worker.fetch(
      new Request('https://worker.example/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'call mom tomorrow' }),
      }), { ...ENV, DB: makeD1() }));
    // smart-add catches fetch failures itself and reports 502; a non-Error
    // throw from JSON.stringify-land would escape it. Either way the response
    // is a readable JSON error, never an opaque 1101.
    assert.ok([500, 502].includes(res.status), `unexpected status ${res.status}`);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticateDevice via /data stamps last_seen_at with the router\'s real clock', async () => {
  const env = { ...ENV, DB: makeD1() };
  const token = await mintDevice(env, 'laptop', '2026-08-01T00:00:00.000Z');
  const before = Date.now();

  const res = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: `Bearer ${token}` },
  }), env);
  assert.equal(res.status, 200);

  const row = await env.DB.prepare('SELECT last_seen_at FROM devices').first();
  assert.match(row.last_seen_at, ISO_INSTANT);
  assert.ok(Math.abs(Date.parse(row.last_seen_at) - before) < 5000,
    `last_seen_at not close to now: ${row.last_seen_at}`);
});
