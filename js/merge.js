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
// every tie for 90 seconds, silently.
//
// AN EDIT PATH NOW EXISTS, AND IT IS SIX FIELDS PLUS ONE BOOLEAN. The To-do
// checkbox (V6 § 5.1) rewrites `done`; the item sheet (edit-items spec) rewrites
// title, date, time, endTime, type and notes through app.js's editItem, which
// rebuilds the record with js/edit.js's applyEdit (makeItem underneath). NOTHING
// CHANGED HERE for either: not merge(), not the tombstone kinds, not
// schemaVersion. An edited record is an ordinary record with a newer
// updatedAt, so a device on pre-edit code receives it as one and deserializeItems
// and unionById pass it through whole. The consequences (edit-items spec § 5),
// each examined rather than assumed, and each accepted:
//
//   1. Every edit and every tick DOES bump updatedAt. It has to: unionById's
//      ties go to remote (`>=`, below), so a write that left updatedAt alone
//      would be silently REVERTED on the next sync. Self-reverting, not
//      self-correcting. The price is whole-record last-write-wins: edit an item
//      on A, tick or edit the same item on B before either syncs, and the later
//      write wins whole — A's change is lost, including fields B never touched.
//   2. Because writes bump updatedAt, applyTombstones can resurrect a deleted
//      record. It keeps anything whose updatedAt is at or after the deletion,
//      on the documented assumption that a later updatedAt means "re-created
//      after the deletion" — and with an edit path that assumption is false.
//      Delete an item on the laptop at 09:00, edit or tick it on the phone at
//      12:00 before either syncs, and it comes back on every device with the
//      phone's fields. Annoying and re-deletable, not lost data, and it is the
//      only horn of the two that converges at all.
//   3. Clock skew decides ties (above). User writes (edit, Undo, tick, delete
//      commit) are stamped strictly later than the record they replace
//      (js/edit.js's nextStamp), so a single write cannot lose to clock skew;
//      concurrent writes on two devices still can.
//   4. Only the latest action can be undone. A second toast commits the first
//      action at once, so its delete lands and its Undo is gone. An edit's Undo
//      is itself a new edit with a new updatedAt; it has no merge special case.
//   5. `deletedAt` IS WHEN THE DELETE COMMITS, not when the user tapped: the
//      tombstone is written when the 5 s Undo toast expires or the app is
//      backgrounded. If a sync brings another device's edit to the item inside
//      that window, the commit still deletes it, because the commit is later.
//   6. EDITS SEND ONLY THE CHANGED FIELDS. The sheet hands editItem the raw
//      diff, applied to the CURRENT record, so a field a sync changed while the
//      sheet was open is not written back over. This narrows (1) on the SAME
//      device only; across devices the whole record still travels and wins.
//
// tests/editsync.test.js pins 1, 2 (and its same-instant boundary), 5 and the
// undo case against merge()/toWire(), comparing field values, not id sets.
//
// Teaching applyTombstones to tell an edit from a re-creation was considered
// and rejected: it is a change to the most defect-prone function here, and the
// ledger records four occasions on this codebase where exactly that kind of
// fix introduced a worse defect than the one it cured.
//
// WHAT RE-OPENS ALL OF THIS. Per-record last-write-wins is tolerable while the
// same id is almost never rewritten on both devices inside one sync window.
// It stops being tolerable for a field edited concurrently OFTEN, or for
// content where last-write-wins throws away meaningful text (long notes edited
// on both devices, say). Either argues for per-field timestamps, which change
// what merge() means for a device on old code and so need a coordinated
// schemaVersion bump and new convergence coverage — not a patch to unionById.

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
//
// Exporting it also cost this function a precondition. merge() only ever fed
// it a list that mergeTombstones had already collapsed to one entry per
// (kind, id); linkui.js feeds it a RAW list straight off a server blob, which
// carries no such guarantee. So:
//   - the newest deletion for an id wins, never simply the last one in the
//     array. Last-wins counted ZERO deletions for a blob listing two
//     tombstones for one id newest-first, where merge() deletes the record —
//     a no-dialog wipe in linkui's classifier.
//   - a malformed list THROWS rather than reading as "nothing was deleted".
//     Coercing it would turn a corrupt blob into a silent no-dialog adoption,
//     which is the failure this module's other guards exist to prevent.
export function applyTombstones(records, tombstones, kind) {
  if (!Array.isArray(records)) throw new Error('applyTombstones needs a records array');
  if (!Array.isArray(tombstones)) throw new Error('applyTombstones needs a tombstones array');
  const dead = new Map();
  for (const t of tombstones) {
    if (t.kind !== kind) continue;
    const at = ts(t.deletedAt);
    const prior = dead.get(t.id);
    if (prior === undefined || at > prior) dead.set(t.id, at);
  }
  // A record whose updatedAt is at or after the deletion was re-created after
  // it and must survive.
  return records.filter(r => !(dead.has(r.id) && dead.get(r.id) > ts(r.updatedAt)));
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
  //
  // IDEAS ARE KEYED ON THEIR id, AND THEY STILL GO THROUGH collapse (V6 6.1).
  // An idea's `date` is its CAPTURE date, so two thoughts jotted on the same
  // day whose first sentences match share the whole of the ordinary key --
  // adoption would collapse them and write a REAL tombstone for the loser,
  // propagating that deletion to every device. Keying each idea on its own id
  // puts every one in its own group, so every one survives.
  //
  // DO NOT "SIMPLIFY" THIS BY EXCLUDING IDEAS FROM collapse. survivingItemIds
  // below is derived from collapse's OUTPUT, so a record filtered out of its
  // input is absent from that set and gets a tombstone written for it: the
  // exclusion tombstones EVERY idea on the account. Verified by execution --
  // it produced ZERO survivors and TWO tombstones where the bug itself
  // produced one survivor and one tombstone. The safety comes precisely from
  // the records still passing THROUGH collapse rather than around it.
  //
  // Both branches carry a leading KIND field so the two key shapes cannot
  // collide: without it an idea keyed on its id could meet a scheduled item
  // whose title happened to be that id.
  const items = collapse(state.items, i => (i.type === 'idea'
    ? `idea\u0001${i.id}`
    : `item\u0001${i.title}\u0001${i.date}\u0001${i.time || ''}`));
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
