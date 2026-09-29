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
// The persistent live region (#toast-live in index.html). Every existing test
// shares this one; the Sweep U tests below make their own.
const LIVE = new FakeElement('p');
const show = (h, text, opts = {}) => showToast(h, text, { live: LIVE, ...opts });
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
  show(h, 'Deleted "Dentist"', { undo: () => {} });
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
  show(h2, 'Saved');
  assert.ok(toastIn(h2));
  assert.equal(undoIn(h2), null, 'no undo, so no Undo button');
});

test('expiry after ms empties the host and calls onExpire exactly once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = host();
    const c = counters();
    show(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire, ms: 5000 });
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
    show(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire, ms: 5000 });
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
    show(h, 'first', { undo: first.undo, onExpire: first.onExpire });
    show(h, 'second', { undo: second.undo, onExpire: second.onExpire });
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
    const handle = show(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire });
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
    const handle = show(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire });
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
    const old = show(h, 'first', { onExpire: first.onExpire });
    show(h, 'second', { onExpire: second.onExpire });
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
    show(h, 'x', { onExpire: c.onExpire, ms: 1000 });
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
    show(h, 'Saved', { undo: () => { show(h, 'Restored'); } });
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
    const handle = show(h, 'x', { onExpire: () => { runs += 1; handle.dismiss(); } });
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
    show(h, 'A', { onExpire: () => { throw new Error('boom'); } });
    const c = counters();
    assert.throws(() => show(h, 'B', { undo: c.undo, onExpire: c.onExpire }), /boom/);
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
    show(h, 'A', { onExpire: () => { show(h, 'C', { ms: 1000, onExpire: cC.onExpire }); } });
    const cB = counters();
    show(h, 'B', { undo: cB.undo, onExpire: cB.onExpire });
    assert.match(textOf(h), /B/);
    assert.equal(cC.calls.expire, 1, 'C is settled at once rather than orphaned with a live timer');
    t.mock.timers.tick(1000);
    assert.ok(undoIn(h), 'B keeps its Undo for its whole lifetime');
    assert.match(textOf(h), /B/);
    show(h, 'D');
    assert.equal(cB.calls.expire, 1, 'a later toast settles B');
  } finally {
    t.mock.timers.reset();
  }
});

// =========================================================================
// Sweep U13 — what is announced, and pausing
// =========================================================================

// The live region is a persistent element of its own, OUTSIDE the toast, and
// it carries only the message. With the toast's host as the live region, the
// Undo button was inside it and was read out as part of every notice.
test('the live region gets the message only; the Undo button stays out of it', () => {
  const h = host();
  const live = new FakeElement('p');
  showToast(h, 'Deleted "Dentist"', { live, undo: () => {} });
  assert.equal(live.textContent, 'Deleted "Dentist"');
  assert.equal(live.children.length, 0, 'nothing but text in the live region');
  assert.ok(undoIn(h), 'the Undo button is in the visible toast');
  assert.equal(h.getAttribute('role'), null, 'toast.js makes no live region of the host');
  assert.equal(h.getAttribute('aria-live'), null);
});

test('settling clears the live region; a replaced toast does not clear its successor\'s text', () => {
  const h = host();
  const live = new FakeElement('p');
  const first = showToast(h, 'first', { live });
  showToast(h, 'second', { live });
  assert.equal(live.textContent, 'second');
  first.dismiss(); // stale handle
  assert.equal(live.textContent, 'second');
  showToast(h, 'third', { live }).dismiss();
  assert.equal(live.textContent, '', 'a settled toast leaves nothing to be found by browsing');
});

test('showToast refuses to run without a live region, and touches nothing', () => {
  const h = host();
  const existing = h.appendChild(new FakeElement('p'));
  assert.throws(() => showToast(h, 'x'), /showToast: live is required/);
  assert.deepEqual(h.children, [existing]);
});

for (const [name, enter, leave] of [
  ['focus is inside it', 'focusin', 'focusout'],
]) {
  test(`the toast does not expire while ${name}, and resumes with the time it had left`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    try {
      const h = host();
      const c = counters();
      show(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire, ms: 5000 });
      t.mock.timers.tick(3000);
      toastIn(h).fire(enter);
      t.mock.timers.tick(60000);
      assert.equal(c.calls.expire, 0, `must not expire while ${name}`);
      assert.ok(toastIn(h));
      toastIn(h).fire(leave);
      t.mock.timers.tick(1999);
      assert.equal(c.calls.expire, 0, 'the 2000 ms it had left, not less');
      t.mock.timers.tick(1);
      assert.equal(c.calls.expire, 1, 'and not more');
      assert.equal(h.children.length, 0);
    } finally {
      t.mock.timers.reset();
    }
  });
}

// Sweep F, UI O12: no hover pause. A toast that appears under a mouse pointer
// already resting there gets a pointerenter and, the pointer never moving, no
// pointerleave: it would never expire, and its delete would never commit.
test('sF: the pointer resting over the toast does not stop it expiring', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const h = host();
    const c = counters();
    show(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire, ms: 5000 });
    toastIn(h).fire('pointerenter');
    t.mock.timers.tick(5000);
    assert.equal(c.calls.expire, 1);
    assert.equal(h.children.length, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test('Undo while paused runs undo once, and no timer is left to expire it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const h = host();
    const c = counters();
    show(h, 'Deleted', { undo: c.undo, onExpire: c.onExpire, ms: 5000 });
    const el = toastIn(h);
    el.fire('focusin');
    undoIn(h).fire('click');
    el.fire('focusout'); // focus leaves the removed button
    t.mock.timers.tick(60000);
    assert.equal(c.calls.undo, 1);
    // A resume after settling is refused by resume()'s own guard; were it
    // not, the stray timer would reach settle(), whose at-most-once guard
    // makes it a no-op. Neither is observable, so this pins the outcome only.
    assert.equal(c.calls.expire, 0, 'an Undo is never followed by an expiry');
  } finally {
    t.mock.timers.reset();
  }
});
