import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { envWith, invite } from '../worker/tests/account-helpers.js';
import {
  AccountError, signUp, logIn, recover, changePassword, newRecoveryLink, upgrade, getAccount,
  listDevices, signOutOthers, confirmRecovery, logOut, recoveryLink, mailtoHref,
} from '../js/account.js';
import { parseLinkCode, generateEncKey, encryptBlob } from '../js/crypto.js';
import { APP_URL } from '../js/config.js';

const FAST = {}; // the Worker enforces kdfIters >= 600000, so tests use the production iteration count
const LOW = {};

// A fake server built from the real Worker. `calls` records every request path;
// `stub(path, fn)` lets a test rewrite one response.
function server(env) {
  const calls = [];
  const stubs = {};
  const fetchImpl = async (url, opts) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const res = await worker.fetch(new Request(url, opts), env);
    if (stubs[path]) return stubs[path](res);
    return res;
  };
  const stub = (path, fn) => { stubs[path] = async (res) => new Response(JSON.stringify(fn(await res.json())), { status: res.status, headers: { 'content-type': 'application/json' } }); };
  return { fetchImpl, calls, stub, apiBase: 'https://w' };
}
const EMAIL = 'tester@example.com';
const PW = 'correct-horse-1!';

async function setup() {
  const env = envWith();
  const s = server(env);
  await invite(env);
  const su = await signUp({ invite: 'INVITE-1', email: EMAIL, password: PW, deviceName: 'iPhone', ...FAST, ...s });
  return { env, s, su };
}
const linkOf = (code) => ({ ...parseLinkCode(code), code });

test('signUp then logIn yield the same DEK and different tokens', async () => {
  const { s, su } = await setup();
  assert.equal(su.code.length, 86);
  assert.equal(su.recoveryCode.length, 22);
  const li = await logIn({ email: EMAIL, password: PW, deviceName: 'Mac', ...LOW, ...s });
  assert.deepEqual(parseLinkCode(li.code).encKey, parseLinkCode(su.code).encKey);
  assert.notEqual(parseLinkCode(li.code).authToken, parseLinkCode(su.code).authToken);
  assert.equal(li.accountId, su.accountId);
  assert.equal(li.recoveryConfirmed, false);
});

test('signUp sends kdfIters 600000 by default', async () => {
  const env = envWith();
  await invite(env);
  let sent;
  const fetchImpl = async (url, opts) => { sent = JSON.parse(opts.body); return worker.fetch(new Request(url, opts), env); };
  await signUp({ invite: 'INVITE-1', email: EMAIL, password: PW, deviceName: 'iPhone', fetchImpl, apiBase: 'https://w' });
  assert.equal(sent.kdfIters, 600000);
});

test('wrong password gives bad_credentials', async () => {
  const { s } = await setup();
  await assert.rejects(logIn({ email: EMAIL, password: 'nope-nope-1!', deviceName: 'Mac', ...LOW, ...s }),
    (e) => e instanceof AccountError && e.code === 'bad_credentials');
});

test('unknown email gives no_account', async () => {
  const { s } = await setup();
  await assert.rejects(logIn({ email: 'x@example.com', password: PW, deviceName: 'Mac', ...LOW, ...s }),
    (e) => e.code === 'no_account');
});

test('recover resets the password, rotates the recovery code, hook runs before finish', async () => {
  const { s, su } = await setup();
  const known = [];
  const rec = await recover({ email: EMAIL, recoveryCode: su.recoveryCode, newPassword: 'brand-new-pw-2#', deviceName: 'Mac',
    onAccountKnown: async (id) => { known.push([id, s.calls.includes('/auth/recover/finish')]); }, ...FAST, ...s });
  assert.deepEqual(known, [[su.accountId, false]]);
  assert.deepEqual(parseLinkCode(rec.code).encKey, parseLinkCode(su.code).encKey);
  await assert.rejects(logIn({ email: EMAIL, password: PW, deviceName: 'x', ...LOW, ...s }), (e) => e.code === 'bad_credentials');
  await logIn({ email: EMAIL, password: 'brand-new-pw-2#', deviceName: 'x', ...LOW, ...s });
  const rec2 = await recover({ email: EMAIL, recoveryCode: rec.recoveryCode, newPassword: 'third-pw-3$', deviceName: 'Mac', ...FAST, ...s });
  assert.equal(rec2.recoveryCode.length, 22);
  await assert.rejects(recover({ email: EMAIL, recoveryCode: su.recoveryCode, newPassword: 'fourth-pw-4%', deviceName: 'Mac', ...FAST, ...s }),
    (e) => e.code === 'bad_recovery');
});

test('recover: a throwing onAccountKnown aborts before finish and propagates', async () => {
  const { s, su } = await setup();
  const boom = new Error('hook');
  await assert.rejects(recover({ email: EMAIL, recoveryCode: su.recoveryCode, newPassword: 'brand-new-pw-2#', deviceName: 'Mac',
    onAccountKnown: () => { throw boom; }, ...FAST, ...s }), (e) => e === boom);
  assert.ok(!s.calls.includes('/auth/recover/finish'));
});

test('a server-sent kdfIters below the floor gives kdf_iters_too_low and sends no login', async () => {
  const { s } = await setup();
  s.stub('/auth/prelogin', (b) => ({ ...b, kdfIters: 1000 }));
  s.calls.length = 0;
  await assert.rejects(logIn({ email: EMAIL, password: PW, deviceName: 'Mac', ...s }),
    (e) => e instanceof AccountError && e.code === 'kdf_iters_too_low');
  assert.ok(!s.calls.includes('/auth/login'));
});

test('tampered dekCheck on login gives dek_check_failed', async () => {
  const { s } = await setup();
  s.stub('/auth/login', (b) => ({ ...b, dekCheck: 'b'.repeat(64) }));
  await assert.rejects(logIn({ email: EMAIL, password: PW, deviceName: 'Mac', ...LOW, ...s }), (e) => e.code === 'dek_check_failed');
});

test('tampered dekCheck on recover/start gives dek_check_failed and sends no finish', async () => {
  const { s, su } = await setup();
  s.stub('/auth/recover/start', (b) => ({ ...b, dekCheck: 'b'.repeat(64) }));
  await assert.rejects(recover({ email: EMAIL, recoveryCode: su.recoveryCode, newPassword: 'brand-new-pw-2#', deviceName: 'Mac', ...FAST, ...s }),
    (e) => e.code === 'dek_check_failed');
  assert.ok(!s.calls.includes('/auth/recover/finish'));
});

test('upgrade with a key that cannot decrypt the blob gives wrong_key_on_device, no upgrade request', async () => {
  const { env, s, su } = await setup();
  const keyA = generateEncKey();
  await env.DB.prepare('UPDATE data SET blob = ? WHERE id = ?').bind(await encryptBlob(keyA, { items: [] }), su.accountId).run();
  const link = { authToken: parseLinkCode(su.code).authToken, encKey: generateEncKey() };
  s.calls.length = 0;
  await assert.rejects(upgrade({ link, email: 'new@example.com', password: PW, ...FAST, ...s }),
    (e) => e.code === 'wrong_key_on_device');
  assert.ok(!s.calls.includes('/account/upgrade'));
});

test('changePassword: D18 check blocks a wrong-key device, then works with the right key', async () => {
  const { env, s, su } = await setup();
  const real = linkOf(su.code);
  await env.DB.prepare('UPDATE data SET blob = ? WHERE id = ?').bind(await encryptBlob(real.encKey, { items: [] }), su.accountId).run();
  const bad = { authToken: real.authToken, encKey: generateEncKey() };
  s.calls.length = 0;
  await assert.rejects(changePassword({ link: bad, email: EMAIL, currentPassword: PW, newPassword: 'changed-pw-5^', signOutOthers: false, ...FAST, ...s }),
    (e) => e.code === 'wrong_key_on_device');
  assert.ok(!s.calls.includes('/account/password'));
  await changePassword({ link: real, email: EMAIL, currentPassword: PW, newPassword: 'changed-pw-5^', signOutOthers: false, ...FAST, ...s });
  const li = await logIn({ email: EMAIL, password: 'changed-pw-5^', deviceName: 'x', ...LOW, ...s });
  assert.deepEqual(parseLinkCode(li.code).encKey, real.encKey);
  await assert.rejects(changePassword({ link: real, email: EMAIL, currentPassword: 'wrong-wrong-1!', newPassword: 'zzzzzzzz-1!', signOutOthers: false, ...FAST, ...s }),
    (e) => e.code === 'bad_credentials');
});

test('newRecoveryLink issues a code that recovers, and getAccount/listDevices/confirmRecovery/signOutOthers work', async () => {
  const { s, su } = await setup();
  const link = linkOf(su.code);
  const { recoveryCode } = await newRecoveryLink({ link, email: EMAIL, currentPassword: PW, ...LOW, ...s });
  assert.equal(recoveryCode.length, 22);
  await recover({ email: EMAIL, recoveryCode, newPassword: 'brand-new-pw-2#', deviceName: 'Mac', ...FAST, ...s });
  // recovery signed every device out; log in again for a fresh link
  const li = await logIn({ email: EMAIL, password: 'brand-new-pw-2#', deviceName: 'B', ...LOW, ...s });
  const l2 = linkOf(li.code);
  const acct = await getAccount({ link: l2, ...s });
  assert.equal(acct.email, EMAIL);
  assert.equal(acct.recoveryConfirmed, false);
  await confirmRecovery({ link: l2, ...s });
  assert.equal((await getAccount({ link: l2, ...s })).recoveryConfirmed, true);
  const devs = await listDevices({ link: l2, ...s });
  assert.ok(devs.devices.some((d) => d.current));
  await signOutOthers({ link: l2, ...s });
});

test('logOut offline returns revoked:false without throwing', async () => {
  const link = { authToken: 'a'.repeat(43), encKey: generateEncKey() };
  const r = await logOut({ link, fetchImpl: async () => { throw new TypeError('offline'); }, apiBase: 'https://w' });
  assert.deepEqual(r, { revoked: false });
});

test('logOut on 401 returns revoked:true; on success revoked:true', async () => {
  const { s, su } = await setup();
  const link = linkOf(su.code);
  assert.deepEqual(await logOut({ link, ...s }), { revoked: true });
  assert.deepEqual(await logOut({ link, ...s }), { revoked: true }); // now 401
});

test('error mapping: unreachable, server, retryAt', async () => {
  await assert.rejects(logIn({ email: EMAIL, password: PW, deviceName: 'x', fetchImpl: async () => { throw new Error('x'); }, apiBase: 'https://w' }),
    (e) => e.code === 'unreachable');
  await assert.rejects(logIn({ email: EMAIL, password: PW, deviceName: 'x', fetchImpl: async () => new Response('<html>', { status: 502 }), apiBase: 'https://w' }),
    (e) => e.code === 'server');
  await assert.rejects(logIn({ email: EMAIL, password: PW, deviceName: 'x', fetchImpl: async () => new Response(JSON.stringify({ error: 'locked', retryAt: 'T' }), { status: 429 }), apiBase: 'https://w' }),
    (e) => e.code === 'locked' && e.extra.retryAt === 'T');
});

test('mailtoHref round-trips and recoveryLink uses APP_URL', () => {
  const code = 'AbCdEfGhIjKlMnOpQrStUv';
  assert.equal(recoveryLink(code), `${APP_URL}#recover=${code}`);
  const u = new URL(mailtoHref('a+b@example.com', code));
  assert.equal(u.protocol, 'mailto:');
  assert.equal(decodeURIComponent(u.pathname), 'a+b@example.com');
  assert.equal(u.searchParams.get('subject'), 'Your plaenicke recovery link');
  const body = u.searchParams.get('body');
  assert.ok(body.includes(`#recover=${code}`));
  assert.ok(body.includes('Keep this email. If you forget your password, open this link to reset it. Anyone with access to this email can reset your password.'));
});
