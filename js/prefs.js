// prefs.js — device-local display preferences: time format, week start and colour scheme.
// Pure resolvers plus storage wrapped in try/catch (mirrors theme.js). Never
// synced: nothing here touches the sync blob. A missing key, an unknown value,
// or a throwing/missing localStorage resolves to today's behaviour.

export const TIME_FORMAT_KEY = 'plaenicke.timeFormat';
export const WEEK_START_KEY = 'plaenicke.weekStart';
export const SCHEME_KEY = 'plaenicke.scheme';
export const SCHEMES = ['classic', 'sage', 'ocean', 'plum'];

export function resolveTimeFormat(raw) {
  return raw === '24h' ? '24h' : '12h';
}

export function resolveWeekStart(raw) {
  return raw === 'mon' ? 'mon' : 'sun';
}

export function resolveScheme(raw) {
  return SCHEMES.includes(raw) ? raw : 'classic';
}

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function getTimeFormat() { return resolveTimeFormat(read(TIME_FORMAT_KEY)); }
export function getWeekStart() { return resolveWeekStart(read(WEEK_START_KEY)); }

// An invalid value is a programming error and throws; a storage failure
// (private mode, quota) returns false so the caller can say so.
export function setTimeFormat(v) {
  if (v !== '12h' && v !== '24h') throw new Error('bad time format');
  return write(TIME_FORMAT_KEY, v);
}

export function setWeekStart(v) {
  if (v !== 'sun' && v !== 'mon') throw new Error('bad week start');
  return write(WEEK_START_KEY, v);
}

export function getScheme() { return resolveScheme(read(SCHEME_KEY)); }

export function setScheme(v) {
  if (!SCHEMES.includes(v)) throw new Error('bad scheme');
  return write(SCHEME_KEY, v);
}

// classic is the absence of the attribute: :root and [data-theme="dark"] carry
// the classic values. index.html's pre-paint script holds a copy of this list.
export function applyScheme(scheme, root = document.documentElement) {
  if (scheme === 'classic') delete root.dataset.scheme;
  else root.dataset.scheme = scheme;
}
