import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openItemSheet } from '../js/itemsheet.js';
import { TYPES } from '../js/preview.js';
import { splitIdeaText } from '../js/ideas.js';

// --- minimal fake DOM ------------------------------------------------------
// Modelled on tests/v6views.test.js. Events DO NOT BUBBLE here, so a test of
// the form "clicking X does not trigger Y" cannot fail through bubbling; the
// sheet is structured so no handler wraps another control. `fire` takes an
// optional event so a backdrop click can be given a target other than the
// backdrop itself (a tap inside the sheet, as a real browser reports it).

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._classes = new Set();
    this._listeners = {};
    this._attrs = {};
    this.hidden = false;
    this.selected = false;
    this.type = '';
    this.value = '';
    this.textContent = '';
    this.href = '';
    this.target = '';
    this.rel = '';
    this.scrollTop = 0;
  }

  // Harness only: records focus the way a browser reports it, so a test can
  // ask which element the sheet focused. Production code never reads this.
  focus() { globalThis.document.activeElement = this; }

  get className() { return [...this._classes].join(' '); }

  set className(v) { this._classes = new Set(String(v).split(' ').filter(Boolean)); }

  setAttribute(name, val) { this._attrs[name] = String(val); }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

  get innerHTML() { return ''; }

  set innerHTML(v) { if (v === '') { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } }

  fire(type, ev = {}) {
    (this._listeners[type] || []).forEach((fn) => fn({ target: this, ...ev }));
    // As a browser does: a click on a submit button submits its form. The
    // sheet must cancel that submission, or a real page would navigate away.
    if (type === 'click' && this.tagName === 'BUTTON' && this.type === 'submit') {
      let f = this.parentNode;
      while (f && f.tagName !== 'FORM') f = f.parentNode;
      assert.ok(f, 'a submit button outside any form submits nothing');
      submitForm(f);
    }
  }
}

// Fires `submit` on a form, as Enter in one of its fields does, and fails the
// test if no handler cancelled it (a real browser would navigate the page).
function submitForm(form) {
  let prevented = false;
  (form._listeners.submit || []).forEach((fn) => fn({ target: form, preventDefault() { prevented = true; } }));
  assert.ok(prevented, 'the form submission was not cancelled; the page would navigate');
}

// document-level listeners are tracked by identity, as the real
// removeEventListener does: removing a different function removes nothing.
const docListeners = {};
globalThis.document = {
  activeElement: null,
  body: { style: { overflow: '' } },
  createElement: (tag) => new FakeElement(tag),
  addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  removeEventListener(type, fn) {
    const list = docListeners[type] || [];
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  },
};
const keydownCount = () => (docListeners.keydown || []).length;
const pressKey = (key) => [...(docListeners.keydown || [])].forEach((fn) => fn({ key }));
// A Tab press; returns whether the sheet cancelled the browser's own move.
function pressTab(shiftKey = false) {
  let prevented = false;
  [...(docListeners.keydown || [])].forEach((fn) => fn({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } }));
  return prevented;
}

function walk(el, fn) { for (const c of el.children) { fn(c); walk(c, fn); } }
function findAll(el, pred) { const out = []; walk(el, (c) => { if (pred(c)) out.push(c); }); return out; }
const byClass = (el, cls) => findAll(el, (c) => c._classes.has(cls));
const one = (el, cls) => {
  const found = byClass(el, cls);
  assert.equal(found.length, 1, `expected exactly one .${cls}, found ${found.length}`);
  return found[0];
};
const byTag = (el, tag) => findAll(el, (c) => c.tagName === tag);
function allText(el) {
  let out = el.textContent || '';
  for (const c of el.children) out += ` ${allText(c)}`;
  return out;
}

const TODAY = '2026-09-23';

const task = (o = {}) => ({
  id: 'a1', title: 'Dentist', date: '2026-09-23', time: '09:00', endTime: '10:00', type: 'task',
  notes: 'bring card', done: false, project: null, subject: null, category: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...o,
});
const LONG = 'Build a tiny garden shed. It should have a green roof and a rain barrel and shelves for the pots and a bench.';
const idea = (o = {}) => task({
  id: 'i1', type: 'idea', title: 'Build a tiny garden shed.', notes: LONG, time: null, endTime: null, date: '2026-09-20', ...o,
});
const external = (o = {}) => ({
  id: 'ext:1', title: 'Board meeting', date: '2026-09-23', time: '09:00', endTime: '10:30', type: 'event',
  external: true, feedId: 'f1', feedColor: '#123456', ...o,
});

// Opens a sheet into a fresh host with recording callbacks.
function open(item, { onSave = () => ({ ok: true }), ...extra } = {}) {
  const host = new FakeElement('div');
  const calls = { save: [], del: 0, close: 0 };
  openItemSheet(host, item, {
    today: () => TODAY,
    onSave: (p) => { calls.save.push(p); return onSave(p); },
    onDelete: () => { calls.del += 1; },
    onClose: () => { calls.close += 1; },
    ...extra,
  });
  return { host, calls };
}

// Every test must leave the document clean, or the listener-count assertions
// in later tests would be measuring an earlier test's leak. Escape closes every
// sheet a test left open FIRST: the page scroll lock is one shared counter
// (js/scrolllock.js), so a sheet left open would hold it into the next test.
test.afterEach(() => {
  pressKey('Escape');
  docListeners.keydown = [];
  document.body.style.overflow = '';
  document.activeElement = null;
});

// =========================================================================
// Own item, not an idea
// =========================================================================

test('the own-item sheet is a modal dialog with Cancel and Save in a top bar, above the form', () => {
  const { host } = open(task());
  assert.equal(host.children.length, 1);
  const backdrop = host.children[0];
  assert.ok(backdrop._classes.has('sheet-backdrop'));
  // Sweep U12: the dialog is the SHEET. On the backdrop, the dialog's box
  // was the whole screen, scrim included.
  assert.equal(backdrop.getAttribute('role'), null, 'the backdrop is not the dialog');
  assert.equal(backdrop.getAttribute('aria-modal'), null);
  const sheet = backdrop.children[0];
  assert.ok(sheet._classes.has('sheet'), '.sheet must be the backdrop\'s child');
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  const form = sheet.children[0];
  assert.equal(form.tagName, 'FORM', 'a real <form>, so Enter in a field saves (sweep U8)');
  const bar = form.children[0];
  assert.ok(bar._classes.has('sheet-bar'), 'the top bar must come FIRST, so it stays above the keyboard');
  const buttons = bar.children.filter((c) => c.tagName === 'BUTTON');
  assert.equal(buttons[0].textContent, 'Cancel', 'Cancel on the left');
  assert.equal(buttons[buttons.length - 1].textContent, 'Save', 'Save on the right');
  for (const b of byTag(host, 'BUTTON')) {
    const want = b._classes.has('sheet-save') ? 'submit' : 'button';
    assert.equal(b.type, want, `${b.textContent}: only Save submits the form`);
  }
});

test('fields are prefilled from the item', () => {
  const { host } = open(task());
  assert.equal(one(host, 'sheet-title').value, 'Dentist');
  assert.equal(one(host, 'sheet-title').type, 'text');
  assert.equal(one(host, 'sheet-date').value, '2026-09-23');
  assert.equal(one(host, 'sheet-date').type, 'date');
  assert.equal(one(host, 'sheet-time').value, '09:00');
  assert.equal(one(host, 'sheet-time').type, 'time');
  assert.equal(one(host, 'sheet-end').value, '10:00');
  assert.equal(one(host, 'sheet-end').type, 'time');
  const notes = one(host, 'sheet-notes');
  assert.equal(notes.tagName, 'TEXTAREA', 'notes are a visible textarea on every sheet');
  assert.equal(notes.value, 'bring card');
  const sel = one(host, 'sheet-type');
  assert.equal(sel.tagName, 'SELECT');
  assert.equal(sel.value, 'task');
  assert.deepEqual(sel.children.map((o) => o.value), TYPES, 'the options are preview.js\'s TYPES, not a fifth copy');
  assert.deepEqual(sel.children.filter((o) => o.selected).map((o) => o.value), ['task']);
});

test('null time, end and notes prefill as empty boxes, not "null"', () => {
  const { host } = open(task({ time: null, endTime: null, notes: null }));
  assert.equal(one(host, 'sheet-time').value, '');
  assert.equal(one(host, 'sheet-end').value, '');
  assert.equal(one(host, 'sheet-notes').value, '');
});

test('quick moves and Delete sit below the form', () => {
  const { host } = open(task());
  assert.deepEqual(byClass(host, 'sheet-move').map((b) => b.textContent), ['Tomorrow', '+1 week']);
  assert.equal(one(host, 'sheet-delete').textContent, 'Delete');
});

test('Save sends only the changed fields, then empties the host and calls onClose', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-title').value = 'Dentist, moved';
  one(host, 'sheet-notes').value = 'bring card and form';
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ title: 'Dentist, moved', notes: 'bring card and form' }],
    'a field not touched must not be written back — it may have changed through a sync meanwhile');
  assert.equal(host.children.length, 0);
  assert.equal(calls.close, 1);
});

test('an unchanged Save closes without calling onSave', () => {
  const { host, calls } = open(task({ time: null, endTime: null, notes: null }));
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, []);
  assert.equal(host.children.length, 0);
  assert.equal(calls.close, 1);
});

test('clearing the start time also clears the end time, and Save sends both as null', () => {
  const { host, calls } = open(task());
  const time = one(host, 'sheet-time');
  time.value = '';
  time.fire('input');
  assert.equal(one(host, 'sheet-end').value, '', 'an end with no start is invalid, so it goes with the start');
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ time: null, endTime: null }]);
});

test('a cleared date reaches onSave as "" so makeItem can refuse it', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-date').value = '';
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ date: '' }]);
});

test('a quick move sends the new date together with any typed changes', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-title').value = 'Dentist (moved)';
  byClass(host, 'sheet-move')[1].fire('click');
  assert.deepEqual(calls.save, [{ title: 'Dentist (moved)', date: '2026-09-30' }],
    '+1 week is from the item\'s date, and the typed title must not be dropped');
  assert.equal(host.children.length, 0);
  assert.equal(calls.close, 1);

  const second = open(task({ date: '2026-09-01' }));
  byClass(second.host, 'sheet-move')[0].fire('click');
  assert.deepEqual(second.calls.save, [{ date: '2026-09-24' }], 'Tomorrow is from today');
});

// Task 3 review I1: the sheet sends the RAW diff. typeChangePatch runs in
// app.js's editItem against the CURRENT record — here it would fill title and
// notes from the record as it was when the sheet opened, and a type change
// would write stale text back over a sync that arrived meanwhile.
test('switching a task to idea sends only the raw diff', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-type').value = 'idea';
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ type: 'idea' }]);
});

test('a failed save keeps the sheet open and shows the error inside it', () => {
  const { host, calls } = open(task(), { onSave: () => ({ ok: false, error: 'End time must be after start time' }) });
  one(host, 'sheet-end').value = '08:00';
  one(host, 'sheet-save').fire('click');
  assert.equal(calls.save.length, 1);
  assert.equal(host.children.length, 1, 'the sheet must stay mounted');
  assert.equal(calls.close, 0);
  const sheet = one(host, 'sheet');
  const err = one(sheet, 'sheet-error');
  assert.equal(err.textContent, 'End time must be after start time');
  assert.equal(keydownCount(), 1, 'the sheet is still open, so Escape must still work');
  assert.equal(one(host, 'sheet-end').value, '08:00', 'the user\'s typed value must survive the failure');
});

test('a failed quick move also keeps the sheet open with the error', () => {
  const { host, calls } = open(task(), { onSave: () => ({ ok: false, error: 'This item no longer exists.' }) });
  byClass(host, 'sheet-move')[0].fire('click');
  assert.equal(calls.close, 0);
  assert.equal(one(host, 'sheet-error').textContent, 'This item no longer exists.');
});

test('Delete calls onDelete, empties the host and calls onClose', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-delete').fire('click');
  assert.equal(calls.del, 1);
  assert.deepEqual(calls.save, []);
  assert.equal(host.children.length, 0);
  assert.equal(calls.close, 1);
});

test('an unknown type throws before anything is mounted or registered', () => {
  const host = new FakeElement('div');
  const existing = host.appendChild(new FakeElement('p'));
  assert.throws(
    () => openItemSheet(host, task({ type: 'bogus' }), { today: () => TODAY, onSave() {}, onDelete() {}, onClose() {} }),
    /Unknown type: bogus/,
  );
  assert.deepEqual(host.children, [existing], 'the host must be untouched');
  assert.equal(keydownCount(), 0, 'no listener may leak from a sheet that never opened');
});

// =========================================================================
// Own idea
// =========================================================================

test('an idea gets one textarea with its full text, a type select, Delete, and no times or quick moves', () => {
  const { host } = open(idea());
  const text = one(host, 'sheet-text');
  assert.equal(text.tagName, 'TEXTAREA');
  assert.equal(text.value, LONG);
  assert.equal(one(host, 'sheet-type').value, 'idea');
  assert.equal(byTag(host, 'INPUT').length, 0, 'no title/date/time inputs on an idea');
  assert.equal(byClass(host, 'sheet-move').length, 0);
  assert.equal(byClass(host, 'sheet-notes').length, 0, 'the idea text IS the notes');
  assert.ok(one(host, 'sheet-delete'));
});

test('an idea whose notes are null shows its title', () => {
  const { host } = open(idea({ title: 'Short thought', notes: null }));
  assert.equal(one(host, 'sheet-text').value, 'Short thought');
});

// The trap: "opened" must be computed the same way as "current". A record
// {title, notes: null} opened as {title, notes: null} and saved as
// {title: text, notes: text} would diff on notes and write an untouched idea.
test('an untouched idea saves nothing, whether or not its notes are set', () => {
  for (const it of [idea(), idea({ title: 'Short thought', notes: null })]) {
    const { host, calls } = open(it);
    one(host, 'sheet-save').fire('click');
    assert.deepEqual(calls.save, [], `untouched idea ${JSON.stringify(it.notes)} must not be written`);
    assert.equal(calls.close, 1);
  }
});

test('editing an idea sends the text as BOTH title and notes', () => {
  // normalizeIdea prefers notes, so a title-only patch would be overridden by
  // the old notes and the edit silently lost.
  for (const it of [idea(), idea({ title: 'Short thought', notes: null })]) {
    const { host, calls } = open(it);
    one(host, 'sheet-text').value = 'A different thought';
    one(host, 'sheet-save').fire('click');
    assert.deepEqual(calls.save, [{ title: 'A different thought', notes: 'A different thought' }]);
  }
});

test('idea -> task with the text untouched sends only the type', () => {
  const { host, calls } = open(idea());
  one(host, 'sheet-type').value = 'task';
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ type: 'task' }]);
});

test('idea -> task with edited text derives from the edited text', () => {
  const { host, calls } = open(idea());
  one(host, 'sheet-text').value = 'Call the plumber';
  one(host, 'sheet-type').value = 'task';
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ type: 'task', title: 'Call the plumber', notes: 'Call the plumber' }]);
});

// =========================================================================
// External item
// =========================================================================

test('an external item is read-only: title, day and time, calendar name, and a Close button', () => {
  const { host, calls } = open(external(), { calendarName: 'Work' });
  assert.equal(byTag(host, 'INPUT').length, 0);
  assert.equal(byTag(host, 'SELECT').length, 0);
  assert.equal(byTag(host, 'TEXTAREA').length, 0);
  const text = allText(host);
  assert.match(text, /Board meeting/);
  assert.match(text, /Today · 9:00–10:30 AM/);
  assert.match(text, /From Work/);
  const buttons = byTag(host, 'BUTTON');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Close']);
  assert.equal(byTag(host, 'A').length, 0, 'no Google link unless a URL is given');
  buttons[0].fire('click');
  assert.equal(host.children.length, 0);
  assert.equal(calls.close, 1);
  assert.deepEqual(calls.save, []);
  assert.equal(calls.del, 0);
});

test('an external item with only a start time shows that time; an untimed one shows only the day', () => {
  let { host } = open(external({ endTime: null, date: '2026-09-24' }), { calendarName: 'Work' });
  assert.match(allText(host), /Tomorrow · 9:00 AM/);
  ({ host } = open(external({ time: null, endTime: null, date: '2026-09-24' }), { calendarName: 'Work' }));
  assert.match(allText(host), /Tomorrow/);
  assert.doesNotMatch(allText(host), /·/);
});

test('the Google link appears only when googleDayUrl is given, and opens safely in a new tab', () => {
  const url = 'https://calendar.google.com/calendar/r/day/2026/9/23';
  const { host } = open(external(), { calendarName: 'Work', googleDayUrl: url });
  const links = byTag(host, 'A');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, url);
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(links[0].textContent, 'Open in Google Calendar');
});

test('an external item never needs a known type — it has no type select', () => {
  const { host } = open(external({ type: 'something-from-ics' }), { calendarName: 'Work' });
  assert.equal(host.children.length, 1);
});

// =========================================================================
// Closing, and the document keydown listener
// =========================================================================

test('Escape closes the sheet; other keys do not', () => {
  const { host, calls } = open(task());
  assert.equal(keydownCount(), 1);
  pressKey('Enter');
  assert.equal(host.children.length, 1);
  assert.equal(calls.close, 0);
  pressKey('Escape');
  assert.equal(host.children.length, 0);
  assert.equal(calls.close, 1);
  assert.deepEqual(calls.save, [], 'Escape is Cancel, not Save');
});

test('a backdrop click closes only when the backdrop itself is the target', () => {
  const { host, calls } = open(task());
  const backdrop = one(host, 'sheet-backdrop');
  const sheet = one(host, 'sheet');
  backdrop.fire('pointerdown', { target: sheet });
  backdrop.fire('pointerup', { target: sheet });
  backdrop.fire('click', { target: sheet });
  assert.equal(host.children.length, 1, 'a tap inside the sheet must not close it');
  backdrop.fire('pointerdown');
  backdrop.fire('pointerup');
  backdrop.fire('click');
  assert.equal(host.children.length, 0);
  assert.equal(calls.close, 1);
});

// Sweep U7: a drag that starts in a field and is released over the scrim
// reports a click whose target is the backdrop. It must not discard the edit.
test('a press that starts inside the sheet and ends on the backdrop does not close it', () => {
  const { host, calls } = open(task());
  const backdrop = one(host, 'sheet-backdrop');
  one(host, 'sheet-title').value = 'typed, then dragged out';
  backdrop.fire('pointerdown', { target: one(host, 'sheet-title') });
  backdrop.fire('pointerup');
  backdrop.fire('click');
  assert.equal(host.children.length, 1, 'the sheet must stay open');
  assert.equal(calls.close, 0);
  assert.equal(one(host, 'sheet-title').value, 'typed, then dragged out');
  // And a fresh press that starts on the backdrop still closes it.
  backdrop.fire('pointerdown');
  backdrop.fire('pointerup');
  backdrop.fire('click');
  assert.equal(calls.close, 1);
});

// Sweep F, UI O1: the other direction. A press that starts on the scrim and is
// released over the sheet ENDS inside it. The browser still sends the click to
// the nearest common ancestor, the backdrop, so a click-target check reads it
// as a tap on the scrim. The end is read from pointerup instead.
test('sF: a press that starts on the backdrop and ends inside the sheet does not close it', () => {
  const { host, calls } = open(task());
  const backdrop = one(host, 'sheet-backdrop');
  backdrop.fire('pointerdown');
  backdrop.fire('pointerup', { target: one(host, 'sheet-title') });
  backdrop.fire('click'); // the common ancestor
  assert.equal(host.children.length, 1, 'the sheet must stay open');
  assert.equal(calls.close, 0);
});


// Every close path, each on a fresh sheet. One path forgetting to remove the
// listener would leave a stale Escape handler that empties whatever the host
// shows next and calls a stale onClose.
const CLOSE_PATHS = {
  'Cancel': (h) => one(h, 'sheet-cancel').fire('click'),
  'backdrop': (h) => {
    const b = one(h, 'sheet-backdrop');
    b.fire('pointerdown'); b.fire('pointerup'); b.fire('click');
  },
  'Enter (submit)': (h) => { one(h, 'sheet-title').value = 'y'; submitForm(byTag(h, 'FORM')[0]); },
  'Escape': () => pressKey('Escape'),
  'Save (changed)': (h) => { one(h, 'sheet-title').value = 'x'; one(h, 'sheet-save').fire('click'); },
  'Save (unchanged)': (h) => one(h, 'sheet-save').fire('click'),
  'quick move': (h) => byClass(h, 'sheet-move')[0].fire('click'),
  'Delete': (h) => one(h, 'sheet-delete').fire('click'),
};
for (const [name, close] of Object.entries(CLOSE_PATHS)) {
  test(`the keydown listener is removed when the sheet closes by ${name}`, () => {
    const { host, calls } = open(task());
    assert.equal(keydownCount(), 1);
    close(host);
    assert.equal(host.children.length, 0);
    assert.equal(calls.close, 1);
    assert.equal(keydownCount(), 0, `${name} left the keydown listener registered`);
  });

  // Sweep U5: the page behind is locked while the sheet is open, and every
  // close path unlocks it.
  test(`page scroll is locked while the sheet is open and restored when it closes by ${name}`, () => {
    document.body.style.overflow = '';
    const { host } = open(task());
    assert.equal(document.body.style.overflow, 'hidden');
    close(host);
    assert.equal(document.body.style.overflow, '', `${name} left the page unscrollable`);
  });
}

test('the keydown listener is removed when an external sheet closes by Close', () => {
  const { host } = open(external(), { calendarName: 'Work' });
  assert.equal(keydownCount(), 1);
  one(host, 'sheet-close').fire('click');
  assert.equal(keydownCount(), 0);
});

test('a closed sheet cannot close twice: onClose runs once', () => {
  const { host, calls } = open(task());
  const cancel = one(host, 'sheet-cancel');
  const save = one(host, 'sheet-save');
  cancel.fire('click');
  cancel.fire('click');
  save.fire('click');
  pressKey('Escape');
  assert.equal(calls.close, 1);
  assert.deepEqual(calls.save, []);
});

test('mounting a second sheet into the same host leaves exactly one keydown listener', () => {
  const host = new FakeElement('div');
  const closes = [];
  const opts = (tag) => ({ today: () => TODAY, onSave: () => ({ ok: true }), onDelete() {}, onClose: () => closes.push(tag) });
  openItemSheet(host, task(), opts('first'));
  openItemSheet(host, task({ id: 'a2', title: 'Second' }), opts('second'));
  assert.equal(keydownCount(), 1, 'the replaced sheet\'s Escape handler must go with it');
  assert.equal(host.children.length, 1);
  pressKey('Escape');
  assert.deepEqual(closes, ['second'], 'Escape closes the sheet on screen, and the replaced one never fires');
  assert.equal(keydownCount(), 0);
});

// =========================================================================
// Task 3 review
// =========================================================================

// O1: "+1 week" is relative to the date in the box, not the date the sheet
// opened with — otherwise a typed date silently vanishes.
test('+1 week counts from a date typed into the sheet', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-date').value = '2026-10-10';
  byClass(host, 'sheet-move')[1].fire('click');
  assert.deepEqual(calls.save, [{ date: '2026-10-17' }]);
});

// O2: a time picker's Clear may fire only `change`.
test('clearing the start via a change event also clears the end', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-time').value = '';
  one(host, 'sheet-time').fire('change');
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ time: null, endTime: null }]);
});

// O3: a throwing onSave must not leave a silent, stuck sheet.
test('an onSave that throws shows the error in the sheet', () => {
  const { host } = open(task(), { onSave: () => { throw new Error('disk on fire'); } });
  one(host, 'sheet-title').value = 'changed';
  assert.throws(() => one(host, 'sheet-save').fire('click'), /disk on fire/);
  assert.match(one(host, 'sheet-error').textContent, /disk on fire/);
});

test('a Save on an already-closed sheet does nothing, even with typed changes', () => {
  const { host, calls } = open(task());
  const save = one(host, 'sheet-save');
  one(host, 'sheet-title').value = 'changed';
  one(host, 'sheet-cancel').fire('click');
  save.fire('click');
  assert.deepEqual(calls.save, []);
});

test('Delete twice deletes once', () => {
  const { host, calls } = open(task());
  const del = one(host, 'sheet-delete');
  del.fire('click');
  del.fire('click');
  assert.equal(calls.del, 1);
});

test('an external item with no calendar name does not say "From null"', () => {
  const { host } = open(external(), { calendarName: null });
  assert.doesNotMatch(allText(host), /From/);
});

// =========================================================================
// Sweep D3: "today" is read when a quick move is tapped, not when the sheet
// was built. A sheet left open across midnight must not move "Tomorrow" to
// today.
// =========================================================================

test('Tomorrow is computed from today at click time, not when the sheet opened', () => {
  let now = '2026-09-23';
  const { host, calls } = open(task({ date: '2026-09-01' }), { today: () => now });
  now = '2026-09-24'; // midnight passes with the sheet open
  byClass(host, 'sheet-move')[0].fire('click');
  assert.deepEqual(calls.save, [{ date: '2026-09-25' }]);
});

test('the sheet refuses to open without a today() function, and touches nothing', () => {
  for (const bad of [undefined, '2026-09-23']) {
    const host = new FakeElement('div');
    const existing = host.appendChild(new FakeElement('p'));
    assert.throws(
      () => openItemSheet(host, task(), { today: bad, onSave() {}, onDelete() {}, onClose() {} }),
      /openItemSheet: today must be a function/,
    );
    assert.deepEqual(host.children, [existing], 'the host must be untouched');
  }
  assert.equal(keydownCount(), 0);
});

// =========================================================================
// Sweep U — from the real-browser review
// =========================================================================

// U5: the page lock survives a sheet replaced by another, and restores what
// the page had before (not a hard-coded '').
test('replacing a sheet keeps the page locked, and the last close restores the prior value', () => {
  document.body.style.overflow = 'clip';
  const host = new FakeElement('div');
  const opts = { today: () => TODAY, onSave: () => ({ ok: true }), onDelete() {}, onClose() {} };
  openItemSheet(host, task(), opts);
  openItemSheet(host, task({ id: 'a2' }), opts);
  assert.equal(document.body.style.overflow, 'hidden');
  one(host, 'sheet-cancel').fire('click');
  assert.equal(document.body.style.overflow, 'clip');
});

// U6: focus moves into the sheet on open.
test('opening an own item focuses its first control', () => {
  const { host } = open(task());
  assert.equal(document.activeElement, one(host, 'sheet-cancel'));
});

test('opening an external item focuses its heading, which is focusable only by script', () => {
  const { host } = open(external(), { calendarName: 'Work' });
  const heading = one(host, 'sheet-heading');
  assert.equal(document.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1');
});

test('Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last', () => {
  const { host } = open(task());
  const cancel = one(host, 'sheet-cancel');
  const del = one(host, 'sheet-delete');
  del.focus();
  assert.equal(pressTab(), true, 'Tab on the last control must be taken over');
  assert.equal(document.activeElement, cancel);
  assert.equal(pressTab(true), true);
  assert.equal(document.activeElement, del);
  one(host, 'sheet-title').focus();
  assert.equal(pressTab(), false, 'a Tab in the middle is left to the browser');
  assert.equal(document.activeElement, one(host, 'sheet-title'));
});

test('Tab from outside the sheet (the external heading) goes to its first control', () => {
  const url = 'https://calendar.google.com/calendar/r/day/2026/9/23';
  const { host } = open(external(), { calendarName: 'Work', googleDayUrl: url });
  assert.equal(pressTab(), true);
  assert.equal(document.activeElement, one(host, 'sheet-close'));
  assert.equal(pressTab(), false, 'Close -> link is the browser\'s own move');
  one(host, 'sheet-google').focus();
  assert.equal(pressTab(), true);
  assert.equal(document.activeElement, one(host, 'sheet-close'));
});

// U8: Enter in a field submits the form, which saves.
test('submitting the form (Enter in a field) saves the changes', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-title').value = 'Entered';
  submitForm(byTag(host, 'FORM')[0]);
  assert.deepEqual(calls.save, [{ title: 'Entered' }]);
  assert.equal(calls.close, 1);
});

// U11: human labels, values unchanged.
test('the type select shows human labels over preview.js\'s values', () => {
  const { host } = open(task());
  const sel = one(host, 'sheet-type');
  assert.deepEqual(sel.children.map((o) => o.value), TYPES, 'values stay exactly preview.js\'s TYPES');
  assert.deepEqual(
    Object.fromEntries(sel.children.map((o) => [o.value, o.textContent])),
    {
      due: 'Deadline', start: 'Start', milestone: 'Milestone', event: 'Event',
      general: 'General', task: 'To-do', idea: 'Idea',
    },
  );
});

// U12: the dialog is the sheet, it is named by a visible heading, and the
// error sits directly under the top bar.
for (const [name, item, heading] of [
  ['own item', task(), 'Edit item'],
  ['idea', idea(), 'Edit idea'],
  ['external item', external(), 'Board meeting'],
]) {
  test(`the ${name} sheet is named by its visible heading`, () => {
    const { host } = open(item, { calendarName: 'Work' });
    const sheet = one(host, 'sheet');
    const h = one(host, 'sheet-heading');
    assert.equal(h.tagName, 'H2');
    assert.equal(h.textContent, heading);
    assert.equal(h.hidden, false);
    const id = h.getAttribute('id');
    assert.ok(id, 'the heading needs an id to label the dialog');
    assert.equal(sheet.getAttribute('aria-labelledby'), id);
    assert.equal(sheet.getAttribute('aria-label'), null, 'one name, not two');
  });
}

test('two sheets get different heading ids', () => {
  const a = open(task());
  const b = open(task({ id: 'a2' }));
  assert.notEqual(one(a.host, 'sheet-heading').getAttribute('id'), one(b.host, 'sheet-heading').getAttribute('id'));
});

test('the error sits directly under the top bar and is an alert (S-10)', () => {
  for (const it of [task(), idea()]) {
    const { host } = open(it);
    const form = byTag(host, 'FORM')[0];
    assert.ok(form.children[0]._classes.has('sheet-bar'));
    assert.ok(form.children[1]._classes.has('sheet-error'), 'the error is the next thing after the bar');
    assert.equal(form.children[1].getAttribute('role'), 'alert');
  }
});

test('a failed save scrolls the sheet back to the error', () => {
  const { host } = open(task(), { onSave: () => ({ ok: false, error: 'nope' }) });
  const sheet = one(host, 'sheet');
  sheet.scrollTop = 400;
  one(host, 'sheet-title').value = 'changed';
  one(host, 'sheet-save').fire('click');
  assert.equal(sheet.scrollTop, 0);
});

test('an onSave that throws also scrolls the sheet back to the error', () => {
  const { host } = open(task(), { onSave: () => { throw new Error('boom'); } });
  const sheet = one(host, 'sheet');
  sheet.scrollTop = 400;
  one(host, 'sheet-title').value = 'changed';
  assert.throws(() => one(host, 'sheet-save').fire('click'), /boom/);
  assert.equal(sheet.scrollTop, 0);
});

// U15: the external sheet's padding lives on a class of its own.
test('the external sheet is marked so its bottom padding applies', () => {
  const { host } = open(external(), { calendarName: 'Work' });
  assert.ok(one(host, 'sheet')._classes.has('sheet-external'));
  const own = open(task());
  assert.equal(one(own.host, 'sheet')._classes.has('sheet-external'), false);
});

// U16: a malformed onSave result is loud, whichever way it is malformed.
for (const [name, res] of [
  ['undefined', undefined],
  ['no ok', {}],
  ['ok not a boolean', { ok: 'yes' }],
  ['failure without an error string', { ok: false }],
]) {
  test(`an onSave result that is ${name} throws, and the sheet stays open`, () => {
    const { host, calls } = open(task(), { onSave: () => res });
    one(host, 'sheet-title').value = 'changed';
    assert.throws(() => one(host, 'sheet-save').fire('click'), /onSave must return/);
    assert.equal(calls.close, 0);
    assert.equal(host.children.length, 1);
  });
}

test('a quick move is inside the Tab order, so Tab from it is the browser\'s own move', () => {
  const { host } = open(task());
  byClass(host, 'sheet-move')[1].focus();
  assert.equal(pressTab(), false, 'not treated as focus outside the sheet');
  assert.equal(pressTab(true), false);
});
