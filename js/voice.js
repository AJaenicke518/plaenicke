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
