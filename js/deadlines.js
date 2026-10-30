// deadlines.js — Brightspace deadlines as own Deadline items (spec:
// docs/superpowers/specs/2026-10-30-plaenicke-brightspace-deadlines-design.md).
//
// PURE: no storage, no DOM, no clock. app.js (the only writer of
// plaenicke.items) feeds it state and applies what it returns.

import { expandEvents } from './ics.js';
import { addDays } from './timegrid.js';

// Every device converts in LMU's zone (spec § 3.4), so two devices always
// derive the same date and time and never overwrite each other.
export const DEADLINE_ZONE = 'America/Los_Angeles';
export const DEADLINE_ID_PREFIX = 'bs-';
export const MAX_AUTO_REMOVALS = 3;
// How far past the start date a deadline is looked for.
const HORIZON_DAYS = 400;

const TRACKABLE = /(?:^|\s-\s|\s)(?:revisions\s+)?due\s*$/i;
const COURSE = /\(([A-Z]{2,5})-(\d{3,4}[A-Z]?)(?=[-/)\s])/;
const TRAILING_DUE = /\s*-\s*due\s*$/i;

export function isTrackableTitle(title) {
  return typeof title === 'string' && TRACKABLE.test(title.trim());
}

export function courseCode(location) {
  if (typeof location !== 'string') return null;
  const m = location.match(COURSE);
  return m ? `${m[1]} ${m[2]}` : null;
}

export function deadlineTitle(title, location) {
  const trimmed = title.trim();
  const base = trimmed.replace(TRAILING_DUE, '').trim() || trimmed;
  const code = courseCode(location);
  return code ? `${code} · ${base}` : base;
}

// deriveDeadlines: one feed's cached ParsedEvents -> Map of item id to the
// fields the import owns. Repeating events and overrides are never a single
// deadline. A multi-day instance contributes its first day only.
export function deriveDeadlines(events, fromISO) {
  const out = new Map();
  if (!Array.isArray(events)) return out;
  const singles = events.filter((ev) => !ev.rrule && !ev.recurrenceId && isTrackableTitle(ev.title));
  if (singles.length === 0) return out;
  const byUid = new Map(singles.map((ev) => [ev.uid, ev]));
  for (const inst of expandEvents(singles, fromISO, addDays(fromISO, HORIZON_DAYS), DEADLINE_ZONE)) {
    const id = DEADLINE_ID_PREFIX + inst.uid;
    if (out.has(id)) continue;
    out.set(id, {
      uid: inst.uid,
      title: deadlineTitle(inst.title, byUid.get(inst.uid).location ?? null),
      date: inst.date,
      time: inst.time,
    });
  }
  return out;
}
