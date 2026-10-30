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
