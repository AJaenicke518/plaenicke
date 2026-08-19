// feed.js — GET /feed proxy route. Fetches a user-supplied ICS feed URL and
// passes the body through, hardened against SSRF and abuse.
//
// ALL effects (fetch, cache) are injected via the second argument — there is
// no Workers `fetch`/`caches.default` under `node --test`, mirroring how
// prompt.js/normalize.js are pure modules split out of index.js.
//
// SECURITY: the target `url` query param is a capability token (an iCloud/
// Google published-calendar URL embeds a secret). It must NEVER be logged.

import { ALLOWED_ORIGIN } from './cors.js';

const MAX_BYTES = 1024 * 1024; // 1 MB
const MAX_REDIRECTS = 3;
const CACHE_TTL_SECONDS = 15 * 60;
const DEFAULT_TIMEOUT_MS = 8000; // per hop

function cors(headers = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, cache-control',
    ...headers,
  };
}

function errorResponse(error, status) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: cors({ 'content-type': 'application/json' }),
  });
}

// Strip a bracketed IPv6 literal ("[::1]" -> "::1") the way URL#hostname
// reports it; everything else passes through unchanged.
function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

// IPv4 octet-pair check shared by dotted-quad hosts and unwrapped IPv4-mapped
// IPv6 addresses (::ffff:a.b.c.d and its ::ffff:HHHH:HHHH hex form).
function isPrivateIPv4(a, b) {
  if (a === 0) return true; // 0.0.0.0/8 ("this network" / unspecified)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

function isPrivateHost(rawHostname) {
  let host = unbracket(rawHostname).toLowerCase();

  // A trailing dot denotes the DNS root and is semantically the same name
  // (RFC 1034) — "localhost." and "localhost" must be treated identically.
  if (host.endsWith('.')) host = host.slice(0, -1);

  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') || // RFC 6761 — reserved, not just the bare name
    host.endsWith('.internal')
  ) {
    return true;
  }

  // Rely on WHATWG URL host parsing to have already canonicalized octal,
  // decimal, hex, and short dotted-quad forms (e.g. "0x7f000001", "127.1")
  // down to plain dotted-decimal — do NOT re-parse the hostname ourselves.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) return isPrivateIPv4(Number(ipv4[1]), Number(ipv4[2]));

  // IPv4-mapped IPv6 (::ffff:0:0/96). The URL parser always canonicalizes
  // these to the hex form "::ffff:HHHH:HHHH" regardless of whether the
  // input used dotted-quad or hex notation for the embedded address.
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    return isPrivateIPv4((hi >> 8) & 0xff, hi & 0xff);
  }

  if (host === '::' || host === '::1') return true; // unspecified + loopback

  // Unique-local (fc00::/7) and link-local (fe80::/10). Both ranges' true
  // members always render as exactly 4 hex digits in the leading group (the
  // high nibble is nonzero, so the URL parser never strips a leading zero
  // from it) — requiring exactly 4 digits avoids misclassifying an unrelated
  // address like "0fe8::1" (value 0x0FE8, rendered without its leading zero)
  // as if it were "fe80::1".
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10

  return false;
}

// Parses + validates a candidate feed URL: must be https, on the standard
// port (443 or omitted), and not point at a private/loopback/link-local
// host. Returns the parsed URL on success, null on any violation.
function validateFeedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.port !== '' && u.port !== '443') return null;
  if (isPrivateHost(u.hostname)) return null;
  return u;
}

function isNoCache(request) {
  const cc = request.headers.get('Cache-Control') || request.headers.get('cache-control') || '';
  return /no-cache/i.test(cc);
}

// Marks a rejection from readCappedBody as "over the size cap" so the caller
// can tell it apart from a genuine transport failure (both surface as thrown
// errors out of the same read loop).
class FeedTooLargeError extends Error {}

// Reads response.body via its stream reader, counting bytes as they arrive
// and bailing (cancelling the underlying stream) the moment the running
// total exceeds maxBytes — never buffers the whole body first. This is what
// actually bounds Worker memory for a hostile/chunked upstream that never
// sends a (trustworthy) Content-Length.
async function readCappedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    // No stream to read from — treat as a malformed upstream response.
    throw new Error('response has no readable body');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FeedTooLargeError();
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(buf);
}

export async function handleFeed(request, {
  fetchImpl,
  cache,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  // Injectable so tests can produce a deterministic abort without relying on
  // a real timer (AbortSignal.timeout's internal timer is unref'd, so it
  // never fires in a synthetic "hangs forever" test with nothing else
  // scheduled to keep the event loop alive).
  createTimeoutSignal = (ms) => AbortSignal.timeout(ms),
} = {}) {
  // Origin allowlist is checked first, unconditionally, for every method —
  // including OPTIONS preflight and any verb other than GET.
  const origin = request.headers.get('Origin');
  if (origin !== ALLOWED_ORIGIN) return errorResponse('forbidden', 403);

  if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
  if (request.method !== 'GET') return errorResponse('method_not_allowed', 405);

  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');
  const validated = target ? validateFeedUrl(target) : null;
  if (!validated) return errorResponse('bad_url', 400);

  const cacheKey = validated.toString();
  const noCache = isNoCache(request);

  if (!noCache) {
    // The cache is advisory: a broken/unavailable cache backend must not
    // turn a servable feed request into a 500. Deliberate scoping of a
    // known-throwing API, not silent degradation of the feed's own checks.
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch {
      // fall through to a live fetch
    }
  }

  let currentUrl = validated;
  let response;
  let redirects = 0;

  for (;;) {
    try {
      response = await fetchImpl(currentUrl.toString(), {
        redirect: 'manual',
        signal: createTimeoutSignal(timeoutMs),
      });
    } catch {
      return errorResponse('upstream_unreachable', 502);
    }

    const isRedirectStatus = response.status >= 300 && response.status < 400;
    const location = isRedirectStatus ? response.headers.get('location') : null;
    if (!location) break;

    redirects += 1;
    if (redirects > MAX_REDIRECTS) return errorResponse('too_many_redirects', 400);

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      return errorResponse('bad_url', 400);
    }
    const revalidated = validateFeedUrl(nextUrl.toString());
    if (!revalidated) return errorResponse('bad_url', 400);
    currentUrl = revalidated;
  }

  if (!response.ok) return errorResponse('upstream_error', 502);

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel().catch(() => {});
    }
    return errorResponse('feed_too_large', 413);
  }

  let body;
  try {
    body = await readCappedBody(response, MAX_BYTES);
  } catch (err) {
    if (err instanceof FeedTooLargeError) return errorResponse('feed_too_large', 413);
    return errorResponse('upstream_error', 502);
  }

  const stripped = body.replace(/^\uFEFF/, '').trimStart();
  if (!stripped.startsWith('BEGIN:VCALENDAR')) {
    return errorResponse('not_an_ics_feed', 422);
  }

  const success = new Response(body, {
    status: 200,
    headers: cors({
      'content-type': 'text/calendar',
      'Cache-Control': `max-age=${CACHE_TTL_SECONDS}`,
    }),
  });

  if (!noCache) {
    // Advisory again: a cache.put failure must not turn a good feed fetch
    // into an error response — the caller still gets today's content, we
    // just don't get to skip the next fetch.
    try {
      await cache.put(cacheKey, success.clone());
    } catch {
      // best-effort only
    }
  }

  return success;
}
