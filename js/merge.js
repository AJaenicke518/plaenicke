// merge.js — the pure conflict-resolution function. No I/O, no crypto, no DOM,
// no imports. Everything arrives as arguments, which is what lets the
// convergence simulation drive it directly.
//
// Last-write-wins per record. Because merging is per record, edits to DIFFERENT
// records on two devices never conflict — the common case, and it is safe.
// Editing the SAME record on both while offline loses the older edit; spec 5.4
// explains why that trade is accepted.
//
// CLOCK SKEW IS THE WEAK JOINT. updatedAt is wall-clock time from two devices
// whose clocks are never compared. A phone 90 seconds ahead of a laptop wins
// every tie for 90 seconds, silently. This is tolerable ONLY because the app
// has no edit path today — app.js adds and deletes, nothing rewrites a record —
// so the same id is almost never written on both devices. Anyone adding an edit
// feature must revisit this before shipping it.

export const SCHEMA_VERSION = 1;

const TOMBSTONE_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [] };
}

function ts(s) {
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

function requireKnownVersion(state, side) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unrecognised schemaVersion on the ${side} state`);
  }
}

// Union by id. Ties go to remote so that re-pushing an identical record is a
// no-op — which is what makes the CAS retry loop safe to run repeatedly.
function unionById(localList, remoteList, pick) {
  const out = new Map();
  for (const rec of localList || []) if (rec && typeof rec.id === 'string') out.set(rec.id, rec);
  for (const rec of remoteList || []) {
    if (!rec || typeof rec.id !== 'string') continue;
    const mine = out.get(rec.id);
    if (!mine || ts(rec.updatedAt) >= ts(mine.updatedAt)) out.set(rec.id, pick ? pick(rec, mine) : rec);
  }
  return [...out.values()];
}

// color and hidden are per-device view preferences and never sync (spec 6.3).
// Keep local values for a feed we know; hand a first-seen feed to feeds.js with
// color null so it assigns from its own colour cycle. feeds.js MUST replace
// that null before saving — deserializeFeeds drops feeds whose color is not a
// string, which would silently destroy the subscription on the next load.
function pickFeed(remoteFeed, localFeed) {
  return localFeed
    ? { ...remoteFeed, color: localFeed.color, hidden: localFeed.hidden }
    : { ...remoteFeed, color: null, hidden: false };
}

function mergeTombstones(localList, remoteList) {
  const out = new Map();
  for (const t of [...(localList || []), ...(remoteList || [])]) {
    if (!t || typeof t.id !== 'string' || (t.kind !== 'item' && t.kind !== 'feed')) continue;
    const key = `${t.kind}:${t.id}`;
    const prior = out.get(key);
    if (!prior || ts(t.deletedAt) > ts(prior.deletedAt)) out.set(key, t);
  }
  return [...out.values()];
}

// EXPORTED so linkui.js can ask "how many of these records would this side's
// tombstones actually delete?" without re-implementing the `deletedAt >
// updatedAt` comparison. A second copy of that rule is a second place for it
// to drift — the ledger already records a near-miss of exactly that shape
// (mergeTombstones ties go LOCAL while unionById ties go REMOTE).
export function applyTombstones(records, tombstones, kind) {
  const dead = new Map();
  for (const t of tombstones || []) if (t && t.kind === kind) dead.set(t.id, ts(t.deletedAt));
  // A record whose updatedAt is at or after the deletion was re-created after
  // it and must survive.
  return (records || []).filter(r => !(dead.has(r.id) && dead.get(r.id) > ts(r.updatedAt)));
}

function prune(tombstones, now) {
  const cutoff = now.getTime() - TOMBSTONE_MAX_AGE_DAYS * DAY_MS;
  return tombstones.filter(t => {
    const parsed = Date.parse(t.deletedAt);
    // An unparseable deletedAt must never cause a drop: losing the tombstone
    // resurrects the record on the next sync.
    if (Number.isNaN(parsed)) return true;
    return parsed >= cutoff;
  });
}

export function merge(local, remote, now) {
  requireKnownVersion(local, 'local');
  requireKnownVersion(remote, 'remote');
  const tombstones = mergeTombstones(local.tombstones, remote.tombstones);
  // Suppress BEFORE pruning. Pruning first would drop an old tombstone and let
  // its record resurrect inside this same merge.
  return {
    schemaVersion: SCHEMA_VERSION,
    items: applyTombstones(unionById(local.items, remote.items), tombstones, 'item'),
    feeds: applyTombstones(unionById(local.feeds, remote.feeds, pickFeed), tombstones, 'feed'),
    tombstones: prune(tombstones, now),
  };
}

// --- the wire form ---
// The blob two devices compare and exchange must be identical for identical
// content, or each sees the other's push as a change and they push at each
// other forever. Sorting removes array-order drift; stripping color/hidden
// removes the per-device fields that are deliberately NOT synced.

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byTombstone = (a, b) => {
  const ka = `${a.kind}:${a.id}`, kb = `${b.kind}:${b.id}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

export function toWire(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    items: [...state.items].sort(byId),
    feeds: [...state.feeds].map(({ color, hidden, ...rest }) => rest).sort(byId),
    tombstones: [...state.tombstones].sort(byTombstone),
  };
}

// --- adoption only (spec 5.7) ---
// Feed ids are per device, so linking a laptop and a phone that subscribe to
// the same four calendars otherwise yields eight feeds — every event drawn
// twice, in two colours, in every view. This runs ONCE, at link time, on the
// user's explicit choice. Running it on an ordinary sync would silently delete
// any two records that happen to share a title, date and time.

function normalizeUrl(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

function collapse(records, keyOf) {
  const out = new Map();
  for (const rec of records) {
    const key = keyOf(rec);
    const prior = out.get(key);
    // Tie-break by id so two devices with different array order keep the SAME
    // survivor; otherwise the winning id flaps between them indefinitely.
    if (!prior || ts(rec.updatedAt) > ts(prior.updatedAt)
      || (ts(rec.updatedAt) === ts(prior.updatedAt) && rec.id < prior.id)) {
      out.set(key, rec);
    }
  }
  return [...out.values()];
}

export function dedupeState(state, now) {
  const feeds = collapse(state.feeds, f => normalizeUrl(f.url));
  // \u0001 is a field separator that cannot appear in a title, date or
  // time string, so a title ending in a substring of the next field can
  // never collide with a differently-split key. `time || ''` folds every
  // spelling of "all-day" -- a missing key on a pre-V5 record, an explicit
  // null, an explicit undefined -- into the same bucket. Without it,
  // `${i.time}` stringifies to the literal text "null" or "undefined",
  // splitting one all-day event into up to three ungatherable keys.
  const items = collapse(state.items, i => `${i.title}\u0001${i.date}\u0001${i.time || ''}`);
  // collapse() silently drops the loser of each group. Without a tombstone
  // for every dropped id, a peer device that never ran adoption (dedupeState
  // runs ONCE, at link time, on ONE device) still holds the loser locally
  // with no tombstone of its own -- and a local-only record with no
  // tombstone always survives merge, so the peer's next sync brings the
  // "collapsed" record right back. Writing tombstones here is what makes
  // the collapse actually propagate through the ordinary merge path, with
  // no special-casing needed at the call site.
  const survivingFeedIds = new Set(feeds.map(f => f.id));
  const survivingItemIds = new Set(items.map(i => i.id));
  const droppedTombstones = [
    ...state.feeds.filter(f => !survivingFeedIds.has(f.id))
      .map(f => ({ id: f.id, kind: 'feed', deletedAt: now.toISOString() })),
    ...state.items.filter(i => !survivingItemIds.has(i.id))
      .map(i => ({ id: i.id, kind: 'item', deletedAt: now.toISOString() })),
  ];
  return {
    ...state,
    feeds,
    items,
    tombstones: mergeTombstones(state.tombstones, droppedTombstones),
  };
}
