// accounts.js — sign-up, prelogin, login (with atomic lockout), logout, devices,
// account info, recovery confirm, recovery, password change, new recovery link
// and legacy upgrade (spec § 6.1 - 6.7).
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
    || typeof b.dekCheck !== 'string' || !/^[0-9a-f]{64}$/.test(b.dekCheck)
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

const validKdf = (b) => isB64u(b.kdfSalt, 16) && Number.isInteger(b.kdfIters) && b.kdfIters >= MIN_ITERS;

// Shared by recover/start and recover/finish: the row is found by email, then
// the recovery key is checked. Recovery is exempt from the D11 lockout, so a
// wrong key is never counted. Returns {row} or {res}.
async function recoveryRow(env, A, email, recAuthKey) {
  const row = await env.DB.prepare(
    'SELECT id, rec_auth_mac, wrapped_dek_rec_sealed, dek_check, disabled_at FROM accounts WHERE email = ?',
  ).bind(email).first();
  if (!row || row.rec_auth_mac === null) return { res: json({ error: 'bad_recovery' }, 401) };
  if (row.disabled_at) return { res: json({ error: 'disabled' }, 403) };
  if (!timingSafeEqual(await A.mac(recAuthKey), row.rec_auth_mac)) return { res: json({ error: 'bad_recovery' }, 401) };
  return { row };
}

async function handleRecoverStart(request, env, A) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || !EMAIL_RE.test(email) || !isB64u(b.recAuthKey, 32)) return json({ error: 'bad_request' }, 400);
  const { row, res } = await recoveryRow(env, A, email, b.recAuthKey);
  if (res) return res;
  return json({
    accountId: row.id,
    wrappedDekRec: await A.unseal('wrapped_dek_rec_sealed', row.id, row.wrapped_dek_rec_sealed),
    dekCheck: row.dek_check,
  });
}

async function handleRecoverFinish(request, env, A) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || !EMAIL_RE.test(email) || !isB64u(b.recAuthKey, 32) || !validKdf(b)
    || !isB64u(b.authKey, 32) || !isB64u(b.recAuthKey2, 32)
    || !isB64(b.wrappedDekPw, 60) || !isB64(b.wrappedDekRec2, 60) || !validName(b.deviceName)) {
    return json({ error: 'bad_request' }, 400);
  }
  const { row, res } = await recoveryRow(env, A, email, b.recAuthKey);
  if (res) return res;
  const id = row.id;
  const now = nowISO(env);
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const oldMac = await A.mac(b.recAuthKey);
  const newMac = await A.mac(b.recAuthKey2);
  const pw = await A.seal('wrapped_dek_pw_sealed', id, b.wrappedDekPw);
  const recW = await A.seal('wrapped_dek_rec_sealed', id, b.wrappedDekRec2);
  const authMac = await A.mac(b.authKey);
  // One batch. The DELETE and INSERT are conditioned on the NEW rec_auth_mac,
  // so they run only if this call's UPDATE landed (spec § 6.3 step 4).
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET kdf_salt=?, kdf_iters=?, auth_mac=?, rec_auth_mac=?, wrapped_dek_pw_sealed=?, wrapped_dek_rec_sealed=?,
        recovery_confirmed_at=NULL, failed_logins=0, locked_until=NULL WHERE id=? AND rec_auth_mac=?`)
      .bind(b.kdfSalt, b.kdfIters, authMac, newMac, pw, recW, id, oldMac),
    env.DB.prepare('DELETE FROM devices WHERE account_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND rec_auth_mac = ?)')
      .bind(id, id, newMac),
    env.DB.prepare('INSERT INTO devices (token_hash, account_id, name, created_at) SELECT ?, id, ?, ? FROM accounts WHERE id = ? AND rec_auth_mac = ?')
      .bind(tokenHash, b.deviceName, now, id, newMac),
  ]);
  if (results[0].meta.changes !== 1) return json({ error: 'recovery_changed' }, 409);
  return json({ token, accountId: id });
}

// Password-gated account changes (change password, new recovery link): the
// current key goes through the same atomic attempt reservation as login.
// Returns {row} to proceed, or {res}.
async function verifyCurrentPassword(env, A, accountId, currentAuthKey, now) {
  const row = await env.DB.prepare('SELECT auth_mac FROM accounts WHERE id = ?').bind(accountId).first();
  if (!row || row.auth_mac === null) return { res: json({ error: 'no_password' }, 409) };
  if (!await reservePasswordAttempt(env, accountId, now)) {
    const cur = await env.DB.prepare('SELECT locked_until FROM accounts WHERE id = ?').bind(accountId).first();
    return { res: json({ error: 'locked', retryAt: cur && cur.locked_until }, 429) };
  }
  if (!timingSafeEqual(await A.mac(currentAuthKey), row.auth_mac)) return { res: json({ error: 'bad_credentials' }, 401) };
  return { row };
}

async function handlePasswordChange(request, env, A, device, now) {
  const b = await readBody(request);
  if (!b || !isB64u(b.currentAuthKey, 32) || !validKdf(b) || !isB64u(b.authKey, 32)
    || !isB64(b.wrappedDekPw, 60) || typeof b.signOutOthers !== 'boolean') {
    return json({ error: 'bad_request' }, 400);
  }
  const { accountId, tokenHash } = device;
  const { row, res } = await verifyCurrentPassword(env, A, accountId, b.currentAuthKey, now);
  if (res) return res;
  const newMac = await A.mac(b.authKey);
  const pw = await A.seal('wrapped_dek_pw_sealed', accountId, b.wrappedDekPw);
  const stmts = [
    env.DB.prepare(`UPDATE accounts SET kdf_salt=?, kdf_iters=?, auth_mac=?, wrapped_dek_pw_sealed=?,
        failed_logins=0, locked_until=NULL WHERE id=? AND auth_mac=?`)
      .bind(b.kdfSalt, b.kdfIters, newMac, pw, accountId, row.auth_mac),
  ];
  if (b.signOutOthers) {
    stmts.push(env.DB.prepare(
      'DELETE FROM devices WHERE account_id = ? AND token_hash != ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND auth_mac = ?)',
    ).bind(accountId, tokenHash, accountId, newMac));
  }
  const results = await env.DB.batch(stmts);
  if (results[0].meta.changes !== 1) return json({ error: 'password_changed' }, 409);
  return json({ ok: true });
}

async function handleNewRecovery(request, env, A, device, now) {
  const b = await readBody(request);
  if (!b || !isB64u(b.currentAuthKey, 32) || !isB64u(b.recAuthKey, 32) || !isB64(b.wrappedDekRec, 60)) {
    return json({ error: 'bad_request' }, 400);
  }
  const { accountId } = device;
  const { row, res } = await verifyCurrentPassword(env, A, accountId, b.currentAuthKey, now);
  if (res) return res;
  const recMac = await A.mac(b.recAuthKey);
  const recW = await A.seal('wrapped_dek_rec_sealed', accountId, b.wrappedDekRec);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET rec_auth_mac=?, wrapped_dek_rec_sealed=?, recovery_confirmed_at=NULL,
        failed_logins=0, locked_until=NULL WHERE id=? AND auth_mac=?`)
      .bind(recMac, recW, accountId, row.auth_mac),
  ]);
  if (results[0].meta.changes !== 1) return json({ error: 'password_changed' }, 409);
  return json({ ok: true });
}

async function handleUpgrade(request, env, A, device) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || !EMAIL_RE.test(email) || email.length > 254 || !validKdf(b)
    || !isB64u(b.authKey, 32) || !isB64u(b.recAuthKey, 32)
    || !isB64(b.wrappedDekPw, 60) || !isB64(b.wrappedDekRec, 60)
    || typeof b.dekCheck !== 'string' || !/^[0-9a-f]{64}$/.test(b.dekCheck)) {
    return json({ error: 'bad_request' }, 400);
  }
  const { accountId } = device;
  const pw = await A.seal('wrapped_dek_pw_sealed', accountId, b.wrappedDekPw);
  const recW = await A.seal('wrapped_dek_rec_sealed', accountId, b.wrappedDekRec);
  let res;
  try {
    res = await env.DB.prepare(`UPDATE accounts SET email=?, kdf_salt=?, kdf_iters=?, auth_mac=?, rec_auth_mac=?,
        wrapped_dek_pw_sealed=?, wrapped_dek_rec_sealed=?, dek_check=?, recovery_confirmed_at=NULL
        WHERE id=? AND email IS NULL`)
      .bind(email, b.kdfSalt, b.kdfIters, await A.mac(b.authKey), await A.mac(b.recAuthKey), pw, recW, b.dekCheck, accountId).run();
  } catch (err) {
    if (/UNIQUE constraint failed: accounts\.email/.test(String(err && err.message))) return json({ error: 'email_taken' }, 409);
    throw err;
  }
  if (res.meta.changes !== 1) return json({ error: 'already_upgraded' }, 409);
  return json({ ok: true, accountId });
}

async function handleBearer(path, request, env, A, now) {
  const device = await authenticateDevice(request, env, now);
  if (!device) return json({ error: 'unauthorized' }, 401);
  const { accountId, tokenHash } = device;
  if (path === '/account/password') return handlePasswordChange(request, env, A, device, now);
  if (path === '/account/recovery') return handleNewRecovery(request, env, A, device, now);
  if (path === '/account/upgrade') return handleUpgrade(request, env, A, device);
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
  '/auth/recover/start': ['POST', 'recover-start'],
  '/auth/recover/finish': ['POST', 'recover-finish'],
  '/account/password': ['POST', 'bearer'],
  '/account/recovery': ['POST', 'bearer'],
  '/account/upgrade': ['POST', 'bearer'],
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
    if (route[1] === 'recover-start') return await handleRecoverStart(request, env, A);
    if (route[1] === 'recover-finish') return await handleRecoverFinish(request, env, A);
    return await handleBearer(pathname, request, env, A, nowISO(env));
  } catch (e) {
    if (e instanceof AtRestError) return json({ error: e.code }, 500);
    throw e;
  }
}
