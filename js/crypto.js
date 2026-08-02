// crypto.js — AES-GCM for the sync blob, and the link-code encoding.
//
// A link code carries two independent secrets concatenated:
//   base64url( authToken(32 bytes) || encKey(32 bytes) )
// authToken proves the device may talk to the Worker and is stored server-side
// hashed. encKey decrypts the blob and NEVER leaves this device — a full
// database compromise yields ciphertext. See spec 4.1.
//
// The base64url here must match worker/src/auth.js byte for byte: the Worker
// stored sha256 of the exact token string it minted, so a token that
// re-encodes even one character differently authenticates as nobody.

export const KEY_BYTES = 32;
export const TOKEN_BYTES = 32;
export const IV_BYTES = 12;

const LINK_CODE_BYTES = TOKEN_BYTES + KEY_BYTES;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function bytesToBase64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(s) {
  if (typeof s !== 'string' || !s || !BASE64URL.test(s)) throw new Error('Not a base64url string');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function generateEncKey() {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export function composeLinkCode(authToken, encKey) {
  const tokenBytes = base64urlToBytes(authToken);
  if (tokenBytes.length !== TOKEN_BYTES) throw new Error('Token must be 32 bytes');
  if (!(encKey instanceof Uint8Array) || encKey.length !== KEY_BYTES) throw new Error('Key must be 32 bytes');
  const joined = new Uint8Array(LINK_CODE_BYTES);
  joined.set(tokenBytes, 0);
  joined.set(encKey, TOKEN_BYTES);
  return bytesToBase64url(joined);
}

export function parseLinkCode(code) {
  const bytes = base64urlToBytes((code || '').trim());
  if (bytes.length !== LINK_CODE_BYTES) throw new Error('A link code is 86 characters');
  return { authToken: bytesToBase64url(bytes.slice(0, TOKEN_BYTES)), encKey: bytes.slice(TOKEN_BYTES) };
}

// Composing a code for a SECOND device. It must carry this device's existing
// key: generating a fresh one here would produce a device that can never
// decrypt the account, with no diagnostic beyond a permanent "undecryptable".
export function composeForNewDevice(newToken, link) {
  if (!link || !(link.encKey instanceof Uint8Array)) throw new Error('This device is not linked');
  return composeLinkCode((newToken || '').trim(), link.encKey);
}

async function importKey(encKey) {
  return crypto.subtle.importKey('raw', encKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBlob(encKey, obj) {
  // A fresh random IV per encryption, from the CSPRNG. NOT a counter: two
  // devices share one encKey, so both would start at zero and collide across
  // devices, which for AES-GCM leaks the XOR of the plaintexts and voids the
  // auth tag. This is not a tunable choice.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importKey(encKey);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  let bin = ''; for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function decryptBlob(encKey, blob) {
  let bytes;
  try {
    const bin = atob(blob);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new Error('Blob is not valid base64');
  }
  if (bytes.length <= IV_BYTES) throw new Error('Blob is too short to contain an IV');
  const key = await importKey(encKey);
  // Wrong key, tampering, truncation — all surface as a rejection. The caller
  // must NOT fall back to applying partial state.
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES));
  return JSON.parse(new TextDecoder().decode(plain));
}
