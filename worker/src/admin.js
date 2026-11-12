// admin.js — ADMIN_SECRET routes (spec § 6.9, D22): invites, account list,
// disable, email correction, delete, legacy upgrade codes, and the legacy
// device routes.
//
// Every route: auth, then method, then body. Never log emails, tokens or bodies.
import {
  isAdmin, mintDevice, revokeDevice, sha256Hex,
} from './auth.js';
import { json } from './cors.js';
import { nowISO, addMinutes } from './clock.js';
import { normEmail, validEmail, readBody } from './input.js';

const validId = (n) => Number.isInteger(n) && n > 0;

async function handleInvite(request, env) {
  const b = await readBody(request);
  if (!b || typeof b !== 'object') return json({ error: 'bad_json' }, 400);
  if (request.method === 'POST') {
    if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 200)) return json({ error: 'bad_request' }, 400);
    const code = newCode();
    await env.DB.prepare('INSERT INTO invites (hash, note, created_at) VALUES (?, ?, ?)')
      .bind(await sha256Hex(code), b.note ?? null, nowISO(env)).run();
    return json({ invite: code });
  }
  // DELETE
  const prefix = b.hashPrefix;
  if (typeof prefix !== 'string' || !/^[0-9a-f]{8,64}$/.test(prefix)) return json({ error: 'bad_request' }, 400);
  const { results } = await env.DB.prepare('SELECT hash, used_at FROM invites WHERE substr(hash, 1, ?) = ?')
    .bind(prefix.length, prefix).all();
  if (results.length === 0) return json({ error: 'not_found' }, 404);
  if (results.length > 1) return json({ error: 'ambiguous' }, 409);
  if (results[0].used_at !== null) return json({ error: 'already_used' }, 409);
  const res = await env.DB.prepare('UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE hash = ? AND used_at IS NULL')
    .bind(nowISO(env), results[0].hash).run();
  if (res.meta.changes !== 1) return json({ error: 'already_used' }, 409);
  return json({ revoked: true });
}

// 16 random bytes, base64url (22 chars): invites and upgrade codes.
function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleAccounts(env) {
  const now = nowISO(env);
  const day = now.slice(0, 10);
  const { results } = await env.DB.prepare(`SELECT a.id, a.email, a.created_at, a.recovery_confirmed_at, a.disabled_at,
      (SELECT MAX(last_seen_at) FROM devices d WHERE d.account_id = a.id) AS last_seen_at,
      (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id) AS devices,
      COALESCE((SELECT calls FROM usage u WHERE u.account_id = a.id AND u.day = ?), 0) AS smart_add_today
    FROM accounts a ORDER BY a.id`).bind(day).all();
  return json(results.map((r) => ({
    id: r.id,
    email: r.email,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    devices: r.devices,
    smartAddToday: r.smart_add_today,
    recoveryConfirmed: r.recovery_confirmed_at !== null,
    disabled: r.disabled_at !== null,
  })));
}

async function handleDisable(request, env) {
  const b = await readBody(request);
  if (!b || !validId(b.id) || typeof b.disabled !== 'boolean') return json({ error: 'bad_request' }, 400);
  const row = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(b.id).first();
  if (!row) return json({ error: 'no_account' }, 404);
  // RETURNING, not meta.changes: per-statement changes inside a D1 batch are
  // not something these tests can verify against real D1. An account deleted
  // between the SELECT and here returns no row -> 404, not a silent 200.
  let landed;
  if (b.disabled) {
    const results = await env.DB.batch([
      env.DB.prepare('UPDATE accounts SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ? RETURNING id').bind(nowISO(env), b.id),
      env.DB.prepare('DELETE FROM devices WHERE account_id = ?').bind(b.id),
    ]);
    landed = results[0].results.length === 1;
  } else {
    const res = await env.DB.prepare('UPDATE accounts SET disabled_at = NULL WHERE id = ? RETURNING id').bind(b.id).run();
    landed = res.results.length === 1;
  }
  if (!landed) return json({ error: 'no_account' }, 404);
  return json({ id: b.id, disabled: b.disabled });
}

const UPGRADE_CODE_MINUTES = 24 * 60;

// One-time code that authorises POST /account/upgrade (sweep W1-C1): a bearer
// token for account 1 alone must not be able to set its email and password.
// Only for an account that has no email yet (legacy account 1).
async function handleUpgradeCode(request, env) {
  const b = await readBody(request);
  if (!b || !validId(b.accountId)) return json({ error: 'bad_request' }, 400);
  const row = await env.DB.prepare('SELECT email FROM accounts WHERE id = ?').bind(b.accountId).first();
  if (!row) return json({ error: 'no_account' }, 404);
  if (row.email !== null) return json({ error: 'already_upgraded' }, 409);
  const code = newCode();
  const now = nowISO(env);
  await env.DB.prepare('INSERT INTO upgrade_codes (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(code), b.accountId, now, addMinutes(now, UPGRADE_CODE_MINUTES)).run();
  // Returned here and never again — only its hash is stored.
  return json({ upgradeCode: code });
}

async function handleEmail(request, env) {
  const b = await readBody(request);
  const email = normEmail(b && b.email);
  if (!b || !validId(b.id) || !validEmail(email)) return json({ error: 'bad_request' }, 400);
  const row = await env.DB.prepare('SELECT auth_mac FROM accounts WHERE id = ?').bind(b.id).first();
  if (!row) return json({ error: 'no_account' }, 404);
  // A legacy account has no password yet; its email is set by the upgrade route, which also sets the credentials.
  if (row.auth_mac === null) return json({ error: 'not_upgraded' }, 409);
  try {
    await env.DB.prepare('UPDATE accounts SET email = ? WHERE id = ?').bind(email, b.id).run();
  } catch (err) {
    if (/UNIQUE constraint failed: accounts\.email/.test(String(err && err.message))) return json({ error: 'email_taken' }, 409);
    throw err;
  }
  return json({ id: b.id });
}

async function handleDeleteAccount(request, env) {
  const b = await readBody(request);
  if (!b || !validId(b.id) || typeof b.confirm !== 'string') return json({ error: 'bad_request' }, 400);
  const row = await env.DB.prepare('SELECT email FROM accounts WHERE id = ?').bind(b.id).first();
  if (!row) return json({ error: 'no_account' }, 404);
  if (row.email === null || normEmail(b.confirm) !== row.email.toLowerCase()) return json({ error: 'confirm_mismatch' }, 400);
  // Child rows first (FKs on). The invite keeps used_at: a used code stays used.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM usage WHERE account_id = ?').bind(b.id),
    env.DB.prepare('DELETE FROM upgrade_codes WHERE account_id = ?').bind(b.id),
    env.DB.prepare('DELETE FROM devices WHERE account_id = ?').bind(b.id),
    env.DB.prepare('DELETE FROM data WHERE id = ?').bind(b.id),
    env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(b.id),
  ]);
  return json({ deleted: true });
}

export async function handleAdminDevice(request, env) {
  const b = await readBody(request);
  if (!b) return json({ error: 'bad_json' }, 400);
  if (request.method === 'POST') {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || !validId(b.accountId)) return json({ error: 'bad_request' }, 400);
    const acct = await env.DB.prepare('SELECT disabled_at FROM accounts WHERE id = ?').bind(b.accountId).first();
    if (!acct) return json({ error: 'no_account' }, 404);
    // A token for a disabled account would be refused on every request anyway
    // (authenticateDevice joins on disabled_at); say so instead of minting it.
    if (acct.disabled_at !== null) return json({ error: 'disabled' }, 409);
    // The token is returned here and never again — only its hash is stored.
    const token = await mintDevice(env, b.accountId, name, nowISO(env));
    return json({ token, name });
  }
  const hash = typeof b.token_hash === 'string' ? b.token_hash : '';
  if (!hash) return json({ error: 'bad_request' }, 400);
  return json({ revoked: await revokeDevice(env, hash) });
}

// path -> [allowed methods, handler(request, env)]
const ROUTES = {
  '/admin/invite': [['POST', 'DELETE'], handleInvite],
  '/admin/accounts': [['GET'], (req, env) => handleAccounts(env)],
  '/admin/account/disable': [['POST'], handleDisable],
  '/admin/account/email': [['POST'], handleEmail],
  '/admin/account': [['DELETE'], handleDeleteAccount],
  '/admin/device': [['POST', 'DELETE'], handleAdminDevice],
  '/admin/upgrade-code': [['POST'], handleUpgradeCode],
};

// Returns null for a path that is not an admin route, so the router falls through to 404.
export async function handleAdminRoute(pathname, request, env) {
  const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : null;
  if (!route) return null;
  // Auth before method: an unauthenticated caller must not learn which methods exist.
  if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
  // Method before body: a bodiless GET gets a real 405, not a misleading bad_json.
  if (!route[0].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
  return route[1](request, env);
}
