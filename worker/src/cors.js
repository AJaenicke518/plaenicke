// cors.js — the single source of truth for the allowed origin and the JSON
// response shape. Previously duplicated across index.js and feed.js; a
// security constant with several copies drifts.

export const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';

export function cors(headers = {}) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'content-type': 'application/json',
    ...headers,
  };
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors() });
}
