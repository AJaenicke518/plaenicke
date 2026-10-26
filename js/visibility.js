// visibility.js — which feed series this device hides, and where (option A,
// Alex 2026-10-26).
//
// A series is (feedId, uid): the same uid in another calendar is another
// series. Each hidden series has an entry { calendar, list, title }:
//   calendar  false hides it from Day, the Week grid and Month
//   list      false hides it from Today's events, Next 7 days, Coming up, the
//             Week list and Today's "Next:" line (controller ruling 1)
//   title     what Settings names it by; an event title, never a feed URL
// An entry with both true is not stored.
//
// DEVICE-LOCAL, NEVER SYNCED. Nothing here writes plaenicke.feeds, items or
// tombstones, and nothing here schedules a sync (tests/visibility.test.js
// reads this file's source to keep it so). Whole-calendar hiding stays the
// feed record's own `hidden`, in Settings.
//
// This file is the ONLY writer of plaenicke.seriesVisibility, and the only
// place its entries are pruned: on each of its own writes it drops entries
// of calendars no longer in plaenicke.feeds (read, never written) and corrupt
// entries. removeFeed does not prune here; an orphan left by a removal is
// harmless (nothing renders it) until the next write here drops it.

import { readSeriesVisibility, writeSeriesVisibility, loadFeeds } from './storage.js';

const SURFACES = new Set(['calendar', 'list']);

function checkSurface(surface) {
  if (!SURFACES.has(surface)) throw new Error(`visibility: unknown surface ${surface}`);
}

// Keys are a feed id and a raw UID from a third-party ICS feed, so either can
// be "__proto__" or "constructor". Every read is own-property only and every
// write defines an own property: a plain `map[k] = v` with k "__proto__"
// would set a prototype (polluting Object.prototype from stored JSON, or
// silently storing nothing), and a plain read of "constructor" would find an
// inherited function.
const get = (obj, k) => (Object.hasOwn(obj, k) ? obj[k] : undefined);
function put(obj, k, v) {
  Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEntry = (e) => isObject(e)
  && typeof e.calendar === 'boolean' && typeof e.list === 'boolean' && typeof e.title === 'string';

// parseVisibility(json) -> { map, corrupt }. Pure. `map` holds only valid
// entries that hide something. Anything else under a feed or a uid is
// CORRUPT and reads as shown (controller ruling 2): a hide that cannot be
// read must never make an event vanish with no way to see why.
export function parseVisibility(json) {
  if (json === null || json === undefined || json === '') return { map: {}, corrupt: false };
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { map: {}, corrupt: true };
  }
  if (!isObject(parsed)) return { map: {}, corrupt: true };
  const map = {};
  let corrupt = false;
  for (const [feedId, series] of Object.entries(parsed)) {
    if (!isObject(series)) { corrupt = true; continue; }
    for (const [uid, e] of Object.entries(series)) {
      if (!isEntry(e)) { corrupt = true; continue; }
      if (e.calendar && e.list) continue;
      if (!get(map, feedId)) put(map, feedId, {});
      put(get(map, feedId), uid, { calendar: e.calendar, list: e.list, title: e.title });
    }
  }
  return { map, corrupt };
}

// Once per session (ruling 2): app.js loads on every render, and a corrupt
// entry would otherwise log on every tap.
let reportedCorrupt = false;

export function loadVisibility() {
  const { map, corrupt } = parseVisibility(readSeriesVisibility());
  if (corrupt && !reportedCorrupt) {
    reportedCorrupt = true;
    console.error('plaenicke: unreadable series-visibility entries are shown');
  }
  return map;
}

// isShown(map, item, surface): false only for a feed instance whose series
// this device hides on that surface. Own items always show.
export function isShown(map, item, surface) {
  checkSurface(surface);
  if (!item || item.external !== true) return true;
  const series = get(map, item.feedId);
  const e = series ? get(series, item.uid) : undefined;
  return e ? e[surface] : true;
}

export function filterBySurface(list, map, surface) {
  checkSurface(surface);
  return list.filter((it) => isShown(map, it, surface));
}

// canHideSeries: whether a sheet offers the switches. A guessed series
// (Canvas-shaped: one uid per meeting) gets none for now (controller ruling
// 3): a switch there would hide one meeting and look like it hid the class.
export function canHideSeries(item) {
  return !!item && item.external === true && item.guessedSeries !== true
    && typeof item.feedId === 'string' && item.feedId !== ''
    && typeof item.uid === 'string' && item.uid !== '';
}

function checkIds(feedId, uid) {
  if (typeof feedId !== 'string' || feedId === '') throw new Error('visibility: feedId required');
  if (typeof uid !== 'string' || uid === '') throw new Error('visibility: uid required');
}

// One synchronous read-modify-write: read, prune, change one series, write.
// Pruning drops calendars not in plaenicke.feeds and (by parsing) corrupt
// entries. A uid that has left its feed is KEPT: the cache can be emptied to
// free storage and refill later.
//
// The target calendar must be in plaenicke.feeds, or the write throws and
// nothing is stored: a hide written for a calendar removed meanwhile (a sync
// can remove one while its sheet is open) would be pruned by this very write,
// leaving a switch that says hidden over nothing stored. The same check keeps
// an unreadable plaenicke.feeds (loadFeeds() reads it as []) from pruning
// every hide on this device.
function update(feedId, change) {
  const { map } = parseVisibility(readSeriesVisibility());
  const live = new Set(loadFeeds().map((f) => f.id));
  if (!live.has(feedId)) throw new Error('visibility: that calendar is no longer linked on this device');
  for (const feedId of Object.keys(map)) if (!live.has(feedId)) delete map[feedId];
  change(map);
  for (const feedId of Object.keys(map)) if (Object.keys(map[feedId]).length === 0) delete map[feedId];
  writeSeriesVisibility(map);
  return map;
}

// setSeriesVisibility({ feedId, uid, title }, surface, shown) -> the new map.
// Throws on a bad argument (nothing written) and QuotaError on a full device.
export function setSeriesVisibility({ feedId, uid, title } = {}, surface, shown) {
  checkIds(feedId, uid);
  if (typeof title !== 'string') throw new Error('visibility: title required');
  checkSurface(surface);
  if (typeof shown !== 'boolean') throw new Error('visibility: shown must be a boolean');
  return update(feedId, (map) => {
    const prev = get(map, feedId) && get(get(map, feedId), uid);
    const next = { calendar: prev ? prev.calendar : true, list: prev ? prev.list : true, title };
    next[surface] = shown;
    if (next.calendar && next.list) {
      if (get(map, feedId)) delete map[feedId][uid];
      return;
    }
    if (!get(map, feedId)) put(map, feedId, {});
    put(get(map, feedId), uid, next);
  });
}

// showSeries(feedId, uid): Settings' Show — both surfaces back on at once.
export function showSeries(feedId, uid) {
  checkIds(feedId, uid);
  return update(feedId, (map) => { if (get(map, feedId)) delete map[feedId][uid]; });
}

// hiddenSeriesFor(map, feedId): Settings' rows for one calendar, by title.
export function hiddenSeriesFor(map, feedId) {
  const series = get(map, feedId) || {};
  return Object.entries(series)
    .map(([uid, e]) => ({ uid, title: e.title, calendar: e.calendar, list: e.list }))
    .sort((a, b) => a.title.localeCompare(b.title) || (a.uid < b.uid ? -1 : 1));
}
