import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeItems, deserializeItems, saveItems,
  serializeFeeds, deserializeFeeds, loadFeeds, saveFeeds,
  serializeFeedCache, deserializeFeedCache, loadFeedCache, saveFeedCache,
  loadTombstones, saveTombstones, addTombstone, pruneTombstones,
  QuotaError,
} from '../js/storage.js';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { loadAuth, saveAuth, clearAuth, loadSyncState, saveSyncState } from '../js/storage.js';

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

// --- V6 § 3.4: the null-date tolerance, shipped as DELIBERATE DEAD CODE -----
//
// V6 creates no undated records: an idea carries its capture date and
// makeItem still refuses a falsy date. This filter is relaxed anyway, so that a
// FUTURE version can adopt genuinely undated records with the tolerance
// already provably deployed on both devices — instead of gating a
// user-visible feature on a rollout a non-programmer has to execute correctly
// across two devices.
//
// Why it matters that this lands first: a device running code that DROPS the
// record is locally blind to it, and spec § 13 records the genuinely
// destructive path that follows (adoption, not ordinary sync).
test('deserializeItems tolerates a null date rather than silently dropping the record', () => {
  const undated = { ...ITEM, id: 'undated', date: null };
  const out = deserializeItems(JSON.stringify([ITEM, undated]));
  assert.deepEqual(out.map((i) => i.id), [ITEM.id, 'undated'],
    'a record with date: null must survive the load, not vanish from this device only');
  assert.equal(out[1].date, null, 'and it must survive AS null — not coerced to a string');
});

// The relaxation is exactly one extra value. Everything else is still junk and
// must still be dropped: a permissive `date != null` or a dropped check
// entirely would let a number or an object through into sortItemsByDate and
// every render site.
test('the relaxed date filter still rejects undefined, numbers, objects and arrays', () => {
  const bad = [
    { ...ITEM, id: 'missing' },
    { ...ITEM, id: 'undef', date: undefined },
    { ...ITEM, id: 'num', date: 20260820 },
    { ...ITEM, id: 'obj', date: { y: 2026 } },
    { ...ITEM, id: 'arr', date: ['2026-08-20'] },
    { ...ITEM, id: 'bool', date: true },
  ];
  delete bad[0].date;
  assert.deepEqual(deserializeItems(JSON.stringify(bad)).map((i) => i.id), [],
    'only a string or an explicit null is a date');
});

// --- V6 § 3.1: new fields ride through storage untouched --------------------
//
// deserializeItems filters, then maps each survivor to ITSELF — it does not
// rebuild from a whitelist (unlike makeItem). That is what lets `done` and
// `notes` survive a round trip through a device running pre-V6 code, and it is
// why the record shape could change without touching schemaVersion.
test('done and notes survive a storage round trip untouched', () => {
  const idea = {
    ...ITEM, id: 'idea1', type: 'idea', title: 'Rework the shelves.',
    notes: 'Rework the shelves. They are too deep for the mugs.', done: false,
  };
  const doneTask = { ...ITEM, id: 'task1', type: 'task', done: true, notes: null };
  const out = deserializeItems(serializeItems([idea, doneTask]));
  assert.deepEqual(out, [idea, doneTask]);
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

test('addTombstone keeps the newer deletedAt even when the newer one arrives first', () => {
  globalThis.localStorage = new FakeLocalStorage();
  addTombstone('a', 'item', '2026-08-02T00:00:00.000Z');
  addTombstone('a', 'item', '2026-08-01T00:00:00.000Z');
  const out = loadTombstones();
  assert.equal(out.length, 1);
  assert.equal(out[0].deletedAt, '2026-08-02T00:00:00.000Z');
});

test('pruneTombstones drops entries older than the window and keeps the rest', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');
  const list = [
    { id: 'old', kind: 'item', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', kind: 'item', deletedAt: '2026-07-30T00:00:00.000Z' },
  ];
  assert.deepEqual(pruneTombstones(list, now).map(t => t.id), ['new']);
});

test('pruneTombstones retains an entry whose deletedAt cannot be parsed', () => {
  const now = new Date('2026-08-01T00:00:00.000Z');
  const list = [{ id: 'corrupt', kind: 'item', deletedAt: 'not-a-date' }];
  assert.deepEqual(pruneTombstones(list, now).map(t => t.id), ['corrupt']);
});

// --- saveItems quota handling ---

test('saveItems throws QuotaError when storage is full', () => {
  globalThis.localStorage = new FakeLocalStorage();
  globalThis.localStorage.setItem = () => {
    const err = new Error('full');
    err.name = 'QuotaExceededError';
    throw err;
  };
  assert.throws(() => saveItems([ITEM]), QuotaError);
});

test('saveItems rethrows non-quota errors unchanged', () => {
  globalThis.localStorage = new FakeLocalStorage();
  globalThis.localStorage.setItem = () => { throw new Error('boom'); };
  assert.throws(() => saveItems([ITEM]), /boom/);
});

// --- saveTombstones quota handling ---

test('saveTombstones throws QuotaError on QuotaExceededError', () => {
  globalThis.localStorage = new QuotaExceedingLocalStorage();
  assert.throws(() => saveTombstones([{ id: 'a', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }]), QuotaError);
});

test('saveTombstones rethrows non-quota errors unchanged', () => {
  globalThis.localStorage = new FakeLocalStorage();
  globalThis.localStorage.setItem = () => { throw new Error('boom'); };
  assert.throws(() => saveTombstones([{ id: 'a', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }]), /boom/);
});

// --- auth and sync state ---

test('auth round-trips and clears', () => {
  installFakeLocalStorage();
  assert.equal(loadAuth(), null);
  saveAuth('abc');
  assert.equal(loadAuth(), 'abc');
  clearAuth();
  assert.equal(loadAuth(), null);
});

test('loadSyncState returns a zeroed state when nothing is stored', () => {
  installFakeLocalStorage();
  assert.deepEqual(loadSyncState(),
    { version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false });
});

test('syncState round-trips including adoptionPending', () => {
  installFakeLocalStorage();
  const s = { version: 7, tokenHash: 'h', lastSyncedAt: '2026-08-02T00:00:00.000Z', lastError: null, adoptionPending: true };
  saveSyncState(s);
  assert.deepEqual(loadSyncState(), s);
});

test('a corrupt or non-numeric syncState falls back to zero rather than throwing', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.syncState', '{{{');
  assert.equal(loadSyncState().version, 0);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 'seven' }));
  assert.equal(loadSyncState().version, 0);
  // -5 and 1.5 catch an implementation that accepts "any number" instead of
  // "non-negative integer"; null catches typeof-based checks that treat
  // typeof null === 'object' as already excluded but should still be tested.
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: -5 }));
  assert.equal(loadSyncState().version, 0);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1.5 }));
  assert.equal(loadSyncState().version, 0);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: null }));
  assert.equal(loadSyncState().version, 0);
});

// adoptionPending gates the first sync of a newly linked device. A corrupt
// value must fail CLOSED (pending) rather than open, or the union is applied
// and pushed before the user is asked.
test('a missing or non-boolean adoptionPending reads as false only when explicitly false', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1, adoptionPending: 'yes' }));
  assert.equal(loadSyncState().adoptionPending, true);
  // A stored object that OMITS the key entirely — e.g. a syncState written
  // before this field existed — must still gate as pending. This is the
  // scenario that fails open under `&& parsed.adoptionPending !== undefined`.
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1 }));
  assert.equal(loadSyncState().adoptionPending, true);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1, adoptionPending: null }));
  assert.equal(loadSyncState().adoptionPending, true);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1, adoptionPending: 0 }));
  assert.equal(loadSyncState().adoptionPending, true);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1, adoptionPending: {} }));
  assert.equal(loadSyncState().adoptionPending, true);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1, adoptionPending: 'no' }));
  assert.equal(loadSyncState().adoptionPending, true);
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 1, adoptionPending: false }));
  assert.equal(loadSyncState().adoptionPending, false);
});

// Dedicated reproduction of the exact scenario from review: a syncState
// written before adoptionPending existed must still gate the first sync,
// not silently lift the gate because the key is merely absent.
test('a stored syncState that predates the adoptionPending field still gates as pending (fail closed)', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.syncState', JSON.stringify({ version: 3, tokenHash: 'h' }));
  assert.equal(loadSyncState().adoptionPending, true);
});

test('saveSyncState converts a quota failure to QuotaError', () => {
  const ls = installFakeLocalStorage();
  ls.setItem = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
  assert.throws(() => saveSyncState({ version: 1 }), (e) => e.name === 'QuotaError');
});

// saveSyncState must merge over the CURRENT persisted state, not the zero
// state: a caller doing a routine partial update (e.g. {version, lastSyncedAt}
// after a sync) must not silently reset adoptionPending to false and lift
// the gate.
test('saveSyncState preserves adoptionPending on a partial update instead of resetting it to the zero default', () => {
  installFakeLocalStorage();
  saveSyncState({ version: 1, adoptionPending: true });
  saveSyncState({ version: 9 });
  assert.equal(loadSyncState().adoptionPending, true);
});

// Confirms the fix for the above does not break unlink()-style full resets:
// a caller supplying every field still gets exactly that object back.
test('saveSyncState with a complete object overwrites every field, including lifting adoptionPending', () => {
  installFakeLocalStorage();
  saveSyncState({ version: 1, tokenHash: 'h', lastSyncedAt: null, lastError: null, adoptionPending: true });
  saveSyncState({ version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false });
  assert.deepEqual(loadSyncState(),
    { version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false });
});

// --- launch log (Phase 0 baseline) ------------------------------------------
//
// Local-only and never synced: it answers "is this device's app actually being
// opened?", which is a per-device question.
import { recordLaunch, loadLaunches, MAX_LAUNCHES } from '../js/storage.js';

test('recordLaunch appends to the launch log, oldest first', () => {
  installFakeLocalStorage();
  recordLaunch('2026-09-22T08:00:00.000Z');
  recordLaunch('2026-09-23T08:00:00.000Z');
  assert.deepEqual(loadLaunches(), ['2026-09-22T08:00:00.000Z', '2026-09-23T08:00:00.000Z']);
});

test('the launch log keeps only the most recent MAX_LAUNCHES entries', () => {
  installFakeLocalStorage();
  for (let i = 0; i < MAX_LAUNCHES + 3; i += 1) recordLaunch(new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString());
  const log = loadLaunches();
  assert.equal(log.length, MAX_LAUNCHES);
  assert.equal(log[log.length - 1], new Date(Date.UTC(2026, 0, 1) + (MAX_LAUNCHES + 2) * 60000).toISOString());
});

test('a corrupt launch log reads as empty and non-string entries are dropped', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.launches', '{not json');
  assert.deepEqual(loadLaunches(), []);
  localStorage.setItem('plaenicke.launches', JSON.stringify(['2026-09-23T08:00:00.000Z', 7, null]));
  assert.deepEqual(loadLaunches(), ['2026-09-23T08:00:00.000Z']);
});

test('recordLaunch raises QuotaError on a full device, like every other writer', () => {
  installFakeLocalStorage();
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
  try {
    assert.throws(() => recordLaunch('2026-09-23T08:00:00.000Z'), QuotaError);
  } finally {
    localStorage.setItem = real;
  }
});

// Sweep S-8: JSON that parses to a non-array (an object here) is not a log.
test('a stored launch log of {} reads as []', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.launches', '{}');
  assert.deepEqual(loadLaunches(), []);
});

// Sweep D10: the launch log is a convenience metric. On a full device it gives
// up its OLDEST entries to make room, rather than failing to record the open.
// The fake quota here rejects any launch log longer than 40 entries.
test('recordLaunch on a full device trims the oldest entries and records the new one', () => {
  installFakeLocalStorage();
  const seeded = Array.from({ length: 100 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString());
  localStorage.setItem('plaenicke.launches', JSON.stringify(seeded));
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    if (k === 'plaenicke.launches' && JSON.parse(v).length > 40) {
      const e = new Error('full'); e.name = 'QuotaExceededError'; throw e;
    }
    return real(k, v);
  };
  try {
    recordLaunch('2026-09-23T08:00:00.000Z');
  } finally {
    localStorage.setItem = real;
  }
  const log = loadLaunches();
  assert.equal(log[log.length - 1], '2026-09-23T08:00:00.000Z', 'the new open is recorded');
  assert.ok(log.length > 0 && log.length <= 40, `trimmed to fit; got ${log.length}`);
  assert.deepEqual(log.slice(0, -1), seeded.slice(-(log.length - 1)), 'what is kept is the newest, in order');
});

// A failure that is not about space is not "fixed" by throwing entries away.
test('recordLaunch passes a non-quota storage error through without trimming', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.launches', JSON.stringify(['2026-09-22T08:00:00.000Z']));
  const real = localStorage.setItem.bind(localStorage);
  let calls = 0;
  localStorage.setItem = () => { calls += 1; const e = new Error('blocked'); e.name = 'SecurityError'; throw e; };
  try {
    assert.throws(() => recordLaunch('2026-09-23T08:00:00.000Z'), { name: 'SecurityError' });
  } finally {
    localStorage.setItem = real;
  }
  assert.equal(calls, 1);
  assert.deepEqual(loadLaunches(), ['2026-09-22T08:00:00.000Z']);
});
