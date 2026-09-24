import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITABLE_FIELDS, applyEdit, diffPatch, snapshotOf, quickMoves, typeChangePatch }
  from '../js/edit.js';

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
  assert.equal(patch.notes, full, 'existing notes are the idea text, never replaced by the title');
  assert.equal(patch.time, null);
  assert.equal(patch.endTime, null);
  const out = applyEdit(record, patch, T1);
  // A thought of 15 words or fewer is stored whole as the title with notes
  // null (js/ideas.js) — either way the complete text must survive.
  assert.equal(out.notes ?? out.title, full, 'nothing the user wrote is lost');
});

test('typeChangePatch to idea uses notes edited in the same save', () => {
  const record = task({ notes: 'old' });
  const patch = typeChangePatch(record, { type: 'idea', notes: 'new words' });
  assert.equal(patch.notes, 'new words');
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
