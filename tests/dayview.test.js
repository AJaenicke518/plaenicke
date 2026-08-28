import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDayView } from '../js/dayview.js';

// --- minimal fake DOM ------------------------------------------------------
//
// Modelled on tests/linkui.test.js's fake (honest semantics, nothing lazily
// created), with ONE addition that is the whole point of this file:
// `scrollTop` is a real accessor that RECORDS THE DOCUMENT STATE AT THE MOMENT
// IT IS ASSIGNED. In a browser, assigning scrollTop to an element that is not
// yet in the document silently does nothing — the V6 spec calls this out as
// the single ordering trap in the day-view reorder, and it is invisible to any
// assertion that only inspects the final tree.

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.id = '';
    this._classes = new Set();
    this._listeners = {};
    this._attrs = {};
    this.style = { setProperty(name, val) { this[name] = val; } };
    this.hidden = false;
    this.textContent = '';
    this._scrollTop = 0;
    // Every assignment, in order, with the tree state it landed in.
    this.scrollWrites = [];
  }

  get scrollTop() { return this._scrollTop; }

  set scrollTop(v) {
    this.scrollWrites.push({
      value: v,
      inDocument: this.parentNode !== null,
      siblingCount: this.parentNode ? this.parentNode.children.length : 0,
    });
    this._scrollTop = v;
  }

  get className() { return [...this._classes].join(' '); }

  set className(v) { this._classes = new Set(String(v).split(' ').filter(Boolean)); }

  get classList() {
    const self = this;
    return {
      add(...cs) {
        for (const c of cs) {
          // Real DOM semantics: classList.add throws on a token containing a
          // space. A fake that silently accepts one lets a multi-class string
          // pass here and blow up in the browser.
          assert.doesNotMatch(String(c), /\s/, `classList.add token must not contain whitespace: "${c}"`);
          self._classes.add(c);
        }
      },
      remove(c) { self._classes.delete(c); },
      contains(c) { return self._classes.has(c); },
    };
  }

  setAttribute(name, val) { this._attrs[name] = val; }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

  get innerHTML() { return ''; }

  set innerHTML(v) { if (v === '') { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } }

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

globalThis.document = { createElement: (tag) => new FakeElement(tag) };

const container = () => new FakeElement('div');
const timed = (id, time) => ({ id, title: `t-${id}`, date: '2026-08-20', time, endTime: null, createdAt: '2026-08-01' });
const untimed = (id) => ({ id, title: `u-${id}`, date: '2026-08-20', time: null, endTime: null, createdAt: '2026-08-01' });
const classesOf = (el) => el.children.map((c) => c.className);

// =========================================================================
// V6 § 4 — the untimed block moves ABOVE the hour grid
// =========================================================================

test('the untimed block renders ABOVE the hour grid, not below it', () => {
  const c = container();
  renderDayView(c, '2026-08-20', [timed('a', '09:00'), untimed('b')], { onDelete() {} });
  assert.deepEqual(classesOf(c), ['other-tasks', 'day-grid'],
    'the "Other tasks" block must come first — that is the whole of V6 change 1');
});

test('with nothing untimed, the hour grid is the only child', () => {
  const c = container();
  renderDayView(c, '2026-08-20', [timed('a', '09:00')], { onDelete() {} });
  assert.deepEqual(classesOf(c), ['day-grid']);
});

test('with nothing timed, the untimed block still renders first and the grid still follows', () => {
  const c = container();
  renderDayView(c, '2026-08-20', [untimed('b')], { onDelete() {} });
  assert.deepEqual(classesOf(c), ['other-tasks', 'day-grid']);
});

// THE ORDERING TRAP (spec § 4). Assigning scrollTop to a detached element is a
// silent no-op in a browser: the day view would open at midnight instead of
// 07:00, every time, with no error anywhere. Moving the "Other tasks" append
// is exactly the edit that invites separating the append from the assignment.
test('grid.scrollTop is assigned only once the grid is in the container, after every append', () => {
  const c = container();
  renderDayView(c, '2026-08-20', [timed('a', '09:00'), untimed('b')], { onDelete() {} });
  const grid = c.querySelector('.day-grid');
  assert.equal(grid.scrollWrites.length, 1, 'exactly one scrollTop assignment per render');
  const [write] = grid.scrollWrites;
  assert.equal(write.inDocument, true,
    'assigning scrollTop before the grid is appended is a silent no-op in a browser');
  assert.equal(write.siblingCount, 2,
    'both children must already be appended — the assignment must be the last thing that happens');
  assert.equal(write.value, 7 * 48, 'autoScroll defaults to 07:00');
});

test('the scrollTop assignment is still last when there is no untimed block', () => {
  const c = container();
  renderDayView(c, '2026-08-20', [timed('a', '09:00')], { onDelete() {} });
  const [write] = c.querySelector('.day-grid').scrollWrites;
  assert.equal(write.inDocument, true);
  assert.equal(write.siblingCount, 1);
});

// The re-render path reads the OLD grid's scrollTop out of the container
// before wiping it. Reordering the appends must not break that read — which it
// silently would if the block were built before the previous tree was cleared.
test('a re-render with autoScroll off restores the previous grid scroll position', () => {
  const c = container();
  renderDayView(c, '2026-08-20', [timed('a', '09:00'), untimed('b')], { onDelete() {} });
  c.querySelector('.day-grid').scrollTop = 321;
  renderDayView(c, '2026-08-20', [timed('a', '09:00'), untimed('b')], { onDelete() {}, autoScroll: false });
  const grid = c.querySelector('.day-grid');
  assert.equal(grid.scrollWrites.length, 1);
  assert.equal(grid.scrollWrites[0].value, 321, 'the prior scroll position must survive a re-render');
});

// V6 § 3.3: a completed to-do stays on the calendar, styled as done — and the
// day view's untimed block is one of the five sites that colour an item.
// itemTypeClass now returns TWO tokens for a done item, so this row must be
// built with className rather than classList.add, which throws
// InvalidCharacterError on a token containing a space in a real browser.
test('a completed untimed to-do keeps its type class and gains the done class', () => {
  const c = container();
  renderDayView(c, '2026-08-20', [{ ...untimed('b'), type: 'task', done: true }], { onDelete() {} });
  const li = c.children.find((x) => x._classes.has('other-tasks')).querySelector('LI');
  assert.ok(li._classes.has('type-task'), 'it must keep its type colour');
  assert.ok(li._classes.has('done'), 'and be marked completed rather than removed');
});

test('Delete on an untimed row still calls onDelete with that item id', () => {
  const c = container();
  const deleted = [];
  renderDayView(c, '2026-08-20', [untimed('b')], { onDelete: (id) => deleted.push(id) });
  const other = c.children.find((x) => x._classes.has('other-tasks'));
  const li = other.querySelector('LI');
  const del = li.children.find((x) => x.tagName === 'BUTTON');
  del.click();
  assert.deepEqual(deleted, ['b']);
});
