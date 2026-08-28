// ideas.js — turning a captured thought into an item record (V6 spec § 6).
// Pure: no DOM, no storage, no network.
//
// THE STRUCTURAL GUARANTEE, and the reason this file is so small: `notes`
// holds the COMPLETE original text and `title` is only ever a derived display
// label. An earlier draft had `notes` hold "the remainder" after the split,
// which means a split bug loses words. Keeping the whole text makes that
// impossible — nothing depends on getting the split right, so an early split
// on an abbreviation ("e.g.") is cosmetic rather than destructive.
//
// The one exception is the case where the title ALREADY is the whole text; then
// notes is null, because a note that merely repeats its own heading is noise on
// screen and carries no information the title does not.

export const IDEA_TITLE_MAX_WORDS = 15;

// A sentence terminator followed by whitespace or the end of the string. The
// lookahead is what stops "3.5" or "e.g" mid-word from matching, and the
// end-of-string case is rejected separately below (splitting there would make
// the label the entire body).
const SENTENCE_END = /[.!?](?=\s|$)/;

export function splitIdeaText(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return { title: '', notes: null };

  // The label goes on one line, so it is derived from a whitespace-flattened
  // copy. `text` itself is left alone — the user's paragraph breaks are part
  // of what they wrote and `notes` must return them verbatim.
  const flat = text.replace(/\s+/g, ' ');
  const words = flat.split(' ');

  let title;
  if (words.length <= IDEA_TITLE_MAX_WORDS) {
    title = flat;
  } else {
    const match = flat.match(SENTENCE_END);
    const endsAtVeryEnd = match ? match.index + 1 >= flat.length : true;
    title = match && !endsAtVeryEnd
      ? flat.slice(0, match.index + 1)
      : words.slice(0, IDEA_TITLE_MAX_WORDS).join(' ');
  }

  return { title, notes: title === text ? null : text };
}

// normalizeIdea — the SAME split applied on both capture paths (spec § 6).
//
// Path 1 is the Ideas page's own text box: offline, deterministic, and the
// fallback when the Worker is unreachable. Path 2 is voice through the main
// entry box, where the model classifies the note as `type: 'idea'` and returns
// its own title/notes split.
//
// Re-deriving from the full text is what makes the two paths produce the same
// record, whatever the model chose — and it is idempotent, so a record that
// passes through twice (e.g. edited in the preview and confirmed) does not
// degrade. Only `title` and `notes` are touched: everything else the model
// returned, including the capture `date`, is the caller's to keep.
export function normalizeIdea(fields) {
  if (fields.type !== 'idea') return fields;
  const supplied = typeof fields.notes === 'string' && fields.notes.trim() ? fields.notes : fields.title;
  const { title, notes } = splitIdeaText(supplied);
  return { ...fields, title, notes };
}
