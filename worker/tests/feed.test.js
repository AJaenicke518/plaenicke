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
// response looks like: status, ok, headers.get(), text().
function fakeResponse({ status = 200, headers = {}, body = ICS_BODY, throwOnText = false } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (h.has(name.toLowerCase()) ? h.get(name.toLowerCase()) : null) },
    text: async () => {
      if (throwOnText) throw new Error('body read failed');
      return body;
    },
  };
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
