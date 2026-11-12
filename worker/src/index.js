// index.js — Cloudflare Worker entry and pathname router.
//
// Env it depends on:
//   env.ANTHROPIC_API_KEY — Worker secret, smart-add (POST /)
//   env.ADMIN_SECRET      — Worker secret, mint/revoke device tokens
//   env.DB                — D1 binding, the sync store and the device table
//
// There is no passphrase: POST / is deliberately public (see handleSmartAdd).
// GET /version is public too: a static deploy marker, no env, no Claude, no D1.
import { buildRequestBody } from './prompt.js';
import { normalizeClaudeJson } from './normalize.js';
import { handleFeed } from './feed.js';
import { VERSION } from './version.js';
import { cors, json } from './cors.js';
import { handleGetData, handlePutData } from './data.js';
import { handleAccountRoute } from './accounts.js';
import { handleAdminRoute } from './admin.js';
import { nowISO } from './clock.js';
import { authenticateDevice } from './auth.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Fallback only — the browser sends its own local date so relative dates
// ("tomorrow") resolve in the USER's timezone, not the Worker's UTC clock.
function utcTodayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// Latency and status ONLY. Never the user's text, never Claude's reply, never
// the key: worker logs are retained, and the text is the user's own notes.
// Time is to response headers (the body is read afterwards).
function logClaudeLatency(ms, status) {
  console.log(`smart-add claude_ms=${ms} status=${status}`);
}

async function handleSmartAdd(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  // No passphrase (personal use). Abuse of this public endpoint is bounded
  // by the monthly spend cap set in the Anthropic Console.
  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return json({ error: 'empty_text' }, 400);

  const today = ISO.test(payload.today) ? payload.today : utcTodayISO();
  const body = buildRequestBody(text, today);

  let claudeRes;
  const startedAt = Date.now();
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    logClaudeLatency(Date.now() - startedAt, 'unreachable');
    return json({ error: 'upstream_unreachable' }, 502);
  }
  logClaudeLatency(Date.now() - startedAt, claudeRes.status);

  if (!claudeRes.ok) return json({ error: 'upstream_error', status: claudeRes.status }, 502);

  // Its own try: a JSON.parse failure message quotes a fragment of the body,
  // and the outer catch logs err.message.
  let data;
  try {
    data = await claudeRes.json();
  } catch {
    return json({ error: 'unparseable_model_output' }, 502);
  }
  if (data.stop_reason === 'refusal') return json({ error: 'refused' }, 422);
  if (data.stop_reason === 'max_tokens') return json({ error: 'too_long' }, 413);

  // Structured output arrives as JSON text in the first text block.
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  let parsed;
  try {
    parsed = JSON.parse(textBlock ? textBlock.text : 'null');
  } catch {
    return json({ error: 'unparseable_model_output' }, 502);
  }

  return json(normalizeClaudeJson(parsed));
}

// The clock boundary is clock.js's nowISO(env). authenticateDevice and
// handlePutData take `now` as a parameter rather than reading the clock
// themselves, so tests can inject a fixed instant (env.NOW) — see auth.js/data.js.

async function handleData(request, env) {
  const device = await authenticateDevice(request, env, nowISO(env));
  if (!device) return json({ error: 'unauthorized' }, 401);
  if (request.method === 'GET') return handleGetData(env, device.accountId);
  if (request.method === 'PUT') return handlePutData(request, env, nowISO(env), device.accountId);
  return json({ error: 'method_not_allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // /feed answers its own OPTIONS: feed.js declares a narrower method set
    // and enforces its own origin allowlist, so the shared preflight below
    // must not intercept it — dispatch here first, unconditionally.
    if (pathname === '/feed') {
      return handleFeed(request, { fetchImpl: fetch, cache: caches.default });
    }

    // Everything below is wrapped so an unexpected throw (a D1 outage, say)
    // becomes a 500 that CARRIES CORS HEADERS. Cloudflare's own 1101 page does
    // not, so the browser would see an opaque TypeError indistinguishable from
    // being offline — the one state the client tolerates silently. The `await`s
    // are load-bearing: without them the promises escape this try.
    //
    // The try deliberately starts AFTER the /feed dispatch, so a feed failure
    // never picks up this wider shared CORS policy.
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

      // Deploy marker: public, static, no Claude, no D1, no env.
      if (pathname === '/version') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return json({ version: VERSION });
      }
      if (pathname === '/') return await handleSmartAdd(request, env);
      if (pathname === '/data') return await handleData(request, env);
      const adminRes = await handleAdminRoute(pathname, request, env);
      if (adminRes) return adminRes;

      const accountRes = await handleAccountRoute(pathname, request, env);
      if (accountRes) return accountRes;

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      // Catching suppresses Cloudflare's automatic exception logging, so this
      // is the only remaining signal. Name and message ONLY — never the
      // request, the payload, or the blob. Optional chaining because a
      // `throw null` would otherwise throw again HERE, escaping fetch() and
      // landing back on the 1101 page this handler exists to avoid (verified
      // by test — plain `err.name` fails it).
      console.error(err?.name, err?.message);
      return json({ error: 'internal_error' }, 500);
    }
  },
};
