import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, dedupeState, toWire, emptyState, SCHEMA_VERSION } from '../js/merge.js';

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
    feeds: [feed('f', '2026-08-01T00:00:00.000Z', { color: '#111', hidden: false })],
    tombstones: [{ id: 'y', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }, { id: 'x', kind: 'feed', deletedAt: '2026-08-01T00:00:00.000Z' }],
  });
  const b = state({
    items: [item('a', '2026-08-01T00:00:00.000Z'), item('z', '2026-08-01T00:00:00.000Z')],
    feeds: [feed('f', '2026-08-01T00:00:00.000Z', { color: '#999', hidden: true })],
    tombstones: [{ id: 'x', kind: 'feed', deletedAt: '2026-08-01T00:00:00.000Z' }, { id: 'y', kind: 'item', deletedAt: '2026-08-01T00:00:00.000Z' }],
  });
  assert.equal(JSON.stringify(toWire(a)), JSON.stringify(toWire(b)));
  assert.ok(!JSON.stringify(toWire(a)).includes('#111'), 'colour must not reach the wire');
  assert.ok(!('hidden' in toWire(a).feeds[0]), 'hidden must not reach the wire');
});

test('toWire is idempotent', () => {
  const w = toWire(state({ items: [item('a', '2026-08-01T00:00:00.000Z')] }));
  assert.deepEqual(toWire(w), w);
});

test('dedupeState collapses feeds sharing a normalised URL, keeping the newer', () => {
  const out = dedupeState(state({ feeds: [
    { ...feed('a', '2026-08-01T00:00:00.000Z'), url: 'https://cal.example/x.ics' },
    { ...feed('b', '2026-08-02T00:00:00.000Z'), url: 'HTTPS://Cal.Example/x.ics/' }] }));
  assert.equal(out.feeds.length, 1);
  assert.equal(out.feeds[0].id, 'b');
});

test('dedupeState collapses items sharing title, date and time', () => {
  const out = dedupeState(state({ items: [
    { ...item('a', '2026-08-01T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('b', '2026-08-02T00:00:00.000Z'), title: 'Dentist', date: '2026-08-05', time: '09:00' },
    { ...item('c', '2026-08-02T00:00:00.000Z'), title: 'Dentist', date: '2026-08-06', time: '09:00' }] }));
  assert.deepEqual(out.items.map(i => i.id).sort(), ['b', 'c']);
});

// Deterministic tie-breaking: without it two devices with different array
// order keep different survivors and the id flaps between them forever.
test('dedupeState breaks an updatedAt tie deterministically by id', () => {
  const same = '2026-08-01T00:00:00.000Z';
  const base = { title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: same };
  const forward = dedupeState(state({ items: [{ ...base, id: 'a' }, { ...base, id: 'b' }] }));
  const reverse = dedupeState(state({ items: [{ ...base, id: 'b' }, { ...base, id: 'a' }] }));
  assert.deepEqual(forward.items.map(i => i.id), reverse.items.map(i => i.id));
});

test('emptyState is a valid mergeable state', () => {
  assert.deepEqual(merge(emptyState(), emptyState(), NOW), emptyState());
});
