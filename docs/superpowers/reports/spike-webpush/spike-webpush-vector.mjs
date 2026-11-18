// SPIKE (2026-11-09, throwaway): correctness checks for spike-webpush-lib.mjs, in Node.
// 1. Reproduces RFC 8291 Section 5 / Appendix A byte-for-byte with the RFC's fixed keys + salt.
// 2. Decrypts a random-key message with node:crypto (an independent implementation).
// 3. Verifies a VAPID JWT signature with node:crypto.
// Run: node scripts/spike-webpush-vector.mjs   (makes no network calls)
import nodeCrypto from 'node:crypto';
import { b64u, unb64u, p256Jwk, encryptPayload, importVapidPrivate, vapidJwt, declarativePayload } from './spike-webpush-lib.mjs';

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; };

// --- 1. RFC 8291 vector ---
const V = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPub: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPriv: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPub: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdh: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const asPubRaw = unb64u(V.asPub);
const asPriv = await crypto.subtle.importKey('jwk', p256Jwk(asPubRaw, unb64u(V.asPriv)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
const r = await encryptPayload(unb64u(V.plaintext), unb64u(V.uaPub), unb64u(V.auth), {
  asKeyPair: { privateKey: asPriv }, asPublicRaw: asPubRaw, salt: unb64u(V.salt),
});
check('RFC8291 ecdh_secret', b64u(r.intermediates.ecdhSecret) === V.ecdh);
check('RFC8291 IKM', b64u(r.intermediates.ikm) === V.ikm);
check('RFC8291 CEK', b64u(r.intermediates.cek) === V.cek);
check('RFC8291 NONCE', b64u(r.intermediates.nonce) === V.nonce);
// The RFC's example says Content-Length: 145, but the body it prints decodes to 144 octets
// (86-octet header + the 58-octet ciphertext in Appendix A). We match the printed bytes.
check('RFC8291 full body (144 octets as printed)', b64u(r.body) === V.body && r.body.length === 144);

// --- 2. Random keys, independent decrypt with node:crypto (receiver side of RFC 8291) ---
const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const uaPubRaw = new Uint8Array(ua.getPublicKey());
const auth = nodeCrypto.randomBytes(16);
const msg = JSON.stringify(declarativePayload('Dentist in 30 min', '14:30 · Main St', 'https://example.github.io/plaenicke/'));
const { body } = await encryptPayload(new TextEncoder().encode(msg), uaPubRaw, new Uint8Array(auth));
const buf = Buffer.from(body);
const salt = buf.subarray(0, 16), rs = buf.readUInt32BE(16), idlen = buf[20], keyid = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
const ecdh = ua.computeSecret(keyid);
const hk = (s, k, info, n) => Buffer.from(nodeCrypto.hkdfSync('sha256', k, s, info, n));
const ikm = hk(auth, ecdh, Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPubRaw), keyid]), 32);
const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
const nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
d.setAuthTag(ct.subarray(ct.length - 16));
const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
check('node:crypto decrypt round trip', rs === 4096 && idlen === 65 && pt.at(-1) === 2 && pt.subarray(0, -1).toString() === msg);
console.log(`  declarative payload ${msg.length} B plaintext -> ${body.length} B body (RFC 8291 cap: 3993 B plaintext / 4096 B body)`);

// --- 3. VAPID JWT verifies with node:crypto ---
const vk = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = vk.privateKey.export({ format: 'jwk' });
const pubRaw = new Uint8Array([4, ...Buffer.from(jwk.x, 'base64url'), ...Buffer.from(jwk.y, 'base64url')]);
const signingKey = await importVapidPrivate(pubRaw, Buffer.from(jwk.d, 'base64url'));
const jwt = await vapidJwt(signingKey, 'https://web.push.apple.com', 'mailto:spike@example.invalid', Math.floor(Date.now() / 1000) + 3600);
const [h, c, s] = jwt.split('.');
const ok = nodeCrypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: vk.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
check('VAPID ES256 JWT verifies (node:crypto, ieee-p1363)', ok);

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
