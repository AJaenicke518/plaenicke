import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { sha256Hex } from '../src/auth.js';
import {
  envWith, invite, body, post, get, one, count, login, signedUp, b64u, T0,
} from './account-helpers.js';

const call = (env, method, path, json, secret = 'adm') => worker.fetch(new Request(`https://w${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  ...(json === undefined ? {} : { body: JSON.stringify(json) }),
}), env);

test('every admin route returns 401 without the secret or with a wrong one', async () => {
  const env = envWith();
  const routes = [
    ['POST', '/admin/invite'], ['DELETE', '/admin/invite'], ['GET', '/admin/accounts'],
    ['POST', '/admin/account/disable'], ['POST', '/admin/account/email'], ['DELETE', '/admin/account'],
    ['POST', '/admin/device'], ['DELETE', '/admin/device'], ['POST', '/admin/upgrade-code'],
  ];
  for (const [m, p] of routes) {
    for (const secret of [null, 'wrong']) {
      const res = await call(env, m, p, m === 'GET' ? undefined : {}, secret);
      assert.equal(res.status, 401, `${m} ${p} ${secret}`);
    }
  }
});

test('wrong method on an admin route is 405 after auth, before the body', async () => {
  const env = envWith();
  assert.equal((await call(env, 'GET', '/admin/invite')).status, 405);
  assert.equal((await call(env, 'POST', '/admin/accounts', {})).status, 405);
  assert.equal((await call(env, 'GET', '/admin/account/disable')).status, 405);
  assert.equal((await call(env, 'DELETE', '/admin/account/email', {})).status, 405);
  assert.equal((await call(env, 'POST', '/admin/account', {})).status, 405);
  assert.equal((await call(env, 'GET', '/admin/upgrade-code')).status, 405);
});

test('POST /admin/invite returns a 22-char code, stores only its hash, usable once', async () => {
  const env = envWith();
  const res = await call(env, 'POST', '/admin/invite', { note: 'for Sam' });
  assert.equal(res.status, 200);
  const { invite: code, ...rest } = await res.json();
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(rest, {});
  const row = await one(env, 'SELECT hash, note FROM invites');
  assert.equal(row.hash, await sha256Hex(code));
  assert.equal(row.note, 'for Sam');
  assert.equal(await count(env, 'invites'), 1);
  assert.equal((await post(env, '/auth/signup', body({ invite: code }))).status, 200);
  const again = await post(env, '/auth/signup', body({ invite: code, email: 'other@example.com' }));
  assert.equal(again.status, 403);
});

test('POST /admin/invite without a note works; bad note type is 400', async () => {
  const env = envWith();
  assert.equal((await call(env, 'POST', '/admin/invite', {})).status, 200);
  assert.equal((await call(env, 'POST', '/admin/invite', { note: 5 })).status, 400);
});

test('DELETE /admin/invite revokes by hash prefix; ambiguous, used, short and unknown are refused', async () => {
  const env = envWith();
  const code = await invite(env, 'A');
  const h = await sha256Hex(code);
  assert.equal((await call(env, 'DELETE', '/admin/invite', { hashPrefix: h.slice(0, 7) })).status, 400);
  assert.equal((await call(env, 'DELETE', '/admin/invite', { hashPrefix: 'f'.repeat(8) })).status, 404);
  const ok = await call(env, 'DELETE', '/admin/invite', { hashPrefix: h.slice(0, 8) });
  assert.equal(ok.status, 200);
  assert.ok((await one(env, 'SELECT revoked_at FROM invites WHERE hash = ?', h)).revoked_at);
  assert.equal((await post(env, '/auth/signup', body({ invite: 'A' }))).status, 403);

  // ambiguous: two hashes sharing a prefix
  await env.DB.prepare('INSERT INTO invites (hash, created_at) VALUES (?, ?), (?, ?)')
    .bind(`abcdef12${'0'.repeat(56)}`, 't', `abcdef12${'1'.repeat(56)}`, 't').run();
  const amb = await call(env, 'DELETE', '/admin/invite', { hashPrefix: 'abcdef12' });
  assert.equal(amb.status, 409);
  assert.equal((await amb.json()).error, 'ambiguous');
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM invites WHERE revoked_at IS NOT NULL')).n, 1);

  // used
  const env2 = envWith();
  await signedUp(env2);
  const uh = await sha256Hex('INVITE-1');
  const used = await call(env2, 'DELETE', '/admin/invite', { hashPrefix: uh.slice(0, 8) });
  assert.equal(used.status, 409);
  assert.equal((await used.json()).error, 'already_used');
  assert.equal((await one(env2, 'SELECT revoked_at FROM invites')).revoked_at, null);
});

test('GET /admin/accounts lists accounts with derived fields; legacy shows email null', async () => {
  const { env, accountId, token } = await signedUp({ ...envWith(), NOW: () => T0 });
  env.NOW = () => '2026-11-11T13:00:00.000Z';
  await login(env);
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash = ?').bind('2026-11-11T09:00:00.000Z', await sha256Hex(token)).run();
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash != ?').bind('2026-11-11T11:00:00.000Z', await sha256Hex(token)).run();
  await env.DB.prepare('INSERT INTO usage (account_id, day, calls) VALUES (?, ?, 7), (?, ?, 40)')
    .bind(accountId, '2026-11-11', accountId, '2026-11-10').run();
  const res = await call(env, 'GET', '/admin/accounts');
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.length, 2);
  const legacy = list.find((a) => a.id === 1);
  assert.equal(legacy.email, null);
  assert.equal(legacy.devices, 0);
  assert.equal(legacy.smartAddToday, 0);
  assert.equal(legacy.lastSeenAt, null);
  assert.equal(legacy.disabled, false);
  assert.equal(legacy.recoveryConfirmed, false);
  const a = list.find((x) => x.id === accountId);
  assert.deepEqual(a, {
    id: accountId, email: 'tester@example.com', createdAt: T0, lastSeenAt: '2026-11-11T11:00:00.000Z',
    devices: 2, smartAddToday: 7, recoveryConfirmed: false, disabled: false,
  });
  assert.ok(!JSON.stringify(list).includes('mac'));
});

test('disable deletes devices in one batch, blocks login with 403, and disabled:false clears it', async () => {
  const { env, accountId, token } = await signedUp();
  const bad = await call(env, 'POST', '/admin/account/disable', { id: accountId, disabled: 'yes' });
  assert.equal(bad.status, 400);
  assert.equal((await call(env, 'POST', '/admin/account/disable', { id: 999, disabled: true })).status, 404);
  const batches = [];
  const orig = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => { batches.push(stmts.length); return orig(stmts); };
  const res = await call(env, 'POST', '/admin/account/disable', { id: accountId, disabled: true });
  env.DB.batch = orig;
  assert.equal(res.status, 200);
  assert.deepEqual(batches, [2]);
  assert.ok((await one(env, 'SELECT disabled_at FROM accounts WHERE id = ?', accountId)).disabled_at);
  assert.equal(await count(env, 'devices'), 0);
  assert.equal((await get(env, '/data', token)).status, 401);
  assert.equal((await login(env)).status, 403);
  const on = await call(env, 'POST', '/admin/account/disable', { id: accountId, disabled: false });
  assert.equal(on.status, 200);
  assert.equal((await one(env, 'SELECT disabled_at FROM accounts WHERE id = ?', accountId)).disabled_at, null);
  assert.equal((await login(env)).status, 200);
});

test('email change: new email logs in with the same authKey and wraps still unseal', async () => {
  const { env, accountId } = await signedUp();
  assert.equal((await call(env, 'POST', '/admin/account/email', { id: accountId, email: 'nope' })).status, 400);
  assert.equal((await call(env, 'POST', '/admin/account/email', { id: 999, email: 'x@example.com' })).status, 404);
  const res = await call(env, 'POST', '/admin/account/email', { id: accountId, email: ' New@Example.com ' });
  assert.equal(res.status, 200);
  assert.equal((await login(env)).status, 404);
  const ok = await login(env, { email: 'new@example.com' });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.wrappedDekPw, body().wrappedDekPw);
});

test('email change to an address another account holds is 409 email_taken', async () => {
  const { env, accountId } = await signedUp();
  await invite(env, 'INVITE-2');
  assert.equal((await post(env, '/auth/signup', body({ invite: 'INVITE-2', email: 'two@example.com' }))).status, 200);
  const res = await call(env, 'POST', '/admin/account/email', { id: accountId, email: 'TWO@example.com' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'email_taken');
});

test('delete account: wrong confirm is 400, correct confirm removes everything in one batch, invite stays used', async () => {
  const { env, accountId } = await signedUp();
  await env.DB.prepare('INSERT INTO usage (account_id, day, calls) VALUES (?, ?, 3)').bind(accountId, '2026-11-11').run();
  const wrong = await call(env, 'DELETE', '/admin/account', { id: accountId, confirm: 'other@example.com' });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'confirm_mismatch');
  assert.equal(await count(env, 'accounts'), 2);
  assert.equal((await call(env, 'DELETE', '/admin/account', { id: 999, confirm: 'a@b.co' })).status, 404);

  const batches = [];
  const orig = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => { batches.push(stmts.length); return orig(stmts); };
  const ok = await call(env, 'DELETE', '/admin/account', { id: accountId, confirm: 'Tester@example.com' });
  assert.equal(ok.status, 200);
  assert.deepEqual(batches, [5]);
  for (const t of ['usage', 'devices']) assert.equal(await count(env, t), 0);
  assert.equal(await count(env, 'accounts'), 1);
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM data WHERE id = ?', accountId)).n, 0);
  assert.ok((await one(env, 'SELECT used_at FROM invites')).used_at);
});

test('delete refuses the legacy account (no email to confirm)', async () => {
  const env = envWith();
  const res = await call(env, 'DELETE', '/admin/account', { id: 1, confirm: '' });
  assert.equal(res.status, 400);
  assert.equal(await count(env, 'accounts'), 1);
});

test('legacy POST /admin/device needs accountId, and an unknown account is 404 no_account', async () => {
  const { env, accountId } = await signedUp();
  assert.equal((await call(env, 'POST', '/admin/device', { name: 'x' })).status, 400);
  const ok = await call(env, 'POST', '/admin/device', { name: 'x', accountId });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);
  const missing = await call(env, 'POST', '/admin/device', { name: 'x', accountId: 424242 });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'no_account');
});

test('email change on the legacy account (no password set) is 409 not_upgraded', async () => {
  const env = envWith();
  const res = await call(env, 'POST', '/admin/account/email', { id: 1, email: 'a@example.com' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'not_upgraded');
  assert.equal((await one(env, 'SELECT email FROM accounts WHERE id = 1')).email, null);
});

// --- sweep W1 (Task 6 deferred, W1-C1 admin half) ---------------------------

test('POST /admin/device for a disabled account is 409 disabled and mints nothing', async () => {
  const { env, accountId } = await signedUp();
  await env.DB.prepare('UPDATE accounts SET disabled_at = ? WHERE id = ?').bind('t', accountId).run();
  const before = await count(env, 'devices');
  const res = await call(env, 'POST', '/admin/device', { name: 'x', accountId });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'disabled');
  assert.equal(await count(env, 'devices'), before);
});

test('disable of an account deleted after the existence check is 404, not a silent 200', async () => {
  const { env, accountId } = await signedUp();
  const real = env.DB;
  // Interleave: the admin delete lands between disable's SELECT and its batch.
  const raced = {
    ...real,
    prepare: (sql) => real.prepare(sql),
    batch: async (stmts) => {
      for (const t of [['usage', 'account_id'], ['devices', 'account_id'], ['data', 'id'], ['accounts', 'id']]) {
        await real.prepare(`DELETE FROM ${t[0]} WHERE ${t[1]} = ?`).bind(accountId).run();
      }
      return real.batch(stmts);
    },
  };
  const res = await call({ ...env, DB: raced }, 'POST', '/admin/account/disable', { id: accountId, disabled: true });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'no_account');
});

test('enable of an account deleted after the existence check is 404 too', async () => {
  const { env, accountId } = await signedUp();
  const real = env.DB;
  let selects = 0;
  const raced = {
    ...real,
    prepare: (sql) => {
      const st = real.prepare(sql);
      if (/^SELECT id FROM accounts/.test(sql)) {
        selects += 1;
        return { bind: (...a) => ({ first: async () => {
          const row = await st.bind(...a).first();
          for (const t of [['usage', 'account_id'], ['devices', 'account_id'], ['data', 'id'], ['accounts', 'id']]) {
            await real.prepare(`DELETE FROM ${t[0]} WHERE ${t[1]} = ?`).bind(accountId).run();
          }
          return row;
        } }) };
      }
      return st;
    },
  };
  const res = await call({ ...env, DB: raced }, 'POST', '/admin/account/disable', { id: accountId, disabled: false });
  assert.equal(selects, 1);
  assert.equal(res.status, 404);
});

test('POST /admin/upgrade-code mints a 22-char single-use code for the legacy account, stores only its hash, expires in 24 h', async () => {
  const env = { ...envWith(), NOW: () => T0 };
  const res = await call(env, 'POST', '/admin/upgrade-code', { accountId: 1 });
  assert.equal(res.status, 200);
  const { upgradeCode, ...rest } = await res.json();
  assert.deepEqual(rest, {});
  assert.match(upgradeCode, /^[A-Za-z0-9_-]{22}$/);
  const row = await one(env, 'SELECT * FROM upgrade_codes');
  assert.deepEqual(row, { hash: await sha256Hex(upgradeCode), account_id: 1, created_at: T0, expires_at: '2026-11-12T12:00:00.000Z', used_at: null });
  const second = await (await call(env, 'POST', '/admin/upgrade-code', { accountId: 1 })).json();
  assert.notEqual(second.upgradeCode, upgradeCode);
});

test('POST /admin/upgrade-code: bad id 400, unknown 404, an account with an email 409 already_upgraded', async () => {
  const { env, accountId } = await signedUp();
  for (const b of [{}, { accountId: '1' }, { accountId: 0 }, { accountId: 1.5 }]) {
    const r = await call(env, 'POST', '/admin/upgrade-code', b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal((await r.json()).error, 'bad_request');
  }
  const unk = await call(env, 'POST', '/admin/upgrade-code', { accountId: 424242 });
  assert.equal(unk.status, 404);
  assert.equal((await unk.json()).error, 'no_account');
  const up = await call(env, 'POST', '/admin/upgrade-code', { accountId });
  assert.equal(up.status, 409);
  assert.equal((await up.json()).error, 'already_upgraded');
  assert.equal(await count(env, 'upgrade_codes'), 0);
});

test('delete account also removes its upgrade codes (FK on)', async () => {
  const { env, accountId } = await signedUp();
  await env.DB.prepare("INSERT INTO upgrade_codes (hash, account_id, created_at, expires_at, used_at) VALUES ('h', ?, 't', 't', 't')").bind(accountId).run();
  const ok = await call(env, 'DELETE', '/admin/account', { id: accountId, confirm: 'tester@example.com' });
  assert.equal(ok.status, 200);
  assert.equal(await count(env, 'upgrade_codes'), 0);
});
