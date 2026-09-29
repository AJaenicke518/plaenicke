import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, toWire, emptyState } from '../js/merge.js';
import { makeItem } from '../js/items.js';
import { applyEdit, snapshotOf } from '../js/edit.js';

// Edits on two devices, driven through merge()/toWire() the way
// tests/convergence.test.js does, with records built by applyEdit so they are
// exactly what app.js's editItem writes. These pin EXISTING behaviour (edit-
// items spec § 5); they passed on first run and were mutation-checked instead.
//
// Every assertion compares FIELD VALUES, not id sets. convergence.test.js
// compares ids only, so a merge that kept the right record ids but the wrong
// version of a record would pass it.

const NOW = new Date('2026-09-23T12:00:00.000Z');
const T0 = '2026-09-23T08:00:00.000Z';
const T1 = '2026-09-23T09:00:00.000Z';
const T2 = '2026-09-23T10:00:00.000Z';
const T3 = '2026-09-23T11:00:00.000Z';

function base(id = 'i1') {
  return makeItem(
    { title: 'Dentist', date: '2026-09-30', time: '09:00', endTime: '10:00', type: 'event', notes: 'bring the form' },
    { id, createdAt: T0, updatedAt: T0 },
  );
}

// One shared compare-and-swap row, two devices. sync(d) merges the server's
// blob into device d and pushes if the result differs — convergence.test.js's
// shape, minus feeds.
function world(initialItems) {
  const start = { ...emptyState(), items: initialItems };
  const w = {
    server: toWire(start),
    devices: [structuredClone(start), structuredClone(start)],
    sync(d) {
      const merged = merge(w.devices[d], w.server, NOW);
      w.devices[d] = merged;
      const wire = toWire(merged);
      if (JSON.stringify(wire) !== JSON.stringify(toWire(w.server))) {
        w.server = wire;
        return true;
      }
      return false;
    },
    quiesce() {
      for (let rounds = 0; ; rounds += 1) {
        const a = w.sync(0);
        const b = w.sync(1);
        if (!a && !b) return;
        assert.ok(rounds < 20, 'devices never reached a fixed point');
      }
    },
    item(d, id = 'i1') { return w.devices[d].items.find((i) => i.id === id); },
    replace(d, rec) {
      w.devices[d] = { ...w.devices[d], items: w.devices[d].items.map((i) => (i.id === rec.id ? rec : i)) };
    },
    tombstone(d, id, deletedAt) {
      w.devices[d] = {
        ...w.devices[d],
        items: w.devices[d].items.filter((i) => i.id !== id),
        tombstones: [...w.devices[d].tombstones, { id, kind: 'item', deletedAt }],
      };
    },
  };
  return w;
}

function assertSameEverywhere(w) {
  assert.deepEqual(toWire(w.devices[0]), toWire(w.devices[1]), 'the two devices diverged');
  assert.deepEqual(toWire(w.devices[0]), w.server, 'the devices agree but the server holds something else');
}

for (const [from, to] of [[0, 1], [1, 0]]) {
  test(`an edit on device ${from} reaches device ${to} field for field`, () => {
    const w = world([base()]);
    const edited = applyEdit(w.item(from), {
      title: 'Dentist (moved)', date: '2026-10-02', time: '14:00', endTime: '15:30', notes: 'new form',
    }, T1);
    w.replace(from, edited);
    w.sync(from);
    w.sync(to);
    assert.deepEqual(w.item(to), edited);
    assert.equal(w.item(to).title, 'Dentist (moved)');
    assert.equal(w.item(to).date, '2026-10-02');
    assert.equal(w.item(to).time, '14:00');
    assert.equal(w.item(to).endTime, '15:30');
    assert.equal(w.item(to).notes, 'new form');
    assert.equal(w.item(to).updatedAt, T1);
    w.quiesce();
    assertSameEverywhere(w);
  });
}

test('spec § 5.1: A edits at T1, B ticks done at T2 > T1 — both hold B\'s record, A\'s edit is lost', () => {
  const w = world([base()]);
  w.replace(0, applyEdit(w.item(0), { title: 'Edited on A', date: '2026-10-05' }, T1));
  // B's tick is setDone's write: done flipped, updatedAt bumped, nothing else.
  const ticked = { ...w.item(1), done: true, updatedAt: T2 };
  w.replace(1, ticked);
  w.sync(0);
  w.sync(1);
  w.quiesce();
  assertSameEverywhere(w);
  for (const d of [0, 1]) {
    assert.deepEqual(w.item(d), ticked, `device ${d} does not hold B's record`);
    assert.equal(w.item(d).done, true);
    assert.equal(w.item(d).title, 'Dentist');
    assert.notEqual(w.item(d).title, 'Edited on A');
    assert.equal(w.item(d).date, '2026-09-30');
  }
});

test('spec § 5.2: A deletes at T1, B edits at T2 > T1 — the item returns everywhere with B\'s fields', () => {
  const w = world([base()]);
  w.tombstone(0, 'i1', T1);
  const edited = applyEdit(w.item(1), { title: 'Edited on B', notes: 'still wanted' }, T2);
  w.replace(1, edited);
  w.sync(0);
  w.sync(1);
  w.quiesce();
  assertSameEverywhere(w);
  for (const d of [0, 1]) {
    assert.deepEqual(w.item(d), edited, `device ${d} does not hold B's edit`);
    assert.equal(w.item(d).title, 'Edited on B');
    assert.equal(w.item(d).notes, 'still wanted');
  }
  // The tombstone is still there; it simply does not outrank a later write.
  assert.deepEqual(w.server.tombstones, [{ id: 'i1', kind: 'item', deletedAt: T1 }]);
});

test('spec § 5.2 boundary: an edit stamped at the same instant as the delete survives', () => {
  const w = world([base()]);
  w.tombstone(0, 'i1', T1);
  const edited = applyEdit(w.item(1), { title: 'Same instant' }, T1);
  w.replace(1, edited);
  w.sync(0);
  w.sync(1);
  w.quiesce();
  assertSameEverywhere(w);
  for (const d of [0, 1]) assert.deepEqual(w.item(d), edited);
});

test('spec § 5.5: deletedAt is the commit time, so an edit synced in during the Undo window is still deleted', () => {
  const w = world([base()]);
  // B edits at T1 and pushes. A's user tapped Delete before T1, but the
  // tombstone is written when the toast commits, at T2.
  w.replace(1, applyEdit(w.item(1), { title: 'Edited on B' }, T1));
  w.sync(1);
  w.tombstone(0, 'i1', T2);
  w.sync(0);
  w.quiesce();
  assertSameEverywhere(w);
  for (const d of [0, 1]) assert.equal(w.item(d), undefined, `device ${d} still holds the item`);
});

test('the undo case: A edits, B syncs in between, A undoes — B converges to the undone values', () => {
  const original = base();
  const w = world([original]);
  const patch = { title: 'Temporary', date: '2026-10-09', time: null, endTime: null, notes: null };
  const edited = applyEdit(w.item(0), patch, T1);
  w.replace(0, edited);
  w.sync(0);
  w.sync(1);
  assert.deepEqual(w.item(1), edited, 'B never saw the edit, so this test would prove nothing');
  // editItem's Undo: a snapshot of the pre-edit values for the keys the edit
  // touched, re-applied as a new edit with a new updatedAt.
  const undone = applyEdit(w.item(0), snapshotOf(original, Object.keys(patch)), T2);
  w.replace(0, undone);
  w.sync(0);
  w.sync(1);
  w.quiesce();
  assertSameEverywhere(w);
  for (const d of [0, 1]) {
    const rec = w.item(d);
    assert.deepEqual(rec, { ...original, updatedAt: T2 }, `device ${d} did not converge to the undone values`);
    assert.equal(rec.title, 'Dentist');
    assert.equal(rec.date, '2026-09-30');
    assert.equal(rec.time, '09:00');
    assert.equal(rec.endTime, '10:00');
    assert.equal(rec.notes, 'bring the form');
  }
});

test('two devices editing the same item at the same instant converge on the first push (ties go to remote)', () => {
  const w = world([base()]);
  const onA = applyEdit(w.item(0), { title: 'A at T1' }, T1);
  const onB = applyEdit(w.item(1), { title: 'B at T1' }, T1);
  w.replace(0, onA);
  w.replace(1, onB);
  w.sync(0); // A pushes first
  w.quiesce();
  assertSameEverywhere(w);
  for (const d of [0, 1]) assert.deepEqual(w.item(d), onA);
  // A later write still beats both.
  const later = applyEdit(w.item(1), { title: 'B at T3' }, T3);
  w.replace(1, later);
  w.quiesce();
  assertSameEverywhere(w);
  for (const d of [0, 1]) assert.deepEqual(w.item(d), later);
});
