// feeds.js — feed sync orchestration. The layer between storage.js (Task 1),
// ics.js (Tasks 2-4), and the Worker's /feed proxy (Task 5). Pure logic +
// orchestration only — no DOM access. All effects (network, wall-clock time)
// are injected via `fetchImpl`/`now` so every path here is testable without a
// real network or real Date.now().
//
// feeds.js is the SINGLE owner of cache pruning: nothing else prunes or
// deletes entries from plaenicke.feedCache. `removeFeed` is likewise the only
// sanctioned way to delete a feed — settings.js (Task 7) calls it rather than
// touching storage.js directly. `applyRemoteFeeds` is the sync-side mirror of
// that same rule: js/sync.js hands merged state to applyState(state, opts)
// and never writes storage itself (spec 5.5) — this file is what actually
// persists the feeds half of it.

import { WORKER_URL } from './config.js';
import { parseICS, expandEvents, parseDuration } from './ics.js';
import { nowISO } from './dateparse.js';
import {
  loadFeeds, saveFeeds, loadFeedCache, saveFeedCache, QuotaError, addTombstone,
} from './storage.js';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

// webcalToHttps: the client-side half of "accepts only https: URLs" (the
// Worker rejects everything else) — a pasted iCloud link is commonly
// `webcal://...`, which is https in every way that matters except the scheme
// label. Anything else (already https/http, or unparseable) passes through
// unchanged; the Worker's own validation is the source of truth for whether
// a URL is actually acceptable.
export function webcalToHttps(url) {
  if (typeof url !== 'string') return url;
  return /^webcal:\/\//i.test(url) ? `https://${url.slice('webcal://'.length)}` : url;
}

// inferName: cosmetic default-name inference from the feed URL's host, per
// the design doc's four known providers. All hosts are treated identically
// once fetched — this only decides what the "Add calendar" flow pre-fills.
export function inferName(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'Calendar';
  }
  if (hostname.includes('google.com')) return 'Google';
  if (hostname.includes('icloud.com')) return 'iCloud';
  if (hostname.includes('outlook')) return 'Outlook';
  if (hostname.includes('instructure.com')) return 'Canvas'; // Canvas LMS's vendor domain
  return 'Calendar';
}

// ---------------------------------------------------------------------------
// Quota recovery — prune, retry, drop (feeds.js's exclusive responsibility)
// ---------------------------------------------------------------------------

const QUOTA_PRUNE_PAST_DAYS = 30;
const QUOTA_PRUNE_FUTURE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

// pruneWindow: [today-30d, today+366d] as 'YYYY-MM-DD' strings, from the
// injected `now`. A rough day-level heuristic for storage triage — not the
// exact civil-date/timezone machinery ics.js uses for rendering, because this
// window only needs to be "close enough" to decide what to keep under
// storage pressure.
function pruneWindow(nowDate) {
  const start = new Date(nowDate.getTime() - QUOTA_PRUNE_PAST_DAYS * DAY_MS);
  const end = new Date(nowDate.getTime() + QUOTA_PRUNE_FUTURE_DAYS * DAY_MS);
  return { startISO: start.toISOString().slice(0, 10), endISO: end.toISOString().slice(0, 10) };
}

// dateOnlyISO: the nominal 'YYYY-MM-DD' an ICS DTSTART/DTEND-shaped raw value
// starts with, read directly off the value string (no zone resolution needed
// for a rough pruning decision — this is a storage-triage heuristic, not the
// exact civil-date machinery ics.js uses for rendering).
function dateOnlyISO(raw) {
  const m = raw ? /^(\d{4})(\d{2})(\d{2})/.exec(raw) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function addDaysToISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// eventRangeISO: a non-recurring event's own [start, end] as 'YYYY-MM-DD'
// strings, used to test range overlap against the prune window. End
// resolution mirrors ics.js's own DTEND > DURATION > neither order:
//   - DTEND present: its date (whichever form/zone it's in — the first 8
//     digits are enough for a day-level heuristic).
//   - else DURATION present: start + duration, rounded to whole days.
//   - else: an instant/untimed event with no declared length — end = start.
// A DTSTART that can't be parsed is treated as "unknown" (both start and end
// null) so the caller can choose to keep it rather than guess.
function eventRangeISO(ev) {
  const start = dateOnlyISO(ev && ev.dtstart && ev.dtstart.value);
  if (start === null) return { start: null, end: null };
  if (ev.dtend) {
    const end = dateOnlyISO(ev.dtend.value);
    if (end !== null) return { start, end };
  } else if (ev.duration) {
    try {
      const days = Math.round(parseDuration(ev.duration) / DAY_MS);
      return { start, end: addDaysToISO(start, days) };
    } catch {
      // malformed duration — fall through to the no-length case below
    }
  }
  return { start, end: start };
}

// ruleUntilISO: a recurring master's RRULE UNTIL value as 'YYYY-MM-DD', or
// null if the rule has no UNTIL (either genuinely unbounded, or COUNT-bounded
// — both cases are handled the same way by the caller: kept). Reading the raw
// RRULE text directly (rather than parseRRule) keeps this a cheap, tolerant
// heuristic — a malformed rule just falls back to "no UNTIL found" rather
// than throwing during quota recovery.
function ruleUntilISO(rruleText) {
  const m = /(?:^|;)UNTIL=(\d{8})/.exec(rruleText || '');
  return m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}` : null;
}

// keepForQuota: whether an event should survive quota-recovery pruning.
// Range-overlap, not DTSTART-alone — an event that *started* long ago but
// runs into or past the window (a multi-week span, an ongoing recurring
// series) is still relevant and must not be silently lost on this
// destructive last-resort path.
//   - Recurring masters: an unbounded rule (no UNTIL — including one bounded
//     only by COUNT, which isn't cheaply determinable here) is always kept;
//     a rule with UNTIL is kept unless UNTIL falls before the window even
//     starts (the series is provably over).
//   - Non-recurring: kept if its own [start, end] range overlaps
//     [windowStart, windowEnd] at all.
//   - Anything whose dates can't be read is kept rather than guessed away.
function keepForQuota(ev, windowStartISO, windowEndISO) {
  if (ev.rrule) {
    const until = ruleUntilISO(ev.rrule);
    return until === null || until >= windowStartISO;
  }
  const { start, end } = eventRangeISO(ev);
  if (start === null) return true;
  return end >= windowStartISO && start <= windowEndISO;
}

// pruneForQuota: drop cached events outside the window, across every feed in
// the cache (a quota failure is a whole-cache problem, not one feed's).
// Entries that actually lost events are flagged `quotaPruned: true` so
// feedStatus can surface what happened (the flag lives IN the persisted
// entry — feedStatus's only inputs are (feed, cacheEntry, now), so this is
// the only channel it has to learn about a prune that already happened).
function pruneForQuota(cache, nowDate) {
  const { startISO, endISO } = pruneWindow(nowDate);
  const out = {};
  for (const [feedId, entry] of Object.entries(cache)) {
    const kept = entry.events.filter((ev) => keepForQuota(ev, startISO, endISO));
    out[feedId] = kept.length === entry.events.length
      ? entry
      : { ...entry, events: kept, quotaPruned: true };
  }
  return out;
}

function entrySize(entry) {
  return JSON.stringify(entry).length;
}

// dropLargestFeed: last resort when pruning alone doesn't free enough space.
// "Drop" empties that feed's events (the actual bulk) rather than deleting
// the entry outright, and marks it `quotaDropped: true` — a full delete would
// leave feedStatus with nothing to read and no way to say why a feed that
// used to sync suddenly shows "not yet synced". Keeping a small marker entry
// preserves the ability to surface the real reason on the next render.
function dropLargestFeed(cache) {
  let largestId = null;
  let largestSize = -1;
  for (const [feedId, entry] of Object.entries(cache)) {
    const size = entrySize(entry);
    if (size > largestSize) { largestSize = size; largestId = feedId; }
  }
  if (largestId === null) return { cache, droppedFeedId: null };
  const next = { ...cache };
  const dropped = cache[largestId];
  next[largestId] = {
    fetchedAt: dropped.fetchedAt,
    events: [],
    skipped: dropped.skipped,
    quotaDropped: true,
  };
  return { cache: next, droppedFeedId: largestId };
}

// ---------------------------------------------------------------------------
// syncFeed
// ---------------------------------------------------------------------------

// syncFeed: fetch one feed through the Worker's /feed proxy, parse, and write
// its cache entry. Returns `{ok:true, skipped, ...}` on success or
// `{ok:false, error}` on failure. On failure the persisted cache is left
// completely untouched — the caller's last-good cached events keep rendering
// (offline-first, same posture as V1-V3).
//
// If the feed was removed from storage while this fetch was in flight, nothing
// is persisted and the result carries `removed: true` (still `ok`, because the
// fetch itself succeeded — there is simply no feed left to cache it for).
//
// On a QuotaError from storage.js: prune events outside the window across
// every cached feed and retry the save once; if that still overflows, drop
// the largest feed's cache and save again. Each outcome that actually
// happened is recorded in the persisted cache entry (`quotaPruned` /
// `quotaDropped`) so feedStatus can surface it later, independent of which
// feed triggered the recovery.
export async function syncFeed(feed, { fetchImpl, now = () => new Date(), manual = false } = {}) {
  const nowDate = now();
  const url = `${WORKER_URL}/feed?url=${encodeURIComponent(feed.url)}`;
  const headers = manual ? { 'Cache-Control': 'no-cache' } : {};

  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers });
  } catch {
    return { ok: false, error: 'unreachable' };
  }

  if (!res.ok) {
    let error = 'server';
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') error = body.error;
    } catch {
      // Worker's error responses are always JSON; an unparseable body here
      // means something is badly wrong upstream — fall back to 'server'.
    }
    return { ok: false, error };
  }

  let text;
  try {
    text = await res.text();
  } catch {
    return { ok: false, error: 'parse_error' };
  }

  let parsed;
  try {
    parsed = parseICS(text);
  } catch {
    // parseICS is total by construction for real feed data (every bad
    // VEVENT becomes a `skipped` entry, never a throw) — this only catches
    // a genuinely malformed top-level input, kept defensive rather than
    // assumed impossible.
    return { ok: false, error: 'parse_error' };
  }

  // Remove-during-sync guard. Nothing outside this function can serialize a
  // removal against an in-flight fetch: settings.js's per-row busy gate only
  // knows about its own manual sync, and app.js's background syncStale batch is
  // invisible to it. So the ownership check happens here, immediately before
  // the write — if the feed is no longer stored, the fetch result is dropped
  // rather than resurrecting a removed calendar as an orphaned cache entry.
  if (!loadFeeds().some((f) => f.id === feed.id)) {
    return { ok: true, skipped: parsed.skipped, removed: true };
  }

  const entry = { fetchedAt: nowDate.toISOString(), events: parsed.events, skipped: parsed.skipped };
  const existingCache = loadFeedCache();
  const candidateCache = { ...existingCache, [feed.id]: entry };

  try {
    saveFeedCache(candidateCache);
    return { ok: true, skipped: parsed.skipped };
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
  }

  const prunedCache = pruneForQuota(candidateCache, nowDate);
  try {
    saveFeedCache(prunedCache);
    return { ok: true, skipped: parsed.skipped, quotaPruned: true };
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
  }

  const { cache: droppedCache, droppedFeedId } = dropLargestFeed(prunedCache);
  try {
    saveFeedCache(droppedCache);
    return {
      ok: true, skipped: parsed.skipped, quotaDropped: true, droppedFeedId,
    };
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
    // Storage is still over quota even after dropping the largest feed's
    // events — an unrecoverable state within this call. Surface it rather
    // than pretending the sync worked; nothing further was persisted.
    return { ok: false, error: 'storage_full' };
  }
}

// ---------------------------------------------------------------------------
// syncStale
// ---------------------------------------------------------------------------

// syncStale: sync only feeds whose cache is older than maxAgeMin (default
// 30, per the design doc's app-load staleness threshold), or that have never
// been synced at all. `cache` is a snapshot used only to decide staleness —
// each stale feed's actual write goes through syncFeed, which reloads the
// persisted cache itself. Feeds are synced sequentially (not
// Promise.all'd): they share one localStorage cache key, and a
// read-modify-write race between concurrent syncFeed calls could silently
// drop one feed's write.
export async function syncStale(feeds, cache, {
  maxAgeMin = 30, fetchImpl, now = () => new Date(), manual = false,
} = {}) {
  const nowDate = now();
  const results = {};
  for (const feed of feeds) {
    const entry = cache[feed.id];
    let stale = true;
    if (entry) {
      const ageMin = (nowDate.getTime() - new Date(entry.fetchedAt).getTime()) / 60000;
      stale = ageMin > maxAgeMin;
    }
    if (!stale) continue;
    // eslint-disable-next-line no-await-in-loop
    results[feed.id] = await syncFeed(feed, { fetchImpl, now, manual });
  }
  return results;
}

// ---------------------------------------------------------------------------
// feedStatus
// ---------------------------------------------------------------------------

const ERROR_TEXT = {
  unreachable: "couldn't reach feed",
  forbidden: 'blocked by server',
  bad_url: 'invalid feed URL',
  too_many_redirects: 'too many redirects',
  upstream_unreachable: 'calendar server unreachable',
  upstream_error: 'calendar server error',
  feed_too_large: 'feed too large',
  not_an_ics_feed: 'not a calendar feed',
  parse_error: "couldn't read calendar data",
  storage_full: 'device storage full',
  server: 'sync failed',
  remove_failed: 'could not remove — try again',
};

function errorText(code) {
  return ERROR_TEXT[code] || 'sync failed';
}

function humanizeAgo(fetchedAtISO, nowDate) {
  const ms = nowDate.getTime() - new Date(fetchedAtISO).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// skipReasonText: friendly wording for a skip `reason` code. Every
// recurrence-related reason (see ics.js's UnsupportedRRule/SkipEvent reasons)
// collapses to "unsupported recurrence" per the design doc's own example
// wording; other structural failures get their own short phrase; anything
// unrecognized falls back rather than throwing.
function skipReasonText(reason) {
  if (reason === 'unknown_tz') return 'unknown timezone';
  if (reason === 'bad_date') return 'invalid date';
  if (reason === 'bad_duration') return 'invalid duration';
  if (reason === 'missing_uid') return 'missing UID';
  if (reason === 'missing_dtstart') return 'missing start date';
  if (reason === 'unterminated_vevent') return 'incomplete event';
  if (reason === 'bad_rrule' || (typeof reason === 'string' && reason.startsWith('unsupported_'))) {
    return 'unsupported recurrence';
  }
  return 'unsupported event';
}

// feedStatus: the display string for one feed's settings row. Reads only
// (feed, cacheEntry, now) — never "synced", always "fetched Xm ago" (the
// provider's own export can lag its UI, per the design doc). `cacheEntry` may
// carry an `error` field that is NOT part of the persisted shape (syncFeed
// never writes one — cache is untouched on failure); it's how a caller
// (Task 7's settings view) surfaces an in-flight sync's failure without
// pretending storage.js recorded it. `quotaPruned`/`quotaDropped`, in
// contrast, ARE persisted flags this module writes, so they survive re-render.
export function feedStatus(feed, cacheEntry, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);

  if (cacheEntry && cacheEntry.error) {
    return `error: ${errorText(cacheEntry.error)}`;
  }
  if (!cacheEntry) {
    return 'not yet synced';
  }

  const parts = [`fetched ${humanizeAgo(cacheEntry.fetchedAt, nowDate)}`];

  if (cacheEntry.quotaDropped) {
    parts.push('storage limit reached — events not cached, sync again to retry');
  } else if (cacheEntry.quotaPruned) {
    parts.push('older events removed to save storage space');
  }

  if (cacheEntry.skipped && cacheEntry.skipped.length > 0) {
    const first = cacheEntry.skipped[0];
    parts.push(`${cacheEntry.skipped.length} skipped: '${first.summary}' — ${skipReasonText(first.reason)}`);
  }

  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// instancesForRange
// ---------------------------------------------------------------------------

// compareInstances: same ordering as items.js's sortItemsByDate (date, time
// with untimed first, createdAt, title) so a merged ownItems ++
// instancesForRange(...) list sorts as one total order without external
// items reshuffling relative to each other on re-sync.
function compareInstances(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const at = a.time || null;
  const bt = b.time || null;
  if (at !== bt) {
    if (at === null) return -1;
    if (bt === null) return 1;
    return at < bt ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.title.localeCompare(b.title);
}

// instancesForRange: expand every visible feed's cached ParsedEvents into
// EventInstances for [start, end] in targetTz, stamped per the spec's
// EventInstance contract:
//   id        "<feedId>:<uid>:<date>:<time>" — stable, unique per instance
//   createdAt "<date>T<time or 00:00>"       — keeps sortItemsByDate total
//   feedId, feedColor, external: true
// `hidden` feeds are excluded entirely — their events never reach a view.
// A feed with no cache entry yet (never synced) or an entry a malformed
// expansion throws on is skipped rather than breaking the whole merge; one
// bad feed must not blank every other calendar.
export function instancesForRange(feeds, cache, start, end, targetTz) {
  const out = [];
  for (const feed of feeds) {
    if (feed.hidden) continue;
    const entry = cache[feed.id];
    if (!entry || !entry.events || entry.events.length === 0) continue;

    let expanded;
    try {
      expanded = expandEvents(entry.events, start, end, targetTz);
    } catch (err) {
      // Skipping keeps one bad feed from blanking every other calendar, but a
      // silent skip is indistinguishable from an empty calendar. Log the error
      // NAME only: a feed URL is a capability token and the feed object carries
      // it, so neither may ever reach the console.
      console.error(`instancesForRange: expansion failed (${err && err.name ? err.name : 'unknown'}) — feed skipped`);
      continue;
    }

    for (const inst of expanded) {
      out.push({
        id: `${feed.id}:${inst.uid}:${inst.date}:${inst.time}`,
        uid: inst.uid,
        title: inst.title,
        date: inst.date,
        time: inst.time,
        endTime: inst.endTime,
        createdAt: `${inst.date}T${inst.time || '00:00'}`,
        feedId: feed.id,
        feedColor: feed.color,
        external: true,
      });
    }
  }
  return out.sort(compareInstances);
}

// ---------------------------------------------------------------------------
// removeFeed
// ---------------------------------------------------------------------------

// removeFeed: deletes both the feed and its cache entry. The single
// sanctioned way to remove a feed — settings.js (Task 7) calls this rather
// than touching storage.js's feeds/cache directly, keeping feeds.js the sole
// owner of cache lifecycle.
export function removeFeed(id) {
  // Tombstone BEFORE the destructive writes: if addTombstone throws (quota
  // exhausted, or storage blocked as in Safari Private Browsing), the feed
  // is still present locally and nothing else has changed — that converges
  // to the user's intent (retry, or the feed just stays linked). The old
  // order (save first, tombstone second) let a tombstone-write failure
  // remove the feed locally with no tombstone to propagate — a silent,
  // self-reversing delete once sync ships.
  addTombstone(id, 'feed', nowISO());
  saveFeeds(loadFeeds().filter((f) => f.id !== id));
  const cache = loadFeedCache();
  if (Object.prototype.hasOwnProperty.call(cache, id)) {
    delete cache[id];
    saveFeedCache(cache);
  }
}

// ---------------------------------------------------------------------------
// applyRemoteFeeds
// ---------------------------------------------------------------------------

// This device's colour cycle for a feed with no local record of its own —
// the same 6-slot palette settings.js (Task 7) offers on Add. Duplicated
// rather than imported: settings.js already imports FROM feeds.js (syncFeed,
// feedStatus, removeFeed, ...), so importing the other way would be a cycle.
// Both lists must stay in lockstep with styles.css's --feed-palette-1..6.
const FEED_PALETTE = [
  'var(--feed-palette-1)', 'var(--feed-palette-2)', 'var(--feed-palette-3)',
  'var(--feed-palette-4)', 'var(--feed-palette-5)', 'var(--feed-palette-6)',
];

// applyRemoteFeeds: the feeds half of the "single writer" fix — js/sync.js
// hands merged state to applyState(state, opts) and never writes storage
// itself (spec 5.5); this IS that write, for plaenicke.feeds.
//
// - A local feed absent from `mergedFeeds` is gone remotely (another
//   device's removeFeed, or a tombstone this device already recorded) and is
//   deleted via removeFeed() here — never a raw saveFeeds(). A raw save
//   would orphan that feed's feedCache entry forever: never read again, but
//   still iterated and re-serialised by pruneForQuota on every future quota
//   recovery — a permanent leak on the most storage-constrained device.
// - color/hidden are device-local and never travel over the wire (spec 6.3;
//   see merge.js's pickFeed). A feed with no local counterpart may arrive
//   with color: null (pickFeed's own first-seen marker) or with no `color`
//   key at all (a raw wire-form feed — toWire strips it entirely). Testing
//   "is it a string", never "is it null", is what catches both shapes;
//   missing either and saving it anyway makes storage.js's deserializeFeeds
//   drop the feed on the very next load, destroying a subscription whose URL
//   nothing on screen can restore.
// - A feed already known locally keeps ITS color/hidden, full stop —
//   whatever arrived on the wire for those two fields is never trusted.
export function applyRemoteFeeds(mergedFeeds) {
  const localFeeds = loadFeeds();
  const localById = new Map(localFeeds.map((f) => [f.id, f]));
  const mergedIds = new Set(mergedFeeds.map((f) => f.id));

  const removed = localFeeds.filter((f) => !mergedIds.has(f.id)).map((f) => f.id);
  for (const id of removed) removeFeed(id);

  const added = [];
  let paletteIdx = localFeeds.length; // continue settings.js's own add-time cycle
  const next = mergedFeeds.map((feed) => {
    const local = localById.get(feed.id);
    if (local) return { ...feed, color: local.color, hidden: local.hidden };
    added.push(feed.id);
    const color = typeof feed.color === 'string'
      ? feed.color
      : FEED_PALETTE[paletteIdx % FEED_PALETTE.length];
    paletteIdx += 1;
    const hidden = typeof feed.hidden === 'boolean' ? feed.hidden : false;
    return { ...feed, color, hidden };
  });

  saveFeeds(next);
  return { added, removed };
}
