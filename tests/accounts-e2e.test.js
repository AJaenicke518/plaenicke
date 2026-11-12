// accounts-e2e.test.js — end-to-end accounts convergence (spec § 9, §§ 6.7,
// 6.10, D16).
//
// WHAT IS REAL HERE, AND WHAT IS NOT. Every request goes through the Worker's
// own default export (worker/src/index.js) against a real node:sqlite D1
// (worker/tests/fake-d1.js) with every migration applied; every sync is the
// real js/sync.js syncOnce, with real AES-GCM and real PBKDF2 at the
// production 600,000 iterations; every link is js/linkui.js's real
// linkAndAdopt / paste field and its real preview, Merge dialog and adoption.
// tests/convergence.test.js drives merge.js directly — no CAS, no
// serialization, no crypto — so this file is the first to run the whole
// client path against the real handlers.
//
// NOT real: the network (fetchImpl calls worker.fetch in-process), the DOM
// (tests/fake-dom.js), and applyState. app.js is NOT imported: its
// module-scope `items` snapshot would be shared by both simulated devices and
// it arms real sync timers. applyState below mirrors app.js's
// applySyncedState write-for-write (merge against live storage with
// keepRemoteTombstones, saveItems, applyRemoteFeeds, saveTombstones) through
// the real storage.js / feeds.js owners.
//
// TWO DEVICES IN ONE PROCESS. Each device owns a FakeLocalStorage and a fake
// document, swapped onto globalThis by use(). Every module reads storage at
// call time — including the continuations of a linkui episode or a syncOnce
// still in flight — so use() refuses to swap while any tracked promise is
// pending, after first awaiting the current device's linkui settled().
// Every syncOnce here is awaited, directly or inside a settled() episode,
// so js/sync.js's module-scope queue is idle whenever use() swaps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { mintDevice } from '../worker/src/auth.js';
import { envWith, invite } from '../worker/tests/account-helpers.js';
import { FakeLocalStorage } from './fake-localstorage.js';
import { makeFakeDocument, makeFakeWindow, allText, findAll, fire } from './fake-dom.js';
import * as account from '../js/account.js';
import {
  initLinkUI, renderSyncStatus, signOutLocal, adoptionBlocker, accountModeFromStorage, ACCOUNT_COPY, SYNC_STATUS_ID,
} from '../js/linkui.js';
import { initAccountUI, refreshAccount } from '../js/accountui.js';
import { syncOnce, localState } from '../js/sync.js';
import { getLink, unlink } from '../js/auth.js';
import { composeForNewDevice, decryptBlob, parseLinkCode } from '../js/crypto.js';
import { merge } from '../js/merge.js';
import { applyEdit, nextStamp } from '../js/edit.js';
import { makeItem } from '../js/items.js';
import { applyRemoteFeeds } from '../js/feeds.js';
import {
  loadItems, saveItems, loadFeeds, saveFeeds, saveTombstones, loadSyncState, loadLocalOwner, saveLocalOwner, loadAuth,
} from '../js/storage.js';

const API = 'https://w.example';
const T0 = '2026-11-11T12:00:00.000Z';

// --- the server ------------------------------------------------------------

function world(extraEnv = {}) {
  const env = { ...envWith(), ...extraEnv };
  // Sweep W1-C1: POST /account/upgrade now requires a one-time upgradeCode
  // (minted by POST /admin/upgrade-code). js/account.js gains that field in
  // W3; until then this test-only shim mints one through the real admin route
  // and adds it to the upgrade body. Every other request passes through.
  const fetchImpl = async (u, o) => {
    if (new URL(u).pathname === '/account/upgrade' && o && typeof o.body === 'string') {
      const minted = await worker.fetch(new Request(`${API}/admin/upgrade-code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ADMIN_SECRET}` },
        body: JSON.stringify({ accountId: 1 }),
      }), env);
      if (minted.status === 200) {
        const { upgradeCode } = await minted.json();
        o = { ...o, body: JSON.stringify({ ...JSON.parse(o.body), upgradeCode }) };
      }
    }
    return worker.fetch(new Request(u, o), env);
  };
  const api = { fetchImpl, apiBase: API };
  const row = (id) => env.DB.prepare('SELECT version, blob FROM data WHERE id = ?').bind(id).first();
  const deviceCount = async (id) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ?').bind(id).first()).n;
  return { env, fetchImpl, api, row, deviceCount };
}

// account.js with the in-process Worker bound in — the shape accountui's
// `api` option takes.
function boundApi(w) {
  const names = ['signUp', 'logIn', 'recover', 'changePassword', 'newRecoveryLink', 'upgrade',
    'getAccount', 'listDevices', 'signOutOthers', 'confirmRecovery', 'logOut'];
  return Object.fromEntries(names.map((n) => [n, (args) => account[n]({ ...args, ...w.api })]));
}

// --- devices ---------------------------------------------------------------

const pending = new Set();
let current = null;

function track(p) {
  pending.add(p);
  const done = () => pending.delete(p);
  p.then(done, done);
  return p;
}

function device(name) {
  return { name, ls: new FakeLocalStorage(), doc: makeFakeDocument(), ui: null, host: null };
}

async function use(dev) {
  if (current && current.ui) await current.ui.settled();
  assert.equal(pending.size, 0, `swap to ${dev.name} with a linkui/sync promise still pending`);
  globalThis.localStorage = dev.ls;
  globalThis.document = dev.doc;
  current = dev;
}

// The TEST applyState: app.js's applySyncedState, write for write, without
// app.js (see the header).
function applyState(state, now) {
  const written = merge(localState(), state, now, { keepRemoteTombstones: true });
  saveItems(written.items);
  applyRemoteFeeds(written.feeds);
  saveTombstones(written.tombstones);
  return written;
}

function mountLinkUI(dev, w, extra = {}) {
  assert.equal(current, dev, 'mount on the device in use');
  const host = dev.doc.createElement('div');
  dev.doc.body.appendChild(host);
  dev.host = host;
  dev.ui = initLinkUI({
    host, applyState, fetchImpl: w.fetchImpl, readFetchImpl: w.fetchImpl, apiBase: API, ...extra,
  });
  return dev.ui;
}

function sync(dev, w) {
  assert.equal(current, dev, 'sync on the device in use');
  return track(syncOnce({ fetchImpl: w.fetchImpl, readFetchImpl: w.fetchImpl, now: () => new Date(), apiBase: API, applyState }));
}

function linkAndAdopt(dev, code, accountId) {
  assert.equal(current, dev);
  return track(dev.ui.linkAndAdopt(code, { accountId }));
}

function findButton(root, text) {
  return findAll(root, 'BUTTON').find((b) => (b.textContent || '').includes(text)) || null;
}

// A bounded poll, never a fixed wait: PBKDF2 and AES-GCM complete on the
// libuv thread pool, as macrotasks.
async function pollUntil(pred, what, ms = 20000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => { setTimeout(r, 0); });
  }
}

// The legacy paste field (Settings → Sync → Link this device / Re-link).
async function pasteLink(dev, code) {
  const input = findAll(dev.host, 'INPUT').find((i) => i.getAttribute('aria-label') === 'Link code');
  assert.ok(input, `${dev.name}: the paste field is rendered`);
  input.value = code;
  fire(findButton(dev.host, 'Link this device'), 'click');
  await track(dev.ui.settled());
}

async function clickMerge(dev) {
  const btn = findButton(dev.host, 'Merge');
  assert.ok(btn, `${dev.name}: the Merge dialog is offered`);
  fire(btn, 'click');
  await track(dev.ui.settled());
  await pollUntil(() => loadSyncState().adoptionPending === false, `${dev.name}: adoption to complete`);
}

// --- data ------------------------------------------------------------------

let seq = 0;
function newItem(title, date = '2026-11-20') {
  const t = new Date().toISOString();
  seq += 1;
  return makeItem({ title, date, type: 'task' }, { id: `e2e-${seq}`, createdAt: t, updatedAt: t });
}
const addLocal = (...items) => saveItems([...loadItems(), ...items]);
function editLocal(id, patch) {
  const items = loadItems();
  const i = items.findIndex((x) => x.id === id);
  assert.ok(i >= 0, `item ${id} is on this device`);
  items[i] = applyEdit(items[i], patch, nextStamp(new Date().toISOString(), items[i].updatedAt));
  saveItems(items);
  return items[i];
}
const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const ids = (list) => byId(list).map((x) => x.id);
const titleOf = (list, id) => (list.find((x) => x.id === id) || {}).title;

async function serverState(w, accountId, encKey) {
  const r = await w.row(accountId);
  return decryptBlob(encKey, r.blob);
}

const EMAIL = 'alex@example.com';
const PW = 'Tangerine#7orbit';
const PW2 = 'Glacier!9meadow';
const OTHER_EMAIL = 'tess@example.com';
const OTHER_PW = 'Copper+4lantern';

// =========================================================================

test('e2e 1: sign up on A, log in on B — both converge through real sync.js against real Worker handlers', async () => {
  const w = world();
  const A = device('A');
  const B = device('B');
  await invite(w.env, 'INVITE-A');

  await use(A);
  mountLinkUI(A, w);
  const up = await account.signUp({ invite: 'INVITE-A', email: EMAIL, password: PW, deviceName: 'A', ...w.api });
  assert.equal(await linkAndAdopt(A, up.code, up.accountId), 'linked');
  assert.equal(loadSyncState().adoptionPending, false, 'A bootstrapped the empty account');
  assert.equal(loadLocalOwner(), up.accountId);
  const dek = getLink().encKey;

  const first = newItem('dentist');
  addLocal(first);
  const cal = { id: 'feed-a', url: 'https://cal.example/a.ics', name: 'School', color: 'var(--feed-palette-1)', hidden: false, updatedAt: new Date().toISOString() };
  saveFeeds([cal]);
  const r1 = await sync(A, w);
  assert.equal(r1.status, 'ok');
  assert.equal(r1.pushed, true);
  const afterA = await w.row(up.accountId);
  assert.equal(afterA.version, 1, 'one PUT landed');
  const onServer = await serverState(w, up.accountId, dek);
  assert.deepEqual(ids(onServer.items), [first.id], 'the server holds A\'s item, decryptable with the DEK');

  await use(B);
  mountLinkUI(B, w);
  const li = await account.logIn({ email: EMAIL, password: PW, deviceName: 'B', ...w.api });
  assert.equal(li.accountId, up.accountId);
  assert.deepEqual(parseLinkCode(li.code).encKey, dek, 'login unwraps the same DEK');
  assert.notEqual(parseLinkCode(li.code).authToken, parseLinkCode(up.code).authToken, 'B has its own session');
  assert.equal(await linkAndAdopt(B, li.code, li.accountId), 'linked');
  assert.equal(loadSyncState().adoptionPending, false, 'an empty B adopts automatically');
  const r2 = await sync(B, w);
  assert.equal(r2.status, 'ok');
  assert.deepEqual(byId(loadItems()), [first], 'B shows A\'s item, record for record');
  assert.deepEqual(loadFeeds().map((f) => f.url), [cal.url], 'B shows A\'s calendar');

  const edited = editLocal(first.id, { title: 'dentist at 3' });
  const r3 = await sync(B, w);
  assert.equal(r3.status, 'ok');
  assert.equal(r3.pushed, true);
  const itemsB = loadItems();

  await use(A);
  const r4 = await sync(A, w);
  assert.equal(r4.status, 'ok');
  assert.equal(titleOf(loadItems(), first.id), 'dentist at 3', 'A shows B\'s edit');
  assert.deepEqual(byId(loadItems()), byId(itemsB), 'A and B hold identical items');
  assert.deepEqual(byId(loadItems()), [edited]);
  assert.deepEqual(byId((await serverState(w, up.accountId, dek)).items), [edited]);
});

test('e2e 2: legacy upgrade — B keeps syncing with no action, both converge, and the account-1 blob always decrypts with the original encKey', async () => {
  const w = world();
  const A = device('A');
  const B = device('B');

  // A: today's first-device link — an admin-minted 43-character token,
  // bootstrapped from the paste field.
  const tokA = await mintDevice(w.env, 1, 'A', T0);
  await use(A);
  mountLinkUI(A, w);
  const a1 = newItem('pay rent');
  const a2 = newItem('call mom');
  addLocal(a1, a2);
  await pasteLink(A, tokA);
  assert.equal(loadSyncState().adoptionPending, false, 'A bootstrapped account 1');
  assert.equal(loadLocalOwner(), null, 'a legacy link records no owner');
  const encKey = getLink().encKey;
  const codeA = loadAuth();
  assert.deepEqual(ids((await serverState(w, 1, encKey)).items), ids([a1, a2]));

  // B: today's second-device link — A composes the 86-character code.
  const tokB = await mintDevice(w.env, 1, 'B', T0);
  const codeForB = composeForNewDevice(tokB, getLink());
  await use(B);
  mountLinkUI(B, w);
  const b1 = newItem('water plants');
  addLocal(b1);
  await pasteLink(B, codeForB);
  await clickMerge(B);
  const codeB = loadAuth();
  assert.deepEqual(getLink().encKey, encKey);
  assert.deepEqual(ids(loadItems()), ids([a1, a2, b1]));

  await use(A);
  assert.equal((await sync(A, w)).status, 'ok');
  assert.deepEqual(ids(loadItems()), ids([a1, a2, b1]), 'both legacy devices synced with items');

  // A upgrades. accountui's ACTIONS.upgrade then records the owner; mirrored
  // here because accountui's form is not under test in this scenario.
  const before = await w.row(1);
  const up = await account.upgrade({ link: getLink(), email: EMAIL, password: PW, ...w.api });
  assert.equal(up.accountId, 1);
  saveLocalOwner(up.accountId);
  const after = await w.row(1);
  assert.equal(after.version, before.version, 'upgrade does not touch the data row');
  assert.equal(after.blob, before.blob, 'the blob is byte-identical');
  assert.equal(loadAuth(), codeA, 'same token, same key on A');

  // An edit on A after the upgrade, so B's next sync has something to pull.
  editLocal(a1.id, { title: 'pay rent today' });
  assert.equal((await sync(A, w)).status, 'ok');
  assert.equal(loadSyncState().adoptionPending, false);

  // B: no action at all — same credential, next ordinary sync.
  await use(B);
  assert.equal(loadAuth(), codeB, 'B\'s credential is untouched');
  const rb = await sync(B, w);
  assert.equal(rb.status, 'ok', 'B keeps syncing after the upgrade');
  assert.equal(loadSyncState().adoptionPending, false, 'adoption is not re-raised (§ 6.7 step 4)');
  assert.equal(loadSyncState().lastError, null);
  assert.equal(titleOf(loadItems(), a1.id), 'pay rent today', 'B pulled A\'s post-upgrade edit');
  editLocal(b1.id, { title: 'water plants twice' });
  assert.equal((await sync(B, w)).status, 'ok');
  // § 6.7 step 4: B learns its owner from GET /account.
  assert.equal(await refreshAccount({ api: boundApi(w) }), 'ok');
  assert.equal(loadLocalOwner(), 1);
  const itemsB = loadItems();

  await use(A);
  assert.equal((await sync(A, w)).status, 'ok');
  assert.deepEqual(byId(loadItems()), byId(itemsB), 'A and B converge');
  assert.equal(titleOf(loadItems(), a1.id), 'pay rent today');
  assert.equal(titleOf(loadItems(), b1.id), 'water plants twice');
  const final = await serverState(w, 1, encKey);
  assert.deepEqual(byId(final.items), byId(itemsB), 'the account-1 blob still decrypts with the original encKey');

  // D2: the encKey IS the DEK — a fresh login unwraps exactly it.
  const C = device('C');
  await use(C);
  const li = await account.logIn({ email: EMAIL, password: PW, deviceName: 'C', ...w.api });
  assert.equal(li.accountId, 1);
  assert.deepEqual(parseLinkCode(li.code).encKey, encKey);
});

test('e2e 3: recovery signs B out; B shows "signed out", signs back in with the new password, and nothing is lost on either side', async () => {
  const w = world();
  const A = device('A');
  const B = device('B');
  await invite(w.env, 'INVITE-R');

  await use(A);
  mountLinkUI(A, w);
  const up = await account.signUp({ invite: 'INVITE-R', email: EMAIL, password: PW, deviceName: 'A', ...w.api });
  const accountId = up.accountId;
  assert.equal(await linkAndAdopt(A, up.code, accountId), 'linked');
  const dek = getLink().encKey;
  const x = newItem('book flights');
  const y = newItem('renew passport');
  addLocal(x, y);
  assert.equal((await sync(A, w)).status, 'ok');

  await use(B);
  mountLinkUI(B, w);
  const liB = await account.logIn({ email: EMAIL, password: PW, deviceName: 'B', ...w.api });
  assert.equal(await linkAndAdopt(B, liB.code, accountId), 'linked');
  assert.equal((await sync(B, w)).status, 'ok');
  assert.deepEqual(ids(loadItems()), ids([x, y]));

  // A: forgot password. Production reaches it only signed out (D17), so A
  // signs out first (D27: revoke, then the local sign-out).
  await use(A);
  assert.deepEqual(await account.logOut({ link: getLink(), ...w.api }), { revoked: true });
  assert.equal(signOutLocal(), 'signed_out');
  const rec = await account.recover({
    email: EMAIL, recoveryCode: up.recoveryCode, newPassword: PW2, deviceName: 'A', ...w.api,
    onAccountKnown: (id) => { const b = adoptionBlocker(id); if (b) throw new Error(b); },
  });
  assert.equal(rec.accountId, accountId);
  assert.notEqual(rec.recoveryCode, up.recoveryCode, 'recovery is single-use: a new code');
  assert.equal(await w.deviceCount(accountId), 1, 'recovery left only the recovering device');
  assert.equal(await linkAndAdopt(A, rec.code, accountId), 'linked');
  await clickMerge(A);
  const z = newItem('pack bags');
  addLocal(z);
  assert.equal((await sync(A, w)).status, 'ok');

  // B: an unsynced local edit, then a sync on a deleted session.
  await use(B);
  const bEdit = editLocal(x.id, { title: 'book flights for June' });
  const versionBefore = (await w.row(accountId)).version;
  const r = await sync(B, w);
  assert.equal(r.status, 'unauthorized');
  assert.equal(r.applied, false, 'nothing was applied');
  assert.equal((await w.row(accountId)).version, versionBefore, 'nothing was pushed');
  assert.equal(loadSyncState().lastError, 'unauthorized');
  renderSyncStatus();
  const statusEl = B.doc.getElementById(SYNC_STATUS_ID);
  assert.ok(statusEl, 'B\'s linkui status line is mounted');
  assert.ok(statusEl.textContent.startsWith('This device was signed out. Sign in again.'),
    `B's rendered status: ${statusEl.textContent}`);
  assert.equal(ACCOUNT_COPY.signed_out, 'This device was signed out. Sign in again.');

  // Settings re-opened on B: account-mode copy and a Sign in button (§ 6.10).
  B.doc = makeFakeDocument();
  globalThis.document = B.doc;
  mountLinkUI(B, w, { onSignIn: () => signOutLocal() });
  assert.ok(allText(B.host).includes(ACCOUNT_COPY.signed_out));
  const signIn = findButton(B.host, 'Sign in');
  assert.ok(signIn, 'the panel offers Sign in');
  fire(signIn, 'click');
  await track(B.ui.settled());
  assert.equal(getLink(), null, 'Sign in signed this device out locally first');
  assert.equal(loadLocalOwner(), accountId, 'the owner tag is kept (D16)');
  assert.equal(titleOf(loadItems(), x.id), 'book flights for June', 'the unsynced edit is still on B');

  await assert.rejects(account.logIn({ email: EMAIL, password: PW, deviceName: 'B', ...w.api }),
    (e) => e.code === 'bad_credentials', 'the old password no longer works');
  const liB2 = await account.logIn({ email: EMAIL, password: PW2, deviceName: 'B', ...w.api });
  assert.deepEqual(parseLinkCode(liB2.code).encKey, dek, 'same DEK after recovery');
  assert.equal(await linkAndAdopt(B, liB2.code, accountId), 'linked');
  await clickMerge(B);
  const itemsB = loadItems();
  assert.deepEqual(ids(itemsB), ids([x, y, z]), 'B has A\'s post-recovery item');
  assert.deepEqual(itemsB.find((i) => i.id === x.id), bEdit, 'B\'s unsynced edit survived the merge');

  await use(A);
  assert.equal((await sync(A, w)).status, 'ok');
  assert.deepEqual(byId(loadItems()), byId(itemsB), 'A and B hold identical items');
  assert.equal(titleOf(loadItems(), x.id), 'book flights for June', 'A has B\'s edit');
  assert.deepEqual(byId((await serverState(w, accountId, dek)).items), byId(itemsB));
});

test('e2e 4: cross-account guard — account-1 device A, signed out, cannot log in to another account; that account is unchanged', async () => {
  const w = world();
  const A = device('A');
  const D = device('D');
  globalThis.window = makeFakeWindow();

  // A: legacy account 1 with items, upgraded (owner 1).
  const tokA = await mintDevice(w.env, 1, 'A', T0);
  await use(A);
  mountLinkUI(A, w);
  addLocal(newItem('pay rent'), newItem('call mom'));
  await pasteLink(A, tokA);
  const up = await account.upgrade({ link: getLink(), email: EMAIL, password: PW, ...w.api });
  saveLocalOwner(up.accountId);

  // D: someone else's account, with data on the server.
  await invite(w.env, 'INVITE-T');
  await use(D);
  mountLinkUI(D, w);
  const other = await account.signUp({ invite: 'INVITE-T', email: OTHER_EMAIL, password: OTHER_PW, deviceName: 'D', ...w.api });
  assert.notEqual(other.accountId, 1);
  assert.equal(await linkAndAdopt(D, other.code, other.accountId), 'linked');
  addLocal(newItem('tess thing'));
  assert.equal((await sync(D, w)).status, 'ok');
  const rowBefore = await w.row(other.accountId);
  assert.equal(rowBefore.version, 1, 'fixture check: the other account holds data');
  const devicesBefore = await w.deviceCount(other.accountId);

  // A signs out (D27), keeping its data and its owner tag.
  await use(A);
  assert.deepEqual(await account.logOut({ link: getLink(), ...w.api }), { revoked: true });
  assert.equal(signOutLocal(), 'signed_out');
  const itemsA = loadItems();
  assert.equal(itemsA.length, 2);

  // The real login form, the real account.js, the real Worker.
  const host = A.doc.createElement('div');
  A.doc.body.appendChild(host);
  initAccountUI({ host, api: boundApi(w), linkui: () => A.ui, setTimeoutImpl: () => {} });
  const byIdIn = (root, id) => {
    if (root.id === id) return root;
    for (const c of root.children) { const f = byIdIn(c, id); if (f) return f; }
    return null;
  };
  fire(byIdIn(host, 'acct-login'), 'click');
  for (const [id, v] of [['acct-email', OTHER_EMAIL], ['acct-password', OTHER_PW]]) {
    const el = byIdIn(host, id);
    el.value = v;
    fire(el, 'input');
  }
  const form = byIdIn(host, 'acct-form');
  const submitted = Promise.all((form._listeners.submit || []).map((fn) => fn({ target: form, preventDefault() {} })));
  await track(submitted);
  await pollUntil(() => (byIdIn(host, 'acct-error') || {}).textContent, 'the login error');

  assert.equal(byIdIn(host, 'acct-error').textContent, ACCOUNT_COPY.other_account_data);
  assert.equal(getLink(), null, 'A was not linked');
  assert.equal(loadLocalOwner(), 1, 'A still records account 1');
  assert.deepEqual(loadItems(), itemsA, 'A\'s planner is untouched');
  const rowAfter = await w.row(other.accountId);
  assert.equal(rowAfter.version, rowBefore.version, 'the other account\'s version is unchanged');
  assert.equal(rowAfter.blob, rowBefore.blob, 'the other account\'s blob bytes are unchanged');
  assert.equal(await w.deviceCount(other.accountId), devicesBefore, 'the session login minted was revoked');
});

test('e2e 5: smart add through worker.fetch — tolerant tokenless is 200, required tokenless is 401, and a session is capped per account', async () => {
  const claudeOk = () => new Response(JSON.stringify({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ items: [{ title: 'call mom', date: '2026-11-12', type: 'task' }], needsReview: false }) }],
    usage: { input_tokens: 900, output_tokens: 120 },
  }), { status: 200 });
  const original = globalThis.fetch;
  let anthropicCalls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    anthropicCalls += 1;
    return claudeOk();
  };
  const smart = (w, token) => w.fetchImpl(`${API}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ text: 'call mom tomorrow', today: '2026-11-11' }),
  });
  const usage = (w) => w.env.DB.prepare('SELECT account_id, calls FROM usage ORDER BY account_id').all().then((r) => r.results);
  try {
    const tolerant = world({ ANTHROPIC_API_KEY: 'k' });
    const res1 = await smart(tolerant, null);
    assert.equal(res1.status, 200);
    assert.equal((await res1.json()).items[0].title, 'call mom');
    assert.deepEqual(await usage(tolerant), [], 'a tokenless call is not billed to any account');

    const required = world({ ANTHROPIC_API_KEY: 'k', REQUIRE_SESSION: 'true' });
    const callsBefore = anthropicCalls;
    const res2 = await smart(required, null);
    assert.equal(res2.status, 401);
    assert.equal((await res2.json()).error, 'unauthorized');
    assert.equal(anthropicCalls, callsBefore, 'a refused call never reaches Anthropic');

    // A real session from a real sign-up is billed to its account, and capped.
    await invite(required.env, 'INVITE-S');
    const up = await account.signUp({ invite: 'INVITE-S', email: EMAIL, password: PW, deviceName: 'A', ...required.api });
    const { authToken } = parseLinkCode(up.code);
    const res3 = await smart(required, authToken);
    assert.equal(res3.status, 200);
    assert.deepEqual(await usage(required), [{ account_id: up.accountId, calls: 1 }]);
    await required.env.DB.prepare('UPDATE usage SET calls = 50 WHERE account_id = ?').bind(up.accountId).run();
    const before51 = anthropicCalls;
    const res4 = await smart(required, authToken);
    assert.equal(res4.status, 429);
    assert.equal((await res4.json()).error, 'daily_limit');
    assert.equal(anthropicCalls, before51, 'the capped call never reaches Anthropic');
  } finally {
    globalThis.fetch = original;
  }
});

// Sweep W2-C2 (reproduced first by the data-integrity review, scen/s3b.mjs):
// D holds account X and an ordinary sync is reading when D signs out and
// signs in to account Y. The old sync used to finish after the switch —
// apply X's records on D, push with X's credential — and Y's adoption then
// merged X's private item into Y.
test('e2e 6: a sync in flight across a sign-out and a sign-in to another account carries nothing into the new account', async () => {
  const w = world();
  const A = device('A');
  const D = device('D');
  const E = device('E');
  await invite(w.env, 'INVITE-X');
  await invite(w.env, 'INVITE-Y');

  // Reads of /data with one chosen token can be held open.
  let holdToken = null;
  const gates = [];
  const holding = {
    fetchImpl: async (u, o = {}) => {
      const isRead = String(u).endsWith('/data') && (o.method || 'GET') === 'GET';
      if (holdToken && isRead && o.headers && o.headers.authorization === `Bearer ${holdToken}`) {
        const res = await w.fetchImpl(u, o);
        await new Promise((r) => gates.push(r));
        return res;
      }
      return w.fetchImpl(u, o);
    },
  };

  await use(A);
  mountLinkUI(A, w);
  const upX = await account.signUp({ invite: 'INVITE-X', email: EMAIL, password: PW, deviceName: 'A', ...w.api });
  assert.equal(await linkAndAdopt(A, upX.code, upX.accountId), 'linked');

  await use(D);
  mountLinkUI(D, holding);
  const lx = await account.logIn({ email: EMAIL, password: PW, deviceName: 'D', ...w.api });
  assert.equal(await linkAndAdopt(D, lx.code, lx.accountId), 'linked');

  await use(A);
  const secret = newItem('X private item');
  addLocal(secret);
  assert.equal((await sync(A, w)).status, 'ok');
  const xRow = await w.row(upX.accountId);

  await use(E);
  mountLinkUI(E, w);
  addLocal(newItem('Y own task'));
  const upY = await account.signUp({ invite: 'INVITE-Y', email: OTHER_EMAIL, password: OTHER_PW, deviceName: 'E', ...w.api });
  assert.equal(await linkAndAdopt(E, upY.code, upY.accountId), 'linked');
  const yItemsBefore = ids((await serverState(w, upY.accountId, getLink().encKey)).items);

  await use(D);
  holdToken = getLink().authToken;
  const ordinary = sync(D, holding);
  try {
    await pollUntil(() => gates.length === 1, 'D\'s ordinary sync to read X');
    // In this tab, sign-out waits for the sync (W2-C2's second half).
    assert.equal(signOutLocal(), 'refused_write_in_flight');
    assert.ok(getLink(), 'fixture check: still linked to X');
    // Another tab signs out (it does not share this tab's signOutBlocked),
    // and this tab signs in to Y while X's sync is still reading.
    unlink();
    const ly = await account.logIn({ email: OTHER_EMAIL, password: OTHER_PW, deviceName: 'D', ...w.api });
    assert.equal(adoptionBlocker(ly.accountId), null, 'fixture check: D holds no planner, so Y is allowed');
    const adoption = linkAndAdopt(D, ly.code, ly.accountId);
    await pollUntil(() => getLink() && getLink().authToken !== holdToken, 'D to hold Y\'s credential');
    gates.shift()();
    const res = await ordinary;
    assert.equal(res.status, 'skipped', 'X\'s sync saw the link change and stopped');
    assert.equal(res.applied, false);
    assert.equal(await adoption, 'linked');
  } finally {
    holdToken = null;
    for (const g of gates) g();
  }
  await pollUntil(() => loadSyncState().adoptionPending === false, 'D\'s adoption into Y to finish');

  assert.ok(!ids(loadItems()).includes(secret.id), 'X\'s item was never applied on D');
  const yState = await serverState(w, upY.accountId, getLink().encKey);
  assert.ok(!ids(yState.items).includes(secret.id), 'X\'s private item is not in Y\'s account');
  assert.deepEqual(ids(yState.items), yItemsBefore, 'Y\'s account holds exactly its own items');
  const xAfter = await w.row(upX.accountId);
  assert.equal(xAfter.version, xRow.version, 'nothing was pushed to X with the old credential');
  assert.equal(loadLocalOwner(), upY.accountId);
});

// The real login form on `dev`, submitted with these credentials. Resolves
// with the form's host once its error line or the home view has settled.
function elById(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) { const f = elById(c, id); if (f) return f; }
  return null;
}
async function loginViaForm(dev, w, email, password) {
  const host = dev.doc.createElement('div');
  dev.doc.body.appendChild(host);
  initAccountUI({ host, api: boundApi(w), linkui: () => dev.ui, setTimeoutImpl: () => {} });
  fire(elById(host, 'acct-login'), 'click');
  for (const [id, v] of [['acct-email', email], ['acct-password', password]]) {
    const el = elById(host, id);
    el.value = v;
    fire(el, 'input');
  }
  const form = elById(host, 'acct-form');
  await track(Promise.all((form._listeners.submit || []).map((fn) => fn({ target: form, preventDefault() {} }))));
  return host;
}

// Sweep W2-C1 (reproduced first by the data-integrity review, scen/s1b.mjs):
// a legacy account-1 device, linked from the paste field and never
// upgraded, recorded no owner. Unlinked, it then let the next account to
// sign in adopt Alex's planner — the feed capability URL included.
test('e2e 7: an unlinked legacy account-1 device holding data cannot be signed in to another account', async () => {
  const w = world();
  const L = device('L');
  const T = device('T');
  const prevWindow = globalThis.window;
  globalThis.window = makeFakeWindow();
  try {
    const feedUrl = 'https://p01-calendars.icloud.com/SECRET';
    const tokL = await mintDevice(w.env, 1, 'L', T0);
    await use(L);
    mountLinkUI(L, w);
    addLocal(newItem('Alex private appointment'));
    saveFeeds([{ id: 'f1', url: feedUrl, name: 'Alex', color: 'var(--feed-palette-1)', hidden: false, updatedAt: T0 }]);
    await pasteLink(L, tokL);
    assert.equal(loadSyncState().adoptionPending, false, 'fixture check: L bootstrapped account 1');
    // App load on a linked device asks GET /account.
    assert.equal(await refreshAccount({ api: boundApi(w) }), 'ok');
    assert.equal(loadLocalOwner(), 1, 'the planner here is recorded as account 1\'s');
    assert.equal(accountModeFromStorage(), 'legacy', 'and the device keeps the legacy UI');
    unlink(); // linkui's legacy Unlink (doUnlink) is unlink() plus a render

    await invite(w.env, 'INVITE-T');
    await use(T);
    mountLinkUI(T, w);
    const upT = await account.signUp({ invite: 'INVITE-T', email: OTHER_EMAIL, password: OTHER_PW, deviceName: 'T', ...w.api });
    assert.equal(await linkAndAdopt(T, upT.code, upT.accountId), 'linked');
    const rowBefore = await w.row(upT.accountId);
    const devicesBefore = await w.deviceCount(upT.accountId);

    await use(L);
    const itemsL = loadItems();
    const host = await loginViaForm(L, w, OTHER_EMAIL, OTHER_PW);
    await pollUntil(() => (elById(host, 'acct-error') || {}).textContent, 'the login error');
    assert.equal(elById(host, 'acct-error').textContent, ACCOUNT_COPY.other_account_data);
    assert.equal(getLink(), null, 'L was not linked');
    assert.equal(loadLocalOwner(), 1);
    assert.deepEqual(loadItems(), itemsL);
    const rowAfter = await w.row(upT.accountId);
    assert.equal(rowAfter.version, rowBefore.version, 'the tester\'s account is unchanged');
    assert.equal(rowAfter.blob, rowBefore.blob);
    assert.equal(await w.deviceCount(upT.accountId), devicesBefore, 'the session the login minted was revoked');
  } finally {
    globalThis.window = prevWindow;
  }
});

// The other half of W2-C1: recording owner 1 on a legacy device must not
// take away its legacy re-link (spec § 6.11: legacy devices keep today's UI
// until upgraded). Unlinked, it still offers the paste field; a code for
// account 1 links — checked against GET /account before anything is
// previewed or adopted — and a code for any other account is refused.
test('e2e 8: an unlinked legacy-owned device re-links with an account-1 code, and refuses another account\'s code', async () => {
  const w = world();
  const A = device('A');
  const L = device('L');
  const T = device('T');

  // A: account 1's first device (bootstrap), with an item on the server.
  const tokA = await mintDevice(w.env, 1, 'A', T0);
  await use(A);
  mountLinkUI(A, w);
  const a1 = newItem('pay rent');
  addLocal(a1);
  await pasteLink(A, tokA);
  const encKey1 = getLink().encKey;

  // T: a tester account with data, and a code for it.
  await invite(w.env, 'INVITE-T');
  await use(T);
  mountLinkUI(T, w);
  const upT = await account.signUp({ invite: 'INVITE-T', email: OTHER_EMAIL, password: OTHER_PW, deviceName: 'T', ...w.api });
  assert.equal(await linkAndAdopt(T, upT.code, upT.accountId), 'linked');
  addLocal(newItem('tess thing'));
  assert.equal((await sync(T, w)).status, 'ok');
  const codeForT = composeForNewDevice(await mintDevice(w.env, upT.accountId, 'L', T0), getLink());
  const tRow = await w.row(upT.accountId);

  // L: a legacy account-1 device, checked (owner 1), then unlinked.
  await use(A);
  const codeL1 = composeForNewDevice(await mintDevice(w.env, 1, 'L', T0), getLink());
  const codeL2 = composeForNewDevice(await mintDevice(w.env, 1, 'L2', T0), getLink());
  await use(L);
  mountLinkUI(L, w);
  const l1 = newItem('water plants');
  addLocal(l1);
  await pasteLink(L, codeL1);
  await clickMerge(L);
  assert.equal(await refreshAccount({ api: boundApi(w) }), 'ok');
  assert.equal(loadLocalOwner(), 1);
  unlink();
  L.doc = makeFakeDocument();
  globalThis.document = L.doc;
  mountLinkUI(L, w);
  assert.ok(findAll(L.host, 'INPUT').some((i) => i.getAttribute('aria-label') === 'Link code'),
    'the legacy paste field is still offered');

  // Another account's code: refused, nothing linked, that account untouched.
  await pasteLink(L, codeForT);
  assert.equal(getLink(), null, 'not linked to the tester\'s account');
  assert.ok(allText(L.host).includes(ACCOUNT_COPY.other_account_data), allText(L.host));
  assert.equal(loadLocalOwner(), 1);
  assert.deepEqual(ids(loadItems()), ids([a1, l1]));
  const tAfter = await w.row(upT.accountId);
  assert.equal(tAfter.version, tRow.version);
  assert.equal(tAfter.blob, tRow.blob);

  // An account-1 code: links and adopts as today.
  await pasteLink(L, codeL2);
  assert.ok(getLink(), 'linked');
  assert.deepEqual(getLink().encKey, encKey1);
  if (findButton(L.host, 'Merge')) await clickMerge(L);
  await pollUntil(() => loadSyncState().adoptionPending === false, 'L to adopt');
  assert.equal(accountModeFromStorage(), 'legacy');
  assert.deepEqual(ids((await serverState(w, 1, encKey1)).items), ids([a1, l1]));
});
