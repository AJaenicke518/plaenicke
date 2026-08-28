import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIdeaText, normalizeIdea, IDEA_TITLE_MAX_WORDS } from '../js/ideas.js';

// =========================================================================
// splitIdeaText (V6 spec § 6)
// =========================================================================
//
// THE STRUCTURAL GUARANTEE. `notes` holds the COMPLETE original text; `title`
// is only ever a derived display label. The previous draft had notes hold "the
// remainder" after the split, which means a split bug loses words. Keeping the
// whole text makes that impossible — no information depends on getting the
// split right, so an early split on an abbreviation is cosmetic.
//
// Every test below therefore asserts the invariant as well as the label.

function assertNothingLost(text, out) {
  const whole = out.notes === null ? out.title : out.notes;
  assert.equal(whole.replace(/\s+/g, ' '), String(text).trim().replace(/\s+/g, ' '),
    'the complete original text must be recoverable from the record');
}

const long = (n) => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');

test('short text becomes the title alone, with no notes', () => {
  const out = splitIdeaText('Buy a birthday present for Mum');
  assert.equal(out.title, 'Buy a birthday present for Mum');
  assert.equal(out.notes, null, 'notes duplicating the title is pure noise on screen');
  assertNothingLost('Buy a birthday present for Mum', out);
});

test('exactly the word limit is still short; one more word is not', () => {
  const atLimit = long(IDEA_TITLE_MAX_WORDS);
  assert.equal(splitIdeaText(atLimit).notes, null);
  assert.equal(splitIdeaText(atLimit).title, atLimit);

  const overLimit = long(IDEA_TITLE_MAX_WORDS + 1);
  const out = splitIdeaText(overLimit);
  assert.equal(out.notes, overLimit, 'over the limit, notes must hold the WHOLE text');
  assert.equal(out.title, long(IDEA_TITLE_MAX_WORDS), 'and the title is the first N words');
  assertNothingLost(overLimit, out);
});

test('long text with a sentence boundary uses the first sentence as the label', () => {
  const text = 'Rework the kitchen shelves. They are too deep for the mugs and everything at the back is unreachable, '
    + 'so half the cupboard is wasted.';
  const out = splitIdeaText(text);
  assert.equal(out.title, 'Rework the kitchen shelves.');
  assert.equal(out.notes, text, 'the full text, not the remainder');
  assertNothingLost(text, out);
});

test('a question mark or exclamation mark ends a sentence too', () => {
  const q = `Should we move the standup? ${long(20)}`;
  assert.equal(splitIdeaText(q).title, 'Should we move the standup?');
  const e = `Book the flights now! ${long(20)}`;
  assert.equal(splitIdeaText(e).title, 'Book the flights now!');
});

// A terminator at the very END of the text is not a boundary to split on —
// splitting there would make the label the entire body.
test('a full stop only at the end of a long text falls back to the word limit', () => {
  const text = `${long(30)}.`;
  const out = splitIdeaText(text);
  assert.equal(out.title, long(IDEA_TITLE_MAX_WORDS));
  assert.equal(out.notes, text);
  assertNothingLost(text, out);
});

// The known cosmetic edge case, pinned so it stays cosmetic: an abbreviation
// splits early, and NOTHING is lost when it does.
test('an abbreviation splits the label early, and loses nothing doing it', () => {
  const text = `Try a lighter framework, e.g. something with no build step at all. ${long(20)}`;
  const out = splitIdeaText(text);
  assert.equal(out.title, 'Try a lighter framework, e.g.');
  assert.equal(out.notes, text);
  assertNothingLost(text, out);
});

// The user's own line breaks are part of what they wrote. The LABEL is
// flattened (it goes on one line); the NOTES are not.
test('newlines survive in notes and are flattened only in the title', () => {
  const text = `First line here.\n\nA second paragraph that carries on ${long(20)}`;
  const out = splitIdeaText(text);
  assert.equal(out.title, 'First line here.');
  assert.equal(out.notes, text, 'notes must be the original, paragraph breaks and all');
  assert.doesNotMatch(out.title, /\n/);
});

test('a short multi-line note keeps its line breaks in notes even though the title is flat', () => {
  const text = 'Milk\neggs\nbread';
  const out = splitIdeaText(text);
  assert.equal(out.title, 'Milk eggs bread');
  assert.equal(out.notes, text, 'the title flattened the text, so the original must be kept somewhere');
  assertNothingLost(text, out);
});

test('surrounding whitespace is trimmed and does not count as content', () => {
  const out = splitIdeaText('   Call the dentist   ');
  assert.equal(out.title, 'Call the dentist');
  assert.equal(out.notes, null);
});

test('empty and non-string input produce an empty title rather than throwing', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.deepEqual(splitIdeaText(bad), { title: '', notes: null });
  }
});

// Applying the split to text that has already been split must change nothing —
// the same function runs on the Ideas page's own capture and again on anything
// the model returns, and a record must not degrade each time it passes through.
test('splitIdeaText is idempotent on its own output', () => {
  for (const text of ['Short one', `${long(30)}.`, 'Rework the shelves. They are too deep for the mugs and it is a waste.']) {
    const once = splitIdeaText(text);
    const twice = splitIdeaText(once.notes === null ? once.title : once.notes);
    assert.deepEqual(twice, once);
  }
});

// =========================================================================
// normalizeIdea — the one split, applied on BOTH capture paths (spec § 6)
// =========================================================================

test('normalizeIdea leaves every non-idea record exactly as it was', () => {
  for (const type of ['general', 'due', 'start', 'milestone', 'event', 'task', undefined]) {
    const fields = { title: `${long(30)}`, date: '2026-08-20', type, notes: 'should not be touched' };
    assert.deepEqual(normalizeIdea(fields), fields);
  }
});

// The model returns title + notes and does its own splitting. Re-running the
// client's split over the FULL text is what makes the two capture paths
// produce the same record shape regardless of what the model chose.
test('normalizeIdea re-derives the title from the model-supplied notes', () => {
  const full = 'Rework the kitchen shelves. They are too deep for the mugs and half the cupboard is wasted entirely.';
  const out = normalizeIdea({ title: 'a label the model invented', date: '2026-08-20', type: 'idea', notes: full });
  assert.equal(out.title, 'Rework the kitchen shelves.');
  assert.equal(out.notes, full);
});

test('normalizeIdea splits the title when the model returned no notes at all', () => {
  const text = `${long(30)}.`;
  const out = normalizeIdea({ title: text, date: '2026-08-20', type: 'idea', notes: null });
  assert.equal(out.title, long(IDEA_TITLE_MAX_WORDS));
  assert.equal(out.notes, text, 'the full text must be preserved, whichever field the model put it in');
});

test('normalizeIdea keeps every other field, including the capture date', () => {
  const out = normalizeIdea({
    title: 'Short thought', date: '2026-08-20', type: 'idea', notes: null,
    project: 'House', subject: null, category: 'Personal', time: null, endTime: null,
  });
  assert.equal(out.date, '2026-08-20', "an idea's date is its capture date and is never null (spec § 3.4)");
  assert.equal(out.project, 'House');
  assert.equal(out.category, 'Personal');
  assert.equal(out.type, 'idea');
});

test('normalizeIdea is idempotent', () => {
  const full = `Rework the shelves. ${long(30)}`;
  const once = normalizeIdea({ title: 'whatever', date: '2026-08-20', type: 'idea', notes: full });
  assert.deepEqual(normalizeIdea(once), once);
});
