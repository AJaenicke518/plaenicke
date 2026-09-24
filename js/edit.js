// edit.js — the pure half of editing your own items (edit-items spec § 3.1).
// No DOM, no storage, no network: js/itemsheet.js collects the patch and
// js/app.js (the sole writer of plaenicke.items) applies it.

import { makeItem } from './items.js';
import { normalizeIdea, splitIdeaText } from './ideas.js';
import { addDays } from './timegrid.js';

// The ONLY fields an edit may change. Everything else on a record — id,
// createdAt, done, project, subject, category — is carried over from the
// record untouched. `done` in particular has its own edit path (the To-do
// checkbox); letting the sheet write it would be a second editable field on
// the sync path, which re-opens the reasoning in js/merge.js's header.
export const EDITABLE_FIELDS = ['title', 'date', 'time', 'endTime', 'type', 'notes'];

// applyEdit — rebuild the record through makeItem, never patch it in place.
//
// Going through makeItem is the point: an edit gets exactly the validation a
// new item gets ('' dates, end <= start, empty titles, bad HH:MM), and the
// 13-key whitelist means a stray key in the patch cannot land on a record.
// The key filter below is still needed, because makeItem's whitelist INCLUDES
// done/project/subject/category — without the filter a patch could rewrite them.
//
// `updatedAt` MUST be the caller's fresh timestamp. unionById's ties go to
// remote, so an edit that kept the record's old updatedAt would be silently
// reverted by the next sync.
//
// normalizeIdea runs on the merged fields so an edited idea gets the same
// title/notes split as a captured one (notes = the complete text, title = a
// derived label). NOTE: normalizeIdea prefers `notes` over `title` when notes
// is non-empty, so for an idea the caller must send the edited text as
// `notes` — a title-only patch to an idea with notes is overridden by them.
export function applyEdit(record, patch, updatedAt) {
  const picked = {};
  for (const k of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) picked[k] = patch[k];
  }
  const merged = { ...record, ...picked };
  try {
    return makeItem(normalizeIdea(merged), { id: record.id, createdAt: record.createdAt, updatedAt });
  } catch (err) {
    // An idea has no separate title box on screen, so "Title is required"
    // would name a field the user cannot see.
    if (merged.type === 'idea' && err instanceof Error && err.message === 'Title is required') {
      throw new Error('The idea is empty.');
    }
    throw err;
  }
}

// Blank-ish values the form and the record spell differently: a record holds
// null, a cleared <input> yields '', and an absent key is undefined.
function blank(v) { return v === null || v === undefined || v === ''; }

// diffPatch — only the editable keys whose values actually changed.
//
// `date` is EXEMPT from the blank-equivalence. '' is what a cleared date box
// yields, and it must reach makeItem so makeItem can reject it; folding it
// into "unchanged" would silently keep the old date instead of refusing the
// save. (A record's date is never null or '' — makeItem refuses both — so
// strict comparison costs nothing for real records.)
export function diffPatch(opened, current) {
  const out = {};
  for (const k of EDITABLE_FIELDS) {
    const a = opened[k], b = current[k];
    const same = k === 'date' ? a === b : a === b || (blank(a) && blank(b));
    if (!same) out[k] = b;
  }
  return out;
}

// snapshotOf — the given keys of a record, as a fresh object. This is what an
// edit's undo re-applies, so it copies null values as well: a snapshot that
// skipped them could not restore a cleared time.
export function snapshotOf(record, keys) {
  const out = {};
  for (const k of keys) out[k] = record[k];
  return out;
}

// quickMoves — "Tomorrow" is relative to TODAY (moving an overdue item to
// tomorrow is the common case), "+1 week" is relative to the ITEM's own date.
export function quickMoves(record, todayISO) {
  return [
    { label: 'Tomorrow', date: addDays(todayISO, 1) },
    { label: '+1 week', date: addDays(record.date, 7) },
  ];
}

// typeChangePatch — adjust a patch that moves a record across the idea line.
// Applied by the caller BEFORE applyEdit. Returns a new object when it
// changes anything and never mutates its inputs.
//
// To idea: the text becomes what the user sees as the title. Without this,
// normalizeIdea would prefer the record's old (possibly hidden) notes and the
// new idea would be titled from text the user never saw. Ideas are unscheduled
// (type is the only discriminator, spec § 3.4), so times are cleared.
//
// From idea: the idea's full text is split with the same splitIdeaText the
// capture path uses, so a long idea becomes a short title with the complete
// text kept in notes — nothing the user wrote is lost.
export function typeChangePatch(record, patch) {
  const wasIdea = record.type === 'idea';
  if (!wasIdea && patch.type === 'idea') {
    const title = patch.title ?? record.title;
    return { ...patch, notes: title, time: null, endTime: null };
  }
  if (wasIdea && patch.type !== undefined && patch.type !== 'idea') {
    const text = patch.notes ?? patch.title ?? (record.notes ?? record.title);
    const { title, notes } = splitIdeaText(text);
    return { ...patch, title, notes };
  }
  return patch;
}
