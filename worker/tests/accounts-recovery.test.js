import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64u, b64, post, get, one, count, login, signedUp, envWith,
} from './account-helpers.js';
import { mintDevice } from '../src/auth.js';

const rec = (over = {}) => ({ email: 'tester@example.com', recAuthKey: b64u(32, 3), ...over });
const fin = (over = {}) => ({
  email: 'tester@example.com', recAuthKey: b64u(32, 3), kdfSalt: b64u(16, 11), kdfIters: 600000,
  authKey: b64u(32, 12), recAuthKey2: b64u(32, 13), wrappedDekPw: b64(60, 14), wrappedDekRec2: b64(60, 15),
  deviceName: 'Recovered', ...over,
});
const pw = (over = {}) => ({
  currentAuthKey: b64u(32, 2), kdfSalt: b64u(16, 21), kdfIters: 600000, authKey: b64u(32, 22),
  wrappedDekPw: b64(60, 24), signOutOthers: false, ...over,
});
const acct = (env) => one(env, 'SELECT * FROM accounts WHERE email IS NOT NULL');
const devices = (env, id) => one(env, 'SELECT COUNT(*) AS n FROM devices WHERE account_id = ?', id).then((r) => r.n);
const lockNow = (env) => env.DB.prepare(
  "UPDATE accounts SET failed_logins = 50, locked_until = '2999-01-01T00:00:00.000Z' WHERE email IS NOT NULL").run();

test('1. recover/start returns the unsealed rec wrap; a wrong key is 401 and not counted', async () => {
  const { env, accountId } = await signedUp();
  const res = await post(env, '/auth/recover/start', rec());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accountId, wrappedDekRec: b64(60, 5), dekCheck: 'a'.repeat(64) });
  const bad = await post(env, '/auth/recover/start', rec({ recAuthKey: b64u(32, 9) }));
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'bad_recovery');
  assert.equal((await acct(env)).failed_logins, 0);
});

test('2. recover/finish replaces all credentials, signs out every device, adds exactly one', async () => {
  const { env, token, accountId } = await signedUp();
  const second = (await (await login(env)).json()).token;
  await post(env, '/account/recovery/confirm', undefined, token);
  const res = await post(env, '/auth/recover/finish', fin());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.accountId, accountId);
  assert.equal((await login(env)).status, 401); // old authKey
  assert.equal((await login(env, { authKey: b64u(32, 12) })).status, 200);
  assert.equal((await post(env, '/auth/recover/start', rec())).status, 401); // old rec key
  const start = await (await post(env, '/auth/recover/start', rec({ recAuthKey: b64u(32, 13) }))).json();
  assert.equal(start.wrappedDekRec, b64(60, 15));
  assert.equal((await acct(env)).recovery_confirmed_at, null);
  for (const t of [token, second]) assert.equal((await get(env, '/data', t)).status, 401);
  assert.equal((await get(env, '/data', j.token)).status, 200);
});

test('2b. exactly one new device after finish', async () => {
  const { env, accountId } = await signedUp();
  await login(env);
  const j = await (await post(env, '/auth/recover/finish', fin())).json();
  assert.equal(await devices(env, accountId), 1);
  assert.equal((await one(env, 'SELECT name FROM devices WHERE account_id = ?', accountId)).name, 'Recovered');
  assert.ok(j.token);
});

test('3. concurrent finish: one 200, one 409 recovery_changed, one device', async () => {
  const { env, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  await login(env); await login(env);
  const rs = await Promise.all([
    post(env, '/auth/recover/finish', fin({ authKey: b64u(32, 31), recAuthKey2: b64u(32, 32), deviceName: 'A' })),
    post(env, '/auth/recover/finish', fin({ authKey: b64u(32, 41), recAuthKey2: b64u(32, 42), deviceName: 'B' })),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const loser = rs.find((r) => r.status === 409);
  assert.equal((await loser.json()).error, 'recovery_changed');
  assert.equal(await devices(env, accountId), 1);
  const winner = (await one(env, 'SELECT name FROM devices WHERE account_id = ?', accountId)).name;
  assert.equal(winner, rs[0].status === 200 ? 'A' : 'B');
});

test('4. recover/finish works while locked and clears the lock', async () => {
  const { env } = await signedUp();
  await lockNow(env);
  assert.equal((await login(env)).status, 429);
  assert.equal((await post(env, '/auth/recover/finish', fin())).status, 200);
  const a = await acct(env);
  assert.equal(a.failed_logins, 0); assert.equal(a.locked_until, null);
  assert.equal((await login(env, { authKey: b64u(32, 12) })).status, 200);
});

test('5. password change: new key logs in; others stay unless signOutOthers', async () => {
  const { env, token, accountId } = await signedUp();
  const second = (await (await login(env)).json()).token;
  const res = await post(env, '/account/password', pw(), token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await login(env)).status, 401);
  const nl = await login(env, { authKey: b64u(32, 22) });
  assert.equal(nl.status, 200);
  assert.equal((await nl.json()).wrappedDekPw, b64(60, 24));
  assert.equal((await get(env, '/data', second)).status, 200);
  const res2 = await post(env, '/account/password', pw({ currentAuthKey: b64u(32, 22), authKey: b64u(32, 52), signOutOthers: true }), token);
  assert.equal(res2.status, 200);
  assert.equal(await devices(env, accountId), 1);
  assert.equal((await get(env, '/data', token)).status, 200);
  assert.equal((await get(env, '/data', second)).status, 401);
});

test('6. wrong current key: 401 counted; 50th sets lock; 51st is 429; /data unaffected; success resets', async () => {
  const { env, token } = await signedUp();
  const bad = pw({ currentAuthKey: b64u(32, 9) });
  for (let i = 1; i <= 49; i += 1) assert.equal((await post(env, '/account/password', bad, token)).status, 401, `attempt ${i}`);
  assert.equal((await acct(env)).locked_until, null);
  const r50 = await post(env, '/account/password', bad, token);
  assert.equal(r50.status, 401);
  assert.equal((await r50.json()).error, 'bad_credentials');
  assert.notEqual((await acct(env)).locked_until, null);
  const r51 = await post(env, '/account/password', bad, token);
  assert.equal(r51.status, 429);
  const j = await r51.json();
  assert.equal(j.error, 'locked'); assert.ok(j.retryAt);
  assert.equal((await get(env, '/data', token)).status, 200);

  const s2 = await signedUp();
  await post(s2.env, '/account/password', pw({ currentAuthKey: b64u(32, 9) }), s2.token);
  await post(s2.env, '/account/password', pw({ currentAuthKey: b64u(32, 9) }), s2.token);
  assert.equal((await acct(s2.env)).failed_logins, 2);
  assert.equal((await post(s2.env, '/account/password', pw(), s2.token)).status, 200);
  assert.equal((await acct(s2.env)).failed_logins, 0);
});

test('6b. password change and new recovery link require a bearer token', async () => {
  const { env } = await signedUp();
  assert.equal((await post(env, '/account/password', pw())).status, 401);
  assert.equal((await post(env, '/account/recovery', {})).status, 401);
});

test('10. unknown email is 401 bad_recovery; disabled is 403 and nothing changes', async () => {
  const { env } = await signedUp();
  for (const [p, b] of [['/auth/recover/start', rec({ email: 'nobody@example.com' })],
    ['/auth/recover/finish', fin({ email: 'nobody@example.com' })]]) {
    const res = await post(env, p, b);
    assert.equal(res.status, 401, p);
    assert.equal((await res.json()).error, 'bad_recovery');
  }
  await env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE email IS NOT NULL').bind('t').run();
  const before = await acct(env);
  for (const [p, b] of [['/auth/recover/start', rec()], ['/auth/recover/finish', fin()]]) {
    const res = await post(env, p, b);
    assert.equal(res.status, 403, p);
    assert.equal((await res.json()).error, 'disabled');
  }
  assert.deepEqual(await acct(env), before);
});

test('10b. recover/finish with a wrong rec key is 401 and changes nothing', async () => {
  const { env, accountId } = await signedUp();
  const before = await acct(env);
  const res = await post(env, '/auth/recover/finish', fin({ recAuthKey: b64u(32, 9) }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'bad_recovery');
  assert.deepEqual(await acct(env), before);
  assert.equal(await devices(env, accountId), 1);
});

test('10c. recover validation failures are 400 before any write', async () => {
  const { env } = await signedUp();
  const before = await acct(env);
  for (const over of [{ kdfIters: 599999 }, { email: 'nope' }, { authKey: b64u(31, 1) }, { recAuthKey2: 'bad!' },
    { wrappedDekPw: b64(59, 1) }, { wrappedDekRec2: b64(61, 1) }, { kdfSalt: b64u(15, 1) }, { deviceName: '' }]) {
    const res = await post(env, '/auth/recover/finish', fin(over));
    assert.equal(res.status, 400, JSON.stringify(Object.keys(over)));
    assert.equal((await res.json()).error, 'bad_request');
  }
  assert.equal((await post(env, '/auth/recover/start', { email: 'tester@example.com' })).status, 400);
  assert.deepEqual(await acct(env), before);
});

test('11. password change and new recovery link on legacy account 1 are 409 no_password', async () => {
  const env = envWith();
  const token = await mintDevice(env, 1, 'old', 't');
  for (const [p, b] of [['/account/password', pw()],
    ['/account/recovery', { currentAuthKey: b64u(32, 2), recAuthKey: b64u(32, 5), wrappedDekRec: b64(60, 6) }]]) {
    const res = await post(env, p, b, token);
    assert.equal(res.status, 409, p);
    assert.equal((await res.json()).error, 'no_password');
  }
});

test('7. new recovery link replaces rec mac and wrap and clears confirmation', async () => {
  const { env, token } = await signedUp();
  await post(env, '/account/recovery/confirm', undefined, token);
  const b = { currentAuthKey: b64u(32, 2), recAuthKey: b64u(32, 7), wrappedDekRec: b64(60, 8) };
  const res = await post(env, '/account/recovery', b, token);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await acct(env)).recovery_confirmed_at, null);
  assert.equal((await post(env, '/auth/recover/start', rec())).status, 401);
  const s = await (await post(env, '/auth/recover/start', rec({ recAuthKey: b64u(32, 7) }))).json();
  assert.equal(s.wrappedDekRec, b64(60, 8));
  const bad = await post(env, '/account/recovery', { ...b, currentAuthKey: b64u(32, 9) }, token);
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'bad_credentials');
  assert.equal((await acct(env)).failed_logins, 1);
  assert.equal((await post(env, '/account/recovery', { ...b, recAuthKey: 'x' }, token)).status, 400);
});

const up = (over = {}) => ({
  email: 'Alex@Example.com', kdfSalt: b64u(16, 1), kdfIters: 600000, authKey: b64u(32, 2), recAuthKey: b64u(32, 3),
  wrappedDekPw: b64(60, 4), wrappedDekRec: b64(60, 5), dekCheck: 'b'.repeat(64), ...over });
const mintUpgradeCode = async (env, accountId = 1) => {
  const res = await post(env, '/admin/upgrade-code', { accountId }, 'adm');
  assert.equal(res.status, 200);
  return (await res.json()).upgradeCode;
};

test('8. upgrade of legacy account 1; a second upgrade is already_upgraded', async () => {
  const env = envWith();
  const t1 = await mintDevice(env, 1, 'old', 't');
  const code = await mintUpgradeCode(env);
  const res = await post(env, '/account/upgrade', up({ upgradeCode: code }), t1);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, accountId: 1 });
  const a = await one(env, 'SELECT * FROM accounts WHERE id = 1');
  assert.equal(a.email, 'alex@example.com'); assert.equal(a.dek_check, 'b'.repeat(64));
  assert.notEqual(a.auth_mac, null); assert.notEqual(a.rec_auth_mac, null);
  assert.ok(a.wrapped_dek_pw_sealed.startsWith('k1:'));
  assert.notEqual((await one(env, 'SELECT used_at FROM upgrade_codes')).used_at, null);
  const again = await post(env, '/account/upgrade', up({ email: 'z@example.com', upgradeCode: code }), t1);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, 'already_upgraded');
  assert.equal((await one(env, 'SELECT email FROM accounts WHERE id = 1')).email, 'alex@example.com');
});

test('8b. non-legacy token is already_upgraded; taken email is email_taken (code not consumed); bad input is 400', async () => {
  const { env, token } = await signedUp();
  const t1 = await mintDevice(env, 1, 'old', 't');
  const code = await mintUpgradeCode(env);
  const r = await post(env, '/account/upgrade', up({ email: 'new@example.com', upgradeCode: code }), token);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'already_upgraded');
  assert.equal((await one(env, 'SELECT email FROM accounts WHERE id = 1')).email, null);
  const taken = await post(env, '/account/upgrade', up({ email: 'TESTER@example.com', upgradeCode: code }), t1);
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).error, 'email_taken');
  assert.equal((await one(env, 'SELECT email FROM accounts WHERE id = 1')).email, null);
  assert.equal((await one(env, 'SELECT used_at FROM upgrade_codes')).used_at, null);
  assert.equal((await post(env, '/account/upgrade', up({ dekCheck: 'a'.repeat(63), upgradeCode: code }), t1)).status, 400);
  assert.equal((await post(env, '/account/upgrade', up({ upgradeCode: code }), undefined)).status, 401);
  // the code survived all of that and still works
  assert.equal((await post(env, '/account/upgrade', up({ upgradeCode: code }), t1)).status, 200);
});

test('9. after upgrade, the data row is byte-identical and both account-1 tokens work', async () => {
  const env = envWith();
  await env.DB.prepare('UPDATE data SET blob = ?, version = 5 WHERE id = 1').bind('opaque-blob-é').run();
  const before = await one(env, 'SELECT * FROM data WHERE id = 1');
  const t1 = await mintDevice(env, 1, 'a', 't');
  const t2 = await mintDevice(env, 1, 'b', 't');
  assert.equal((await post(env, '/account/upgrade', up({ upgradeCode: await mintUpgradeCode(env) }), t1)).status, 200);
  assert.deepEqual(await one(env, 'SELECT * FROM data WHERE id = 1'), before);
  for (const t of [t1, t2]) assert.equal((await get(env, '/data', t)).status, 200);
  assert.equal(await count(env, 'devices'), 2);
});

// --- sweep W1-C1: an account-1 bearer alone cannot upgrade ------------------

test('C1a. upgrade without upgradeCode is 400 bad_request and changes nothing', async () => {
  const env = envWith();
  const t1 = await mintDevice(env, 1, 'smoke', 't');
  for (const over of [{}, { upgradeCode: 5 }, { upgradeCode: '' }, { upgradeCode: 'x'.repeat(201) }]) {
    const res = await post(env, '/account/upgrade', up(over), t1);
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal((await res.json()).error, 'bad_request');
  }
  assert.equal((await one(env, 'SELECT email, auth_mac FROM accounts WHERE id = 1')).auth_mac, null);
});

test('C1b. a wrong, used, expired or other-account code is 403 invalid_upgrade_code and changes nothing', async () => {
  let now = '2026-11-11T12:00:00.000Z';
  const env = { ...envWith(), NOW: () => now };
  const t1 = await mintDevice(env, 1, 'smoke', 't');
  const before = await one(env, 'SELECT * FROM accounts WHERE id = 1');
  const expect403 = async (code, label) => {
    const res = await post(env, '/account/upgrade', up({ upgradeCode: code }), t1);
    assert.equal(res.status, 403, label);
    assert.equal((await res.json()).error, 'invalid_upgrade_code', label);
    assert.deepEqual(await one(env, 'SELECT * FROM accounts WHERE id = 1'), before, label);
  };
  await expect403(b64u(16, 7), 'wrong');
  // expired: valid for 24 h, refused at exactly expires_at
  const code = await mintUpgradeCode(env);
  now = '2026-11-12T12:00:00.000Z';
  await expect403(code, 'expired');
  assert.equal((await one(env, 'SELECT used_at FROM upgrade_codes')).used_at, null);
  // used: mark it used directly
  now = '2026-11-11T13:00:00.000Z';
  const used = await mintUpgradeCode(env);
  const { sha256Hex } = await import('../src/auth.js');
  await env.DB.prepare("UPDATE upgrade_codes SET used_at = 'earlier' WHERE hash = ?").bind(await sha256Hex(used)).run();
  await expect403(used, 'used');
  // other account: a code row bound to a different legacy-shaped account
  await env.DB.prepare("INSERT INTO accounts (id, created_at) VALUES (7, 't')").run();
  const other = await mintUpgradeCode(env, 7);
  await expect403(other, 'other account');
});

test('C1c. the code is consumed by a successful upgrade and only then; one minute before expiry still works', async () => {
  let now = '2026-11-11T12:00:00.000Z';
  const env = { ...envWith(), NOW: () => now };
  const t1 = await mintDevice(env, 1, 'old', 't');
  const code = await mintUpgradeCode(env);
  now = '2026-11-12T11:59:00.000Z';
  assert.equal((await post(env, '/account/upgrade', up({ upgradeCode: code }), t1)).status, 200);
  const row = await one(env, 'SELECT used_at FROM upgrade_codes');
  assert.notEqual(row.used_at, null);
});

test('C1d. concurrent upgrades: same code twice, or two codes — exactly one 200, the code(s) used at most once', async () => {
  for (const twoCodes of [false, true]) {
    const env = envWith({ yieldPerStatement: true });
    const t1 = await mintDevice(env, 1, 'a', 't');
    const t2 = await mintDevice(env, 1, 'b', 't');
    const c1 = await mintUpgradeCode(env);
    const c2 = twoCodes ? await mintUpgradeCode(env) : c1;
    const rs = await Promise.all([
      post(env, '/account/upgrade', up({ email: 'one@example.com', authKey: b64u(32, 61), upgradeCode: c1 }), t1),
      post(env, '/account/upgrade', up({ email: 'two@example.com', authKey: b64u(32, 62), upgradeCode: c2 }), t2),
    ]);
    const st = rs.map((r) => r.status);
    assert.equal(st.filter((s) => s === 200).length, 1, `${twoCodes}: ${st}`);
    const loser = rs.find((r) => r.status !== 200);
    assert.ok([403, 409].includes(loser.status), `${twoCodes}: ${st}`);
    const winnerEmail = rs[0].status === 200 ? 'one@example.com' : 'two@example.com';
    assert.equal((await one(env, 'SELECT email FROM accounts WHERE id = 1')).email, winnerEmail);
    assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM upgrade_codes WHERE used_at IS NOT NULL')).n, 1);
  }
});
