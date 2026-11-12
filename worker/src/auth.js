// auth.js — device-token authentication.
//
// A token is 32 random bytes, base64url-encoded, handed to the owner exactly
// once at mint time. Only its SHA-256 hex is stored, so a database leak yields
// no usable credential. Lookup is BY hash as a primary key, so no secret
// comparison happens on the request path.
//
// Note this issues the AUTH half of a link code only. The encryption key that
// protects the blob is generated and held client-side and never reaches this
// Worker — see spec 4.1.

const TOKEN_BYTES = 32;

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

export function newToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

// Constant-time for equal-length inputs; length itself is not secret.
// Never throws: a non-string on either side is simply not equal.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAdmin(request, env) {
  const token = bearerToken(request);
  if (!token || !env.ADMIN_SECRET) return false;
  return timingSafeEqual(token, env.ADMIN_SECRET);
}

export async function authenticateDevice(request, env, now) {
  const token = bearerToken(request);
  if (!token) return null;
  const hash = await sha256Hex(token);
  // The JOIN is the disabled-account check: a disabled account's devices are
  // unknown here, so they get no last_seen_at stamp either.
  const row = await env.DB.prepare(
    'SELECT d.token_hash, d.account_id FROM devices d JOIN accounts a ON a.id = d.account_id '
    + 'WHERE d.token_hash = ? AND a.disabled_at IS NULL',
  ).bind(hash).first();
  if (!row) return null;
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash = ?')
    .bind(now, hash).run();
  return { tokenHash: hash, accountId: row.account_id };
}

export async function mintDevice(env, accountId, name, now) {
  if (!Number.isInteger(accountId) || accountId <= 0) throw new TypeError('accountId required');
  const token = newToken();
  await env.DB.prepare('INSERT INTO devices (token_hash, account_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), accountId, name, now).run();
  return token;
}

export async function revokeDevice(env, tokenHash) {
  const res = await env.DB.prepare('DELETE FROM devices WHERE token_hash = ?').bind(tokenHash).run();
  return res.meta.changes > 0;
}
