import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { loadFeeds, saveFeeds, saveItems, loadSyncState } from '../js/storage.js';
import { initSettings } from '../js/settings.js';
import { linkWithCode } from '../js/auth.js';
import { bytesToBase64url, generateEncKey, encryptBlob } from '../js/crypto.js';
import { SCHEMA_VERSION } from '../js/merge.js';

// --- minimal fake DOM ------------------------------------------------------
//
// settings.js has no prior test coverage: it's DOM glue, Node 22 has no DOM,
// and this repo has no jsdom dependency (no new dependencies, per this
// task's constraints). This fakes only the slice of Element/Document/Window
// settings.js actually touches — createElement, classList, style.setProperty,
// dataset, addEventListener/removeEventListener, append/appendChild,
// `innerHTML = ''` (clear), querySelectorAll('button'), and
// window.matchMedia — enough to open the panel and drive its real click
// handlers, not to render pixels.

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

  click() {
    (this._listeners.click || []).forEach((fn) => fn({ target: this }));
  }
}

function makeFakeDocument() {
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  const listeners = {};
  return {
    documentElement,
    body,
    createElement: (tag) => new FakeElement(tag),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
  };
}

function makeFakeWindow() {
  return { matchMedia: () => ({ matches: false, addEventListener() {} }) };
}

// Recursively finds the first BUTTON descendant whose textContent matches.
function findButtonByText(el, text) {
  for (const c of el.children) {
    if (c.tagName === 'BUTTON' && c.textContent === text) return c;
    const found = findButtonByText(c, text);
    if (found) return found;
  }
  return null;
}

function openPanel(feeds) {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  saveFeeds(feeds);

  const button = document.createElement('button');
  const host = document.createElement('div');
  // Every notification this panel emits, in order, tagged by kind: 'view' for
  // onFeedsChanged (this device's own re-render) and 'synced' for
  // onSyncedDataChanged (something the account must be told about).
  const notified = [];
  initSettings({
    button,
    host,
    onFeedsChanged: () => notified.push('view'),
    onSyncedDataChanged: () => notified.push('synced'),
  });
  button.click(); // host.childElementCount === 0 -> open()
  return { host, notified };
}

// --- the second-writer fix --------------------------------------------------

test('settings: toggling hidden on one feed does not discard a feed that arrived in storage after the panel opened', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host } = openPanel([feedA]); // captures the panel's `feeds` binding as [feedA] only

  // A second, already-linked device's feed lands in storage while THIS
  // device's panel is sitting open. `initSettings` mounts inside this same
  // panel (Task 8), so a newly linked device's first sync races exactly
  // this window. It's a same-tab write, so the cross-tab `storage` event
  // (Task 7) never fires here — the panel has no other way to learn about it.
  const feedC = {
    id: 'feedC', url: 'https://example.com/c.ics', name: 'C', color: 'var(--feed-palette-2)', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  saveFeeds([feedA, feedC]);

  const toggleBtn = findButtonByText(host, 'Hide');
  assert.ok(toggleBtn, 'expected to find the Hide button for feedA');
  toggleBtn.click();

  const stored = loadFeeds();
  assert.deepEqual(stored.map((f) => f.id).sort(), ['feedA', 'feedC']);
  const storedA = stored.find((f) => f.id === 'feedA');
  assert.equal(storedA.hidden, true);
});

test('settings: cycling a feed\'s color does not discard a feed that arrived in storage after the panel opened', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host } = openPanel([feedA]);

  const feedC = {
    id: 'feedC', url: 'https://example.com/c.ics', name: 'C', color: 'var(--feed-palette-2)', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  saveFeeds([feedA, feedC]);

  const dotBtn = host.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Change color for A');
  assert.ok(dotBtn, 'expected to find the color-cycle dot for feedA');
  dotBtn.click();

  const stored = loadFeeds();
  assert.deepEqual(stored.map((f) => f.id).sort(), ['feedA', 'feedC']);
});

// --- synced mutations vs per-device view preferences (spec 6.3) ------------
//
// The panel's seven notification sites are NOT interchangeable. Two of them
// mutate plaenicke.feeds/plaenicke.syncTombstones — the data the account
// actually holds — and must reach app.js's scheduleSync, or a subscription
// added or dropped on the laptop sits unpushed until the next page load,
// `visibilitychange` or `online` event. Closing this modal fires none of
// those, so the obvious gesture triggers nothing at all, and a feed URL is
// the one record in this app that cannot be re-entered from anything on
// screen. The other five are per-device: `color` and `hidden` are stripped by
// toWire and never reach the wire (spec 6.3), and the feed cache is not
// synced at all — pushing on those would fire a sync on every colour tap.

test('settings: removing a calendar is a SYNCED change, not just a re-render', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host, notified } = openPanel([feedA]);
  notified.length = 0;

  findButtonByText(host, 'Remove').click();

  assert.deepEqual(loadFeeds(), [], 'fixture check: the feed really was removed');
  assert.ok(notified.includes('synced'),
    'an unsubscribe writes a feed tombstone the account must be told about — nothing else in the app pushes it');
});

test('settings: adding a calendar is a SYNCED change, not just a re-render', async () => {
  const { host, notified } = openPanel([]);
  notified.length = 0;

  const originalFetch = globalThis.fetch;
  // handleAdd's own first syncFeed() goes to the real /feed proxy; this suite
  // makes no network calls, so answer it with a plain server error. syncFeed
  // returns {ok:false} rather than throwing, which is the path the panel
  // already handles.
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'server' }) });
  try {
    const urlInput = host.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'Calendar link');
    assert.ok(urlInput, 'fixture check: the Add form must offer a URL field');
    urlInput.value = 'https://example.com/new.ics';
    findButtonByText(host, 'Add calendar').click();

    // saveFeeds and the notification both run synchronously, before
    // handleAdd's first await — the assertion does not depend on the sync.
    assert.deepEqual(loadFeeds().map((f) => f.url), ['https://example.com/new.ics'], 'fixture check');
    assert.ok(notified.includes('synced'),
      'a new subscription must be pushed — a feed URL is unrecoverable if this device is lost before it syncs');
    await waitFor(() => findButtonByText(host, 'Add calendar') !== null, 'the initial sync to settle');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('settings: colour and hidden are per-device preferences and never schedule a sync', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host, notified } = openPanel([feedA]);
  notified.length = 0;

  host.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Change color for A').click();
  findButtonByText(host, 'Hide').click();
  findButtonByText(host, 'Show').click();

  assert.ok(notified.includes('view'), 'fixture check: the panel must still re-render on a view change');
  assert.ok(!notified.includes('synced'),
    'toWire strips color and hidden, so pushing on them would burn a sync per colour tap and change nothing anywhere else');
});

test('settings: initSettings refuses to mount without a synced-change callback', () => {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  assert.throws(
    () => initSettings({
      button: document.createElement('button'),
      host: document.createElement('div'),
      onFeedsChanged: () => {},
    }),
    /onSyncedDataChanged/,
    'a missing wire here is silent data loss, not a degraded feature — it must fail at mount',
  );
});

// --- the linking UI mounted inside this panel (Task 8) ---------------------
//
// End-to-end through the REAL mount: initSettings -> open() -> initLinkUI ->
// previewRemote -> chooseAdoption -> syncOnce -> applyState. Nothing here is
// stubbed except the network and the state owner.
//
// The bug: onLinked was `notifyChanged`, which refreshes app.js's snapshot but
// not open()'s own `feeds`/`feedCache` bindings, and never re-runs
// renderCalendars(). After adopting an account with calendars the panel still
// read "No calendars linked yet". Display only — reapplyFeedField, handleAdd
// and removeFeed all re-read storage before writing — but wrong on screen.
function allText(el) {
  let out = el.textContent || '';
  for (const c of el.children) out += ` ${allText(c)}`;
  return out;
}

async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error(`timed out waiting for: ${label}`);
}

test('settings: the calendar list refreshes when an adoption lands while the panel is open', async () => {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  saveFeeds([]);
  saveItems([]); // empty device + an account with data -> 'auto', no dialog

  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  const remoteFeed = {
    id: 'fRemote', url: 'https://cal.example/r.ics', name: 'Pulled Calendar',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const blob = await encryptBlob(link.encKey, {
    schemaVersion: SCHEMA_VERSION, items: [], feeds: [remoteFeed], tombstones: [],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ version: 3, blob }) });

  try {
    const button = document.createElement('button');
    const host = document.createElement('div');
    initSettings({
      button,
      host,
      onFeedsChanged: () => {},
      onSyncedDataChanged: () => {},
      // Stands in for app.js's applySyncedState: the feed owner assigns a
      // real colour before saving (merge.js hands a first-seen feed
      // color: null, and deserializeFeeds drops any feed whose color is not
      // a string).
      applyState: (s) => {
        const assigned = s.feeds.map((f) => (typeof f.color === 'string' ? f : { ...f, color: 'var(--feed-palette-1)' }));
        saveFeeds(assigned);
        return { ...s, feeds: assigned };
      },
    });
    button.click();

    await waitFor(() => loadSyncState().adoptionPending === false, 'the adoption to complete');
    assert.deepEqual(loadFeeds().map((f) => f.id), ['fRemote'], 'the pulled calendar must have been written');
    await waitFor(() => allText(host).includes('Pulled Calendar'), 'the panel to show the pulled calendar');
    assert.ok(!allText(host).includes('No calendars linked yet'),
      'the panel must not still claim the device has no calendars after adopting an account that has one');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Note: Add is deliberately NOT exercised here the same way — handleAdd
// awaits a real syncFeed() call against the live Worker (no fetchImpl hook
// is reachable from outside initSettings), and this suite must not make
// network calls. The :330-337 write site gets the identical
// re-read-before-write fix as the two sites above; app.js/Task 7's
// integration tests are where an Add flow with a real fetchImpl belongs.
