import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../src/auth.js';
import {
  KEY, KEY_B, b64u, b64, envWith, invite, body, post, get, one, count, login, signedUp, T0,
} from './account-helpers.js';

test('1. sign-up with a valid invite creates account, data row, device; consumes invite', async () => {
  const env = envWith();
  await invite(env);
  const res = await post(env, '/auth/signup', body());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(typeof j.token, 'string');
  assert.ok(Number.isSafeInteger(j.accountId) && j.accountId >= 2);
  const acc = await one(env, 'SELECT * FROM accounts WHERE id = ?', j.accountId);
  assert.equal(acc.email, 'tester@example.com');
  assert.equal(acc.failed_logins, 0);
  assert.equal(acc.recovery_confirmed_at, null);
  const d = await one(env, 'SELECT * FROM data WHERE id = ?', j.accountId);
  assert.equal(d.version, 0); assert.equal(d.blob, '');
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM devices WHERE account_id = ?', j.accountId)).n, 1);
  assert.notEqual((await one(env, 'SELECT used_at FROM invites')).used_at, null);
});

test('2. a second sign-up with the same invite is 403 invalid_invite', async () => {
  const { env } = await signedUp();
  const before = await count(env, 'accounts');
  const res = await post(env, '/auth/signup', body({ email: 'other@example.com' }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'invalid_invite');
  assert.equal(await count(env, 'accounts'), before);
});

test('3. an invite stays used after its account is deleted', async () => {
  const { env, accountId } = await signedUp();
  for (const [t, c] of [['usage', 'account_id'], ['devices', 'account_id'], ['data', 'id'], ['accounts', 'id']]) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE ${c} = ?`).bind(accountId).run();
  }
  const res = await post(env, '/auth/signup', body());
  assert.equal(res.status, 403);
});

test('4. a revoked invite is 403', async () => {
  const env = envWith();
  await invite(env);
  await env.DB.prepare('UPDATE invites SET revoked_at = ?').bind('t').run();
  const res = await post(env, '/auth/signup', body());
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'invalid_invite');
});

test('5. a duplicate email is 409 and the second invite is not consumed', async () => {
  const { env } = await signedUp();
  await invite(env, 'INVITE-2');
  const res = await post(env, '/auth/signup', body({ invite: 'INVITE-2' }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'email_taken');
  const row = await one(env, 'SELECT used_at FROM invites WHERE hash = ?', await sha256Hex('INVITE-2'));
  assert.equal(row.used_at, null);
});

test('6. a batch whose LAST statement fails rolls back the earlier ones (invite, account, data)', async () => {
  const env = envWith();
  await invite(env);
  const real = env.DB;
  const failingLast = {
    prepare: (sql) => real.prepare(sql),
    batch: (stmts) => real.batch([...stmts.slice(0, -1), real.prepare('INSERT INTO nosuch_table VALUES (1)')]),
  };
  const res = await post({ ...env, DB: failingLast }, '/auth/signup', body());
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'internal_error');
  assert.equal(await count(env, 'accounts'), 1); // legacy account 1 only
  assert.equal(await count(env, 'data'), 1); // legacy account 1's row only
  assert.equal((await one(env, 'SELECT used_at FROM invites')).used_at, null);
});

test('7. prelogin returns salt and iters; unknown and legacy are 404', async () => {
  const { env } = await signedUp();
  const res = await post(env, '/auth/prelogin', { email: 'tester@example.com' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { kdfSalt: b64u(16, 1), kdfIters: 600000 });
  const unk = await post(env, '/auth/prelogin', { email: 'nobody@example.com' });
  assert.equal(unk.status, 404);
  assert.equal((await unk.json()).error, 'no_account');
  const leg = await post(env, '/auth/prelogin', { email: '' });
  assert.equal(leg.status, 404);
});

test('8. login with the right key returns the unsealed wrap and resets failures', async () => {
  const { env } = await signedUp();
  await env.DB.prepare('UPDATE accounts SET failed_logins = 7 WHERE email IS NOT NULL').run();
  const res = await login(env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(typeof j.token, 'string');
  assert.equal(j.wrappedDekPw, b64(60, 4));
  assert.equal(j.dekCheck, 'a'.repeat(64));
  assert.equal(j.recoveryConfirmed, false);
  assert.equal((await one(env, 'SELECT failed_logins FROM accounts WHERE email IS NOT NULL')).failed_logins, 0);
});

test('9. login with a wrong key is 401 and increments failed_logins', async () => {
  const { env } = await signedUp();
  const res = await login(env, { authKey: b64u(32, 9) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'bad_credentials');
  assert.equal((await one(env, 'SELECT failed_logins FROM accounts WHERE email IS NOT NULL')).failed_logins, 1);
});

test('10. lockout at exactly 50, expires after an hour', async () => {
  const { env } = await signedUp();
  env.NOW = () => T0;
  const bad = { authKey: b64u(32, 9) };
  for (let i = 1; i <= 49; i += 1) assert.equal((await login(env, bad)).status, 401, `attempt ${i}`);
  assert.equal((await one(env, 'SELECT locked_until FROM accounts WHERE email IS NOT NULL')).locked_until, null);
  assert.equal((await login(env, bad)).status, 401);
  assert.notEqual((await one(env, 'SELECT locked_until FROM accounts WHERE email IS NOT NULL')).locked_until, null);
  const locked = await login(env);
  assert.equal(locked.status, 429);
  const lj = await locked.json();
  assert.equal(lj.error, 'locked');
  assert.equal(lj.retryAt, '2026-11-11T13:00:00.000Z');
  env.NOW = () => '2026-11-11T13:01:00.000Z';
  assert.equal((await login(env)).status, 200);
  assert.equal((await one(env, 'SELECT failed_logins FROM accounts WHERE email IS NOT NULL')).failed_logins, 0);
});

test('10b. after an expired lock a WRONG key restarts the window at 1', async () => {
  const { env } = await signedUp();
  env.NOW = () => T0;
  const bad = { authKey: b64u(32, 9) };
  for (let i = 1; i <= 50; i += 1) await login(env, bad);
  assert.equal((await login(env, bad)).status, 429);
  env.NOW = () => '2026-11-11T13:01:00.000Z';
  assert.equal((await login(env, bad)).status, 401);
  const row = await one(env, 'SELECT failed_logins, locked_until FROM accounts WHERE email IS NOT NULL');
  assert.equal(row.failed_logins, 1);
  assert.equal(row.locked_until, null);
});

test('11 + 20. 60 concurrent wrong logins: exactly 50 x 401, 10 x 429, all with retryAt', async () => {
  const { env } = await signedUp(envWith({ yieldPerStatement: true }));
  env.NOW = () => T0;
  const rs = await Promise.all(Array.from({ length: 60 }, () => login(env, { authKey: b64u(32, 9) })));
  const statuses = rs.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 50);
  assert.equal(statuses.filter((s) => s === 429).length, 10);
  for (const r of rs.filter((x) => x.status === 429)) assert.ok((await r.json()).retryAt);
  assert.equal((await one(env, 'SELECT failed_logins FROM accounts WHERE email IS NOT NULL')).failed_logins, 50);
});

test('12. a disabled account is 403 disabled on login — only after the key matched (no disabled oracle)', async () => {
  const { env } = await signedUp();
  await env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE email IS NOT NULL').bind('t').run();
  const wrong = await login(env, { authKey: b64u(32, 9) });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, 'bad_credentials');
  const res = await login(env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'disabled');
});

test('13. logout deletes only the calling device', async () => {
  const { env, token } = await signedUp();
  const second = (await (await login(env)).json()).token;
  const res = await post(env, '/auth/logout', undefined, token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await get(env, '/data', token)).status, 401);
  assert.equal((await get(env, '/data', second)).status, 200);
  assert.equal((await post(env, '/auth/logout', undefined)).status, 401);
});

test('14. devices list marks current; signout-others leaves only the caller', async () => {
  const { env, token } = await signedUp();
  const second = (await (await login(env)).json()).token;
  const list = await (await get(env, '/account/devices', token)).json();
  assert.equal(list.devices.length, 2);
  assert.deepEqual(list.devices.map((d) => d.name).sort(), ['Mac', 'iPhone']);
  assert.equal(list.devices.filter((d) => d.current).length, 1);
  assert.equal(list.devices.find((d) => d.current).name, 'iPhone');
  const so = await post(env, '/account/devices/signout-others', undefined, token);
  assert.deepEqual(await so.json(), { signedOut: 1 });
  assert.equal((await get(env, '/data', second)).status, 401);
  assert.equal((await get(env, '/data', token)).status, 200);
  assert.equal((await get(env, '/account/devices')).status, 401);
});

test('15. recovery confirm sets recovery_confirmed_at; login reports it', async () => {
  const { env, token, accountId } = await signedUp();
  const acct = await (await get(env, '/account', token)).json();
  assert.deepEqual(acct, { accountId, email: 'tester@example.com', recoveryConfirmed: false });
  const res = await post(env, '/account/recovery/confirm', { recAuthKey: b64u(32, 3) }, token);
  assert.deepEqual(await res.json(), { ok: true });
  assert.notEqual((await one(env, 'SELECT recovery_confirmed_at FROM accounts WHERE id = ?', accountId)).recovery_confirmed_at, null);
  assert.equal((await (await login(env)).json()).recoveryConfirmed, true);
  assert.equal((await post(env, '/account/recovery/confirm', undefined)).status, 401);
});

test('15b. GET /account for the legacy account', async () => {
  const env = envWith();
  const { mintDevice } = await import('../src/auth.js');
  const token = await mintDevice(env, 1, 'old', 't');
  assert.deepEqual(await (await get(env, '/account', token)).json(), { accountId: 1, email: null, recoveryConfirmed: false });
});

test('16. missing AT_REST_KEY is 500 not_configured; a changed key is at_rest_key_mismatch', async () => {
  const env = envWith();
  await invite(env);
  const noKey = { ...env, AT_REST_KEY: undefined };
  let res = await post(noKey, '/auth/signup', body());
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'not_configured');
  res = await login(noKey);
  assert.equal((await res.json()).error, 'not_configured');
  assert.equal((await one(env, 'SELECT used_at FROM invites')).used_at, null);

  const a = envWith();
  await invite(a);
  assert.equal((await post(a, '/auth/signup', body())).status, 200);
  res = await login({ ...a, AT_REST_KEY: KEY_B });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'at_rest_key_mismatch');
});

test('17. responses and logs never contain the email or the auth key', async () => {
  const captured = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    const env = envWith();
    await invite(env);
    const r1 = await post(env, '/auth/signup', body());
    captured.push(await r1.clone().text());
    const r2 = await login(env, { authKey: b64u(32, 9) });
    captured.push(await r2.text());
    const r3 = await login(env);
    captured.push(await r3.text().then((t) => t.replace(/"wrappedDekPw":"[^"]*"/, '')));
    // a 500 path while the console is captured: internal_error logs name + message only
    const broken = { ...env, DB: { prepare: env.DB.prepare, batch: async () => { throw new Error('D1 down'); } } };
    const r4 = await login(broken);
    assert.equal(r4.status, 500);
    captured.push(await r4.text());
  } finally { console.log = origLog; console.error = origErr; }
  assert.ok(captured.some((s) => s.includes('D1 down')), 'the 500 path logged');
  for (const s of captured) {
    assert.ok(!s.toLowerCase().includes('tester@example.com'));
    assert.ok(!s.includes(body().authKey));
  }
});

test('18. a replayed used invite with the same email cannot attach a device', async () => {
  const { env, accountId } = await signedUp();
  const res = await post(env, '/auth/signup', body());
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'invalid_invite');
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM devices WHERE account_id = ?', accountId)).n, 1);
});

test('19. validation failures are 400 and consume no invite', async () => {
  const env = envWith();
  await invite(env);
  for (const over of [
    { kdfIters: 599999 }, { email: '' }, { email: 'no-at-sign' }, { deviceName: 'x'.repeat(101) },
    { deviceName: '' }, { authKey: b64u(31, 2) }, { recAuthKey: 'not base64!' }, { kdfSalt: b64u(15, 1) },
    { dekCheck: 'a'.repeat(63) }, { dekCheck: 'A'.repeat(64) }, { dekCheck: 'g'.repeat(64) }, { dekCheck: 'a'.repeat(65) },
    { wrappedDekPw: b64(59, 4) }, { wrappedDekRec: b64(61, 5) }, { kdfIters: 600000.5 },
  ]) {
    const res = await post(env, '/auth/signup', body(over));
    assert.equal(res.status, 400, JSON.stringify(Object.keys(over)));
    assert.equal((await res.json()).error, 'bad_request');
  }
  assert.equal((await one(env, 'SELECT used_at FROM invites')).used_at, null);
});

// --- sweep W1 (I5, I8, I9, TEST M2/M3) ---------------------------------------

test('I5. login with an unsealable wrap is 500 bad_seal and mints no session', async () => {
  const { env, accountId } = await signedUp();
  await env.DB.prepare("UPDATE accounts SET wrapped_dek_pw_sealed = 'k1:AAAA', failed_logins = 3 WHERE id = ?").bind(accountId).run();
  const res = await login(env);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'bad_seal');
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM devices WHERE account_id = ?', accountId)).n, 1);
});

test('I8. kdfIters above 10,000,000 is 400 on sign-up; exactly 10,000,000 is accepted', async () => {
  const env = envWith();
  await invite(env);
  const res = await post(env, '/auth/signup', body({ kdfIters: 10_000_001 }));
  assert.equal(res.status, 400);
  assert.equal((await one(env, 'SELECT used_at FROM invites')).used_at, null);
  assert.equal((await post(env, '/auth/signup', body({ kdfIters: 10_000_000 }))).status, 200);
});

test('I9. the devices list and sign-out-others are scoped to the caller\'s account', async () => {
  const { env, token } = await signedUp();
  await invite(env, 'INVITE-2');
  const other = await (await post(env, '/auth/signup', body({ invite: 'INVITE-2', email: 'two@example.com', deviceName: 'OtherPhone' }))).json();
  const otherSecond = (await (await login(env, { email: 'two@example.com', deviceName: 'OtherMac' })).json()).token;
  const second = (await (await login(env)).json()).token;
  const list = await (await get(env, '/account/devices', token)).json();
  assert.deepEqual(list.devices.map((d) => d.name).sort(), ['Mac', 'iPhone']);
  const so = await post(env, '/account/devices/signout-others', undefined, token);
  assert.deepEqual(await so.json(), { signedOut: 1 });
  assert.equal((await get(env, '/data', second)).status, 401);
  for (const t of [other.token, otherSecond]) assert.equal((await get(env, '/data', t)).status, 200);
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM devices WHERE account_id = ?', other.accountId)).n, 2);
});

test('M2. login at exactly retryAt succeeds', async () => {
  const { env } = await signedUp();
  env.NOW = () => T0;
  for (let i = 1; i <= 50; i += 1) await login(env, { authKey: b64u(32, 9) });
  const locked = await (await login(env)).json();
  assert.equal(locked.retryAt, '2026-11-11T13:00:00.000Z');
  env.NOW = () => locked.retryAt;
  assert.equal((await login(env)).status, 200);
});

test('M3. prelogin and login treat an account with an email but no password as unknown (404)', async () => {
  const env = envWith();
  await env.DB.prepare("INSERT INTO accounts (id, email, kdf_salt, kdf_iters, created_at) VALUES (9, 'half@example.com', ?, 600000, 't')")
    .bind(b64u(16, 1)).run();
  const pre = await post(env, '/auth/prelogin', { email: 'half@example.com' });
  assert.equal(pre.status, 404);
  assert.equal((await pre.json()).error, 'no_account');
  assert.equal((await login(env, { email: 'half@example.com' })).status, 404);
});
