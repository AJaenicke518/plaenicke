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
  return parsed.filter(it =>
    it &&
    typeof it.id === 'string' &&
    typeof it.title === 'string' &&
    typeof it.date === 'string');
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
  return parsed.filter(f =>
    f &&
    typeof f.id === 'string' &&
    typeof f.url === 'string' &&
    typeof f.name === 'string' &&
    typeof f.color === 'string' &&
    typeof f.hidden === 'boolean');
}

export function loadFeeds() {
  return deserializeFeeds(localStorage.getItem(FEEDS_KEY));
}

export function saveFeeds(feeds) {
  localStorage.setItem(FEEDS_KEY, serializeFeeds(feeds));
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
