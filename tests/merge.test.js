import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, dedupeState, toWire, emptyState, applyTombstones, SCHEMA_VERSION } from '../js/merge.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const item = (id, updatedAt, extra = {}) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt, ...extra });
const feed = (id, updatedAt, extra = {}) => ({ id, url: `https://cal.example/${id}.ics`, name: `n-${id}`, color: '#111', hidden: false, updatedAt, ...extra });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });

test('a record present on only one side survives', () => {
  assert.deepEqual(merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }), state(), NOW).items.map(i => i.id), ['a']);
});

test('the higher updatedAt wins, in both directions', () => {
  const older = '2026-08-01T00:00:00.000Z', newer = '2026-08-02T00:00:00.000Z';
  assert.equal(merge(state({ items: [item('a', newer, { title: 'LOCAL' })] }),
                     state({ items: [item('a', older, { title: 'REMOTE' })] }), NOW).items[0].title, 'LOCAL');
  assert.equal(merge(state({ items: [item('a', older, { title: 'LOCAL' })] }),
                     state({ items: [item('a', newer, { title: 'REMOTE' })] }), NOW).items[0].title, 'REMOTE');
});

test('a tie goes to remote, which is what makes a re-push idempotent', () => {
  const same = '2026-08-01T00:00:00.000Z';
  assert.equal(merge(state({ items: [item('a', same, { title: 'LOCAL' })] }),
                     state({ items: [item('a', same, { title: 'REMOTE' })] }), NOW).items[0].title, 'REMOTE');
});

// DA-C1: an ordinary sync must NEVER collapse distinct records that happen to
// share a title, date and time. In an app with no edit UI, re-adding is how a
// user duplicates — and losing one is silent, permanent and cross-device.
test('merge keeps two DISTINCT items sharing title, date and time', () => {
  const out = merge(
    state({ items: [{ ...item('a', '2026-08-01T00:00:00.000Z'), title: 'Call mom', date: '2026-08-05', time: null }] }),
    state({ items: [{ ...item('b', '2026-08-01T00:00:00.000Z'), title: 'Call mom', date: '2026-08-05', time: null }] }),
    NOW);
  assert.deepEqual(out.items.map(i => i.id).sort(), ['a', 'b'],
    'merge must not dedupe — that is adoption-only behaviour');
});

test('a tombstone newer than the record removes it', () => {
  const out = merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.items, []);
  assert.equal(out.tombstones.length, 1);
});

test('a record re-created after its deletion is NOT removed', () => {
  const out = merge(state({ items: [item('a', '2026-08-03T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.items.map(i => i.id), ['a']);
});

// M4 boundary: a record re-created in the SAME millisecond as its deletion
// must survive. "at or after the deletion was re-created after it" (the code
// comment) means the comparison must be strictly >, not >=, or a legitimate
// same-instant re-add is silently swallowed.
test('a record re-created in the SAME millisecond as its tombstone is NOT removed', () => {
  const out = merge(state({ items: [item('a', '2026-08-02T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.items.map(i => i.id), ['a']);
});

// DA-M4: no test in the first draft used a feed tombstone, so deleting the
// feed branch entirely passed the whole suite — meaning an unsubscribe would
// never propagate and would resurrect from the other device forever.
test('a FEED tombstone removes the feed', () => {
  const out = merge(state({ feeds: [feed('f1', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'f1', kind: 'feed', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.feeds, [], 'an unsubscribe must propagate');
});

test('a re-subscribed feed survives its older tombstone', () => {
  const out = merge(state({ feeds: [feed('f1', '2026-08-03T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'f1', kind: 'feed', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.feeds.map(f => f.id), ['f1']);
});

test('an item tombstone does not delete a feed with the same id, and vice versa', () => {
  assert.deepEqual(merge(state({ feeds: [feed('a', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW).feeds.map(f => f.id), ['a']);
  assert.deepEqual(merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'feed', deletedAt: '2026-08-02T00:00:00.000Z' }] }), NOW).items.map(i => i.id), ['a']);
});

test('a tombstone suppresses a record BEFORE age-pruning can drop the tombstone', () => {
  const out = merge(state({ items: [item('a', '2020-01-01T00:00:00.000Z')] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2020-06-01T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.tombstones, []);
});

test('tombstones older than 90 days are pruned; newer ones are kept', () => {
  const out = merge(state(), state({ tombstones: [
    { id: 'old', kind: 'item', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', kind: 'item', deletedAt: '2026-07-30T00:00:00.000Z' }] }), NOW);
  assert.deepEqual(out.tombstones.map(t => t.id), ['new']);
});

test('the newer of two tombstones for the same record wins', () => {
  const out = merge(state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-07-01T00:00:00.000Z' }] }),
    state({ tombstones: [{ id: 'a', kind: 'item', deletedAt: '2026-07-20T00:00:00.000Z' }] }), NOW);
  assert.equal(out.tombstones.length, 1);
  assert.equal(out.tombstones[0].deletedAt, '2026-07-20T00:00:00.000Z');
});

test('local color and hidden survive a pull that changes the feed name', () => {
  const out = merge(state({ feeds: [feed('a', '2026-08-01T00:00:00.000Z', { color: '#abc', hidden: true, name: 'old' })] }),
    state({ feeds: [feed('a', '2026-08-02T00:00:00.000Z', { color: '#zzz', hidden: false, name: 'new' })] }), NOW);
  assert.equal(out.feeds[0].name, 'new');
  assert.equal(out.feeds[0].color, '#abc');
  assert.equal(out.feeds[0].hidden, true);
});

test('a first-seen feed arrives with color null for feeds.js to assign', () => {
  const out = merge(state(), state({ feeds: [feed('a', '2026-08-02T00:00:00.000Z', { color: '#zzz', hidden: true })] }), NOW);
  assert.equal(out.feeds[0].color, null);
  assert.equal(out.feeds[0].hidden, false);
});

test('a wire feed carrying no color at all is still handled', () => {
  const bare = { id: 'a', url: 'https://cal.example/a.ics', name: 'n', updatedAt: '2026-08-02T00:00:00.000Z' };
  assert.equal(merge(state(), state({ feeds: [bare] }), NOW).feeds[0].color, null);
});

test('an unknown schemaVersion is rejected rather than migrated', () => {
  assert.throws(() => merge(state(), { ...state(), schemaVersion: 99 }, NOW));
  assert.throws(() => merge({ ...state(), schemaVersion: 0 }, state(), NOW));
});

test('merge is idempotent — merging a result with its own remote changes nothing', () => {
  const once = merge(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }),
                     state({ items: [item('b', '2026-08-02T00:00:00.000Z')] }), NOW);
  assert.deepEqual(merge(once, state({ items: [item('b', '2026-08-02T00:00:00.000Z')] }), NOW), once);
});

// DA-C3: without a canonical projection, two devices each see the other's
// blob as "changed" — measured at 7 pushes in 8 syncs, forever.
test('toWire strips per-device fields and sorts, so two devices agree byte for byte', () => {
  const a = state({
    items: [item('z', '2026-08-01T00:00:00.000Z'), item('a', '2026-08-01T00:00:00.000Z')],
    // Two feeds in one order on this side, reversed on the other — feed ids
    // are per-device, so this is the one place order actually differs
    // between two real devices (review finding 4).
    feeds: [feed('f', '2026-08-01T00:00:00.000Z', { color: '#111', hidden: false }),
            feed('g', '2026-08-01T00:00:00.000Z', { color: '#222', hidden: false })],
    tombstones: [{ id: 'y', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }, { id: 'x', kind: 'feed', deletedAt: '2026-08-01T00:00:00.000Z' }],
  });
  const b = state({
    items: [item('a', '2026-08-01T00:00:00.000Z'), item('z', '2026-08-01T00:00:00.000Z')],
    feeds: [feed('g', '2026-08-01T00:00:00.000Z', { color: '#444', hidden: true }),
            feed('f', '2026-08-01T00:00:00.000Z', { color: '#999', hidden: true })],
    tombstones: [{ id: 'x', kind: 'feed', deletedAt: '2026-08-01T00:00:00.000Z' }, { id: 'y', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }],
  });
  assert.equal(JSON.stringify(toWire(a)), JSON.stringify(toWire(b)));
  assert.ok(!JSON.stringify(toWire(a)).includes('#111'), 'colour must not reach the wire');
  assert.ok(!('hidden' in toWire(a).feeds[0]), 'hidden must not reach the wire');
});

// EVERY ASSERTION ABOVE IS SYMMETRIC, NEGATIVE OR A FIXED POINT — none of
// them says a single content field reaches the wire, and the whole suite was
// satisfied by a toWire that shipped no content at all. This implementation
// passed 548/548:
//
//   items: [...state.items].map(({ title, date, time, ...r }) => r).sort(byId),
//   feeds: [...state.feeds].map(({ color, hidden, url, name, ...rest }) => rest).sort(byId),
//
// Every device would have received items with no title, date or time, and
// feeds with no URL — and a feed URL is never re-displayed anywhere in the
// app, so that loss is permanent. Stripping `date` alone, `time` alone, feed
// `name` alone or feed `url` alone each passed 548/548 too, because the
// existing checks compare toWire against ITSELF: `toWire(a) === toWire(b)` is
// satisfied by any stripping mutant, so are the two "colour must not reach the
// wire" negatives, so is idempotence, and so is linkui.test.js's
// deepEqual(pushed, toWire(pushed)).
//
// So: assert the projection EXACTLY, field by field, in both directions. An
// exact deepEqual is what makes this total — it fails on a field that
// disappears AND on a field that appears (a leak of a per-device preference is
// the same defect from the other side).
test('toWire carries every item field through untouched — the wire is the only copy the account has', () => {
  const full = {
    id: 'i1',
    title: 'Dentist',
    date: '2026-08-05',
    time: '09:00',
    endTime: '09:45',
    createdAt: '2026-08-01',
    updatedAt: '2026-08-01T00:00:00.000Z',
    type: 'appointment',
    project: 'Health',
    subject: 'Teeth',
    category: 'Personal',
  };
  const wired = toWire(state({ items: [full] }));
  assert.deepEqual(wired.items, [full],
    'an item must cross the wire exactly as stored — nothing about an item is per-device');
  // Named individually so a failure says WHICH field was dropped rather than
  // just "objects differ", and so the four fields the executed mutant removed
  // are each pinned by name.
  for (const key of ['id', 'title', 'date', 'time', 'endTime', 'updatedAt', 'type', 'project', 'subject', 'category']) {
    assert.ok(key in wired.items[0], `toWire dropped item.${key}`);
    assert.deepEqual(wired.items[0][key], full[key], `toWire altered item.${key}`);
  }
});

test('toWire carries every SYNCED feed field and drops exactly the two per-device ones', () => {
  const full = {
    id: 'f1',
    url: 'https://cal.example/secret-token/f1.ics',
    name: 'Work',
    updatedAt: '2026-08-01T00:00:00.000Z',
    color: '#abc',
    hidden: true,
  };
  const wired = toWire(state({ feeds: [full] }));
  assert.deepEqual(wired.feeds, [{
    id: 'f1', url: 'https://cal.example/secret-token/f1.ics', name: 'Work', updatedAt: '2026-08-01T00:00:00.000Z',
  }], 'url, name and updatedAt are the account\'s copy; color and hidden are this device\'s alone (spec 6.3)');
  for (const key of ['id', 'url', 'name', 'updatedAt']) {
    assert.ok(key in wired.feeds[0], `toWire dropped feed.${key}`);
    assert.equal(wired.feeds[0][key], full[key], `toWire altered feed.${key}`);
  }
  assert.ok(!('color' in wired.feeds[0]) && !('hidden' in wired.feeds[0]));
});

test('toWire carries every tombstone field — a tombstone missing kind or deletedAt deletes nothing', () => {
  const t = { id: 'x', kind: 'feed', deletedAt: '2026-08-01T00:00:00.000Z' };
  assert.deepEqual(toWire(state({ tombstones: [t] })).tombstones, [t]);
});

test('toWire is idempotent', () => {
  const w = toWire(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }));
  assert.deepEqual(toWire(w), w);
});

test('dedupeState collapses feeds sharing a normalised URL, keeping the newer', () => {
  const out = dedupeState(state({ feeds: [
    { ...feed('a', '2026-08-01T00:00:00.000Z'), url: 'https://cal.example/x.ics' },
    { ...feed('b', '2026-08-02T00:00:00.000Z'), url: 'HTTPS://Cal.Example/x.ics/' }] }), NOW);
  assert.equal(out.feeds.length, 1);
  assert.equal(out.feeds[0].id, 'b');
});

test('dedupeState collapses items sharing title, date and time', () => {
  const out = dedupeState(state({ items: [
    { ...item('a', '2026-08-01T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('b', '2026-08-02T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('c', '2026-08-02T00:00:00.000Z'), title: 'Dentist', date: '2026-08-06', time: '09:00' }] }), NOW);
  assert.deepEqual(out.items.map(i => i.id).sort(), ['b', 'c']);
});

// Deterministic tie-breaking: without it two devices with different array
// order keep different survivors and the id flaps between them forever.
test('dedupeState breaks an updatedAt tie deterministically by id', () => {
  const same = '2026-08-01T00:00:00.000Z';
  const base = { title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: same };
  const forward = dedupeState(state({ items: [{ ...base, id: 'a' }, { ...base, id: 'b' }] }), NOW);
  const reverse = dedupeState(state({ items: [{ ...base, id: 'b' }, { ...base, id: 'a' }] }), NOW);
  assert.deepEqual(forward.items.map(i => i.id), reverse.items.map(i => i.id));
});

// Review finding 1: collapse() silently drops the loser. Unless dedupeState
// writes a tombstone for it, a peer device that never ran adoption still
// holds the loser locally with no tombstone, and a local-only record with no
// tombstone always survives merge — so the peer's next sync brings it right
// back, and adoption never actually converges the two devices.
test('dedupeState tombstones the ids it drops, and does not tombstone the survivor', () => {
  const out = dedupeState(state({
    feeds: [
      { ...feed('f1', '2026-08-01T00:00:00.000Z'), url: 'https://cal.example/x.ics' },
      { ...feed('f2', '2026-08-02T00:00:00.000Z'), url: 'HTTPS://Cal.Example/x.ics/' }],
  }), NOW);
  assert.equal(out.feeds.map(f => f.id).length, 1);
  assert.equal(out.feeds[0].id, 'f2');
  assert.deepEqual(out.tombstones, [{ id: 'f1', kind: 'feed', deletedAt: NOW.toISOString() }]);
  // The survivor must not also be tombstoned — it kept a different id.
  assert.ok(!out.tombstones.some(t => t.id === 'f2'), 'the survivor must not be tombstoned');
});

// Review finding 1, round trip: device A adopts, collapsing f1/f2 (same URL)
// down to f2. Device B never ran adoption and still holds f1 with no
// tombstone of its own. B must merge A's result and NOT resurrect f1 — that
// is the entire point of adoption existing.
test('a peer device does not resurrect a feed dedupeState collapsed away', () => {
  const deviceB = state({ feeds: [feed('f1', '2026-08-01T00:00:00.000Z')] });
  const deviceAAdopted = dedupeState(state({
    feeds: [
      { ...feed('f1', '2026-08-01T00:00:00.000Z'), url: 'https://cal.example/x.ics' },
      { ...feed('f2', '2026-08-02T00:00:00.000Z'), url: 'https://cal.example/x.ics' }],
  }), NOW);
  const peerResult = merge(deviceB, deviceAAdopted, NOW);
  assert.deepEqual(peerResult.feeds.map(f => f.id), ['f2'], 'f1 must not come back');
});

// Review finding 2: `${i.time}` stringifies null -> "null" and undefined ->
// "undefined", so a legacy pre-V5 item with no time key at all, one with
// time: null and one with time: undefined would land in three different
// dedupe buckets instead of the one all-day bucket they represent.
test('dedupeState folds every spelling of all-day (missing, null, undefined) into one bucket', () => {
  const missingTime = { id: 'a', title: 'Dentist', date: '2026-08-05', updatedAt: '2026-08-01T00:00:00.000Z' };
  const nullTime = { id: 'b', title: 'Dentist', date: '2026-08-05', time: null, updatedAt: '2026-08-02T00:00:00.000Z' };
  const undefinedTime = { id: 'c', title: 'Dentist', date: '2026-08-05', time: undefined, updatedAt: '2026-08-03T00:00:00.000Z' };
  const out = dedupeState(state({ items: [missingTime, nullTime, undefinedTime] }), NOW);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].id, 'c');
});

// Review finding 3: the only existing multi-item dedupe test varies the
// DATE across its distinguishing item, so dropping time from the dedupe key
// entirely still passes. Two same-day appointments at different times must
// both survive, or adoption silently deletes one of them.
test('dedupeState keeps two items sharing title and date but differing only in time', () => {
  const out = dedupeState(state({ items: [
    { ...item('a', '2026-08-01T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('b', '2026-08-01T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '17:00' }] }), NOW);
  assert.deepEqual(out.items.map(i => i.id).sort(), ['a', 'b']);
});

test('emptyState is a valid mergeable state', () => {
  assert.deepEqual(merge(emptyState(), emptyState(), NOW), emptyState());
});

// --- applyTombstones is now a PUBLIC entry point (Task 8) -------------------
//
// linkui.js's chooseAdoption asks "how many of these records would that side's
// tombstones actually delete?" and reuses this function rather than copying
// the `deletedAt > updatedAt` rule. That gave it a caller which, unlike
// merge(), hands it a RAW un-merged tombstone list straight off a server blob
// — so the preconditions merge() used to guarantee no longer hold.

test('applyTombstones takes the NEWEST deletion for an id, not the last one in the array', () => {
  // mergeTombstones and storage.addTombstone both dedupe by (kind, id), so an
  // honest device never produces this — but a server blob is not required to
  // be honest, and last-wins here counts ZERO deletions where merge() deletes
  // the record: a no-dialog wipe in linkui's classifier.
  const records = [item('a', '2026-06-01T00:00:00.000Z')];
  const newestFirst = [
    { id: 'a', kind: 'item', deletedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'a', kind: 'item', deletedAt: '2026-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(applyTombstones(records, newestFirst, 'item'), [],
    'the newest deletion must win regardless of array order');
  assert.deepEqual(applyTombstones(records, [...newestFirst].reverse(), 'item'), [],
    'and the answer must not depend on that order');
});

test('applyTombstones still lets a record re-created after the newest deletion survive', () => {
  const records = [item('a', '2026-08-01T00:00:00.000Z')];
  const tombstones = [
    { id: 'a', kind: 'item', deletedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'a', kind: 'item', deletedAt: '2026-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(applyTombstones(records, tombstones, 'item').map(r => r.id), ['a']);
});

// Escalate, never degrade: coercing a malformed list to "no deletions" would
// turn a corrupt blob into a NO-DIALOG adoption in linkui's classifier —
// exactly the silent-loss shape this module's other guards exist to prevent.
test('applyTombstones refuses a malformed list instead of reading it as "nothing deleted"', () => {
  // The predicate must pin OUR error, not merely "something threw". Deleting
  // the tombstones guard entirely still throws — `for (const t of null)` gives
  // "TypeError: tombstones is not iterable", and V8 interpolates the parameter
  // name — so a bare /tombstone/i regex passes against the unguarded code.
  const ours = (re) => (err) => err.constructor === Error && re.test(err.message);
  const records = [item('a', '2026-08-01T00:00:00.000Z')];
  for (const bad of [null, undefined, {}, 'nope']) {
    assert.throws(() => applyTombstones(records, bad, 'item'), ours(/needs a tombstones array/));
  }
  for (const bad of [null, undefined, {}, 'nope']) {
    assert.throws(() => applyTombstones(bad, [], 'item'), ours(/needs a records array/));
  }
});

// A junk ELEMENT must not be skipped either: skipping reads as "this
// tombstone deletes nothing", which in linkui's classifier is the difference
// between a dialog and a silent adoption.
test('applyTombstones refuses a junk element rather than skipping it', () => {
  const records = [item('a', '2026-08-01T00:00:00.000Z')];
  assert.throws(() => applyTombstones(records, [null], 'item'));
  assert.throws(() => applyTombstones(records, [{ id: 'a', kind: 'item', deletedAt: 'x' }, undefined], 'item'));
});
