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
  }

  get className() { return [...this._classes].join(' '); }

  set className(v) { this._classes = new Set(String(v).split(' ').filter(Boolean)); }

  setAttribute(name, val) { this._attrs[name] = String(val); }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

  get innerHTML() { return ''; }

  set innerHTML(v) { if (v === '') { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } }

  fire(type, ev = {}) { (this._listeners[type] || []).forEach((fn) => fn({ target: this, ...ev })); }
}

// document-level listeners are tracked by identity, as the real
// removeEventListener does: removing a different function removes nothing.
const docListeners = {};
globalThis.document = {
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
    todayISO: TODAY,
    onSave: (p) => { calls.save.push(p); return onSave(p); },
    onDelete: () => { calls.del += 1; },
    onClose: () => { calls.close += 1; },
    ...extra,
  });
  return { host, calls };
}

// Every test must leave the document clean, or the listener-count assertions
// in later tests would be measuring an earlier test's leak.
test.afterEach(() => { docListeners.keydown = []; });

// =========================================================================
// Own item, not an idea
// =========================================================================

test('the own-item sheet is a modal dialog with Cancel and Save in a top bar, above the form', () => {
  const { host } = open(task());
  assert.equal(host.children.length, 1);
  const backdrop = host.children[0];
  assert.ok(backdrop._classes.has('sheet-backdrop'));
  assert.equal(backdrop.getAttribute('role'), 'dialog');
  assert.equal(backdrop.getAttribute('aria-modal'), 'true');
  const sheet = backdrop.children[0];
  assert.ok(sheet._classes.has('sheet'), '.sheet must be the backdrop\'s child');
  const bar = sheet.children[0];
  assert.ok(bar._classes.has('sheet-bar'), 'the top bar must be the sheet\'s FIRST child, so it stays above the keyboard');
  const buttons = bar.children.filter((c) => c.tagName === 'BUTTON');
  assert.equal(buttons[0].textContent, 'Cancel', 'Cancel on the left');
  assert.equal(buttons[buttons.length - 1].textContent, 'Save', 'Save on the right');
  for (const b of byTag(host, 'BUTTON')) assert.equal(b.type, 'button', 'no button may default to submit');
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

test('switching a task to idea sends the typeChangePatch result, not the raw diff', () => {
  const { host, calls } = open(task());
  one(host, 'sheet-type').value = 'idea';
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ type: 'idea', notes: 'Dentist\n\nbring card', time: null, endTime: null }]);
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
    () => openItemSheet(host, task({ type: 'bogus' }), { todayISO: TODAY, onSave() {}, onDelete() {}, onClose() {} }),
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

test('idea -> task sends a derived title and keeps the full text in notes', () => {
  const { host, calls } = open(idea());
  one(host, 'sheet-type').value = 'task';
  one(host, 'sheet-save').fire('click');
  const { title, notes } = splitIdeaText(LONG);
  assert.equal(title, 'Build a tiny garden shed.');
  assert.deepEqual(calls.save, [{ type: 'task', title, notes }]);
});

test('idea -> task with edited text derives from the edited text', () => {
  const { host, calls } = open(idea());
  one(host, 'sheet-text').value = 'Call the plumber';
  one(host, 'sheet-type').value = 'task';
  one(host, 'sheet-save').fire('click');
  assert.deepEqual(calls.save, [{ type: 'task', title: 'Call the plumber', notes: null }]);
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
  assert.equal(links[0].rel, 'noopener');
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
  backdrop.fire('click', { target: sheet });
  assert.equal(host.children.length, 1, 'a tap inside the sheet must not close it');
  backdrop.fire('click');
  assert.equal(host.children.length, 0);
  assert.equal(calls.close, 1);
});

// Every close path, each on a fresh sheet. One path forgetting to remove the
// listener would leave a stale Escape handler that empties whatever the host
// shows next and calls a stale onClose.
const CLOSE_PATHS = {
  'Cancel': (h) => one(h, 'sheet-cancel').fire('click'),
  'backdrop': (h) => one(h, 'sheet-backdrop').fire('click'),
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
  const opts = (tag) => ({ todayISO: TODAY, onSave: () => ({ ok: true }), onDelete() {}, onClose: () => closes.push(tag) });
  openItemSheet(host, task(), opts('first'));
  openItemSheet(host, task({ id: 'a2', title: 'Second' }), opts('second'));
  assert.equal(keydownCount(), 1, 'the replaced sheet\'s Escape handler must go with it');
  assert.equal(host.children.length, 1);
  pressKey('Escape');
  assert.deepEqual(closes, ['second'], 'Escape closes the sheet on screen, and the replaced one never fires');
  assert.equal(keydownCount(), 0);
});
