import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { SCHEMA_VERSION } from '../js/merge.js';
import {
  saveItems, loadItems, saveTombstones, saveFeeds, loadFeeds, loadTombstones, loadSyncState,
  loadLaunches,
} from '../js/storage.js';
import { linkWithCode, clearAdoptionPending } from '../js/auth.js';
import { bytesToBase64url, TOKEN_BYTES } from '../js/crypto.js';
import { SYNC_STATUS_ID, SHELL_SYNC_STATUS_ID } from '../js/linkui.js';
import { addDays, startOfWeek } from '../js/timegrid.js';
import { formatDayLabel } from '../js/freshness.js';

// --- historical note: the js/linkui.js resolve hook -------------------------
//
// Until Task 8, this file registered an ESM resolve hook that redirected
// app.js's `import { renderSyncStatus } from './linkui.js'` to an in-memory
// stub, because js/linkui.js did not exist yet and Node's loader would
// otherwise throw ERR_MODULE_NOT_FOUND before any of app.js's module-scope
// code ran. js/linkui.js now exists, so the hook only ever took the
// nextResolve() path — dead code. It is REMOVED rather than left inert:
// while it was present, deleting or renaming js/linkui.js would have made
// this suite quietly fall back to the stub instead of failing, which is the
// same class of "assertion that cannot fail" defect DA-C4 flagged below.

// --- minimal fake DOM --------------------------------------------------
//
// app.js reaches for `document`/`window` at module scope (building its
// `els` cache, wiring initSettings, registering the storage/visibilitychange/
// online listeners, and calling render() once). Node has no DOM and this
// repo has no jsdom dependency (no new dependencies, per this task's
// constraints), so this fakes only the slice app.js's import graph actually
// touches. Modeled directly on tests/settings.test.js's fake DOM (Task 6),
// extended with:
//   - getElementById: app.js looks up ~30 ids by id, lazily creating one
//     FakeElement per id (settings.test.js only ever needed two, passed in
//     directly).
//   - querySelector: dayview.js reads back its own prior scroll position via
//     `container.querySelector('.day-grid')`.
//   - a `_listeners` escape hatch on document/window so this file can invoke
//     app.js's own registered storage-event listener directly (there is no
//     other way to dispatch a synthetic 'storage' event from Node).

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
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
      // The real classList.add THROWS InvalidCharacterError on a token
      // containing whitespace. itemTypeClass can now return two tokens
      // ('type-task done'), so a fake that silently accepted one would let a
      // call site pass in a browser-fatal string and stay green here.
      add(...cs) {
        for (const c of cs) {
          assert.doesNotMatch(String(c), /\s/, `classList.add token must not contain whitespace: "${c}"`);
          self._classes.add(c);
        }
      },
      remove(c) { self._classes.delete(c); },
      contains(c) { return self._classes.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !self._classes.has(c) : force;
        if (on) self._classes.add(c); else self._classes.delete(c);
      },
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

  set innerHTML(v) { if (v === '') this.children = []; }

  get childElementCount() { return this.children.length; }

  querySelectorAll(selector) {
    const tag = selector.toUpperCase();
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.tagName === tag) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    const isClass = selector.startsWith('.');
    const key = isClass ? selector.slice(1) : selector.toUpperCase();
    const matches = (el) => (isClass ? el._classes.has(key) : el.tagName === key);
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c)) return c;
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  click() { (this._listeners.click || []).forEach((fn) => fn({ target: this })); }

  // Harness only: records focus the way a browser reports it, so a test can
  // ask what the app focused, and with which options (sweep F: preventScroll).
  // Production code never reads this.
  focus(options) {
    globalThis.document.activeElement = this;
    globalThis.document.lastFocusOptions = options;
  }
}

function makeFakeDocument() {
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  const byId = new Map();
  const listeners = {};
  return {
    documentElement,
    body,
    activeElement: null,
    visibilityState: 'visible',
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement('div'));
      return byId.get(id);
    },
    createElement: (tag) => new FakeElement(tag),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    _listeners: listeners,
  };
}

function makeFakeWindow() {
  const listeners = {};
  return {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    _listeners: listeners,
  };
}

// Installed before the dynamic import below, per the brief: app.js reaches
// for `document`/`window` at module scope.
globalThis.window = makeFakeWindow();
globalThis.document = makeFakeDocument();

const item = (id, updatedAt) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });

// Recursively concatenates textContent across a FakeElement subtree — the
// only way to inspect what renderList() actually put on screen, since a
// list item's title lives on a nested <span>, not on the <li> itself.
function allText(el) {
  let out = el.textContent || '';
  for (const c of el.children) out += ` ${allText(c)}`;
  return out;
}

// --- V6 step 0: the shell indicator must be painted at LOAD ----------------
//
// THIS TEST MUST RUN FIRST IN THIS FILE. app.js's module-scope code runs
// exactly once, on the first import; every later test gets the cached module.
// So the storage state app.js sees at load is whatever this test seeds.
//
// Why load-time painting is the load-bearing wire, and not an optimisation:
// runSync's `finally` is the only other caller of renderSyncStatus, and
// runSync returns BEFORE its try/finally whenever `!isLinked() || isAdoptionPending()`
// (js/app.js:484). Those are exactly the two states step 0 exists to surface —
// a stuck adoption and a corrupt stored code (which makes isLinked() false).
// Without this call the indicator would light for everything EXCEPT the two
// failures it was built for. That early return must NOT be made to paint
// instead: tests/apply.test.js's "runSync does not proceed into its
// try/finally while adoption is pending" anchors the "never union silently"
// guard on renderSyncStatus NOT running there.
test('app.js paints the shell sync indicator at load, so a stuck adoption is visible with no sync', async () => {
  installFakeLocalStorage();
  // linkWithCode's bootstrap path always sets adoptionPending: true (spec 5.7).
  await linkWithCode(bytesToBase64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))));
  const shell = globalThis.document.getElementById(SHELL_SYNC_STATUS_ID);
  shell.hidden = true;
  shell.textContent = '';
  await import('../js/app.js');
  assert.equal(shell.hidden, false,
    'a device sitting at adoptionPending syncs nothing at all — the app shell must say so without opening Settings');
  assert.match(shell.textContent, /\S/);
  // Phase 0 baseline: a cold load is an open, and it is logged. Asserted here
  // because this is the only test that sees app.js's module-scope code run.
  assert.equal(loadLaunches().length, 1, 'loading the app must record one launch');
});

// applySyncedState must re-merge against live storage. Between the merge that
// produced `state` and this call there may have been a full PUT round trip.
test('applySyncedState keeps a record written after the state was computed', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  saveItems([item('a', '2026-08-01T00:00:00.000Z'), item('added-late', '2026-08-03T00:00:00.000Z')]);
  const written = applySyncedState(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }));
  assert.ok(written.items.some((i) => i.id === 'added-late'), 'a concurrent add must not be destroyed');
  assert.ok(loadItems().some((i) => i.id === 'added-late'));
});

test('applySyncedState honours a tombstone written after the state was computed', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  saveTombstones([{ id: 'a', kind: 'item', deletedAt: '2026-08-04T00:00:00.000Z' }]);
  // A second tombstone that arrives ONLY via the incoming state (never
  // written to local storage directly) — this is what actually exercises
  // the saveTombstones(written.tombstones) write below, not just the
  // pre-existing local write above surviving by coincidence.
  const remoteTombstone = { id: 'remote-deleted', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' };
  const written = applySyncedState(state({
    items: [item('a', '2026-08-01T00:00:00.000Z')],
    tombstones: [remoteTombstone],
  }));
  assert.deepEqual(written.items, [], 'a concurrent delete must not be undone');
  const storedTombstones = loadTombstones();
  assert.ok(storedTombstones.some((t) => t.id === 'a'), 'the pre-existing local tombstone must survive');
  assert.ok(storedTombstones.some((t) => t.id === 'remote-deleted'),
    'a tombstone that only arrived via the incoming state must actually be persisted, not merely returned');
});

test('applySyncedState returns what it wrote', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const written = applySyncedState(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }));
  assert.deepEqual(written.items.map((i) => i.id), loadItems().map((i) => i.id));
});

// --- opts.replace: a local discard, never a re-merge (mutation M2) ---------
//
// "Replace this device" means the user explicitly chose to drop local data.
// Re-merging here would union it straight back in, and sync.js would then
// push the resurrected data to the account being joined.
test('applySyncedState with opts.replace discards live storage instead of re-merging it back in', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  saveItems([item('live-only', '2026-08-01T00:00:00.000Z')]);
  const incoming = state({ items: [item('remote-only', '2026-08-01T00:00:00.000Z')] });
  const written = applySyncedState(incoming, { replace: true });
  assert.deepEqual(written.items.map((i) => i.id), ['remote-only']);
  assert.deepEqual(loadItems().map((i) => i.id), ['remote-only']);
});

// Replace's "nothing is tombstoned" guarantee depends on the ORDER of the
// applyRemoteFeeds()/saveTombstones() calls inside applySyncedState:
// applyRemoteFeeds's own removeFeed() writes a real tombstone for every local
// feed the replace discards, and the full-overwrite saveTombstones() that
// runs immediately after is what erases it (see the comment at the two call
// sites in js/app.js). Swapping those two lines would leave the tombstone in
// place and push that deletion to the account being joined on the next sync.
test('applySyncedState with opts.replace leaves no tombstone for a feed the replace discarded', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const feedX = {
    id: 'feedX', url: 'https://example.com/x.ics', name: 'X', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  saveFeeds([feedX]);
  applySyncedState(state({ feeds: [] }), { replace: true });
  assert.deepEqual(loadFeeds(), [], 'the local-only feed must be gone after replace');
  assert.deepEqual(loadTombstones(), [],
    'replace must not leave a tombstone for data it discarded locally — that would push the deletion to the account being joined');
});

// --- applyRemoteFeeds must get the COMPLETE merged list (mutation M5) ------
//
// applyRemoteFeeds deletes+tombstones every local feed absent from its
// argument. A feed that exists only on this device (never mentioned by the
// incoming remote state, never tombstoned) must still be in the union merge()
// produces, and applySyncedState must hand THAT complete list onward — not
// some partial slice (e.g. just what's new) — or an ordinary sync would
// silently propagate a deletion of every other feed on every device.
test('applySyncedState keeps a feed that exists only locally through an ordinary sync', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const feedX = {
    id: 'feedX', url: 'https://example.com/x.ics', name: 'X', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  saveFeeds([feedX]);
  applySyncedState(state({ feeds: [] }));
  assert.deepEqual(loadFeeds().map((f) => f.id), ['feedX']);
});

// --- a newly pulled feed must actually be fetched, not just stored ---------
//
// applyRemoteFeeds only writes plaenicke.feeds; it never touches the feed
// cache. app.js's background syncStale runs once, at module load, over the
// feed list from that moment — so without applySyncedState routing a freshly
// pulled feed's id through that same path, a device that just linked (or
// pulled a newly-added feed from another device) would show the right
// subscription with ZERO events until a full page reload.
test('applySyncedState fetches a feed the device has never seen before, immediately', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  // A raw wire-form feed — no color/hidden — exactly what arrives over sync
  // (merge.js's pickFeed marks a first-seen feed this way; toWire strips
  // both fields entirely before a push).
  const newFeed = {
    id: 'feedNew', url: 'https://example.com/new.ics', name: 'New', updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, text: async () => '' }; };
  try {
    applySyncedState(state({ feeds: [newFeed] }));
    // backgroundSyncFeeds's fetch call happens synchronously up to its own
    // first await inside syncFeed — this tick is a safety margin only, not
    // load-bearing for the assertion below.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(
    calls.some((u) => u.includes('/feed?url=') && u.includes(encodeURIComponent(newFeed.url))),
    'a feed the device just learned about via sync must be fetched immediately, not only at next page load',
  );
});

// --- cross-tab storage listener is narrowed to the three data keys (M4) ----
//
// plaenicke.syncState is written on every sync tick. If the listener were
// widened back to a bare startsWith('plaenicke.') prefix it would treat that
// tick as a cross-tab data change and force a full reload+re-render in every
// other open tab, every ~few seconds while linked.
test('the storage listener ignores plaenicke.syncState and only reacts to the three data keys', async () => {
  installFakeLocalStorage();
  await import('../js/app.js'); // cached after the first test; listener already registered
  const storageListeners = globalThis.window._listeners.storage;
  assert.ok(storageListeners && storageListeners.length > 0, 'expected a storage listener to be registered');

  // Write a distinguishable item straight to storage, bypassing app.js's own
  // `items` variable — this simulates another tab's write landing while this
  // one is open.
  saveItems([item('cross-tab-item', '2026-08-01T00:00:00.000Z')]);
  const list = globalThis.document.getElementById('item-list');

  for (const fn of storageListeners) fn({ key: 'plaenicke.syncState' });
  assert.ok(!allText(list).includes('t-cross-tab-item'), 'a syncState-only write must not trigger a reload/re-render');

  for (const fn of storageListeners) fn({ key: 'plaenicke.items' });
  assert.ok(allText(list).includes('t-cross-tab-item'), 'an items write must trigger a reload/re-render');

  // The listener reloads items/feeds/feedCache regardless of WHICH of the
  // three data keys fired — so a distinguishable item is enough to prove
  // 'plaenicke.feeds' and 'plaenicke.syncTombstones' are each still in the
  // allowlist, not just 'plaenicke.items' (a narrowing regression that
  // dropped the other two would otherwise pass silently).
  saveItems([item('cross-tab-item-feeds-key', '2026-08-01T00:00:00.000Z')]);
  for (const fn of storageListeners) fn({ key: 'plaenicke.feeds' });
  assert.ok(allText(list).includes('t-cross-tab-item-feeds-key'), 'a plaenicke.feeds write must also trigger a reload/re-render');

  saveItems([item('cross-tab-item-tombstones-key', '2026-08-01T00:00:00.000Z')]);
  for (const fn of storageListeners) fn({ key: 'plaenicke.syncTombstones' });
  assert.ok(allText(list).includes('t-cross-tab-item-tombstones-key'), 'a plaenicke.syncTombstones write must also trigger a reload/re-render');
});

// --- a calendar added or removed in Settings must actually PUSH ------------
//
// scheduleSync had exactly three call sites in app.js — addItems, deleteItem
// and runSync's pending re-arm — and onFeedsChanged was not one of them. A
// subscription added or removed on the laptop therefore sat unpushed until the
// next page load, `visibilitychange` or `online` event; closing the settings
// modal fires none of those. Items pushed in 2s and feeds never pushed at all,
// and a feed URL is the one record in this app that nothing on screen can
// restore.
//
// Driven through the REAL settings panel that app.js mounts at module scope,
// so this pins the WIRE (app.js -> initSettings -> onSyncedDataChanged ->
// scheduleSync), not just settings.js's own classification.
test('removing a calendar in Settings pushes it, without waiting for a reload', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js'); // cached; initSettings already wired to els.settingsBtn
  await linkWithCode(bytesToBase64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))));
  clearAdoptionPending(); // steady state — the adoption dialog is a different path

  saveFeeds([{
    id: 'feedGone', url: 'https://example.com/gone.ics', name: 'Gone',
    color: 'var(--feed-palette-1)', hidden: false, updatedAt: '2026-08-01T00:00:00.000Z',
  }]);

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }), text: async () => '' };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const settingsBtn = globalThis.document.getElementById('settings-btn');
    for (const fn of settingsBtn._listeners.click || []) fn({ target: settingsBtn });
    const host = globalThis.document.getElementById('settings-host');
    const remove = host.querySelectorAll('button').find((b) => b.textContent === 'Remove');
    assert.ok(remove, 'fixture check: the open panel must offer a Remove button for the seeded calendar');

    remove.click();
    assert.deepEqual(loadFeeds(), [], 'fixture check: the calendar really was removed');
    assert.deepEqual(requests.filter((r) => r.url.includes('/data')), [],
      'the push is debounced, so nothing may go out before the timer fires');

    t.mock.timers.tick(2000);
    // runSync -> syncOnce is async; let its awaits drain against the real
    // microtask queue (only setTimeout is mocked).
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }

  assert.ok(requests.some((r) => r.url.includes('/data') && r.method === 'GET'),
    'removing a calendar must schedule a sync — nothing else pushes the feed tombstone until the page is reloaded');
  assert.ok(requests.some((r) => r.url.includes('/data') && r.method === 'PUT'),
    'and the tombstone must actually reach the account');
});

// =========================================================================
// V6 — the To-do page, the Ideas page, and the checkbox write
// =========================================================================
//
// These drive the REAL app.js — its els cache, its showView table, its
// render(), and its module-scope `items` array — so they pin the WIRE, not
// just the pure helpers underneath. Every defect the V5 ledger records as
// "found by independent review and not by the author's own battery" was a
// wiring gap, not a logic gap.

// THE FAKE DOCUMENT ABOVE LAZILY CREATES AN ELEMENT FOR ANY ID, so nothing in
// this file can notice that index.html is missing one. In a real browser a
// missing id makes els.<name> null and app.js THROWS at module scope — on the
// listener wiring, before render() ever runs — so the whole app is dead, not
// merely one page. Adding a page to app.js and forgetting the markup is
// exactly that, and it stayed green through the whole V6 battery until this
// existed.
//
// Derived from app.js's own source rather than a hand-written list, so a page
// added later is covered without anyone remembering to extend this.
test('index.html mounts every element app.js looks up by id', () => {
  const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ids = [...appSrc.matchAll(/document\.getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 20, `fixture check: expected app.js to look up many ids, found ${ids.length}`);
  for (const id of ids) {
    assert.match(html, new RegExp(`id="${id}"`),
      `index.html has no #${id} — app.js would hold null there and throw at load`);
  }
});

const ideaText = () => globalThis.document.getElementById('idea-text');
const ideaAdd = () => globalThis.document.getElementById('idea-add');
const todoList = () => globalThis.document.getElementById('todo-list');
const ideaList = () => globalThis.document.getElementById('idea-list');
const itemList = () => globalThis.document.getElementById('item-list');

// As a browser does, a click on a submit button (the sheet's Save) also
// submits its form, and a submission nothing cancelled would navigate away.
function click(el) {
  (el._listeners.click || []).forEach((fn) => fn({ target: el }));
  if (el.tagName === 'BUTTON' && el.type === 'submit') {
    let form = el.parentNode;
    while (form && form.tagName !== 'FORM') form = form.parentNode;
    assert.ok(form, 'a submit button outside any form submits nothing');
    let prevented = false;
    (form._listeners.submit || []).forEach((fn) => fn({ target: form, preventDefault() { prevented = true; } }));
    assert.ok(prevented, 'the form submission was not cancelled; the page would navigate');
  }
}

function fire(el, type) { (el._listeners[type] || []).forEach((fn) => fn({ target: el })); }

// Walks for the first checkbox whose aria-label names this title.
function checkboxFor(root, title) {
  const found = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (c.tagName === 'INPUT' && c.type === 'checkbox' && (c.getAttribute('aria-label') || '').includes(title)) {
        found.push(c);
      }
      walk(c);
    }
  };
  walk(root);
  return found[0] || null;
}

const record = (o) => ({
  title: 'x', date: '2026-08-20', time: null, endTime: null, type: 'general',
  createdAt: '2026-08-19', updatedAt: '2026-08-19T00:00:00.000Z',
  project: null, subject: null, category: null, done: false, notes: null, ...o,
});

// app.js keeps its own module-scope `items` snapshot and saves from it — that
// is the ownership invariant, and it means a bare saveItems() leaves app.js
// holding the PREVIOUS test's array and writing it straight back over the
// seed. Reload it the way the app itself does, through the cross-tab storage
// listener, which also re-renders. (The module is imported once for the whole
// file, so state genuinely carries between tests.)
function seed(records) {
  saveItems(records);
  for (const fn of globalThis.window._listeners.storage) fn({ key: 'plaenicke.items' });
  assert.deepEqual(loadItems().map((i) => i.id), records.map((i) => i.id), 'fixture check: the seed is what is stored');
}

// showView drives two PARALLEL object literals — one of sections, one of
// buttons — and a page missing from either is silent. Missing from `views`,
// the button hides every other section and never un-hides its own: a blank
// page. Missing from `buttons`, the nav never shows which page you are on.
// Both are invisible to any test that only inspects list contents.
test('each nav button reveals exactly its own page, and marks itself active', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const pages = [
    ['show-list', 'list-view'],
    ['show-month', 'calendar-view'],
    ['show-week', 'week-view'],
    ['show-day', 'day-view'],
    ['show-todo', 'todo-view'],
    ['show-ideas', 'ideas-view'],
  ];
  for (const [buttonId, sectionId] of pages) {
    click(globalThis.document.getElementById(buttonId));
    for (const [otherButton, otherSection] of pages) {
      const section = globalThis.document.getElementById(otherSection);
      const button = globalThis.document.getElementById(otherButton);
      const isTarget = otherSection === sectionId;
      assert.equal(section.hidden, !isTarget,
        `after clicking #${buttonId}, #${otherSection} should be ${isTarget ? 'visible' : 'hidden'}`);
      assert.equal(button._classes.has('active'), isTarget,
        `after clicking #${buttonId}, #${otherButton} should${isTarget ? '' : ' not'} be active`);
    }
  }
  click(globalThis.document.getElementById('show-list')); // leave the default view selected
});

test('the To-do page lists open to-dos, and nothing else', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'task1', type: 'task', title: 'Renew the passport' }),
    record({ id: 'due1', type: 'due', title: 'Physics essay' }),
    record({ id: 'start1', type: 'start', title: 'Start the essay' }),
    record({ id: 'ms1', type: 'milestone', title: 'First draft' }),
    record({ id: 'done1', type: 'task', title: 'Already finished', done: true }),
    record({ id: 'ev1', type: 'event', title: 'Dentist appointment' }),
    record({ id: 'gen1', type: 'general', title: 'Someones birthday' }),
    record({ id: 'idea1', type: 'idea', title: 'Rework the shelves' }),
  ]);
  const text = allText(todoList());
  for (const t of ['Renew the passport', 'Physics essay', 'Start the essay', 'First draft']) {
    assert.match(text, new RegExp(t), `${t} is actionable and belongs on the To-do page`);
  }
  assert.doesNotMatch(text, /Already finished/, 'a completed to-do leaves the To-do page');
  assert.doesNotMatch(text, /Dentist appointment/, 'an appointment is not a to-do');
  assert.doesNotMatch(text, /Someones birthday/, 'a general item is not a to-do — birthdays are not chores');
  assert.doesNotMatch(text, /Rework the shelves/, 'an idea is not a to-do');
});

// § 5: soonest first. The comparator is items.js's sortItemsByDate — the
// repo's SINGLE ordering rule, reused rather than restated, because § 7.6
// already flags one drifting second copy of it in feeds.js and a third would
// be worse than the small extra it applies (untimed before timed on the same
// day, then createdAt, then title).
test('the To-do page is ordered soonest first, whatever order storage holds', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'c', type: 'task', title: 'Latest', date: '2026-12-01' }),
    record({ id: 'a', type: 'task', title: 'Soonest', date: '2026-09-01' }),
    record({ id: 'b', type: 'task', title: 'Middle', date: '2026-10-01' }),
  ]);
  assert.match(allText(todoList()), /Soonest[\s\S]*Middle[\s\S]*Latest/,
    'an unsorted to-do list buries whatever is due next');
});

// A COMPLETED TO-DO STAYS ON THE CALENDAR (spec § 3.3) — it still happened
// that day. Only the To-do page drops it.
test('a completed to-do stays in the list view, styled as done', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'done1', type: 'task', title: 'Already finished', done: true, date: '2099-01-01' })]);
  assert.match(allText(itemList()), /Already finished/, 'a done to-do must not vanish from the calendar');
  const row = itemList().children.find((li) => allText(li).includes('Already finished'));
  assert.ok(row._classes.has('done'), 'and it must be styled as completed');
  assert.ok(row._classes.has('type-task'), 'without losing its type colour');
});

// § 7.1/§ 7.2: visibleItems is the single chokepoint feeding list, month, week
// and day. renderList calls sortItemsByDate(visibleItems(...)) DIRECTLY —
// groupItemsByDate is never involved — so this one filter is what covers it.
test('an idea never appears on any calendar view', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'idea1', type: 'idea', title: 'Rework the shelves', date: '2099-01-01' }),
    record({ id: 'ev1', type: 'event', title: 'Dentist appointment', date: '2099-01-01' }),
  ]);
  assert.doesNotMatch(allText(itemList()), /Rework the shelves/, 'the list view must not show ideas');
  assert.match(allText(itemList()), /Dentist appointment/, 'fixture check: the same date DOES render');
  assert.doesNotMatch(allText(globalThis.document.getElementById('calendar-grid')), /Rework the shelves/);
  assert.doesNotMatch(allText(globalThis.document.getElementById('week-grid')), /Rework the shelves/);
});

test('the Ideas page lists ideas and nothing else, newest first', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'i1', type: 'idea', title: 'Older thought', createdAt: '2026-08-01', date: '2026-08-01' }),
    record({ id: 'i2', type: 'idea', title: 'Newer thought', createdAt: '2026-08-05', date: '2026-08-05' }),
    record({ id: 't1', type: 'task', title: 'Renew the passport' }),
  ]);
  const text = allText(ideaList());
  assert.doesNotMatch(text, /Renew the passport/, 'a task is not an idea');
  assert.match(text, /Newer thought[\s\S]*Older thought/, 'newest capture first');
});

// THE WRITE LANDS IN app.js, mutating its module-scope `items` array, then
// saveItems / render / scheduleSync — the same shape as deleteItem. That is
// the ownership invariant; a writer anywhere else is silently overwritten the
// next time app.js saves from its own snapshot.
test('ticking a to-do writes done to storage and re-renders both pages', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'task1', type: 'task', title: 'Renew the passport', date: '2099-01-01' }),
    record({ id: 'task2', type: 'task', title: 'Book the car service', date: '2099-01-01' }),
  ]);
  const box = checkboxFor(todoList(), 'Renew the passport');
  assert.ok(box, 'fixture check: the To-do page must offer a checkbox for the item');
  box.checked = true;
  fire(box, 'change');

  const stored = loadItems();
  assert.equal(stored.find((i) => i.id === 'task1').done, true, 'the tick must reach storage');
  assert.equal(stored.find((i) => i.id === 'task2').done, false, 'and must not touch its neighbour');
  assert.doesNotMatch(allText(todoList()), /Renew the passport/, 'the completed item leaves the To-do page');
  assert.match(allText(itemList()), /Renew the passport/, 'and stays on the calendar');
});

// § 5.1, the horn that was CHOSEN. unionById's ties go to REMOTE (`>=`), so a
// toggle that left updatedAt alone would be silently REVERTED on the next
// sync — self-reverting, not self-correcting. The resurrection risk that
// bumping creates is documented in js/merge.js's header and accepted; a toggle
// that does NOT bump is simply broken.
test('ticking a to-do bumps updatedAt, or the tick is reverted by the next sync', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const before = '2026-08-19T00:00:00.000Z';
  seed([record({ id: 'task1', type: 'task', title: 'Renew the passport', updatedAt: before })]);
  const box = checkboxFor(todoList(), 'Renew the passport');
  box.checked = true;
  fire(box, 'change');
  const after = loadItems().find((i) => i.id === 'task1').updatedAt;
  assert.notEqual(after, before);
  assert.ok(Date.parse(after) > Date.parse(before), 'updatedAt must move FORWARD, not merely change');
  assert.match(after, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'a day-only updatedAt loses ties against a same-day tombstone deletedAt');
});

// A tick is a change to SYNCED data. Without a push trigger it would sit
// unsent until a reload, a visibilitychange or an online event — the same
// class of defect as the feed change that had no push trigger at all.
test('ticking a to-do schedules a sync', async (t) => {
  installFakeLocalStorage();
  const { render } = await import('../js/app.js');
  await linkWithCode(bytesToBase64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))));
  clearAdoptionPending();
  seed([record({ id: 'task1', type: 'task', title: 'Renew the passport' })]);

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }), text: async () => '' };
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const box = checkboxFor(todoList(), 'Renew the passport');
    box.checked = true;
    fire(box, 'change');
    assert.deepEqual(requests.filter((r) => r.url.includes('/data')), [],
      'the push is debounced, so nothing may go out before the timer fires');
    t.mock.timers.tick(2000);
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
  assert.ok(requests.some((r) => r.url.includes('/data') && r.method === 'PUT'),
    'a completed to-do must reach the account without waiting for a reload');
});

// The Ideas page's own capture box: offline, deterministic, and the fallback
// when the Worker is unreachable (spec § 6).
test('the Ideas box captures a short thought as an idea dated today', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  ideaText().value = '  Look into a standing desk  ';
  click(ideaAdd());

  const stored = loadItems();
  assert.equal(stored.length, 1);
  const [idea] = stored;
  assert.equal(idea.type, 'idea');
  assert.equal(idea.title, 'Look into a standing desk');
  assert.equal(idea.notes, null, 'a short thought needs no separate body');
  assert.equal(idea.done, false);
  assert.match(idea.date, /^\d{4}-\d{2}-\d{2}$/, "an idea's date is its capture date and is NEVER null");
  assert.equal(idea.date, idea.createdAt, 'the capture date IS today');
  assert.equal(ideaText().value, '', 'the box must clear so the next thought does not append to this one');
  assert.match(allText(ideaList()), /standing desk/);
});

test('the Ideas box keeps the complete text of a long thought in notes', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const full = 'Rework the kitchen shelves. They are far too deep for the mugs and everything at the back '
    + 'is unreachable, so half of the cupboard is wasted entirely.';
  ideaText().value = full;
  click(ideaAdd());

  const [idea] = loadItems();
  assert.equal(idea.title, 'Rework the kitchen shelves.', 'the title is a derived label');
  assert.equal(idea.notes, full, 'and the COMPLETE original text is kept, so no split bug can lose words');
});

// makeItem's own "Title is required" throw is a second net under this, so
// "nothing was saved" alone does not distinguish the guard being present from
// it being absent. What the guard is FOR is the message: an empty box should
// be told what to do, not shown a validation error about a field it does not
// know it has.
test('the Ideas box refuses an empty thought, with guidance rather than a validation error', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  ideaText().value = '   ';
  click(ideaAdd());
  assert.deepEqual(loadItems(), [], 'whitespace is not a thought');
  const message = globalThis.document.getElementById('message').textContent;
  assert.match(message, /thought/i, 'the empty box must be told what to do');
  assert.doesNotMatch(message, /required/i, 'a raw field-validation error is not guidance');
});

// The model classifies (spec § 3.3), so an idea arriving through the MAIN
// entry box must get the same treatment as one typed on the Ideas page — one
// split function, both paths.
test('an idea returned by the model is normalised through the same split', async () => {
  installFakeLocalStorage();
  const { addItems } = await import('../js/app.js');
  seed([]);
  const full = 'Rework the kitchen shelves. They are far too deep for the mugs and everything at the back '
    + 'is unreachable, so half of the cupboard is wasted entirely.';
  addItems([{
    title: 'a label the model invented', date: '2026-08-20', type: 'idea',
    time: null, endTime: null, project: null, subject: null, category: null, notes: full,
  }]);
  const [idea] = loadItems();
  assert.equal(idea.title, 'Rework the kitchen shelves.');
  assert.equal(idea.notes, full);
});

// --- runSync must not run while adoption is pending (mutation M3) ----------
//
// sync.js's syncOnce has its OWN internal isAdoptionPending() check and
// refuses to touch the network either way — so this mutation cannot be caught
// by asserting "no fetch call happened". The only externally observable
// effect of app.js's own guard is that a correctly-guarded runSync returns
// BEFORE its try/finally, so renderSyncStatus is never called; remove the
// guard and isLinked() alone lets it fall through into syncOnce (which
// resolves immediately, harmlessly, with status 'adoption-required') and then
// into the finally block, which DOES call renderSyncStatus.
//
// RE-ANCHORED IN TASK 8 (DA-C4). This assertion used to count calls into the
// in-memory stub the removed resolve hook installed while js/linkui.js was
// absent. That hook was correctly self-healing, so landing Task 8 deleted the
// stub and the counter could never move again — converting the only live
// guard on "never union silently" into a permanently green assertion.
// Measured: with the real js/linkui.js present and the guard removed, the old
// version passed 9/9.
//
// The re-anchor is the real renderSyncStatus's own observable effect: it
// paints the element whose id is SYNC_STATUS_ID. Seed that element with a
// sentinel; if runSync reaches its finally, the sentinel is overwritten.
//
// ALSO MEASURED, and the reason the two checks below are belt-and-braces
// rather than the anchor: neither a fetch spy nor loadSyncState() can
// distinguish this mutation on its own. syncOnce's own gate check
// (js/sync.js:81) returns BEFORE resetSyncStateIfDeviceChanged and before any
// network call, so with app.js's guard removed there is still no request and
// still no write. They are kept only to prove no real network call escapes,
// in case that reasoning about sync.js is ever wrong.
const SENTINEL = 'sentinel: renderSyncStatus has not run';

test('runSync does not proceed into its try/finally while adoption is pending', async () => {
  installFakeLocalStorage();
  await import('../js/app.js'); // cached after the first test; online listener already registered

  // linkWithCode's bootstrap path accepts any base64url string of exactly
  // TOKEN_BYTES bytes and always sets adoptionPending: true (spec 5.7) — this
  // device has not yet been offered Merge / Replace / Cancel.
  const token = bytesToBase64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  await linkWithCode(token);

  const statusEl = globalThis.document.getElementById(SYNC_STATUS_ID);
  statusEl.textContent = SENTINEL;
  const syncStateBefore = JSON.stringify(loadSyncState());

  const onlineListeners = globalThis.window._listeners.online;
  assert.ok(onlineListeners && onlineListeners.length > 0, 'expected an online listener to be registered');

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    requests.push(String(url));
    throw new Error('unexpected network call while adoption is pending');
  };
  try {
    for (const fn of onlineListeners) await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(statusEl.textContent, SENTINEL,
    'runSync must return before its try/finally while adoption is pending, so renderSyncStatus must never repaint the status line');
  assert.deepEqual(requests.filter((u) => u.includes('/data')), [],
    'nothing may be pulled or pushed before the user has chosen Merge / Replace / Cancel');
  assert.equal(JSON.stringify(loadSyncState()), syncStateBefore,
    'a sync that must not run must not move the cursor either');
});

// --- Phase 0: the app opens on today, and stays on today across a resume ----
//
// iOS resumes a home-screen web app rather than reloading it. app.js used to
// compute its day cursor and fetch calendar feeds ONLY at module load, so an
// app opened at 23:00 and resumed at 08:00 showed yesterday, with yesterday's
// calendar data. These tests fire the real visibilitychange listener with a
// mocked clock a day ahead.

const DAY_LABEL_OPTS = { weekday: 'short', month: 'short', day: 'numeric' };
const labelFor = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toLocaleDateString('en-US', DAY_LABEL_OPTS);
const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function resume() {
  for (const fn of globalThis.document._listeners.visibilitychange || []) fn();
}

test('index.html opens on the Day view, not the List', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="show-day"[^>]*class="active"/, 'the Day button must be the active one on load');
  assert.doesNotMatch(html, /<button id="show-list"[^>]*class="active"/, 'List must no longer be the default');
  assert.match(html, /<section id="day-view"(?![^>]*hidden)[^>]*>/, 'the Day section must be visible on load');
  assert.match(html, /<section id="list-view"[^>]*hidden/, 'the List section must start hidden');
});

test('resuming the next morning moves the Day view to the new today', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const realNow = Date.now();
  const dayLabel = globalThis.document.getElementById('day-label');
  assert.equal(dayLabel.textContent, labelFor(new Date(realNow)), 'fixture check: the Day view starts on today');
  t.mock.timers.enable({ apis: ['Date'], now: realNow + 24 * 60 * 60 * 1000 });
  try {
    resume();
    assert.equal(dayLabel.textContent, labelFor(new Date(Date.now())),
      'a Day view that was showing today must follow the clock across a resume');
  } finally {
    t.mock.timers.reset();
  }
  // And back again, so later tests see today. This also proves the cursor
  // follows in both directions from whatever app.js last thought today was.
  resume();
  assert.equal(dayLabel.textContent, labelFor(new Date()));
});

test('resuming leaves a Day view the user moved elsewhere where they put it', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const dayLabel = globalThis.document.getElementById('day-label');
  click(globalThis.document.getElementById('next-day'));
  click(globalThis.document.getElementById('next-day'));
  const moved = dayLabel.textContent;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 });
  try {
    resume();
    assert.equal(dayLabel.textContent, moved, 'a day the user navigated to is not today, and must not jump');
  } finally {
    t.mock.timers.reset();
  }
  // Resume at the real time BEFORE navigating back. Every render catches up
  // with the clock (sweep D4), and app.js still believes "today" is the mocked
  // tomorrow: the first prev-day would land on that day and be carried along.
  resume();
  click(globalThis.document.getElementById('prev-day'));
  click(globalThis.document.getElementById('prev-day'));
  assert.equal(dayLabel.textContent, labelFor(new Date()), 'restored for later tests');
});

test('resuming re-fetches calendar feeds whose cache is stale', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const feed = { id: 'feedR', url: 'https://example.com/r.ics', name: 'R', color: 'var(--feed-palette-1)', hidden: false, updatedAt: '2026-08-01T00:00:00.000Z' };
  saveFeeds([feed]);
  for (const fn of globalThis.window._listeners.storage) fn({ key: 'plaenicke.feeds' });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, text: async () => '' }; };
  try {
    resume();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(calls.some((u) => u.includes('/feed?url=') && u.includes(encodeURIComponent(feed.url))),
    'a resume must refresh stale calendars, not leave last night\'s data on screen');
  saveFeeds([]);
  for (const fn of globalThis.window._listeners.storage) fn({ key: 'plaenicke.feeds' });
});

// Sweep S-12: these assert the DIFFERENCE a resume makes. Run alone (with
// --test-name-pattern), the import below is app.js's first, so module load has
// already logged one launch of its own; an absolute count passed only in a
// full-file run. Sweep S-9: the stamp is pinned to an exact local time with a
// mocked Date, not a shape.
test('resuming records a launch and stamps when the screen was refreshed', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const stamp = globalThis.document.getElementById('updated-stamp');
  stamp.textContent = '';
  const before = loadLaunches().length;
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 23, 9, 5).getTime() });
  try {
    resume();
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(loadLaunches().length - before, 1, 'each resume is an open, for the Phase 0 baseline');
  assert.equal(stamp.textContent, 'Updated 9:05 AM', 'with no calendars, the stamp is the time of the render');
  resume(); // back to the real today, for later tests
});

test('a hidden-tab visibilitychange is not a launch and does not refresh', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const before = loadLaunches().length;
  globalThis.document.visibilityState = 'hidden';
  try {
    resume();
  } finally {
    globalThis.document.visibilityState = 'visible';
  }
  assert.equal(loadLaunches().length - before, 0);
});

test('the List shows human dates, with today named as Today', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const today = localISO(new Date());
  seed([record({ id: 'h1', title: 'Dentist', date: today })]);
  assert.match(allText(itemList()), /Today — Dentist/);
  assert.doesNotMatch(allText(itemList()), new RegExp(`${today} — Dentist`), 'raw ISO dates must not reach the screen');
  seed([]);
});

test('the To-do page shows human dates too', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const today = localISO(new Date());
  seed([record({ id: 'h2', title: 'Essay', date: today, type: 'task' })]);
  assert.match(allText(todoList()), /Today — Essay/);
  seed([]);
});

// =========================================================================
// Edit-items Task 4a — tapping an item opens its sheet
// =========================================================================
//
// These drive the REAL app.js: its renderList / renderDay / renderTodos /
// renderIdeas each hand the view an onOpen, and openItem builds the sheet's
// options. A view test alone cannot see a call site that passes a no-op.
// Every id here is prefixed `open-`: the module is imported once per file, so
// state carries between tests. Each test closes the sheet it opened.

const sheetHost = () => globalThis.document.getElementById('sheet-host');
const dayBody = () => globalThis.document.getElementById('day-body');
const messageText = () => globalThis.document.getElementById('message').textContent;

// The .item-open control of the first row under `root` whose text mentions `title`.
function openControlFor(root, title) {
  const found = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (c.tagName === 'BUTTON' && c._classes.has('item-open') && (c.textContent || '').includes(title)) found.push(c);
      walk(c);
    }
  };
  walk(root);
  return found[0] || null;
}

function closeSheet() {
  const host = sheetHost();
  const btn = host.querySelector('.sheet-cancel') || host.querySelector('.sheet-close');
  if (btn) click(btn);
  assert.equal(host.children.length, 0, 'fixture check: the sheet closed');
}

// Cleanup for `finally`: never asserts, so a failing test cannot leave its
// sheet mounted and cascade into the next one.
function forceCloseSheet() {
  const host = sheetHost();
  const btn = host.querySelector('.sheet-cancel') || host.querySelector('.sheet-close');
  if (btn) click(btn);
}

// Every string a node exposes: text, attributes, and plain properties such as
// href, value, target — anything a real DOM could show or send.
function stringsOf(root) {
  const out = [];
  const visit = (el) => {
    for (const [k, v] of Object.entries(el)) {
      if (k === 'children' || k === 'parentNode' || k === '_listeners') continue;
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object' && !(v instanceof Set)) {
        for (const x of Object.values(v)) if (typeof x === 'string') out.push(x);
      }
    }
    out.push(...el._classes);
    for (const c of el.children) visit(c);
  };
  visit(root);
  return out;
}

const localTodayCompact = () => localISO(new Date()).replace(/-/g, '');

function seedFeed(feed) {
  saveFeeds([feed]);
  localStorage.setItem('plaenicke.feedCache', JSON.stringify({
    [feed.id]: {
      fetchedAt: new Date().toISOString(),
      events: [{
        uid: 'open-e1', title: 'Standup from the feed', form: 'DATE',
        dtstart: { value: localTodayCompact(), tzid: null },
        dtend: null, duration: null, rrule: null, exdates: [], recurrenceId: null,
      }],
      skipped: [],
    },
  }));
  for (const fn of globalThis.window._listeners.storage) fn({ key: 'plaenicke.feeds' });
}

function unseedFeeds() {
  saveFeeds([]);
  localStorage.removeItem('plaenicke.feedCache');
  for (const fn of globalThis.window._listeners.storage) fn({ key: 'plaenicke.feeds' });
}

test('open: tapping an item in the List opens its sheet in #sheet-host', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'open-list1', title: 'Open me from the list', date: '2099-02-01' })]);
  assert.equal(sheetHost().children.length, 0, 'fixture check: no sheet before the tap');
  const btn = openControlFor(itemList(), 'Open me from the list');
  assert.ok(btn, 'the list row must offer an .item-open control');
  click(btn);
  assert.ok(sheetHost().querySelector('.sheet'), 'a .sheet must be mounted in #sheet-host');
  assert.equal(sheetHost().querySelector('.sheet-title').value, 'Open me from the list', 'and it is THIS item');
  closeSheet();
  seed([]);
});

// Each render call site passes its own onOpen; a no-op at any one of them
// would leave that page's titles dead and every view test green.
test('open: the Day, To-do and Ideas pages each open the sheet too', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const today = localISO(new Date());
  seed([
    record({ id: 'open-task1', type: 'task', title: 'Open me as a task', date: today }),
    record({ id: 'open-idea1', type: 'idea', title: 'Open me as an idea', date: today }),
  ]);
  for (const [name, root, title] of [
    ['Day', dayBody(), 'Open me as a task'],
    ['To-do', todoList(), 'Open me as a task'],
    ['Ideas', ideaList(), 'Open me as an idea'],
  ]) {
    const btn = openControlFor(root, title);
    assert.ok(btn, `the ${name} page must offer an .item-open control`);
    click(btn);
    assert.ok(sheetHost().querySelector('.sheet'), `tapping on the ${name} page must mount a sheet`);
    closeSheet();
  }
  seed([]);
});

test("open: an external item's sheet names its calendar and never contains the feed URL", async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const url = 'https://example.com/private/open-SECRET-TOKEN-123/basic.ics';
  seedFeed({
    id: 'open-feed1', url, name: 'Work calendar', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  try {
    const btn = openControlFor(itemList(), 'Standup from the feed');
    assert.ok(btn, 'fixture check: the feed event is listed with an open control');
    click(btn);
    const host = sheetHost();
    assert.ok(host.querySelector('.sheet'), 'the read-only sheet must mount');
    assert.match(allText(host), /From Work calendar/, 'the sheet says which calendar the event came from');
    const strings = stringsOf(host);
    assert.ok(strings.length > 10, 'fixture check: the walk actually collected the tree');
    // Secrets F4: and nowhere else the app writes text on this path.
    strings.push(...stringsOf(globalThis.document.getElementById('message')), ...stringsOf(toastHost()));
    for (const s of strings) {
      assert.ok(!s.includes(url) && !s.includes('open-SECRET-TOKEN-123'),
        `the feed URL is a capability token and must appear nowhere in the sheet; found it in ${JSON.stringify(s)}`);
    }
    assert.equal(host.querySelector('.sheet-google'), null, 'a non-Google feed gets no Google Calendar link');
  } finally {
    forceCloseSheet();
    unseedFeeds();
  }
});

test('open: a Google feed event links to that day in Google Calendar, unpadded', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const url = 'https://calendar.google.com/calendar/ical/open-SECRET-G/private-abc/basic.ics';
  seedFeed({
    id: 'open-feed2', url, name: 'Google (me)', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  try {
    click(openControlFor(itemList(), 'Standup from the feed'));
    const link = sheetHost().querySelector('.sheet-google');
    assert.ok(link, 'a Google feed gets the link');
    const d = new Date();
    assert.equal(link.href, `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
    for (const s of [
      ...stringsOf(sheetHost()), ...stringsOf(globalThis.document.getElementById('message')), ...stringsOf(toastHost()),
    ]) {
      assert.ok(!s.includes('open-SECRET-G'), `the Google feed URL must not leak either; found it in ${JSON.stringify(s)}`);
    }
  } finally {
    forceCloseSheet();
    unseedFeeds();
  }
});

test('open: an item of an unknown type shows a message and mounts no sheet', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'open-bogus', type: 'bogus', title: 'Open me with a strange type', date: '2099-02-01' })]);
  globalThis.document.getElementById('message').textContent = '';
  assert.equal(sheetHost().children.length, 0, 'fixture check: no sheet left over from an earlier test');
  const btn = openControlFor(itemList(), 'Open me with a strange type');
  assert.ok(btn, 'fixture check: the row renders');
  assert.doesNotThrow(() => click(btn), 'a sheet that refuses to open must not throw out of the tap');
  assert.equal(sheetHost().children.length, 0, 'no sheet may be mounted');
  assert.match(messageText(), /can't be edited here/);
  assert.match(messageText(), /bogus/, 'the message carries the reason');
  seed([]);
});

// Task 4b: the sheet's Delete goes through requestDelete like every other
// delete — hidden at once, committed (tombstone first) when the toast expires.
test("open: the sheet's Delete deletes through the existing path, tombstone and all", async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'open-del1', title: 'Open me and delete', date: '2099-02-01' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Open me and delete'));
    click(sheetHost().querySelector('.sheet-delete'));
    assert.equal(sheetHost().children.length, 0, 'the sheet closed');
    assert.doesNotMatch(allText(itemList()), /Open me and delete/);
    assert.equal(loadTombstones().length, 0, 'nothing is committed while Undo is offered');
    t.mock.timers.tick(5000);
    assert.deepEqual(loadItems(), [], 'the item is gone from storage');
    assert.ok(loadTombstones().some((ts) => ts.id === 'open-del1'), 'and the delete is tombstoned so it syncs');
    assert.equal(toastHost().children.length, 0, 'no toast is left showing');
  } finally {
    t.mock.timers.reset();
  }
});

// =========================================================================
// Edit-items Task 4b — deleting with Undo
// =========================================================================
//
// A delete hides the item at once and offers Undo for 5 seconds; only on
// expiry (or on backgrounding, or on the next action) is it committed, with
// the tombstone written first as before. Every id here is prefixed `del-`,
// and every test ends with nothing pending: the module is imported once per
// file, so a pending delete or a live toast would leak into the next test.

const toastHost = () => globalThis.document.getElementById('toast-host');

// The delete control (.delete, or the Day grid's .day-del) that sits beside
// the .item-open whose text mentions `title` — found by climbing from the
// open button to the nearest ancestor that holds one as a direct child.
function deleteControlFor(root, title) {
  let hit = null;
  const walk = (el, ancestors) => {
    for (const c of el.children) {
      if (hit) return;
      const chain = [...ancestors, el];
      if (c.tagName === 'BUTTON' && c._classes.has('item-open') && (c.textContent || '').includes(title)) {
        for (let i = chain.length - 1; i >= 0 && !hit; i--) {
          hit = chain[i].children.find((s) => s._classes.has('delete') || s._classes.has('day-del')) || null;
        }
        return;
      }
      walk(c, chain);
    }
  };
  walk(root, []);
  return hit;
}

const tombstoned = (id) => loadTombstones().some((ts) => ts.id === id);
const stored = (id) => loadItems().some((it) => it.id === id);

// Every call site: the List's Delete, the Day grid's ×, the Day page's
// "Other tasks" Delete, the To-do page, the Ideas page, and the sheet. A
// site left calling handleDelete would commit at once: tombstone written, no
// toast — which is exactly what this checks for.
test('delete: every delete control hides the item, offers Undo, and commits only on expiry', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const today = localISO(new Date());
  const sites = [
    ['List', () => itemList(), record({ id: 'del-site-list', title: 'Del via list', date: '2099-03-01' })],
    ['Day ×', () => dayBody(), record({ id: 'del-site-grid', type: 'task', title: 'Del via grid', date: today, time: '09:00' })],
    ['Other tasks', () => dayBody(), record({ id: 'del-site-other', type: 'task', title: 'Del via other', date: today })],
    ['To-do', () => todoList(), record({ id: 'del-site-todo', type: 'task', title: 'Del via todo', date: '2099-03-02' })],
    ['Ideas', () => ideaList(), record({ id: 'del-site-idea', type: 'idea', title: 'Del via ideas', date: today })],
  ];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const [name, root, rec] of sites) {
      seed([rec]);
      const del = deleteControlFor(root(), rec.title);
      assert.ok(del, `fixture check: the ${name} page offers a delete control for ${rec.title}`);
      click(del);
      assert.ok(!tombstoned(rec.id), `${name}: the delete must not be committed while Undo is offered`);
      assert.ok(stored(rec.id), `${name}: the item stays in storage until the delete commits`);
      assert.doesNotMatch(allText(root()), new RegExp(rec.title), `${name}: the item is hidden at once`);
      assert.match(allText(toastHost()), new RegExp(`Deleted "${rec.title}"`), `${name}: a toast names what was deleted`);
      assert.ok(toastHost().querySelector('.toast-undo'), `${name}: and offers Undo`);
      t.mock.timers.tick(5000);
      assert.ok(tombstoned(rec.id), `${name}: on expiry the delete is committed, tombstone and all`);
      assert.ok(!stored(rec.id), `${name}: and the item is gone from storage`);
      assert.equal(toastHost().children.length, 0, `${name}: no toast is left showing`);
    }
  } finally {
    t.mock.timers.reset();
  }
  seed([]);
});

test('delete: a pending delete is hidden from the List, Day, To-do and Ideas pages at once', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const today = localISO(new Date());
  seed([
    record({ id: 'del-hide-task', type: 'task', title: 'Del hide task', date: today, time: '10:00' }),
    record({ id: 'del-hide-idea', type: 'idea', title: 'Del hide idea', date: today }),
  ]);
  for (const [root, title] of [[itemList(), 'Del hide task'], [dayBody(), 'Del hide task'], [todoList(), 'Del hide task'], [ideaList(), 'Del hide idea']]) {
    assert.match(allText(root), new RegExp(title), `fixture check: ${title} is on screen before the delete`);
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(deleteControlFor(todoList(), 'Del hide task'));
    for (const root of [itemList(), dayBody(), todoList()]) {
      assert.doesNotMatch(allText(root), /Del hide task/, 'a pending delete is hidden on every page, not just the one tapped');
    }
    click(deleteControlFor(ideaList(), 'Del hide idea'));
    assert.doesNotMatch(allText(ideaList()), /Del hide idea/);
    assert.ok(!tombstoned('del-hide-idea'), 'the second delete is still pending');
    t.mock.timers.tick(5000);
    assert.equal(toastHost().children.length, 0, 'no toast is left showing');
    assert.ok(tombstoned('del-hide-task') && tombstoned('del-hide-idea'));
  } finally {
    t.mock.timers.reset();
  }
  seed([]);
});

test('delete: Undo before expiry brings the item back and writes no tombstone', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'del-undo', title: 'Del then undo', date: '2099-03-03' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(deleteControlFor(itemList(), 'Del then undo'));
    assert.doesNotMatch(allText(itemList()), /Del then undo/, 'fixture check: hidden while pending');
    click(toastHost().querySelector('.toast-undo'));
    assert.match(allText(itemList()), /Del then undo/, 'Undo shows the item again, at once');
    assert.equal(toastHost().children.length, 0, 'the toast is gone');
    t.mock.timers.tick(5000);
    assert.ok(!tombstoned('del-undo'), 'an undone delete is never committed');
    assert.ok(stored('del-undo'), 'and the item is still stored');
    assert.match(allText(itemList()), /Del then undo/);
  } finally {
    t.mock.timers.reset();
  }
  seed([]);
});

// Critical C1. iOS can kill a backgrounded web app without warning; a delete
// still pending then would be lost, and on return a stale Undo would sit over
// a delete that had in fact been saved.
test('delete: going to the background commits a pending delete and leaves no Undo on screen', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'del-hidden', title: 'Del then hide', date: '2099-03-04' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(deleteControlFor(itemList(), 'Del then hide'));
    assert.ok(toastHost().querySelector('.toast-undo'), 'fixture check: Undo is showing');
    globalThis.document.visibilityState = 'hidden';
    try {
      resume();
    } finally {
      globalThis.document.visibilityState = 'visible';
    }
    assert.ok(tombstoned('del-hidden'), 'backgrounding commits the delete, tombstone and all');
    assert.ok(!stored('del-hidden'), 'and the item is gone from storage');
    assert.equal(toastHost().children.length, 0, 'no stale Undo remains for a delete that is already saved');
  } finally {
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

test('delete: deleting a second item commits the first at once and leaves the second pending', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'del-a', title: 'Del first A', date: '2099-03-05' }),
    record({ id: 'del-b', title: 'Del second B', date: '2099-03-06' }),
  ]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(deleteControlFor(itemList(), 'Del first A'));
    click(deleteControlFor(itemList(), 'Del second B'));
    assert.ok(tombstoned('del-a'), 'only the latest delete can be undone, so A is committed');
    assert.ok(!stored('del-a'));
    assert.ok(!tombstoned('del-b'), 'B is still pending');
    assert.ok(stored('del-b'));
    assert.doesNotMatch(allText(itemList()), /Del second B/);
    assert.match(allText(toastHost()), /Deleted "Del second B"/, 'the toast is now for B');
    t.mock.timers.tick(5000);
    assert.ok(tombstoned('del-b'));
    assert.equal(toastHost().children.length, 0, 'no toast is left showing');
  } finally {
    t.mock.timers.reset();
  }
  seed([]);
});

// The test Task 4a could not write: openItem dismisses the toast, and for a
// delete that dismissal is the commit. Without it, an Undo would sit over the
// sheet's own buttons for a delete the user has moved on from.
test('delete: opening another item commits a pending delete and clears its toast', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'del-open-a', title: 'Del before open', date: '2099-03-07' }),
    record({ id: 'del-open-b', title: 'Del open me after', date: '2099-03-08' }),
  ]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(deleteControlFor(itemList(), 'Del before open'));
    assert.ok(toastHost().querySelector('.toast-undo'), 'fixture check: Undo is showing');
    click(openControlFor(itemList(), 'Del open me after'));
    assert.ok(sheetHost().querySelector('.sheet'), 'fixture check: the other sheet opened');
    assert.equal(toastHost().children.length, 0, 'the toast is gone once another item is opened');
    assert.ok(tombstoned('del-open-a'), 'and the delete it offered to undo is committed');
    assert.ok(!stored('del-open-a'));
    closeSheet();
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// Undo, then switch apps: the backgrounding commit must touch only what is
// still pending. The toast it dismisses has already settled through Undo.
test('delete: Undo, then going to the background, keeps the item', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'del-undo-hide', title: 'Del undo then hide', date: '2099-03-09' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(deleteControlFor(itemList(), 'Del undo then hide'));
    click(toastHost().querySelector('.toast-undo'));
    globalThis.document.visibilityState = 'hidden';
    try {
      resume();
    } finally {
      globalThis.document.visibilityState = 'visible';
    }
    t.mock.timers.tick(5000);
    assert.ok(!tombstoned('del-undo-hide'), 'an undone delete stays undone across backgrounding');
    assert.ok(stored('del-undo-hide'));
    assert.match(allText(itemList()), /Del undo then hide/);
    assert.equal(toastHost().children.length, 0);
  } finally {
    t.mock.timers.reset();
  }
  seed([]);
});

// --- Task 4a review I1 + the 4b commit-failure finding ----------------------

test('review: tapping the SECOND list item opens the second item', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'rv-a', title: 'First of two', date: '2099-03-01' }),
    record({ id: 'rv-b', title: 'Second of two', date: '2099-03-02' }),
  ]);
  click(openControlFor(itemList(), 'Second of two'));
  assert.equal(sheetHost().querySelector('.sheet-title').value, 'Second of two');
  closeSheet();
  seed([]);
});

// A delete whose commit fails (the tombstone write hits a full device) must
// not leave the item hidden: before pending deletes, a failed delete left it
// on screen, and it must still be on screen after one now.
test('review: a delete whose commit fails is shown again, with the error', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'rv-fail', title: 'Cannot be deleted', date: '2099-03-03' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const real = localStorage.setItem.bind(localStorage);
  try {
    click(deleteControlFor(itemList(), 'Cannot be deleted'));
    assert.doesNotMatch(allText(itemList()), /Cannot be deleted/, 'fixture check: hidden while pending');
    localStorage.setItem = (k, v) => {
      if (k === 'plaenicke.syncTombstones') { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
      return real(k, v);
    };
    t.mock.timers.tick(5000);
  } finally {
    localStorage.setItem = real;
    t.mock.timers.reset();
  }
  assert.match(allText(itemList()), /Cannot be deleted/, 'a delete that did not happen must not look like it did');
  assert.match(messageText(), /quota/i);
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// =========================================================================
// Edit-items Task 4c — editing
// =========================================================================
//
// editItem is the sheet's onSave. Every id here is prefixed `edit-`, and
// every test that shows a toast resolves it (expiry or Undo) and leaves the
// toast host empty: the module is imported once per file.

const storedById = (id) => loadItems().find((it) => it.id === id);
const rawStored = () => localStorage.getItem('plaenicke.items');

// A sync that lands while the app is open: storage changes underneath app.js,
// which reloads through its storage listener (the same path as seed()).
function simulateSync(records) {
  saveItems(records);
  for (const fn of globalThis.window._listeners.storage) fn({ key: 'plaenicke.items' });
}

// A hand-rolled timer fake, used INSTEAD of t.mock.timers for the sync test.
// app.js's module-scope `syncTimer` outlives each test, and Node 22's
// MockTimers mis-handles clearTimeout on a handle from an EARLIER test's mock
// session: it removes an unrelated timer from the current queue by the stale
// handle's heap position. The delete tests leave exactly such a handle, and
// scheduleSync's clearTimeout(syncTimer) then silently swallowed the new sync
// timer. Reproduced standalone; not an app.js defect.
function installManualTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const pending = [];
  globalThis.setTimeout = (fn, ms) => { const h = { fn, ms, cancelled: false }; pending.push(h); return h; };
  globalThis.clearTimeout = (h) => { if (h && pending.includes(h)) h.cancelled = true; };
  return {
    // Runs, once, every live timer scheduled for exactly `ms`.
    fire(ms) {
      for (const h of pending.filter((x) => x.ms === ms && !x.cancelled)) { h.cancelled = true; h.fn(); }
    },
    live: (ms) => pending.filter((x) => x.ms === ms && !x.cancelled).length,
    restore() { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; },
  };
}

test('edit: a Save through the sheet writes storage, bumps updatedAt and schedules a sync', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  await linkWithCode(bytesToBase64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))));
  clearAdoptionPending();
  seed([record({ id: 'edit-save', title: 'Edit me', date: '2099-04-01' })]);

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }), text: async () => '' };
  };
  const timers = installManualTimers();
  try {
    click(openControlFor(itemList(), 'Edit me'));
    sheetHost().querySelector('.sheet-title').value = 'Edited title';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(sheetHost().children.length, 0, 'a successful save closes the sheet');
    const saved = storedById('edit-save');
    assert.equal(saved.title, 'Edited title', 'the edit is in storage');
    assert.ok(saved.updatedAt > '2026-08-19T00:00:00.000Z', 'updatedAt is bumped, or the next sync reverts the edit');
    assert.match(allText(itemList()), /Edited title/, 'the screen shows the edit');
    assert.match(allText(toastHost()), /Saved/, 'a toast confirms the save');
    assert.deepEqual(requests.filter((r) => r.url.includes('/data')), [], 'the push is debounced');
    assert.equal(timers.live(2000), 1, 'exactly one debounced sync is scheduled');
    timers.fire(2000);
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
    assert.ok(requests.some((r) => r.url.includes('/data') && r.method === 'PUT'),
      'an edit must reach the account without waiting for a reload');
    timers.fire(5000);
    assert.equal(toastHost().children.length, 0, 'no toast is left showing');
  } finally {
    forceCloseSheet();
    timers.restore();
    globalThis.fetch = originalFetch;
  }
  installFakeLocalStorage();
  seed([]);
});

test('edit: a cleared date is refused, storage is untouched, and the sheet says why', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'edit-nodate', title: 'Keep my date', date: '2099-04-02' })]);
  const beforeRaw = rawStored();
  const beforeItems = loadItems();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Keep my date'));
    sheetHost().querySelector('.sheet-date').value = '';
    click(sheetHost().querySelector('.sheet-save'));
    assert.ok(sheetHost().querySelector('.sheet'), 'a refused save keeps the sheet open');
    assert.equal(sheetHost().querySelector('.sheet-error').textContent, 'Date is required', 'and shows why');
    assert.equal(rawStored(), beforeRaw, 'storage is byte-identical');
    assert.deepEqual(loadItems(), beforeItems);
    assert.equal(toastHost().children.length, 0, 'a refused save offers no Undo');
    closeSheet();
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000); // a failed assertion must not leave a live toast behind
    t.mock.timers.reset();
  }
  seed([]);
});

// I1: pendingDeletes hides a record from liveItems() but it is still in
// `items`, so an index found in liveItems() is off by one for every record
// after it — and editItem writes into `items` by that index.
test('edit: with an earlier item pending deletion, the edit lands on the right record and no other', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'edit-i1-a', title: 'I1 first', date: '2099-04-03' }),
    record({ id: 'edit-i1-b', title: 'I1 second', date: '2099-04-04' }),
    record({ id: 'edit-i1-c', title: 'I1 third', date: '2099-04-05' }),
    record({ id: 'edit-i1-d', title: 'I1 fourth', date: '2099-04-06' }),
  ]);
  const beforeById = Object.fromEntries(loadItems().map((it) => [it.id, JSON.stringify(it)]));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'I1 third'));
    // Delete A while C's sheet is open (opening an item would commit it).
    click(deleteControlFor(itemList(), 'I1 first'));
    assert.ok(!tombstoned('edit-i1-a'), 'fixture check: A is pending, not committed');
    sheetHost().querySelector('.sheet-title').value = 'I1 third, edited';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(sheetHost().children.length, 0, 'the save succeeded');
    for (const id of ['edit-i1-b', 'edit-i1-d']) {
      assert.equal(JSON.stringify(storedById(id)), beforeById[id], `${id} is byte-identical`);
    }
    const c = storedById('edit-i1-c');
    assert.equal(c.title, 'I1 third, edited');
    const { title: _t, updatedAt: _u, ...cRest } = c;
    const { title: _t0, updatedAt: _u0, ...cRest0 } = JSON.parse(beforeById['edit-i1-c']);
    assert.deepEqual(cRest, cRest0, 'only the title (and updatedAt) changed on the edited record');
    assert.equal(loadItems().length, 3, 'A was committed by the Saved toast replacing its own; nothing else was lost');
    assert.ok(tombstoned('edit-i1-a'));
    t.mock.timers.tick(5000);
    assert.equal(toastHost().children.length, 0, 'no toast is left showing');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000); // a failed assertion must not leave a live toast behind
    t.mock.timers.reset();
  }
  seed([]);
});

test('edit: saving an item that is pending deletion is refused', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'edit-pend', title: 'Pending edit', date: '2099-04-07' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Pending edit'));
    click(deleteControlFor(itemList(), 'Pending edit'));
    const beforeRaw = rawStored();
    sheetHost().querySelector('.sheet-title').value = 'Renamed while pending';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(sheetHost().querySelector('.sheet-error').textContent, 'This item is being deleted.');
    assert.equal(rawStored(), beforeRaw, 'nothing was written');
    assert.ok(!tombstoned('edit-pend'), 'and the delete is still pending, with its Undo');
    closeSheet();
    t.mock.timers.tick(5000);
    assert.ok(tombstoned('edit-pend'), 'the delete then commits as normal');
    assert.equal(toastHost().children.length, 0);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000); // a failed assertion must not leave a live toast behind
    t.mock.timers.reset();
  }
  seed([]);
});

test('edit: Undo restores the edited field and keeps a field a sync changed in between', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'edit-undo', title: 'Undo me', date: '2099-04-08' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Undo me'));
    sheetHost().querySelector('.sheet-title').value = 'Undo me, renamed';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(storedById('edit-undo').title, 'Undo me, renamed', 'fixture check: the edit landed');
    simulateSync([{ ...storedById('edit-undo'), date: '2099-05-01' }]);
    click(toastHost().querySelector('.toast-undo'));
    const r = storedById('edit-undo');
    assert.equal(r.title, 'Undo me', 'Undo restores the title');
    assert.equal(r.date, '2099-05-01', 'and keeps the date the sync wrote');
    assert.match(allText(itemList()), /Undo me/);
    assert.doesNotMatch(allText(itemList()), /renamed/);
    assert.equal(toastHost().children.length, 0, 'Undo leaves no toast');
    t.mock.timers.tick(5000);
    assert.equal(toastHost().children.length, 0);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000); // a failed assertion must not leave a live toast behind
    t.mock.timers.reset();
  }
  seed([]);
});

// typeChangePatch ADDS keys (notes, times, and normalizeIdea re-derives the
// title), so an Undo built from the caller's keys alone restores only `type`.
// And re-running typeChangePatch on the undo would split the idea's text
// instead of restoring the task's own fields.
test('edit: Undo of a task -> idea switch restores the original task exactly', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const original = record({
    id: 'edit-undo-type', type: 'task', title: 'Call the plumber',
    notes: 'About the kitchen sink', date: '2099-04-09', time: '09:00', endTime: '10:00',
  });
  seed([original]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Call the plumber'));
    sheetHost().querySelector('.sheet-type').value = 'idea';
    click(sheetHost().querySelector('.sheet-save'));
    const idea = storedById('edit-undo-type');
    assert.equal(idea.type, 'idea', 'fixture check: the switch landed');
    assert.equal(idea.time, null, 'an idea is unscheduled');
    assert.match(idea.notes, /Call the plumber/, 'the idea keeps the title');
    assert.match(idea.notes, /About the kitchen sink/, 'and the notes');
    click(toastHost().querySelector('.toast-undo'));
    const back = storedById('edit-undo-type');
    for (const k of ['type', 'title', 'notes', 'date', 'time', 'endTime']) {
      assert.equal(back[k], original[k], `Undo restores ${k}`);
    }
    assert.equal(toastHost().children.length, 0);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000); // a failed assertion must not leave a live toast behind
    t.mock.timers.reset();
  }
  seed([]);
});

test('edit: a quota failure leaves the in-memory list unchanged and shows the error', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'edit-quota', title: 'Quota original', date: '2099-04-10' })]);
  const beforeRaw = rawStored();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const real = localStorage.setItem.bind(localStorage);
  try {
    click(openControlFor(itemList(), 'Quota original'));
    sheetHost().querySelector('.sheet-title').value = 'Quota renamed';
    localStorage.setItem = (k, v) => {
      if (k === 'plaenicke.items') { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      return real(k, v);
    };
    try {
      click(sheetHost().querySelector('.sheet-save'));
    } finally {
      localStorage.setItem = real;
    }
    assert.match(sheetHost().querySelector('.sheet-error').textContent, /quota/i, 'the sheet shows the error');
    assert.equal(rawStored(), beforeRaw);
    assert.equal(toastHost().children.length, 0, 'a failed save offers no Undo');
    closeSheet();
    resume(); // re-renders from app.js's in-memory list
    assert.match(allText(itemList()), /Quota original/, 'the in-memory list was restored');
    assert.doesNotMatch(allText(itemList()), /Quota renamed/);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000); // a failed assertion must not leave a live toast behind
    t.mock.timers.reset();
  }
  seed([]);
});

// Task 3 review I1: the type switch fills title/notes from the CURRENT record,
// not the one the sheet opened with.
test('edit: a type switch after a sync changed the notes keeps the synced notes', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'edit-stale', type: 'task', title: 'Stale check', notes: 'notes as opened', date: '2099-04-11' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Stale check'));
    simulateSync([{ ...storedById('edit-stale'), notes: 'notes from the other device', updatedAt: '2026-08-20T00:00:00.000Z' }]);
    sheetHost().querySelector('.sheet-type').value = 'idea';
    click(sheetHost().querySelector('.sheet-save'));
    const r = storedById('edit-stale');
    assert.equal(r.type, 'idea');
    assert.match(r.notes, /notes from the other device/, 'the synced notes survive');
    assert.doesNotMatch(r.notes, /notes as opened/, 'the stale notes are not written back');
    t.mock.timers.tick(5000);
    assert.equal(toastHost().children.length, 0);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000); // a failed assertion must not leave a live toast behind
    t.mock.timers.reset();
  }
  seed([]);
});

// I8: the edit's fresh updatedAt is what wins the merge.
test('edit: a sync carrying an older copy of the record keeps the edit, in storage and on screen', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const original = record({ id: 'edit-lww', title: 'Before the edit', date: '2099-04-12' });
  seed([original]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Before the edit'));
    sheetHost().querySelector('.sheet-title').value = 'After the edit';
    click(sheetHost().querySelector('.sheet-save'));
    t.mock.timers.tick(5000);
    applySyncedState(state({ items: [original] }));
    assert.equal(storedById('edit-lww').title, 'After the edit', 'storage keeps the edit');
    assert.match(allText(itemList()), /After the edit/, 'and so does the screen');
    assert.doesNotMatch(allText(itemList()), /Before the edit/);
    assert.equal(toastHost().children.length, 0);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000); // a failed assertion must not leave a live toast behind
    t.mock.timers.reset();
  }
  seed([]);
});

// Task 4b review, item 3: an Undo whose item was deleted on the other device
// while its toast was up used to do nothing visible. The outcome is right —
// the item really is gone — but a button that appears broken is not.
test('review: Undo of an item the other device deleted meanwhile says so', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const rec = record({ id: 'rv-remote', title: 'Deleted over there', date: '2099-04-01' });
  seed([rec]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(deleteControlFor(itemList(), 'Deleted over there'));
    applySyncedState(state({
      items: [],
      tombstones: [{ id: 'rv-remote', kind: 'item', deletedAt: '2099-12-31T00:00:00.000Z' }],
    }));
    const undo = toastHost().querySelector('.toast-undo');
    assert.ok(undo, 'fixture check: the delete toast is still showing');
    click(undo);
  } finally {
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.match(messageText(), /deleted on your other device/i);
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// --- Task 4c review ---------------------------------------------------------

// I1: Undo is itself an edit and must bump updatedAt, or the next sync —
// carrying the already-pushed edit, whose updatedAt it would merely tie —
// silently reverts the undo (unionById ties go to REMOTE).
// Through applySyncedState (a real merge), not simulateSync, which overwrites
// storage wholesale and so cannot exercise last-write-wins. Date is mocked so
// the edit and the undo are a second apart: a same-millisecond pair would tie.
test('review4c: an Undo survives a sync that returns the already-pushed edit', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({ id: 'rv4-bump', title: 'R orig', date: '2099-06-01' })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-23T12:00:00.000Z') });
  try {
    click(openControlFor(itemList(), 'R orig'));
    sheetHost().querySelector('.sheet-title').value = 'R edited';
    click(sheetHost().querySelector('.sheet-save'));
    const pushed = { ...storedById('rv4-bump') };
    t.mock.timers.tick(1000);
    click(toastHost().querySelector('.toast-undo'));
    applySyncedState(state({ items: [pushed] }));
    assert.equal(storedById('rv4-bump').title, 'R orig', 'the undo must win over the edit it undid');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  seed([]);
});

// I3a: a failed Undo is not silent. The other device deleted the item between
// the Save and the Undo.
test('review4c: an Undo that cannot be applied says why', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({ id: 'rv4-gone', title: 'Gone soon', date: '2099-06-02' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Gone soon'));
    sheetHost().querySelector('.sheet-title').value = 'Gone soon, renamed';
    click(sheetHost().querySelector('.sheet-save'));
    applySyncedState(state({ items: [], tombstones: [{ id: 'rv4-gone', kind: 'item', deletedAt: '2999-01-01T00:00:00.000Z' }] }));
    click(toastHost().querySelector('.toast-undo'));
    assert.match(messageText(), /no longer exists/);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  seed([]);
});

// I3b: the Saved toast is the active toast, so opening another item dismisses
// it — no stale Undo sits over the new sheet.
test('review4c: opening another item dismisses the Saved toast', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'rv4-a', title: 'Saved one', date: '2099-06-03' }),
    record({ id: 'rv4-b', title: 'Next one', date: '2099-06-04' }),
  ]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Saved one'));
    sheetHost().querySelector('.sheet-title').value = 'Saved one, renamed';
    click(sheetHost().querySelector('.sheet-save'));
    assert.ok(toastHost().querySelector('.toast-undo'), 'fixture check: the Saved toast is up');
    click(openControlFor(itemList(), 'Next one'));
    assert.equal(toastHost().children.length, 0, 'the Saved toast must be dismissed');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  seed([]);
});

// I3c: the end time was edited, then the other device moved the start past the
// old end. Restoring the old end alone would store an invalid record. Since
// sweep F (I2) time and endTime move together: the start changed, so neither
// is restored, nothing is written, and the message is not the validator's.
test('review4c: an Undo that would store an invalid record is refused, and nothing is written', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'rv4-inv', title: 'Timed', date: '2099-06-05', time: '09:00', endTime: '10:00' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(itemList(), 'Timed'));
    sheetHost().querySelector('.sheet-end').value = '12:00';
    click(sheetHost().querySelector('.sheet-save'));
    simulateSync([{ ...storedById('rv4-inv'), time: '11:00', updatedAt: '2999-01-01T00:00:00.000Z' }]);
    const before = JSON.stringify(storedById('rv4-inv'));
    click(toastHost().querySelector('.toast-undo'));
    assert.equal(JSON.stringify(storedById('rv4-inv')), before, 'an invalid undo writes nothing');
    assert.equal(messageText(), 'Some changes from your other device were kept.');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  seed([]);
});

// Sweep (dates) Critical, at the app level: an undated record — tolerated by
// deserializeItems on purpose — must render, not crash the app.
test('sweep: records with a null or empty date render instead of crashing the app', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  assert.doesNotThrow(() => seed([
    record({ id: 'sw-null', title: 'Undated null', date: null, type: 'event' }),
    record({ id: 'sw-empty', title: 'Undated empty', date: '', type: 'task' }),
  ]));
  assert.match(allText(itemList()), /No date — Undated null/);
  assert.match(allText(todoList()), /Undated empty/);
  seed([]);
});

// --- sweep batch S ------------------------------------------------------------
//
// Clock-skew tests seed a record stamped 60 s AFTER this device's (mocked)
// clock: exactly what a record from a device whose clock runs ahead looks
// like. Each sync goes through applySyncedState, the real merge path;
// simulateSync overwrites storage and cannot exercise last-write-wins.

const S_NOW = Date.parse('2026-09-23T12:00:00.000Z');
const S_AHEAD = '2026-09-23T12:01:00.000Z';
const clearMessage = () => { globalThis.document.getElementById('message').textContent = ''; };
const storedTombstone = (id) => loadTombstones().find((x) => x.id === id);

// F1: an edit of a record from a clock-ahead device is stamped strictly after
// it, so the next sync carrying that same record does not revert the edit.
test('sweep S: an edit of a record stamped in the future survives a sync of the original', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const original = record({ id: 'sS-skew-edit', title: 'Skewed before', date: '2099-07-01', updatedAt: S_AHEAD });
  seed([original]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    click(openControlFor(itemList(), 'Skewed before'));
    sheetHost().querySelector('.sheet-title').value = 'Skewed after';
    click(sheetHost().querySelector('.sheet-save'));
    t.mock.timers.tick(5000);
    applySyncedState(state({ items: [original] }));
    assert.equal(storedById('sS-skew-edit').title, 'Skewed after', 'the edit must not lose to the copy it replaced');
    assert.match(allText(itemList()), /Skewed after/);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// F1: the same for a tick.
test('sweep S: a tick of a to-do stamped in the future survives a sync of the original', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const original = record({ id: 'sS-skew-tick', type: 'task', title: 'Skewed tick', date: '2099-07-02', updatedAt: S_AHEAD });
  seed([original]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    const box = checkboxFor(todoList(), 'Skewed tick');
    box.checked = true;
    fire(box, 'change');
    applySyncedState(state({ items: [original] }));
    assert.equal(storedById('sS-skew-tick').done, true, 'the tick must not lose to the copy it replaced');
  } finally {
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// F1: an Undo in the same millisecond as its edit must still be later than the
// edit, or the pushed edit ties it and (ties go to remote) reverts it.
test('sweep S: an Undo in the same millisecond as its edit survives a sync of the edit', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({ id: 'sS-skew-undo', title: 'Undo skew orig', date: '2099-07-03', updatedAt: S_AHEAD })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    click(openControlFor(itemList(), 'Undo skew orig'));
    sheetHost().querySelector('.sheet-title').value = 'Undo skew edited';
    click(sheetHost().querySelector('.sheet-save'));
    const pushed = { ...storedById('sS-skew-undo') };
    click(toastHost().querySelector('.toast-undo'));
    applySyncedState(state({ items: [pushed] }));
    assert.equal(storedById('sS-skew-undo').title, 'Undo skew orig', 'the undo must win over the edit it undid');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// F2: a delete of a record from a clock-ahead device must stay deleted.
// applyTombstones keeps a record whose updatedAt is at or after deletedAt.
test('sweep S: a delete of a record stamped in the future stays deleted after a sync of the original', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  const original = record({ id: 'sS-skew-del', title: 'Skewed delete', date: '2099-07-04', updatedAt: S_AHEAD });
  seed([original]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    click(deleteControlFor(itemList(), 'Skewed delete'));
    t.mock.timers.tick(5000);
    assert.ok(tombstoned('sS-skew-del'), 'fixture check: the delete committed');
    applySyncedState(state({ items: [original] }));
    assert.ok(!stored('sS-skew-del'), 'the deleted item must not come back');
    assert.doesNotMatch(allText(itemList()), /Skewed delete/);
  } finally {
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// F3: Undo restores a field only while it still holds what the edit wrote. A
// field the other device changed since is kept, and the user is told.
test('sweep S: Undo keeps a field a sync changed since the edit, restores the rest, and says so', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({ id: 'sS-undo-theirs', title: 'Undo base', date: '2099-07-05' })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    clearMessage();
    click(openControlFor(itemList(), 'Undo base'));
    sheetHost().querySelector('.sheet-title').value = 'mine';
    sheetHost().querySelector('.sheet-date').value = '2099-07-06';
    click(sheetHost().querySelector('.sheet-save'));
    applySyncedState(state({ items: [{ ...storedById('sS-undo-theirs'), title: 'theirs', updatedAt: S_AHEAD }] }));
    assert.equal(storedById('sS-undo-theirs').title, 'theirs', 'fixture check: the newer sync landed');
    click(toastHost().querySelector('.toast-undo'));
    const r = storedById('sS-undo-theirs');
    assert.equal(r.title, 'theirs', 'Undo must not write over a newer value from the other device');
    assert.equal(r.date, '2099-07-05', 'Undo still restores the field nobody else changed');
    assert.equal(messageText(), 'Some changes from your other device were kept.');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// F3: when EVERY field was changed since, there is nothing to restore: no
// write at all (a write would bump updatedAt for no change), and still a message.
test('sweep S: Undo with every edited field changed since writes nothing and says so', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({ id: 'sS-undo-none', title: 'Undo none base', date: '2099-07-07' })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    clearMessage();
    click(openControlFor(itemList(), 'Undo none base'));
    sheetHost().querySelector('.sheet-title').value = 'mine only';
    click(sheetHost().querySelector('.sheet-save'));
    applySyncedState(state({ items: [{ ...storedById('sS-undo-none'), title: 'theirs only', updatedAt: S_AHEAD }] }));
    const before = rawStored();
    click(toastHost().querySelector('.toast-undo'));
    assert.equal(rawStored(), before, 'nothing to restore, so nothing is written');
    assert.equal(messageText(), 'Some changes from your other device were kept.');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// F4: the sheet is built for the type it opened with (the idea sheet has one
// text box; the others have title/date/time). If a sync changed the type while
// it was open, its diff no longer describes the record: refuse, don't guess.
test('sweep S: saving a sheet whose item changed type underneath it is refused', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({ id: 'sS-type-under', type: 'task', title: 'Type under', date: '2099-07-08' })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    click(openControlFor(itemList(), 'Type under'));
    applySyncedState(state({ items: [{ ...storedById('sS-type-under'), type: 'due', updatedAt: S_AHEAD }] }));
    const before = rawStored();
    sheetHost().querySelector('.sheet-title').value = 'Type under, renamed';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(sheetHost().querySelector('.sheet-error').textContent,
      'This item changed elsewhere (another device or tab) — close and reopen it.');
    assert.equal(rawStored(), before, 'nothing was written');
    assert.equal(toastHost().children.length, 0, 'a refused save offers no Undo');
    closeSheet();
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// F5: a failed tick must not leave `done: true` in app.js's in-memory list,
// where the next successful save of ANY item would write it to storage.
test('sweep S: a tick that fails on quota is not saved by a later, unrelated edit', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([
    record({ id: 'sS-rb-tick', type: 'task', title: 'Rollback tick', date: '2099-07-09' }),
    record({ id: 'sS-rb-other', title: 'Rollback other', date: '2099-07-10' }),
  ]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const real = localStorage.setItem.bind(localStorage);
  try {
    localStorage.setItem = (k, v) => {
      if (k === 'plaenicke.items') { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      return real(k, v);
    };
    try {
      const box = checkboxFor(todoList(), 'Rollback tick');
      box.checked = true;
      fire(box, 'change');
    } finally {
      localStorage.setItem = real;
    }
    assert.equal(storedById('sS-rb-tick').done, false, 'fixture check: the tick was not saved');
    click(openControlFor(itemList(), 'Rollback other'));
    sheetHost().querySelector('.sheet-title').value = 'Rollback other, renamed';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(storedById('sS-rb-other').title, 'Rollback other, renamed', 'fixture check: the edit saved');
    assert.equal(storedById('sS-rb-tick').done, false, 'the failed tick must not ride along with the edit');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// F5: the same for a capture (addItems) that fails on quota.
test('sweep S: an add that fails on quota is not saved by a later, unrelated edit', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sS-rb-add-other', title: 'Rollback add other', date: '2099-07-11' })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const real = localStorage.setItem.bind(localStorage);
  try {
    localStorage.setItem = (k, v) => {
      if (k === 'plaenicke.items') { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
      return real(k, v);
    };
    try {
      ideaText().value = 'sS failed capture thought';
      click(ideaAdd());
    } finally {
      localStorage.setItem = real;
    }
    assert.match(messageText(), /quota/i, 'fixture check: the add failed visibly');
    click(openControlFor(itemList(), 'Rollback add other'));
    sheetHost().querySelector('.sheet-title').value = 'Rollback add other, renamed';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(storedById('sS-rb-add-other').title, 'Rollback add other, renamed', 'fixture check: the edit saved');
    assert.ok(!loadItems().some((it) => /sS failed capture thought/.test(`${it.title} ${it.notes}`)),
      'the failed add must not ride along with the edit');
  } finally {
    forceCloseSheet();
    ideaText().value = '';
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// S-3 (E8), through the real idea sheet: the text is edited AND the type
// switched in one save. The new text wins over the idea's old notes.
test('sweep S: editing an idea\'s text and switching it to a task in one save keeps the new text', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({
    id: 'sS-idea-switch', type: 'idea', title: 'Old idea words',
    notes: 'Old idea words, the complete original thought', date: '2099-07-12',
  })]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(openControlFor(ideaList(), 'Old idea words'));
    sheetHost().querySelector('.sheet-text').value = 'Fresh task text';
    sheetHost().querySelector('.sheet-type').value = 'task';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(sheetHost().children.length, 0, 'the save succeeded');
    const r = storedById('sS-idea-switch');
    assert.equal(r.type, 'task');
    assert.equal(r.title, 'Fresh task text');
    assert.doesNotMatch(JSON.stringify(r), /Old idea words/, 'the old text is not written back');
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// S-5: going to the background commits a pending delete through the toast's
// dismiss AND sweeps pendingDeletes; the tombstone must be written once, at
// the moment of backgrounding, and never again by a later timer.
test('sweep S: backgrounding commits a pending delete\'s tombstone exactly once', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sS-bg-once', title: 'Background once', date: '2099-07-13' })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  const real = localStorage.setItem.bind(localStorage);
  let writes = 0;
  try {
    click(deleteControlFor(itemList(), 'Background once'));
    localStorage.setItem = (k, v) => {
      if (k === 'plaenicke.syncTombstones' && JSON.parse(v).some((x) => x.id === 'sS-bg-once')) writes += 1;
      return real(k, v);
    };
    globalThis.document.visibilityState = 'hidden';
    try {
      resume();
    } finally {
      globalThis.document.visibilityState = 'visible';
    }
    t.mock.timers.tick(5000);
    t.mock.timers.tick(5000);
    assert.equal(writes, 1, 'the tombstone is written exactly once');
    assert.equal(storedTombstone('sS-bg-once').deletedAt, new Date(S_NOW).toISOString(),
      'stamped when the app went to the background');
  } finally {
    localStorage.setItem = real;
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// =========================================================================
// Sweep batch D — dates and staying current
// =========================================================================
//
// Ids are prefixed `sD-`. The module is imported once for the file, so every
// test here puts feeds, cursors and the clock back the way it found them.

const stampEl = () => globalThis.document.getElementById('updated-stamp');
const labelText = (id) => globalThis.document.getElementById(id).textContent;
const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => { setImmediate(r); }); };
const localAt = (h, m) => new Date(2026, 8, 23, h, m);
// Puts the Day and Week cursors back on today by tapping today's month cell.
function openDayForToday() {
  const grid = globalThis.document.getElementById('calendar-grid');
  click(grid.children.find((c) => c._classes.has('today')));
  assert.equal(labelText('day-label'), labelFor(new Date()), 'fixture check: back on today');
}

// Feeds and their cache, loaded into app.js through its storage listener.
function seedFeedsWithCache(feedList, cache) {
  saveFeeds(feedList);
  localStorage.setItem('plaenicke.feedCache', JSON.stringify(cache));
  for (const fn of globalThis.window._listeners.storage) fn({ key: 'plaenicke.feeds' });
}
const sdFeed = (id, o = {}) => ({
  id, url: `https://example.com/${id}.ics`, name: id, color: 'var(--feed-palette-1)', hidden: false,
  updatedAt: '2026-08-01T00:00:00.000Z', ...o,
});
const cacheAt = (d) => ({ fetchedAt: d.toISOString(), events: [], skipped: [] });

// --- D1: the "Updated" stamp says when the calendars were fetched ----------

test('sweep D: with calendars, the stamp is the OLDEST fetch among the visible ones', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  // All three are fresh at 10:40, so nothing is fetched. The hidden one is the
  // oldest, and must not count: its events are not on screen.
  seedFeedsWithCache(
    [sdFeed('sD-fa'), sdFeed('sD-fb'), sdFeed('sD-fh', { hidden: true })],
    { 'sD-fa': cacheAt(localAt(10, 30)), 'sD-fb': cacheAt(localAt(10, 20)), 'sD-fh': cacheAt(localAt(10, 15)) },
  );
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, text: async () => '' }; };
  stampEl().textContent = 'sentinel';
  t.mock.timers.enable({ apis: ['Date'], now: localAt(10, 40).getTime() });
  let beforeSettle;
  try {
    resume();
    beforeSettle = stampEl().textContent;
    await settle();
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
  assert.equal(beforeSettle, 'sentinel', 'the render time must not be painted over calendars that have not settled');
  assert.deepEqual(calls, [], 'fixture check: every feed was fresh');
  assert.equal(stampEl().textContent, 'Updated 10:20 AM');
  unseedFeeds();
  resume();
});

test('sweep D: a calendar fetch that fails says so instead of a time', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seedFeedsWithCache([sdFeed('sD-ff')], { 'sD-ff': cacheAt(localAt(8, 40)) }); // stale at 10:40
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new TypeError('offline'); };
  t.mock.timers.enable({ apis: ['Date'], now: localAt(10, 40).getTime() });
  try {
    resume();
    await settle();
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetched, 1, 'fixture check: the stale feed was fetched');
  assert.equal(stampEl().textContent, "Couldn't refresh calendars");
  unseedFeeds();
  resume();
});

// syncStale REJECTS (rather than reporting {ok:false}) on a storage error that
// is not about quota. That is a failed refresh too.
test('sweep D: a calendar refresh that rejects also says so', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seedFeedsWithCache([sdFeed('sD-fr')], { 'sD-fr': cacheAt(localAt(8, 40)) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => '' });
  const real = localStorage.setItem.bind(localStorage);
  const originalError = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a); };
  localStorage.setItem = (k, v) => {
    if (k === 'plaenicke.feedCache') { const e = new Error('blocked'); e.name = 'SecurityError'; throw e; }
    return real(k, v);
  };
  t.mock.timers.enable({ apis: ['Date'], now: localAt(10, 40).getTime() });
  try {
    resume();
    await settle();
  } finally {
    t.mock.timers.reset();
    localStorage.setItem = real;
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
  assert.ok(logged.some((a) => String(a[0]).includes('background calendar sync failed')), 'fixture check: the batch rejected');
  assert.equal(stampEl().textContent, "Couldn't refresh calendars");
  unseedFeeds();
  resume();
});

// --- D3: the sheet's quick moves read today when tapped --------------------

test('sweep D: a sheet left open past midnight moves "Tomorrow" from the new today', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sD-move', title: 'sD move me', date: '2099-01-01' })]);
  const timers = installManualTimers();
  try {
    click(openControlFor(itemList(), 'sD move me'));
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 });
    const newToday = localISO(new Date());
    click(sheetHost().querySelector('.sheet-move')); // Tomorrow
    t.mock.timers.reset();
    assert.equal(storedById('sD-move').date, addDays(newToday, 1));
    timers.fire(5000);
    assert.equal(toastHost().children.length, 0, 'no toast is left showing');
  } finally {
    t.mock.timers.reset();
    forceCloseSheet();
    timers.restore();
  }
  seed([]);
  resume();
});

// --- D4: any render catches up with the clock, not only a resume -----------

test('sweep D: a render after midnight moves the Day view even without a resume', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const dayLabel = globalThis.document.getElementById('day-label');
  assert.equal(dayLabel.textContent, labelFor(new Date()), 'fixture check: the Day view starts on today');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 });
  try {
    seed([]); // a sync landing re-renders, with no visibilitychange at all
    assert.equal(dayLabel.textContent, labelFor(new Date()));
  } finally {
    t.mock.timers.reset();
  }
  seed([]);
  assert.equal(dayLabel.textContent, labelFor(new Date()));
});

// The other side of D4. Opening a SPECIFIC day is not "the view that was
// showing today": a month cell tapped just after midnight, before anything
// re-rendered, must open the day that was tapped, not be carried on to the new
// today by the render that follows.
test('sweep D: tapping yesterday\'s cell just after midnight opens that day', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const oldToday = new Date();
  const cell = globalThis.document.getElementById('calendar-grid').children.find((c) => c._classes.has('today'));
  assert.ok(cell, 'fixture check: the month grid marks today');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 });
  try {
    click(cell);
    assert.equal(labelText('day-label'), labelFor(oldToday), 'the tapped day opens');
  } finally {
    t.mock.timers.reset();
  }
  seed([]);
  assert.equal(labelText('day-label'), labelFor(oldToday), 'fixture check: still on the day the user chose');
  click(globalThis.document.getElementById('show-day'));
  openDayForToday();
});

// --- D5: the time zone is re-read, not fixed at load ------------------------

// The clock is pinned to 12:00 UTC, when Tokyo (21:00) and Honolulu (02:00)
// are on the SAME local date. So the second switch changes the zone and not
// the day, and a re-read placed after refreshForToday's "day unchanged" early
// return would miss it.
test('sweep D: calendar times follow a change of the device time zone', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const prior = process.env.TZ;
  const seen = {};
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-23T12:00:00.000Z') });
  try {
    seedFeedsWithCache([sdFeed('sD-tz')], {
      'sD-tz': {
        fetchedAt: new Date().toISOString(),
        events: [{
          uid: 'sD-tz-e', title: 'sD zoned event', form: 'UTC',
          dtstart: { value: '20261003T120000Z', tzid: null },
          dtend: null, duration: null, rrule: null, exdates: [], recurrenceId: null,
        }],
        skipped: [],
      },
    });
    for (const tz of ['Asia/Tokyo', 'Pacific/Honolulu']) {
      process.env.TZ = tz;
      seed([]);
      seen[tz] = allText(itemList());
    }
  } finally {
    if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior;
    t.mock.timers.reset();
  }
  unseedFeeds();
  seed([]);
  assert.match(seen['Asia/Tokyo'], /sD zoned event\s+9:00 PM/, '12:00 UTC is 9 PM in Tokyo');
  assert.match(seen['Pacific/Honolulu'], /sD zoned event\s+2:00 AM/, '12:00 UTC is 2 AM in Honolulu');
});

// --- D6: one calendar refresh at a time ------------------------------------

test('sweep D: two quick resumes fetch each calendar once, and a feed pulled meanwhile is still fetched', async () => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sD-g1')], {}); // never fetched, so stale
  const calls = [];
  const gates = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return new Promise((resolve) => { gates.push(() => resolve({ ok: true, text: async () => '' })); });
  };
  const releaseAll = async () => {
    for (let i = 0; i < 5; i += 1) { while (gates.length) gates.shift()(); await settle(); }
  };
  const fetchesOf = (id) => calls.filter((u) => u.includes(encodeURIComponent(`https://example.com/${id}.ics`))).length;
  try {
    resume();
    resume();
    await settle();
    assert.equal(fetchesOf('sD-g1'), 1, 'the second resume must not start a second fetch of the same calendar');
    // A feed this device learns about from a sync while that fetch is in flight.
    applySyncedState(state({ feeds: [sdFeed('sD-g2')] }));
    await releaseAll();
    assert.equal(fetchesOf('sD-g1'), 1, 'and it is not fetched again once the first fetch lands');
    assert.equal(fetchesOf('sD-g2'), 1, 'a feed pulled during the fetch is fetched once it settles, not dropped');
  } finally {
    while (gates.length) gates.shift()();
    await settle();
    globalThis.fetch = originalFetch;
  }
  unseedFeeds();
  saveTombstones([]);
});

// --- D7: the List's footer is a human date ----------------------------------

test('sweep D: the List footer names its horizon as a date, not raw ISO', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seedFeedsWithCache([sdFeed('sD-foot')], { 'sD-foot': cacheAt(new Date()) });
  const horizon = addDays(localISO(new Date()), 366);
  const text = allText(itemList());
  unseedFeeds();
  assert.match(text, new RegExp(`external calendars shown through ${formatDayLabel(horizon, localISO(new Date()))}`));
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, 'no raw ISO date on screen');
});

// --- S-1: the week and month cursors follow a resume too --------------------

const weekLabelFor = (iso) => `${iso.slice(5).replace('-', '/')} – ${addDays(iso, 6).slice(5).replace('-', '/')}`;
const monthLabelFor = (d) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

test('sweep D: the Week view follows a resume, and a navigated week stays put', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  assert.equal(labelText('week-label'), weekLabelFor(startOfWeek(localISO(new Date()))), 'fixture check');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + WEEK });
  try {
    resume();
    assert.equal(labelText('week-label'), weekLabelFor(startOfWeek(localISO(new Date()))));
  } finally {
    t.mock.timers.reset();
  }
  resume();
  click(globalThis.document.getElementById('prev-week'));
  const moved = labelText('week-label');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + WEEK });
  try {
    resume();
    assert.equal(labelText('week-label'), moved, 'a week the user navigated to must not jump');
  } finally {
    t.mock.timers.reset();
  }
  click(globalThis.document.getElementById('next-week'));
  resume();
  assert.equal(labelText('week-label'), weekLabelFor(startOfWeek(localISO(new Date()))), 'restored for later tests');
});

test('sweep D: the Month view follows a resume, and a navigated month stays put', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const real = new Date();
  const nextMonth = new Date(real.getFullYear(), real.getMonth() + 1, 1, 12);
  assert.equal(labelText('calendar-label'), monthLabelFor(real), 'fixture check');
  t.mock.timers.enable({ apis: ['Date'], now: nextMonth.getTime() });
  try {
    resume();
    assert.equal(labelText('calendar-label'), monthLabelFor(nextMonth));
  } finally {
    t.mock.timers.reset();
  }
  resume();
  click(globalThis.document.getElementById('prev-month'));
  const moved = labelText('calendar-label');
  t.mock.timers.enable({ apis: ['Date'], now: nextMonth.getTime() });
  try {
    resume();
    assert.equal(labelText('calendar-label'), moved, 'a month the user navigated to must not jump');
  } finally {
    t.mock.timers.reset();
  }
  click(globalThis.document.getElementById('next-month'));
  resume();
  assert.equal(labelText('calendar-label'), monthLabelFor(new Date()), 'restored for later tests');
});

// --- S-2: the Google link on a date whose month and day are one digit -------

test('sweep D: the Google day link is unpadded on a single-digit month and day', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 2, 5, 12, 0).getTime() }); // Thu Mar 5 2026
  try {
    seedFeed({
      id: 'sD-google', url: 'https://calendar.google.com/calendar/ical/sD/basic.ics', name: 'G',
      color: 'var(--feed-palette-1)', hidden: false, updatedAt: '2026-08-01T00:00:00.000Z',
    });
    click(openControlFor(itemList(), 'Standup from the feed'));
    assert.equal(sheetHost().querySelector('.sheet-google').href, 'https://calendar.google.com/calendar/r/day/2026/3/5');
  } finally {
    forceCloseSheet();
    unseedFeeds();
    t.mock.timers.reset();
  }
  seed([]);
});

// --- S-4: going to the background refreshes nothing -------------------------

test('sweep D: a hidden visibilitychange changes no label and no stamp, and fetches nothing', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sD-hid')], {}); // stale: a visible resume would fetch it
  const ids = ['day-label', 'week-label', 'calendar-label', 'updated-stamp'];
  const before = ids.map(labelText);
  const launches = loadLaunches().length;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, text: async () => '' }; };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 40 * 24 * 60 * 60 * 1000 });
  globalThis.document.visibilityState = 'hidden';
  try {
    resume();
    await settle();
  } finally {
    globalThis.document.visibilityState = 'visible';
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(ids.map(labelText), before);
  assert.deepEqual(calls, []);
  assert.equal(loadLaunches().length - launches, 0);
  unseedFeeds();
});

// --- extra: a tick that fails does not leave the box looking ticked ---------

test('sweep D: a tick that fails on quota is shown unticked again, with the error', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sD-tick', type: 'task', title: 'sD tick me', date: '2099-07-09' })]);
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    if (k === 'plaenicke.items') { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
    return real(k, v);
  };
  try {
    const box = checkboxFor(todoList(), 'sD tick me');
    box.checked = true;
    fire(box, 'change');
  } finally {
    localStorage.setItem = real;
  }
  assert.equal(storedById('sD-tick').done, false, 'fixture check: the tick was not saved');
  assert.equal(checkboxFor(todoList(), 'sD tick me').checked, false, 'the box must not look ticked');
  assert.match(messageText(), /quota/i);
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// =========================================================================
// Sweep U — the UI batch, through the real app
// =========================================================================
//
// Ids are prefixed `sU-`. Every test that shows a toast ends with it resolved
// and #toast-host empty.

const PAGES = [
  ['List', 'show-list', 'list-view', () => itemList()],
  ['Day', 'show-day', 'day-view', () => dayBody()],
  ['To-do', 'show-todo', 'todo-view', () => todoList()],
  ['Ideas', 'show-ideas', 'ideas-view', () => ideaList()],
];
// The nav button of whichever page is showing, to put it back afterwards.
function visiblePageButton() {
  for (const [buttonId, sectionId] of [
    ['show-list', 'list-view'], ['show-month', 'calendar-view'], ['show-week', 'week-view'],
    ['show-day', 'day-view'], ['show-todo', 'todo-view'], ['show-ideas', 'ideas-view'],
  ]) {
    if (!globalThis.document.getElementById(sectionId).hidden) return globalThis.document.getElementById(buttonId);
  }
  return null;
}
// Is `el` still attached somewhere under `root`?
function isUnder(root, el) {
  for (let n = el; n; n = n.parentNode) if (n === root) return true;
  return false;
}

// U6: closing the sheet puts focus back on the item's opener. A Save
// re-renders every page, so the button tapped is gone; the NEW one, found by
// item id on the page that is showing, is the one focused.
test('sweep U: after a Save, focus returns to the re-rendered opener on the page that is showing', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const today = localISO(new Date());
  seed([
    record({ id: 'sU-focus-task', type: 'task', title: 'sU focus task', date: today }),
    record({ id: 'sU-focus-idea', type: 'idea', title: 'sU focus idea', date: today }),
  ]);
  const restore = visiblePageButton();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const [name, buttonId, , root] of PAGES) {
      click(globalThis.document.getElementById(buttonId));
      const id = name === 'Ideas' ? 'sU-focus-idea' : 'sU-focus-task';
      const title = name === 'Ideas' ? 'sU focus idea' : 'sU focus task';
      const opener = openControlFor(root(), title);
      assert.ok(opener, `fixture check: the ${name} page lists the item`);
      assert.equal(opener.getAttribute('data-item-id'), id, `the ${name} opener carries its item id`);
      click(opener);
      if (name === 'Ideas') sheetHost().querySelector('.sheet-text').value = `${title} (${name})`;
      else sheetHost().querySelector('.sheet-notes').value = `saved from ${name}`;
      click(sheetHost().querySelector('.sheet-save'));
      assert.equal(sheetHost().children.length, 0, 'fixture check: the save closed the sheet');
      const focused = globalThis.document.activeElement;
      assert.ok(focused, `${name}: something must be focused`);
      assert.notEqual(focused, opener, `${name}: the tapped button was re-rendered away; focus the new one`);
      assert.ok(focused._classes.has('item-open'), `${name}: the opener is focused`);
      assert.equal(focused.getAttribute('data-item-id'), id);
      assert.ok(isUnder(root(), focused), `${name}: on the page that is showing, not a hidden one`);
      t.mock.timers.tick(5000); // settle the Saved toast
    }
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
    if (restore) click(restore);
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// The Day grid's timed blocks build their opener separately from its
// "Other tasks" list; each needs the id.
test('sweep U: after a Save, focus returns to a timed Day block\'s opener', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sU-timed', type: 'event', title: 'sU timed block', date: localISO(new Date()), time: '10:00', endTime: '11:00' })]);
  const restore = visiblePageButton();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(globalThis.document.getElementById('show-day'));
    const opener = openControlFor(dayBody(), 'sU timed block');
    assert.ok(opener, 'fixture check: the block is on the Day grid');
    click(opener);
    sheetHost().querySelector('.sheet-notes').value = 'timed';
    click(sheetHost().querySelector('.sheet-save'));
    const focused = globalThis.document.activeElement;
    assert.equal(focused?.getAttribute('data-item-id'), 'sU-timed');
    assert.notEqual(focused, opener);
    assert.ok(isUnder(dayBody(), focused));
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
    if (restore) click(restore);
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

test('sweep U: Cancel returns focus to the opener too', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sU-cancel', title: 'sU cancel me', date: '2099-02-02' })]);
  const restore = visiblePageButton();
  try {
    click(globalThis.document.getElementById('show-list'));
    click(openControlFor(itemList(), 'sU cancel me'));
    globalThis.document.activeElement = null;
    closeSheet();
    assert.equal(globalThis.document.activeElement?.getAttribute('data-item-id'), 'sU-cancel');
  } finally {
    forceCloseSheet();
    if (restore) click(restore);
  }
  seed([]);
});

// U10: the List row's text block takes the row's whole width, so a tap
// anywhere on it (not only on the text) lands on the opener.
test('sweep U: the List row\'s main block is the flexible one', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sU-main', title: 'sU main block', date: '2099-02-03' })]);
  const opener = openControlFor(itemList(), 'sU main block');
  assert.ok(opener.parentNode._classes.has('list-main'));
  seed([]);
});

// U14: the Google link is offered only for Google's own hosts. inferName's
// substring test says "Google" for these look-alikes; the link must not.
for (const [label, url, linked] of [
  ['a look-alike domain', 'https://evilgoogle.com/sU-SECRET-1/basic.ics', false],
  ['google.com inside another host', 'https://calendar.google.com.evil.example/sU-SECRET-2/basic.ics', false],
  ['calendar.google.com', 'https://calendar.google.com/calendar/ical/sU-SECRET-3/basic.ics', true],
  ['another google.com subdomain', 'https://www.google.com/calendar/ical/sU-SECRET-4/basic.ics', true],
  ['an unparseable URL', 'not a url google.com sU-SECRET-5', false],
]) {
  test(`sweep U: the Google link for ${label} is ${linked ? 'offered' : 'not offered'}`, async () => {
    installFakeLocalStorage();
    await import('../js/app.js');
    seed([]);
    seedFeed({
      id: 'sU-feed', url, name: 'Mine', color: 'var(--feed-palette-1)', hidden: false,
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    try {
      click(openControlFor(itemList(), 'Standup from the feed'));
      assert.ok(sheetHost().querySelector('.sheet'), 'fixture check: the sheet opened');
      const link = sheetHost().querySelector('.sheet-google');
      assert.equal(!!link, linked);
      if (link) assert.match(link.href, /^https:\/\/calendar\.google\.com\/calendar\/r\/day\//);
      const secret = /sU-SECRET-\d/.exec(url)[0];
      for (const root of [sheetHost(), globalThis.document.getElementById('message'), toastHost()]) {
        for (const s of stringsOf(root)) {
          assert.ok(!s.includes(secret), `the feed URL must appear nowhere; found it in ${JSON.stringify(s)}`);
        }
      }
    } finally {
      forceCloseSheet();
      unseedFeeds();
    }
  });
}

// S-10 / U13: the live regions are in the page from the start (a region
// inserted already filled is often not announced), and the toast's own
// container is NOT one, so its Undo button is never read as part of a notice.
test('sweep U: index.html has a persistent #toast-live status region, and #toast-host is not live', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const tag = (id) => {
    const m = new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
    assert.ok(m, `index.html has no #${id}`);
    return m[0];
  };
  const live = tag('toast-live');
  assert.match(live, /\brole="status"/);
  assert.match(live, /\baria-live="polite"/);
  const toastHostTag = tag('toast-host');
  assert.doesNotMatch(toastHostTag, /\brole=/, '#toast-host holds the Undo button, so it must not be a live region');
  assert.doesNotMatch(toastHostTag, /\baria-live=/);
});

test('sweep U: a delete announces its message in #toast-live, and it clears when resolved', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sU-live', title: 'sU live one', date: '2099-02-04' })]);
  const live = globalThis.document.getElementById('toast-live');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    click(deleteControlFor(itemList(), 'sU live one'));
    assert.equal(live.textContent, 'Deleted "sU live one"');
    assert.ok(toastHost().querySelector('.toast-undo'), 'the Undo is in the visible toast');
    click(toastHost().querySelector('.toast-undo'));
    assert.equal(live.textContent, '');
  } finally {
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  seed([]);
});

// =========================================================================
// Sweep batch F — from the re-reviews of batches S, D and U
// =========================================================================
//
// Ids are prefixed `sF-`. Every test that shows a toast resolves it and leaves
// the toast host empty.

const UNDO_REFUSED = "Changes from your other device were kept, so this couldn't be undone.";
const UNDO_KEPT = 'Some changes from your other device were kept.';

// F1 (sync I1): an idea switched to a task, then the other device renamed the
// task. Restoring `type: 'idea'` without the title would let normalizeIdea
// derive a title from the notes and write over THEIR TITLE, while the message
// claimed their change was kept.
test('sF: an Undo across the idea line with a field changed since is refused whole', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({
    id: 'sF-boat', type: 'idea', title: 'Buy a boat', notes: 'Buy a boat. A small one, for the lake.', date: '2099-08-01',
  })]);
  const restore = visiblePageButton();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    clearMessage();
    click(globalThis.document.getElementById('show-ideas'));
    click(openControlFor(ideaList(), 'Buy a boat'));
    sheetHost().querySelector('.sheet-type').value = 'task';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(storedById('sF-boat').type, 'task', 'fixture check: the switch landed');
    applySyncedState(state({ items: [{ ...storedById('sF-boat'), title: 'THEIR TITLE', updatedAt: S_AHEAD }] }));
    assert.equal(storedById('sF-boat').title, 'THEIR TITLE', 'fixture check: the newer sync landed');
    const before = rawStored();
    click(toastHost().querySelector('.toast-undo'));
    assert.equal(storedById('sF-boat').title, 'THEIR TITLE', 'their title survives');
    assert.equal(rawStored(), before, 'nothing is written');
    assert.equal(messageText(), UNDO_REFUSED);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
    if (restore) click(restore);
  }
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// The type check on its own: here every restored field would apply cleanly and
// the skipped one (notes) would survive, but the result would be a task with
// the other device's idea text in it. A partial Undo across the idea line is
// refused before it is attempted.
test('sF: an Undo back across the idea line is refused when the idea text changed since', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({
    id: 'sF-toidea', type: 'task', title: 'sF call Bob', date: '2099-08-02', time: '09:00', endTime: '10:00',
  })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    clearMessage();
    click(openControlFor(itemList(), 'sF call Bob'));
    sheetHost().querySelector('.sheet-type').value = 'idea';
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(storedById('sF-toidea').type, 'idea', 'fixture check: the switch landed');
    applySyncedState(state({
      items: [{ ...storedById('sF-toidea'), notes: 'sF call Bob on Friday instead', updatedAt: S_AHEAD }],
    }));
    const before = rawStored();
    click(toastHost().querySelector('.toast-undo'));
    assert.equal(rawStored(), before, 'nothing is written');
    assert.equal(storedById('sF-toidea').type, 'idea');
    assert.equal(messageText(), UNDO_REFUSED);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// The check after applyEdit, on its own: no type change, but an idea's title
// is derived from its notes. Restoring the notes while skipping the title the
// other device changed would re-derive the title over theirs.
test('sF: an Undo whose rebuild would change a skipped field is refused', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({
    id: 'sF-ideakeep', type: 'idea', title: 'sF idea keep is the first sentence.',
    notes: 'sF idea keep is the first sentence. Then enough further words to make this a long idea.', date: '2099-08-07',
  })]);
  const restore = visiblePageButton();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    clearMessage();
    click(globalThis.document.getElementById('show-ideas'));
    click(openControlFor(ideaList(), 'sF idea keep'));
    const mine = 'sF idea mine is the first sentence. Then enough further words to make this a long idea.';
    sheetHost().querySelector('.sheet-text').value = mine;
    click(sheetHost().querySelector('.sheet-save'));
    assert.equal(storedById('sF-ideakeep').notes, mine, 'fixture check: the edit landed');
    assert.equal(storedById('sF-ideakeep').title, 'sF idea mine is the first sentence.', 'fixture check: title derived');
    applySyncedState(state({ items: [{ ...storedById('sF-ideakeep'), title: 'THEIR IDEA TITLE', updatedAt: S_AHEAD }] }));
    const before = rawStored();
    click(toastHost().querySelector('.toast-undo'));
    assert.equal(storedById('sF-ideakeep').title, 'THEIR IDEA TITLE', 'their title survives');
    assert.equal(rawStored(), before, 'nothing is written');
    assert.equal(messageText(), UNDO_REFUSED);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
    if (restore) click(restore);
  }
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// F2 (sync I2): time and endTime are one value. The start was edited, then the
// other device moved the end. Restoring the old start alone would pair it with
// their end, a range neither device ever set.
test('sF: an Undo keeps both times when a sync changed the end since', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({ id: 'sF-times', title: 'sF timed', date: '2099-08-03', time: '09:00', endTime: '10:00' })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    clearMessage();
    click(openControlFor(itemList(), 'sF timed'));
    sheetHost().querySelector('.sheet-time').value = '08:00';
    click(sheetHost().querySelector('.sheet-save'));
    applySyncedState(state({ items: [{ ...storedById('sF-times'), endTime: '11:00', updatedAt: S_AHEAD }] }));
    const before = rawStored();
    click(toastHost().querySelector('.toast-undo'));
    const r = storedById('sF-times');
    assert.equal(r.time, '08:00', 'the start is not restored on its own');
    assert.equal(r.endTime, '11:00', 'their end is kept');
    assert.equal(rawStored(), before, 'nothing left to restore, so nothing is written');
    assert.equal(messageText(), UNDO_KEPT);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// F2: a filtered restore that fails validation says the Undo could not be done,
// not the validator's text about a field the user did not touch. The other
// device sent a record whose times are out of order (merge passes records
// through whole); restoring the title alone rebuilds it through makeItem.
test('sF: a filtered Undo that fails validation says it could not be undone', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([record({
    id: 'sF-val', title: 'sF val', notes: 'n0', date: '2099-08-04', time: '09:00', endTime: '10:00',
  })]);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: S_NOW });
  try {
    clearMessage();
    click(openControlFor(itemList(), 'sF val'));
    sheetHost().querySelector('.sheet-title').value = 'sF val mine';
    sheetHost().querySelector('.sheet-notes').value = 'n mine';
    click(sheetHost().querySelector('.sheet-save'));
    applySyncedState(state({
      items: [{ ...storedById('sF-val'), notes: 'n theirs', time: '11:00', endTime: '10:00', updatedAt: S_AHEAD }],
    }));
    assert.equal(storedById('sF-val').time, '11:00', 'fixture check: the out-of-order record landed');
    const before = rawStored();
    click(toastHost().querySelector('.toast-undo'));
    assert.equal(rawStored(), before, 'nothing is written');
    assert.equal(messageText(), UNDO_REFUSED);
  } finally {
    forceCloseSheet();
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
  }
  assert.equal(toastHost().children.length, 0);
  clearMessage();
  seed([]);
});

// F3 (sync I3): an arrow tapped after midnight acts on the day the user can
// see. Without catching up with the clock first, the render after the tap
// read the new cursor as "showing the old today" and carried it forward: the
// Day view bounced back to where it was.
test('sF: the Day arrows after midnight move from the day on screen, with no bounce', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const startDay = new Date();
  assert.equal(labelText('day-label'), labelFor(startDay), 'fixture check: the Day view is on today');
  click(globalThis.document.getElementById('next-day'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 });
  try {
    const newToday = new Date();
    click(globalThis.document.getElementById('prev-day'));
    const dayBeforeNewToday = new Date(newToday.getFullYear(), newToday.getMonth(), newToday.getDate() - 1);
    assert.equal(labelText('day-label'), labelFor(dayBeforeNewToday));
    seed([]); // a later render leaves it there
    assert.equal(labelText('day-label'), labelFor(dayBeforeNewToday));
  } finally {
    t.mock.timers.reset();
  }
  resume();
  assert.equal(labelText('day-label'), labelFor(new Date()), 'restored for later tests');
});

test('sF: the Week arrows after the week turns move from the week on screen, with no bounce', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const thisWeek = startOfWeek(localISO(new Date()));
  assert.equal(labelText('week-label'), weekLabelFor(thisWeek), 'fixture check');
  click(globalThis.document.getElementById('next-week'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + WEEK });
  try {
    click(globalThis.document.getElementById('prev-week'));
    assert.equal(labelText('week-label'), weekLabelFor(thisWeek), 'the week before the new today\'s week');
    seed([]);
    assert.equal(labelText('week-label'), weekLabelFor(thisWeek));
  } finally {
    t.mock.timers.reset();
  }
  resume();
  assert.equal(labelText('week-label'), weekLabelFor(startOfWeek(localISO(new Date()))), 'restored for later tests');
});

test('sF: the Month arrows after the month turns move from the month on screen, with no bounce', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const real = new Date();
  const nextMonth = new Date(real.getFullYear(), real.getMonth() + 1, 1, 12);
  assert.equal(labelText('calendar-label'), monthLabelFor(real), 'fixture check');
  click(globalThis.document.getElementById('next-month'));
  t.mock.timers.enable({ apis: ['Date'], now: nextMonth.getTime() });
  try {
    click(globalThis.document.getElementById('prev-month'));
    assert.equal(labelText('calendar-label'), monthLabelFor(real), 'the month before the new today\'s month');
    seed([]); // the next render must not carry it forward
    assert.equal(labelText('calendar-label'), monthLabelFor(real));
  } finally {
    t.mock.timers.reset();
  }
  resume();
  assert.equal(labelText('calendar-label'), monthLabelFor(new Date()), 'restored for later tests');
});

// The "next" arrows, the same way round: back one, the clock turns, forward
// one. Each must land on the old today, the one before the new today.
test('sF: the next arrows after the clock turns move from what is on screen, with no bounce', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  const real = new Date();
  const DAY = 24 * 60 * 60 * 1000;
  const cases = [
    ['prev-day', 'next-day', 'day-label', Date.now() + DAY, labelFor(real)],
    ['prev-week', 'next-week', 'week-label', Date.now() + 7 * DAY, weekLabelFor(startOfWeek(localISO(real)))],
    ['prev-month', 'next-month', 'calendar-label',
      new Date(real.getFullYear(), real.getMonth() + 1, 1, 12).getTime(), monthLabelFor(real)],
  ];
  for (const [back, forward, labelId, later, expected] of cases) {
    click(globalThis.document.getElementById(back));
    t.mock.timers.enable({ apis: ['Date'], now: later });
    try {
      click(globalThis.document.getElementById(forward));
      assert.equal(labelText(labelId), expected, `${forward}: the one before the new today`);
      seed([]);
      assert.equal(labelText(labelId), expected, `${forward}: a later render leaves it there`);
    } finally {
      t.mock.timers.reset();
    }
    resume();
    assert.equal(labelText(labelId), expected, `${forward}: restored for later tests`);
  }
});

// F4 (sync I4), reworked after the batch-F review: the timeout is PER FETCH,
// not per batch. A batch timeout declared a slow-but-progressing batch failed
// and then ignored its results, and left the timed-out batch's loop running,
// so a resume could fetch the same calendar twice at once.
function okFeedResponse() { return { ok: true, status: 200, text: async () => '' }; }

test('sF: a slow batch that is still making progress is not declared failed', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sF-slow1'), sdFeed('sF-slow2')], {});
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => { setTimeout(() => resolve(okFeedResponse()), 15000); });
  stampEl().textContent = 'sentinel';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    resume();
    await settle();
    t.mock.timers.tick(15000);
    await settle();
    t.mock.timers.tick(15000);
    for (let i = 0; i < 5; i += 1) await settle();
    assert.match(stampEl().textContent, /^Updated /, 'two 15 s fetches are 30 s of progress, not a failure');
  } finally {
    for (let i = 0; i < 4; i += 1) { t.mock.timers.tick(20000); await settle(); }
    unseedFeeds();
    for (let i = 0; i < 5; i += 1) await settle();
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

test('sF: a fetch that never answers is aborted, the batch moves on, and it is never fetched twice at once', async (t) => {
  installFakeLocalStorage();
  const { applySyncedState } = await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sF-hang'), sdFeed('sF-next')], {});
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), signal: init && init.signal });
    if (String(url).includes('sF-hang')) return new Promise(() => {}); // ignores its signal on purpose
    return Promise.resolve(okFeedResponse());
  };
  const fetchesOf = (id) => calls.filter((c) => c.url.includes(encodeURIComponent(`https://example.com/${id}.ics`)));
  const originalError = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a); };
  stampEl().textContent = 'sentinel';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    resume();
    await settle();
    assert.equal(fetchesOf('sF-hang').length, 1, 'fixture check: the hung calendar is being fetched');
    applySyncedState(state({ feeds: [sdFeed('sF-hang'), sdFeed('sF-next'), sdFeed('sF-queued')] }));
    await settle();
    t.mock.timers.tick(20000);
    for (let i = 0; i < 5; i += 1) await settle();
    assert.equal(fetchesOf('sF-hang')[0].signal.aborted, true, 'the hung fetch is aborted, not abandoned');
    assert.equal(fetchesOf('sF-next').length, 1, 'the batch moves on to the next calendar');
    assert.equal(stampEl().textContent, "Couldn't refresh calendars", 'and says one calendar failed');
    assert.equal(fetchesOf('sF-queued').length, 1, 'the queue drains');
    resume();
    await settle();
    const hangs = fetchesOf('sF-hang');
    assert.equal(hangs.length, 2, 'the next resume retries it');
    assert.ok(hangs[0].signal.aborted, 'while the first attempt is already aborted: never two at once');
  } finally {
    for (let i = 0; i < 4; i += 1) { t.mock.timers.tick(20000); for (let j = 0; j < 3; j += 1) await settle(); }
    unseedFeeds();
    for (let i = 0; i < 5; i += 1) await settle();
    t.mock.timers.reset();
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
  assert.ok(!logged.some((a) => a.some((x) => String(x).includes('example.com'))), 'never the feed URL');
  saveTombstones([]);
});

// F7 (sync O5): a change of calendars in Settings changes what the stamp is
// about. Removing the only visible calendar leaves only local data on screen,
// so the stamp becomes the render time.
test('sF: removing a calendar in Settings repaints the Updated stamp', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sF-stamp')], { 'sF-stamp': cacheAt(localAt(10, 20)) });
  const settingsBtn = globalThis.document.getElementById('settings-btn');
  const settingsHost = globalThis.document.getElementById('settings-host');
  if (settingsHost.childElementCount) click(settingsBtn); // left open by an earlier test
  stampEl().textContent = 'sentinel';
  t.mock.timers.enable({ apis: ['Date'], now: localAt(10, 40).getTime() });
  try {
    click(settingsBtn);
    const remove = settingsHost.querySelectorAll('button').find((b) => b.textContent === 'Remove');
    assert.ok(remove, 'fixture check: the panel offers Remove');
    click(remove);
    assert.deepEqual(loadFeeds(), [], 'fixture check: removed');
    assert.equal(stampEl().textContent, 'Updated 10:40 AM');
  } finally {
    t.mock.timers.reset();
    if (settingsHost.childElementCount) click(settingsBtn);
  }
  saveTombstones([]);
  unseedFeeds();
});

// F9 (UI I1): returning focus must not scroll the page to the opener.
test('sF: focus goes back to the opener without scrolling', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sF-focus', title: 'sF focus me', date: '2099-08-05' })]);
  const restore = visiblePageButton();
  try {
    click(globalThis.document.getElementById('show-list'));
    click(openControlFor(itemList(), 'sF focus me'));
    globalThis.document.activeElement = null;
    globalThis.document.lastFocusOptions = undefined;
    closeSheet();
    assert.equal(globalThis.document.activeElement?.getAttribute('data-item-id'), 'sF-focus', 'fixture check');
    assert.deepEqual(globalThis.document.lastFocusOptions, { preventScroll: true });
  } finally {
    forceCloseSheet();
    if (restore) click(restore);
  }
  seed([]);
});

// F11 (UI O2): the sheet and Settings share one page lock, so closing either
// first leaves the page locked while the other is open, and unlocked once both
// are closed.
test('sF: the page stays locked while Settings or a sheet is open, whichever closes first', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([record({ id: 'sF-lock', title: 'sF lock me', date: '2099-08-06' })]);
  const body = globalThis.document.body;
  const settingsBtn = globalThis.document.getElementById('settings-btn');
  const settingsHost = globalThis.document.getElementById('settings-host');
  if (settingsHost.childElementCount) click(settingsBtn); // left open by an earlier test
  const restore = visiblePageButton();
  try {
    click(globalThis.document.getElementById('show-list'));
    body.style.overflow = '';
    for (const settingsFirst of [true, false]) {
      const label = settingsFirst ? 'Settings closed first' : 'sheet closed first';
      click(settingsBtn);
      assert.equal(body.style.overflow, 'hidden', `${label}: Settings locks the page`);
      click(openControlFor(itemList(), 'sF lock me'));
      assert.equal(body.style.overflow, 'hidden', `${label}: both open`);
      if (settingsFirst) click(settingsBtn); else closeSheet();
      assert.equal(settingsHost.childElementCount === 0, settingsFirst, `fixture check (${label})`);
      assert.equal(body.style.overflow, 'hidden', `${label}: the other is still open, so the page stays locked`);
      if (settingsFirst) closeSheet(); else click(settingsBtn);
      assert.equal(body.style.overflow, '', `${label}: both closed, so the page is unlocked`);
    }
  } finally {
    forceCloseSheet();
    if (settingsHost.childElementCount) click(settingsBtn);
    if (restore) click(restore);
  }
  seed([]);
});

// Batch-F review, Important 1: the mirror of I3. The SCREEN still shows the
// old today (nothing re-rendered since midnight — a desktop tab left open), and
// an arrow must step from what is on screen, not from the caught-up today.
test('sF2: an arrow on a stale screen steps from the day shown, not from the new today', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  click(globalThis.document.getElementById('show-day'));
  const realNow = Date.now();
  const dayLabel = globalThis.document.getElementById('day-label');
  assert.equal(dayLabel.textContent, labelFor(new Date(realNow)), 'fixture check: showing today');
  t.mock.timers.enable({ apis: ['Date'], now: realNow + 24 * 60 * 60 * 1000 });
  try {
    click(globalThis.document.getElementById('next-day'));
    assert.equal(dayLabel.textContent, labelFor(new Date(realNow + 24 * 60 * 60 * 1000)),
      'next from the old today shown is the new today — not the day after it');
    click(globalThis.document.getElementById('prev-day'));
    assert.equal(dayLabel.textContent, labelFor(new Date(realNow)), 'and prev steps back from there');
  } finally {
    t.mock.timers.reset();
  }
  resume();
});

test('sF2: a week arrow on a stale screen steps from the week shown', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  click(globalThis.document.getElementById('show-week'));
  const weekLabel = globalThis.document.getElementById('week-label');
  const before = weekLabel.textContent;
  const realNow = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: realNow + 7 * 24 * 60 * 60 * 1000 });
  try {
    click(globalThis.document.getElementById('prev-week'));
    click(globalThis.document.getElementById('next-week'));
    assert.equal(weekLabel.textContent, before, 'prev then next returns to the week that was on screen');
  } finally {
    t.mock.timers.reset();
  }
  resume();
  click(globalThis.document.getElementById('show-day'));
});

// Batch-F review, observations 4 and 5: the stamp must stay honest on a
// Settings change (it had no memory of the last batch's failures, and showed a
// days-old time with no date), and a calendar still being fetched for the
// first time is not a failure.
function tapColourDot(feedName) {
  const settingsBtn = globalThis.document.getElementById('settings-btn');
  const settingsHost = globalThis.document.getElementById('settings-host');
  if (settingsHost.childElementCount) click(settingsBtn);
  click(settingsBtn);
  const dot = settingsHost.querySelectorAll('button')
    .find((b) => (b.getAttribute('aria-label') || '').includes(feedName) && b.className.includes('feed-dot'));
  assert.ok(dot, `fixture check: a colour dot for ${feedName}`);
  click(dot);
  click(settingsBtn);
}

test('sF2: a Settings change keeps "Couldn\'t refresh" after a failed refresh', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sF2-bad'), sdFeed('sF2-good')],
    { 'sF2-bad': cacheAt(localAt(7, 0)), 'sF2-good': cacheAt(localAt(7, 0)) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => Promise.resolve(String(url).includes('sF2-bad')
    ? { ok: false, status: 502, json: async () => ({ error: 'upstream_error' }), text: async () => '' }
    : { ok: true, status: 200, text: async () => '' });
  t.mock.timers.enable({ apis: ['Date'], now: localAt(10, 0).getTime() });
  try {
    resume();
    for (let i = 0; i < 6; i += 1) await settle();
    assert.equal(stampEl().textContent, "Couldn't refresh calendars", 'fixture check: the refresh failed');
    tapColourDot('sF2-good');
    assert.equal(stampEl().textContent, "Couldn't refresh calendars", 'a colour tap must not erase the failure');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
  unseedFeeds();
  saveTombstones([]);
});

test('sF2: a stamp from an earlier day names the day', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sF2-old')], { 'sF2-old': cacheAt(new Date(2026, 8, 21, 9, 2)) });
  t.mock.timers.enable({ apis: ['Date'], now: localAt(10, 0).getTime() });
  try {
    tapColourDot('sF2-old');
    assert.equal(stampEl().textContent, 'Updated Mon, Sep 21, 9:02 AM');
  } finally {
    t.mock.timers.reset();
  }
  unseedFeeds();
});

test('sF2: a calendar not yet fetched for the first time is not reported as a failure', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sF2-fetched'), sdFeed('sF2-new')], { 'sF2-fetched': cacheAt(localAt(9, 30)) });
  t.mock.timers.enable({ apis: ['Date'], now: localAt(10, 0).getTime() });
  try {
    tapColourDot('sF2-fetched');
    assert.equal(stampEl().textContent, 'Updated 9:30 AM', 'the new calendar is simply not counted yet');
  } finally {
    t.mock.timers.reset();
  }
  unseedFeeds();
});

test('sF2: a calendar that failed and then refreshes clears "Couldn\'t refresh"', async (t) => {
  installFakeLocalStorage();
  await import('../js/app.js');
  seed([]);
  seedFeedsWithCache([sdFeed('sF2-flaky')], { 'sF2-flaky': cacheAt(localAt(7, 0)) });
  let up = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(up
    ? { ok: true, status: 200, text: async () => '' }
    : { ok: false, status: 502, json: async () => ({ error: 'upstream_error' }), text: async () => '' });
  t.mock.timers.enable({ apis: ['Date'], now: localAt(10, 0).getTime() });
  try {
    resume();
    for (let i = 0; i < 6; i += 1) await settle();
    assert.equal(stampEl().textContent, "Couldn't refresh calendars", 'fixture check: first refresh failed');
    up = true;
    resume();
    for (let i = 0; i < 6; i += 1) await settle();
    assert.equal(stampEl().textContent, 'Updated 10:00 AM', 'a later success must clear the failure');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
  unseedFeeds();
});
