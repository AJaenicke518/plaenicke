// today.js — what the Today screen shows (home-screen spec § 2.3). Pure: no
// DOM, no storage, no clock of its own. app.js passes the items, the feed
// instances, today's date and the minute of the day in; js/todayview.js draws
// the result.

import { isScheduled, isTodoType } from './items.js';
import { addDays, minutesOf } from './timegrid.js';
import { formatDayLabel } from './freshness.js';
import { toISO } from './dateparse.js';

// Next 7 days is (today, today + NEXT_DAYS].
export const NEXT_DAYS = 7;
// "in N" is shown only within this many minutes of the next event's start
// (Alex, 2026-10-21: "relative time only within 12 hours of the next event").
export const RELATIVE_MAX_MIN = 12 * 60;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// Own items that are events on Today. 'general' is every pre-V6 record's type.
const EVENT_TYPES = new Set(['event', 'general']);
const DAY_MS = 24 * 60 * 60 * 1000;
const utcOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });

// sectionOf: the one section an OWN item belongs to on `todayISO`, or null.
// One answer per item is what makes "no item twice" true by construction.
//   'overdue' every to-do type (due, milestone, task, start) whose date has
//             passed and that is not done — no age limit (Alex, question 9) —
//             or that was ticked today: it stays, struck through, until
//             tomorrow (Alex, 2026-10-22; see tickedToday)
//   'todo'    every to-do type dated today, done or not: a ticked one stays,
//             struck through, until tomorrow (question 2)
//   'events'  an event or general item dated today
//   'next'    anything scheduled and not done, dated (today, today + 7]
// Never: ideas, done items outside today, past events (Alex: "i dont want
// past events included"), or a record with no readable date — '' sorts
// before every real date and would otherwise read as overdue.
export function sectionOf(item, todayISO) {
  if (!isScheduled(item)) return null;
  if (typeof item.date !== 'string' || !ISO_DAY.test(item.date)) return null;
  const done = item.done === true;
  if (item.date < todayISO) {
    if (!isTodoType(item)) return null;
    return !done || tickedToday(item, todayISO) ? 'overdue' : null;
  }
  if (item.date === todayISO) {
    if (isTodoType(item)) return 'todo';
    return EVENT_TYPES.has(item.type) ? 'events' : null;
  }
  return item.date <= addDays(todayISO, NEXT_DAYS) && !done ? 'next' : null;
}

// tickedToday: no item records when it was ticked, and the spec allows no new
// item field (§ 6). handleToggleDone bumps updatedAt on every tick, so a done
// item whose updatedAt is on today's LOCAL date was ticked today — or edited
// today after being ticked, which shows it struck for the rest of the day
// (the accepted cost). An unreadable updatedAt is no evidence: not today —
// an invalid Date's toISO is 'NaN-NaN-NaN', which no todayISO equals.
function tickedToday(item, todayISO) {
  return typeof item.updatedAt === 'string' && toISO(new Date(item.updatedAt)) === todayISO;
}

// daysBetween: whole calendar days from one 'YYYY-MM-DD' to another, counted
// on UTC midnights so a 23- or 25-hour DST day cannot change the answer.
// (Its parameters are not named fromISO/toISO: `toISO` is imported.)
export function daysBetween(fromDay, toDay) {
  return Math.round((utcOf(toDay) - utcOf(fromDay)) / DAY_MS);
}

// dayWord: how Today names a coming day — "Tomorrow", then the weekday
// ("Thu") up to a week out, then the date ("Thu, Oct 29").
export function dayWord(dateISO, todayISO) {
  const diff = daysBetween(todayISO, dateISO);
  if (diff === 1) return 'Tomorrow';
  if (diff >= 2 && diff <= NEXT_DAYS) return WEEKDAY.format(utcOf(dateISO));
  return formatDayLabel(dateISO, todayISO);
}

// relativeLabel: the next event's "in N" text at `nowMinutes` (minutes since
// local midnight), or null. "now" while it runs — for an event with no end,
// during its start minute only. Over 12 h away, or over: null.
export function relativeLabel(item, nowMinutes) {
  if (!item.time) return null;
  const start = minutesOf(item.time);
  const end = item.endTime ? minutesOf(item.endTime) : start + 1;
  if (nowMinutes >= start && nowMinutes < end) return 'now';
  const ahead = start - nowMinutes;
  if (ahead <= 0 || ahead > RELATIVE_MAX_MIN) return null;
  if (ahead < 60) return `in ${ahead} min`;
  const h = Math.floor(ahead / 60);
  const m = ahead % 60;
  return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
}

// isPastEvent: a timed event is over once its end has passed — with no end,
// once its start minute has. Untimed events are never greyed.
export function isPastEvent(item, nowMinutes) {
  if (!item.time) return false;
  const end = item.endTime ? minutesOf(item.endTime) : minutesOf(item.time) + 1;
  return nowMinutes >= end;
}
