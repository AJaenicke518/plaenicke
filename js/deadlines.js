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
// How far ahead a deadline is looked for: from the start date to this many
// days past today (or past the start date, while that is still ahead), so
// tracking never silently stops importing a year after it was turned on.
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
export function deriveDeadlines(events, fromISO, todayISO) {
  const out = new Map();
  if (!Array.isArray(events)) return out;
  const singles = events.filter((ev) => !ev.rrule && !ev.recurrenceId && isTrackableTitle(ev.title));
  if (singles.length === 0) return out;
  const byUid = new Map(singles.map((ev) => [ev.uid, ev]));
  const anchor = fromISO > todayISO ? fromISO : todayISO;
  for (const inst of expandEvents(singles, fromISO, addDays(anchor, HORIZON_DAYS), DEADLINE_ZONE)) {
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

const isTracking = (f) => Boolean(f && f.trackDeadlines && typeof f.trackDeadlines.from === 'string');
const NO_DEADLINES = 'Brightspace returned no deadlines — none removed';
const OWNED_FIELDS = ['title', 'date', 'time'];

// planDeadlineImport: what app.js must write after a feed refresh (spec § 3.5,
// § 4). Never reads the clock, storage or the device zone.
export function planDeadlineImport({ feeds, prevCache, cache, items, tombstones, failedFeedIds, pendingIds, todayISO }) {
  const plan = { create: [], update: [], remove: [], held: [], note: null };
  const tracking = feeds.filter(isTracking);
  if (tracking.length === 0) return plan;

  const dead = new Set(tombstones.filter((t) => t.kind === 'item').map((t) => t.id));
  const byId = new Map(items.map((it) => [it.id, it]));
  const current = new Map();
  let allOk = true;
  let anyEvents = false;

  for (const feed of tracking) {
    const entry = cache[feed.id];
    if (!entry || !Array.isArray(entry.events) || entry.quotaDropped || failedFeedIds.has(feed.id)) {
      allOk = false;
      continue;
    }
    if (entry.events.length > 0) anyEvents = true;
    const prevEntry = prevCache[feed.id];
    const prev = prevEntry && Array.isArray(prevEntry.events) && !prevEntry.quotaDropped
      ? deriveDeadlines(prevEntry.events, feed.trackDeadlines.from, todayISO)
      : new Map();
    for (const [id, d] of deriveDeadlines(entry.events, feed.trackDeadlines.from, todayISO)) {
      if (current.has(id)) continue;
      current.set(id, d);
      if (pendingIds.has(id) || dead.has(id)) continue;
      const item = byId.get(id);
      if (!item) {
        plan.create.push({ id, title: d.title, date: d.date, time: d.time });
        continue;
      }
      const was = prev.get(id);
      if (!was) continue; // no record of Brightspace's last value: leave the item alone
      const patch = {};
      for (const k of OWNED_FIELDS) if (was[k] !== d[k] && item[k] !== d[k]) patch[k] = d[k];
      if ('time' in patch && item.endTime) patch.endTime = null;
      if (Object.keys(patch).length > 0) plan.update.push({ id, patch });
    }
  }

  const missing = items
    .filter((it) => it.id.startsWith(DEADLINE_ID_PREFIX) && !current.has(it.id) && !pendingIds.has(it.id)
      && typeof it.date === 'string' && it.date >= todayISO)
    .map((it) => it.id);
  if (missing.length === 0 || !allOk) return plan;
  if (!anyEvents || current.size === 0) {
    plan.note = NO_DEADLINES;
    return plan;
  }
  if (missing.length > MAX_AUTO_REMOVALS) {
    plan.held = missing;
    plan.note = `${missing.length} deadlines disappeared from Brightspace — not removed`;
    return plan;
  }
  plan.remove = missing;
  return plan;
}

export function trackedCopyIds(items, tombstones) {
  const ids = new Set();
  for (const it of items) if (it.id.startsWith(DEADLINE_ID_PREFIX)) ids.add(it.id);
  for (const t of tombstones) if (t.kind === 'item' && t.id.startsWith(DEADLINE_ID_PREFIX)) ids.add(t.id);
  return ids;
}

export function hideTrackedCopies(instances, feeds, hiddenIds) {
  const trackingIds = new Set(feeds.filter(isTracking).map((f) => f.id));
  if (trackingIds.size === 0) return instances;
  return instances.filter((inst) => !(trackingIds.has(inst.feedId) && hiddenIds.has(DEADLINE_ID_PREFIX + inst.uid)));
}
