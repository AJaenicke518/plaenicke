import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPreview, TYPES } from '../js/preview.js';
import { buildRequestBody } from '../worker/src/prompt.js';

// --- minimal fake DOM ------------------------------------------------------
// Honest semantics, nothing lazily created. preview.js needs createElement,
// append/appendChild, addEventListener and the handful of properties it sets.

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._classes = new Set();
    this._listeners = {};
    this.hidden = false;
    this.selected = false;
    this.readOnly = false;
    this.type = '';
    this.value = '';
    this.textContent = '';
  }

  get className() { return [...this._classes].join(' '); }

  set className(v) { this._classes = new Set(String(v).split(' ').filter(Boolean)); }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  get innerHTML() { return ''; }

  set innerHTML(v) { if (v === '') { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } }

  click() { (this._listeners.click || []).forEach((fn) => fn({ target: this })); }

  fire(type) { (this._listeners[type] || []).forEach((fn) => fn({ target: this })); }
}

globalThis.document = { createElement: (tag) => new FakeElement(tag) };

function findAll(el, tag) {
  const out = [];
  const walk = (node) => { for (const c of node.children) { if (c.tagName === tag) out.push(c); walk(c); } };
  walk(el);
  return out;
}

const findButton = (el, text) => findAll(el, 'BUTTON').find((b) => b.textContent === text);

const modelItem = (o = {}) => ({
  title: 'Something', date: '2026-08-20', time: null, endTime: null, type: 'event',
  project: null, subject: null, category: null, notes: null, ...o,
});

// =========================================================================
// V6 § 7.5 — the SECOND hard-coded type list
// =========================================================================
//
// js/preview.js keeps its own TYPES list, and it lives in a different deploy
// unit from the Worker's `type` enum: the client ships by merging to main, the
// Worker ships separately through wrangler. They can diverge silently.
//
// The consequence is not cosmetic. A returned type the list does not know
// renders a <select> with NO option selected — a browser then displays the
// first option, "due" — while draft[i].type still holds the real value. The
// user sees a wrong type, and the first change event on that control writes
// the wrong one into the record for good.

test('the preview offers every type the Worker can return', () => {
  const modelTypes = buildRequestBody('x', '2026-08-20')
    .output_config.format.schema.properties.items.items.properties.type.enum;
  const missing = modelTypes.filter((t) => !TYPES.includes(t));
  assert.deepEqual(missing, [],
    'a type the model can return but the preview cannot render is silently rewritten on first edit');
});

// The other direction is NOT set equality, and this states why so the next
// person does not "fix" it into one. 'general' is client-only: manual add
// hard-codes it (js/app.js) and it is every pre-V6 record's type, but the
// model is never asked to produce it. Pinning the difference exactly means a
// THIRD divergence still fails this test.
test('the only type the preview offers that the Worker cannot return is general', () => {
  const modelTypes = new Set(buildRequestBody('x', '2026-08-20')
    .output_config.format.schema.properties.items.items.properties.type.enum);
  assert.deepEqual(TYPES.filter((t) => !modelTypes.has(t)), ['general']);
});

test('TYPES has no duplicates and no blanks', () => {
  assert.equal(new Set(TYPES).size, TYPES.length);
  for (const t of TYPES) assert.match(t, /^[a-z]+$/);
});

// The end-to-end shape of the § 7.5 defect, driven through the real render.
test('a task and an idea each render with their OWN option selected', () => {
  for (const type of ['task', 'idea']) {
    const container = new FakeElement('section');
    renderPreview(container, [modelItem({ type })], { onConfirm: () => true, onCancel() {} });
    const select = findAll(container, 'SELECT')[0];
    const selected = select.children.filter((o) => o.selected);
    assert.deepEqual(selected.map((o) => o.value), [type],
      `a returned ${type} must show as ${type}, not as whatever option happens to be first`);
  }
});

// draft = items.map(it => ({...it})) — a spread, so notes rides through
// untouched even though no control edits it. If that ever became a
// field-by-field rebuild, an idea confirmed through the preview would lose its
// body text, which is exactly the makeItem defect one layer up.
test('confirming carries notes through untouched', () => {
  const container = new FakeElement('section');
  const full = 'Rework the shelves. They are too deep for the mugs.';
  let confirmed = null;
  renderPreview(container, [modelItem({ type: 'idea', title: 'Rework the shelves.', notes: full })], {
    onConfirm: (d) => { confirmed = d; return true; },
    onCancel() {},
  });
  findButton(container, 'Add all').click();
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].notes, full);
  assert.equal(confirmed[0].type, 'idea');
});

// Changing the type in the preview is the documented recovery from a
// misclassification (spec § 8.3), so it has to actually work.
test('changing the type control rewrites the draft', () => {
  const container = new FakeElement('section');
  let confirmed = null;
  renderPreview(container, [modelItem({ type: 'idea' })], {
    onConfirm: (d) => { confirmed = d; return true; },
    onCancel() {},
  });
  const select = findAll(container, 'SELECT')[0];
  select.value = 'task';
  select.fire('change');
  findButton(container, 'Add all').click();
  assert.equal(confirmed[0].type, 'task');
});
