import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followVisualViewport, PLACED_PROPS } from '../js/viewport.js';

// js/viewport.js on its own (home-screen spec § 3, § 8 stage 4). The item
// sheet's own placement tests stay in tests/itemsheet.test.js, unchanged:
// they are the proof that moving the function here changed nothing for it.

// Inline style through setProperty/removeProperty only, as a real
// CSSStyleDeclaration is written by property NAME ('max-height').
class FakeStyle {
  setProperty(name, value) { this[name] = String(value); }

  removeProperty(name) { delete this[name]; }
}
const element = () => ({ style: new FakeStyle() });
const inline = (el) => ({ ...el.style });

// An EventTarget-like visualViewport, as tests/itemsheet.test.js has.
function fakeViewport({ height = 800, offsetTop = 0 } = {}) {
  const listeners = {};
  return {
    height,
    offsetTop,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    dispatch(type) { [...(listeners[type] || [])].forEach((fn) => fn({ type })); },
    count() { return Object.values(listeners).reduce((n, l) => n + l.length, 0); },
  };
}

function withViewport(vv, fn) {
  globalThis.visualViewport = vv;
  try { return fn(); } finally { delete globalThis.visualViewport; }
}

test('places the element by its bottom edge on the visible bottom, at maxShare of the visible height', () => {
  withViewport(fakeViewport({ height: 800 }), () => {
    const el = element();
    followVisualViewport(el, { maxShare: 0.5 });
    assert.deepEqual(inline(el), {
      bottom: 'auto', top: '800px', transform: 'translateY(-100%)', 'max-height': '400px',
    });
  });
});

test('a caller\'s transform is used verbatim', () => {
  withViewport(fakeViewport({ height: 600 }), () => {
    const el = element();
    followVisualViewport(el, { maxShare: 0.5, transform: 'translateY(calc(-100% - var(--capture-lift)))' });
    assert.equal(el.style.transform, 'translateY(calc(-100% - var(--capture-lift)))');
  });
});

test('the keyboard: a resize and then a scroll each re-place it inside the visible area', () => {
  const vv = fakeViewport({ height: 800, offsetTop: 0 });
  withViewport(vv, () => {
    const el = element();
    followVisualViewport(el, { maxShare: 0.5 });
    vv.height = 420;
    vv.dispatch('resize');
    assert.equal(el.style.top, '420px');
    assert.equal(el.style['max-height'], '210px');
    vv.offsetTop = 260;
    vv.dispatch('scroll');
    assert.equal(el.style.top, '680px', 'offsetTop + height: the visible bottom in layout-viewport px');
    assert.equal(el.style['max-height'], '210px');
  });
});

test('stop removes both listeners and every inline property it set, and a second stop is harmless', () => {
  assert.deepEqual(PLACED_PROPS, ['bottom', 'top', 'transform', 'max-height']);
  const vv = fakeViewport({ height: 420, offsetTop: 260 });
  withViewport(vv, () => {
    const el = element();
    const stop = followVisualViewport(el, { maxShare: 0.85 });
    assert.equal(vv.count(), 2, 'one resize and one scroll listener while following');
    stop();
    assert.equal(vv.count(), 0);
    assert.deepEqual(inline(el), {});
    stop();
    vv.height = 300;
    vv.dispatch('resize');
    vv.dispatch('scroll');
    assert.deepEqual(inline(el), {}, 'a later keyboard change reaches nothing');
  });
});

test('without visualViewport nothing is set and nothing listens', () => {
  assert.equal(globalThis.visualViewport, undefined);
  const el = element();
  const stop = followVisualViewport(el, { maxShare: 0.5 });
  assert.deepEqual(inline(el), {});
  stop();
  assert.deepEqual(inline(el), {});
});

test('a maxShare that is not a number in (0, 1] is refused before anything listens', () => {
  const vv = fakeViewport();
  withViewport(vv, () => {
    for (const bad of [undefined, 0, -0.5, 1.5, Number.NaN, '0.5']) {
      assert.throws(() => followVisualViewport(element(), { maxShare: bad }), /maxShare/, String(bad));
    }
    assert.throws(() => followVisualViewport(element()), /maxShare/, 'no options at all');
    assert.equal(vv.count(), 0);
  });
});
