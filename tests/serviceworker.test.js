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
const CACHE_ON_MAIN = 'plaenicke-v5-2';

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
