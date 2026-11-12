import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeD1 } from './fake-d1.js';
import { sha256Hex } from '../src/auth.js';

export const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export const KEY_B = 'HB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs';
export const b64u = (n, fill) => Buffer.alloc(n, fill).toString('base64url');
export const b64 = (n, fill) => Buffer.alloc(n, fill).toString('base64');
// envWith({ yieldPerStatement: true }) for every concurrency test (see fake-d1.js).
export function envWith(d1 = {}) { return { DB: makeD1(d1), AT_REST_KEY: KEY, ADMIN_SECRET: 'adm' }; }
export async function invite(env, code = 'INVITE-1') {
  await env.DB.prepare('INSERT INTO invites (hash, created_at) VALUES (?, ?)').bind(await sha256Hex(code), 't').run();
  return code;
}
export function body(over = {}) {
  return { invite: 'INVITE-1', email: 'Tester@Example.com', kdfSalt: b64u(16, 1), kdfIters: 600000,
    authKey: b64u(32, 2), recAuthKey: b64u(32, 3), wrappedDekPw: b64(60, 4), wrappedDekRec: b64(60, 5),
    dekCheck: 'a'.repeat(64), deviceName: 'iPhone', ...over };
}
export const post = (env, path, json, token) => worker.fetch(new Request(`https://w${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(json) }), env);
export const get = (env, path, token) => worker.fetch(new Request(`https://w${path}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {} }), env);
export const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const count = async (env, table) => (await one(env, `SELECT COUNT(*) AS n FROM ${table}`)).n;
export const login = (env, over = {}) => post(env, '/auth/login', { email: 'tester@example.com', authKey: b64u(32, 2), deviceName: 'Mac', ...over });
export async function signedUp(env = envWith()) {
  await invite(env);
  const res = await post(env, '/auth/signup', body());
  assert.equal(res.status, 200);
  return { env, ...(await res.json()) };
}
export const T0 = '2026-11-11T12:00:00.000Z';

