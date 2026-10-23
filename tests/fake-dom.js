// The shared fake DOM. Node has no DOM and this repo has no jsdom dependency,
// so this fakes only the slice the app's modules actually touch.
//
// getElementById WALKS THE TREE and returns null for an id that is not
// mounted under document.body, as a browser does. Extracted from
// tests/linkui.test.js's harness for exactly that reason: the fakes it
// replaced lazily created an element for ANY id and never returned null,
// which made "safe when the host is absent" a vacuous assertion — an
// implementation doing `document.getElementById(x).textContent = …` passed
// under them and threw in a real browser. A test that needs an element by id
// mounts it (mountIds, or appendChild under document.body).
//
// The element class is the union of the old harnesses: tests/apply.test.js's
// querySelector/querySelectorAll, classList.toggle, the whitespace check on
// classList.add and focus(); tests/linkui.test.js's id default and the
// innerHTML reset that detaches children.

import assert from 'node:assert/strict';

export class FakeElement {
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
      // The real classList.add THROWS InvalidCharacterError on a token
      // containing whitespace. itemTypeClass can return two tokens
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

  removeAttribute(name) { delete this._attrs[name]; }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
  }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

  get innerHTML() { return ''; }

  set innerHTML(v) {
    if (v === '') {
      this.children.forEach((c) => { c.parentNode = null; });
      this.children = [];
    }
  }

  get childElementCount() { return this.children.length; }

  // Tag selectors only ('button'), which is all any caller passes.
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

  // A tag ('div') or a single class ('.day-grid').
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
  // ask what the app focused, and with which options. Production code never
  // reads lastFocusOptions.
  focus(options) {
    globalThis.document.activeElement = this;
    globalThis.document.lastFocusOptions = options;
  }
}

export function makeFakeDocument() {
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  const listeners = {};
  const walk = (el, pred) => {
    for (const c of el.children) {
      if (pred(c)) return c;
      const found = walk(c, pred);
      if (found) return found;
    }
    return null;
  };
  return {
    documentElement,
    body,
    activeElement: null,
    visibilityState: 'visible',
    // Real semantics: an element that is not in the document is not found.
    getElementById(id) { return walk(body, (el) => el.id === id); },
    createElement: (tag) => new FakeElement(tag),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    // Escape hatch: lets a test dispatch to the app's own document listeners.
    _listeners: listeners,
  };
}

export function makeFakeWindow() {
  const listeners = {};
  return {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    // Escape hatch: there is no other way to dispatch a synthetic 'storage'
    // or 'online' event from Node.
    _listeners: listeners,
  };
}

// Mounts one element per id directly under document.body. Flat, not nested:
// these fakes model lookup by id, not the page's layout.
export function mountIds(doc, ids, tag = 'div') {
  for (const id of ids) {
    const el = doc.createElement(tag);
    el.id = id;
    doc.body.appendChild(el);
  }
}

// Every id index.html declares, in document order.
export function indexHtmlIds(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

// --- tree helpers shared by the test files ---------------------------------
// They read only children, tagName, textContent and _listeners, so they work
// on this file's FakeElement and on the local fakes some test files keep.

// Recursively concatenates textContent across a subtree — the only way to
// inspect what a render put on screen, since a row's title usually lives on a
// nested element, not on the row itself.
export function allText(el) {
  let out = el.textContent || '';
  for (const c of el.children) out += ` ${allText(c)}`;
  return out;
}

// Every descendant (not el itself) whose tagName is `tag`, in document order.
export function findAll(el, tag) {
  const out = [];
  const walk = (node) => { for (const c of node.children) { if (c.tagName === tag) out.push(c); walk(c); } };
  walk(el);
  return out;
}

// Calls el's `type` listeners with { target: el }. No bubbling, no default
// action (apply.test.js's click() adds form submission on top).
export function fire(el, type) {
  (el._listeners[type] || []).forEach((fn) => fn({ target: el }));
}
