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
const isLive = (it) => Boolean(it) && typeof it.date === 'string';

// A cache entry written before LOCATION was parsed (spec § 3.2) has events
// with no `location` key at all (a parsed event without LOCATION has null).
// Its derived titles lack the course code, so it is not a refresh: recording
// those titles in the baseline would make the next real fetch look like a
// Brightspace title change and overwrite a title Alex renamed.
const isPreRelease = (entry) => entry.events.some((ev) => !ev || !('location' in ev));

const recordOf = (d) => ({ title: d.title, date: d.date, time: d.time });

// planDeadlineImport: what app.js must write after a feed refresh (spec § 3.5,
// § 4, amended 2026-10-31). Never reads the clock, storage or the device zone.
//
// `baseline` is THIS device's record of what it last imported, per tracking
// feed: { [feedId]: { fetchedAt, deadlines: { [id]: { title, date, time } } } }
// (plaenicke.deadlineBaseline, device-local). Every update and removal is
// judged against it, never against the feed cache, which only says what this
// device last fetched and can be older than what the other device imported:
//   - update: a field differs between the baseline record and the current
//     derived value (Brightspace changed it) AND the item differs. No baseline
//     record for the id -> no update.
//   - remove: the id is in this feed's baseline, absent from this feed's
//     current set, the feed was re-fetched since the baseline (fetchedAt
//     differs), and no other tracking feed lists it. An id this device never
//     imported is never removed by this device. Then the § 4 guards.
// `nextBaseline` is what app.js stores once the writes succeeded: per tracking
// feed that refreshed OK and was not degenerate, the current derived set plus
// the candidates not removed this round (held or blocked), so they stay
// candidates. Feeds that failed, were degenerate or are pre-release keep their
// old entry; feeds no longer tracking are dropped.
export function planDeadlineImport({ feeds, baseline, cache, items, tombstones, failedFeedIds, pendingIds, todayISO }) {
  const plan = { create: [], update: [], remove: [], held: [], note: null, nextBaseline: {} };
  const tracking = feeds.filter(isTracking);
  if (tracking.length === 0) return plan;

  const dead = new Set(tombstones.filter((t) => t.kind === 'item').map((t) => t.id));
  const byId = new Map(items.map((it) => [it.id, it]));
  const current = new Map();
  const ok = []; // { feed, entry, derived, degenerate, base }
  let allOk = true;
  // § 4.2, per feed: one feed that returned nothing trackable blocks every
  // removal this round, even when another tracking feed is healthy.
  let degenerate = false;

  for (const feed of tracking) {
    const entry = cache[feed.id];
    const base = baseline[feed.id];
    if (!entry || !Array.isArray(entry.events) || entry.quotaDropped || failedFeedIds.has(feed.id) || isPreRelease(entry)) {
      allOk = false;
      if (base) plan.nextBaseline[feed.id] = base;
      continue;
    }
    const derived = deriveDeadlines(entry.events, feed.trackDeadlines.from, todayISO);
    const feedDegenerate = entry.events.length === 0 || derived.size === 0;
    if (feedDegenerate) degenerate = true;
    ok.push({ feed, entry, derived, degenerate: feedDegenerate, base });
    const was = base ? base.deadlines : {};
    for (const [id, d] of derived) {
      if (current.has(id)) continue;
      current.set(id, d);
      if (pendingIds.has(id) || dead.has(id)) continue;
      const item = byId.get(id);
      if (!item) {
        plan.create.push({ id, title: d.title, date: d.date, time: d.time });
        continue;
      }
      const prev = was[id];
      if (!prev) continue; // this device has no record of Brightspace's last value: leave the item alone
      const patch = {};
      for (const k of OWNED_FIELDS) if (prev[k] !== d[k] && item[k] !== d[k]) patch[k] = d[k];
      if ('time' in patch && item.endTime) patch.endTime = null;
      if (Object.keys(patch).length > 0) plan.update.push({ id, patch });
    }
  }

  // Removal candidates, per feed: ids this device imported from it, gone from
  // its re-fetched copy and from every other tracking feed.
  const candidates = []; // { feedId, id }
  for (const { feed, entry, derived, base } of ok) {
    if (!base || entry.fetchedAt === base.fetchedAt) continue;
    for (const id of Object.keys(base.deadlines)) {
      if (derived.has(id) || current.has(id)) continue;
      candidates.push({ feedId: feed.id, id });
    }
  }
  // The § 4 guards that are about the item itself. An id whose item is gone
  // (deleted, or never here) has nothing left to remove and drops out.
  const live = candidates.filter(({ id }) => id.startsWith(DEADLINE_ID_PREFIX) && !dead.has(id) && isLive(byId.get(id)));
  const removable = live.filter(({ id }) => !pendingIds.has(id) && byId.get(id).date >= todayISO).map(({ id }) => id);
  const removableIds = [...new Set(removable)];

  if (removableIds.length > 0 && allOk) {
    if (degenerate) plan.note = NO_DEADLINES;
    else if (removableIds.length > MAX_AUTO_REMOVALS) {
      plan.held = removableIds;
      plan.note = `${removableIds.length} deadlines disappeared from Brightspace — not removed`;
    } else plan.remove = removableIds;
  }

  const removed = new Set(plan.remove);
  for (const { feed, entry, derived, degenerate: feedDegenerate, base } of ok) {
    if (feedDegenerate) {
      if (base) plan.nextBaseline[feed.id] = base;
      continue;
    }
    const deadlines = {};
    for (const [id, d] of derived) deadlines[id] = recordOf(d);
    if (base && entry.fetchedAt === base.fetchedAt) {
      // Not re-fetched: nothing was judged, so every earlier record stays.
      for (const [id, r] of Object.entries(base.deadlines)) if (!(id in deadlines)) deadlines[id] = r;
    } else {
      for (const { feedId, id } of live) {
        if (feedId === feed.id && !removed.has(id)) deadlines[id] = base.deadlines[id];
      }
    }
    plan.nextBaseline[feed.id] = { fetchedAt: entry.fetchedAt, deadlines };
  }
  return plan;
}

export function trackedCopyIds(items, tombstones) {
  const ids = new Set();
  for (const it of items) if (it.id.startsWith(DEADLINE_ID_PREFIX)) ids.add(it.id);
  for (const t of tombstones) if (t.kind === 'item' && t.id.startsWith(DEADLINE_ID_PREFIX)) ids.add(t.id);
  return ids;
}

// hideTrackedCopies: drop every feed instance whose bs-<uid> is a live
// Deadline item or an item tombstone — for EVERY feed, tracking or not (spec
// § 3.6, amended 2026-10-31). The items outlive "Stop tracking" and a removed
// and re-added calendar, so the feed's own copy must stay hidden then too.
export function hideTrackedCopies(instances, hiddenIds) {
  if (hiddenIds.size === 0) return instances;
  return instances.filter((inst) => !hiddenIds.has(DEADLINE_ID_PREFIX + inst.uid));
}
