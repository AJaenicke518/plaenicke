// wrangler.toml: Workers Logs must not store request URLs.
//
// /feed carries the feed URL — a capability token — in its query string
// (js/feeds.js builds `/feed?url=…`), and an invocation log records each fetch
// as `<METHOD> <URL>`. A live `wrangler tail` on 2026-10-27 showed the full
// `?url=` in event.request.url. Invocation logs stay off; console.log lines
// (the smart-add latency log) still reach Workers Logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TOML = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

// Minimal reader: { '[section]': { key: 'raw value' } }. Enough for the flat
// keys checked here; not a TOML parser.
function sections(text) {
  const out = {};
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[([^\[\]]+)\]$/);
    if (header) { current = header[1]; out[current] ??= {}; continue; }
    const kv = line.match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
    if (kv) (out[current] ??= {})[kv[1]] = kv[2];
  }
  return out;
}

test('invocation logs are off, so no request URL (and no feed token) is stored', () => {
  assert.equal(sections(TOML)['observability.logs']?.invocation_logs, 'false');
});

test('Workers Logs stays enabled for console output (smart-add latency, D1 errors)', () => {
  assert.equal(sections(TOML).observability?.enabled, 'true');
});

// REQUIRE_SESSION (docs/admin.md, release Phase 3): the flag lives in this
// file's [vars], because `wrangler deploy` overwrites variables set in the
// dashboard unless keep_vars is true (developers.cloudflare.com/workers/
// wrangler/configuration/, "Source of truth", checked 2026-11-12). So:
// keep_vars must stay off — with it on, a dashboard value could outlive the
// file — and a declared flag must be a value index.js's requireSession()
// accepts, or every GET /feed and smart add answers 500 bad_config.
test('keep_vars is not enabled: wrangler.toml stays the only source of REQUIRE_SESSION', () => {
  assert.notEqual(sections(TOML)['']?.keep_vars, 'true');
});

test('a declared REQUIRE_SESSION is one requireSession() accepts', () => {
  const v = sections(TOML).vars?.REQUIRE_SESSION;
  if (v === undefined) return; // Phase 1 and 2: unset = tolerant
  assert.ok(['"true"', '"false"', 'true', 'false'].includes(v), `REQUIRE_SESSION = ${v}`);
});
