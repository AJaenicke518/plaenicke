// freshness.js — keeping "today" true in a long-lived PWA, and saying dates
// the way people say them. Pure: no DOM, no storage, no clock of its own.
//
// iOS resumes a home-screen web app rather than reloading it, so anything
// app.js computes once at module load (the day/week/month cursors) goes stale
// overnight. app.js re-derives today on every resume and passes each cursor
// through followToday.

// A cursor that was showing the old today follows the clock; one the user
// navigated elsewhere is left exactly where they put it. Works for any key
// that is equal-when-the-same-period: a day ISO, a week-start ISO, 'YYYY-MM'.
export function followToday(shown, wasToday, isToday) {
  return shown === wasToday ? isToday : shown;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Civil dates are compared as UTC midnights so arithmetic and weekday names
// never depend on the device's timezone.
function utcOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

const SAME_YEAR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
});
const OTHER_YEAR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Never throws. deserializeItems DELIBERATELY tolerates `date: null` (CLAUDE.md:
// deliberate dead code for future undated records), '' is the third date state,
// and this runs inside render() at module load — a throw here would crash every
// cold start, before sync could run to repair the record. So an unreadable date
// gets a loud, specific label instead: visible, never silent, never fatal.
export function formatDayLabel(iso, todayISO) {
  if (iso === null || iso === undefined || iso === '') return 'No date';
  if (typeof iso !== 'string' || !ISO_DAY.test(iso) || Number.isNaN(utcOf(iso))) return 'Unreadable date';
  const diff = Math.round((utcOf(iso) - utcOf(todayISO)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const fmt = iso.slice(0, 4) === todayISO.slice(0, 4) ? SAME_YEAR : OTHER_YEAR;
  return fmt.format(utcOf(iso));
}

const WINDOW_DAYS = 7;

// The Phase 0 baseline: is the app actually being opened? Local-only; see
// storage.js's launch log.
export function describeLaunches(launches, now) {
  const cutoff = now.getTime() - WINDOW_DAYS * DAY_MS;
  const n = launches.filter((iso) => Date.parse(iso) >= cutoff).length;
  if (n === 0) return `Not opened in the last ${WINDOW_DAYS} days.`;
  if (n === 1) return `Opened once in the last ${WINDOW_DAYS} days.`;
  return `Opened ${n} times in the last ${WINDOW_DAYS} days.`;
}
