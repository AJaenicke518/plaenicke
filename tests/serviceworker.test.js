import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const read = () => readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

// PARSE the ASSETS array; do not substring-search the file. `sw.includes('js/feeds.js')`
// is satisfied by the prose comment at service-worker.js:44 ("cache in js/feeds.js, not
// Cache Storage"), so the original test passed with js/feeds.js deleted from ASSETS
// outright — a cold offline start would white-screen on the module that owns every
// calendar subscription, and the guard said nothing.
function assets(sw) {
  const m = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(m, 'could not find the ASSETS array in service-worker.js');
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    assert.match(s, /^'[^']*'$/, `ASSETS entry is not a plain quoted string: ${s}`);
    return s.slice(1, -1);
  });
}

test('every js/ module is precached — a missing one white-screens a cold offline start', () => {
  const listed = new Set(assets(read()));
  for (const f of readdirSync(new URL('../js', import.meta.url))) {
    if (f.endsWith('.js')) assert.ok(listed.has(`js/${f}`), `service-worker ASSETS is missing js/${f}`);
  }
});

// AND THE OTHER DIRECTION, which nothing checked. `cache.addAll` is
// ALL-OR-NOTHING: one entry that 404s rejects the whole promise, the install
// event's waitUntil rejects, and the service worker never activates at all —
// so a single stale filename silently costs the app its entire offline mode
// and its PWA install, with the app still working perfectly online. Adding an
// ASSETS line before creating the file (or renaming a module and forgetting
// this list) is exactly how that happens.
test('every ASSETS entry actually exists — cache.addAll is all-or-nothing', () => {
  for (const entry of assets(read())) {
    if (entry === '.') continue; // the app shell, served by index.html
    assert.ok(existsSync(new URL(`../${entry}`, import.meta.url)),
      `service-worker ASSETS lists ${entry}, which does not exist — install would reject and the SW would never activate`);
  }
});

// A guard against forgetting on a FUTURE release. It only works if the pinned
// value is kept CURRENT: this constant sat at 'plaenicke-v5-1' while main had
// already shipped 'plaenicke-v5-2', so `got > base` was satisfied forever and
// the assertion could not fail for V6 — the exact vacuity the comment above it
// was written to prevent. RE-PIN THIS TO main's VALUE ON EVERY RELEASE.
const CACHE_ON_MAIN = 'plaenicke-v6-8';

// AND COMPARE THE WHOLE VERSION, not just the trailing integer. The original
// read only the last number, so the legitimate v5-2 -> v6-1 bump would have
// FAILED (1 > 2 is false) and the tempting way out is to weaken the assertion.
// A (major, minor) tuple makes the bump the test asks for the one a release
// actually performs.
function version(name) {
  const m = name.match(/-v(\d+)-(\d+)$/);
  assert.ok(m, `cache name must end in -v<major>-<minor>; got '${name}'`);
  return [Number(m[1]), Number(m[2])];
}

test('the cache name is ahead of the release on main', () => {
  const m = read().match(/const CACHE = '([^']+)'/);
  assert.ok(m, 'could not find CACHE in service-worker.js');
  const [gotMajor, gotMinor] = version(m[1]);
  const [baseMajor, baseMinor] = version(CACHE_ON_MAIN);
  assert.ok(gotMajor > baseMajor || (gotMajor === baseMajor && gotMinor > baseMinor),
    `CACHE must be a later version than main's '${CACHE_ON_MAIN}' so stale caches are purged; got '${m[1]}'`);
});

// --- behaviour: the handlers themselves, run against fake globals ----------
//
// Everything above reads the file as text. These load service-worker.js
// itself with a fake `self`, `caches` and `fetch` and drive its install,
// activate and fetch listeners, so the origin guard and the offline fallback
// are executed rather than argued from reading.
const ORIGIN = 'https://plaenicke.example';

function loadWorker({ fetchImpl, cacheKeys = [] } = {}) {
  const listeners = {};
  const log = { skipWaiting: 0, claimed: 0, added: [], put: [], deleted: [], opened: [], matched: [] };
  const cache = {
    addAll: async (list) => { log.added.push(...list); },
    put: async (req, res) => { log.put.push([req, res]); },
  };
  const caches = {
    open: async (name) => { log.opened.push(name); return cache; },
    keys: async () => [...cacheKeys],
    delete: async (name) => { log.deleted.push(name); return true; },
    match: async (req) => { log.matched.push(req); return { fromCache: true, url: req.url }; },
  };
  const self = {
    location: new URL(`${ORIGIN}/`),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { log.skipWaiting += 1; },
    clients: { claim: async () => { log.claimed += 1; } },
  };
  const fetchCalls = [];
  const fakeFetch = async (req) => { fetchCalls.push(req); return fetchImpl(req); };
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', read())(self, caches, fakeFetch);
  const dispatch = (type, extra = {}) => {
    const event = { ...extra, waits: [], responded: null };
    event.waitUntil = (p) => { event.waits.push(p); };
    event.respondWith = (p) => { event.responded = p; };
    listeners[type](event);
    return event;
  };
  return { dispatch, log, fetchCalls, listeners };
}

const request = (url, method = 'GET') => ({ url, method });
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

test('fetch: a same-origin GET goes to the network first, and a copy is cached', async () => {
  const response = { ok: true, clone() { return { copyOf: this }; } };
  const sw = loadWorker({ fetchImpl: async () => response });
  const req = request(`${ORIGIN}/js/app.js`);
  const ev = sw.dispatch('fetch', { request: req });
  assert.ok(ev.responded, 'a same-origin GET is answered by the service worker');
  assert.equal(await ev.responded, response, 'online, the network response is what the page gets');
  await flush();
  assert.deepEqual(sw.fetchCalls, [req]);
  assert.equal(sw.log.put.length, 1, 'the response is written to the cache');
  assert.equal(sw.log.put[0][0], req);
  assert.deepEqual(sw.log.put[0][1], { copyOf: response }, 'a CLONE is cached, not the body the page consumes');
  assert.deepEqual(sw.log.opened, [read().match(/const CACHE = '([^']+)'/)[1]], 'into the current cache');
  assert.deepEqual(sw.log.matched, [], 'the cache is not consulted while online');
});

test('fetch: offline, a same-origin GET falls back to the cached copy', async () => {
  const sw = loadWorker({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  const req = request(`${ORIGIN}/index.html`);
  const ev = sw.dispatch('fetch', { request: req });
  assert.deepEqual(await ev.responded, { fromCache: true, url: req.url });
  assert.deepEqual(sw.log.matched, [req]);
  assert.deepEqual(sw.log.put, [], 'nothing is cached from a failed fetch');
});

test('fetch: a cross-origin GET (the Worker\'s /feed proxy) is never intercepted or cached', async () => {
  const sw = loadWorker({ fetchImpl: async () => { throw new Error('must not be fetched by the SW'); } });
  const ev = sw.dispatch('fetch', { request: request('https://plaenicke-worker.example/feed?url=https%3A%2F%2Fcal.example%2Fsecret.ics') });
  assert.equal(ev.responded, null, 'left entirely to the browser');
  // Compared as origins, not string prefixes: a host that merely begins with
  // this origin's text is a different origin.
  const lookalike = sw.dispatch('fetch', { request: request(`${ORIGIN}.other.example/x.ics`) });
  assert.equal(lookalike.responded, null, 'a lookalike host is cross-origin');
  await flush();
  assert.deepEqual(sw.fetchCalls, []);
  assert.deepEqual(sw.log.put, []);
});

test('fetch: a non-GET is never intercepted, even same-origin', async () => {
  const sw = loadWorker({ fetchImpl: async () => { throw new Error('must not be fetched by the SW'); } });
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const ev = sw.dispatch('fetch', { request: request(`${ORIGIN}/data`, method) });
    assert.equal(ev.responded, null, method);
  }
  assert.deepEqual(sw.fetchCalls, []);
});

test('install precaches exactly ASSETS into the current cache and skips waiting', async () => {
  const sw = loadWorker({ fetchImpl: async () => ({}) });
  const ev = sw.dispatch('install');
  await Promise.all(ev.waits);
  assert.equal(sw.log.skipWaiting, 1);
  assert.deepEqual(sw.log.added, assets(read()));
  assert.deepEqual(sw.log.opened, [read().match(/const CACHE = '([^']+)'/)[1]]);
});

test('activate deletes every cache but the current one, then claims open pages', async () => {
  const current = read().match(/const CACHE = '([^']+)'/)[1];
  const sw = loadWorker({ fetchImpl: async () => ({}), cacheKeys: ['plaenicke-v4', current, 'plaenicke-v6-2'] });
  const ev = sw.dispatch('activate');
  await Promise.all(ev.waits);
  assert.deepEqual(sw.log.deleted, ['plaenicke-v4', 'plaenicke-v6-2']);
  assert.equal(sw.log.claimed, 1);
});
