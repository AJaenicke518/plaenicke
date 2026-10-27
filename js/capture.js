// capture.js — the round capture button and the box that grows out of it
// (home-screen spec § 3). Presentation and the listen state machine only:
// it never adds an item, and holds no storage or app state. `submit` (app.js's
// handleAdd for the capture box) adds, and calls `added()` back on success;
// `cancelSubmit` makes a smart add in flight superseded; `closePreviews`
// closes an open preview in BOTH boxes (spec § 3 step 8).
//
// The gesture (Decided): tap = start listening, the box opens and live words
// appear; tap again = stop and add; tap the text = type instead (listening
// stops). No double-tap.
//
// Modes: 'closed' (box hidden) | 'listening' | 'typing' (box open, not
// listening). Separately, `adding` is the latch while a smart add thinks.
//
// Every stop is STOP-AND-DETACH (voice.js's session.stop()): the text on
// screen is what counts, and nothing that arrives after the stop changes it.
// Nothing is ever added without a tap: recognition ending on its own, the page
// hiding, a sheet or Settings opening all stop and KEEP the text.
//
// Focus: the field is focused only inside a tap (iOS raises the keyboard only
// from a user gesture). An asynchronous refusal never focuses; it offers
// "Type instead", whose own tap focuses.

import { followVisualViewport } from './viewport.js';

// The box may take half the visible height; it sits above the button (or the
// keyboard), and its panel scrolls inside itself (styles.css).
export const CAPTURE_MAX_SHARE = 0.5;
// Lifts the box's bottom edge --capture-lift above the visible bottom
// (styles.css sets it: above the button, or 8px above the keyboard).
export const CAPTURE_TRANSFORM = 'translateY(calc(-100% - var(--capture-lift)))';
// The close animation's length (styles.css: 250ms); the box hides after it.
export const CLOSE_MS = 250;

export const CAPTURE_MESSAGES = Object.freeze({
  stopped: 'Stopped listening — tap Add.',
  nothing: "Didn't catch anything — type it, or tap the mic.",
  retry: "Didn't catch that — try again or type it.",
  unsupported: "Voice isn't available here — type instead.",
  safari: 'Voice works in the home-screen app.',
  permission: 'Microphone permission is off — Settings → plaenicke.',
  cancelled: 'Cancelled — nothing was added.',
});
const M = CAPTURE_MESSAGES;

const REQUIRED_ELS = ['button', 'box', 'field', 'add', 'cancel', 'close', 'typeInstead', 'preview'];

export function createCapture({
  els, line, voice, isStandalone, submit, cancelSubmit, closePreviews,
  later = (fn, ms) => setTimeout(fn, ms),
  clearLater = (handle) => clearTimeout(handle),
  follow = followVisualViewport,
} = {}) {
  // A missing wire would be a dead button, found only on the phone.
  for (const name of REQUIRED_ELS) {
    if (!els || !els[name]) throw new Error(`createCapture: missing element ${name}`);
  }
  if (!line || typeof line.set !== 'function') throw new Error('createCapture: line.set must be a function');
  if (!voice || !['isVoiceSupported', 'listen', 'errorKind'].every((k) => typeof voice[k] === 'function')) {
    throw new Error('createCapture: voice needs isVoiceSupported, listen and errorKind');
  }
  for (const [name, fn] of Object.entries({ isStandalone, submit, cancelSubmit, closePreviews })) {
    if (typeof fn !== 'function') throw new Error(`createCapture: ${name} must be a function`);
  }

  let mode = 'closed';
  let session = null; // voice.js's session while listening
  let adding = null; // a fresh token while a smart add thinks, else null
  let refused = false; // voice refused once: later taps this session type instead
  let previewText = null; // the text that produced this box's open preview
  // This box's preview is showing: its own Add is hidden then, so "Add all"
  // is the one confirm and a second paid request cannot re-send the same
  // text (controller ruling, 2026-10-26). app.js says when it closes.
  let previewOpen = false;
  let closeTimer = null;
  let stopFollow = null;

  function setMode(next) {
    mode = next;
    els.button.classList.toggle('listening', next === 'listening');
    els.button.setAttribute('aria-label', next === 'listening' ? 'Stop and add' : 'Capture by voice');
    els.button.setAttribute('aria-expanded', String(next !== 'closed'));
    // Read-only while listening, so a tap on the text does not raise the
    // keyboard by itself; the tap's handler decides (spec § 3 step 3).
    els.field.readOnly = next === 'listening';
  }

  // The field grows with its text (spec § 3: "a new textarea that grows"), up
  // to styles.css's max-height, after which it scrolls. scrollHeight leaves
  // out the border, which border-box sizing counts: offsetHeight - clientHeight
  // adds it back, or the last line is clipped (DA M3).
  function grow() {
    els.field.style.height = 'auto';
    els.field.style.height = `${els.field.scrollHeight + els.field.offsetHeight - els.field.clientHeight}px`;
  }

  // A control that raises the keyboard: the field unless it is read-only
  // (listening), and the preview's inputs and selects (DA I4).
  const raisesKeyboard = (node) => !!node && (node === els.field
    ? !els.field.readOnly
    : ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));
  const inBox = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === els.box) return true;
    return false;
  };

  function open() {
    if (closeTimer !== null) {
      // Reopened while closing: the box is still showing and still placed,
      // so it only stops closing. Its field lost focus when it began to.
      clearLater(closeTimer);
      closeTimer = null;
      els.box.classList.remove('closing');
      els.box.classList.remove('fade');
      els.box.classList.remove('typing');
    }
    if (!els.box.hidden) return;
    els.box.hidden = false;
    stopFollow = follow(els.box, { maxShare: CAPTURE_MAX_SHARE, transform: CAPTURE_TRANSFORM });
  }

  function finishClose() {
    closeTimer = null;
    els.box.hidden = true;
    els.box.classList.remove('closing');
    els.box.classList.remove('fade');
    els.box.classList.remove('typing');
    if (stopFollow) { stopFollow(); stopFollow = null; }
  }

  // Stop-and-detach. True when it stopped a listen.
  function stopListening() {
    if (!session) return false;
    const s = session;
    session = null;
    s.stop();
    setMode('typing');
    return true;
  }

  // Inside a tap only. blur() first: a tap on the read-only field has already
  // focused it, and focus() on a focused field would not raise the keyboard.
  function focusField() {
    els.field.readOnly = false;
    els.field.blur();
    els.field.focus();
  }

  function setAdding(on) {
    els.button.disabled = on;
    els.add.disabled = on;
    els.add.hidden = on || previewOpen;
    els.cancel.hidden = !on;
  }

  const refusedText = () => (isStandalone() ? M.permission : M.safari);

  function onVoiceError(code) {
    session = null;
    setMode('typing');
    if (voice.errorKind(code) === 'refused') {
      refused = true;
      line.set(refusedText());
      els.typeInstead.hidden = false;
      return;
    }
    line.set(M.retry);
  }

  function startListening() {
    line.set('');
    els.typeInstead.hidden = true;
    // A listen while this box's own preview is open is a NEW capture (spec
    // § 3 step 8): the text that made the preview goes with it, or it would
    // be the new listen's prefix and be sent again (DA I2). Only while the
    // field still holds that text: an edit made since is the next entry and
    // is kept, as handleAdd's clearSentText keeps it (Task 4 review).
    if (els.preview.children.length > 0 && els.field.value.trim() === previewText) els.field.value = '';
    // After clearing the line: closing this box's own preview says so here.
    closePreviews();
    const s = voice.listen({
      prefix: els.field.value,
      onText: (text) => { els.field.value = text; grow(); },
      onEnd: () => { session = null; setMode('typing'); line.set(M.stopped); },
      onError: onVoiceError,
    });
    if (s === null) return; // start() threw; onError has already said so
    session = s;
    setMode('listening');
  }

  function cancel() {
    if (adding === null) return;
    adding = null;
    setAdding(false);
    cancelSubmit();
    line.set(M.cancelled);
  }

  // Every Add path runs stop-and-detach first (spec § 3 step 6). `spoken`:
  // the round button stopped a listen, so empty text means nothing was heard.
  async function add({ spoken = false } = {}) {
    if (adding !== null) return;
    stopListening();
    if (spoken && !els.field.value.trim()) { line.set(M.nothing); return; }
    const token = {};
    adding = token;
    setAdding(true);
    const sent = els.field.value.trim();
    try {
      const outcome = await submit();
      if (outcome === 'preview') { previewText = sent; previewOpen = true; }
    } catch (err) {
      // handleAdd reports its own failures; reaching here is a bug. Say so,
      // and rethrow so the click handler logs it (zero fallback).
      if (adding === token) line.set(`Could not add: ${err && err.message ? err.message : err}`);
      throw err;
    } finally {
      // Only this add's own latch: a Cancel and a newer add may have come since.
      if (adding === token) { adding = null; setAdding(false); }
    }
  }

  function close() {
    if (mode === 'closed') return;
    stopListening();
    if (adding !== null) cancel(); // x while thinking discards the request
    // With the keyboard up the button is covered, so the box fades out.
    // .closing goes on BEFORE the blur, and .typing stays until finishClose:
    // the box fades where it is instead of jumping up first (DA M1).
    if (els.box.classList.contains('typing')) els.box.classList.add('fade');
    els.box.classList.add('closing');
    els.field.blur();
    els.field.value = '';
    els.field.style.height = '';
    line.set('');
    els.typeInstead.hidden = true;
    els.preview.hidden = true;
    els.preview.innerHTML = '';
    previewOpen = false;
    els.add.hidden = false;
    setMode('closed');
    closeTimer = later(finishClose, CLOSE_MS);
  }

  // add() rethrows what handleAdd did not handle; a click handler has no one
  // to rethrow to, so it is logged (and the line already says so).
  const logFailure = (err) => { console.error('capture: add failed', err); };

  function tapButton() {
    if (adding !== null) return;
    if (mode === 'listening') {
      add({ spoken: true }).catch(logFailure); // stops the listen first
      return;
    }
    open();
    if (!voice.isVoiceSupported()) {
      setMode('typing');
      line.set(M.unsupported);
      focusField();
      return;
    }
    if (refused) {
      setMode('typing');
      line.set(refusedText());
      els.typeInstead.hidden = true;
      focusField();
      return;
    }
    startListening();
  }

  els.button.addEventListener('click', tapButton);
  els.add.addEventListener('click', () => { add().catch(logFailure); });
  els.cancel.addEventListener('click', cancel);
  els.close.addEventListener('click', close);
  els.typeInstead.addEventListener('click', () => {
    els.typeInstead.hidden = true;
    focusField();
  });
  els.field.addEventListener('click', () => {
    if (mode !== 'listening') return;
    stopListening();
    focusField();
  });
  els.field.addEventListener('input', grow);
  // Return adds (Alex, 2026-10-26: "add the item"), through the same path as
  // the box's Add: stop-and-detach first, then the adding latch. Never a
  // newline, while thinking too. Not mid-composition: an IME's Return
  // confirms the composed word.
  // keyCode 229: Safari can report the Return that confirms a composition
  // with isComposing false. With this box's own preview open and the text
  // unchanged, Return sends nothing: "Add all" is the confirm, and re-sending
  // the same text is the second paid request the hidden Add exists to stop.
  // An edit made since is the next entry and adds (merge review, 2026-10-26).
  els.field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (previewOpen && els.field.value.trim() === previewText) return;
    add().catch(logFailure);
  });
  // .typing lowers the box to just above the keyboard (styles.css) while any
  // control in it that raises the keyboard has focus: the field (not while
  // read-only: no keyboard comes up for that) or an input of its preview
  // (DA I4). Moving focus between two such controls keeps it, and a closing
  // box keeps it until it is hidden (DA M1).
  els.box.addEventListener('focusin', (e) => { if (raisesKeyboard(e.target)) els.box.classList.add('typing'); });
  els.box.addEventListener('focusout', (e) => {
    if (els.box.classList.contains('closing')) return;
    if (raisesKeyboard(e.relatedTarget) && inBox(e.relatedTarget)) return;
    els.box.classList.remove('typing');
  });

  els.box.hidden = true;
  els.cancel.hidden = true;
  els.typeInstead.hidden = true;
  setMode('closed');

  return {
    // Stop a listen and keep its text (page hidden, a sheet or Settings opening).
    stopAndKeep() { if (stopListening()) line.set(M.stopped); },
    // A newer Add from the other box superseded this box's smart add: its
    // reply will change nothing, so the latch goes now, not when the reply
    // comes up to a minute later (DA I1). app.js clears the line.
    released() {
      if (adding !== null) { adding = null; setAdding(false); }
    },
    // This box's preview closed without being confirmed: a newer Add (from
    // either box), its Cancel, or a new listen. Its Add shows again.
    previewClosed() {
      previewOpen = false;
      setAdding(adding !== null);
    },
    // A capture was added (direct, or from its preview, which is then closed).
    added() {
      previewOpen = false;
      adding = null;
      setAdding(false);
      // Text typed while it was thinking is the next entry: the box stays.
      if (els.field.value.trim()) return;
      close();
    },
    state: () => ({ mode, adding: adding !== null, refused, open: !els.box.hidden }),
  };
}
