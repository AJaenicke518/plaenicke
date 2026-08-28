import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeItem, sortItemsByDate, isScheduled, isTodo, isIdea, sortIdeasNewestFirst,
} from '../js/items.js';

test('makeItem builds an item with type and tags, trims title', () => {
  const it = makeItem(
    { title: '  First draft  ', date: '2026-05-15', type: 'milestone',
      project: 'Physics paper', subject: 'Physics', category: 'School' },
    { id: 'a', createdAt: '2026-07-18' });
  // deepEqual, so this is also the pin on the FULL record shape (spec § 3.1):
  // a field added to makeItem's whitelist without being added here fails, and
  // a field silently dropped from it fails too.
  assert.deepEqual(it, {
    id: 'a', title: 'First draft', date: '2026-05-15', time: null, endTime: null,
    createdAt: '2026-07-18', updatedAt: '2026-07-18',
    type: 'milestone', project: 'Physics paper', subject: 'Physics', category: 'School',
    done: false, notes: null,
  });
});

test('makeItem defaults type to general and tags to null', () => {
  const it = makeItem({ title: 'Buy milk', date: '2026-05-15' }, { id: 'b', createdAt: '2026-07-18' });
  assert.equal(it.type, 'general');
  assert.equal(it.project, null);
  assert.equal(it.category, null);
});

test('makeItem rejects an empty title', () => {
  assert.throws(() => makeItem({ title: '  ', date: '2026-05-15' }, { id: 'c', createdAt: 'x' }),
    /Title is required/);
});

test('makeItem rejects a missing date', () => {
  assert.throws(() => makeItem({ title: 'x', date: '' }, { id: 'c', createdAt: 'x' }),
    /Date is required/);
});

test('sortItemsByDate orders soonest first without mutating input', () => {
  const input = [
    { id: '1', title: 'B', date: '2026-07-10', createdAt: 'x' },
    { id: '2', title: 'A', date: '2026-07-02', createdAt: 'x' },
  ];
  assert.deepEqual(sortItemsByDate(input).map(i => i.id), ['2', '1']);
  assert.equal(input[0].id, '1');
});

test('makeItem stores time and endTime, defaulting both to null', () => {
  const timed = makeItem({ title: 'Dentist', date: '2026-08-04', time: '14:00', endTime: '15:00' },
    { id: 'd', createdAt: 'x' });
  assert.equal(timed.time, '14:00');
  assert.equal(timed.endTime, '15:00');
  const plain = makeItem({ title: 'Buy milk', date: '2026-08-04' }, { id: 'e', createdAt: 'x' });
  assert.equal(plain.time, null);
  assert.equal(plain.endTime, null);
});

test('makeItem rejects malformed times', () => {
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '2pm' }, { id: 'f', createdAt: 'x' }),
    /Time must be HH:MM/);
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '14:00', endTime: '25:00' }, { id: 'g', createdAt: 'x' }),
    /End time must be HH:MM/);
});

test('makeItem rejects endTime without time, and end not after start', () => {
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', endTime: '15:00' }, { id: 'h', createdAt: 'x' }),
    /End time requires a start time/);
  assert.throws(() => makeItem({ title: 'x', date: '2026-08-04', time: '15:00', endTime: '15:00' }, { id: 'i', createdAt: 'x' }),
    /End time must be after start time/);
});

test('sortItemsByDate: same date puts untimed first, then timed by time', () => {
  const input = [
    { id: 't2', title: 'B', date: '2026-08-04', time: '15:00', endTime: null, createdAt: 'x' },
    { id: 't1', title: 'A', date: '2026-08-04', time: '09:00', endTime: null, createdAt: 'x' },
    { id: 'u1', title: 'C', date: '2026-08-04', createdAt: 'x' },
  ];
  assert.deepEqual(sortItemsByDate(input).map(i => i.id), ['u1', 't1', 't2']);
});

// --- sortItemsByDate: mixed own/external, order-independence -----------------
// Task 6's EventInstance contract always stamps createdAt (date + time-or-
// 00:00), so a merged own++external array is total under this comparator
// regardless of input order — the same permutation must always produce the
// same sorted output. A comparator hole (e.g. one branch not handling an
// external item's fields) would show up as different orderings for different
// permutations of the identical set.

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

test('sortItemsByDate: mixed own/external array sorts identically regardless of input order', () => {
  const own1 = { id: 'own1', title: 'Homework', date: '2026-08-04', time: null, endTime: null, createdAt: '2026-07-01T00:00' };
  const own2 = { id: 'own2', title: 'Chore', date: '2026-08-04', time: '10:00', endTime: null, createdAt: '2026-07-02T00:00' };
  const ext1 = {
    id: 'feedA:e1:2026-08-04:09:00', title: 'Standup', date: '2026-08-04', time: '09:00', endTime: '09:15',
    createdAt: '2026-08-04T09:00', feedId: 'feedA', feedColor: '#f00', external: true,
  };
  const ext2 = {
    id: 'feedA:e2:2026-08-03:null', title: 'All-day trip', date: '2026-08-03', time: null, endTime: null,
    createdAt: '2026-08-03T00:00', feedId: 'feedA', feedColor: '#f00', external: true,
  };
  const set = [own1, own2, ext1, ext2];

  const orderings = permutations(set).map((perm) => sortItemsByDate(perm).map((i) => i.id));
  const [first, ...rest] = orderings;
  for (const ordering of rest) assert.deepEqual(ordering, first);

  // And it's the expected order: date first, then untimed-before-timed, then time.
  assert.deepEqual(first, [ext2.id, own1.id, ext1.id, own2.id]);
});

test('makeItem defaults updatedAt to createdAt', () => {
  const it = makeItem({ title: 'x', date: '2026-05-15' }, { id: 'c', createdAt: '2026-07-18' });
  assert.equal(it.updatedAt, '2026-07-18');
});

test('makeItem honours an explicit updatedAt', () => {
  const it = makeItem({ title: 'x', date: '2026-05-15' },
    { id: 'd', createdAt: '2026-07-18', updatedAt: '2026-07-20' });
  assert.equal(it.updatedAt, '2026-07-20');
});

// Regression for the day-resolution updatedAt bug: app.js's item-construction
// path now passes a full-precision UTC instant (dateparse.js's nowISO()) as
// meta.updatedAt, not app.js's old createdAt fallback (a local YYYY-MM-DD
// date via toISO). makeItem must preserve that full precision verbatim
// rather than truncating it — a day-only updatedAt is what let a tombstone's
// deletedAt lose to a same-day edit's updatedAt and resurrect a deleted item.
test('makeItem preserves a full-precision UTC updatedAt distinct from a day-only createdAt', () => {
  const it = makeItem({ title: 'x', date: '2026-05-15' },
    { id: 'j', createdAt: '2026-08-01', updatedAt: '2026-08-01T22:05:00.000Z' });
  assert.equal(it.updatedAt, '2026-08-01T22:05:00.000Z');
  assert.match(it.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.notEqual(it.updatedAt, it.createdAt);
});

// =========================================================================
// V6 — makeItem is a WHITELIST REBUILDER (spec § 3.2)
// =========================================================================
//
// makeItem returns an object literal with a FIXED set of keys. It does not
// spread its input. Passing `notes` into the pre-V6 version returned a record
// with no notes at all — so an idea would have been created with its body text
// silently discarded, at the moment of creation, on every path. This is the
// defect the spec's third review pass found by executing the function; it had
// been through two passes of reading before that.

test('makeItem carries notes through — it rebuilds from a whitelist and would otherwise drop it', () => {
  const it = makeItem({ title: 'Idea label', date: '2026-08-20', type: 'idea', notes: 'the complete original text' },
    { id: 'n1', createdAt: '2026-08-20' });
  assert.equal(it.notes, 'the complete original text');
});

test('makeItem carries done through — the checkbox state must survive creation', () => {
  const on = makeItem({ title: 'x', date: '2026-08-20', type: 'task', done: true }, { id: 'd1', createdAt: 'x' });
  assert.equal(on.done, true);
  const off = makeItem({ title: 'x', date: '2026-08-20', type: 'task', done: false }, { id: 'd2', createdAt: 'x' });
  assert.equal(off.done, false);
});

test('makeItem defaults done to false and notes to null on a record that mentions neither', () => {
  const it = makeItem({ title: 'x', date: '2026-08-20' }, { id: 'd3', createdAt: 'x' });
  assert.equal(it.done, false, 'absent means not done — never undefined, which reads as "no such field"');
  assert.equal(it.notes, null);
});

// `done` is read everywhere as `it.done === true`, so anything non-boolean
// arriving from a hand-edited blob or a future Worker must land as false
// rather than as a truthy string.
test('makeItem coerces a non-boolean done to false and a non-string notes to null', () => {
  const it = makeItem({ title: 'x', date: '2026-08-20', done: 'yes', notes: 42 }, { id: 'd4', createdAt: 'x' });
  assert.equal(it.done, false);
  assert.equal(it.notes, null);
});

test('makeItem treats empty notes as null rather than storing an empty string', () => {
  const it = makeItem({ title: 'x', date: '2026-08-20', notes: '' }, { id: 'd5', createdAt: 'x' });
  assert.equal(it.notes, null);
});

// THE EMPTY-STRING DATE (spec § 3.4). '' passes `typeof x === 'string'`, is
// falsy, and is exactly what a cleared <input type="date"> yields
// (js/preview.js). V6 relaxes deserializeItems to tolerate a null date; the
// guard HERE must not be relaxed with it, or a cleared date box would create a
// record that renders as "null — …" and sorts nowhere.
test('makeItem still rejects an empty-string date, and a null one', () => {
  assert.throws(() => makeItem({ title: 'x', date: '' }, { id: 'e1', createdAt: 'x' }), /Date is required/);
  assert.throws(() => makeItem({ title: 'x', date: null }, { id: 'e2', createdAt: 'x' }), /Date is required/);
  assert.throws(() => makeItem({ title: 'x' }, { id: 'e3', createdAt: 'x' }), /Date is required/);
});

// =========================================================================
// V6 — the page predicates (spec § 3.3)
// =========================================================================
//
// The pages OVERLAP by design: a dated to-do appears on the calendar views AND
// on the To-do page. A completed to-do leaves the To-do page but stays on the
// calendar — it still happened that day.

test('isScheduled excludes ideas and nothing else', () => {
  for (const type of ['general', 'due', 'start', 'milestone', 'event', 'task']) {
    assert.equal(isScheduled({ type }), true, `${type} belongs on the calendar`);
  }
  assert.equal(isScheduled({ type: 'idea' }), false);
  assert.equal(isScheduled({}), true, 'a record with no type at all is a pre-V6 record and is scheduled');
  // External feed instances carry no `type` — they must never be filtered out
  // of the calendar views by this predicate.
  assert.equal(isScheduled({ external: true, feedId: 'f1' }), true);
});

test('isTodo covers exactly the four actionable types, and only while not done', () => {
  for (const type of ['due', 'start', 'milestone', 'task']) {
    assert.equal(isTodo({ type }), true, `${type} is actionable`);
    assert.equal(isTodo({ type, done: false }), true);
    assert.equal(isTodo({ type, done: true }), false, 'a completed to-do leaves the To-do page');
  }
  for (const type of ['general', 'event', 'idea']) {
    assert.equal(isTodo({ type }), false, `${type} is not a to-do`);
  }
  assert.equal(isTodo({}), false, 'a pre-V6 record with no type is not a to-do — birthdays are not chores');
});

// `done` is read as `=== true` everywhere: a truthy non-boolean must not
// silently complete a to-do, and a falsy non-boolean must not un-complete one.
test('isTodo reads done strictly — only an actual true removes an item', () => {
  assert.equal(isTodo({ type: 'task', done: 'no' }), true, "the string 'no' is truthy but is not done");
  assert.equal(isTodo({ type: 'task', done: 1 }), true);
  assert.equal(isTodo({ type: 'task', done: undefined }), true);
});

test('isIdea is exactly type === idea', () => {
  assert.equal(isIdea({ type: 'idea' }), true);
  for (const type of ['general', 'due', 'start', 'milestone', 'event', 'task']) {
    assert.equal(isIdea({ type }), false);
  }
  assert.equal(isIdea({}), false);
});

// isScheduled and isIdea must partition the space: `type` is the ONLY
// discriminator for unscheduled-ness (spec § 3.4), so anything not on the
// calendar has to be on the Ideas page and vice versa. If these ever drift, a
// record becomes invisible on every page at once.
test('isScheduled and isIdea are exact complements — no record can fall through both', () => {
  for (const type of ['general', 'due', 'start', 'milestone', 'event', 'task', 'idea', undefined, 'unknown-future']) {
    const it = { type };
    assert.notEqual(isScheduled(it), isIdea(it), `type=${type} must be on exactly one of the two surfaces`);
  }
});

// =========================================================================
// V6 — Ideas ordering
// =========================================================================
//
// An idea's `date` is its CAPTURE date, so "newest first" is the only ordering
// that means anything on that page. Deterministic to the last tie-break: the
// list must not reshuffle between renders.
test('sortIdeasNewestFirst is newest-first, deterministic, and does not mutate its input', () => {
  const idea = (id, createdAt) => ({ id, title: id, type: 'idea', createdAt, date: createdAt });
  const input = [idea('b', '2026-08-01'), idea('c', '2026-08-03'), idea('a', '2026-08-02')];
  assert.deepEqual(sortIdeasNewestFirst(input).map((i) => i.id), ['c', 'a', 'b']);
  assert.equal(input[0].id, 'b', 'the input array must not be reordered in place');

  // Same capture day: fall back to id so two renders agree.
  const tied = [idea('z', '2026-08-05'), idea('a', '2026-08-05'), idea('m', '2026-08-05')];
  assert.deepEqual(sortIdeasNewestFirst(tied).map((i) => i.id), ['a', 'm', 'z']);
  assert.deepEqual(sortIdeasNewestFirst([...tied].reverse()).map((i) => i.id), ['a', 'm', 'z'],
    'the answer must not depend on input order');
});
