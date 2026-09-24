import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showToast } from '../js/toast.js';

// --- minimal fake DOM ------------------------------------------------------
// Modelled on tests/v6views.test.js. Events do not bubble here, which is fine:
// the toast has exactly one control and nothing wraps it.

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._classes = new Set();
    this._listeners = {};
    this._attrs = {};
    this.type = '';
    this.textContent = '';
  }

  get className() { return [...this._classes].join(' '); }

  set className(v) { this._classes = new Set(String(v).split(' ').filter(Boolean)); }

  setAttribute(name, val) { this._attrs[name] = val; }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

  get innerHTML() { return ''; }

  set innerHTML(v) { if (v === '') { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } }

  fire(type) { (this._listeners[type] || []).forEach((fn) => fn({ target: this })); }
}

globalThis.document = { createElement: (tag) => new FakeElement(tag) };

const host = () => new FakeElement('div');
const toastIn = (h) => h.children.find((c) => c._classes.has('toast')) || null;
const undoIn = (h) => {
  const t = toastIn(h);
  return t ? t.children.find((c) => c._classes.has('toast-undo')) || null : null;
};
const textOf = (h) => toastIn(h).children.map((c) => c.textContent).join(' ');

function counters() {
  const calls = { undo: 0, expire: 0 };
  return {
    calls,
    undo: () => { calls.undo += 1; },
    onExpire: () => { calls.expire += 1; },
  };
}

test('renders a status toast with the text, and an Undo button only when undo is given', () => {
  const h = host();
  showToast(h, 'Deleted "Dentist"', { undo: () => {} });
  const t = toastIn(h);
  assert.ok(t, 'a .toast must be rendered into the host');
  assert.equal(t.tagName, 'DIV');
  // The live region is the PERSISTENT #toast-host (index.html), not this
  // element: a live region inserted already filled is often not announced.
  assert.equal(t.getAttribute('role'), null, 'role belongs on the host, not the inserted toast');
  assert.match(textOf(h), /Deleted "Dentist"/);
  const btn = undoIn(h);
  assert.ok(btn, 'undo given, so there must be an Undo button');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.type, 'button');
  assert.equal(btn.textContent, 'Undo');

  const h2 = host();
  showToast(h2, 'Saved');
  assert.ok(toastIn(h2));
  assert.equal(undoIn(h2), null, 'no undo, so no Undo button');
});

test('expiry after ms empties the host and calls onExpire exactly once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const c = counters();
    showToast(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire, ms: 5000 });
    t.mock.timers.tick(4999);
    assert.equal(c.calls.expire, 0, 'must not expire early');
    assert.ok(toastIn(h), 'still showing before ms elapses');
    t.mock.timers.tick(1);
    assert.equal(c.calls.expire, 1);
    assert.equal(c.calls.undo, 0);
    assert.equal(h.children.length, 0, 'expiry empties the host');
    t.mock.timers.tick(60000);
    assert.equal(c.calls.expire, 1, 'onExpire runs once, not once per tick');
  } finally {
    t.mock.timers.reset();
  }
});

test('Undo calls undo, empties the host, and onExpire never runs — not even when the timer would have fired', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const c = counters();
    showToast(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire, ms: 5000 });
    undoIn(h).fire('click');
    assert.equal(c.calls.undo, 1);
    assert.equal(c.calls.expire, 0, 'Undo must not also commit the deletion');
    assert.equal(h.children.length, 0, 'Undo empties the host');
    t.mock.timers.tick(10000);
    assert.equal(c.calls.expire, 0, 'the timer must have been cleared by Undo');
  } finally {
    t.mock.timers.reset();
  }
});

test('a second toast on the same host synchronously expires the first, then replaces it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const first = counters();
    const second = counters();
    showToast(h, 'first', { undo: first.undo, onExpire: first.onExpire });
    showToast(h, 'second', { undo: second.undo, onExpire: second.onExpire });
    assert.equal(first.calls.expire, 1, 'the first toast\'s onExpire must run before it is replaced');
    assert.equal(first.calls.undo, 0);
    assert.equal(second.calls.expire, 0, 'the second toast is still pending');
    assert.equal(h.children.length, 1, 'exactly one toast in the host');
    assert.match(textOf(h), /second/);
    t.mock.timers.tick(5000);
    assert.equal(first.calls.expire, 1, 'the first toast\'s own timer must not fire it again');
    assert.equal(second.calls.expire, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('dismiss() expires early, so onExpire runs', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const c = counters();
    const handle = showToast(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire });
    handle.dismiss();
    assert.equal(c.calls.expire, 1);
    assert.equal(c.calls.undo, 0);
    assert.equal(h.children.length, 0, 'dismiss empties the host');
  } finally {
    t.mock.timers.reset();
  }
});

test('dismiss() twice, then the timer, then Undo: onExpire runs once and undo never', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const c = counters();
    const handle = showToast(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire });
    const btn = undoIn(h);
    handle.dismiss();
    handle.dismiss();
    t.mock.timers.tick(10000);
    btn.fire('click'); // a stale reference to the detached button
    assert.equal(c.calls.expire, 1, 'onExpire and undo together run at most once');
    assert.equal(c.calls.undo, 0, 'undo after expiry would resurrect a committed deletion');
  } finally {
    t.mock.timers.reset();
  }
});

test('dismiss() on a replaced toast leaves the newer toast alone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const first = counters();
    const second = counters();
    const old = showToast(h, 'first', { onExpire: first.onExpire });
    showToast(h, 'second', { onExpire: second.onExpire });
    old.dismiss();
    assert.equal(first.calls.expire, 1);
    assert.equal(second.calls.expire, 0, 'a stale handle must not expire the current toast');
    assert.ok(toastIn(h), 'a stale handle must not empty the host out from under the current toast');
    assert.match(textOf(h), /second/);
  } finally {
    t.mock.timers.reset();
  }
});

// --- Task 2 review ----------------------------------------------------------

test('ms is honoured: a 1000 ms toast expires at 1000, not 5000', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const c = counters();
    showToast(h, 'x', { onExpire: c.onExpire, ms: 1000 });
    t.mock.timers.tick(999);
    assert.equal(c.calls.expire, 0);
    t.mock.timers.tick(1);
    assert.equal(c.calls.expire, 1);
  } finally {
    t.mock.timers.reset();
  }
});

// Undo of an edit re-runs the edit, whose own path may show a toast. That new
// toast must survive the settle of the one whose Undo was tapped.
test('a toast shown from inside undo stays visible', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    showToast(h, 'Saved', { undo: () => { showToast(h, 'Restored'); } });
    undoIn(h).fire('click');
    assert.ok(toastIn(h), 'the toast shown by undo must be on screen');
    assert.match(textOf(h), /Restored/);
  } finally {
    t.mock.timers.reset();
  }
});

test('dismiss() called from inside onExpire does not run onExpire again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    let runs = 0;
    const handle = showToast(h, 'x', { onExpire: () => { runs += 1; handle.dismiss(); } });
    handle.dismiss();
    assert.equal(runs, 1);
  } finally {
    t.mock.timers.reset();
  }
});

// I1: a throw in the previous toast's onExpire must not stop the new toast
// from rendering — otherwise a delete requested after it would be hidden with
// no toast, no Undo and no timer. The throw is still surfaced to the caller.
test('a throwing onExpire on the replaced toast still lets the new toast render and work', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    showToast(h, 'A', { onExpire: () => { throw new Error('boom'); } });
    const c = counters();
    assert.throws(() => showToast(h, 'B', { undo: c.undo, onExpire: c.onExpire }), /boom/);
    assert.match(textOf(h), /B/, 'the new toast must be rendered despite the throw');
    t.mock.timers.tick(5000);
    assert.equal(c.calls.expire, 1, 'the new toast timer must be running');
  } finally {
    t.mock.timers.reset();
  }
});

// I2: A is replaced by B, and A's onExpire shows C. B must end up owning the
// host with its full lifetime, and a later toast D must settle B.
test('a toast shown from inside a replaced toast\'s onExpire does not orphan or wipe the newer one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const cC = counters();
    showToast(h, 'A', { onExpire: () => { showToast(h, 'C', { ms: 1000, onExpire: cC.onExpire }); } });
    const cB = counters();
    showToast(h, 'B', { undo: cB.undo, onExpire: cB.onExpire });
    assert.match(textOf(h), /B/);
    assert.equal(cC.calls.expire, 1, 'C is settled at once rather than orphaned with a live timer');
    t.mock.timers.tick(1000);
    assert.ok(undoIn(h), 'B keeps its Undo for its whole lifetime');
    assert.match(textOf(h), /B/);
    showToast(h, 'D');
    assert.equal(cB.calls.expire, 1, 'a later toast settles B');
  } finally {
    t.mock.timers.reset();
  }
});
