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
import { normEmail, validEmail, readBody } from './input.js';

const MIN_ITERS = 600000;
const MAX_ITERS = 10_000_000; // a compromised or buggy client cannot make every later login hang
const MAX_FAILED = 50; // anonymous /auth/login guesses per account (D11)
const LOCK_MINUTES = 60;
const DEVICE_MAX_FAILED = 10; // password checks made with a session, per device (sweep W1-I7)

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
const validIters = (n) => Number.isInteger(n) && n >= MIN_ITERS && n <= MAX_ITERS;
const validKdf = (b) => isB64u(b.kdfSalt, 16) && validIters(b.kdfIters);

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

// The same atomic reservation on the calling DEVICE's own counter, for the
// password checks made with a session (change password, new recovery link).
// It never touches accounts.failed_logins, so an anonymous guesser who locks
// /auth/login cannot also lock the signed-in owner out of these routes.
async function reserveDeviceAttempt(env, tokenHash, now) {
  const lockUntil = addMinutes(now, LOCK_MINUTES);
  const reserved = await env.DB.prepare(`UPDATE devices SET
      failed_pw       = CASE WHEN pw_locked_until IS NOT NULL AND pw_locked_until <= ? THEN 1 ELSE failed_pw + 1 END,
      pw_locked_until = CASE WHEN pw_locked_until IS NOT NULL AND pw_locked_until <= ? THEN NULL
                             WHEN failed_pw + 1 >= ${DEVICE_MAX_FAILED} THEN ? ELSE pw_locked_until END
    WHERE token_hash = ? AND (pw_locked_until IS NULL OR pw_locked_until <= ?) RETURNING failed_pw`)
    .bind(now, now, lockUntil, tokenHash, now).first();
  return Boolean(reserved);
}

// Reserve an attempt, or build the 429. On refusal the lock end is read in a
// second statement; a lock cleared in between (a success elsewhere, a
// recovery) is retried once, and retryAt is never null — if the lock keeps
// vanishing it is now + LOCK_MINUTES. readLock returns {until} or null when
// the row itself is gone, which answers `gone`.
async function reserveOr429(reserve, readLock, now, gone) {
  for (let i = 0; i < 2; i += 1) {
    if (await reserve()) return null;
    const lock = await readLock();
    if (!lock) return gone();
    if (lock.until && lock.until > now) return json({ error: 'locked', retryAt: lock.until }, 429);
  }
  return json({ error: 'locked', retryAt: addMinutes(now, LOCK_MINUTES) }, 429);
}

const readAccountLock = (env, id) => env.DB.prepare('SELECT locked_until FROM accounts WHERE id = ?').bind(id).first()
  .then((r) => (r ? { until: r.locked_until } : null));
const readDeviceLock = (env, tokenHash) => env.DB.prepare('SELECT pw_locked_until FROM devices WHERE token_hash = ?').bind(tokenHash).first()
  .then((r) => (r ? { until: r.pw_locked_until } : null));

async function handleSignup(request, env, A) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || typeof b.invite !== 'string' || !b.invite || b.invite.length > 200
    || !validEmail(email) || !validKdf(b)
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
                        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, hash, ? FROM invites WHERE hash = ? AND used_at = ? RETURNING id`)
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
    // RETURNING, not meta.changes: per-statement changes inside a real-D1
    // batch are unverified here; the returned row also proves WHICH account.
    const created = results[1].results;
    if (created.length !== 1 || created[0].id !== id) return json({ error: 'invalid_invite' }, 403);
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
  if (!b || !validEmail(email) || !isB64u(b.authKey, 32) || !validName(b.deviceName)) {
    return json({ error: 'bad_request' }, 400);
  }
  const row = await env.DB.prepare(
    'SELECT id, auth_mac, wrapped_dek_pw_sealed, dek_check, recovery_confirmed_at, disabled_at FROM accounts WHERE email = ?',
  ).bind(email).first();
  const noAccount = () => json({ error: 'no_account' }, 404);
  if (!row || row.auth_mac === null) return noAccount();
  const now = nowISO(env);
  const locked = await reserveOr429(() => reservePasswordAttempt(env, row.id, now), () => readAccountLock(env, row.id), now, noAccount);
  if (locked) return locked;
  if (!timingSafeEqual(await A.mac(b.authKey), row.auth_mac)) return json({ error: 'bad_credentials' }, 401);
  // After the key check, so a wrong key cannot learn that an account is disabled (SEC #7).
  if (row.disabled_at) return json({ error: 'disabled' }, 403);
  // Unseal BEFORE any session exists: a bad seal is 500 bad_seal with no device minted.
  const wrappedDekPw = await A.unseal('wrapped_dek_pw_sealed', row.id, row.wrapped_dek_pw_sealed);
  const token = newToken();
  // Both statements are conditioned on the MAC this request compared and on
  // the account still being enabled: a password change, a recovery or an
  // admin disable that lands between the compare and here mints nothing.
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ? AND auth_mac = ? AND disabled_at IS NULL')
      .bind(row.id, row.auth_mac),
    env.DB.prepare(`INSERT INTO devices (token_hash, account_id, name, created_at)
                    SELECT ?, id, ?, ? FROM accounts WHERE id = ? AND auth_mac = ? AND disabled_at IS NULL RETURNING account_id`)
      .bind(await sha256Hex(token), b.deviceName, now, row.id, row.auth_mac),
  ]);
  if (results[1].results.length !== 1) {
    const cur = await env.DB.prepare('SELECT disabled_at FROM accounts WHERE id = ?').bind(row.id).first();
    if (cur && cur.disabled_at) return json({ error: 'disabled' }, 403);
    return json({ error: 'bad_credentials' }, 401);
  }
  return json({
    token,
    accountId: row.id,
    wrappedDekPw,
    dekCheck: row.dek_check,
    recoveryConfirmed: row.recovery_confirmed_at !== null,
  });
}

// Shared by recover/start and recover/finish: the row is found by email, then
// the recovery key is checked. Recovery is exempt from the D11 lockout, so a
// wrong key is never counted. Returns {row} or {res}.
async function recoveryRow(env, A, email, recAuthKey) {
  const row = await env.DB.prepare(
    'SELECT id, rec_auth_mac, wrapped_dek_rec_sealed, dek_check, disabled_at FROM accounts WHERE email = ?',
  ).bind(email).first();
  if (!row || row.rec_auth_mac === null) return { res: json({ error: 'bad_recovery' }, 401) };
  if (!timingSafeEqual(await A.mac(recAuthKey), row.rec_auth_mac)) return { res: json({ error: 'bad_recovery' }, 401) };
  // After the key check: no disabled oracle for a wrong key (SEC #7).
  if (row.disabled_at) return { res: json({ error: 'disabled' }, 403) };
  return { row };
}

async function handleRecoverStart(request, env, A) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || !validEmail(email) || !isB64u(b.recAuthKey, 32)) return json({ error: 'bad_request' }, 400);
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
  if (!b || !validEmail(email) || !isB64u(b.recAuthKey, 32) || !validKdf(b)
    || !isB64u(b.authKey, 32) || !isB64u(b.recAuthKey2, 32) || b.recAuthKey2 === b.recAuthKey
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
  // Sealed with a fresh IV, so this value is unique to THIS request: the
  // DELETE and INSERT key on it, not on newMac, and an identical replayed
  // body (same newMac) cannot delete the winner's device (sweep W1-I2).
  const recW = await A.seal('wrapped_dek_rec_sealed', id, b.wrappedDekRec2);
  const authMac = await A.mac(b.authKey);
  // One batch (spec § 6.3 step 4). The UPDATE also requires the account to be
  // enabled, so a disable landing after recoveryRow mints nothing.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET kdf_salt=?, kdf_iters=?, auth_mac=?, rec_auth_mac=?, wrapped_dek_pw_sealed=?, wrapped_dek_rec_sealed=?,
        recovery_confirmed_at=NULL, failed_logins=0, locked_until=NULL WHERE id=? AND rec_auth_mac=? AND disabled_at IS NULL RETURNING id`)
      .bind(b.kdfSalt, b.kdfIters, authMac, newMac, pw, recW, id, oldMac),
    env.DB.prepare('DELETE FROM devices WHERE account_id = ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND wrapped_dek_rec_sealed = ?)')
      .bind(id, id, recW),
    env.DB.prepare('INSERT INTO devices (token_hash, account_id, name, created_at) SELECT ?, id, ?, ? FROM accounts WHERE id = ? AND wrapped_dek_rec_sealed = ?')
      .bind(tokenHash, b.deviceName, now, id, recW),
  ]);
  if (results[0].results.length !== 1) {
    const cur = await env.DB.prepare('SELECT disabled_at FROM accounts WHERE id = ?').bind(id).first();
    if (cur && cur.disabled_at) return json({ error: 'disabled' }, 403);
    return json({ error: 'recovery_changed' }, 409);
  }
  return json({ token, accountId: id });
}

// Password-gated account changes (change password, new recovery link): the
// current key goes through the calling device's own attempt reservation
// (sweep W1-I7). Returns {row} to proceed, or {res}.
async function verifyCurrentPassword(env, A, device, currentAuthKey, now) {
  const row = await env.DB.prepare('SELECT auth_mac FROM accounts WHERE id = ?').bind(device.accountId).first();
  if (!row || row.auth_mac === null) return { res: json({ error: 'no_password' }, 409) };
  const locked = await reserveOr429(
    () => reserveDeviceAttempt(env, device.tokenHash, now),
    () => readDeviceLock(env, device.tokenHash),
    now,
    () => json({ error: 'unauthorized' }, 401), // the device was signed out mid-request
  );
  if (locked) return { res: locked };
  if (!timingSafeEqual(await A.mac(currentAuthKey), row.auth_mac)) return { res: json({ error: 'bad_credentials' }, 401) };
  return { row };
}

const clearDeviceFailures = (env, tokenHash) => env.DB.prepare(
  'UPDATE devices SET failed_pw = 0, pw_locked_until = NULL WHERE token_hash = ?').bind(tokenHash);

async function handlePasswordChange(request, env, A, device, now) {
  const b = await readBody(request);
  if (!b || !isB64u(b.currentAuthKey, 32) || !validKdf(b) || !isB64u(b.authKey, 32)
    || !isB64(b.wrappedDekPw, 60) || typeof b.signOutOthers !== 'boolean') {
    return json({ error: 'bad_request' }, 400);
  }
  const { accountId, tokenHash } = device;
  const { row, res } = await verifyCurrentPassword(env, A, device, b.currentAuthKey, now);
  if (res) return res;
  const newMac = await A.mac(b.authKey);
  // Fresh IV: unique to this request, so the optional sign-out keys on it and
  // a concurrent change to the SAME new password that lost cannot sign out.
  const pw = await A.seal('wrapped_dek_pw_sealed', accountId, b.wrappedDekPw);
  // The new password also restarts the anonymous login counter: the guesses
  // it counted were against the old password.
  const stmts = [
    env.DB.prepare(`UPDATE accounts SET kdf_salt=?, kdf_iters=?, auth_mac=?, wrapped_dek_pw_sealed=?,
        failed_logins=0, locked_until=NULL WHERE id=? AND auth_mac=? RETURNING id`)
      .bind(b.kdfSalt, b.kdfIters, newMac, pw, accountId, row.auth_mac),
    clearDeviceFailures(env, tokenHash),
  ];
  if (b.signOutOthers) {
    stmts.push(env.DB.prepare(
      'DELETE FROM devices WHERE account_id = ? AND token_hash != ? AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND wrapped_dek_pw_sealed = ?)',
    ).bind(accountId, tokenHash, accountId, pw));
  }
  const results = await env.DB.batch(stmts);
  if (results[0].results.length !== 1) return json({ error: 'password_changed' }, 409);
  return json({ ok: true });
}

async function handleNewRecovery(request, env, A, device, now) {
  const b = await readBody(request);
  if (!b || !isB64u(b.currentAuthKey, 32) || !isB64u(b.recAuthKey, 32) || !isB64(b.wrappedDekRec, 60)) {
    return json({ error: 'bad_request' }, 400);
  }
  const { accountId, tokenHash } = device;
  const { row, res } = await verifyCurrentPassword(env, A, device, b.currentAuthKey, now);
  if (res) return res;
  const recMac = await A.mac(b.recAuthKey);
  const recW = await A.seal('wrapped_dek_rec_sealed', accountId, b.wrappedDekRec);
  // Does not reset accounts.failed_logins: a new recovery link changes nothing
  // an anonymous login guesser is guessing.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET rec_auth_mac=?, wrapped_dek_rec_sealed=?, recovery_confirmed_at=NULL
        WHERE id=? AND auth_mac=? RETURNING id`)
      .bind(recMac, recW, accountId, row.auth_mac),
    clearDeviceFailures(env, tokenHash),
  ]);
  if (results[0].results.length !== 1) return json({ error: 'password_changed' }, 409);
  return json({ ok: true });
}

async function handleUpgrade(request, env, A, device, now) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || !validEmail(email) || !validKdf(b)
    || !isB64u(b.authKey, 32) || !isB64u(b.recAuthKey, 32)
    || !isB64(b.wrappedDekPw, 60) || !isB64(b.wrappedDekRec, 60)
    || typeof b.dekCheck !== 'string' || !/^[0-9a-f]{64}$/.test(b.dekCheck)
    || typeof b.upgradeCode !== 'string' || !b.upgradeCode || b.upgradeCode.length > 200) {
    return json({ error: 'bad_request' }, 400);
  }
  const { accountId } = device;
  const pw = await A.seal('wrapped_dek_pw_sealed', accountId, b.wrappedDekPw);
  const recW = await A.seal('wrapped_dek_rec_sealed', accountId, b.wrappedDekRec);
  const codeHash = await sha256Hex(b.upgradeCode);
  const nonce = `${now}|${crypto.randomUUID()}`;
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(`UPDATE upgrade_codes SET used_at = ? WHERE hash = ? AND account_id = ? AND used_at IS NULL AND expires_at > ?
                        AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND email IS NULL)`)
        .bind(nonce, codeHash, accountId, now, accountId),
      env.DB.prepare(`UPDATE accounts SET email=?, kdf_salt=?, kdf_iters=?, auth_mac=?, rec_auth_mac=?,
          wrapped_dek_pw_sealed=?, wrapped_dek_rec_sealed=?, dek_check=?, recovery_confirmed_at=NULL
          WHERE id=? AND email IS NULL AND EXISTS (SELECT 1 FROM upgrade_codes WHERE hash = ? AND account_id = ? AND used_at = ?)
          RETURNING id`)
        .bind(email, b.kdfSalt, b.kdfIters, await A.mac(b.authKey), await A.mac(b.recAuthKey), pw, recW, b.dekCheck,
          accountId, codeHash, accountId, nonce),
    ]);
  } catch (err) {
    if (/UNIQUE constraint failed: accounts\.email/.test(String(err && err.message))) return json({ error: 'email_taken' }, 409);
    throw err;
  }
  if (results[1].results.length === 1) return json({ ok: true, accountId });
  const cur = await env.DB.prepare('SELECT email FROM accounts WHERE id = ?').bind(accountId).first();
  if (!cur || cur.email !== null) return json({ error: 'already_upgraded' }, 409);
  return json({ error: 'invalid_upgrade_code' }, 403);
}

async function handleBearer(path, request, env, A, now) {
  const device = await authenticateDevice(request, env, now);
  if (!device) return json({ error: 'unauthorized' }, 401);
  const { accountId, tokenHash } = device;
  if (path === '/account/password') return handlePasswordChange(request, env, A, device, now);
  if (path === '/account/recovery') return handleNewRecovery(request, env, A, device, now);
  if (path === '/account/upgrade') return handleUpgrade(request, env, A, device, now);
  if (path === '/auth/logout') {
    await env.DB.prepare('DELETE FROM devices WHERE token_hash = ?').bind(tokenHash).run();
    return json({ ok: true });
  }
  if (path === '/account') {
    const row = await env.DB.prepare('SELECT email, recovery_confirmed_at FROM accounts WHERE id = ?').bind(accountId).first();
    if (!row) return json({ error: 'unauthorized' }, 401); // deleted after authenticateDevice
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
  // /account/recovery/confirm {recAuthKey}: confirms the code the caller has
  // on screen, and only while it is still the account's recovery key — a new
  // link made on another device in the meantime is 409 recovery_changed.
  const b = await readBody(request);
  if (!b || !isB64u(b.recAuthKey, 32)) return json({ error: 'bad_request' }, 400);
  const confirmed = await env.DB.prepare(
    'UPDATE accounts SET recovery_confirmed_at = COALESCE(recovery_confirmed_at, ?) WHERE id = ? AND rec_auth_mac = ? RETURNING id',
  ).bind(now, accountId, await A.mac(b.recAuthKey)).first();
  if (!confirmed) return json({ error: 'recovery_changed' }, 409);
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
