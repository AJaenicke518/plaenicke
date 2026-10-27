// voice.js — in-app dictation via the browser Web Speech API.
// Supported on desktop Chrome/Safari; unreliable on iOS Safari, so callers
// should hide the mic button when isVoiceSupported() is false and fall back
// to the built-in keyboard microphone.

function getRecognizer() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isVoiceSupported() {
  return typeof getRecognizer() === 'function';
}

// Starts one listen. Calls back with the transcript. Returns the recognizer
// (so a caller could stop it) or null if unsupported.
export function dictate({ onResult, onStart, onEnd, onError }) {
  const SR = getRecognizer();
  if (!SR) { if (onError) onError(new Error('unsupported')); return null; }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onstart = () => { if (onStart) onStart(); };
  rec.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    if (onResult) onResult(transcript);
  };
  rec.onerror = (e) => { if (onError) onError(e.error || e); };
  rec.onend = () => { if (onEnd) onEnd(); };
  try {
    rec.start();
  } catch (err) {
    if (onError) onError(err);
    return null;
  }
  return rec;
}

// --- listen(): the capture button's listen (home-screen spec § 3) ----------
//
// What the 2026-10-20 iPhone spike (voice-test.html, commits f2ff20d..8b4e819)
// established, and so what this is built around:
//   - a NEW SpeechRecognition per listen, never a reused one;
//   - `continuous` + `interimResults`, so words appear as they are said;
//   - after stop() NO final result arrives (textAfterStop=null) and onend may
//     not fire at all. So the caller never waits for one: the text already
//     on screen IS what gets added, and stop() detaches every handler BEFORE
//     calling stop() and then abort(), so nothing late can change it.
//
// listen({ prefix, onText, onEnd, onError }) -> session | null
//   prefix   the field's text when the listen started; every result shows
//            prefix + all finals + the current interim (composeText).
//   onText   (text) on every result.
//   onEnd    () when recognition ended on its own (not after stop()).
//   onError  (code) on an error — e.error, e.g. 'not-allowed' — or
//            'start-failed' when the constructor or start() throws. Ends the listen.
//   session  { stop() }: detach, then stop(), then abort(). Idempotent.
//   null     only when the constructor or start() threw (onError has already
//            been called).
// Throws when there is no SpeechRecognition: callers check
// isVoiceSupported() inside the tap first, and must not reach here without it.

// The two error codes that mean "voice is refused here", not "try again".
export const REFUSED_ERRORS = ['not-allowed', 'service-not-allowed'];

export function errorKind(code) {
  return REFUSED_ERRORS.includes(code) ? 'refused' : 'retry';
}

// prefix + every final + the current interim, rebuilt from the WHOLE result
// list each time (e.results), joined to the prefix by exactly one space.
// Nothing said yet: the prefix, untouched.
export function composeText(prefix, results) {
  let finals = '';
  let interim = '';
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (r.isFinal) finals += r[0].transcript;
    else interim += r[0].transcript;
  }
  const spoken = `${finals}${interim}`.trim();
  if (!spoken) return prefix;
  if (!prefix || /\s$/.test(prefix)) return `${prefix}${spoken}`;
  return `${prefix} ${spoken}`;
}

export function listen({ prefix = '', onText, onEnd, onError } = {}) {
  for (const [name, fn] of Object.entries({ onText, onEnd, onError })) {
    if (typeof fn !== 'function') throw new Error(`listen: ${name} must be a function`);
  }
  const SR = getRecognizer();
  if (!SR) throw new Error('listen: no SpeechRecognition here — check isVoiceSupported() first');
  // A constructor that throws reports like a start() that throws (DA M4): an
  // escaping throw would leave the box open with nothing listening.
  let rec;
  try {
    rec = new SR();
  } catch {
    onError('start-failed');
    return null;
  }
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  // `live` as well as nulling the handlers: a browser that already holds a
  // reference to a handler can still call it after it was replaced.
  let live = true;
  const detach = () => {
    live = false;
    rec.onresult = null;
    rec.onend = null;
    rec.onerror = null;
  };
  rec.onresult = (e) => { if (live) onText(composeText(prefix, e.results)); };
  rec.onerror = (e) => {
    if (!live) return;
    detach();
    onError((e && e.error) || 'unknown');
  };
  rec.onend = () => {
    if (!live) return;
    detach();
    onEnd();
  };
  try {
    rec.start();
  } catch {
    detach();
    onError('start-failed');
    return null;
  }
  return {
    stop() {
      if (!live) return;
      detach();
      rec.stop();
      rec.abort();
    },
  };
}
