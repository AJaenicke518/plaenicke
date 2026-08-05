import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import {
  describeSyncStatus, classifyPastedCode, chooseAdoption, renderSyncStatus,
  initLinkUI, failureText, SYNC_STATUS_ID,
} from '../js/linkui.js';
import { linkWithCode, clearAdoptionPending, isLinked } from '../js/auth.js';
import {
  bytesToBase64url, generateEncKey, composeLinkCode, encryptBlob, parseLinkCode,
} from '../js/crypto.js';
import {
  saveItems, saveFeeds, saveAuth, saveTombstones, loadItems, loadFeeds, loadTombstones, loadSyncState, saveSyncState,
} from '../js/storage.js';
import { SCHEMA_VERSION, toWire } from '../js/merge.js';
import { WORKER_URL } from '../js/config.js';

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
//
// This enumerates the element's OWN enumerable primitive properties rather
// than a hand-written list. js/linkui.js's el() helper assigns most
// attribute-ish things (placeholder, autocomplete, type, title) as DOM
// PROPERTIES, not via setAttribute, so a fixed list that read only
// textContent/id/className/_attrs missed all of them: proven by adding
// `placeholder: mintedCode` — a real 86-character link code in the
// accessibility tree — and watching the whole suite stay green.
function allNonValueStrings(el) {
  let out = ` ${el.className}`;
  for (const [key, val] of Object.entries(el)) {
    if (key === 'value') continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out += ` ${val}`;
  }
  for (const v of Object.values(el._attrs)) out += ` ${v}`;
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

// --- emptiness must count tombstones THAT ACTUALLY DELETE SOMETHING -------
//
// The plan said "tombstones are never counted on either side". That was
// adjudicated to stop a tombstone-only account being classified 'ask' and
// offered "Replace this device" — a one-click unrecoverable wipe. But 'none'
// and 'auto' both route to adopt-bootstrap, which runs AUTOMATICALLY on panel
// mount with no user interaction: it traded a one-click wipe for a ZERO-click
// one, in both directions. Reproduced.
//
// A pure count of tombstones is the wrong fix too — it sends a tombstone-only
// account back to 'ask', re-creating the original defect. What counts is
// whether a side's tombstones would actually suppress a record on the OTHER
// side.

test('remote tombstones that would delete local records must ASK, never bootstrap silently', () => {
  const local = st({ items: [it('a')], feeds: [fd('f')] });
  const remote = st({
    tombstones: [
      { id: 'a', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' },
      { id: 'f', kind: 'feed', deletedAt: '2026-08-04T00:00:00.000Z' },
    ],
  });
  assert.equal(chooseAdoption(local, remote), 'ask',
    'bootstrapping here deletes both local records with no dialog at all — and a feed URL is a capability token that is never re-displayed');
});

test('local tombstones that would delete account records must ASK, never adopt silently', () => {
  // Signed-out plaenicke is a complete app (spec 4.4): the user cleared their
  // list while unlinked, so items/feeds are empty but the tombstones remain.
  const local = st({ tombstones: [{ id: 'r', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }] });
  const remote = st({ items: [it('r')] });
  assert.equal(chooseAdoption(local, remote), 'ask',
    "'auto' here deletes the account's record and tombstones it to every other device, with no dialog");
});

test('tombstones that suppress nothing on the other side are not data', () => {
  const unrelated = st({ tombstones: [{ id: 'never-seen-here', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }] });
  assert.equal(chooseAdoption(st({ items: [it('l')] }), unrelated), 'none',
    'an account carrying only deletions this device never had is still an empty account');
  assert.equal(chooseAdoption(unrelated, st({ items: [it('r')] })), 'auto');
});

// The suppression rule is merge.js's, reused rather than re-implemented: a
// record whose updatedAt is at or after the deletion was RE-CREATED after it
// and survives. A naive id match would call this a deletion and ask.
test('a tombstone older than the record it names suppresses nothing', () => {
  const local = st({ items: [{ ...it('a'), updatedAt: '2026-08-06T00:00:00.000Z' }] });
  const remote = st({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }] });
  assert.equal(chooseAdoption(local, remote), 'none');
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

// The dialog can now be reached against a side showing 0 items and 0
// calendars but carrying pending deletions. It must say so — a bare
// "0 items, 0 calendars" next to a Replace button is not an informed choice.
test('the dialog names pending deletions instead of showing a bare "0 items" next to Replace', async () => {
  const { host, syncCalls } = await setup({
    seed: () => { saveItems([it('a'), it('b')]); },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: 3,
        blob: await encryptBlob(currentKey, st({
          tombstones: [
            { id: 'a', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' },
            { id: 'b', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' },
          ],
        })),
      }),
    }),
  });
  assert.equal(syncCalls.length, 0, 'a tombstone-only account must not be adopted with no dialog');
  assert.ok(findButton(host, 'Replace this device'), 'the choice must be presented');
  const text = allText(host);
  assert.match(text, /deletion/i, 'the pending deletions must be named, not hidden behind a bare "0 items"');
  assert.match(text, /2 of the items/i);
});

// Minor 1: the OTHER direction of that sentence. This is the one where Merge
// deletes the ACCOUNT's records on every other device, so it is if anything
// the more important half — and `if (false)` in its place survived the suite.
test('the dialog also names the deletions THIS device would push to the account', async () => {
  const { host } = await setup({
    seed: () => {
      saveItems([it('mine')]);
      saveTombstones([{ id: 'r', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }]);
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 6, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
    }),
  });
  assert.ok(findButton(host, 'Merge'));
  assert.match(allText(host), /1 of the records in the account/i,
    'a Merge that deletes an account record on every other device must say so first');
});

// I5. chooseAdoption's own unit tests cover local feeds; the CALLER's read of
// them did not. Proven: changing handlePreview's `local` to `feeds: []` left
// the whole suite green, while a device whose only local data is calendar
// subscriptions would classify 'auto', adopt with no dialog, and have
// applyRemoteFeeds delete every feed absent from the merged list — the Task 5
// unrecoverable-subscription shape again.
test('a device whose only local data is a calendar subscription still gets the dialog', async () => {
  const { host, syncCalls } = await setup({
    seed: () => { saveItems([]); saveFeeds([fd('localfeed')]); },
    fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ version: 4, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
    }),
  });
  assert.equal(syncCalls.length, 0, 'a local calendar subscription is data — it must not be adopted over silently');
  assert.ok(findButton(host, 'Replace this device'));
});

// IR1. The sibling read (local FEEDS) is pinned by the test above; the local
// TOMBSTONE read at handlePreview was not — chooseAdoption's local-tombstone
// logic was verified only as a pure function, so changing the caller's
// loadTombstones() to [] left the whole suite green while turning this exact
// scenario into a no-dialog wipe of the account.
test('a device that cleared its list while unlinked still gets the dialog, not a silent account wipe', async () => {
  const { host, syncCalls } = await setup({
    seed: () => {
      // Signed-out plaenicke is a complete app (spec 4.4): the user deleted
      // their records while unlinked, so items/feeds are empty and only the
      // tombstones remain.
      saveItems([]);
      saveFeeds([]);
      saveTombstones([
        { id: 'r', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' },
        { id: 'rf', kind: 'feed', deletedAt: '2026-08-04T00:00:00.000Z' },
      ]);
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: 5,
        blob: await encryptBlob(currentKey, st({ items: [it('r')], feeds: [fd('rf')] })),
      }),
    }),
  });
  assert.equal(syncCalls.length, 0,
    "adopting here deletes the account's item AND calendar and tombstones both to every other device, with no dialog");
  assert.ok(findButton(host, 'Replace this device'), 'the choice must be presented');
  assert.match(allText(host), /2 of the records in the account/i,
    'the deletions this device would push must be named');
});

// I1. adopt() on status 'changed' re-previews, which on a 'none'/'auto'
// decision adopts again — with no counter and no error surface. Reproduced
// against an account whose version advances on every GET: 201 GETs before the
// harness cap, panel stuck on "Combining…" forever. syncOnce's own CAS loop
// twenty lines away is bounded for exactly this reason.
test('an account that keeps changing gives up instead of looping forever', async () => {
  let version = 0;
  const { host, syncCalls } = await setup({
    fetchImpl: async () => {
      version += 1;
      return { ok: true, status: 200, json: async () => ({ version, blob: '' }) };
    },
    syncResults: Array.from({ length: 50 }, (_, i) => ({ status: 'changed', version: 100 + i })),
  });
  assert.ok(syncCalls.length > 0, 'the adoption must actually have been attempted');
  assert.ok(syncCalls.length <= 5, `the changed/re-preview cycle must be bounded, got ${syncCalls.length} attempts`);
  assert.match(allText(host), /kept changing/i, 'giving up must be surfaced, not left spinning on "Combining…"');
  assert.ok(findButton(host, 'Try again'), 'exhaustion must leave a way forward');
  assert.equal(loadSyncState().adoptionPending, true, 'the gate stays raised');
});

// I2. settings.js calls initLinkUI per open(), and close() cannot cancel the
// previous closure's in-flight work: each mount owns its own `inflight` and
// the gate is still raised, so a second mount fires its own adoption.
// Reproduced: ['GET','GET','SYNC','SYNC']. Worst realistic case is Replace
// then Merge — two applyState writes with conflicting semantics, resolved by
// arrival order.
test('re-opening the panel mid-adoption does not start a second, concurrent adoption', async () => {
  installFakeLocalStorage();
  const doc = installDom();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  saveItems([it('local')]);

  const log = [];
  let releaseFirstGet;
  const held = new Promise((resolve) => { releaseFirstGet = resolve; });
  let gets = 0;
  const fetchImpl = async () => {
    gets += 1;
    log.push('GET');
    if (gets === 1) await held;
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) };
  };
  const syncOnceImpl = async (deps) => { log.push(`SYNC:${deps.adoptChoice}`); return { status: 'ok', pushed: true }; };
  const deps = { applyState: (s) => s, fetchImpl, apiBase: 'https://w.example', now: () => NOW, syncOnceImpl };

  const hostA = doc.createElement('div');
  doc.body.appendChild(hostA);
  const first = initLinkUI({ host: hostA, ...deps });

  // The user closes the panel and opens it again while that GET is still out.
  hostA.innerHTML = '';
  const hostB = doc.createElement('div');
  doc.body.appendChild(hostB);
  const second = initLinkUI({ host: hostB, ...deps });

  releaseFirstGet();
  await first.settled();
  await second.settled();

  assert.deepEqual(log, ['GET', 'SYNC:adopt-bootstrap'],
    'a second mount must join the adoption already running, not start a parallel one');
  assert.equal(link.authToken.length, 43); // fixture sanity
});

// --- the adoption exclusion: preview phase vs write phase ------------------
//
// A PREVIEW is a read with no side effects, so abandoning one is safe and a
// joining mount may take it over. A WRITE is not abandonable and nothing may
// take over from it. Round 2 got this wrong: it gated whether an episode may
// BEGIN a write, which says nothing once one is already inside syncOnce, and
// the takeover control was offered instantly under text that invited the
// click. Every mutant of the generation counter died loudly; the defect only
// appears under an interleaving, so these tests construct the interleavings.

function makeClock(startMs) {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

// A SINGLE setTimeout(0) IS NOT ENOUGH to wait out an adoption episode, and
// treating it as if it were made this file's concurrency block flaky on
// UNMUTATED source: measured 4/15 failing under `npm test` and 7/10 running
// this file alone under load, always on the same fixture check.
//
// Releasing a held fetch does not put the episode one microtask away from its
// write: it still has to traverse previewRemote -> fetchRemote -> decryptBlob,
// and decryptBlob is real WebCrypto. It resolves on a libuv thread-pool
// completion — a MACROTASK that routinely lands AFTER a setTimeout(0) queued
// before it, so the settle returns with the episode still mid-decrypt.
//
// That matters beyond noise. The write-in-flight test below is the SOLE killer
// of the mutant that deletes `|| writeInFlight` from runAdoption, and a run
// that aborts at the fixture check never exercises the guard at all — so the
// flake both hides the guard and contaminates mutation batteries, which
// mis-attributed 13 of 24 mutants in one pass to this test.
//
// Poll the condition. Never a fixed sleep: a sleep long enough to be reliable
// on a loaded machine is a sleep paid on every green run, and it would still
// only be a guess.
async function settleUntil(pred) {
  for (let i = 0; i < 200 && !pred(); i += 1) await settle();
}

// Mounts a linked, adoption-pending device with a preview that can be held
// open, and a syncOnceImpl that can be held open independently.
async function concurrencyFixture({ staleAfterMs, clock, localEmpty = false } = {}) {
  installFakeLocalStorage();
  const doc = installDom();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  // localEmpty drives chooseAdoption to 'auto', so an episode reaches the
  // WRITE with no human in the loop — the only way to exercise what happens
  // to a superseded episode that gets as far as adopt().
  if (!localEmpty) saveItems([it('local')]);
  // The account holds data too, so chooseAdoption reaches 'ask' and these
  // tests exercise the dialog and the write, not just the preview.
  const blob = await encryptBlob(link.encKey, st({ items: [it('r')] }));
  const gets = [];
  const releases = [];
  const fetchImpl = async () => {
    const index = gets.length;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    releases.push(release);
    gets.push(index);
    await held;
    return { ok: true, status: 200, json: async () => ({ version: 4, blob }) };
  };
  const syncCalls = [];
  let releaseWrite = null;
  const syncOnceImpl = async (d) => {
    syncCalls.push(d.adoptChoice);
    if (releaseWrite === false) {
      await new Promise((resolve) => { releaseWrite = resolve; });
    }
    return { status: 'ok', pushed: false };
  };
  const deps = {
    applyState: (s) => s,
    fetchImpl,
    apiBase: 'https://w.example',
    now: (clock || { now: () => NOW }).now,
    syncOnceImpl,
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
  };
  const mount = () => {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    return { host, ui: initLinkUI({ host, ...deps }) };
  };
  const letWriteFinish = () => {
    if (typeof releaseWrite === 'function') releaseWrite();
    releaseWrite = null;
  };
  return {
    doc, mount, gets, syncCalls,
    releaseGet: (i) => releases[i](),
    holdNextWrite: () => { releaseWrite = false; },
    letWriteFinish,
    // Registered with t.after by every test below. A concurrency test that
    // fails an assertion half way through would otherwise leave held fetch
    // promises pending, which keeps node's event loop alive and hangs the
    // WHOLE suite rather than reporting the failure — measured: three
    // mutants that these tests do detect were reported as a 60s timeout in
    // an unrelated file instead of as a named failure.
    releaseAll: () => { releases.forEach((r) => r()); letWriteFinish(); },
  };
}

// THE CRITICAL. Reproduced verbatim before the fix: Merge held inside
// syncOnce -> close/reopen -> Try again -> Replace gave
// ['adopt-merge','adopt-replace'] with both writes in flight at once. The
// superseded PUT then landed after the replace, putting the record the user
// explicitly discarded back into the account.
test('a mount arriving while a write is in flight cannot take over from it', async (t) => {
  const f = await concurrencyFixture();
  t.after(() => f.releaseAll());
  const a = f.mount();
  f.releaseGet(0);
  await a.ui.settled();
  assert.ok(findButton(a.host, 'Merge'), 'fixture check: the dialog is up');

  f.holdNextWrite();
  findButton(a.host, 'Merge').click();
  await settleUntil(() => f.syncCalls.length > 0);
  assert.deepEqual(f.syncCalls, ['adopt-merge'], 'fixture check: the write is in flight');

  // The panel is closed and re-opened while that write is still running.
  a.host.innerHTML = '';
  const b = f.mount();
  assert.match(allText(b.host), /Saving your choice/,
    'a write in flight must be reported as such, not as something to retry');
  assert.equal(findButton(b.host, 'Try again'), null,
    'nothing may take over from an unabandonable write');
  assert.equal(findButton(b.host, 'Unlink'), null,
    'and unlinking here would leave that write pushing with a token the user just revoked');
  // Nothing under syncOnce has a timeout, so a write that never answers would
  // leave this on a bare spinner. With no control to offer, the text has to
  // carry the whole state: what is happening, that it cannot be interrupted,
  // and that reloading is SAFE — the gate is still raised and the
  // compare-and-swap makes a re-run idempotent. "Reload the page" without
  // "this is safe" just invites the user to sit and wait instead.
  assert.match(allText(b.host), /cannot be interrupted/i);
  assert.match(allText(b.host), /safe to reload/i,
    'a user with no control to click must be told that reloading loses nothing');

  f.letWriteFinish();
  await a.ui.settled();
  await b.ui.settled();
  assert.deepEqual(f.syncCalls, ['adopt-merge'], 'exactly one write may run');
  assert.doesNotMatch(allText(b.host), /Saving your choice/,
    'the joining mount must leave that view once the write settles');
});

// THE SAME HOLE, REACHED THROUGH THE RE-ASK BRANCH.
//
// adoptAgainstFreshCounts re-decides when the dialog's counts moved, and it
// does so by calling decideAndAct — which, when the device has since emptied,
// resolves to 'auto' and goes STRAIGHT into a write with no human in the loop.
// Drop the `await` on that one call and adoptAgainstFreshCounts resolves
// immediately: guarded() resolves, runAdoption's `finally` clears
// `activeAdoption`, and the write is still running underneath it. The next
// panel open then sees no live episode and starts a second one freely — the
// exclusion `writeInFlight` exists to hold, breached by a different route.
//
// Every dialog test above stays green under that mutant because they all end
// on the 'ask' branch, which is synchronous to render(). Measured: 553/553.
test('the re-ask branch is awaited, so an episode that re-decides still holds the exclusion', async (t) => {
  const f = await concurrencyFixture();
  t.after(() => f.releaseAll());
  const a = f.mount();
  f.releaseGet(0);
  await a.ui.settled();
  assert.ok(findButton(a.host, 'Merge'), 'fixture check: the dialog is up');

  // The device empties while the dialog sits open — renderCalendars' Remove
  // control and app.js's own delete path are both live directly above it, and
  // open() installs no focus trap. The counts moved, so the click re-decides.
  saveItems([]);
  f.holdNextWrite();
  findButton(a.host, 'Merge').click();
  await settleUntil(() => f.syncCalls.length > 0);
  assert.deepEqual(f.syncCalls, ['adopt-bootstrap'],
    'fixture check: the re-ask resolved to auto and went straight into a write');
  // Drain to the next MACROTASK before mounting. The episode's `finally` sits
  // three or four microtask ticks past the point the write becomes observable,
  // so a mount taken immediately would still see the stale `activeAdoption`
  // even under the mutant and pass for the wrong reason — measured: this test
  // passed 1/1 against the mutated source until this line was added.
  await settle();
  await settle();

  // Closed and re-opened while that write is still running.
  a.host.innerHTML = '';
  const b = f.mount();
  assert.match(allText(b.host), /Saving your choice/,
    'the re-deciding episode must still be the live one while its write is in flight');
  assert.equal(f.gets.length, 1,
    'a joining mount must not start its own preview — that is how a second concurrent write begins');

  f.letWriteFinish();
  await a.ui.settled();
  await b.ui.settled();
  assert.deepEqual(f.syncCalls, ['adopt-bootstrap'], 'exactly one write may run');
});

// A healthy adoption takes a second or two. Offering a takeover instantly
// turns every ordinary wait into an invitation to start a second episode.
test('a takeover is not offered until the live preview has been running long enough to look stuck', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 10000, clock });
  t.after(() => f.releaseAll());
  const a = f.mount();

  a.host.innerHTML = '';
  const b = f.mount();
  assert.equal(findButton(b.host, 'Try again'), null,
    'a two-second adoption must not present a takeover control');
  assert.match(allText(b.host), /already under way/);

  f.releaseGet(0);
  await a.ui.settled();
  await b.ui.settled();
  assert.deepEqual(f.syncCalls, [], 'a preview alone must never write');
});

test('a preview that has stalled past the threshold can be taken over, and the stalled one never writes', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 50, clock });
  t.after(() => f.releaseAll());
  const a = f.mount();

  a.host.innerHTML = '';
  clock.advance(60);
  const b = f.mount();
  const takeOver = findButton(b.host, 'Try again');
  assert.ok(takeOver, 'a stalled PREVIEW is abandonable and must offer a way out');
  assert.ok(findButton(b.host, 'Unlink'), 'and a way to stop syncing entirely');

  takeOver.click();
  f.releaseGet(1);
  await b.ui.settled();
  assert.ok(findButton(b.host, 'Merge'), 'the takeover must reach the dialog');
  findButton(b.host, 'Merge').click();
  await b.ui.settled();
  assert.deepEqual(f.syncCalls, ['adopt-merge']);

  // The stalled preview finally answers. It has been superseded.
  f.releaseGet(0);
  await a.ui.settled();
  assert.deepEqual(f.syncCalls, ['adopt-merge'],
    'a superseded preview must not go on to write when it eventually returns');
});

// Cancel says "Nothing was combined. This device will not sync until you
// choose." A superseded episode reaching syncOnce would call
// clearAdoptionPending() and make that statement false.
test('Cancel after a takeover stays true — the superseded episode never lands the adoption', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 50, clock });
  t.after(() => f.releaseAll());
  const a = f.mount();

  a.host.innerHTML = '';
  clock.advance(60);
  const b = f.mount();
  findButton(b.host, 'Try again').click();
  f.releaseGet(1);
  await b.ui.settled();
  findButton(b.host, 'Cancel').click();
  await b.ui.settled();
  assert.equal(loadSyncState().adoptionPending, true);

  f.releaseGet(0);
  await a.ui.settled();
  assert.deepEqual(f.syncCalls, [], 'the superseded episode must not adopt behind the user');
  assert.equal(loadSyncState().adoptionPending, true,
    'the panel said nothing was combined — that must remain true');
});

// R3C-a. The mutation battery proved the test above does NOT cover this:
// deleting `|| writeInFlight` from runAdoption's guard left the whole suite
// green, because joinActive picks the 'saving' view on its own so there is no
// button to click. The reachable interleaving is a takeover control rendered
// BEFORE the write began and still on screen after it started: the joining
// mount only re-renders when the episode it joined settles.
test('a takeover control left on screen from before the write cannot fire once the write starts', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 50, clock, localEmpty: true });
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';
  clock.advance(60);
  const b = f.mount();
  const takeOver = findButton(b.host, 'Try again');
  assert.ok(takeOver, 'fixture check: the stalled-preview takeover is offered');

  // The live episode's preview answers and it goes straight into its write.
  f.holdNextWrite();
  f.releaseGet(0);
  await settleUntil(() => f.syncCalls.length > 0);
  assert.deepEqual(f.syncCalls, ['adopt-bootstrap'], 'fixture check: a write is now in flight');

  // No poll here, deliberately: the refusal is SYNCHRONOUS (runAdoption ->
  // joinActive -> render, no await), so one macrotask is already more than the
  // path needs. Polling on "syncCalls stayed at 1" would also be polling on a
  // negative, which can only ever time out into a pass.
  takeOver.click();
  await settle();
  assert.deepEqual(f.syncCalls, ['adopt-bootstrap'],
    'a stale takeover control must not start a second write alongside the live one');
  assert.match(allText(b.host), /Saving your choice/, 'and must report what is actually happening');

  f.letWriteFinish();
  await a.ui.settled();
  await b.ui.settled();
});

// R3C-d. Also proved uncovered: in the takeover test above, the superseded
// episode lands on the DIALOG and never reaches adopt(), so the generation
// gate is never exercised. It only bites on the automatic path, where no
// human stands between the preview returning and the write.
test('a superseded preview does not write when it returns, on the automatic path', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 50, clock, localEmpty: true });
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';
  clock.advance(60);
  const b = f.mount();
  findButton(b.host, 'Try again').click();
  f.releaseGet(1);
  await b.ui.settled();
  assert.deepEqual(f.syncCalls, ['adopt-bootstrap'], 'fixture check: the live episode adopted');

  f.releaseGet(0);
  await a.ui.settled();
  assert.deepEqual(f.syncCalls, ['adopt-bootstrap'],
    'the superseded preview must not adopt a second time when it finally answers');
});

// R3C-f. The re-check timer is what stops the ordinary joining view becoming
// the wedge again: a mount that joined a preview which LATER stalls must be
// offered the way out without the user closing and reopening the panel.
test('a mount that joined a healthy preview is offered a takeover once it stalls', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 30, clock });
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';
  const b = f.mount();
  assert.equal(findButton(b.host, 'Try again'), null, 'fixture check: nothing looks stuck yet');

  clock.advance(120);
  // Polled, not slept: the wall-clock delay under test is 30 ms, and any fixed
  // wait picked to clear it is either flaky on a loaded machine or paid in
  // full on every green run.
  await settleUntil(() => findButton(b.host, 'Try again'));
  assert.ok(findButton(b.host, 'Try again'),
    'the joining view must promote itself when the episode it joined stalls, not wait for another panel open');
});

// M19. "A superseded episode must not clear the marker its successor set."
// The comment asserted it; nothing tested it. Clearing unconditionally
// orphans the live episode's exclusion and lets a third start alongside it.
test('a superseded episode that finishes does not release the live episode exclusion', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 50, clock });
  t.after(() => f.releaseAll());
  const a = f.mount();                       // generation 1
  a.host.innerHTML = '';
  clock.advance(60);
  const b = f.mount();                       // joins
  findButton(b.host, 'Try again').click();   // generation 2
  b.host.innerHTML = '';
  clock.advance(60);
  const c = f.mount();                       // joins
  findButton(c.host, 'Try again').click();   // generation 3 — the live one
  assert.equal(f.gets.length, 3, 'fixture check: three previews are open');

  // The MIDDLE episode answers. It is superseded and must leave generation
  // 3's exclusion intact.
  f.releaseGet(1);
  await b.ui.settled();

  c.host.innerHTML = '';
  const d = f.mount();
  assert.equal(f.gets.length, 3,
    'a fourth mount must join the live episode, not start a fourth preview alongside it');
  // WHAT WAS HERE — assert.match(allText(d.host), /account/i) — could not
  // fail. render() appends the status line unconditionally before every
  // branch (js/linkui.js), the adoption gate is raised throughout this test,
  // and that line therefore always reads "Linked — but nothing syncs until you
  // choose how to combine this device with the account." The regex matched
  // whatever rendered, including the failure states.
  //
  // What is actually unpinned at this point is that runAdoption RESTARTS the
  // staleness clock when an episode takes over. Generation 3 began at
  // clock+120 and d mounts at clock+120, so d has joined a BRAND NEW episode
  // and nothing looks stuck yet. Leave activeStartedAt at the first episode's
  // start and d sees an elapsed of 120 against a 50 ms threshold: every mount
  // after a takeover is instantly invited to start yet another one — the
  // "instant takeover invites a second episode" defect, restored on the
  // takeover path. This is the only mount in the file that opens AFTER a
  // takeover, so it is the only place that can see it.
  assert.match(allText(d.host), /already under way/,
    'a mount joining a fresh takeover episode is waiting on it, not reporting one of its own');
  assert.equal(findButton(d.host, 'Try again'), null,
    'the takeover episode restarted the staleness clock — nothing looks stuck yet');

  f.releaseGet(2);
  f.releaseGet(0);
  await c.ui.settled();
  await a.ui.settled();
  await d.ui.settled();
});

// M55. The ORDINARY joining path is the one that simply waits. Deleting the
// re-render leaves it on "Checking the account…" forever — the very wedge the
// joining branch exists to avoid — and the takeover tests never catch it
// because they always click.
test('a joining mount that never clicks leaves the joining view once the live episode settles', async (t) => {
  const f = await concurrencyFixture();
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';
  const b = f.mount();
  assert.match(allText(b.host), /already under way/, 'fixture check: b is waiting');

  f.releaseGet(0);
  await a.ui.settled();
  await b.ui.settled();
  assert.doesNotMatch(allText(b.host), /already under way/,
    'a mount that only waits must be re-rendered when the episode it joined finishes');
  // The 'ask' stage lives in the episode's own mount; this one re-derives
  // from stored state, which still has the gate raised — so it must offer the
  // way back in rather than a dead "Checking the account…".
  assert.ok(findButton(b.host, 'Continue'),
    'a mount that only waited must end up with a way forward, not a frozen busy view');
});

// R4-2. The write-phase rule was applied to the takeover control and not to
// the control appended beside it in the SAME call. Both come from
// renderJoiningStale's `wrap.append(takeOver, unlinkButton(...))`, so the
// interleaving is identical — a control rendered before the write began, still
// on screen after it started — but unlinkButton wired straight to doUnlink()
// with no gate. syncOnce captured `link = getLink()` at entry (js/sync.js:83),
// so the in-flight write goes on pushing with a credential the user just
// revoked, and its applyState has already replaced this device's items with
// the account's. Reproduced: isLinked() false, local items ['remoteA',
// 'remoteB'], syncState {version: 4, tokenHash: null, adoptionPending: false},
// under a panel reading "Unlinked. Everything on this device was kept."
test('an Unlink control left on screen from before the write cannot fire once the write starts', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 50, clock, localEmpty: true });
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';
  clock.advance(60);
  const b = f.mount();
  const unlinkBtn = findButton(b.host, 'Unlink');
  assert.ok(unlinkBtn, 'fixture check: the stalled-preview view offers Unlink beside Try again');

  // The live episode's preview answers and it goes straight into its write.
  f.holdNextWrite();
  f.releaseGet(0);
  await settleUntil(() => f.syncCalls.length > 0);
  assert.deepEqual(f.syncCalls, ['adopt-bootstrap'], 'fixture check: a write is now in flight');

  unlinkBtn.click();
  await settle();
  assert.equal(isLinked(), true,
    'the credential the in-flight write is still pushing with must not be revoked under it');
  assert.match(allText(b.host), /Saving your choice/,
    'and the refusal must say what is actually happening, not silently do nothing');

  f.letWriteFinish();
  await a.ui.settled();
  await b.ui.settled();
});

// R4-3. joinActive closed over `activeAdoption` at CALL time, so a mount that
// went on to take over still had the abandoned episode's settle handler wired
// to `stage = null; render()`. View-only — the superseded episode is
// generation-gated out of adopt, so no wrong write is possible — but it
// discards a decision the user is in the middle of making.
test('a superseded episode settling does not wipe the taking-over mount mid-decision', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 50, clock });
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';
  clock.advance(60);
  const b = f.mount();                       // joins the stalled episode
  findButton(b.host, 'Try again').click();   // and then takes over from it
  f.releaseGet(1);
  await b.ui.settled();
  assert.ok(findButton(b.host, 'Merge'), 'fixture check: b is mid-decision on its own preview');

  // The abandoned first preview finally answers.
  f.releaseGet(0);
  await a.ui.settled();
  await settle();
  assert.ok(findButton(b.host, 'Merge'),
    'a superseded episode settling must not discard a dialog the user is deciding in');
  assert.ok(findButton(b.host, 'Replace'), 'all three choices, not a half-rendered view');
  assert.ok(findButton(b.host, 'Cancel'));
});

// R4-4. Every other concurrency test injects staleAfterMs or runs on a frozen
// clock where elapsed === 0, so ANY default >= 1 behaves identically and
// STALE_ADOPTION_MS was pinned by nothing. Setting it to 1 restores exactly
// the "instant takeover invites a second episode" defect the threshold was
// added to fix, with the suite green. Both edges are asserted, so a default
// that is too LARGE fails too.
test('the production staleness threshold is ten seconds — not instant, and not a minute', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ clock });   // no override: the real default
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';

  clock.advance(9999);
  const b = f.mount();
  assert.equal(findButton(b.host, 'Try again'), null,
    'a ten-second-shy adoption is healthy; a takeover control here invites a second episode');
  assert.match(allText(b.host), /already under way/);
  b.host.innerHTML = '';

  clock.advance(1);
  const c = f.mount();
  assert.ok(findButton(c.host, 'Try again'),
    'at ten seconds it looks stuck, and a preview is a side-effect-free read that is safe to abandon');

  f.releaseGet(0);
  await a.ui.settled();
  await b.ui.settled();
  await c.ui.settled();
});

// R4-5. Deleting the clearTimeout in joinActive's settle handler took
// `node --test tests/linkui.test.js` from 0.22 s to 10.22 s — an uncleared
// 10 000 ms timer holding the event loop open — with the suite still green.
// Asserted directly rather than by timing the run: a wall-clock assertion on
// the whole file would be the flakiest thing in it.
//
// linkui.js calls bare `setTimeout` / `clearTimeout`, which resolve to the
// globals at call time, so the globals can be observed without changing the
// module's surface for testability. Only long timers are tracked; settle()'s
// own 0 ms ones are noise here.
test('the joining view clears its re-check timer when the episode it joined settles', async (t) => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set();
  globalThis.setTimeout = (fn, ms) => {
    const h = realSet(fn, ms);
    if (ms >= 1000) live.add(h);
    return h;
  };
  globalThis.clearTimeout = (h) => { live.delete(h); return realClear(h); };
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });

  const f = await concurrencyFixture();            // 10 000 ms default threshold
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';
  const b = f.mount();
  assert.match(allText(b.host), /already under way/, 'fixture check: b joined and is waiting');
  assert.equal(live.size, 1, 'fixture check: the joining view armed a re-check timer');

  f.releaseGet(0);
  await a.ui.settled();
  await b.ui.settled();
  assert.equal(live.size, 0,
    'a settled episode must not leave a ten-second timer holding the event loop open');
});

// R4-6. `Math.max(0, staleAfterMs - elapsed)` -> `staleAfterMs` survived
// everything: the only test that exercised the re-check timer joined at
// elapsed 0, where the two expressions are equal. A mount that joins an
// already-almost-stale episode would wait the whole threshold over again.
test('a mount joining an already-stale-ish episode waits the remaining time, not the whole threshold', async (t) => {
  const clock = makeClock(Date.parse('2026-08-05T12:00:00.000Z'));
  const f = await concurrencyFixture({ staleAfterMs: 5000, clock });
  t.after(() => f.releaseAll());
  const a = f.mount();
  a.host.innerHTML = '';

  // 4990 ms of a 5000 ms threshold already spent: 10 ms remain, and the
  // mutant would arm for 5000.
  clock.advance(4990);
  const b = f.mount();
  assert.equal(findButton(b.host, 'Try again'), null, 'fixture check: not stale yet');

  clock.advance(10);
  await settleUntil(() => findButton(b.host, 'Try again'));
  assert.ok(findButton(b.host, 'Try again'),
    'the re-check must be armed for the time REMAINING, not for the whole threshold again');
});

// Minor 2. I argued these counts could not go stale because "the panel is the
// only writer during adoption". That was wrong: renderCalendars()'s Add /
// Remove / colour controls sit live directly above this dialog (isBusy()
// covers only feed syncing), and open() installs no focus trap, so app.js's
// own add path is reachable too. Reproduced against the real syncOnce: the
// dialog said "1 item and 1 calendar", a second calendar was added, Replace
// was clicked, and BOTH calendars were destroyed.
//
// EVERY limb of the check and BOTH buttons are covered: the Merge button
// bypassing the check entirely survived when only Replace was exercised.
async function dialogFixture(seed) {
  return setup({
    seed,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: 4,
        blob: await encryptBlob(currentKey, st({
          items: [it('r'), it('r2')],
          tombstones: [{ id: 'doomed', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }],
        })),
      }),
    }),
  });
}

for (const button of ['Merge', 'Replace this device']) {
  test(`${button}: a count that moved while the dialog was open re-asks instead of acting`, async () => {
    const { host, ui, syncCalls } = await dialogFixture(() => {
      saveItems([it('local')]);
      saveFeeds([fd('existing')]);
    });
    assert.match(allText(host), /1 calendar\b/, 'fixture check: the dialog shows one calendar');

    saveFeeds([fd('existing'), fd('justAdded')]);
    findButton(host, button).click();
    await ui.settled();

    assert.equal(syncCalls.length, 0, `${button} must not act on counts the user never saw`);
    assert.match(allText(host), /2 calendars/, 'the dialog must be re-presented with what this device now holds');
    assert.match(allText(host), /changed while the dialog was open/i, 'and must say why');
    assert.deepEqual(loadFeeds().map((f) => f.id), ['existing', 'justAdded'], 'nothing may have been discarded');

    findButton(host, button).click();
    await ui.settled();
    assert.equal(syncCalls.length, 1, 'confirming against the CURRENT counts must go through');
  });
}

test('an item added while the dialog was open re-asks — localItems is part of the check', async () => {
  const { host, ui, syncCalls } = await dialogFixture(() => { saveItems([it('local')]); });
  saveItems([it('local'), it('alsoLocal')]);
  findButton(host, 'Merge').click();
  await ui.settled();
  assert.equal(syncCalls.length, 0);
  assert.match(allText(host), /2 items/);
});

test('a deletion recorded while the dialog was open re-asks — localDeletesRemote is part of the check', async () => {
  const { host, ui, syncCalls } = await dialogFixture(() => { saveItems([it('local')]); });
  assert.doesNotMatch(allText(host), /records in the account/i, 'fixture check: no local deletions yet');
  // The user deletes one of the ACCOUNT's records from the live list above.
  saveTombstones([{ id: 'r', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }]);
  findButton(host, 'Merge').click();
  await ui.settled();
  assert.equal(syncCalls.length, 0, 'a Merge that now deletes an account record must be re-confirmed');
  assert.match(allText(host), /1 of the records in the account/i);
});

// Minor 3: remoteDeletesLocal is part of the rendered description, so it is
// part of the check. Isolated: local COUNTS stay identical while the account's
// pending deletions stop applying to what is here.
test('a swap that changes only remoteDeletesLocal still re-asks', async () => {
  const { host, ui, syncCalls } = await dialogFixture(() => {
    saveItems([it('local'), it('doomed')]);
  });
  assert.match(allText(host), /1 of the items and calendars on this device/i, 'fixture check');
  // Same count, different records: 'doomed' (which the account deletes) is
  // replaced by one it does not.
  saveItems([it('local'), it('safe')]);
  findButton(host, 'Replace this device').click();
  await ui.settled();
  assert.equal(syncCalls.length, 0, 'the description changed, so the choice must be re-confirmed');
  assert.doesNotMatch(allText(host), /1 of the items and calendars on this device/i);
});

// Minor 4: the re-ask must go back through chooseAdoption. If local emptied
// while the dialog sat open, re-rendering the old dialog reads "This device
// holds 0 items and 0 calendars" beside a Replace button — the exact shape
// DA-C2 named as not an informed choice. chooseAdoption says 'auto'.
test('a device that emptied while the dialog was open is no longer asked to choose', async () => {
  const { host, ui, syncCalls } = await dialogFixture(() => {
    saveItems([it('local')]);
    saveFeeds([fd('existing')]);
  });
  saveItems([]);
  saveFeeds([]);
  findButton(host, 'Merge').click();
  await ui.settled();
  assert.equal(findButton(host, 'Replace this device'), null,
    'there is nothing left on this device to replace — offering it is not an informed choice');
  assert.doesNotMatch(allText(host), /holds 0 items/);
  assert.deepEqual(syncCalls.map((c) => c.adoptChoice), ['adopt-bootstrap'],
    "an empty device adopts; it does not 'merge' with nothing");
});

// M39: stageData must carry the previewed remote state, or the fresh counts
// are computed against nothing and every local deletion silently reads as
// zero. Confirming with NO local change must go straight through.
test('a dialog whose device records account deletions still confirms in one click', async () => {
  const { host, ui, syncCalls } = await dialogFixture(() => {
    saveItems([it('local')]);
    saveTombstones([{ id: 'r', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }]);
  });
  assert.match(allText(host), /1 of the records in the account/i, 'fixture check');
  findButton(host, 'Merge').click();
  await ui.settled();
  assert.deepEqual(syncCalls.map((c) => c.adoptChoice), ['adopt-merge'],
    'nothing changed, so the click must act rather than re-ask');
});

// Minor 6/7 + Minor 1. 'unauthorized' and 'undecryptable' offered only
// "Re-link this device", and closing/reopening re-previews straight back into
// them — so a user who pasted a bare token on a second device, precisely the
// user with no valid 86-character code, could never stop syncing. 'malformed'
// is worse: its only control re-previews the same unusable blob forever. And
// the note describing Unlink was rendered on states that had no Unlink button
// at all, offline being the most common of them.
test('every failure state offers a way to stop syncing, and says so only where it does', async () => {
  const cases = [
    ['offline', async () => { throw new TypeError('Failed to fetch'); }],
    ['unauthorized', async () => ({ ok: false, status: 401, json: async () => ({}) })],
    ['undecryptable', async () => ({ ok: true, status: 200, json: async () => ({ version: 2, blob: await encryptBlob(generateEncKey(), st({ items: [it('r')] })) }) })],
    ['malformed', async () => ({ ok: true, status: 200, json: async () => ({ version: 2, blob: await encryptBlob(currentKey, { schemaVersion: SCHEMA_VERSION, items: [it('r')], feeds: [], tombstones: [null] }) }) })],
  ];
  for (const [label, fetchImpl] of cases) {
    const { host, ui } = await setup({ fetchImpl });
    const unlinkBtn = findButton(host, 'Unlink');
    assert.ok(unlinkBtn, `${label}: the user must always be able to stop syncing`);
    assert.match(allText(host), /Unlinking stops syncing/,
      `${label}: the note describing Unlink must be rendered with the button`);
    unlinkBtn.click();
    await ui.settled();
    assert.equal(isLinked(), false, label);
    assert.equal(findButton(host, 'Unlink'), null, `${label}: and must be gone once unlinked`);
    assert.doesNotMatch(allText(host), /Unlinking stops syncing/,
      `${label}: the note must not outlive the button it describes`);
  }
});

// Minor 1: Cancel must leave a way to finish. Deleting the Continue button
// entirely used to pass the whole suite, leaving a raised gate and no
// in-panel route back.
test('after Cancel the panel still offers a way to finish the adoption', async () => {
  const { host, ui, syncCalls } = await setup({
    seed: () => { saveItems([it('local')]); },
    fetchImpl: async () => ({
      ok: true, status: 200, json: async () => ({ version: 4, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
    }),
  });
  findButton(host, 'Cancel').click();
  await ui.settled();
  const resume = findButton(host, 'Continue');
  assert.ok(resume, 'Cancel must not strand the device with a raised gate and no way forward');
  resume.click();
  await ui.settled();
  assert.ok(findButton(host, 'Merge'), 'Continue must lead back to the choice');
  assert.equal(syncCalls.length, 0);
});

// Minor 2: settings.js passes none of fetchImpl / apiBase / now, so all three
// defaults ARE the production wiring. Breaking any of them used to pass the
// whole suite.
test('the injected effects default to the production wiring', async () => {
  installFakeLocalStorage();
  const doc = installDom();
  await linkWithCode(bytesToBase64url(generateEncKey()));
  const host = doc.createElement('div');
  doc.body.appendChild(host);

  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) };
  };
  const syncCalls = [];
  try {
    const ui = initLinkUI({
      host,
      applyState: (s) => s,
      syncOnceImpl: async (d) => { syncCalls.push(d); return { status: 'ok', pushed: false }; },
    });
    await ui.settled();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(seen.length, 1, 'the default fetchImpl must reach global fetch');
  assert.equal(seen[0].url, `${WORKER_URL}/data`, 'apiBase must default to the deployed Worker');
  assert.ok(seen[0].opts && seen[0].opts.headers && /^Bearer /.test(seen[0].opts.headers.authorization),
    'the default fetchImpl must forward (url, opts) in that order — swapping them drops the Authorization header');
  assert.equal(syncCalls.length, 1);
  const stamped = syncCalls[0].now();
  assert.ok(stamped instanceof Date);
  assert.ok(Math.abs(stamped.getTime() - Date.now()) < 60_000,
    'now must default to the real clock — an epoch default would stamp every lastSyncedAt as 1970');
});

// Minor 5: a blob with `items` but no `feeds` key passed chooseAdoption (its
// count is null-safe) and then threw on preview.state.feeds.length. run()
// caught it, so the user got the generic "Something went wrong on this
// device" with no way forward.
test('a structurally incomplete account blob gets its own message, not a generic crash', async () => {
  const { host, syncCalls } = await setup({
    seed: () => { saveItems([it('local')]); },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 2, blob: await encryptBlob(currentKey, { schemaVersion: SCHEMA_VERSION, items: [it('r')] }) }),
    }),
  });
  assert.equal(syncCalls.length, 0, 'an account this device cannot make sense of must not be adopted');
  const text = allText(host);
  assert.doesNotMatch(text, /Something went wrong on this device/,
    'a malformed blob is a diagnosable condition, not an unexplained crash');
  assert.match(text, /incomplete|malformed/i);
  assert.ok(findButton(host, 'Try again'), 'the user needs a way forward');
});

// Element shape matters as much as the arrays themselves: these lists go
// STRAIGHT to merge.js's applyTombstones, which now — correctly — throws
// rather than reading junk as "nothing was deleted". Without the element
// check the user gets the generic "Something went wrong on this device"
// instead of a message naming a diagnosable cause.
test('an account blob carrying a junk record is reported as malformed, not as an unexplained crash', async () => {
  for (const bad of [
    { schemaVersion: SCHEMA_VERSION, items: [it('r')], feeds: [], tombstones: [null] },
    { schemaVersion: SCHEMA_VERSION, items: [null], feeds: [], tombstones: [] },
    { schemaVersion: SCHEMA_VERSION, items: [], feeds: ['not-a-feed'], tombstones: [] },
  ]) {
    const { host, syncCalls } = await setup({
      seed: () => { saveItems([it('local')]); },
      fetchImpl: async () => ({
        ok: true, status: 200, json: async () => ({ version: 2, blob: await encryptBlob(currentKey, bad) }),
      }),
    });
    assert.equal(syncCalls.length, 0);
    const text = allText(host);
    assert.doesNotMatch(text, /Something went wrong on this device/,
      'a junk element is a diagnosable condition, not an unexplained crash');
    assert.match(text, /incomplete/i);
  }
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

// --- a failure after the write must not claim nothing happened -------------
//
// syncOnce applies BEFORE the push loop, so 'offline', 'error' and 'conflict'
// are all reachable with the local write already landed. The panel said
// "Nothing has been combined yet" on every one of them, and on adopt-replace
// the local wipe is complete and irreversible by then — with Unlink offered
// right beside the false report, so the user can act on it. Same divergence
// class as round 3's Critical (a Cancel reversed while the panel said it was
// not), which this branch treated as blocking.

test('a failure AFTER the write says the device was combined; the same failure before it does not', async () => {
  for (const status of ['offline', 'error', 'conflict']) {
    const before = await setup({
      seed: () => { saveItems([it('local')]); },
      syncResults: [{ status, applied: false }],
      fetchImpl: async () => ({
        ok: true, status: 200, json: async () => ({ version: 4, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
      }),
    });
    findButton(before.host, 'Merge').click();
    await before.ui.settled();
    assert.match(allText(before.host), /nothing has been combined/i,
      `${status} before the write really did combine nothing`);

    const after = await setup({
      seed: () => { saveItems([it('local')]); },
      syncResults: [{ status, applied: true }],
      fetchImpl: async () => ({
        ok: true, status: 200, json: async () => ({ version: 4, blob: await encryptBlob(currentKey, st({ items: [it('r')] })) }),
      }),
    });
    findButton(after.host, 'Merge').click();
    await after.ui.settled();
    const text = allText(after.host);
    assert.doesNotMatch(text, /nothing has been combined/i,
      `${status} after applyState wrote must not report that nothing happened — on Replace the local wipe is already irreversible`);
    assert.match(text, /already been combined/i, `${status} must say what actually happened`);
    assert.match(text, /nothing is lost|next sync/i, 'and what happens next');
  }
});

// A table check rather than one hand-picked path: every status syncOnce can
// return with applied:true must be safe to show in that state. Without this,
// adding a status whose text claims "nothing has been combined" and forgetting
// its applied variant puts the defect straight back.
test('no failure message reachable after the write claims nothing was combined', () => {
  for (const status of ['offline', 'unauthorized', 'error', 'conflict', 'undecryptable']) {
    assert.doesNotMatch(failureText(status, true), /nothing (has been|was) combined/i,
      `${status} is returned by syncOnce after applyState may have written`);
  }
  // And the pre-write wording is still the honest one where it applies.
  assert.match(failureText('offline', false), /nothing has been combined/i);
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
    seed: () => {
      saveItems([it('keep')]);
      saveFeeds([fd('keepfeed')]);
      saveTombstones([{ id: 'deletedEarlier', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }]);
    },
  });
  findButton(host, 'Unlink').click();
  await ui.settled();
  assert.equal(isLinked(), false);
  assert.deepEqual(loadItems().map((i) => i.id), ['keep'], 'unlinking never deletes local data (spec 4.4)');
  assert.deepEqual(loadFeeds().map((f) => f.id), ['keepfeed']);
  // A wiped tombstone set resurrects every deleted record on the next link.
  // Task 4's ledger records the identical gap for auth.unlink.
  assert.deepEqual(loadTombstones().map((t) => t.id), ['deletedEarlier'],
    'tombstones are local data too — wiping them resurrects every deleted record on the next link');
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
    // Anchored on the LIBRARY's own message. The earlier /base64url|link/i
    // could not fail: the unlinked view's own copy says "Link this device",
    // "link code" and "linked", so replacing doLink's catch body with
    // `notice = ''` — the error completely swallowed — still passed.
    assert.match(allText(host), /Not a base64url string/,
      "crypto.js's own message must reach the user, not a generic one");
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
