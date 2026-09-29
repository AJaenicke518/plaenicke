// freshness.js — keeping "today" true in a long-lived PWA, and saying dates
// the way people say them. Pure: no DOM, no storage, no clock of its own.
//
// iOS resumes a home-screen web app rather than reloading it, so anything
// app.js computes once at module load (the day/week/month cursors) goes stale
// overnight. app.js re-derives today on every resume and passes each cursor
// through followToday.

import { toISO } from './dateparse.js';
import { addDays, formatTime } from './timegrid.js';

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

function localClock(d) {
  return formatTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
}

// The Phase 0 baseline: is the app actually being opened? Local-only; see
// storage.js's launch log. Pure: the caller passes the log and the clock.
//
// The metric is DAYS of use, not opens: a day is the device's LOCAL calendar
// date of each timestamp, and the window is the last WINDOW_DAYS local dates
// (today and the six before). Day arithmetic is on YYYY-MM-DD strings, so a
// 23- or 25-hour DST day cannot move the window's edge.
export function describeLaunches(launches, now) {
  const today = toISO(now);
  const first = addDays(today, -(WINDOW_DAYS - 1));
  const times = launches.map((iso) => Date.parse(iso)).filter(Number.isFinite);
  const days = new Set(times.map((t) => toISO(new Date(t))).filter((d) => d >= first && d <= today));
  const head = days.size === 0
    ? `Not opened in the last ${WINDOW_DAYS} days.`
    : `Opened on ${days.size} of the last ${WINDOW_DAYS} days.`;
  if (times.length === 0) return head;
  const last = new Date(Math.max(...times));
  return `${head} Last opened ${formatDayLabel(toISO(last), today)}, ${localClock(last)}.`;
}
