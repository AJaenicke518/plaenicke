// storage.js — the ONLY file that touches localStorage.

const STORAGE_KEY = 'plaenicke.items';
const FEEDS_KEY = 'plaenicke.feeds';
const FEED_CACHE_KEY = 'plaenicke.feedCache';

export class QuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaError';
  }
}

export function serializeItems(items) {
  return JSON.stringify(items);
}

export function deserializeItems(json) {
  if (!json) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(it =>
      it &&
      typeof it.id === 'string' &&
      typeof it.title === 'string' &&
      typeof it.date === 'string')
    // Records written before V5 have no updatedAt. Backfill from createdAt so
    // conflict resolution has an input; see spec 5.1.
    .map(it => (typeof it.updatedAt === 'string'
      ? it
      : { ...it, updatedAt: typeof it.createdAt === 'string' ? it.createdAt : '1970-01-01T00:00:00.000Z' }));
}

export function loadItems() {
  return deserializeItems(localStorage.getItem(STORAGE_KEY));
}

export function saveItems(items) {
  localStorage.setItem(STORAGE_KEY, serializeItems(items));
}

// --- feeds ---

export function serializeFeeds(feeds) {
  return JSON.stringify(feeds);
}

export function deserializeFeeds(json) {
  if (!json) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(f =>
      f &&
      typeof f.id === 'string' &&
      typeof f.url === 'string' &&
      typeof f.name === 'string' &&
      typeof f.color === 'string' &&
      typeof f.hidden === 'boolean')
    // Pre-V5 feeds have no updatedAt. Backfill to the epoch so any genuine
    // post-link edit always wins; see spec 5.1.
    .map(f => (typeof f.updatedAt === 'string'
      ? f
      : { ...f, updatedAt: '1970-01-01T00:00:00.000Z' }));
}

export function loadFeeds() {
  return deserializeFeeds(localStorage.getItem(FEEDS_KEY));
}

export function saveFeeds(feeds) {
  localStorage.setItem(FEEDS_KEY, serializeFeeds(feeds));
}

// --- tombstones ---
// Deletions live here, NOT in plaenicke.items: a tombstone has no title/date,
// so deserializeItems would discard it on the next load and the deletion would
// be lost. Cleared only once a sync has acknowledged them. See spec 5.6.

const TOMBSTONES_KEY = 'plaenicke.syncTombstones';
const TOMBSTONE_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function loadTombstones() {
  const json = localStorage.getItem(TOMBSTONES_KEY);
  if (!json) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(t =>
    t &&
    typeof t.id === 'string' &&
    (t.kind === 'item' || t.kind === 'feed') &&
    typeof t.deletedAt === 'string');
}

export function saveTombstones(list) {
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(list));
}

export function addTombstone(id, kind, deletedAt) {
  const existing = loadTombstones();
  const prior = existing.find(t => t.id === id && t.kind === kind);
  if (prior && Date.parse(prior.deletedAt) > Date.parse(deletedAt)) {
    // Prior entry is newer than the incoming one — keep it.
    return;
  }
  const kept = existing.filter(t => !(t.id === id && t.kind === kind));
  kept.push({ id, kind, deletedAt });
  saveTombstones(kept);
}

export function pruneTombstones(list, now, maxAgeDays = TOMBSTONE_MAX_AGE_DAYS) {
  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  return list.filter(t => {
    const parsed = Date.parse(t.deletedAt);
    // An unparseable deletedAt must not cause a tombstone to be dropped:
    // losing it would let the deleted item resurrect on the next sync.
    if (Number.isNaN(parsed)) return true;
    return parsed >= cutoff;
  });
}

// --- feed cache ---
// Cache is an object keyed by feedId: { [feedId]: { fetchedAt, events, skipped } }.
// Pruning entries for feeds that no longer exist is feeds.js's job, not storage's.

export function serializeFeedCache(cache) {
  return JSON.stringify(cache);
}

export function deserializeFeedCache(json) {
  if (!json) return {};
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result = {};
  for (const [feedId, entry] of Object.entries(parsed)) {
    if (
      entry &&
      typeof entry.fetchedAt === 'string' &&
      Array.isArray(entry.events) &&
      Array.isArray(entry.skipped)
    ) {
      result[feedId] = entry;
    }
  }
  return result;
}

export function loadFeedCache() {
  return deserializeFeedCache(localStorage.getItem(FEED_CACHE_KEY));
}

export function saveFeedCache(cache) {
  try {
    localStorage.setItem(FEED_CACHE_KEY, serializeFeedCache(cache));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      throw new QuotaError('Feed cache exceeded storage quota');
    }
    throw err;
  }
}
