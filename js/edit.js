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
  // Ideas are unscheduled (spec § 3.4): no edit — including a raw undo that
  // restores an idea after the other device set a time — leaves one timed.
  if (merged.type === 'idea') { merged.time = null; merged.endTime = null; }
  try {
    const rebuilt = makeItem(normalizeIdea(merged), { id: record.id, createdAt: record.createdAt, updatedAt });
    // makeItem is a whitelist rebuild, which is right for VALIDATING the
    // fields it knows and wrong for DISCARDING the ones it doesn't. CLAUDE.md:
    // "adding a new field to items is safe on the sync path" — deserializeItems
    // and unionById pass records through whole, and an edit must too, or this
    // version erases a newer version's field on every device (the edit wins
    // last-write-wins with its newer updatedAt). Unknown keys ride along; the
    // whitelisted ones always come from makeItem and can never be overridden.
    const extras = {};
    for (const k of Object.keys(record)) if (!(k in rebuilt)) extras[k] = record[k];
    return { ...extras, ...rebuilt };
  } catch (err) {
    // An idea has no separate title box on screen, so "Title is required"
    // would name a field the user cannot see. That holds when the SAME save
    // switches an idea to another type: the user is still on the idea sheet.
    if ((merged.type === 'idea' || record.type === 'idea') && err instanceof Error && err.message === 'Title is required') {
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
// To idea: an idea is ONE piece of text, and nothing the user wrote may be
// dropped on the way into it. The title leads and the notes (a visible field on
// every sheet) follow, separated by a blank line. When the notes already begin
// with the title — a task that was itself derived from an idea, whose title is
// the first sentence of its notes — the notes ARE the full text, so the round
// trip idea -> task -> idea returns exactly what it started with. Notes cleared
// in the same save (patch.notes === null or '') count as cleared: `??` would
// resurrect the old ones. Setting notes explicitly means normalizeIdea derives
// from exactly this text. Ideas are unscheduled (spec § 3.4): times cleared.
//
// From idea: the idea's full text is split with the same splitIdeaText the
// capture path uses, so a long idea becomes a short title with the complete
// text kept in notes — nothing the user wrote is lost.
// The notes already hold the title only when they ARE the title, or begin with
// it as a whole word (followed by whitespace). A bare startsWith read
// "Calloway about the invoice" as containing the title "Call" and dropped it.
function notesContainTitle(notes, title) {
  // No title to lose (cleared in the same save): the notes are the text, as before.
  if (typeof title !== 'string' || title === '') return true;
  return notes === title || (notes.startsWith(title) && /\s/.test(notes.charAt(title.length)));
}

export function typeChangePatch(record, patch) {
  const wasIdea = record.type === 'idea';
  if (!wasIdea && patch.type === 'idea') {
    const notes = patch.notes !== undefined ? patch.notes : record.notes;
    const title = patch.title ?? record.title;
    const hasNotes = typeof notes === 'string' && notes.trim() !== '';
    let text = title;
    if (hasNotes) text = notesContainTitle(notes, title) ? notes : `${title}\n\n${notes}`;
    return { ...patch, notes: text, time: null, endTime: null };
  }
  if (wasIdea && patch.type !== undefined && patch.type !== 'idea') {
    const text = patch.notes ?? patch.title ?? (record.notes ?? record.title);
    const { title, notes } = splitIdeaText(text);
    return { ...patch, title, notes };
  }
  return patch;
}

// nextStamp — the updatedAt (or deletedAt) for a user write that replaces a
// record stamped `prevIso`: now, or one millisecond after the record's own
// stamp if that is not earlier than now. Used by every user write to a synced
// record — editItem (and so Undo), setDone, and the delete commit's tombstone.
//
// WHY STRICTLY LATER. unionById's ties go to remote (`>=`) and applyTombstones
// keeps a record whose updatedAt is at or after the deletion. A record written
// by a device whose clock runs ahead carries a future updatedAt; a write here
// stamped with this device's plain `now` then LOSES to the very copy it
// replaced on the next sync — the edit or delete silently undone. One write
// can therefore no longer lose to clock skew. Two CONCURRENT writes on two
// devices still can: this orders a write after the record it saw, nothing more.
//
// An unparseable prevIso (a record from before updatedAt was a full instant,
// or a corrupt one) cannot be compared, so the write takes plain now.
export function nextStamp(nowIso, prevIso) {
  const now = Date.parse(nowIso);
  const prev = typeof prevIso === 'string' ? Date.parse(prevIso) : NaN;
  if (Number.isNaN(prev) || prev < now) return nowIso;
  return new Date(prev + 1).toISOString();
}
