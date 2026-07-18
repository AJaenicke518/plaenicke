// index.js — Cloudflare Worker entry. Holds the Anthropic key (env.ANTHROPIC_API_KEY)
// and the shared passphrase (env.APP_PASSPHRASE), both set as Worker secrets.
import { buildRequestBody } from './prompt.js';
import { normalizeClaudeJson } from './normalize.js';

const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function cors(headers = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'content-type': 'application/json',
    ...headers,
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors() });
}

// Fallback only — the browser sends its own local date so relative dates
// ("tomorrow") resolve in the USER's timezone, not the Worker's UTC clock.
function utcTodayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
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
      return json({ error: 'upstream_unreachable' }, 502);
    }

    if (!claudeRes.ok) return json({ error: 'upstream_error', status: claudeRes.status }, 502);

    const data = await claudeRes.json();
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
  },
};
