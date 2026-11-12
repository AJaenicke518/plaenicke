// seal.js — at-rest MAC and AES-GCM sealing for D1 columns (spec D5, § 4.2).
// The key (env.AT_REST_KEY, 32 bytes base64url) never leaves this module and is never logged.

export class AtRestError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const PREFIX = 'k1:';
const KEY_CHECK_INFO = 'plaenicke/v1/key-check';

function b64urlToBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
}

function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function atRest(env) {
  const raw = b64urlToBytes(env && env.AT_REST_KEY);
  if (!raw || raw.length !== 32) throw new AtRestError('not_configured');
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const derive = (info, algo, usages) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) },
    ikm, algo, false, usages);
  const macKey = await derive('plaenicke/v1/at-rest/mac', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  const sealKey = await derive('plaenicke/v1/at-rest/seal', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
  const aad = (column, accountId) => enc.encode(`${column}|${accountId}`);

  return {
    async mac(str) {
      return hex(await crypto.subtle.sign('HMAC', macKey, enc.encode(str)));
    },
    async seal(column, accountId, plaintext) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad(column, accountId) }, sealKey, enc.encode(plaintext)));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv, 0); out.set(ct, 12);
      return PREFIX + bytesToB64(out);
    },
    async unseal(column, accountId, sealed) {
      if (typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) throw new AtRestError('bad_seal');
      const bytes = b64ToBytes(sealed.slice(PREFIX.length));
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aad(column, accountId) },
        sealKey, bytes.slice(12));
      return dec.decode(pt);
    },
  };
}

// Positive results cached per isolate, keyed by the DB object; value is the verified mac.
const verified = new WeakMap();

export async function checkKey(env) {
  const a = await atRest(env);
  const expected = await a.mac(KEY_CHECK_INFO);
  if (verified.get(env.DB) === expected) return;
  const read = () => env.DB.prepare("SELECT value FROM config WHERE key = 'key-check'").first();
  let row = await read();
  if (!row) {
    await env.DB.prepare("INSERT INTO config (key, value) VALUES ('key-check', ?) ON CONFLICT(key) DO NOTHING")
      .bind(expected).run();
    row = await read();
  }
  if (!row || row.value !== expected) throw new AtRestError('at_rest_key_mismatch');
  verified.set(env.DB, expected);
}
