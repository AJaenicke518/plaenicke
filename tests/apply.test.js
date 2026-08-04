import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { SCHEMA_VERSION } from '../js/merge.js';
import {
  saveItems, loadItems, saveTombstones, saveFeeds, loadFeeds, loadTombstones,
} from '../js/storage.js';
import { linkWithCode } from '../js/auth.js';
import { bytesToBase64url, TOKEN_BYTES } from '../js/crypto.js';

// --- js/linkui.js does not exist yet (Task 8) -------------------------------
//
// app.js's plan-mandated import list (spec Task 7) includes
// `import { renderSyncStatus } from './linkui.js';`. js/linkui.js is Task 8's
// file and must not be stubbed into existence on disk — but leaving the
// import as-is means Node's module loader throws ERR_MODULE_NOT_FOUND before
// ANY of app.js's module-scope code runs, including the code this file
// exists to test. This registers an ESM resolution hook, scoped to this
// process only, that redirects just the one `.../linkui.js` specifier to a
// tiny in-memory `data:` module — no file is ever written anywhere.
//
// CORRECTNESS NOTE: a resolve hook runs BEFORE Node's default resolution,
// not after — it does not get consulted only when the normal lookup fails.
// An earlier version of this hook returned the stub unconditionally for any
// `.../linkui.js` specifier, which would keep shadowing a REAL js/linkui.js
// forever once Task 8 lands (verified: with a real file on disk exporting a
// distinguishable value, the unconditional version still resolved to the
// stub). This version tries the real resolution FIRST via nextResolve(), and
// only falls back to the in-memory stub if that fails with
// ERR_MODULE_NOT_FOUND — so the hook self-removes the moment a real
// js/linkui.js exists, and any other resolution failure (a typo, a real
// syntax error in a future js/linkui.js) still surfaces as itself rather
// than being silently masked.
//
// The stub counts its own calls via globalThis.__renderSyncStatusCalls so the
// adoption-pending test below can observe whether runSync's guard actually
// stopped it from reaching the point of calling it.
const RENDER_SYNC_STATUS_STUB = 'export function renderSyncStatus(){ globalThis.__renderSyncStatusCalls = (globalThis.__renderSyncStatusCalls || 0) + 1; }';
const HOOK_SOURCE = `
  const STUB_URL = 'data:text/javascript,${encodeURIComponent(RENDER_SYNC_STATUS_STUB)}';
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/linkui.js')) {
      try {
        return await nextResolve(specifier, context);
      } catch (err) {
        if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
          return { url: STUB_URL, shortCircuit: true };
        }
        throw err;
      }
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`, import.meta.url);

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
      add(c) { self._classes.add(c); },
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

// --- runSync must not run while adoption is pending (mutation M3) ----------
//
// sync.js's syncOnce has its OWN internal isAdoptionPending() check and
// refuses to touch the network either way — so this mutation can't be caught
// by asserting "no fetch call happened". The only externally observable
// effect of app.js's own guard is that a correctly-guarded runSync returns
// BEFORE its try/finally, so renderSyncStatus is never called; remove the
// guard and isLinked() alone lets it fall through into syncOnce (which
// resolves immediately, harmlessly, with status 'adoption-required') and
// then into the finally block, which DOES call renderSyncStatus. A `fetch`
// spy that throws is a redundant belt-and-braces check that no real network
// call ever escapes, in case that reasoning about sync.js is ever wrong.
test('runSync does not proceed into its try/finally while adoption is pending', async () => {
  installFakeLocalStorage();
  await import('../js/app.js'); // cached after the first test; online listener already registered
  globalThis.__renderSyncStatusCalls = 0;

  // linkWithCode's bootstrap path accepts any base64url string of exactly
  // TOKEN_BYTES bytes and always sets adoptionPending: true (spec 5.7) — this
  // device has not yet been offered Merge / Replace / Cancel.
  const token = bytesToBase64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  await linkWithCode(token);

  const onlineListeners = globalThis.window._listeners.online;
  assert.ok(onlineListeners && onlineListeners.length > 0, 'expected an online listener to be registered');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('unexpected network call while adoption is pending'); };
  try {
    for (const fn of onlineListeners) await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(globalThis.__renderSyncStatusCalls, 0,
    'runSync must return before its try/finally while adoption is pending, so renderSyncStatus must never be called');
});
