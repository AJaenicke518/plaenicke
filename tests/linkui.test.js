import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import {
  describeSyncStatus, classifyPastedCode, chooseAdoption, renderSyncStatus,
  initLinkUI, SYNC_STATUS_ID,
} from '../js/linkui.js';
import { linkWithCode, clearAdoptionPending, isLinked } from '../js/auth.js';
import {
  bytesToBase64url, generateEncKey, composeLinkCode, encryptBlob, parseLinkCode,
} from '../js/crypto.js';
import {
  saveItems, saveFeeds, saveAuth, loadItems, loadFeeds, loadSyncState, saveSyncState,
} from '../js/storage.js';
import { SCHEMA_VERSION, toWire } from '../js/merge.js';

// --- minimal fake DOM ------------------------------------------------------
//
// Modeled on tests/settings.test.js's fake (Task 6) with ONE deliberate
// difference: getElementById WALKS THE TREE and returns null for an id that
// is not mounted. The repo's existing fakes (tests/apply.test.js:170,
// tests/settings.test.js) lazily create an element for any id and never
// return null, which makes "renderSyncStatus is safe when the host is
// absent" a vacuous assertion — an implementation doing
// `document.getElementById('sync-status').textContent = …` passes under
// those fakes and throws in a real browser.

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.id = '';
    this._classes = new Set();
    this._listeners = {};
    this._attrs = {};
    this.style = { setProperty(name, val) { this[name] = val; } };
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.textContent = '';
  }

  get className() { return [...this._classes].join(' '); }

  set className(v) { this._classes = new Set(String(v).split(' ').filter(Boolean)); }

  get classList() {
    const self = this;
    return {
      add(c) { self._classes.add(c); },
      remove(c) { self._classes.delete(c); },
      contains(c) { return self._classes.has(c); },
    };
  }

  setAttribute(name, val) { this._attrs[name] = val; }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
  }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

  get innerHTML() { return ''; }

  set innerHTML(v) { if (v === '') { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } }

  get childElementCount() { return this.children.length; }

  click() { (this._listeners.click || []).forEach((fn) => fn({ target: this })); }
}

function makeFakeDocument() {
  const body = new FakeElement('body');
  const walk = (el, pred) => {
    for (const c of el.children) {
      if (pred(c)) return c;
      const found = walk(c, pred);
      if (found) return found;
    }
    return null;
  };
  return {
    body,
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    // Real semantics: an element that is not in the document is not found.
    getElementById(id) { return walk(body, (el) => el.id === id); },
    addEventListener() {},
    removeEventListener() {},
  };
}

function installDom() {
  globalThis.document = makeFakeDocument();
  return globalThis.document;
}

function allText(el) {
  let out = el.textContent || '';
  for (const c of el.children) out += ` ${allText(c)}`;
  return out;
}

// Everything a screen reader or a devtools inspector can see EXCEPT the value
// of an input — i.e. every place a link code must never appear.
function allNonValueStrings(el) {
  let out = `${el.textContent || ''} ${el.id || ''} ${el.className || ''}`;
  for (const v of Object.values(el._attrs)) out += ` ${v}`;
  if (el.title) out += ` ${el.title}`;
  for (const c of el.children) out += ` ${allNonValueStrings(c)}`;
  return out;
}

function findAll(el, tag) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children) {
      if (c.tagName === tag) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

function findButton(el, text) {
  return findAll(el, 'BUTTON').find((b) => (b.textContent || '').includes(text)) || null;
}

function findInput(el, ariaLabel) {
  return findAll(el, 'INPUT').find((i) => i.getAttribute('aria-label') === ariaLabel) || null;
}

function fire(el, type) {
  (el._listeners[type] || []).forEach((fn) => fn({ target: el }));
}

// --- fixtures --------------------------------------------------------------

const NOW = new Date('2026-08-05T12:00:00.000Z');
// The linked device's encKey, so a fetchImpl closure can encrypt a fake
// account blob that THIS device can actually read.
let currentKey = null;
const syncState = (o = {}) => ({
  version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false, ...o,
});
const st = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });
const it = (id) => ({ id, title: `t-${id}`, date: '2026-08-05', time: null, updatedAt: '2026-08-01T00:00:00.000Z' });
const fd = (id) => ({
  id, url: `https://cal.example/${id}.ics`, name: id, color: 'var(--feed-palette-1)', hidden: false,
  updatedAt: '2026-08-01T00:00:00.000Z',
});

// =========================================================================
// describeSyncStatus
// =========================================================================

test('describeSyncStatus reports never-synced, just-synced, minutes and hours distinctly', () => {
  const never = describeSyncStatus(syncState(), NOW);
  assert.match(never, /nothing has synced yet/i);
  assert.match(describeSyncStatus(syncState({ lastSyncedAt: '2026-08-05T11:59:30.000Z' }), NOW), /just now/i);
  assert.match(describeSyncStatus(syncState({ lastSyncedAt: '2026-08-05T11:59:00.000Z' }), NOW), /1 minute ago/);
  assert.match(describeSyncStatus(syncState({ lastSyncedAt: '2026-08-05T11:55:00.000Z' }), NOW), /5 minutes ago/);
  assert.match(describeSyncStatus(syncState({ lastSyncedAt: '2026-08-05T09:00:00.000Z' }), NOW), /3 hours ago/);
  assert.match(describeSyncStatus(syncState({ lastSyncedAt: '2026-08-01T12:00:00.000Z' }), NOW), /4 days ago/);
});

test('describeSyncStatus surfaces lastError alongside the last successful sync', () => {
  const s = describeSyncStatus(syncState({ lastError: 'offline', lastSyncedAt: '2026-08-05T11:00:00.000Z' }), NOW);
  assert.match(s, /problem/i);
  assert.match(s, /1 hour ago/);
  const noPrior = describeSyncStatus(syncState({ lastError: 'unauthorized' }), NOW);
  assert.match(noPrior, /problem/i);
  assert.doesNotMatch(noPrior, /ago/);
});

// The adoption gate means a device that links while offline sits at
// adoptionPending: true and syncs NOTHING until the user completes the
// dialog. The failure mode is "silently does nothing", and this string is the
// only thing standing between the user and an app they believe is syncing.
test('describeSyncStatus reports a pending adoption distinctly from never having synced', () => {
  const pending = describeSyncStatus(syncState({ adoptionPending: true }), NOW);
  const never = describeSyncStatus(syncState(), NOW);
  assert.notEqual(pending, never);
  assert.match(pending, /choose/i);
  assert.doesNotMatch(pending, /nothing has synced yet/i);
});

// DA-I1: linking while offline sets BOTH — js/sync.js:96 records lastError
// and does not lower the gate. If lastError won, the load-bearing signal
// would be hidden behind an offline banner precisely when it matters.
test('a pending adoption outranks lastError, the exact pair that linking while offline produces', () => {
  const both = describeSyncStatus(syncState({ adoptionPending: true, lastError: 'offline' }), NOW);
  assert.equal(both, describeSyncStatus(syncState({ adoptionPending: true }), NOW));
  assert.match(both, /choose/i);
});

// =========================================================================
// classifyPastedCode
// =========================================================================

test('classifyPastedCode decodes rather than counting characters', () => {
  const token = bytesToBase64url(generateEncKey());
  const code = composeLinkCode(token, generateEncKey());
  assert.equal(token.length, 43, 'fixture check: a 32-byte token is 43 base64url characters');
  assert.equal(code.length, 86, 'fixture check: a 64-byte link code is 86 base64url characters');
  assert.equal(classifyPastedCode(code), 'linkcode');
  assert.equal(classifyPastedCode(token), 'token');
  assert.equal(classifyPastedCode(`  ${code}\n`), 'linkcode');
  assert.equal(classifyPastedCode(` ${token} `), 'token');
  assert.equal(classifyPastedCode('not a code'), 'invalid');
  assert.equal(classifyPastedCode('   '), 'invalid');
  assert.equal(classifyPastedCode(''), 'invalid');
  assert.equal(classifyPastedCode(null), 'invalid');
});

// DA-I3: linkWithCode branches on base64urlToBytes(trimmed).length
// (js/auth.js:45), so a CHARACTER COUNT disagrees with it on valid-length,
// invalid-alphabet input. The UI would show the "creates a NEW account"
// warning, the user would confirm, and base64urlToBytes would throw out of
// linkWithCode with the dialog already committed.
test('a 43-character string that is not valid base64url classifies invalid, not token', () => {
  const plus = `+${'A'.repeat(42)}`;
  const slash = `${'A'.repeat(42)}/`;
  assert.equal(plus.length, 43);
  assert.equal(slash.length, 43);
  assert.equal(classifyPastedCode(plus), 'invalid');
  assert.equal(classifyPastedCode(slash), 'invalid');
  // And the same for a full-length code in the standard (non-url) alphabet.
  assert.equal(classifyPastedCode(`+${'A'.repeat(85)}`), 'invalid');
});

// =========================================================================
// chooseAdoption
// =========================================================================

test('chooseAdoption asks when both the device and the account hold data', () => {
  assert.equal(chooseAdoption(st({ items: [it('l')] }), st({ items: [it('r')] })), 'ask');
  assert.equal(chooseAdoption(st({ feeds: [fd('l')] }), st({ feeds: [fd('r')] })), 'ask');
});

test('chooseAdoption adopts automatically when the device is empty', () => {
  assert.equal(chooseAdoption(st(), st({ items: [it('r')] })), 'auto');
  assert.equal(chooseAdoption(st(), st({ feeds: [fd('r')] })), 'auto');
});

test('chooseAdoption treats an empty account as a bootstrap, even with data on the device', () => {
  assert.equal(chooseAdoption(st({ items: [it('l')] }), null), 'none');
  assert.equal(chooseAdoption(st({ items: [it('l')] }), st()), 'none');
});

// The plan previously gave two answers for this case.
test('chooseAdoption resolves both-empty to none, not auto', () => {
  assert.equal(chooseAdoption(st(), st()), 'none');
  assert.equal(chooseAdoption(st(), null), 'none');
});

// DA-C2. previewRemote returns state: null ONLY when the response carries no
// blob at all; an account whose records were all deleted returns a NON-NULL
// {schemaVersion, items: [], feeds: [], tombstones: [...]}. Reading emptiness
// as `state === null` classifies that account as "has data", offers Replace
// this device, and wipes every local item and every feed URL — unrecoverably,
// since js/settings.js never re-displays a feed URL.
test('an account holding only tombstones is EMPTY and is never offered for Replace', () => {
  const remote = st({ tombstones: [{ id: 'gone', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }] });
  assert.equal(chooseAdoption(st({ items: [it('l')] }), remote), 'none');
  assert.equal(chooseAdoption(st({ feeds: [fd('l')] }), remote), 'none');
  assert.equal(chooseAdoption(st(), remote), 'none');
});

test('chooseAdoption never counts tombstones on the local side either', () => {
  const local = st({ tombstones: [{ id: 'gone', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }] });
  assert.equal(chooseAdoption(local, st({ items: [it('r')] })), 'auto');
});

// =========================================================================
// renderSyncStatus
// =========================================================================

test('renderSyncStatus does not throw when the status element is not mounted', () => {
  installFakeLocalStorage();
  const doc = installDom();
  assert.equal(doc.getElementById(SYNC_STATUS_ID), null,
    'the fake document must return null for an unmounted id, or the assertion below is vacuous');
  assert.doesNotThrow(() => renderSyncStatus(NOW));
});

test('renderSyncStatus paints the mounted status element', () => {
  installFakeLocalStorage();
  const doc = installDom();
  saveAuth(composeLinkCode(bytesToBase64url(generateEncKey()), generateEncKey()));
  saveSyncState({ lastSyncedAt: '2026-08-05T11:55:00.000Z', adoptionPending: false });
  const el = doc.createElement('div');
  el.id = SYNC_STATUS_ID;
  doc.body.appendChild(el);
  renderSyncStatus(NOW);
  assert.match(el.textContent, /5 minutes ago/);
});

// DA-I2. getLink() returns null for an unparseable code (js/auth.js:30), so
// isLinked() reads false while a credential IS stored: runSync returns before
// its try/finally and plaenicke.syncState keeps showing the last good
// lastSyncedAt — a permanently frozen "synced N minutes ago" on an app that
// will never sync again. describeSyncStatus cannot express this, because the
// discriminator is not in syncState.
test('renderSyncStatus renders a corrupt stored code as its own state, not a frozen last-synced', () => {
  installFakeLocalStorage();
  const doc = installDom();
  saveAuth('!!! not a link code !!!');
  saveSyncState({ lastSyncedAt: '2026-08-05T11:55:00.000Z', adoptionPending: false });
  assert.equal(isLinked(), false, 'fixture check: a corrupt code reads as unlinked');
  const el = doc.createElement('div');
  el.id = SYNC_STATUS_ID;
  doc.body.appendChild(el);
  renderSyncStatus(NOW);
  assert.match(el.textContent, /unreadable/i);
  assert.doesNotMatch(el.textContent, /5 minutes ago/,
    'a frozen "synced N minutes ago" on a device that will never sync again is the exact failure this state exists to replace');
});

// =========================================================================
// initLinkUI
// =========================================================================

async function setup(o = {}) {
  installFakeLocalStorage();
  const doc = installDom();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  currentKey = link.encKey;
  if (o.seed) o.seed(link);
  if (o.clearGate) clearAdoptionPending();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const syncCalls = [];
  const syncResults = o.syncResults || [];
  const fetchCalls = [];
  const linkedCalls = o.linkedCalls || [];
  const unlinkedCalls = o.unlinkedCalls || [];
  const ui = initLinkUI({
    host,
    applyState: o.applyState || ((s) => s),
    onLinked: () => linkedCalls.push(true),
    onUnlinked: () => unlinkedCalls.push(true),
    fetchImpl: async (url, opts) => {
      fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
      if (!o.fetchImpl) throw new Error('no network call was expected here');
      return o.fetchImpl(url, opts);
    },
    apiBase: 'https://w.example',
    now: () => NOW,
    syncOnceImpl: async (deps) => {
      syncCalls.push(deps);
      return syncResults.length ? syncResults.shift() : { status: 'ok', pushed: false };
    },
  });
  await ui.settled();
  return { ui, host, doc, link, syncCalls, fetchCalls, linkedCalls, unlinkedCalls };
}

// DA-C3. previewRemote can return offline, unauthorized, error,
// undecryptable or skipped — each with NO `state` key at all. Treating an
// absent state as "empty server" runs a silent merge on all five.
test('each failing preview status gets its own message and adopts nothing', async () => {
  const messages = new Map();

  const offline = await setup({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(offline.syncCalls.length, 0, 'offline must not adopt');
  messages.set('offline', allText(offline.host));

  const unauthorized = await setup({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.equal(unauthorized.syncCalls.length, 0, 'unauthorized must not adopt');
  messages.set('unauthorized', allText(unauthorized.host));

  const serverError = await setup({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(serverError.syncCalls.length, 0, 'a server error must not adopt');
  messages.set('error', allText(serverError.host));

  // The signature of pasting a bare 43-character token on a SECOND device:
  // linkWithCode bootstraps a fresh encKey (js/auth.js:47), producing a
  // device that can never read the account.
  const undecryptable = await setup({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 2, blob: await encryptBlob(generateEncKey(), st({ items: [it('r')] })) }),
    }),
  });
  assert.equal(undecryptable.syncCalls.length, 0, 'an unreadable account must not adopt');
  messages.set('undecryptable', allText(undecryptable.host));

  assert.equal(new Set(messages.values()).size, 4,
    'each status must produce its own message — a shared one hides which failure actually happened');
  assert.match(messages.get('offline'), /could not reach/i);
  assert.match(messages.get('unauthorized'), /rejected/i);
  assert.match(messages.get('error'), /server/i);
  assert.match(messages.get('undecryptable'), /86-character/);
  assert.match(messages.get('undecryptable'), /cannot read/i);
});

test('an offline preview offers a retry — the gate stays raised and there is otherwise no way out', async () => {
  let attempt = 0;
  const { host, ui, syncCalls } = await setup({
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) };
    },
  });
  assert.equal(loadSyncState().adoptionPending, true, 'a failed preview must leave the gate raised');
  const retry = findButton(host, 'Try again');
  assert.ok(retry, 'an offline preview must offer a retry control');
  retry.click();
  await ui.settled();
  assert.equal(syncCalls.length, 1, 'the retry must reach the adoption path');
});

// DA-C1. js/sync.js:118 runs dedupeState on exactly 'adopt-merge', and
// js/merge.js writes a tombstone per dropped id which is then PUSHED. On a
// first-device bootstrap that collapses two legitimately distinct
// same-title/date/time records, permanently, and destroys one of two feeds
// whose URLs differ only in a trailing slash. Spec 5.7 step 2: an empty
// server means local uploads AS-IS.
test("an empty account bootstraps with 'adopt-bootstrap', never 'adopt-merge'", async () => {
  const { syncCalls } = await setup({
    seed: () => { saveItems([it('local')]); saveFeeds([fd('localfeed')]); },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) }),
  });
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].adoptChoice, 'adopt-bootstrap');
});

test("an account with data and an empty device adopts with 'adopt-bootstrap', never 'adopt-merge'", async () => {
  const { syncCalls } = await setup({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 7, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
    }),
  });
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].adoptChoice, 'adopt-bootstrap');
  assert.equal(syncCalls[0].expectVersion, 7, 'the version previewed must be pinned against the write');
});

test('a device and an account that both hold data present Merge, Replace and Cancel and adopt nothing yet', async () => {
  const { host, syncCalls } = await setup({
    seed: () => { saveItems([it('local')]); },
    fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ version: 4, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
    }),
  });
  assert.equal(syncCalls.length, 0, 'nothing may be applied or pushed before the user chooses');
  assert.ok(findButton(host, 'Merge'), 'Merge must be offered');
  assert.ok(findButton(host, 'Replace this device'), 'Replace this device must be offered');
  assert.ok(findButton(host, 'Cancel'), 'Cancel must be offered');
});

test('Merge and Replace pass their own adoptChoice, pinned to the previewed version', async () => {
  for (const [label, expected] of [['Merge', 'adopt-merge'], ['Replace this device', 'adopt-replace']]) {
    const { host, ui, syncCalls } = await setup({
      seed: () => { saveItems([it('local')]); },
      fetchImpl: async () => ({
        ok: true, status: 200, json: async () => ({ version: 4, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
      }),
    });
    findButton(host, label).click();
    await ui.settled();
    assert.equal(syncCalls.length, 1, `${label} must adopt exactly once`);
    assert.equal(syncCalls[0].adoptChoice, expected);
    assert.equal(syncCalls[0].expectVersion, 4);
  }
});

test('Cancel adopts nothing and leaves the adoption gate raised', async () => {
  const { host, ui, syncCalls } = await setup({
    seed: () => { saveItems([it('local')]); },
    fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ version: 4, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
    }),
  });
  findButton(host, 'Cancel').click();
  await ui.settled();
  assert.equal(syncCalls.length, 0);
  assert.equal(loadSyncState().adoptionPending, true, 'Cancel must leave the gate raised — nothing syncs until the user chooses');
  assert.deepEqual(loadItems().map((i) => i.id), ['local'], 'Cancel must not touch local data');
});

// DA-I5. The account can empty between previewRemote and syncOnce, and a user
// who clicked Replace against data they SAW would get a silent full local
// wipe with no re-confirmation. syncOnce hands the decision back rather than
// acting on a stale choice.
test('a version that moved between the preview and the write re-asks instead of acting on a stale choice', async () => {
  let pull = 0;
  const { host, ui, syncCalls } = await setup({
    seed: () => { saveItems([it('local')]); },
    syncResults: [{ status: 'changed', version: 9 }],
    fetchImpl: async () => {
      pull += 1;
      const version = pull === 1 ? 4 : 9;
      return { ok: true, status: 200, json: async () => ({ version, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }) };
    },
  });
  findButton(host, 'Replace this device').click();
  await ui.settled();
  assert.equal(syncCalls.length, 1, 'a stale choice must not be retried automatically against the new state');
  assert.equal(syncCalls[0].expectVersion, 4);
  assert.match(allText(host), /changed/i, 'the user must be told the account moved');
  assert.ok(findButton(host, 'Replace this device'), 'the choice must be presented again, against the new state');
  const again = findButton(host, 'Merge');
  again.click();
  await ui.settled();
  assert.equal(syncCalls.length, 2);
  assert.equal(syncCalls[1].expectVersion, 9, 'the re-asked choice must be pinned to the NEW version');
});

test('an unlinked device warns that a bare device token creates a NEW account', () => {
  installFakeLocalStorage();
  const doc = installDom();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  initLinkUI({
    host,
    applyState: (s) => s,
    fetchImpl: async () => { throw new Error('no network call was expected here'); },
    apiBase: 'https://w.example',
    now: () => NOW,
    syncOnceImpl: async () => ({ status: 'ok' }),
  });
  const input = findInput(host, 'Link code');
  assert.ok(input, 'an unlinked device must offer a paste field');
  input.value = bytesToBase64url(generateEncKey());
  fire(input, 'input');
  const warning = allText(host);
  assert.match(warning, /new/i, 'a bare token must be flagged as creating a NEW account');
  assert.match(warning, /86/, 'the user must be told joining an existing account needs an 86-character code');

  input.value = composeLinkCode(bytesToBase64url(generateEncKey()), generateEncKey());
  fire(input, 'input');
  assert.doesNotMatch(allText(host), /creates? a new/i, 'a full link code must not carry the new-account warning');
});

test('mounting a linked, settled device makes no network call', async () => {
  const { fetchCalls, host } = await setup({ clearGate: true });
  assert.deepEqual(fetchCalls, [], 'mounting the settings panel must not fire a request');
  assert.ok(findButton(host, 'Unlink'), 'a linked device must offer Unlink');
});

test('Unlink keeps local data and says so', async () => {
  const unlinkedCalls = [];
  const { host, ui } = await setup({
    clearGate: true,
    unlinkedCalls,
    seed: () => { saveItems([it('keep')]); saveFeeds([fd('keepfeed')]); },
  });
  findButton(host, 'Unlink').click();
  await ui.settled();
  assert.equal(isLinked(), false);
  assert.deepEqual(loadItems().map((i) => i.id), ['keep'], 'unlinking never deletes local data (spec 4.4)');
  assert.deepEqual(loadFeeds().map((f) => f.id), ['keepfeed']);
  assert.match(allText(host), /kept/i, 'the user must be told local data was kept');
  assert.equal(unlinkedCalls.length, 1);
});

// The only way a second device obtains encKey.
test('Link another device composes a code carrying THIS device key, and shows it only in the copy field', async () => {
  const { host, ui, link } = await setup({ clearGate: true });
  const tokenInput = findInput(host, 'New device token');
  assert.ok(tokenInput, 'a linked device must offer a field for a freshly minted device token');
  const newToken = bytesToBase64url(generateEncKey());
  tokenInput.value = newToken;
  findButton(host, 'Create a code').click();
  await ui.settled();

  const out = findInput(host, 'Link code for the new device');
  assert.ok(out, 'the composed code must land in a field the user can copy from');
  assert.equal(out.value.length, 86);
  const parsed = parseLinkCode(out.value);
  assert.equal(parsed.authToken, newToken, 'the code must carry the NEW device token');
  assert.deepEqual([...parsed.encKey], [...link.encKey],
    'the code must carry THIS device key — a fresh one would produce a device that can never decrypt the account');

  // Never in textContent, never in an aria-label or title: both land in the
  // accessibility tree.
  assert.ok(!allNonValueStrings(host).includes(out.value),
    'the link code must appear only in the value of the field it is copied from');
});

// composeForNewDevice fails closed on a null link and on an 86-character
// token (js/crypto.js:58, :40). An uncaught throw here leaves the dialog
// frozen with no diagnostic.
test('a rejected new-device token renders the error instead of freezing the dialog', async () => {
  const { host, ui } = await setup({ clearGate: true });
  const tokenInput = findInput(host, 'New device token');
  // An 86-character link code pasted where a 43-character token belongs.
  tokenInput.value = composeLinkCode(bytesToBase64url(generateEncKey()), generateEncKey());
  findButton(host, 'Create a code').click();
  await ui.settled();
  assert.match(allText(host), /32 bytes/, "composeForNewDevice's own message must reach the user");
  assert.equal(findInput(host, 'Link code for the new device').value, '', 'no code may be shown for a rejected token');
});

test('a link attempt that throws renders the error and never echoes the pasted code', () => {
  installFakeLocalStorage();
  const doc = installDom();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const ui = initLinkUI({
    host,
    applyState: (s) => s,
    fetchImpl: async () => { throw new Error('no network call was expected here'); },
    apiBase: 'https://w.example',
    now: () => NOW,
    syncOnceImpl: async () => ({ status: 'ok' }),
  });
  const input = findInput(host, 'Link code');
  input.value = 'this is not a link code';
  findButton(host, 'Link this device').click();
  return ui.settled().then(() => {
    assert.equal(isLinked(), false);
    assert.match(allText(host), /base64url|link/i, 'the failure must be surfaced, not swallowed');
    assert.ok(!allNonValueStrings(host).includes('this is not a link code'),
      'the pasted string must never be echoed — on a transient failure it IS a real link code');
  });
});

// An end-to-end pass through the REAL syncOnce, so the deps initLinkUI hands
// it are exercised rather than stubbed: every other test above injects
// syncOnceImpl to observe the adoptChoice directly.
test('a bootstrap adoption drives the real syncOnce, pushes local state and lifts the gate', async () => {
  installFakeLocalStorage();
  const doc = installDom();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  saveItems([it('local')]);
  const row = { version: 0, blob: '' };
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ ...row }) };
    const body = JSON.parse(opts.body);
    assert.equal(body.version, row.version);
    row.version += 1;
    row.blob = body.blob;
    return { ok: true, status: 200, json: async () => ({ version: row.version }) };
  };
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const ui = initLinkUI({
    host,
    applyState: (s) => s,
    fetchImpl,
    apiBase: 'https://w.example',
    now: () => NOW,
  });
  await ui.settled();
  assert.equal(row.version, 1, 'the bootstrap must push local state to the empty account');
  assert.equal(loadSyncState().adoptionPending, false, 'a completed adoption lifts the gate');
  const { decryptBlob } = await import('../js/crypto.js');
  const pushed = await decryptBlob(link.encKey, row.blob);
  assert.deepEqual(pushed.items.map((i) => i.id), ['local']);
  assert.deepEqual(pushed, toWire(pushed), 'the pushed blob must be canonical wire form');
});
