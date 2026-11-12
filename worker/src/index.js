// index.js — Cloudflare Worker entry and pathname router.
//
// Env it depends on:
//   env.ANTHROPIC_API_KEY — Worker secret, smart-add (POST /)
//   env.ADMIN_SECRET      — Worker secret, the /admin/* routes (admin.js)
//   env.AT_REST_KEY       — Worker secret, 32 bytes base64url; MACs and seals
//                           account columns (seal.js). Missing → 500 not_configured
//                           on the account routes only.
//   env.REQUIRE_SESSION   — var, phased-release flag for POST / and /feed:
//                           true / "true" → a device session is required;
//                           false / "false" / unset → tolerant (a session is
//                           counted when present); anything else → 500 bad_config.
//   env.DB                — D1 binding: accounts, devices, data, usage, invites
//
// POST / and /feed are public only while REQUIRE_SESSION is tolerant; a
// session's smart adds are capped per account per UTC day either way (usage.js).
// GET /version is always public: a static deploy marker, no env, no Claude, no D1.
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
import { utcDay, nextUtcMidnight, takeSmartAddSlot, recordTokens } from './usage.js';

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
function logClaudeLatency(ms, status, inTok, outTok) {
  const tokens = inTok === undefined ? '' : ` in=${inTok} out=${outTok}`;
  console.log(`smart-add claude_ms=${ms} status=${status}${tokens}`);
}

// Phased release. Returns true (required), false (tolerant) or null for a
// value that is neither — the caller answers 500 bad_config rather than guess
// (a typo such as '1' or 'TRUE' must not silently leave the endpoints open).
function requireSession(env) {
  const v = env.REQUIRE_SESSION;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false' || v === undefined) return false;
  return null;
}
const badConfig = () => json({ error: 'bad_config' }, 500);

async function handleSmartAdd(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const required = requireSession(env);
  if (required === null) return badConfig();

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  // Tolerant mode leaves this endpoint public; abuse is then bounded by the
  // monthly spend cap set in the Anthropic Console.
  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return json({ error: 'empty_text' }, 400);

  // Auth and the slot come after validation so a client bug cannot burn the cap.
  const device = await authenticateDevice(request, env, nowISO(env));
  if (!device && required) return json({ error: 'unauthorized' }, 401);
  const day = utcDay(nowISO(env)); // captured once: a call straddling midnight bills the request's day
  if (device) {
    const slot = await takeSmartAddSlot(env, device.accountId, day);
    if (!slot.ok) return json({ error: 'daily_limit', resetsAt: nextUtcMidnight(day) }, 429);
  }

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

  const headersMs = Date.now() - startedAt; // to response headers; the body is read afterwards
  if (!claudeRes.ok) {
    logClaudeLatency(headersMs, claudeRes.status);
    return json({ error: 'upstream_error', status: claudeRes.status }, 502);
  }

  // Its own try: a JSON.parse failure message quotes a fragment of the body,
  // and the outer catch logs err.message.
  let data;
  try {
    data = await claudeRes.json();
  } catch {
    logClaudeLatency(headersMs, claudeRes.status);
    return json({ error: 'unparseable_model_output' }, 502);
  }
  // Every path where Claude returned a body records its tokens, refusal and
  // max_tokens included. The log line carries counts only.
  if (data.usage) {
    const inTok = data.usage.input_tokens | 0;
    const outTok = data.usage.output_tokens | 0;
    logClaudeLatency(headersMs, claudeRes.status, inTok, outTok);
    if (device) await recordTokens(env, device.accountId, day, inTok, outTok);
  } else {
    logClaudeLatency(headersMs, claudeRes.status);
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
      const required = requireSession(env);
      if (required === null) return badConfig();
      return handleFeed(request, {
        fetchImpl: fetch,
        cache: caches.default,
        requireSession: required,
        authenticate: (req) => authenticateDevice(req, env, nowISO(env)),
      });
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
