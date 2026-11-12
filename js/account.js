// account.js — client API for invite-only accounts (spec 6.1-6.7, D18).
// Pure network + crypto: never touches storage. Every function takes
// {fetchImpl, apiBase} last. Failures throw AccountError(code); nothing
// degrades silently.

import { WORKER_URL, APP_URL } from './config.js';
import {
  MIN_KDF_ITERS, KDF_ITERS, newSalt, newRecoveryCode, derivePasswordKeys, deriveRecoveryKeys,
  wrapDek, unwrapDek, dekCheck,
} from './keys.js';
import { bytesToBase64url, generateEncKey, composeLinkCode, parseLinkCode, decryptBlob } from './crypto.js';

export class AccountError extends Error {
  constructor(code, extra = {}, status = null) {
    super(code);
    this.name = 'AccountError';
    this.code = code;
    this.extra = extra;
    this.status = status;
  }
}

const KEY_ERRORS = new Set(['kdf_iters_too_low', 'kdf_iters_out_of_range', 'unwrap_failed', 'bad_salt', 'bad_recovery_code']);

// Every failure inside becomes an AccountError: known js/keys.js codes keep
// their code, anything else is 'server' (never a bare Error). Caller-supplied
// hooks must run outside keyOp so their throws propagate unchanged.
async function keyOp(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof AccountError) throw e;
    if (e && KEY_ERRORS.has(e.message)) throw new AccountError(e.message);
    throw new AccountError('server');
  }
}

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
// Throws AccountError('server') unless every named check passes on the 2xx body.
function shape(res, checks) {
  if (!res || typeof res !== 'object') throw new AccountError('server');
  for (const [k, ok] of Object.entries(checks)) if (!ok(res[k])) throw new AccountError('server');
  return res;
}

function ctx(o = {}) {
  return {
    fetchImpl: o.fetchImpl || ((...a) => fetch(...a)),
    apiBase: o.apiBase || WORKER_URL,
    minKdfIters: o.minKdfIters ?? MIN_KDF_ITERS,
  };
}

// Returns {status, ok, json}; throws AccountError on transport or shape failure
// only when `strict` (default). Non-OK JSON {error} always becomes AccountError.
async function call(c, method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await c.fetchImpl(`${c.apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new AccountError('unreachable');
  }
  let json;
  try { json = await res.json(); } catch { throw new AccountError('server'); }
  if (!res.ok) {
    if (!json || typeof json.error !== 'string') throw new AccountError('server');
    const { error, ...extra } = json;
    throw new AccountError(error, extra, res.status);
  }
  return json;
}

const post = (c, path, body, token) => call(c, 'POST', path, { body, token });

async function prelogin(c, email) {
  return shape(await post(c, '/auth/prelogin', { email }), { kdfSalt: isStr, kdfIters: Number.isInteger });
}

// D18: before any password / recovery change, prove this device's key decrypts
// the account blob. An empty blob (never synced) has nothing to check.
async function checkDeviceKey(c, link) {
  const data = await call(c, 'GET', '/data', { token: link.authToken });
  if (typeof data.blob !== 'string') throw new AccountError('server');
  if (data.blob === '') return;
  try { await decryptBlob(link.encKey, data.blob); } catch { throw new AccountError('wrong_key_on_device'); }
}

export async function signUp({ invite, email, password, deviceName, iters = KDF_ITERS, minKdfIters, ...o }) {
  const c = ctx({ ...o, minKdfIters });
  return keyOp(async () => {
    const dek = generateEncKey();
    const recoveryCode = newRecoveryCode();
    const salt = bytesToBase64url(newSalt());
    const { authKey, wrapKey } = await derivePasswordKeys(password, salt, iters, { minKdfIters: c.minKdfIters });
    const rec = await deriveRecoveryKeys(recoveryCode);
    const res = shape(await post(c, '/auth/signup', {
      invite, email, kdfSalt: salt, kdfIters: iters, authKey, recAuthKey: rec.recAuthKey,
      wrappedDekPw: await wrapDek(wrapKey, dek, 'pw'), wrappedDekRec: await wrapDek(rec.wrapKey, dek, 'rec'),
      dekCheck: await dekCheck(dek), deviceName,
    }), { token: isStr, accountId: isId });
    return { code: composeLinkCode(res.token, dek), accountId: res.accountId, recoveryCode };
  });
}

// The server has minted a session (`answer` carries its token) and a check
// on this device then failed (sweep W2-I2): nothing will ever hold that
// session, and a device row nobody can sign out never expires. Revoked best
// effort — logOut never throws — and the original error propagates.
async function revokeOnThrow(c, answer, fn) {
  try {
    return await fn();
  } catch (err) {
    if (answer && isStr(answer.token)) await logOut({ link: { authToken: answer.token }, fetchImpl: c.fetchImpl, apiBase: c.apiBase });
    throw err;
  }
}

export async function logIn({ email, password, deviceName, ...o }) {
  const c = ctx(o);
  return keyOp(async () => {
    const pre = await prelogin(c, email);
    const { authKey, wrapKey } = await derivePasswordKeys(password, pre.kdfSalt, pre.kdfIters, { minKdfIters: c.minKdfIters });
    const answer = await post(c, '/auth/login', { email, authKey, deviceName });
    return revokeOnThrow(c, answer, async () => {
      const res = shape(answer,
        { token: isStr, accountId: isId, wrappedDekPw: isStr, dekCheck: isStr, recoveryConfirmed: (v) => typeof v === 'boolean' });
      const dek = await unwrapDek(wrapKey, res.wrappedDekPw, 'pw');
      if (await dekCheck(dek) !== res.dekCheck) throw new AccountError('dek_check_failed');
      return { code: composeLinkCode(res.token, dek), accountId: res.accountId, recoveryConfirmed: res.recoveryConfirmed };
    });
  });
}

export async function recover({ email, recoveryCode, newPassword, deviceName, onAccountKnown, iters = KDF_ITERS, ...o }) {
  const c = ctx(o);
  const known = await keyOp(async () => {
    const old = await deriveRecoveryKeys(recoveryCode);
    const start = shape(await post(c, '/auth/recover/start', { email, recAuthKey: old.recAuthKey }),
      { accountId: isId, wrappedDekRec: isStr, dekCheck: isStr });
    const dek = await unwrapDek(old.wrapKey, start.wrappedDekRec, 'rec');
    if (await dekCheck(dek) !== start.dekCheck) throw new AccountError('dek_check_failed');
    return { old, dek, accountId: start.accountId };
  });
  // Outside keyOp: a throw from the hook propagates unchanged and aborts before finish.
  await onAccountKnown?.(known.accountId);
  return keyOp(async () => {
    const { old, dek } = known;
    const salt = bytesToBase64url(newSalt());
    const { authKey, wrapKey } = await derivePasswordKeys(newPassword, salt, iters, { minKdfIters: c.minKdfIters });
    const newCode = newRecoveryCode();
    const nrec = await deriveRecoveryKeys(newCode);
    const fin = shape(await post(c, '/auth/recover/finish', {
      email, recAuthKey: old.recAuthKey, kdfSalt: salt, kdfIters: iters, authKey, recAuthKey2: nrec.recAuthKey,
      wrappedDekPw: await wrapDek(wrapKey, dek, 'pw'), wrappedDekRec2: await wrapDek(nrec.wrapKey, dek, 'rec'), deviceName,
    }), { token: isStr, accountId: isId });
    return { code: composeLinkCode(fin.token, dek), accountId: fin.accountId, recoveryCode: newCode };
  });
}

async function currentAuthKey(c, email, currentPassword) {
  const pre = await prelogin(c, email);
  return (await derivePasswordKeys(currentPassword, pre.kdfSalt, pre.kdfIters, { minKdfIters: c.minKdfIters })).authKey;
}

export async function changePassword({ link, email, currentPassword, newPassword, signOutOthers: signOutOtherDevices, iters = KDF_ITERS, ...o }) {
  const c = ctx(o);
  return keyOp(async () => {
    await checkDeviceKey(c, link);
    const currentAuth = await currentAuthKey(c, email, currentPassword);
    const salt = bytesToBase64url(newSalt());
    const { authKey, wrapKey } = await derivePasswordKeys(newPassword, salt, iters, { minKdfIters: c.minKdfIters });
    await post(c, '/account/password', {
      currentAuthKey: currentAuth, kdfSalt: salt, kdfIters: iters, authKey,
      wrappedDekPw: await wrapDek(wrapKey, link.encKey, 'pw'), signOutOthers: signOutOtherDevices === true,
    }, link.authToken);
    return { ok: true };
  });
}

export async function newRecoveryLink({ link, email, currentPassword, ...o }) {
  const c = ctx(o);
  return keyOp(async () => {
    await checkDeviceKey(c, link);
    const currentAuth = await currentAuthKey(c, email, currentPassword);
    const recoveryCode = newRecoveryCode();
    const rec = await deriveRecoveryKeys(recoveryCode);
    await post(c, '/account/recovery', {
      currentAuthKey: currentAuth, recAuthKey: rec.recAuthKey, wrappedDekRec: await wrapDek(rec.wrapKey, link.encKey, 'rec'),
    }, link.authToken);
    return { recoveryCode };
  });
}

// `upgradeCode` is the one-time code Alex mints with POST /admin/upgrade-code
// (sweep W1-C1): the server refuses an upgrade without it, so a missing one is
// refused here before any key is derived or anything is sent.
export async function upgrade({ link, email, password, upgradeCode, iters = KDF_ITERS, ...o }) {
  const c = ctx(o);
  const code = typeof upgradeCode === 'string' ? upgradeCode.trim() : '';
  if (!code) throw new AccountError('missing_upgrade_code');
  return keyOp(async () => {
    await checkDeviceKey(c, link);
    const recoveryCode = newRecoveryCode();
    const salt = bytesToBase64url(newSalt());
    const { authKey, wrapKey } = await derivePasswordKeys(password, salt, iters, { minKdfIters: c.minKdfIters });
    const rec = await deriveRecoveryKeys(recoveryCode);
    const res = shape(await post(c, '/account/upgrade', {
      email, kdfSalt: salt, kdfIters: iters, authKey, recAuthKey: rec.recAuthKey,
      wrappedDekPw: await wrapDek(wrapKey, link.encKey, 'pw'), wrappedDekRec: await wrapDek(rec.wrapKey, link.encKey, 'rec'),
      dekCheck: await dekCheck(link.encKey), upgradeCode: code,
    }, link.authToken), { accountId: isId });
    return { recoveryCode, accountId: res.accountId };
  });
}

export const getAccount = ({ link, ...o }) => call(ctx(o), 'GET', '/account', { token: link.authToken });
export const listDevices = ({ link, ...o }) => call(ctx(o), 'GET', '/account/devices', { token: link.authToken });
export const signOutOthers = ({ link, ...o }) => post(ctx(o), '/account/devices/signout-others', undefined, link.authToken);

// Confirms THE CODE ON SCREEN (sweep W1-I3 / W3-I2): the server sets
// recovery_confirmed_at only when this recAuthKey is the account's current
// one, so a link replaced on another device meanwhile answers 409
// recovery_changed instead of confirming a code nobody saved. A malformed
// code throws bad_recovery_code before anything is sent.
export async function confirmRecovery({ link, recoveryCode, ...o }) {
  const c = ctx(o);
  const { recAuthKey } = await keyOp(() => deriveRecoveryKeys(recoveryCode));
  return post(c, '/account/recovery/confirm', { recAuthKey }, link.authToken);
}

// Never throws. 401 means the session is already gone, which is the goal.
export async function logOut({ link, ...o }) {
  try {
    await post(ctx(o), '/auth/logout', undefined, link.authToken);
    return { revoked: true };
  } catch (e) {
    if (e instanceof AccountError && e.status === 401) return { revoked: true };
    return { revoked: false };
  }
}

export function recoveryLink(code) {
  return `${APP_URL}#recover=${code}`;
}

// The one sentence that travels with a recovery link: the mailto body here and
// accountui's Download file both use it, so the two cannot drift.
export const RECOVERY_NOTE = 'Keep this email. If you forget your password, open this link to reset it. Anyone with access to this email can reset your password.';

export function mailtoHref(email, code) {
  const subject = 'Your plaenicke recovery link';
  const body = `${recoveryLink(code)}\n\n${RECOVERY_NOTE}`;
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
