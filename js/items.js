// items.js — the shape of a saved item and how to order items.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function makeItem(fields, meta) {
  const title = (fields.title || '').trim();
  if (!title) throw new Error('Title is required');
  // KEEP THIS A FALSY CHECK, not a null check (V6 spec § 3.4). V6 relaxed
  // deserializeItems to tolerate `date: null` as deliberate dead code, so that
  // a future version can adopt genuinely undated records with the tolerance
  // already deployed on both devices. Nothing may start CREATING them here.
  // '' is a third state that behaves like neither: it passes
  // `typeof x === 'string'`, it is falsy, and it is exactly what a cleared
  // <input type="date"> yields (js/preview.js).
  if (!fields.date) throw new Error('Date is required');

  const time = fields.time || null;
  const endTime = fields.endTime || null;
  if (time && !HHMM.test(time)) throw new Error('Time must be HH:MM');
  if (endTime && !HHMM.test(endTime)) throw new Error('End time must be HH:MM');
  if (endTime && !time) throw new Error('End time requires a start time');
  if (time && endTime && endTime <= time) throw new Error('End time must be after start time');

  // THIS IS A WHITELIST REBUILD, NOT A SPREAD. Every field an item may carry
  // has to be listed here or it is silently discarded at the moment of
  // creation — which is what would have happened to `notes` and `done` in V6.
  // Anything added to the record shape (spec § 3.1) must be added here too.
  return {
    id: meta.id,
    title,
    date: fields.date,
    time,
    endTime,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt || meta.createdAt,
    type: fields.type || 'general',
    project: fields.project || null,
    subject: fields.subject || null,
    category: fields.category || null,
    // V6. `done` is read as `=== true` everywhere, so it is stored as a real
    // boolean rather than passed through: a truthy string off a hand-edited
    // blob must not complete a to-do. `notes` is a string or null, never ''.
    done: fields.done === true,
    notes: typeof fields.notes === 'string' && fields.notes !== '' ? fields.notes : null,
  };
}

// --- which page does a record belong on? (V6 spec § 3.3) -------------------
//
// THE PAGES OVERLAP BY DESIGN. A dated to-do appears on the calendar views AND
// on the To-do page: if it has a date it goes on the calendar, and if it also
// needs doing it goes on the to-do list as well. A completed to-do leaves the
// To-do page but STAYS on the calendar — it still happened that day.
//
// `type` is the ONLY discriminator for unscheduled-ness (spec § 3.4): an
// idea's `date` is its capture date, a real YYYY-MM-DD string, never null.

export function isScheduled(it) { return it.type !== 'idea'; }

export function isIdea(it) { return it.type === 'idea'; }

const TODO_TYPES = new Set(['due', 'start', 'milestone', 'task']);

// Note what is NOT here: 'general'. Manual add hard-codes it (js/app.js), and
// it is also every pre-V6 record's type — treating it as actionable would put
// birthdays on the to-do list. This is the accepted gap in spec § 3.3.
export function isTodo(it) { return TODO_TYPES.has(it.type) && it.done !== true; }

// Ideas are ordered newest-first: an idea's `date` is when it was captured, so
// nothing else about it is chronological. Tie-broken by id so two renders of
// the same set never disagree.
export function sortIdeasNewestFirst(items) {
  return [...items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function sortItemsByDate(items) {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const at = a.time || null, bt = b.time || null;
    if (at !== bt) {
      if (at === null) return -1;
      if (bt === null) return 1;
      return at < bt ? -1 : 1;
    }
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
