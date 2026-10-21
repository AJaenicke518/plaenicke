import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installPress, PRESS_SELECTOR, PRESS_MOVE_PX, PRESS_EVENTS,
} from '../js/press.js';

// press.js is DOM glue over five pointer events. tests/fake-dom.js has no
// closest() and no event dispatch, so this file keeps its own two fakes: an
// element with a parent chain, and a root that records its listeners.

function el(tag, { parent = null, press = false, disabled = false } = {}) {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    parent,
    disabled,
    press,
    classes,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    // Element.closest: this element first, then each ancestor.
    closest(selector) {
      assert.equal(selector, PRESS_SELECTOR);
      for (let n = this; n; n = n.parent) if (n.tagName === 'BUTTON' || n.press) return n;
      return null;
    },
  };
}

function fakeRoot() {
  const listeners = {};
  const options = {};
  return {
    listeners,
    options,
    addEventListener(type, fn, opts) { (listeners[type] ||= []).push(fn); options[type] = opts; },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire(type, ev) { for (const fn of listeners[type] || []) fn({ pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0, ...ev }); },
  };
}

function setup() {
  const root = fakeRoot();
  const uninstall = installPress(root);
  return { root, uninstall };
}

test('press: pointerdown on a button marks it pressed at once — no timer, no wait', () => {
  const { root } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b });
  assert.ok(b.classList.contains('pressed'));
});

test('press: a tap on a button\'s inner text presses the button', () => {
  const { root } = setup();
  const b = el('button');
  const span = el('span', { parent: b });
  root.fire('pointerdown', { target: span });
  assert.ok(b.classList.contains('pressed'));
  assert.ok(!span.classList.contains('pressed'));
});

test('press: a [data-press] row is pressable; plain content is not', () => {
  const { root } = setup();
  const row = el('li', { press: true });
  root.fire('pointerdown', { target: el('span', { parent: row }) });
  assert.ok(row.classList.contains('pressed'));
  const plain = el('p');
  root.fire('pointerdown', { target: plain });
  assert.ok(!plain.classList.contains('pressed'));
  assert.ok(!row.classList.contains('pressed'), 'the next touch-down cleared the row');
});

for (const end of ['pointerup', 'pointercancel']) {
  test(`press: ${end} ends the press`, () => {
    const { root } = setup();
    const b = el('button');
    root.fire('pointerdown', { target: b });
    root.fire(end, { target: b });
    assert.ok(!b.classList.contains('pressed'));
  });
}

// iOS: a touch that turns into a scroll. A small wobble is still a tap.
test(`press: a move of exactly ${PRESS_MOVE_PX}px keeps the press; past it, the press ends`, () => {
  const { root } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b, clientX: 100, clientY: 200 });
  root.fire('pointermove', { target: b, clientX: 106, clientY: 208 }); // 10px
  assert.ok(b.classList.contains('pressed'), '10px is a tap');
  root.fire('pointermove', { target: b, clientX: 100, clientY: 211 }); // 11px from the start
  assert.ok(!b.classList.contains('pressed'), '11px is a scroll');
  root.fire('pointermove', { target: b, clientX: 100, clientY: 200 });
  assert.ok(!b.classList.contains('pressed'), 'coming back does not re-press it');
});

test('press: only the pointer that pressed can end it', () => {
  const { root } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b, pointerId: 7 });
  root.fire('pointermove', { target: b, pointerId: 8, clientX: 50, clientY: 50 });
  root.fire('pointerup', { target: b, pointerId: 8 });
  root.fire('pointercancel', { target: b, pointerId: 8 });
  assert.ok(b.classList.contains('pressed'));
  root.fire('pointerup', { target: b, pointerId: 7 });
  assert.ok(!b.classList.contains('pressed'));
});

test('press: a second finger or a right click presses nothing', () => {
  const { root } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b, isPrimary: false });
  root.fire('pointerdown', { target: b, button: 2 });
  assert.ok(!b.classList.contains('pressed'));
});

test('press: a disabled button never looks pressed', () => {
  const { root } = setup();
  const b = el('button', { disabled: true });
  root.fire('pointerdown', { target: b });
  assert.ok(!b.classList.contains('pressed'));
});

test('press: leaving the pressed element ends the press; leaving its child does not', () => {
  const { root } = setup();
  const b = el('button');
  const span = el('span', { parent: b });
  root.fire('pointerdown', { target: span });
  root.fire('pointerleave', { target: span });
  assert.ok(b.classList.contains('pressed'));
  root.fire('pointerleave', { target: b });
  assert.ok(!b.classList.contains('pressed'));
});

test('press: never two pressed at once', () => {
  const { root } = setup();
  const a = el('button');
  const b = el('button');
  root.fire('pointerdown', { target: a });
  root.fire('pointerdown', { target: b, pointerId: 2 });
  assert.ok(!a.classList.contains('pressed'));
  assert.ok(b.classList.contains('pressed'));
});

test('press: listens in the capture phase and passively, so it can never block a scroll', () => {
  const { root } = setup();
  assert.deepEqual(Object.keys(root.options).sort(), [...PRESS_EVENTS].sort());
  for (const type of PRESS_EVENTS) {
    assert.deepEqual(root.options[type], { capture: true, passive: true }, type);
  }
});

test('press: uninstall removes every listener and clears a press in progress', () => {
  const { root, uninstall } = setup();
  const b = el('button');
  root.fire('pointerdown', { target: b });
  uninstall();
  assert.ok(!b.classList.contains('pressed'));
  for (const type of PRESS_EVENTS) assert.equal(root.listeners[type].length, 0, type);
});
