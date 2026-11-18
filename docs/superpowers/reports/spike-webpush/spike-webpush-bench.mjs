// SPIKE (2026-11-09, throwaway): CPU cost of Web Push crypto in NODE's WebCrypto.
// A proxy only — Node's WebCrypto runs on OpenSSL and (unlike workerd) dispatches some work
// to its thread pool, so process.cpuUsage() (all threads) is used, not wall time.
// The authoritative numbers come from the workerd harness (see the report).
// Run: node scripts/spike-webpush-bench.mjs [iterations]   (no network calls)
import nodeCrypto from 'node:crypto';
import { encryptPayload, importVapidPrivate, vapidJwt, declarativePayload } from './spike-webpush-lib.mjs';

const N = Number(process.argv[2] ?? 2000);
const te = new TextEncoder();

const vk = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const vPub = new Uint8Array([4, ...Buffer.from(vk.x, 'base64url'), ...Buffer.from(vk.y, 'base64url')]);
const vPriv = new Uint8Array(Buffer.from(vk.d, 'base64url'));
const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const uaPub = new Uint8Array(ua.getPublicKey());
const auth = new Uint8Array(nodeCrypto.randomBytes(16));
const payload = te.encode(JSON.stringify(declarativePayload('Dentist in 30 min', '14:30 · Main St', 'https://example.github.io/plaenicke/')));

async function measure(label, fn) {
  // first call (includes any lazy init) measured separately
  let c0 = process.cpuUsage(); await fn(); let c1 = process.cpuUsage(c0);
  const first = (c1.user + c1.system) / 1000;
  c0 = process.cpuUsage();
  for (let i = 0; i < N; i++) await fn();
  c1 = process.cpuUsage(c0);
  const per = (c1.user + c1.system) / 1000 / N;
  console.log(`${label.padEnd(44)} first ${first.toFixed(3)} ms   mean ${per.toFixed(4)} ms CPU over ${N}`);
}

const key = await importVapidPrivate(vPub, vPriv);
await measure('importKey VAPID private (jwk, ECDSA)', () => importVapidPrivate(vPub, vPriv));
await measure('VAPID JWT sign (ES256)', () => vapidJwt(key, 'https://web.push.apple.com', 'mailto:x@example.invalid', 2e9));
await measure('RFC 8291 encrypt (179 B declarative payload)', () => encryptPayload(payload, uaPub, auth));
await measure('full send crypto: import + sign + encrypt', async () => {
  const k = await importVapidPrivate(vPub, vPriv);
  await vapidJwt(k, 'https://web.push.apple.com', 'mailto:x@example.invalid', 2e9);
  await encryptPayload(payload, uaPub, auth);
});
console.log(`node ${process.version}, ${process.arch}, ${nodeCrypto.getCiphers().length} ciphers; OpenSSL ${process.versions.openssl}`);
