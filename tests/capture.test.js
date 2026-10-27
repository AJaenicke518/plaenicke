import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeElement, makeFakeDocument, fire } from './fake-dom.js';
import {
  createCapture, CAPTURE_MESSAGES as M, CAPTURE_MAX_SHARE, CAPTURE_TRANSFORM, CLOSE_MS,
} from '../js/capture.js';
import { errorKind } from '../js/voice.js';

// js/capture.js on its own (home-screen spec § 3): the capture button's state
// machine against a fake voice, a fake viewport follower and fake timers.
// tests/apply.test.js covers it wired into app.js (smart add, the two message
// lines, the triggers that stop a listen).

globalThis.document = makeFakeDocument();

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const tap = (el) => el.click();

// A fake voice. listen() records each session; the test drives the session's
// callbacks (opts.onText / onEnd / onError). `order` is shared with submit,
// so a test can check that a stop came before an add.
function fakeVoice(order) {
  const v = {
    supported: true,
    failNext: false,
    listens: [],
    isVoiceSupported: () => v.supported,
    errorKind,
    listen(opts) {
      const session = { opts, stops: 0, stop() { session.stops += 1; order.push('stop'); } };
      v.listens.push(session);
      if (v.failNext) { v.failNext = false; opts.onError('start-failed'); return null; }
      return session;
    },
    get current() { return v.listens[v.listens.length - 1]; },
  };
  return v;
}

function setup({ standalone = false } = {}) {
  globalThis.document.activeElement = null;
  const make = (tag) => new FakeElement(tag);
  const els = {
    button: make('button'), box: make('div'), field: make('textarea'), add: make('button'),
    cancel: make('button'), close: make('button'), typeInstead: make('button'), preview: make('section'),
  };
  const message = make('p');
  const order = [];
  const voice = fakeVoice(order);
  const fx = {
    els, message, order, voice, standalone,
    follows: [], timers: [], previews: 0, cancels: 0, submits: 0, settles: [],
    get settle() { return fx.settles[fx.settles.length - 1]; },
  };
  // Records blur/focus on the field in order, then does what the fake does.
  const { blur, focus } = els.field;
  els.field.blur = function spyBlur() { order.push('blur'); return blur.call(this); };
  els.field.focus = function spyFocus(o) { order.push('focus'); return focus.call(this, o); };
  fx.capture = createCapture({
    els,
    line: { set(t) { message.textContent = t || ''; } },
    voice: { isVoiceSupported: voice.isVoiceSupported, listen: voice.listen, errorKind: voice.errorKind },
    isStandalone: () => fx.standalone,
    submit: () => {
      fx.submits += 1;
      order.push('submit');
      return new Promise((resolve) => { fx.settles.push(resolve); });
    },
    cancelSubmit: () => { fx.cancels += 1; },
    closePreviews: () => { fx.previews += 1; },
    later: (fn, ms) => { const h = { fn, ms, cleared: false }; fx.timers.push(h); return h; },
    clearLater: (h) => { h.cleared = true; },
    follow: (target, opts) => {
      const f = { target, opts, stops: 0 };
      fx.follows.push(f);
      return () => { f.stops += 1; };
    },
  });
  return fx;
}

// Opens the box listening and has the voice say `text`.
function listening(fx, text) {
  tap(fx.els.button);
  if (text !== undefined) fx.voice.current.opts.onText(text);
}

test('it starts closed: box hidden, button not expanded, nothing listening', () => {
  const { els, capture } = setup();
  assert.equal(els.box.hidden, true);
  assert.equal(els.button.getAttribute('aria-expanded'), 'false');
  assert.equal(els.button.getAttribute('aria-label'), 'Capture by voice');
  assert.equal(els.field.readOnly, false);
  assert.equal(els.cancel.hidden, true);
  assert.equal(els.typeInstead.hidden, true);
  assert.deepEqual(capture.state(), { mode: 'closed', adding: false, refused: false, open: false });
});

test('a tap opens the box, follows the visual viewport, closes any preview and listens', () => {
  const fx = setup();
  tap(fx.els.button);
  assert.equal(fx.els.box.hidden, false);
  assert.equal(fx.follows.length, 1);
  assert.equal(fx.follows[0].target, fx.els.box);
  assert.deepEqual(fx.follows[0].opts, { maxShare: CAPTURE_MAX_SHARE, transform: CAPTURE_TRANSFORM });
  assert.equal(fx.previews, 1, 'a new capture closes any open preview (spec § 3 step 8)');
  assert.equal(fx.voice.listens.length, 1);
  assert.equal(fx.voice.current.opts.prefix, '');
  assert.ok(fx.els.button.classList.contains('listening'));
  assert.equal(fx.els.button.getAttribute('aria-label'), 'Stop and add');
  assert.equal(fx.els.button.getAttribute('aria-expanded'), 'true');
  assert.equal(fx.els.field.readOnly, true);
  assert.equal(fx.capture.state().mode, 'listening');
});

test('live words fill the field and grow it, border included', () => {
  const fx = setup();
  listening(fx);
  // A border-box textarea: scrollHeight leaves out its 2px of border.
  fx.els.field.scrollHeight = 72;
  fx.els.field.offsetHeight = 50;
  fx.els.field.clientHeight = 48;
  fx.voice.current.opts.onText('lunch with sam');
  assert.equal(fx.els.field.value, 'lunch with sam');
  assert.equal(fx.els.field.style.height, '74px');
});

test('a listen while this box\'s own preview is open is a new capture: the old text is not its prefix', () => {
  const fx = setup();
  listening(fx, 'two things on friday');
  fx.voice.current.opts.onEnd();
  fx.els.preview.appendChild(new FakeElement('div'));
  tap(fx.els.button);
  assert.equal(fx.voice.current.opts.prefix, '');
  assert.equal(fx.els.field.value, '');
  assert.equal(fx.previews, 2, 'and the preview is closed');
});

test('released() drops the latch at once and adds nothing', async () => {
  const fx = setup();
  listening(fx, 'lunch');
  tap(fx.els.button);
  assert.equal(fx.capture.state().adding, true, 'fixture check');
  fx.capture.released();
  assert.equal(fx.capture.state().adding, false);
  assert.equal(fx.els.button.disabled, false);
  assert.equal(fx.els.cancel.hidden, true);
  assert.equal(fx.cancels, 0, 'released is not a cancel');
  assert.equal(fx.els.field.value, 'lunch', 'the text is kept');
});

test('a tap while listening stops first, then adds the text shown, behind the adding latch', async () => {
  const fx = setup();
  listening(fx, 'lunch with sam');
  tap(fx.els.button);
  assert.deepEqual(fx.order, ['stop', 'submit'], 'stop-and-detach runs before the add');
  assert.equal(fx.els.field.value, 'lunch with sam', 'the text on screen is what is added; no wait for a final result');
  assert.equal(fx.capture.state().mode, 'typing');
  assert.equal(fx.els.field.readOnly, false);
  assert.equal(fx.els.button.disabled, true);
  assert.equal(fx.els.add.disabled, true);
  assert.equal(fx.els.add.hidden, true, 'Cancel replaces Add');
  assert.equal(fx.els.cancel.hidden, false);
  tap(fx.els.button);
  tap(fx.els.add);
  await tick();
  assert.equal(fx.submits, 1, 'the latch refuses a second add');
  fx.settle('preview');
  await tick();
  assert.equal(fx.capture.state().adding, false);
  assert.equal(fx.els.button.disabled, false);
  assert.equal(fx.els.add.hidden, false);
  assert.equal(fx.els.cancel.hidden, true);
});

test('a tap while listening with nothing heard adds nothing and says so', () => {
  const fx = setup();
  listening(fx, '   ');
  tap(fx.els.button);
  assert.deepEqual(fx.order, ['stop']);
  assert.equal(fx.submits, 0);
  assert.equal(fx.message.textContent, M.nothing);
  assert.equal(fx.capture.state().adding, false);
});

test("the box's own Add stops a listen first too", () => {
  const fx = setup();
  listening(fx, 'call the bank');
  tap(fx.els.add);
  assert.deepEqual(fx.order, ['stop', 'submit']);
});

test('tapping the text while listening stops without adding and focuses it for the keyboard', () => {
  const fx = setup();
  listening(fx, 'dentist');
  fire(fx.els.field, 'click');
  assert.deepEqual(fx.order, ['stop', 'blur', 'focus'], 'blur first: the tap has already focused the read-only field');
  assert.equal(fx.submits, 0);
  assert.equal(fx.els.field.readOnly, false);
  assert.equal(globalThis.document.activeElement, fx.els.field);
  assert.equal(fx.els.field.value, 'dentist', 'text kept');
  assert.equal(fx.capture.state().mode, 'typing');
});

test('recognition ending on its own keeps the text and adds nothing; the next tap appends', () => {
  const fx = setup();
  listening(fx, 'call mom');
  fx.voice.current.opts.onEnd();
  assert.equal(fx.message.textContent, M.stopped);
  assert.equal(fx.capture.state().mode, 'typing');
  assert.equal(fx.submits, 0, 'nothing is added without a tap');
  tap(fx.els.button);
  assert.equal(fx.voice.listens.length, 2);
  assert.equal(fx.voice.current.opts.prefix, 'call mom', 'the new listen appends to the text');
  assert.equal(fx.previews, 2);
  assert.equal(fx.message.textContent, '', 'a new listen clears the old message');
});

test('stopAndKeep stops a listen and keeps its text; when not listening it changes nothing', () => {
  const fx = setup();
  fx.capture.stopAndKeep();
  assert.deepEqual(fx.order, []);
  assert.equal(fx.message.textContent, '');
  listening(fx, 'pick up keys');
  fx.capture.stopAndKeep();
  assert.deepEqual(fx.order, ['stop']);
  assert.equal(fx.message.textContent, M.stopped);
  assert.equal(fx.els.field.value, 'pick up keys');
  assert.equal(fx.submits, 0);
  assert.equal(fx.els.box.hidden, false, 'the box stays open');
});

for (const [standalone, text] of [[false, M.safari], [true, M.permission]]) {
  test(`a refusal in ${standalone ? 'the home-screen app' : 'a Safari tab'} says why, offers Type instead, and never focuses`, () => {
    const fx = setup({ standalone });
    listening(fx, 'half a thought');
    fx.order.length = 0;
    fx.voice.current.opts.onError('service-not-allowed');
    assert.equal(fx.message.textContent, text);
    assert.equal(fx.els.typeInstead.hidden, false);
    assert.equal(fx.capture.state().mode, 'typing');
    assert.deepEqual(fx.order, [], 'no focus from an asynchronous error');
    assert.equal(globalThis.document.activeElement, null);
    tap(fx.els.typeInstead);
    assert.equal(fx.els.typeInstead.hidden, true);
    assert.equal(globalThis.document.activeElement, fx.els.field, 'Type instead focuses within its own tap');
    // Later taps this session go straight to typing.
    tap(fx.els.button);
    assert.equal(fx.voice.listens.length, 1, 'no second listen');
    assert.equal(fx.message.textContent, text);
    assert.equal(globalThis.document.activeElement, fx.els.field);
    assert.equal(fx.capture.state().refused, true);
  });
}

test('no-speech, audio-capture and network say try again, with no Type instead and no focus', () => {
  for (const code of ['no-speech', 'audio-capture', 'network']) {
    const fx = setup();
    listening(fx);
    fx.order.length = 0;
    fx.voice.current.opts.onError(code);
    assert.equal(fx.message.textContent, M.retry, code);
    assert.equal(fx.els.typeInstead.hidden, true, code);
    assert.deepEqual(fx.order, [], code);
    assert.equal(fx.capture.state().mode, 'typing', code);
    assert.equal(fx.capture.state().refused, false, code);
  }
});

test('a start() that fails reads as try again', () => {
  const fx = setup();
  fx.voice.failNext = true;
  tap(fx.els.button);
  assert.equal(fx.message.textContent, M.retry);
  assert.equal(fx.capture.state().mode, 'typing');
});

test('without SpeechRecognition a tap opens the box to type in, focused, and says so', () => {
  const fx = setup();
  fx.voice.supported = false;
  tap(fx.els.button);
  assert.equal(fx.els.box.hidden, false);
  assert.equal(fx.voice.listens.length, 0);
  assert.equal(fx.message.textContent, M.unsupported);
  assert.equal(globalThis.document.activeElement, fx.els.field);
  assert.equal(fx.capture.state().mode, 'typing');
});

test('Cancel during Thinking clears the latch and keeps the text; a late settle changes nothing', async () => {
  const fx = setup();
  listening(fx, 'dentist on may 15');
  tap(fx.els.button);
  const firstSettle = fx.settle;
  tap(fx.els.cancel);
  assert.equal(fx.cancels, 1);
  assert.equal(fx.message.textContent, M.cancelled);
  assert.equal(fx.capture.state().adding, false);
  assert.equal(fx.els.button.disabled, false);
  assert.equal(fx.els.field.value, 'dentist on may 15');
  tap(fx.els.add);
  await tick();
  assert.equal(fx.submits, 2);
  firstSettle('superseded');
  await tick();
  assert.equal(fx.capture.state().adding, true, 'the newer add keeps its latch through the older settle');
  assert.equal(fx.els.button.disabled, true);
  fx.settle('failed');
  await tick();
  assert.equal(fx.capture.state().adding, false);
});

test('added() clears the latch and closes an empty box; text typed meanwhile keeps it open', async () => {
  const fx = setup();
  listening(fx, 'lunch');
  tap(fx.els.button);
  fx.els.field.value = '';
  fx.capture.added();
  assert.equal(fx.capture.state().adding, false);
  assert.equal(fx.cancels, 0, 'a success is not a cancel');
  assert.ok(fx.els.box.classList.contains('closing'));
  const fx2 = setup();
  listening(fx2, 'lunch');
  tap(fx2.els.button);
  fx2.els.field.value = 'and the next thing';
  fx2.capture.added();
  assert.equal(fx2.capture.state().adding, false);
  assert.equal(fx2.els.box.classList.contains('closing'), false);
  assert.equal(fx2.capture.state().mode, 'typing');
});

test('x stops listening, clears everything, and closes with the grow-back animation', () => {
  const fx = setup();
  listening(fx, 'never mind');
  fx.els.preview.appendChild(new FakeElement('div'));
  fx.els.preview.hidden = false;
  fx.els.field.style.height = '72px';
  tap(fx.els.close);
  assert.deepEqual(fx.order.filter((x) => x !== 'blur'), ['stop']);
  assert.equal(fx.els.field.value, '');
  assert.equal(fx.els.field.style.height, '');
  assert.equal(fx.message.textContent, '');
  assert.equal(fx.els.preview.children.length, 0);
  assert.equal(fx.els.preview.hidden, true);
  assert.ok(fx.els.box.classList.contains('closing'));
  assert.equal(fx.els.box.classList.contains('fade'), false);
  assert.equal(fx.els.box.hidden, false, 'still showing while it animates');
  assert.equal(fx.els.button.getAttribute('aria-expanded'), 'false');
  assert.equal(fx.timers.length, 1);
  assert.equal(fx.timers[0].ms, CLOSE_MS);
  fx.timers[0].fn();
  assert.equal(fx.els.box.hidden, true);
  assert.equal(fx.els.box.classList.contains('closing'), false);
  assert.equal(fx.follows[0].stops, 1, 'and stops following the viewport');
});

// focusin/focusout as a browser sends them to the box: they bubble from the
// control, and focusout names where focus is going (relatedTarget).
function focusEvent(fx, type, target, relatedTarget = null) {
  for (const fn of fx.els.box._listeners[type] || []) fn({ target, relatedTarget });
}

test('the box drops to the keyboard while the field or a preview input has focus, and not for a read-only field', () => {
  const fx = setup();
  listening(fx, 'typed');
  const box = fx.els.box;
  focusEvent(fx, 'focusin', fx.els.field);
  assert.equal(box.classList.contains('typing'), false, 'a read-only focus raises no keyboard');
  fx.voice.current.opts.onEnd();
  focusEvent(fx, 'focusin', fx.els.field);
  assert.ok(box.classList.contains('typing'));
  // Into the preview's title input: still typing, no flicker.
  const input = new FakeElement('input');
  fx.els.preview.appendChild(input);
  fx.els.box.appendChild(fx.els.preview);
  focusEvent(fx, 'focusout', fx.els.field, input);
  assert.ok(box.classList.contains('typing'), 'moving between two inputs in the box keeps it');
  focusEvent(fx, 'focusin', input);
  assert.ok(box.classList.contains('typing'));
  // Out to a button (no keyboard): the box goes back above the round button.
  focusEvent(fx, 'focusout', input, fx.els.add);
  assert.equal(box.classList.contains('typing'), false);
  // A preview input alone raises it too.
  focusEvent(fx, 'focusin', input);
  assert.ok(box.classList.contains('typing'));
  focusEvent(fx, 'focusout', input, null);
  assert.equal(box.classList.contains('typing'), false);
});

test('x with the keyboard up fades where it is, keeping its place until it is hidden', () => {
  const fx = setup();
  listening(fx, 'typed');
  fx.voice.current.opts.onEnd();
  focusEvent(fx, 'focusin', fx.els.field);
  tap(fx.els.close);
  focusEvent(fx, 'focusout', fx.els.field, null); // the blur close() causes
  assert.ok(fx.els.box.classList.contains('fade'));
  assert.ok(fx.els.box.classList.contains('closing'));
  assert.ok(fx.els.box.classList.contains('typing'), 'no jump up before the fade');
  fx.timers[0].fn();
  assert.equal(fx.els.box.classList.contains('typing'), false);
  assert.equal(fx.els.box.hidden, true);
});

test('x during Thinking discards the request', () => {
  const fx = setup();
  listening(fx, 'lunch');
  tap(fx.els.button);
  tap(fx.els.close);
  assert.equal(fx.cancels, 1);
  assert.equal(fx.capture.state().adding, false);
  assert.ok(fx.els.box.classList.contains('closing'));
});

test('a tap while the box is closing reopens it without a second viewport follow', () => {
  const fx = setup();
  listening(fx, 'x');
  fx.voice.current.opts.onEnd();
  focusEvent(fx, 'focusin', fx.els.field);
  tap(fx.els.close);
  tap(fx.els.button);
  assert.equal(fx.timers[0].cleared, true);
  assert.equal(fx.els.box.classList.contains('closing'), false);
  assert.equal(fx.els.box.classList.contains('fade'), false);
  assert.equal(fx.els.box.classList.contains('typing'), false, 'the field lost focus as the box began to close');
  assert.equal(fx.els.box.hidden, false);
  assert.equal(fx.follows.length, 1);
  assert.equal(fx.voice.listens.length, 2);
  assert.equal(fx.voice.current.opts.prefix, '', 'x cleared the text');
});

test('createCapture refuses a missing element or callback', () => {
  const base = setup();
  const ok = {
    els: base.els, line: { set() {} },
    voice: { isVoiceSupported: () => true, listen() {}, errorKind },
    isStandalone: () => false, submit: async () => {}, cancelSubmit() {}, closePreviews() {},
  };
  for (const name of ['button', 'box', 'field', 'add', 'cancel', 'close', 'typeInstead', 'preview']) {
    assert.throws(() => createCapture({ ...ok, els: { ...ok.els, [name]: null } }), new RegExp(name));
  }
  for (const name of ['isStandalone', 'submit', 'cancelSubmit', 'closePreviews']) {
    assert.throws(() => createCapture({ ...ok, [name]: undefined }), new RegExp(name));
  }
  assert.throws(() => createCapture({ ...ok, line: null }), /line/);
  assert.throws(() => createCapture({ ...ok, voice: { listen() {} } }), /voice/);
});

test('the transform names the variable styles.css sets', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(CAPTURE_TRANSFORM, /var\(--capture-lift\)/);
  assert.match(css, /\.capture-box \{[^}]*--capture-lift:/);
  assert.match(css, /capture-shrink 250ms/, `CLOSE_MS (${CLOSE_MS}) is the close animation's length`);
  assert.equal(CLOSE_MS, 250);
});
