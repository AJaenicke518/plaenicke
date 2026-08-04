import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { loadFeeds, saveFeeds } from '../js/storage.js';
import { initSettings } from '../js/settings.js';

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
  initSettings({ button, host, onFeedsChanged: () => {} });
  button.click(); // host.childElementCount === 0 -> open()
  return { host };
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

// Note: Add is deliberately NOT exercised here the same way — handleAdd
// awaits a real syncFeed() call against the live Worker (no fetchImpl hook
// is reachable from outside initSettings), and this suite must not make
// network calls. The :330-337 write site gets the identical
// re-read-before-write fix as the two sites above; app.js/Task 7's
// integration tests are where an Add flow with a real fetchImpl belongs.
