import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { SCHEMA_VERSION } from '../js/merge.js';
import {
  saveItems, loadItems, saveTombstones, saveFeeds, loadFeeds, loadTombstones, loadSyncState,
} from '../js/storage.js';
import { linkWithCode, clearAdoptionPending } from '../js/auth.js';
import { bytesToBase64url, TOKEN_BYTES } from '../js/crypto.js';
import { SYNC_STATUS_ID, SHELL_SYNC_STATUS_ID } from '../js/linkui.js';

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
}

function makeFakeDocument() {
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  const byId = new Map();
  const listeners = {};
  return {
    documentElement,
    body,
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

function click(el) { (el._listeners.click || []).forEach((fn) => fn({ target: el })); }

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
