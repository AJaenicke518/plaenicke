// keys.js — client key derivation, DEK wrapping, recovery codes. Spec 4.1.
// Pure and async: no storage, no DOM. The password never leaves the device;
// only authKey / recAuthKey (HKDF outputs) are sent to the Worker.

import { bytesToBase64url, base64urlToBytes, KEY_BYTES } from './crypto.js';

export const MIN_KDF_ITERS = 600000;
export const KDF_ITERS = 600000;
const SALT_BYTES = 16;
const RECOVERY_BYTES = 16;
const IV_BYTES = 12;

const enc = new TextEncoder();
const subtle = () => crypto.subtle;
const ZERO32 = new Uint8Array(32);

const INFO = {
  auth: 'plaenicke/v1/auth',
  wrap: 'plaenicke/v1/wrap',
  recAuth: 'plaenicke/v1/rec-auth',
  recWrap: 'plaenicke/v1/rec-wrap',
  dekCheck: 'plaenicke/v1/dek-check',
};
const AAD = { pw: 'plaenicke/v1/dek-pw', rec: 'plaenicke/v1/dek-rec' };

export function newSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export function newRecoveryCode() {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(RECOVERY_BYTES)));
}

async function masterKey(password, saltBytes, iters) {
  const pwKey = await subtle().importKey('raw', enc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iters }, pwKey, 256);
}

// Test hook: skips the salt-length and iteration-floor checks.
export const _masterKeyForTest = masterKey;

function hkdfParams(info) {
  return { name: 'HKDF', hash: 'SHA-256', salt: ZERO32, info: enc.encode(info) };
}

async function hkdfKeys(ikmBytes, authInfo, wrapInfo) {
  const hk = await subtle().importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const auth = await subtle().deriveBits(hkdfParams(authInfo), hk, 256);
  const wrapKey = await subtle().deriveKey(hkdfParams(wrapInfo), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { auth: bytesToBase64url(new Uint8Array(auth)), wrapKey };
}

export async function derivePasswordKeys(password, saltB64u, iters, { minKdfIters = MIN_KDF_ITERS } = {}) {
  if (!Number.isInteger(iters) || iters < minKdfIters) throw new Error('kdf_iters_too_low');
  let salt;
  try { salt = base64urlToBytes(saltB64u); } catch { throw new Error('bad_salt'); }
  if (salt.length !== SALT_BYTES) throw new Error('bad_salt');
  const master = new Uint8Array(await masterKey(password, salt, iters));
  const { auth, wrapKey } = await hkdfKeys(master, INFO.auth, INFO.wrap);
  return { authKey: auth, wrapKey };
}

export async function deriveRecoveryKeys(code) {
  let bytes;
  try { bytes = base64urlToBytes(String(code).trim()); } catch { throw new Error('bad_recovery_code'); }
  if (bytes.length !== RECOVERY_BYTES) throw new Error('bad_recovery_code');
  const { auth, wrapKey } = await hkdfKeys(bytes, INFO.recAuth, INFO.recWrap);
  return { recAuthKey: auth, wrapKey };
}

function toB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function aadFor(kind) {
  const a = AAD[kind];
  if (!a) throw new Error('bad_kind');
  return enc.encode(a);
}

export async function wrapDek(wrapKey, dek, kind) {
  const additionalData = aadFor(kind);
  if (!(dek instanceof Uint8Array) || dek.length !== KEY_BYTES) throw new Error('bad_dek');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData }, wrapKey, dek));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return toB64(out);
}

export async function unwrapDek(wrapKey, wrapped, kind) {
  const additionalData = aadFor(kind);
  try {
    const bin = atob(wrapped);
    const all = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: all.slice(0, IV_BYTES), additionalData }, wrapKey, all.slice(IV_BYTES));
    const dek = new Uint8Array(pt);
    if (dek.length !== KEY_BYTES) throw new Error('bad length');
    return dek;
  } catch {
    throw new Error('unwrap_failed');
  }
}

export async function dekCheck(dek) {
  const key = await subtle().importKey('raw', dek, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await subtle().sign('HMAC', key, enc.encode(INFO.dekCheck)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}
