// feed.js — GET /feed proxy route. Fetches a user-supplied ICS feed URL and
// passes the body through, hardened against SSRF and abuse.
//
// ALL effects (fetch, cache) are injected via the second argument — there is
// no Workers `fetch`/`caches.default` under `node --test`, mirroring how
// prompt.js/normalize.js are pure modules split out of index.js.
//
// SECURITY: the target `url` query param is a capability token (an iCloud/
// Google published-calendar URL embeds a secret). It must NEVER be logged.

const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';
const MAX_BYTES = 1024 * 1024; // 1 MB
const MAX_REDIRECTS = 3;
const CACHE_TTL_SECONDS = 15 * 60;

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

function isPrivateHost(rawHostname) {
  const host = unbracket(rawHostname).toLowerCase();

  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    return false;
  }

  // IPv6 loopback and link-local (fe80::/10).
  if (host === '::1') return true;
  if (host.startsWith('fe80:')) return true;

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

export async function handleFeed(request, { fetchImpl, cache }) {
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
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let currentUrl = validated;
  let response;
  let redirects = 0;

  for (;;) {
    try {
      response = await fetchImpl(currentUrl.toString(), { redirect: 'manual' });
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
    return errorResponse('feed_too_large', 413);
  }

  let body;
  try {
    body = await response.text();
  } catch {
    return errorResponse('upstream_error', 502);
  }

  if (new TextEncoder().encode(body).length > MAX_BYTES) {
    return errorResponse('feed_too_large', 413);
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
    await cache.put(cacheKey, success.clone());
  }

  return success;
}
