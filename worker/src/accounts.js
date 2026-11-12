// accounts.js — sign-up, prelogin, login (with atomic lockout), logout, devices,
// account info and recovery confirm (spec § 6.1, 6.2, 6.6).
//
// Never log emails, keys, tokens or bodies from this file.
import { atRest, checkKey, AtRestError } from './seal.js';
import {
  authenticateDevice, sha256Hex, newToken, timingSafeEqual,
} from './auth.js';
import { json } from './cors.js';
import { nowISO, addMinutes } from './clock.js';

const MIN_ITERS = 600000;
const MAX_FAILED = 50;
const LOCK_MINUTES = 60;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// 2 + a random integer in [0, 2^52): two Uint32 words, the high one masked to 20 bits.
export function randomAccountId() {
  const w = crypto.getRandomValues(new Uint32Array(2));
  const id = 2 + (((w[0] & 0xfffff) * 2 ** 32) + w[1]);
  if (!Number.isSafeInteger(id)) throw new Error('account id not a safe integer');
  return id;
}

function decodedLength(s, url) {
  const re = url ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (typeof s !== 'string' || !re.test(s)) return -1;
  try {
    const std = url ? s.replace(/-/g, '+').replace(/_/g, '/') : s;
    return atob(std + '='.repeat((4 - (std.length % 4)) % 4)).length;
  } catch { return -1; }
}

const isB64u = (s, n) => decodedLength(s, true) === n;
const isB64 = (s, n) => decodedLength(s, false) === n;
const validName = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 100;
const normEmail = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

// Attempt reservation (spec § 6.2 step 3): one UPDATE, so concurrent wrong
// guesses cannot out-run the limit. Also restarts an expired lock window.
// Anonymous ? params (bind order = appearance order): node:sqlite rejects ?N
// positionally, and the fake D1 sits on it.
export async function reservePasswordAttempt(env, accountId, now) {
  const lockUntil = addMinutes(now, LOCK_MINUTES);
  const reserved = await env.DB.prepare(`UPDATE accounts SET
      failed_logins = CASE WHEN locked_until IS NOT NULL AND locked_until <= ? THEN 1 ELSE failed_logins + 1 END,
      locked_until  = CASE WHEN locked_until IS NOT NULL AND locked_until <= ? THEN NULL
                           WHEN failed_logins + 1 >= ${MAX_FAILED} THEN ? ELSE locked_until END
    WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?) RETURNING failed_logins`)
    .bind(now, now, lockUntil, accountId, now).first();
  return Boolean(reserved);
}

export function clearPasswordFailures(env, accountId) {
  return env.DB.prepare('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(accountId);
}

async function handleSignup(request, env, A) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || typeof b.invite !== 'string' || !b.invite || b.invite.length > 200
    || !EMAIL_RE.test(email) || email.length > 254
    || !isB64u(b.kdfSalt, 16) || !Number.isInteger(b.kdfIters) || b.kdfIters < MIN_ITERS
    || !isB64u(b.authKey, 32) || !isB64u(b.recAuthKey, 32)
    || !isB64(b.wrappedDekPw, 60) || !isB64(b.wrappedDekRec, 60)
    || typeof b.dekCheck !== 'string' || b.dekCheck.length < 1 || b.dekCheck.length > 128
    || !validName(b.deviceName)) {
    return json({ error: 'bad_request' }, 400);
  }
  const now = nowISO(env);
  const inviteHash = await sha256Hex(b.invite);
  const nonce = `${now}|${crypto.randomUUID()}`;
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = randomAccountId();
    const pw = await A.seal('wrapped_dek_pw_sealed', id, b.wrappedDekPw);
    const rec = await A.seal('wrapped_dek_rec_sealed', id, b.wrappedDekRec);
    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare('UPDATE invites SET used_at = ? WHERE hash = ? AND used_at IS NULL AND revoked_at IS NULL').bind(nonce, inviteHash),
        env.DB.prepare(`INSERT INTO accounts (id, email, kdf_salt, kdf_iters, auth_mac, rec_auth_mac, wrapped_dek_pw_sealed, wrapped_dek_rec_sealed, dek_check, invite_hash, created_at)
                        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, hash, ? FROM invites WHERE hash = ? AND used_at = ?`)
          .bind(id, email, b.kdfSalt, b.kdfIters, await A.mac(b.authKey), await A.mac(b.recAuthKey), pw, rec, b.dekCheck, now, inviteHash, nonce),
        env.DB.prepare(`INSERT INTO data (id, version, blob, updated_at)
                        SELECT a.id, 0, '', ? FROM accounts a JOIN invites i ON i.hash = a.invite_hash WHERE i.hash = ? AND i.used_at = ?`)
          .bind(now, inviteHash, nonce),
        env.DB.prepare(`INSERT INTO devices (token_hash, account_id, name, created_at)
                        SELECT ?, a.id, ?, ? FROM accounts a JOIN invites i ON i.hash = a.invite_hash WHERE i.hash = ? AND i.used_at = ?`)
          .bind(tokenHash, b.deviceName, now, inviteHash, nonce),
      ]);
    } catch (err) {
      const msg = String(err && err.message);
      if (/UNIQUE constraint failed: accounts\.email/.test(msg)) return json({ error: 'email_taken' }, 409);
      if (/UNIQUE constraint failed: accounts\.id/.test(msg) && attempt === 0) continue; // id collision: retry once
      throw err;
    }
    if (results[1].meta.changes !== 1) return json({ error: 'invalid_invite' }, 403);
    return json({ token, accountId: id });
  }
  throw new Error('account id collision twice');
}

async function handlePrelogin(request, env) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  const row = email
    ? await env.DB.prepare('SELECT kdf_salt, kdf_iters FROM accounts WHERE email = ? AND auth_mac IS NOT NULL').bind(email).first()
    : null;
  if (!row) return json({ error: 'no_account' }, 404);
  return json({ kdfSalt: row.kdf_salt, kdfIters: row.kdf_iters });
}

async function handleLogin(request, env, A) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || !EMAIL_RE.test(email) || !isB64u(b.authKey, 32) || !validName(b.deviceName)) {
    return json({ error: 'bad_request' }, 400);
  }
  const row = await env.DB.prepare(
    'SELECT id, auth_mac, wrapped_dek_pw_sealed, dek_check, recovery_confirmed_at, disabled_at FROM accounts WHERE email = ?',
  ).bind(email).first();
  if (!row || row.auth_mac === null) return json({ error: 'no_account' }, 404);
  if (row.disabled_at) return json({ error: 'disabled' }, 403);
  const now = nowISO(env);
  if (!await reservePasswordAttempt(env, row.id, now)) {
    const cur = await env.DB.prepare('SELECT locked_until FROM accounts WHERE id = ?').bind(row.id).first();
    return json({ error: 'locked', retryAt: cur && cur.locked_until }, 429);
  }
  if (!timingSafeEqual(await A.mac(b.authKey), row.auth_mac)) return json({ error: 'bad_credentials' }, 401);
  const token = newToken();
  await env.DB.batch([
    clearPasswordFailures(env, row.id),
    env.DB.prepare('INSERT INTO devices (token_hash, account_id, name, created_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), row.id, b.deviceName, now),
  ]);
  return json({
    token,
    accountId: row.id,
    wrappedDekPw: await A.unseal('wrapped_dek_pw_sealed', row.id, row.wrapped_dek_pw_sealed),
    dekCheck: row.dek_check,
    recoveryConfirmed: row.recovery_confirmed_at !== null,
  });
}

async function handleBearer(path, request, env, now) {
  const device = await authenticateDevice(request, env, now);
  if (!device) return json({ error: 'unauthorized' }, 401);
  const { accountId, tokenHash } = device;
  if (path === '/auth/logout') {
    await env.DB.prepare('DELETE FROM devices WHERE token_hash = ?').bind(tokenHash).run();
    return json({ ok: true });
  }
  if (path === '/account') {
    const row = await env.DB.prepare('SELECT email, recovery_confirmed_at FROM accounts WHERE id = ?').bind(accountId).first();
    return json({ accountId, email: row.email, recoveryConfirmed: row.recovery_confirmed_at !== null });
  }
  if (path === '/account/devices') {
    const { results } = await env.DB.prepare(
      'SELECT token_hash, name, created_at, last_seen_at FROM devices WHERE account_id = ? ORDER BY created_at, token_hash',
    ).bind(accountId).all();
    return json({
      devices: results.map((d) => ({
        name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, current: d.token_hash === tokenHash,
      })),
    });
  }
  if (path === '/account/devices/signout-others') {
    const res = await env.DB.prepare('DELETE FROM devices WHERE account_id = ? AND token_hash != ?').bind(accountId, tokenHash).run();
    return json({ signedOut: res.meta.changes });
  }
  // /account/recovery/confirm
  await env.DB.prepare('UPDATE accounts SET recovery_confirmed_at = COALESCE(recovery_confirmed_at, ?) WHERE id = ?')
    .bind(now, accountId).run();
  return json({ ok: true });
}

const ROUTES = {
  '/auth/signup': ['POST', 'signup'],
  '/auth/prelogin': ['POST', 'prelogin'],
  '/auth/login': ['POST', 'login'],
  '/auth/logout': ['POST', 'bearer'],
  '/account': ['GET', 'bearer'],
  '/account/devices': ['GET', 'bearer'],
  '/account/devices/signout-others': ['POST', 'bearer'],
  '/account/recovery/confirm': ['POST', 'bearer'],
};

// Returns a Response for an account route, or null when the path is not one.
// Throws propagate to index.js's catch (500 internal_error).
export async function handleAccountRoute(pathname, request, env) {
  const route = ROUTES[pathname];
  if (!route) return null;
  if (request.method !== route[0]) return json({ error: 'method_not_allowed' }, 405);
  try {
    const A = await atRest(env);
    await checkKey(env);
    if (route[1] === 'signup') return await handleSignup(request, env, A);
    if (route[1] === 'prelogin') return await handlePrelogin(request, env);
    if (route[1] === 'login') return await handleLogin(request, env, A);
    return await handleBearer(pathname, request, env, nowISO(env));
  } catch (e) {
    if (e instanceof AtRestError) return json({ error: e.code }, 500);
    throw e;
  }
}
