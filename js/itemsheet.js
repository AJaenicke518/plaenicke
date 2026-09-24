// itemsheet.js — the bottom sheet that opens one item (edit-items spec § 3.2).
//
// Presentation only: no storage, no app state. It collects a patch and hands
// it to onSave; js/app.js (the sole writer of plaenicke.items) applies it.
//
// What the sheet sends is `diffPatch(opened, current)`: ONLY the fields the
// user changed, raw. The idea<->non-idea adjustment (typeChangePatch) is NOT
// applied here — app.js's editItem applies it against the CURRENT record. A field that changed through a sync while
// the sheet was open must not be written back with the value the sheet opened
// with (spec § 6). `opened` is read back from the freshly built form by the
// same function that reads `current` at Save, so an untouched sheet diffs to
// nothing by construction — the idea sheet in particular shows `notes ?? title`
// in one box, and an `opened` built from the record's raw fields would differ
// from it on every idea whose notes are null.
//
// External (feed) items get a read-only sheet. It is given only a calendar
// NAME and an optional Google day URL — never the feed's URL, which is a
// capability token (CLAUDE.md, "Feed URLs are unrecoverable").

import { TYPES } from './preview.js';
import { diffPatch, quickMoves } from './edit.js';
import { formatDayLabel } from './freshness.js';
import { formatTime, formatTimeRange } from './timegrid.js';

// The teardown of the sheet currently mounted in each host. Mounting empties
// the host, so a sheet replaced by another must lose its Escape listener too;
// otherwise the stale handler would empty the NEW sheet and call the old
// onClose. WeakMap so a host that leaves the DOM takes its entry with it.
const mounted = new WeakMap();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text) {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
}

// A visible label wrapping its control, so every field is named without ids.
function field(labelText, control) {
  const label = el('label', 'sheet-field');
  label.append(el('span', 'sheet-label', labelText), control);
  return label;
}

function input(type, className, value) {
  const i = el('input', className);
  i.type = type;
  i.value = value;
  return i;
}

function typeSelect(current) {
  const sel = el('select', 'sheet-type');
  for (const t of TYPES) {
    const opt = el('option', null, t);
    opt.value = t;
    if (t === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.value = current;
  return sel;
}

export function openItemSheet(host, item, {
  today, calendarName = null, googleDayUrl = null, onSave, onDelete, onClose,
} = {}) {
  const isExternal = item.external === true;
  // Every check happens BEFORE the host is touched or a listener registered:
  // the caller (app.js) catches the throw and shows a message, and whatever
  // the host was showing must still be there.
  // A FUNCTION, not a date string (sweep D3): a sheet can stay open across
  // midnight, so a quick move asks for today when it is tapped.
  if (typeof today !== 'function') throw new Error('openItemSheet: today must be a function');
  if (typeof onClose !== 'function') throw new Error('openItemSheet: onClose must be a function');
  if (!isExternal) {
    // A type the select does not list renders with NO option selected; the
    // browser shows the first one while the record holds the real value, and
    // the next change writes the wrong type in for good (js/preview.js).
    if (!TYPES.includes(item.type)) throw new Error(`Unknown type: ${item.type}`);
    if (typeof onSave !== 'function') throw new Error('openItemSheet: onSave must be a function');
    if (typeof onDelete !== 'function') throw new Error('openItemSheet: onDelete must be a function');
  }

  const prev = mounted.get(host);
  if (prev) prev();

  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  // Detach without notifying: used when another sheet replaces this one.
  const teardown = () => {
    if (closed) return false;
    closed = true;
    document.removeEventListener('keydown', onKey);
    if (mounted.get(host) === teardown) mounted.delete(host);
    return true;
  };
  // EVERY close path goes through here, so the listener removal lives in
  // exactly one place.
  function close() {
    if (!teardown()) return;
    host.innerHTML = '';
    onClose();
  }

  const backdrop = el('div', 'sheet-backdrop');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  // Only a tap on the backdrop itself: a tap inside the sheet reports the
  // backdrop as currentTarget but something inside as target.
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  const sheet = el('div', 'sheet');
  backdrop.appendChild(sheet);
  const bar = el('div', 'sheet-bar');
  sheet.appendChild(bar);

  if (isExternal) {
    backdrop.setAttribute('aria-label', 'Event details');
    const closeBtn = button('sheet-close', 'Close');
    closeBtn.addEventListener('click', close);
    bar.appendChild(closeBtn);

    sheet.appendChild(el('h2', 'sheet-heading', item.title));
    let when = formatDayLabel(item.date, today());
    if (item.time) when += ` · ${item.endTime ? formatTimeRange(item.time, item.endTime) : formatTime(item.time)}`;
    sheet.appendChild(el('p', 'sheet-when', when));
    if (calendarName) sheet.appendChild(el('p', 'sheet-source', `From ${calendarName}`));
    if (googleDayUrl) {
      const a = el('a', 'sheet-google', 'Open in Google Calendar');
      a.href = googleDayUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      sheet.appendChild(a);
    }
  } else {
    const isIdeaSheet = item.type === 'idea';
    backdrop.setAttribute('aria-label', isIdeaSheet ? 'Edit idea' : 'Edit item');
    const cancel = button('sheet-cancel', 'Cancel');
    cancel.addEventListener('click', close);
    const save = button('sheet-save', 'Save');
    bar.append(cancel, save);

    const form = el('div', 'sheet-form');
    sheet.appendChild(form);
    const error = el('p', 'sheet-error', '');
    error.setAttribute('role', 'alert');
    const type = typeSelect(item.type);

    let read;
    if (isIdeaSheet) {
      const text = el('textarea', 'sheet-text');
      text.value = item.notes ?? item.title;
      text.setAttribute('rows', '6');
      form.append(field('Idea', text), field('Type', type));
      // title AND notes, always together: normalizeIdea prefers notes, so a
      // title-only patch would be overridden by the old notes.
      read = () => ({ title: text.value, notes: text.value, type: type.value });
    } else {
      const title = input('text', 'sheet-title', item.title);
      const date = input('date', 'sheet-date', item.date);
      const time = input('time', 'sheet-time', item.time || '');
      const end = input('time', 'sheet-end', item.endTime || '');
      // An end with no start is invalid (makeItem), so it goes with the start.
      // `change` too: a time picker's Clear may fire only that (Task 3 review O2).
      const clearEnd = () => { if (!time.value) end.value = ''; };
      time.addEventListener('input', clearEnd);
      time.addEventListener('change', clearEnd);
      const notes = el('textarea', 'sheet-notes');
      notes.value = item.notes || '';
      notes.setAttribute('rows', '3');
      form.append(
        field('Title', title), field('Date', date), field('Start', time), field('End', end),
        field('Type', type), field('Notes', notes),
      );
      read = () => ({
        title: title.value,
        date: date.value,
        time: time.value || null,
        endTime: end.value || null,
        type: type.value,
        notes: notes.value || null,
      });
    }
    const opened = read();

    const submit = (override) => {
      if (closed) return; // a stale reference to a control of a closed sheet
      const current = { ...read(), ...override };
      const diff = diffPatch(opened, current);
      if (Object.keys(diff).length === 0) { close(); return; }
      // The RAW diff (Task 3 review I1). typeChangePatch fills title/notes from
      // a record, and the only safe record is the CURRENT one, which app.js's
      // editItem holds — `item` is the record as it was when this sheet opened,
      // and filling from it wrote stale text back over a sync that arrived
      // while the sheet was open.
      let res;
      try {
        res = onSave(diff);
      } catch (err) {
        // Never a silent, stuck sheet (Task 3 review O3): say what happened,
        // then let it propagate so it is not swallowed either.
        error.textContent = `Could not save: ${err && err.message ? err.message : err}`;
        throw err;
      }
      // Loud on a malformed result: an ok-less result read as failure would
      // show no message, and read as success would close over an unsaved edit.
      if (!res || typeof res.ok !== 'boolean' || (!res.ok && typeof res.error !== 'string')) {
        throw new Error('openItemSheet: onSave must return { ok: true } or { ok: false, error }');
      }
      if (res.ok) { close(); return; }
      error.textContent = res.error;
    };
    save.addEventListener('click', () => submit({}));

    const actions = el('div', 'sheet-actions');
    if (!isIdeaSheet) {
      // Only the labels are taken here; the dates are computed at click time.
      quickMoves(item, today()).forEach((move, i) => {
        const b = button('sheet-move', move.label);
        // Recomputed at click time from the date IN THE BOX, so "+1 week" never
        // silently discards a date the user typed (Task 3 review O1), and from
        // today() as of the tap, so "Tomorrow" is right after midnight (D3).
        b.addEventListener('click', () => {
          // `|| item.date` is DELIBERATE. A cleared date box reads as '', and
          // addDays('', 7) is not a date; a quick move is a move from the
          // item's date, so an emptied box falls back to it. This is not the
          // Save path: a Save with a cleared box still sends date: '' so that
          // makeItem refuses it.
          const typed = read().date || item.date;
          submit({ date: quickMoves({ ...item, date: typed }, today())[i].date });
        });
        actions.appendChild(b);
      });
    }
    const del = button('sheet-delete', 'Delete');
    del.addEventListener('click', () => {
      if (closed) return;
      onDelete();
      close();
    });
    actions.appendChild(del);
    sheet.append(error, actions);
  }

  host.innerHTML = '';
  host.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  mounted.set(host, teardown);
}
