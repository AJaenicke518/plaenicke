import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeItems, deserializeItems,
  serializeFeeds, deserializeFeeds, loadFeeds, saveFeeds,
  serializeFeedCache, deserializeFeedCache, loadFeedCache, saveFeedCache,
  loadTombstones, saveTombstones, addTombstone, pruneTombstones,
  QuotaError,
} from '../js/storage.js';

const ITEM = { id: 'a', title: 'Bio', date: '2026-07-02', createdAt: '2026-07-01', updatedAt: '2026-07-01' };

class FakeLocalStorage {
  constructor() { this.store = new Map(); }
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; }
  setItem(key, value) { this.store.set(key, String(value)); }
  removeItem(key) { this.store.delete(key); }
  clear() { this.store.clear(); }
}

class QuotaExceedingLocalStorage {
  getItem() { return null; }
  setItem() {
    const err = new Error('quota exceeded');
    err.name = 'QuotaExceededError';
    throw err;
  }
}

const FEED = {
  id: 'f1', url: 'https://example.com/cal.ics', name: 'Work', color: '#ff0000', hidden: false,
  updatedAt: '2026-07-01T00:00:00.000Z',
};
const CACHE_ENTRY = { fetchedAt: '2026-07-28T00:00:00.000Z', events: [{ id: 'e1' }], skipped: [] };

test('serialize then deserialize round-trips', () => {
  assert.deepEqual(deserializeItems(serializeItems([ITEM])), [ITEM]);
});

test('deserialize returns [] for null', () => {
  assert.deepEqual(deserializeItems(null), []);
});

test('deserialize returns [] for corrupt JSON', () => {
  assert.deepEqual(deserializeItems('{not json'), []);
});

test('deserialize drops malformed entries', () => {
  const json = JSON.stringify([ITEM, { id: 5 }, { title: 'no id' }]);
  assert.deepEqual(deserializeItems(json), [ITEM]);
});

// --- feeds ---

test('feeds: serialize then deserialize round-trips', () => {
  assert.deepEqual(deserializeFeeds(serializeFeeds([FEED])), [FEED]);
});

test('feeds: deserialize returns [] for null', () => {
  assert.deepEqual(deserializeFeeds(null), []);
});

test('feeds: deserialize returns [] for corrupt JSON', () => {
  assert.deepEqual(deserializeFeeds('{not json'), []);
});

test('feeds: deserialize drops malformed entries', () => {
  const json = JSON.stringify([
    FEED,
    { id: 5, url: 'x', name: 'x', color: 'x', hidden: false },
    { id: 'f2', url: 'x', name: 'x', color: 'x', hidden: 'nope' },
    { id: 'f3', url: 'x', name: 'x' },
  ]);
  assert.deepEqual(deserializeFeeds(json), [FEED]);
});

test('feeds: loadFeeds/saveFeeds round-trip through localStorage', () => {
  globalThis.localStorage = new FakeLocalStorage();
  saveFeeds([FEED]);
  assert.deepEqual(loadFeeds(), [FEED]);
});

test('feeds: loadFeeds returns [] when nothing stored', () => {
  globalThis.localStorage = new FakeLocalStorage();
  assert.deepEqual(loadFeeds(), []);
});

test('feeds: saveFeeds propagates errors instead of swallowing them', () => {
  globalThis.localStorage = new QuotaExceedingLocalStorage();
  assert.throws(() => saveFeeds([FEED]), /quota exceeded/);
});

// --- feed cache ---

test('feed cache: serialize then deserialize round-trips', () => {
  const cache = { f1: CACHE_ENTRY };
  assert.deepEqual(deserializeFeedCache(serializeFeedCache(cache)), cache);
});

test('feed cache: deserialize returns {} for null', () => {
  assert.deepEqual(deserializeFeedCache(null), {});
});

test('feed cache: deserialize returns {} for corrupt JSON', () => {
  assert.deepEqual(deserializeFeedCache('{not json'), {});
});

test('feed cache: deserialize drops malformed entries', () => {
  const json = JSON.stringify({
    f1: CACHE_ENTRY,
    f2: { fetchedAt: 123, events: [], skipped: [] },
    f3: { fetchedAt: 'now', events: 'nope', skipped: [] },
    f4: { fetchedAt: 'now', events: [] },
  });
  assert.deepEqual(deserializeFeedCache(json), { f1: CACHE_ENTRY });
});

test('feed cache: entry for an unknown feed id is preserved (pruning is not storage\'s job)', () => {
  const json = JSON.stringify({ 'unknown-feed-id': CACHE_ENTRY });
  assert.deepEqual(deserializeFeedCache(json), { 'unknown-feed-id': CACHE_ENTRY });
});

test('feed cache: loadFeedCache/saveFeedCache round-trip through localStorage', () => {
  globalThis.localStorage = new FakeLocalStorage();
  const cache = { f1: CACHE_ENTRY };
  saveFeedCache(cache);
  assert.deepEqual(loadFeedCache(), cache);
});

test('feed cache: loadFeedCache returns {} when nothing stored', () => {
  globalThis.localStorage = new FakeLocalStorage();
  assert.deepEqual(loadFeedCache(), {});
});

test('feed cache: saveFeedCache throws QuotaError on QuotaExceededError', () => {
  globalThis.localStorage = new QuotaExceedingLocalStorage();
  assert.throws(() => saveFeedCache({ f1: CACHE_ENTRY }), QuotaError);
});

test('deserializeItems backfills updatedAt from createdAt', () => {
  const json = JSON.stringify([{ id: 'a', title: 'Bio', date: '2026-07-02', createdAt: '2026-07-01' }]);
  assert.equal(deserializeItems(json)[0].updatedAt, '2026-07-01');
});

test('deserializeItems preserves an existing updatedAt', () => {
  const json = JSON.stringify([
    { id: 'a', title: 'Bio', date: '2026-07-02', createdAt: '2026-07-01', updatedAt: '2026-07-05' },
  ]);
  assert.equal(deserializeItems(json)[0].updatedAt, '2026-07-05');
});

// FEED_LEGACY (distinct from the shared FEED fixture above, which already
// carries updatedAt) represents a pre-V5 feed record with no updatedAt field.
const FEED_LEGACY = { id: 'f1', url: 'https://x/c.ics', name: 'X', color: '#111', hidden: false };

test('deserializeFeeds backfills updatedAt to the epoch', () => {
  const out = deserializeFeeds(JSON.stringify([FEED_LEGACY]));
  assert.equal(out[0].updatedAt, '1970-01-01T00:00:00.000Z');
});

test('deserializeFeeds preserves an existing updatedAt', () => {
  const out = deserializeFeeds(JSON.stringify([{ ...FEED_LEGACY, updatedAt: '2026-08-01T00:00:00.000Z' }]));
  assert.equal(out[0].updatedAt, '2026-08-01T00:00:00.000Z');
});

test('deserializeFeeds still rejects records missing required fields', () => {
  assert.deepEqual(deserializeFeeds(JSON.stringify([{ id: 'f', url: 'u' }])), []);
});

// --- tombstones ---

test('tombstones round-trip', () => {
  globalThis.localStorage = new FakeLocalStorage();
  saveTombstones([{ id: 'a', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }]);
  assert.deepEqual(loadTombstones(), [{ id: 'a', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }]);
});

test('loadTombstones returns [] when unset or malformed', () => {
  globalThis.localStorage = new FakeLocalStorage();
  assert.deepEqual(loadTombstones(), []);
  globalThis.localStorage.setItem('plaenicke.syncTombstones', 'not json');
  assert.deepEqual(loadTombstones(), []);
});

test('addTombstone appends and de-duplicates by id+kind keeping the newer', () => {
  globalThis.localStorage = new FakeLocalStorage();
  addTombstone('a', 'item', '2026-08-01T00:00:00.000Z');
  addTombstone('b', 'feed', '2026-08-01T00:00:00.000Z');
  addTombstone('a', 'item', '2026-08-02T00:00:00.000Z');
  const out = loadTombstones();
  assert.equal(out.length, 2);
  assert.equal(out.find(t => t.id === 'a').deletedAt, '2026-08-02T00:00:00.000Z');
});

test('addTombstone treats the same id under a different kind as distinct', () => {
  globalThis.localStorage = new FakeLocalStorage();
  addTombstone('x', 'item', '2026-08-01T00:00:00.000Z');
  addTombstone('x', 'feed', '2026-08-01T00:00:00.000Z');
  assert.equal(loadTombstones().length, 2);
});

test('pruneTombstones drops entries older than the window and keeps the rest', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');
  const list = [
    { id: 'old', kind: 'item', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', kind: 'item', deletedAt: '2026-07-30T00:00:00.000Z' },
  ];
  assert.deepEqual(pruneTombstones(list, now).map(t => t.id), ['new']);
});
