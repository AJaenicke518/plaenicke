import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTodoView } from '../js/todoview.js';

// A fixed "today" so relative labels (Today/Tomorrow) are deterministic.
const TODAY = '2026-08-30';
import { renderIdeasView } from '../js/ideasview.js';

// --- minimal fake DOM ------------------------------------------------------
// Honest semantics throughout; classList.add refuses a token containing a
// space, because the real one throws InvalidCharacterError on it and
// itemTypeClass can now return two tokens.

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._classes = new Set();
    this._listeners = {};
    this._attrs = {};
    this.style = { setProperty(name, val) { this[name] = val; } };
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.textContent = '';
  }

  get className() { return [...this._classes].join(' '); }

  set className(v) { this._classes = new Set(String(v).split(' ').filter(Boolean)); }

  get classList() {
    const self = this;
    return {
      add(...cs) {
        for (const c of cs) {
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

  fire(type) { (this._listeners[type] || []).forEach((fn) => fn({ target: this })); }
}

globalThis.document = { createElement: (tag) => new FakeElement(tag) };

function findAll(el, tag) {
  const out = [];
  const walk = (node) => { for (const c of node.children) { if (c.tagName === tag) out.push(c); walk(c); } };
  walk(el);
  return out;
}

function allText(el) {
  let out = el.textContent || '';
  for (const c of el.children) out += ` ${allText(c)}`;
  return out;
}

const host = () => new FakeElement('ul');
const rows = (el) => el.children.filter((c) => c.tagName === 'LI' && !c._classes.has('empty'));

const todo = (id, o = {}) => ({
  id, title: `t-${id}`, date: '2026-08-20', time: null, endTime: null, type: 'task',
  createdAt: '2026-08-19', updatedAt: '2026-08-19T00:00:00.000Z', done: false, notes: null,
  project: null, subject: null, category: null, ...o,
});
const ideaRec = (id, o = {}) => todo(id, { type: 'idea', done: false, ...o });

// =========================================================================
// The To-do page (V6 spec § 5)
// =========================================================================

test('the To-do view renders one row per item, in the order it was given', () => {
  const el = host();
  renderTodoView(el, [todo('a'), todo('b'), todo('c')], { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone() {} });
  assert.deepEqual(rows(el).length, 3);
  // Ordering is the CALLER's (app.js sorts with the repo's single comparator);
  // the view must not reorder behind its back.
  assert.match(allText(el), /t-a[\s\S]*t-b[\s\S]*t-c/);
});

test('each To-do row shows the date and the title', () => {
  const el = host();
  renderTodoView(el, [todo('a', { date: '2026-09-01', title: 'Renew the passport' })],
    { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone() {} });
  const text = allText(el);
  assert.match(text, /Tue, Sep 1 — Renew the passport/, 'a to-do without its date is not actionable');
  assert.match(text, /Renew the passport/);
});

test('each To-do row carries a real unchecked checkbox', () => {
  const el = host();
  renderTodoView(el, [todo('a')], { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone() {} });
  const boxes = findAll(el, 'INPUT').filter((i) => i.type === 'checkbox');
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].checked, false, 'the page only lists items that are NOT done');
  assert.match(boxes[0].getAttribute('aria-label') || '', /t-a/,
    'a bare checkbox with no label is unusable with a screen reader');
});

test('ticking the checkbox calls onToggleDone with the id and true', () => {
  const el = host();
  const calls = [];
  renderTodoView(el, [todo('a'), todo('b')], {
    todayISO: TODAY,
    onOpen() {}, onDelete() {},
    onToggleDone: (id, done) => calls.push([id, done]),
  });
  const box = findAll(el, 'INPUT').filter((i) => i.type === 'checkbox')[1];
  box.checked = true;
  box.fire('change');
  assert.deepEqual(calls, [['b', true]], 'the id must be the row that was ticked, not the first row');
});

// The handler must report what the CONTROL now holds, not a hard-coded true —
// otherwise unticking (reachable the instant the page ever shows a done item)
// would silently re-complete it.
test('the checkbox reports the control state, not a hard-coded true', () => {
  const el = host();
  const calls = [];
  renderTodoView(el, [todo('a', { done: true })], { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone: (id, d) => calls.push([id, d]) });
  const box = findAll(el, 'INPUT').filter((i) => i.type === 'checkbox')[0];
  assert.equal(box.checked, true, 'a done item, were it ever shown, must render ticked');
  box.checked = false;
  box.fire('change');
  assert.deepEqual(calls, [['a', false]]);
});

test('Delete on a To-do row calls onDelete with that id', () => {
  const el = host();
  const deleted = [];
  renderTodoView(el, [todo('a'), todo('b')], { todayISO: TODAY, onOpen() {}, onDelete: (id) => deleted.push(id), onToggleDone() {} });
  findAll(el, 'BUTTON').filter((b) => b._classes.has('delete'))[1].fire('click');
  assert.deepEqual(deleted, ['b']);
});

test('the To-do view says so when there is nothing to do', () => {
  const el = host();
  renderTodoView(el, [], { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone() {} });
  assert.equal(rows(el).length, 0);
  assert.match(allText(el), /\S/, 'an empty page must say something rather than look broken');
});

test('a re-render replaces the previous rows rather than appending to them', () => {
  const el = host();
  renderTodoView(el, [todo('a')], { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone() {} });
  renderTodoView(el, [todo('b')], { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone() {} });
  assert.equal(rows(el).length, 1);
  assert.match(allText(el), /t-b/);
  assert.doesNotMatch(allText(el), /t-a/);
});

test('a To-do row carries its type class so it colours like the same item elsewhere', () => {
  const el = host();
  renderTodoView(el, [todo('a', { type: 'due' })], { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone() {} });
  assert.ok(rows(el)[0]._classes.has('type-due'));
});

// =========================================================================
// The Ideas page (V6 spec § 6)
// =========================================================================

test('the Ideas view renders one row per idea, in the order it was given', () => {
  const el = host();
  renderIdeasView(el, [ideaRec('a'), ideaRec('b')], { onOpen() {}, onDelete() {} });
  assert.equal(rows(el).length, 2);
  assert.match(allText(el), /t-a[\s\S]*t-b/);
});

// An idea's `date` is its CAPTURE date, not when anything happens. Spec § 3.1:
// it is never displayed. Showing it would present a made-up schedule.
test("an idea's capture date is never displayed", () => {
  const el = host();
  renderIdeasView(el, [ideaRec('a', { date: '2026-08-20', title: 'Rework the shelves' })], { onOpen() {}, onDelete() {} });
  assert.match(allText(el), /Rework the shelves/);
  assert.doesNotMatch(allText(el), /2026-08-20/,
    'the date on an idea means "captured on", not "happens on" — showing it invents a schedule');
});

test('the body text is shown when there is one, and no empty element when there is not', () => {
  const withNotes = host();
  const full = 'Rework the shelves. They are too deep for the mugs and half the cupboard is wasted.';
  renderIdeasView(withNotes, [ideaRec('a', { title: 'Rework the shelves.', notes: full })], { onOpen() {}, onDelete() {} });
  assert.match(allText(withNotes), /too deep for the mugs/, 'the full text is the record — it must be readable');

  const withoutNotes = host();
  renderIdeasView(withoutNotes, [ideaRec('b', { title: 'Call the dentist', notes: null })], { onOpen() {}, onDelete() {} });
  const bodies = findAll(withoutNotes, 'P');
  assert.deepEqual(bodies.filter((p) => p._classes.has('idea-notes')), [],
    'a null notes must render nothing at all, not an empty paragraph');
});

test('Delete on an idea row calls onDelete with that id', () => {
  const el = host();
  const deleted = [];
  renderIdeasView(el, [ideaRec('a'), ideaRec('b')], { onOpen() {}, onDelete: (id) => deleted.push(id) });
  findAll(el, 'BUTTON').filter((b) => b._classes.has('delete'))[1].fire('click');
  assert.deepEqual(deleted, ['b']);
});

test('the Ideas view says so when there is nothing captured yet', () => {
  const el = host();
  renderIdeasView(el, [], { onOpen() {}, onDelete() {} });
  assert.equal(rows(el).length, 0);
  assert.match(allText(el), /\S/);
});

test('an Ideas re-render replaces the previous rows', () => {
  const el = host();
  renderIdeasView(el, [ideaRec('a')], { onOpen() {}, onDelete() {} });
  renderIdeasView(el, [ideaRec('b')], { onOpen() {}, onDelete() {} });
  assert.equal(rows(el).length, 1);
  assert.doesNotMatch(allText(el), /t-a/);
});

// No silent fallback to raw ISO dates: a caller that forgets todayISO would
// otherwise render every row as "2026-09-01 — …" with nothing failing.
test('renderTodoView refuses to render without todayISO', () => {
  assert.throws(() => renderTodoView(host(), [todo('a')], { onOpen() {}, onDelete() {}, onToggleDone() {} }), /todayISO/);
});

// =========================================================================
// Opening an item (edit-items plan, Task 4a)
// =========================================================================
//
// The title becomes a real <button class="item-open">. The fake DOM does not
// bubble, so "tapping Delete does not also open the sheet" cannot be tested by
// clicking. What CAN be tested is the tree: no element that carries a click
// listener may contain another control, so there is nothing to bubble into.

// Every element under `root` that has a click (or change) listener, paired
// with the controls nested INSIDE it.
function wrappedControls(root) {
  const bad = [];
  const controlsUnder = (node) => findAll(node, 'BUTTON').concat(findAll(node, 'INPUT'));
  const walk = (node) => {
    for (const c of node.children) {
      const listens = (c._listeners.click || []).length > 0 || (c._listeners.change || []).length > 0;
      if (listens && controlsUnder(c).length > 0) bad.push(c);
      walk(c);
    }
  };
  walk(root);
  return bad;
}

const openButtons = (el) => findAll(el, 'BUTTON').filter((b) => b._classes.has('item-open'));

test('renderTodoView refuses to render without onOpen', () => {
  assert.throws(() => renderTodoView(host(), [todo('a')], { todayISO: TODAY, onDelete() {}, onToggleDone() {} }), /onOpen/);
});

test('renderIdeasView refuses to render without onOpen', () => {
  assert.throws(() => renderIdeasView(host(), [ideaRec('a')], { onDelete() {} }), /onOpen/);
});

test('the To-do title is a button that opens that item', () => {
  const el = host();
  const opened = [];
  const b = todo('b', { title: 'Renew the passport', date: '2026-09-01' });
  renderTodoView(el, [todo('a'), b], { todayISO: TODAY, onOpen: (it) => opened.push(it), onDelete() {}, onToggleDone() {} });
  const buttons = openButtons(el);
  assert.equal(buttons.length, 2, 'one open control per row');
  assert.equal(buttons[1].type, 'button', 'type="button", so it can never submit anything');
  assert.match(buttons[1].textContent, /Tue, Sep 1 — Renew the passport/, 'the date and title ARE the control');
  buttons[1].fire('click');
  assert.deepEqual(opened, [b], 'the row that was tapped, and the whole record');
});

test('the idea title is a button that opens that idea', () => {
  const el = host();
  const opened = [];
  const b = ideaRec('b', { title: 'Rework the shelves' });
  renderIdeasView(el, [ideaRec('a'), b], { onOpen: (it) => opened.push(it), onDelete() {} });
  const buttons = openButtons(el);
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].type, 'button');
  assert.equal(buttons[1].textContent, 'Rework the shelves');
  buttons[1].fire('click');
  assert.deepEqual(opened, [b]);
});

test('the checkbox and Delete are siblings of the open control, never inside a clickable element', () => {
  const el = host();
  renderTodoView(el, [todo('a')], { todayISO: TODAY, onOpen() {}, onDelete() {}, onToggleDone() {} });
  assert.deepEqual(wrappedControls(el), []);
  const ideas = host();
  renderIdeasView(ideas, [ideaRec('a', { notes: 'a longer body' })], { onOpen() {}, onDelete() {} });
  assert.deepEqual(wrappedControls(ideas), []);
});
