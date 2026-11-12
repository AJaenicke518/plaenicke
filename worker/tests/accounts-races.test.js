// accounts-races.test.js — sweep W1 concurrency findings, each EXECUTED as an
// interleaving rather than argued: hookDb runs the competing request at the
// exact statement where the race opens; Promise.all variants run on
// makeD1({ yieldPerStatement: true }) so handlers genuinely interleave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64u, b64, post, get, one, login, signedUp, envWith, hookDb, noBatchMeta, invite, body, T0,
} from './account-helpers.js';

const fin = (over = {}) => ({
  email: 'tester@example.com', recAuthKey: b64u(32, 3), kdfSalt: b64u(16, 11), kdfIters: 600000,
  authKey: b64u(32, 12), recAuthKey2: b64u(32, 13), wrappedDekPw: b64(60, 14), wrappedDekRec2: b64(60, 15),
  deviceName: 'Recovered', ...over,
});
const pw = (over = {}) => ({
  currentAuthKey: b64u(32, 2), kdfSalt: b64u(16, 21), kdfIters: 600000, authKey: b64u(32, 22),
  wrappedDekPw: b64(60, 24), signOutOthers: false, ...over,
});
const devCount = async (env, id) => (await one(env, 'SELECT COUNT(*) AS n FROM devices WHERE account_id = ?', id)).n;
const admin = (env, path, json) => post(env, path, json, 'adm');
const LOGIN_INSERT = /INSERT INTO devices/;

// --- W1-I1: login must not mint a session that outlives a credential change --

test('I1a. login racing a password change with sign-out-others: the late login is 401 and mints nothing', async () => {
  const { env, token, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  let change;
  const res = await login(hookDb(env, [{ re: LOGIN_INSERT, before: async () => {
    change = await post(env, '/account/password', pw({ signOutOthers: true }), token);
  } }]));
  assert.equal(change.status, 200);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'bad_credentials');
  assert.equal(await devCount(env, accountId), 1); // only the device that changed the password
});

test('I1b. login racing a recovery: the late login is 401; only the recovered device remains', async () => {
  const { env, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  let rec;
  const res = await login(hookDb(env, [{ re: LOGIN_INSERT, before: async () => {
    rec = await post(env, '/auth/recover/finish', fin());
  } }]));
  assert.equal(rec.status, 200);
  assert.equal(res.status, 401);
  assert.equal(await devCount(env, accountId), 1);
  assert.equal((await one(env, 'SELECT name FROM devices WHERE account_id = ?', accountId)).name, 'Recovered');
});

test('I1c. login racing an admin disable: the late login is 403 disabled and mints nothing', async () => {
  const { env, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  const res = await login(hookDb(env, [{ re: LOGIN_INSERT, before: async () => {
    assert.equal((await admin(env, '/admin/account/disable', { id: accountId, disabled: true })).status, 200);
  } }]));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'disabled');
  assert.equal(await devCount(env, accountId), 0);
});

test('I1d. recover/finish racing an admin disable: 403 disabled, credentials unchanged, no device', async () => {
  const { env, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  const before = await one(env, 'SELECT auth_mac, rec_auth_mac FROM accounts WHERE id = ?', accountId);
  const res = await post(hookDb(env, [{ re: /UPDATE accounts SET kdf_salt/, before: async () => {
    assert.equal((await admin(env, '/admin/account/disable', { id: accountId, disabled: true })).status, 200);
  } }]), '/auth/recover/finish', fin());
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'disabled');
  assert.deepEqual(await one(env, 'SELECT auth_mac, rec_auth_mac FROM accounts WHERE id = ?', accountId), before);
  assert.equal(await devCount(env, accountId), 0);
});

// --- W1-I2: recover/finish replay ---------------------------------------------

test('I2a. two identical recover/finish bodies in parallel: [200, 409], and the 200 token works', async () => {
  const { env, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  const rs = await Promise.all([post(env, '/auth/recover/finish', fin()), post(env, '/auth/recover/finish', fin())]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const win = await rs.find((r) => r.status === 200).json();
  assert.equal((await rs.find((r) => r.status === 409).json()).error, 'recovery_changed');
  assert.equal((await get(env, '/data', win.token)).status, 200);
  assert.equal(await devCount(env, accountId), 1);
});

test('I2b. an identical body replayed at the batch (deterministic): the winner keeps its device', async () => {
  const { env, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  let first;
  const second = await post(hookDb(env, [{ re: /UPDATE accounts SET kdf_salt/, before: async () => {
    first = await post(env, '/auth/recover/finish', fin());
  } }]), '/auth/recover/finish', fin());
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal((await get(env, '/data', (await first.json()).token)).status, 200);
  assert.equal(await devCount(env, accountId), 1);
});

test('I2c. recAuthKey2 equal to recAuthKey is 400 bad_request', async () => {
  const { env } = await signedUp();
  const res = await post(env, '/auth/recover/finish', fin({ recAuthKey2: b64u(32, 3) }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
});

// --- W1-I10: 409 password_changed paths ---------------------------------------

test('I10a. two password changes in parallel: [200, 409 password_changed]; the loser signs nothing out', async () => {
  const { env, token, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  const t2 = (await (await login(env)).json()).token;
  const t3 = (await (await login(env)).json()).token;
  const rs = await Promise.all([
    post(env, '/account/password', pw({ authKey: b64u(32, 71) }), token),
    post(env, '/account/password', pw({ authKey: b64u(32, 72), signOutOthers: true }), t2),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await rs.find((r) => r.status === 409).json()).error, 'password_changed');
  if (rs[0].status === 200) {
    // the loser asked to sign the others out; nobody was
    assert.equal(await devCount(env, accountId), 3);
    for (const t of [token, t2, t3]) assert.equal((await get(env, '/data', t)).status, 200);
    assert.equal((await login(env, { authKey: b64u(32, 71) })).status, 200);
  } else {
    assert.equal(await devCount(env, accountId), 1);
    assert.equal((await login(env, { authKey: b64u(32, 72) })).status, 200);
  }
});

test('I10b. deterministic: a password change landing first makes the other 409 and its sign-out-others a no-op', async () => {
  const { env, token, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  const t2 = (await (await login(env)).json()).token;
  let winner;
  const loser = await post(hookDb(env, [{ re: /UPDATE accounts SET kdf_salt/, before: async () => {
    winner = await post(env, '/account/password', pw({ authKey: b64u(32, 71) }), token);
  } }]), '/account/password', pw({ authKey: b64u(32, 72), signOutOthers: true }), t2);
  assert.equal(winner.status, 200);
  assert.equal(loser.status, 409);
  assert.equal((await loser.json()).error, 'password_changed');
  assert.equal(await devCount(env, accountId), 2);
  assert.equal((await login(env, { authKey: b64u(32, 71) })).status, 200);
});

test('I10d. two changes to the SAME new password: the loser\'s sign-out-others is still a no-op', async () => {
  const { env, token, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  const t2 = (await (await login(env)).json()).token;
  let winner;
  const loser = await post(hookDb(env, [{ re: /UPDATE accounts SET kdf_salt/, before: async () => {
    winner = await post(env, '/account/password', pw({ authKey: b64u(32, 71) }), token);
  } }]), '/account/password', pw({ authKey: b64u(32, 71), signOutOthers: true }), t2);
  assert.equal(winner.status, 200);
  assert.equal(loser.status, 409);
  assert.equal(await devCount(env, accountId), 2);
  assert.equal((await get(env, '/data', token)).status, 200);
});

test('I10c. a new recovery link racing a password change: 409 password_changed, recovery key unchanged', async () => {
  const { env, token, accountId } = await signedUp(envWith({ yieldPerStatement: true }));
  const t2 = (await (await login(env)).json()).token;
  const recBefore = (await one(env, 'SELECT rec_auth_mac FROM accounts WHERE id = ?', accountId)).rec_auth_mac;
  const res = await post(hookDb(env, [{ re: /UPDATE accounts SET rec_auth_mac/, before: async () => {
    assert.equal((await post(env, '/account/password', pw(), token)).status, 200);
  } }]), '/account/recovery', { currentAuthKey: b64u(32, 2), recAuthKey: b64u(32, 7), wrappedDekRec: b64(60, 8) }, t2);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'password_changed');
  assert.equal((await one(env, 'SELECT rec_auth_mac FROM accounts WHERE id = ?', accountId)).rec_auth_mac, recBefore);
});

// --- W1-I4: success is read from RETURNING, never batch meta ------------------

test('I4. sign-up, login, recover/finish, password change, new recovery and upgrade succeed with no batch meta', async () => {
  const base = envWith();
  await invite(base);
  const env = noBatchMeta(base);
  const su = await post(env, '/auth/signup', body());
  assert.equal(su.status, 200);
  const { token } = await su.json();
  assert.equal((await login(env)).status, 200);
  assert.equal((await post(env, '/account/password', pw({ authKey: b64u(32, 2) }), token)).status, 200);
  assert.equal((await post(env, '/account/recovery', { currentAuthKey: b64u(32, 2), recAuthKey: b64u(32, 3), wrappedDekRec: b64(60, 5) }, token)).status, 200);
  assert.equal((await post(env, '/auth/recover/finish', fin())).status, 200);
  const { mintDevice } = await import('../src/auth.js');
  const t1 = await mintDevice(base, 1, 'old', 't');
  const code = (await (await admin(base, '/admin/upgrade-code', { accountId: 1 })).json()).upgradeCode;
  const upRes = await post(env, '/account/upgrade', {
    email: 'alex@example.com', kdfSalt: b64u(16, 1), kdfIters: 600000, authKey: b64u(32, 2), recAuthKey: b64u(32, 3),
    wrappedDekPw: b64(60, 4), wrappedDekRec: b64(60, 5), dekCheck: 'b'.repeat(64), upgradeCode: code,
  }, t1);
  assert.equal(upRes.status, 200);
});

test('I4b. sign-up RETURNING names the account it created', async () => {
  const env = envWith();
  await invite(env);
  const j = await (await post(env, '/auth/signup', body())).json();
  assert.equal((await one(env, 'SELECT id FROM accounts WHERE email = ?', 'tester@example.com')).id, j.accountId);
});

// --- CONC S7: 429 retryAt is never null; GET /account on a vanished account ----

test('S7a. a lock cleared between the failed reservation and the read: the reservation is retried once', async () => {
  const { env } = await signedUp({ ...envWith(), NOW: () => T0 });
  await env.DB.prepare("UPDATE accounts SET failed_logins = 50, locked_until = '2026-11-11T13:00:00.000Z' WHERE email IS NOT NULL").run();
  const res = await login(hookDb(env, [{ re: /SELECT locked_until/, before: async () => {
    await env.DB.prepare('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE email IS NOT NULL').run();
  } }]));
  assert.equal(res.status, 200);
});

test('S7b. a lock that keeps flickering: 429 with retryAt = now + 60 min, never null', async () => {
  const { env } = await signedUp({ ...envWith(), NOW: () => T0 });
  const res = await login(hookDb(env, [
    { re: /RETURNING failed_logins/, once: false, before: async () => {
      await env.DB.prepare("UPDATE accounts SET locked_until = '2999-01-01T00:00:00.000Z' WHERE email IS NOT NULL").run();
    } },
    { re: /SELECT locked_until/, once: false, before: async () => {
      await env.DB.prepare('UPDATE accounts SET locked_until = NULL WHERE email IS NOT NULL').run();
    } },
  ]));
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'locked', retryAt: '2026-11-11T13:00:00.000Z' });
});

test('S7c. GET /account for an account deleted after authentication is 401, not 500', async () => {
  const { env, token, accountId } = await signedUp();
  const res = await get(hookDb(env, [{ re: /SELECT email, recovery_confirmed_at FROM accounts/, before: async () => {
    for (const [t, c] of [['usage', 'account_id'], ['devices', 'account_id'], ['data', 'id'], ['accounts', 'id']]) {
      await env.DB.prepare(`DELETE FROM ${t} WHERE ${c} = ?`).bind(accountId).run();
    }
  } }]), '/account', token);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

// --- W1-I7: bearer password checks use a per-device counter -------------------

test('I7c. 15 parallel wrong current keys from one device: exactly 10 x 401 and 5 x 429', async () => {
  const { env, token } = await signedUp({ ...envWith({ yieldPerStatement: true }), NOW: () => T0 });
  const rs = await Promise.all(Array.from({ length: 15 }, () => post(env, '/account/password', pw({ currentAuthKey: b64u(32, 9) }), token)));
  const st = rs.map((r) => r.status);
  assert.equal(st.filter((s) => s === 401).length, 10);
  assert.equal(st.filter((s) => s === 429).length, 5);
  assert.equal((await one(env, 'SELECT failed_logins FROM accounts WHERE email IS NOT NULL')).failed_logins, 0);
});
