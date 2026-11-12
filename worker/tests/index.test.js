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
  const token = await mintDevice(env, 1, 'laptop', '2026-08-01T00:00:00.000Z');
  const res = await worker.fetch(new Request('https://worker.example/data', {
    headers: { authorization: `Bearer ${token}` },
  }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 0, blob: '' });
});

test('/data rejects an unsupported method', async () => {
  const env = { ...ENV, DB: makeD1() };
  const token = await mintDevice(env, 1, 'laptop', '2026-08-01T00:00:00.000Z');
  const res = await worker.fetch(new Request('https://worker.example/data', {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  }), env);
  assert.equal(res.status, 405);
});

test('/admin/device requires the admin secret, not a device token', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  const deviceToken = await mintDevice(env, 1, 'laptop', '2026-08-01T00:00:00.000Z');

  const asDevice = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone', accountId: 1 }),
  }), env);
  assert.equal(asDevice.status, 401);

  const asAdmin = await worker.fetch(new Request('https://worker.example/admin/device', {
    method: 'POST',
    headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'phone', accountId: 1 }),
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
    body: JSON.stringify({ name: 'phone', accountId: 1 }),
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
    body: JSON.stringify({ name: 'phone', accountId: 1 }),
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
  const token = await mintDevice(env, 1, 'laptop', '2026-08-01T00:00:00.000Z');
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
    body: JSON.stringify({ name: '  ', accountId: 1 }),
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
      body: JSON.stringify({ name, accountId: 1 }),
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
  const token = await mintDevice(env, 1, 'laptop', '2026-08-01T00:00:00.000Z');
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
  const token = await mintDevice(env, 1, 'laptop', '2026-08-01T00:00:00.000Z');
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

// --- Task 3: per-account routing ---------------------------------------

test('a token reads only its own account row', async () => {
  const DB = makeD1();
  await DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (2, 'b@x.de', 't')").run();
  await DB.prepare("INSERT INTO data (id, version, blob, updated_at) VALUES (2, 3, 'B', 't')").run();
  const env = { ...ENV, DB };
  const token = await mintDevice(env, 2, 'phone', 't');
  const res = await worker.fetch(new Request('https://w/data', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.deepEqual(await res.json(), { version: 3, blob: 'B' });
});

test('a PUT through the router moves only the token\'s account version', async () => {
  const DB = makeD1();
  await DB.prepare("INSERT INTO accounts (id, email, created_at) VALUES (2, 'b@x.de', 't')").run();
  await DB.prepare("INSERT INTO data (id, version, blob, updated_at) VALUES (2, 3, 'B', 't')").run();
  const env = { ...ENV, DB };
  const token = await mintDevice(env, 2, 'phone', 't');
  const res = await worker.fetch(new Request('https://w/data', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 3, blob: 'B2' }),
  }), env);
  assert.deepEqual(await res.json(), { version: 4 });
  assert.equal((await DB.prepare('SELECT version FROM data WHERE id = 1').first()).version, 0);
});

test('/data with a disabled account\'s token is 401', async () => {
  const DB = makeD1();
  await DB.prepare("INSERT INTO accounts (id, email, created_at, disabled_at) VALUES (2, 'b@x.de', 't', 't')").run();
  const env = { ...ENV, DB };
  const token = await mintDevice(env, 2, 'phone', 't');
  const res = await worker.fetch(new Request('https://w/data', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(res.status, 401);
});

test('POST /admin/device without accountId returns 400 bad_request', async () => {
  const env = { ...ENV, DB: makeD1(), ADMIN_SECRET: 'adm1n' };
  for (const body of [{ name: 'phone' }, { name: 'phone', accountId: '1' }, { name: 'phone', accountId: 0 }]) {
    const res = await worker.fetch(new Request('https://worker.example/admin/device', {
      method: 'POST',
      headers: { authorization: 'Bearer adm1n', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_request');
  }
});

// --- Task 7: smart-add cap, session gating, /feed auth ---------------------

const NOON = '2026-11-11T12:00:00.000Z';
const claudeOk = (usage = { input_tokens: 900, output_tokens: 120 }) => new Response(JSON.stringify({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ items: [{ title: 'x', date: '2026-11-12', type: 'task' }], needsReview: false }) }],
  usage,
}), { status: 200 });

async function withAnthropic(handler, fn) {
  const original = globalThis.fetch;
  const stub = { calls: 0 };
  globalThis.fetch = async (...a) => { stub.calls += 1; return handler(...a); };
  try { return await fn(stub); } finally { globalThis.fetch = original; }
}
const smart = (env, token, body = { text: 'call mom tomorrow' }) => worker.fetch(new Request('https://worker.example/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}), env);
async function smartEnv(extra = {}) {
  const env = { ...ENV, DB: makeD1(), NOW: () => NOON, ...extra };
  const token = await mintDevice(env, 1, 'laptop', NOON);
  return { env, token };
}
const usageRows = (env) => env.DB.prepare('SELECT * FROM usage ORDER BY account_id, day').all().then((r) => r.results);

test('REQUIRE_SESSION=true: smart-add without a token is 401 and never reaches Anthropic', async () => {
  const { env } = await smartEnv({ REQUIRE_SESSION: 'true' });
  await withAnthropic(() => claudeOk(), async (stub) => {
    const res = await smart(env, null);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
    assert.equal(stub.calls, 0);
  });
});

test('smart-add cap: 50 calls are 200, the 51st is 429 daily_limit with resetsAt; Anthropic called 50 times', async () => {
  const { env, token } = await smartEnv({ REQUIRE_SESSION: 'true' });
  await withAnthropic(() => claudeOk(), async (stub) => {
    for (let i = 1; i <= 50; i += 1) assert.equal((await smart(env, token)).status, 200, `call ${i}`);
    const res = await smart(env, token);
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'daily_limit', resetsAt: '2026-11-12T00:00:00.000Z' });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
    assert.equal(stub.calls, 50);
  });
});

test('55 parallel smart-adds: exactly 50 x 200 and 5 x 429', async () => {
  const { env, token } = await smartEnv({ DB: makeD1({ yieldPerStatement: true }) });
  await withAnthropic(() => claudeOk(), async (stub) => {
    const res = await Promise.all(Array.from({ length: 55 }, () => smart(env, token)));
    const codes = res.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 200).length, 50);
    assert.equal(codes.filter((c) => c === 429).length, 5);
    assert.equal(stub.calls, 50);
  });
});

test('the UTC day rolls over: capped at 23:59Z, open again at 00:00Z', async () => {
  let now = '2026-11-11T23:59:00.000Z';
  const { env, token } = await smartEnv({ NOW: () => now });
  await withAnthropic(() => claudeOk(), async () => {
    for (let i = 0; i < 50; i += 1) await smart(env, token);
    assert.equal((await smart(env, token)).status, 429);
    now = '2026-11-12T00:00:00.000Z';
    assert.equal((await smart(env, token)).status, 200);
  });
});

test('a call straddling midnight records tokens on the request day', async () => {
  let now = '2026-11-11T23:59:59.000Z';
  const { env, token } = await smartEnv({ NOW: () => now });
  await withAnthropic(() => { now = '2026-11-12T00:00:01.000Z'; return claudeOk({ input_tokens: 900, output_tokens: 120 }); }, async () => {
    assert.equal((await smart(env, token)).status, 200);
  });
  assert.deepEqual(await usageRows(env), [{ account_id: 1, day: '2026-11-11', calls: 1, in_tok: 900, out_tok: 120 }]);
});

test('a Claude failure (500) still consumes a slot', async () => {
  const { env, token } = await smartEnv();
  await withAnthropic(() => new Response('boom', { status: 500 }), async () => {
    assert.equal((await smart(env, token)).status, 502);
  });
  assert.equal((await usageRows(env))[0].calls, 1);
});

test('tolerant mode: no token goes through and writes no usage row; a token is still counted', async () => {
  const { env, token } = await smartEnv();
  await withAnthropic(() => claudeOk(), async () => {
    assert.equal((await smart(env, null)).status, 200);
    assert.deepEqual(await usageRows(env), []);
    assert.equal((await smart(env, token)).status, 200);
  });
  assert.deepEqual(await usageRows(env), [{ account_id: 1, day: '2026-11-11', calls: 1, in_tok: 900, out_tok: 120 }]);
});

test('tokens are recorded on the refusal and max_tokens paths too', async () => {
  for (const [stop, status] of [['refusal', 422], ['max_tokens', 413]]) {
    const { env, token } = await smartEnv();
    await withAnthropic(() => new Response(JSON.stringify({ stop_reason: stop, content: [], usage: { input_tokens: 7, output_tokens: 3 } })), async () => {
      assert.equal((await smart(env, token)).status, status);
    });
    assert.deepEqual(await usageRows(env), [{ account_id: 1, day: '2026-11-11', calls: 1, in_tok: 7, out_tok: 3 }]);
  }
});

test('a client bug (empty text, bad json) does not burn a slot', async () => {
  const { env, token } = await smartEnv();
  await withAnthropic(() => claudeOk(), async () => {
    assert.equal((await smart(env, token, { text: '  ' })).status, 400);
    const badJson = await worker.fetch(new Request('https://worker.example/', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{not json',
    }), env);
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, 'bad_json');
  });
  assert.deepEqual(await usageRows(env), []);
});

test('a disabled account token is 401 on smart-add under REQUIRE_SESSION and never reaches Anthropic', async () => {
  const { env, token } = await smartEnv({ REQUIRE_SESSION: 'true' });
  await env.DB.prepare("UPDATE accounts SET disabled_at = 't' WHERE id = 1").run();
  await withAnthropic(() => claudeOk(), async (stub) => {
    assert.equal((await smart(env, token)).status, 401);
    assert.equal(stub.calls, 0);
  });
});

test('the smart-add log line carries counts only', async () => {
  const { env, token } = await smartEnv();
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await withAnthropic(() => claudeOk(), async () => { await smart(env, token, { text: 'SECRET-TEXT' }); });
  } finally { console.log = orig; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^smart-add claude_ms=\d+ status=200 in=900 out=120$/);
  assert.ok(!lines[0].includes('SECRET'));
  assert.ok(!lines[0].includes(token));
});

// /feed through the router: auth is wired with the real authenticateDevice.
function withCache(fn) {
  const original = globalThis.caches;
  const spy = { matches: 0, match: async () => { spy.matches += 1; return undefined; }, put: async () => {} };
  globalThis.caches = { default: spy };
  return Promise.resolve(fn(spy)).finally(() => { globalThis.caches = original; });
}
const feedReq = (token) => new Request('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/a.ics'), {
  headers: { origin: ALLOWED_ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

test('/feed via the router: REQUIRE_SESSION and no token is 401 before the cache; a disabled account too', async () => {
  const { env, token } = await smartEnv({ REQUIRE_SESSION: 'true' });
  await withCache(async (spy) => {
    assert.equal((await worker.fetch(feedReq(null), env)).status, 401);
    await env.DB.prepare("UPDATE accounts SET disabled_at = 't' WHERE id = 1").run();
    assert.equal((await worker.fetch(feedReq(token), env)).status, 401);
    assert.equal(spy.matches, 0);
  });
});

test('/feed via the router: a valid token reaches the cache', async () => {
  const { env, token } = await smartEnv({ REQUIRE_SESSION: 'true' });
  await withCache(async (spy) => {
    await withAnthropic(() => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 }), async () => {
      await worker.fetch(feedReq(token), env);
    });
    assert.equal(spy.matches, 1);
  });
});

// --- sweep W1-C2: REQUIRE_SESSION parses strictly, fails closed on garbage ---

test('REQUIRE_SESSION: "true" and true require a session on smart add and /feed', async () => {
  for (const flag of ['true', true]) {
    const { env } = await smartEnv({ REQUIRE_SESSION: flag });
    await withAnthropic(() => claudeOk(), async (stub) => {
      const res = await smart(env, null);
      assert.equal(res.status, 401, String(flag));
      assert.equal(stub.calls, 0);
    });
    await withCache(async (spy) => {
      assert.equal((await worker.fetch(feedReq(null), env)).status, 401, String(flag));
      assert.equal(spy.matches, 0);
    });
  }
});

test('REQUIRE_SESSION: "false", false and unset are tolerant', async () => {
  for (const flag of ['false', false, undefined]) {
    const { env } = await smartEnv(flag === undefined ? {} : { REQUIRE_SESSION: flag });
    await withAnthropic(() => claudeOk(), async () => {
      assert.equal((await smart(env, null)).status, 200, String(flag));
    });
    await withCache(async (spy) => {
      await withAnthropic(() => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 }), async () => {
        assert.equal((await worker.fetch(feedReq(null), env)).status, 200, String(flag));
      });
      assert.equal(spy.matches, 1);
    });
  }
});

test('REQUIRE_SESSION: any other value is 500 bad_config on smart add and /feed (zero fallback)', async () => {
  for (const flag of ['1', 'TRUE', 'True', 'yes', '', 1, 'false ']) {
    const { env, token } = await smartEnv({ REQUIRE_SESSION: flag });
    await withAnthropic(() => claudeOk(), async (stub) => {
      for (const t of [null, token]) {
        const res = await smart(env, t);
        assert.equal(res.status, 500, JSON.stringify(flag));
        assert.equal((await res.json()).error, 'bad_config');
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
      }
      assert.equal(stub.calls, 0);
    });
    await withCache(async (spy) => {
      const res = await worker.fetch(feedReq(token), env);
      assert.equal(res.status, 500, JSON.stringify(flag));
      assert.equal((await res.json()).error, 'bad_config');
      assert.equal(spy.matches, 0);
    });
    assert.deepEqual(await usageRows(env), []);
  }
});

// Sweep W2 (carried from W1's re-review): the bad_config check ran in the
// router before feed.js's own checks, so a misconfigured flag answered 500 to
// a preflight and to a foreign Origin. OPTIONS, the Origin allowlist and the
// method check answer exactly as they do with a valid flag; only the real GET
// is 500 bad_config — still before the cache and before any upstream fetch.
test('REQUIRE_SESSION garbage: /feed OPTIONS, Origin and method checks are unaffected; only the GET is 500 bad_config', async () => {
  const url = 'https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/a.ics');
  for (const flag of ['1', 'TRUE', '']) {
    const { env, token } = await smartEnv({ REQUIRE_SESSION: flag });
    await withCache(async (spy) => {
      const pre = await worker.fetch(new Request(url, { method: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN } }), env);
      assert.equal(pre.status, 200, `OPTIONS ${JSON.stringify(flag)}`);
      assert.equal(pre.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
      const foreign = await worker.fetch(new Request(url, { headers: { origin: 'https://evil.example' } }), env);
      assert.equal(foreign.status, 403);
      assert.equal((await foreign.json()).error, 'forbidden');
      const post = await worker.fetch(new Request(url, { method: 'POST', headers: { origin: ALLOWED_ORIGIN } }), env);
      assert.equal(post.status, 405);
      assert.equal((await post.json()).error, 'method_not_allowed');
      for (const t of [null, token]) {
        const res = await worker.fetch(feedReq(t), env);
        assert.equal(res.status, 500);
        assert.equal((await res.json()).error, 'bad_config');
        assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
      }
      assert.equal(spy.matches, 0, 'never reaches the cache');
    });
  }
});
