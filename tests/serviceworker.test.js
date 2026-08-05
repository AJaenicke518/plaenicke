import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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

// A guard against forgetting on a FUTURE release, not a Task 9 deliverable — this
// branch already bumped v5-1 -> v5-2 in 1c03057, so it is green on arrival. Stated
// plainly because the original spelled the assertion as `!sw.includes("'plaenicke-v5-1'")`,
// which hardcodes one stale value and can therefore never fail again for any release.
const CACHE_ON_MAIN = 'plaenicke-v5-1';

test('the cache name is ahead of the release on main', () => {
  const m = read().match(/const CACHE = '([^']+)'/);
  assert.ok(m, 'could not find CACHE in service-worker.js');
  const got = Number(m[1].match(/(\d+)$/)?.[1]);
  const base = Number(CACHE_ON_MAIN.match(/(\d+)$/)[1]);
  assert.ok(Number.isFinite(got) && got > base,
    `CACHE must end in an integer greater than ${base} so new modules are fetched; got '${m[1]}'`);
});
