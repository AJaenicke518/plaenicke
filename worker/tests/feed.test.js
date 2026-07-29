import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleFeed } from '../src/feed.js';

const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';
const ICS_BODY = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

function req(url, { origin = ALLOWED_ORIGIN, headers = {}, method = 'GET' } = {}) {
  const h = new Headers(headers);
  if (origin !== undefined && origin !== null) h.set('Origin', origin);
  return new Request(url, { method, headers: h });
}

// A fake Response-alike object mirroring what a Workers fetch() redirect: 'manual'
// response looks like: status, ok, headers.get(), body (a ReadableStream — the
// real thing the streaming byte-cap reads from, never .text()).
function fakeResponse({ status = 200, headers = {}, body = ICS_BODY, throwOnRead = false } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream({
    pull(controller) {
      if (throwOnRead) {
        controller.error(new Error('body read failed'));
        return;
      }
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (h.has(name.toLowerCase()) ? h.get(name.toLowerCase()) : null) },
    body: stream,
  };
}

// Builds a ReadableStream fed from discrete pre-made chunks, instrumented so
// a test can assert how many chunks were actually pulled before the reader
// gave up (proves early bail-out) and whether cancel() was called.
function countingChunkedStream(chunks) {
  const remaining = [...chunks];
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (remaining.length === 0) {
        controller.close();
        return;
      }
      controller.enqueue(remaining.shift());
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, getPulls: () => pulls, wasCancelled: () => cancelled };
}

// A fake injected cache mirroring the Workers Cache API surface we use.
function fakeCache() {
  const store = new Map();
  return {
    store,
    match: async (key) => store.get(key) || undefined,
    put: async (key, response) => {
      store.set(key, response);
    },
  };
}

test('missing Origin header -> 403 forbidden', async () => {
  const request = req('https://worker.example/feed?url=https://cal.example/feed.ics', { origin: null });
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'forbidden');
});

test('wrong Origin header -> 403 forbidden', async () => {
  const request = req('https://worker.example/feed?url=https://cal.example/feed.ics', { origin: 'https://evil.example' });
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'forbidden');
});

test('http:// target url -> 400 bad_url', async () => {
  const request = req('https://worker.example/feed?url=http://cal.example/feed.ics');
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_url');
});

test('private IPv4 host (192.168.1.1) -> 400 bad_url', async () => {
  const request = req('https://worker.example/feed?url=https://192.168.1.1/feed.ics');
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_url');
});

test('localhost host -> 400 bad_url', async () => {
  const request = req('https://worker.example/feed?url=https://localhost/feed.ics');
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_url');
});

test('non-standard port (:8080) -> 400 bad_url', async () => {
  const request = req('https://worker.example/feed?url=https://cal.example:8080/feed.ics');
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_url');
});

test('missing url param -> 400 bad_url', async () => {
  const request = req('https://worker.example/feed');
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_url');
});

// Table-driven private-host coverage (security review round 1, Critical 1 +
// Important 5). Two separate lists on purpose: the first is hosts the naive
// v4-only/`fe80:`-literal check previously let through as 200; the second is
// hosts the WHATWG URL parser itself normalizes into a canonical private form
// (proving we rely on that normalization rather than re-parsing hostnames).
const PRIVATE_HOST_BYPASSES = [
  'https://[::ffff:127.0.0.1]/feed.ics', // IPv4-mapped IPv6 loopback
  'https://localhost./feed.ics', // trailing dot (FQDN root) on localhost
  'https://0.0.0.0/feed.ics', // 0.0.0.0/8
  'https://0/feed.ics', // single-component form of 0.0.0.0
  'https://[fd00::1]/feed.ics', // unique-local fc00::/7
  'https://[febf::1]/feed.ics', // top of link-local fe80::/10 range
  'https://[::]/feed.ics', // unspecified address
  'https://api.localhost/feed.ics', // RFC 6761 .localhost, not just .local
];
const NORMALIZED_AWAY_PRIVATE_FORMS = [
  'https://0177.0.0.1/feed.ics', // octal
  'https://2130706433/feed.ics', // decimal
  'https://0x7f000001/feed.ics', // hex
  'https://127.1/feed.ics', // short dotted form
  'https://192.168.001.001/feed.ics', // zero-padded octets
  'https://LOCALHOST/feed.ics', // case
  'https://127.0.0.1./feed.ics', // trailing dot on an IPv4 literal
];
const LEGITIMATE_PUBLIC_HOSTS = [
  'https://cal.example/feed.ics',
  'https://p01-calendars.icloud.com/published/2/original',
];

test('private/loopback/link-local host bypasses are all rejected as bad_url', async () => {
  for (const target of PRIVATE_HOST_BYPASSES) {
    const request = req('https://worker.example/feed?url=' + encodeURIComponent(target));
    const res = await handleFeed(request, {
      fetchImpl: async () => { throw new Error(`must not fetch: ${target}`); },
      cache: fakeCache(),
    });
    assert.equal(res.status, 400, `expected 400 bad_url for ${target}, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error, 'bad_url', `expected bad_url for ${target}`);
  }
});

test('hostnames the URL parser normalizes to a private form are still rejected', async () => {
  for (const target of NORMALIZED_AWAY_PRIVATE_FORMS) {
    const request = req('https://worker.example/feed?url=' + encodeURIComponent(target));
    const res = await handleFeed(request, {
      fetchImpl: async () => { throw new Error(`must not fetch: ${target}`); },
      cache: fakeCache(),
    });
    assert.equal(res.status, 400, `expected 400 bad_url for ${target}, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error, 'bad_url', `expected bad_url for ${target}`);
  }
});

test('legitimate public hosts pass the private-host check', async () => {
  for (const target of LEGITIMATE_PUBLIC_HOSTS) {
    const fetchImpl = async () => fakeResponse({ status: 200 });
    const request = req('https://worker.example/feed?url=' + encodeURIComponent(target));
    const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
    assert.equal(res.status, 200, `expected 200 for ${target}, got ${res.status}`);
  }
});

// Addresses that are near the fe80::/10 and fc00::/7 boundaries but must NOT
// be flagged — regression coverage for the "exactly 4 hex digits" boundary
// (a value like 0x0FE8 renders as "fe8" with the leading zero stripped, and
// must not be confused with the true range member "fe80").
test('addresses adjacent to the link-local/unique-local ranges are not false-positived', async () => {
  const nonPrivateHosts = ['https://[fe7f::1]/feed.ics', 'https://[fec0::1]/feed.ics'];
  for (const target of nonPrivateHosts) {
    const fetchImpl = async () => fakeResponse({ status: 200 });
    const request = req('https://worker.example/feed?url=' + encodeURIComponent(target));
    const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
    assert.equal(res.status, 200, `expected 200 (not private) for ${target}, got ${res.status}`);
  }
});

test('https -> https redirect is followed (iCloud shape)', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(url, 'https://p01-calendars.icloud.com/published/2/original');
      return fakeResponse({ status: 302, headers: { location: 'https://p02-calendars.icloud.com/published/2/rotated' } });
    }
    assert.equal(url, 'https://p02-calendars.icloud.com/published/2/rotated');
    return fakeResponse({ status: 200 });
  };
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://p01-calendars.icloud.com/published/2/original'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/calendar');
  const body = await res.text();
  assert.equal(body, ICS_BODY);
  assert.equal(calls, 2);
});

test('redirect to http target -> 400 bad_url', async () => {
  const fetchImpl = async () => fakeResponse({ status: 302, headers: { location: 'http://cal.example/feed.ics' } });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_url');
});

test('redirect to private host -> 400 bad_url', async () => {
  const fetchImpl = async () => fakeResponse({ status: 302, headers: { location: 'https://10.0.0.5/feed.ics' } });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_url');
});

test('4 redirect hops -> 400 too_many_redirects', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeResponse({ status: 302, headers: { location: `https://cal.example/hop${calls}` } });
  };
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/start'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'too_many_redirects');
});

test('exactly 3 redirect hops is allowed', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 3) return fakeResponse({ status: 302, headers: { location: `https://cal.example/hop${calls}` } });
    return fakeResponse({ status: 200 });
  };
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/start'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 200);
  assert.equal(calls, 4);
});

test('oversized body (>1MB) -> 413 feed_too_large', async () => {
  const big = 'BEGIN:VCALENDAR\r\n' + 'X'.repeat(1024 * 1024 + 10) + '\r\nEND:VCALENDAR\r\n';
  const fetchImpl = async () => fakeResponse({ status: 200, body: big });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, 'feed_too_large');
});

test('a Content-Length header over the cap is rejected before any body is read', async () => {
  const fetchImpl = async () => fakeResponse({
    status: 200,
    headers: { 'content-length': String(1024 * 1024 + 1) },
    body: ICS_BODY,
  });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, 'feed_too_large');
});

test('a chunked (no Content-Length) body over 1MB is rejected without buffering the whole stream', async () => {
  // 5 chunks of 256KB = 1.25MB, over the 1MB cap. No content-length header,
  // simulating a real chunked-transfer-encoding upstream response.
  const chunk = new Uint8Array(256 * 1024).fill(65);
  const totalChunks = 8;
  const chunks = Array.from({ length: totalChunks }, () => chunk.slice());
  const { stream, getPulls, wasCancelled } = countingChunkedStream(chunks);
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: stream,
  });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error, 'feed_too_large');
  assert.ok(getPulls() < totalChunks, `expected an early bail-out, only pulled ${getPulls()} of ${totalChunks} chunks`);
  assert.ok(wasCancelled(), 'must cancel the underlying stream once the cap is exceeded');
});

test('a body-stream read failure mid-transfer -> 502 upstream_error', async () => {
  const fetchImpl = async () => fakeResponse({ status: 200, throwOnRead: true });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'upstream_error');
});

test('HTML body (not an ICS feed) -> 422 not_an_ics_feed', async () => {
  const fetchImpl = async () => fakeResponse({ status: 200, body: '<html><body>not a calendar</body></html>' });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, 'not_an_ics_feed');
});

test('BOM and leading whitespace before BEGIN:VCALENDAR is tolerated', async () => {
  const fetchImpl = async () => fakeResponse({ status: 200, body: '﻿   \r\n' + ICS_BODY });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 200);
});

test('fetchImpl throws -> 502 upstream_unreachable', async () => {
  const fetchImpl = async () => { throw new Error('DNS failure'); };
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'upstream_unreachable');
});

test('upstream non-2xx (e.g. 404) -> 502 upstream_error', async () => {
  const fetchImpl = async () => fakeResponse({ status: 404, body: 'not found' });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'upstream_error');
});

test('a hop that never resolves is aborted by the per-hop deadline -> 502 upstream_unreachable', async () => {
  // fetchImpl respects the injected AbortSignal the way a real fetch would:
  // it never resolves on its own, only rejects when the signal aborts. The
  // timeout-signal factory is injected too, firing on a microtask instead of
  // a real timer — deterministic, and avoids relying on AbortSignal.timeout's
  // (unref'd) internal timer ever getting a turn in a synthetic test where
  // nothing else keeps the event loop alive.
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
  const createTimeoutSignal = () => {
    const controller = new AbortController();
    queueMicrotask(() => controller.abort());
    return controller.signal;
  };
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache: fakeCache(), createTimeoutSignal });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, 'upstream_unreachable');
});

test('a signal is passed to fetchImpl on every hop', async () => {
  const seenSignals = [];
  const fetchImpl = async (url, options) => {
    seenSignals.push(options.signal);
    return fakeResponse({ status: 200 });
  };
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  await handleFeed(request, { fetchImpl, cache: fakeCache() });
  assert.equal(seenSignals.length, 1);
  assert.ok(seenSignals[0] instanceof AbortSignal);
});

test('happy path -> 200, CORS headers, and writes the cache', async () => {
  const fetchImpl = async () => fakeResponse({ status: 200 });
  const cache = fakeCache();
  const target = 'https://cal.example/feed.ics';
  const request = req('https://worker.example/feed?url=' + encodeURIComponent(target));
  const res = await handleFeed(request, { fetchImpl, cache });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/calendar');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert.equal(cache.store.size, 1);
  assert.ok(cache.store.has(target));
});

test('a cached response is served without calling fetchImpl again', async () => {
  const target = 'https://cal.example/feed.ics';
  const cache = fakeCache();
  cache.store.set(target, new Response(ICS_BODY, { status: 200, headers: { 'content-type': 'text/calendar' } }));
  const fetchImpl = async () => { throw new Error('must not fetch — should be served from cache'); };
  const request = req('https://worker.example/feed?url=' + encodeURIComponent(target));
  const res = await handleFeed(request, { fetchImpl, cache });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, ICS_BODY);
});

test('Cache-Control: no-cache on the request bypasses cache read AND write', async () => {
  const target = 'https://cal.example/feed.ics';
  const cache = fakeCache();
  cache.store.set(target, new Response('STALE', { status: 200, headers: { 'content-type': 'text/calendar' } }));
  const fetchImpl = async () => fakeResponse({ status: 200 });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent(target), { headers: { 'Cache-Control': 'no-cache' } });
  const res = await handleFeed(request, { fetchImpl, cache });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, ICS_BODY, 'must fetch fresh, not serve the stale cached body');
  assert.equal(cache.store.get(target).status, 200);
  const bodyAfter = await cache.store.get(target).clone().text().catch(() => 'STALE');
  assert.equal(bodyAfter, 'STALE', 'must not overwrite the cache while no-cache is set');
});

test('a throwing cache.match does not break the request — falls through to a live fetch', async () => {
  const cache = {
    match: async () => { throw new Error('cache backend unavailable'); },
    put: async () => { throw new Error('cache backend unavailable'); },
  };
  const fetchImpl = async () => fakeResponse({ status: 200 });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, ICS_BODY);
});

test('a throwing cache.put does not break a successful response', async () => {
  const cache = {
    match: async () => undefined,
    put: async () => { throw new Error('cache backend unavailable'); },
  };
  const fetchImpl = async () => fakeResponse({ status: 200 });
  const request = req('https://worker.example/feed?url=' + encodeURIComponent('https://cal.example/feed.ics'));
  const res = await handleFeed(request, { fetchImpl, cache });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, ICS_BODY);
});

test('Origin allowlist is checked before the method check (POST from bad origin -> 403, not 405)', async () => {
  const request = req('https://worker.example/feed?url=https://cal.example/feed.ics', {
    origin: 'https://evil.example',
    method: 'POST',
  });
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'forbidden');
});

test('OPTIONS preflight from the allowed origin returns CORS headers', async () => {
  const request = req('https://worker.example/feed', { method: 'OPTIONS' });
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert.match(res.headers.get('Access-Control-Allow-Methods'), /GET/);
});

test('OPTIONS preflight from a disallowed origin -> 403 forbidden', async () => {
  const request = req('https://worker.example/feed', { origin: 'https://evil.example', method: 'OPTIONS' });
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 403);
});

test('unsupported method (POST) from the allowed origin -> 405 method_not_allowed', async () => {
  const request = req('https://worker.example/feed?url=https://cal.example/feed.ics', { method: 'POST' });
  const res = await handleFeed(request, { fetchImpl: async () => { throw new Error('must not fetch'); }, cache: fakeCache() });
  assert.equal(res.status, 405);
  const body = await res.json();
  assert.equal(body.error, 'method_not_allowed');
});

test('never logs the feed URL', async () => {
  const target = 'https://secret-token-abc123.example/private-feed.ics';
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const fetchImpl = async () => { throw new Error('boom'); };
    const request = req('https://worker.example/feed?url=' + encodeURIComponent(target));
    await handleFeed(request, { fetchImpl, cache: fakeCache() });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  for (const line of logs) {
    assert.ok(!line.includes('secret-token-abc123'), `log line leaked the feed URL: ${line}`);
  }
});
