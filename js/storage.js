// storage.js — the ONLY file that touches localStorage.

// WHO MAY WRITE EACH SYNCED KEY. The three synced keys are protected by
// different invariants, and a writer added under the wrong one fails
// silently. sync.js and linkui.js write none of them: merged state reaches
// storage only through the injected applyState (app.js's applySyncedState).
// tests/sync.test.js enforces that half for both files.

// plaenicke.items — SOLE OWNERSHIP. Only app.js calls saveItems, and it saves
// from its module-scope `items` snapshot rather than re-reading storage, so
// any other writer in this tab is overwritten by app.js's next save. Another
// tab's write reaches the snapshot through app.js's storage listener.
export const STORAGE_KEY = 'plaenicke.items';
// plaenicke.feeds — READ IMMEDIATELY BEFORE WRITE. Several writers (feeds.js's
// removeFeed and applyRemoteFeeds, settings.js twice), each loading the list
// and saving it in one synchronous step. A writer that holds a list across
// an await, or keeps a snapshot and saves from it later, breaks this.
export const FEEDS_KEY = 'plaenicke.feeds';
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
      // DELIBERATE DEAD CODE IN V6 (spec § 3.4). Nothing creates an undated
      // record: an idea carries its capture date and makeItem still refuses a
      // falsy date. The tolerance ships anyway so that a future version can
      // adopt genuinely undated records with it already provably deployed on
      // BOTH devices, rather than gating a user-visible feature on a rollout
      // executed by hand across two devices.
      //
      // EXACTLY ONE extra value. undefined, numbers, objects and booleans are
      // still junk and must still be dropped — do not loosen this to
      // `it.date != null` or drop the check: a non-string date reaches
      // sortItemsByDate and every render site.
      (it.date === null || typeof it.date === 'string'))
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
  try {
    localStorage.setItem(STORAGE_KEY, serializeItems(items));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      throw new QuotaError('Items exceeded storage quota');
    }
    throw err;
  }
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

// Same quota translation as every other saver here: a raw QuotaExceededError
// reaches syncOnce's lastError under its DOMException name, which linkui.js
// has no label for, so a full device read "something went wrong".
export function saveFeeds(feeds) {
  try {
    localStorage.setItem(FEEDS_KEY, serializeFeeds(feeds));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      throw new QuotaError('Feeds exceeded storage quota');
    }
    throw err;
  }
}

// --- tombstones ---
// Deletions live here, NOT in plaenicke.items: a tombstone has no title/date,
// so deserializeItems would discard it on the next load and the deletion would
// be lost. See spec 5.6.

// plaenicke.syncTombstones — TWO KINDS OF WRITE, both synchronous.
// addTombstone (app.js's deleteItem, feeds.js's removeFeed) is a
// read-modify-write of one entry. app.js's applySyncedState is a FULL
// OVERWRITE, saveTombstones(written.tombstones), from a list it loaded at its
// own start; that is correct only because nothing between that load and the
// save awaits, and the one tombstone written in between (applyRemoteFeeds's
// removeFeed) is for a feed that written.tombstones already covers. Any
// asynchronous tombstone writer breaks the overwrite.
// Tombstones are NOT kept until every device has seen them: merge() drops any
// older than its 90-day TOMBSTONE_MAX_AGE_DAYS on every sync, so a device
// offline for longer can bring a deleted record back (spec § 12).
export const TOMBSTONES_KEY = 'plaenicke.syncTombstones';
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
  try {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(list));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      throw new QuotaError('Tombstones exceeded storage quota');
    }
    throw err;
  }
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

// --- sync credentials and sync state ---
// The link code contains the encryption key, so it is a secret: never log it
// and never render it outside the linking UI.
//
// syncState.version is recorded after each sync but read by nothing in the
// sync protocol: syncOnce PUTs against the version its own GET returned. Its
// projection in loadSyncState is hygiene, not a guard.

export const AUTH_KEY = 'plaenicke.auth';
export const SYNC_STATE_KEY = 'plaenicke.syncState';

export function loadAuth() {
  const v = localStorage.getItem(AUTH_KEY);
  return typeof v === 'string' && v ? v : null;
}

export function saveAuth(code) { localStorage.setItem(AUTH_KEY, code); }
export function clearAuth() { localStorage.removeItem(AUTH_KEY); }

// EXPORTED, and it is the ONLY copy. saveSyncState merges over the CURRENT
// persisted state (see below), so `saveSyncState({ ...ZERO_SYNC_STATE })` is a
// FULL reset only because this object happens to enumerate every field
// loadSyncState returns. auth.js used to keep a second, identical literal for
// exactly that purpose: adding a sixth field here would have left unlink() and
// resetSyncStateIfDeviceChanged() silently no longer clearing it, while still
// reading at both call sites as a full reset. There was never an import-cycle
// reason for the duplicate — auth.js already imports from this file.
//
// tests/auth.test.js asserts loadSyncState() deep-equals this object after
// unlink, so a field added here without being cleared, or without being added
// to loadSyncState's projection below, fails rather than drifting.
export const ZERO_SYNC_STATE = {
  version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false,
};

export function loadSyncState() {
  const json = localStorage.getItem(SYNC_STATE_KEY);
  if (!json) return { ...ZERO_SYNC_STATE };
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ...ZERO_SYNC_STATE };
  }
  if (!parsed || typeof parsed !== 'object') return { ...ZERO_SYNC_STATE };
  return {
    version: Number.isInteger(parsed.version) && parsed.version >= 0 ? parsed.version : 0,
    tokenHash: typeof parsed.tokenHash === 'string' ? parsed.tokenHash : null,
    lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null,
    lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
    // Fails CLOSED: ONLY an explicit false lifts the gate. A missing key, a
    // corrupt value, null, 0 — all read as still-pending, so nothing can let
    // the silent union through. Do NOT add `&& !== undefined`: a stored object
    // that omits the key would then read as lifted, which is the exact
    // fail-open this guard exists to prevent.
    adoptionPending: parsed.adoptionPending !== false,
  };
}

export function saveSyncState(s) {
  try {
    // Merges over the CURRENT persisted state, not over the zero state: a
    // caller doing a partial update (`{version, lastSyncedAt}` after a
    // routine sync) would otherwise silently reset adoptionPending to false
    // and lift the gate.
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ ...loadSyncState(), ...s }));
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') throw new QuotaError('Sync state exceeded storage quota');
    throw err;
  }
}

// --- launch log ---
// Timestamps of each time the app was opened or resumed on THIS device. Local
// only, never synced: it is the Phase 0 baseline for "is plaenicke actually
// being used?" (docs/superpowers/research/2026-09-23-plaenicke-ui-research.md).
// Capped so it can never grow into the quota the feed cache depends on.

const LAUNCHES_KEY = 'plaenicke.launches';
export const MAX_LAUNCHES = 500;

export function loadLaunches() {
  const json = localStorage.getItem(LAUNCHES_KEY);
  if (!json) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((t) => typeof t === 'string');
}

// On a full device the log gives up its OLDEST half and tries again, down to
// the new entry alone; only when even that does not fit is it a QuotaError. It
// is a convenience metric, and an open that cannot be recorded should not cost
// the room the feed cache and items need. Any other storage error propagates
// untouched.
export function recordLaunch(iso) {
  let next = [...loadLaunches(), iso].slice(-MAX_LAUNCHES);
  for (;;) {
    try {
      localStorage.setItem(LAUNCHES_KEY, JSON.stringify(next));
      return;
    } catch (err) {
      if (!(err && err.name === 'QuotaExceededError')) throw err;
      if (next.length <= 1) throw new QuotaError('Launch log exceeded storage quota');
      next = next.slice(Math.floor(next.length / 2));
    }
  }
}
