import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITABLE_FIELDS, applyEdit, diffPatch, snapshotOf, quickMoves, typeChangePatch, nextStamp,
} from '../js/edit.js';

// =========================================================================
// js/edit.js — the pure half of editing your own items (edit-items spec § 3.1)
// =========================================================================
//
// Every edit is rebuilt through makeItem, so these tests are mostly about what
// must SURVIVE that rebuild (identity, `done`, the smart-add metadata) and what
// must be REJECTED by it ('' dates, bad time ranges, empty titles).

const T0 = '2026-09-01T10:00:00.000Z';
const T1 = '2026-09-23T12:34:56.000Z';

function task(overrides = {}) {
  return {
    id: 'item-1',
    title: 'Hand in essay',
    date: '2026-09-25',
    time: '09:00',
    endTime: '10:00',
    createdAt: T0,
    updatedAt: T0,
    type: 'task',
    project: 'Thesis',
    subject: 'History',
    category: 'school',
    done: true,
    notes: 'old hidden notes',
    ...overrides,
  };
}

function idea(overrides = {}) {
  return task({
    title: 'Paint the fence',
    time: null,
    endTime: null,
    type: 'idea',
    project: null,
    subject: null,
    category: null,
    done: false,
    notes: null,
    ...overrides,
  });
}

const long = (n) => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');

// --- EDITABLE_FIELDS -------------------------------------------------------

test('EDITABLE_FIELDS is exactly the six fields the sheet can change', () => {
  assert.deepEqual(EDITABLE_FIELDS, ['title', 'date', 'time', 'endTime', 'type', 'notes']);
});

// --- applyEdit: what survives ----------------------------------------------

test('applyEdit preserves id, createdAt, done, project, subject and category', () => {
  const out = applyEdit(task(), { title: 'Hand in the essay' }, T1);
  assert.equal(out.id, 'item-1');
  assert.equal(out.createdAt, T0);
  assert.equal(out.done, true, 'a completed to-do must stay completed after a title edit');
  assert.equal(out.project, 'Thesis');
  assert.equal(out.subject, 'History');
  assert.equal(out.category, 'school');
  assert.equal(out.title, 'Hand in the essay');
});

test('applyEdit stamps updatedAt with the value passed in, not the record\'s', () => {
  const out = applyEdit(task(), { date: '2026-09-26' }, T1);
  assert.equal(out.updatedAt, T1,
    'unionById ties go to remote: an edit that keeps the old updatedAt is reverted by the next sync');
  assert.equal(out.date, '2026-09-26');
});

test('applyEdit ignores non-editable keys in the patch', () => {
  const out = applyEdit(task(), {
    id: 'hijack', createdAt: T1, updatedAt: '1999-01-01T00:00:00.000Z',
    done: false, project: 'Other', subject: 'Other', category: 'other', external: true,
    title: 'Renamed',
  }, T1);
  assert.equal(out.id, 'item-1');
  assert.equal(out.createdAt, T0);
  assert.equal(out.updatedAt, T1);
  assert.equal(out.done, true);
  assert.equal(out.project, 'Thesis');
  assert.equal(out.subject, 'History');
  assert.equal(out.category, 'school');
  assert.equal(out.title, 'Renamed');
  assert.equal('external' in out, false);
});

test('applyEdit does not mutate the record or the patch', () => {
  const record = task();
  const before = structuredClone(record);
  const patch = { title: 'Renamed', date: '2026-10-01', type: 'due' };
  const patchBefore = structuredClone(patch);
  applyEdit(record, patch, T1);
  assert.deepEqual(record, before);
  assert.deepEqual(patch, patchBefore);
});

// --- applyEdit: what makeItem rejects --------------------------------------

test('applyEdit rejects a cleared date box (\'\'), not only a missing date', () => {
  assert.throws(() => applyEdit(task(), { date: '' }, T1), /Date is required/);
});

test('applyEdit rejects an end time at or before the start', () => {
  assert.throws(() => applyEdit(task(), { endTime: '09:00' }, T1), /End time must be after start time/);
  assert.throws(() => applyEdit(task(), { endTime: '08:30' }, T1), /End time must be after start time/);
});

test('applyEdit rejects an empty title', () => {
  assert.throws(() => applyEdit(task(), { title: '   ' }, T1), /^Error: Title is required$/);
});

test('applyEdit rewords an empty idea as "The idea is empty."', () => {
  assert.throws(() => applyEdit(idea(), { title: '', notes: '' }, T1),
    (err) => err instanceof Error && err.message === 'The idea is empty.');
});

// --- applyEdit: ideas ------------------------------------------------------

test('applyEdit runs normalizeIdea: a long idea gets a derived title and keeps its full text', () => {
  const text = long(20);
  const out = applyEdit(idea(), { title: text, notes: text }, T1);
  assert.equal(out.title, long(15), 'the title is only a derived label');
  assert.equal(out.notes, text, 'notes must hold the COMPLETE text');
  assert.equal(out.type, 'idea');
});

test('applyEdit on a short idea keeps the text as the title with no notes', () => {
  const out = applyEdit(idea({ notes: long(20) }), { title: 'Short now', notes: 'Short now' }, T1);
  assert.equal(out.title, 'Short now');
  assert.equal(out.notes, null);
});

// --- diffPatch -------------------------------------------------------------

test('diffPatch returns only the editable keys whose values changed', () => {
  const opened = snapshotOf(task(), EDITABLE_FIELDS);
  const current = { ...opened, title: 'Renamed', time: '11:00', endTime: '12:00', done: false, project: 'X' };
  assert.deepEqual(diffPatch(opened, current), { title: 'Renamed', time: '11:00', endTime: '12:00' });
});

test('diffPatch returns {} when nothing changed', () => {
  const opened = snapshotOf(task(), EDITABLE_FIELDS);
  assert.deepEqual(diffPatch(opened, { ...opened }), {});
});

test('diffPatch treats null, undefined and \'\' as equal for non-date fields', () => {
  const opened = { title: 'A', date: '2026-09-25', time: null, endTime: null, type: 'task', notes: null };
  const current = { title: 'A', date: '2026-09-25', time: '', endTime: undefined, type: 'task', notes: '' };
  assert.deepEqual(diffPatch(opened, current), {});
});

test('diffPatch counts a cleared date (\'\') as a change so makeItem can reject it', () => {
  const opened = snapshotOf(task(), EDITABLE_FIELDS);
  assert.deepEqual(diffPatch(opened, { ...opened, date: '' }), { date: '' });
  // And the rejection it exists for actually happens downstream.
  assert.throws(() => applyEdit(task(), diffPatch(opened, { ...opened, date: '' }), T1), /Date is required/);
});

test('diffPatch reports a date cleared from null as a change too', () => {
  const opened = { title: 'A', date: null, time: null, endTime: null, type: 'task', notes: null };
  assert.deepEqual(diffPatch(opened, { ...opened, date: '' }), { date: '' });
});

// --- snapshotOf ------------------------------------------------------------

test('snapshotOf copies exactly the requested keys, including null values', () => {
  const snap = snapshotOf(task(), ['title', 'time', 'project']);
  assert.deepEqual(snap, { title: 'Hand in essay', time: '09:00', project: 'Thesis' });
  assert.deepEqual(snapshotOf(idea(), ['time', 'notes']), { time: null, notes: null });
});

test('snapshotOf returns a new object; changing it does not touch the record', () => {
  const record = task();
  const snap = snapshotOf(record, EDITABLE_FIELDS);
  snap.title = 'changed';
  assert.equal(record.title, 'Hand in essay');
});

// --- typeChangePatch -------------------------------------------------------

// Notes are a VISIBLE field on every item's sheet (plan rev 2 amendment), so
// switching to idea must never discard them: they ARE the idea's text. Only
// an item with no notes takes its text from the title.
test('typeChangePatch to idea keeps existing notes as the idea text and clears times', () => {
  const full = 'Full text of an earlier idea that must survive the switch back';
  const record = task({ title: 'Full text of an earlier', notes: full });
  const patch = typeChangePatch(record, { type: 'idea', title: 'Renamed label' });
  assert.match(patch.notes, /Full text of an earlier idea that must survive/, 'existing notes are never replaced by the title');
  assert.equal(patch.time, null);
  assert.equal(patch.endTime, null);
  const out = applyEdit(record, patch, T1);
  // A thought of 15 words or fewer is stored whole as the title with notes
  // null (js/ideas.js) — either way the complete text must survive.
  assert.match(out.notes ?? out.title, new RegExp(full), 'nothing the user wrote is lost');
});

test('typeChangePatch to idea uses notes edited in the same save', () => {
  const record = task({ notes: 'old' });
  const patch = typeChangePatch(record, { type: 'idea', notes: 'new words' });
  assert.match(patch.notes, /new words/);
  assert.doesNotMatch(patch.notes, /old/, 'notes replaced in the same save must not come back');
});

test('typeChangePatch to idea with no notes takes the typed title as the text', () => {
  const patch = typeChangePatch(task({ notes: null }), { type: 'idea', title: 'Build a boat' });
  assert.equal(patch.notes, 'Build a boat');
  const out = applyEdit(task({ notes: null }), patch, T1);
  assert.equal(out.title, 'Build a boat');
  assert.equal(out.notes, null);
});

test('typeChangePatch to idea with no title in the patch uses the record\'s title', () => {
  const patch = typeChangePatch(task({ notes: null }), { type: 'idea' });
  assert.equal(patch.notes, 'Hand in essay');
  assert.equal(patch.time, null);
  assert.equal(patch.endTime, null);
});

test('typeChangePatch from idea: a long idea gets a derived title and keeps the full notes', () => {
  const text = long(20);
  const record = idea({ title: long(15), notes: text });
  const patch = typeChangePatch(record, { type: 'task' });
  assert.deepEqual(patch, { type: 'task', title: long(15), notes: text });
  const out = applyEdit(record, patch, T1);
  assert.equal(out.type, 'task');
  assert.equal(out.title, long(15));
  assert.equal(out.notes, text);
});

test('typeChangePatch from idea prefers the patch\'s notes, then its title, then the record', () => {
  const record = idea({ title: 'Old', notes: null });
  assert.deepEqual(typeChangePatch(record, { type: 'due', notes: 'From notes', title: 'From title' }),
    { type: 'due', title: 'From notes', notes: null });
  assert.deepEqual(typeChangePatch(record, { type: 'due', title: 'From title' }),
    { type: 'due', title: 'From title', notes: null });
  assert.deepEqual(typeChangePatch(record, { type: 'due' }),
    { type: 'due', title: 'Old', notes: null });
});

test('typeChangePatch leaves the patch alone when the type does not cross the idea line', () => {
  const p1 = { type: 'due', title: 'X' };
  assert.equal(typeChangePatch(task(), p1), p1);
  const p2 = { title: 'Y' };
  assert.equal(typeChangePatch(idea(), p2), p2, 'no type in the patch is not a switch');
  const p3 = { type: 'idea', notes: 'Z' };
  assert.equal(typeChangePatch(idea(), p3), p3, 'idea -> idea is not a switch');
});

test('typeChangePatch does not mutate the patch or the record', () => {
  const record = task();
  const before = structuredClone(record);
  const patch = { type: 'idea' };
  typeChangePatch(record, patch);
  assert.deepEqual(patch, { type: 'idea' });
  assert.deepEqual(record, before);
});

// --- quickMoves ------------------------------------------------------------

test('quickMoves: Tomorrow is relative to today, +1 week to the item\'s date', () => {
  assert.deepEqual(quickMoves(task({ date: '2026-09-25' }), '2026-09-23'), [
    { label: 'Tomorrow', date: '2026-09-24' },
    { label: '+1 week', date: '2026-10-02' },
  ]);
});

test('quickMoves crosses month and year boundaries', () => {
  assert.deepEqual(quickMoves(task({ date: '2026-12-28' }), '2026-12-31'), [
    { label: 'Tomorrow', date: '2027-01-01' },
    { label: '+1 week', date: '2027-01-04' },
  ]);
  assert.deepEqual(quickMoves(task({ date: '2026-02-25' }), '2026-02-28'), [
    { label: 'Tomorrow', date: '2026-03-01' },
    { label: '+1 week', date: '2026-03-04' },
  ]);
});

// --- review of Task 1 (C1, I1, O1, O4) --------------------------------------
//
// C1: switching an item with notes to an idea used the notes as the whole text
// and dropped the title — including a title typed in the same save. Both must
// survive: the title leads, the notes follow.

test('typeChangePatch to idea keeps BOTH the title and the notes', () => {
  const record = task({ title: 'Call mom about Thanksgiving', notes: 'after 6pm her time' });
  const out = applyEdit(record, typeChangePatch(record, { type: 'idea' }), T1);
  const text = out.notes ?? out.title;
  assert.match(text, /Call mom about Thanksgiving/, 'the title must survive the switch');
  assert.match(text, /after 6pm her time/, 'the notes must survive the switch');
});

test('typeChangePatch to idea keeps a title typed in the same save', () => {
  const record = task({ title: 'Old', notes: 'details' });
  const out = applyEdit(record, typeChangePatch(record, { type: 'idea', title: 'New title' }), T1);
  const text = out.notes ?? out.title;
  assert.match(text, /New title/);
  assert.match(text, /details/);
  assert.doesNotMatch(text, /Old/);
});

// The idea -> task -> idea round trip must not duplicate the label: a task
// derived from an idea has a title that is a prefix of its notes.
test('typeChangePatch idea -> task -> idea does not duplicate the title', () => {
  const text = long(20);
  const asIdea = idea({ title: long(15), notes: text });
  const asTask = applyEdit(asIdea, typeChangePatch(asIdea, { type: 'task' }), T1);
  const back = applyEdit(asTask, typeChangePatch(asTask, { type: 'idea' }), '2026-09-24T12:00:00.000Z');
  assert.equal(back.notes, text, 'the round trip returns exactly the original text');
});

// I1: notes cleared in the same save must not resurrect the old notes.
test('typeChangePatch to idea honours notes cleared in the same save', () => {
  const record = task({ notes: 'old' });
  const out = applyEdit(record, typeChangePatch(record, { type: 'idea', notes: null, title: 'T' }), T1);
  assert.equal(out.notes ?? out.title, 'T');
});

// O4: whitespace-only notes are no notes.
test('typeChangePatch to idea treats whitespace-only notes as empty', () => {
  const record = task({ title: 'Real title', notes: '   ' });
  const out = applyEdit(record, typeChangePatch(record, { type: 'idea' }), T1);
  assert.equal(out.notes ?? out.title, 'Real title');
});

// O1: the user is on the idea sheet, so an emptied idea says so even when the
// same save switches it to a task.
test('an idea emptied while switching to a task says the idea is empty', () => {
  const record = idea({ title: 'x', notes: null });
  assert.throws(() => applyEdit(record, typeChangePatch(record, { type: 'task', notes: '', title: '' }), T1),
    /The idea is empty/);
});

// --- Task 4c review ---------------------------------------------------------

// I2: CLAUDE.md — "adding a new field to items is safe on the sync path".
// deserializeItems and unionById pass records through whole; an edit must too,
// or a device on this version erases a newer version's field on every device
// (the edit carries a newer updatedAt and last-write-wins takes the record).
test('applyEdit keeps fields this version does not know about', () => {
  const record = { ...task(), color: 'red', futureField: { a: 1 } };
  const out = applyEdit(record, { title: 'Renamed' }, T1);
  assert.equal(out.color, 'red');
  assert.deepEqual(out.futureField, { a: 1 });
  assert.equal(out.title, 'Renamed');
});

test('an unknown field can never override a validated one', () => {
  const record = { ...task(), title: 'Real' };
  const out = applyEdit(record, { date: '2026-10-01' }, T1);
  assert.equal(out.date, '2026-10-01');
  assert.equal(out.updatedAt, T1);
});

// O5: ideas are unscheduled (spec § 3.4). No edit path — including a raw
// undo — may leave an idea carrying a time.
test('an idea never carries a time after an edit', () => {
  const record = { ...task({ time: '07:00', endTime: '08:00' }) };
  const out = applyEdit(record, { type: 'idea', notes: 'x', title: 'x' }, T1);
  assert.equal(out.time, null);
  assert.equal(out.endTime, null);
});

// --- sweep batch S ----------------------------------------------------------

// F1/F2: a user write must be stamped STRICTLY later than the record it
// replaces. unionById's ties go to remote and applyTombstones keeps a record
// whose updatedAt is at or after the deletion, so a write stamped at or before
// the record's own updatedAt (a record from a device whose clock runs ahead)
// loses to the very copy it replaced on the next sync.
test('nextStamp returns now when the record is older', () => {
  assert.equal(nextStamp('2026-09-23T12:00:00.000Z', '2026-09-23T11:00:00.000Z'), '2026-09-23T12:00:00.000Z');
});

test('nextStamp returns one millisecond after a record stamped at or after now', () => {
  assert.equal(nextStamp('2026-09-23T12:00:00.000Z', '2026-09-23T12:01:00.000Z'), '2026-09-23T12:01:00.001Z');
  assert.equal(nextStamp('2026-09-23T12:00:00.000Z', '2026-09-23T12:00:00.000Z'), '2026-09-23T12:00:00.001Z',
    'a same-millisecond stamp would tie, and ties go to remote');
});

test('nextStamp returns now when the record has no usable updatedAt', () => {
  for (const prev of [undefined, null, '', 'not a date', 42]) {
    assert.equal(nextStamp('2026-09-23T12:00:00.000Z', prev), '2026-09-23T12:00:00.000Z', String(prev));
  }
});

// F6: "the notes already contain the title" needs a word boundary. A bare
// startsWith read "Calloway about the invoice" as containing the title "Call"
// and dropped the title.
test('typeChangePatch to idea keeps a title that is only a prefix of a word in the notes', () => {
  const record = task({ title: 'Call', notes: 'Calloway about the invoice' });
  const patch = typeChangePatch(record, { type: 'idea' });
  assert.equal(patch.notes, 'Call\n\nCalloway about the invoice');
});

test('typeChangePatch to idea treats notes equal to the title as the whole text', () => {
  const record = task({ title: 'Paint the fence', notes: 'Paint the fence' });
  assert.equal(typeChangePatch(record, { type: 'idea' }).notes, 'Paint the fence');
});

test('typeChangePatch to idea treats notes that begin with the title and a space as the whole text', () => {
  const record = task({ title: 'Paint the fence', notes: 'Paint the fence before the frost' });
  assert.equal(typeChangePatch(record, { type: 'idea' }).notes, 'Paint the fence before the frost');
  const nl = task({ title: 'Paint the fence', notes: 'Paint the fence\nbefore the frost' });
  assert.equal(typeChangePatch(nl, { type: 'idea' }).notes, 'Paint the fence\nbefore the frost');
});

test('typeChangePatch to idea with the title cleared in the same save takes the notes as the text', () => {
  const record = task({ title: 'Old', notes: 'details' });
  assert.equal(typeChangePatch(record, { type: 'idea', title: '' }).notes, 'details');
});

// S-3 (E8): an idea's text edited AND its type switched in one save. The idea
// sheet sends the text as both title and notes; the NEW text must win over the
// record's own (non-null, different) notes.
test('typeChangePatch from idea: text edited in the same save wins over the record\'s notes', () => {
  const record = idea({ title: 'Old thought', notes: 'Old thought, written out at length' });
  const patch = typeChangePatch(record, { type: 'task', title: 'Brand new thought', notes: 'Brand new thought' });
  assert.equal(patch.title, 'Brand new thought');
  const out = applyEdit(record, patch, T1);
  assert.equal(out.title, 'Brand new thought');
  assert.doesNotMatch(JSON.stringify(out), /Old thought/);
});

// Sweep F, O1: a record stamped at the very end of the Date range has no
// "one millisecond later". new Date(prev + 1).toISOString() throws a
// RangeError there, which would break every write to that record.
test('sF: nextStamp returns now when one millisecond after the record is not a date', () => {
  const now = '2026-09-23T12:00:00.000Z';
  assert.equal(nextStamp(now, '+275760-09-13T00:00:00.000Z'), now);
});
