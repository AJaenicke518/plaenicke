// SPIKE (2026-11-09, throwaway): Web Push sender primitives using ONLY WebCrypto,
// so the same file runs in Node 22 and in workerd (wrangler dev).
//   - vapidJwt():     RFC 8292 VAPID JWT, ES256 (ECDSA P-256 / SHA-256)
//   - encryptPayload: RFC 8291 aes128gcm (ECDH P-256 + HKDF-SHA-256 + AES-128-GCM)
// Not production code. Not a test file (name must never match node --test patterns).

const te = new TextEncoder();

export function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const s = str.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Build a P-256 JWK from raw 65-byte public point and optional 32-byte private scalar.
export function p256Jwk(pubRaw, privRaw) {
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pubRaw.slice(1, 33)), y: b64u(pubRaw.slice(33, 65)), ext: true };
  if (privRaw) jwk.d = b64u(privRaw);
  return jwk;
}

export async function importVapidPrivate(pubRaw, privRaw) {
  return crypto.subtle.importKey('jwk', p256Jwk(pubRaw, privRaw), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// RFC 8292 section 2: JWT signed with ES256; aud = origin of push resource.
export async function vapidJwt(signingKey, aud, sub, expSeconds) {
  const header = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(te.encode(JSON.stringify({ aud, exp: expSeconds, sub })));
  const input = te.encode(`${header}.${claims}`);
  // WebCrypto ECDSA returns IEEE P1363 r||s (64 bytes), which is exactly JWS ES256 format.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, input);
  return `${header}.${claims}.${b64u(sig)}`;
}

async function hkdf(salt, ikm, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBytes * 8);
  return new Uint8Array(bits);
}

// RFC 8291 section 3/4. uaPublicRaw = subscription p256dh (65 bytes), authSecret = 16 bytes.
// opts.asKeyPair / opts.salt let the RFC Appendix A vector be reproduced; normally random.
export async function encryptPayload(plaintext, uaPublicRaw, authSecret, opts = {}) {
  const asKeyPair = opts.asKeyPair ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(opts.asPublicRaw ?? await crypto.subtle.exportKey('raw', asKeyPair.publicKey));
  const uaPublic = await crypto.subtle.importKey('raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublic }, asKeyPair.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const padded = concat(plaintext, new Uint8Array([2])); // single record => delimiter 0x02, no padding
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // Header: salt(16) || rs(4, BE, 4096) || idlen(1)=65 || keyid(65 = as_public)
  const rs = new Uint8Array([0, 0, 0x10, 0]);
  const header = concat(salt, rs, new Uint8Array([65]), asPublicRaw);
  return { body: concat(header, ct), intermediates: { ecdhSecret, ikm, cek, nonce } };
}

// One full send's crypto, as a cron handler would do it. jwt may be passed in (cached).
export async function buildPushRequest({ endpoint, p256dh, auth, payloadObj, vapid, jwt }) {
  const aud = new URL(endpoint).origin;
  const token = jwt ?? await vapidJwt(vapid.signingKey, aud, vapid.sub, Math.floor(Date.now() / 1000) + 12 * 3600);
  const { body } = await encryptPayload(te.encode(JSON.stringify(payloadObj)), p256dh, auth);
  return {
    url: endpoint,
    init: {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${token}, k=${vapid.publicB64u}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '1800',
        Urgency: 'high',
      },
      body,
    },
  };
}

// The Declarative Web Push shape (WebKit blog 16535 / W3C Push API "declarative push message").
export function declarativePayload(title, body, navigate) {
  return { web_push: 8030, notification: { title, body, navigate, lang: 'en-US', dir: 'ltr', silent: false } };
}
