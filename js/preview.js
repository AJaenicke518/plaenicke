// preview.js — editable confirmation list for multi/uncertain smart-add results.

// THIS IS THE SECOND HARD-CODED TYPE LIST. The first is the `type` enum in
// worker/src/prompt.js, and the two live in DIFFERENT DEPLOY UNITS — the
// client ships by merging to main, the Worker ships separately through
// wrangler — so they can diverge silently. A type the model returns that is
// missing here renders a <select> with NO option selected: the browser shows
// the first option while draft[i].type still holds the real value, and the
// first change event on that control writes the wrong type into the record.
//
// EXPORTED so tests/preview.test.js can assert against the Worker's enum
// directly (npm test recurses into worker/, so importing both is airtight
// without coupling the two deploy units through a shared import).
//
// 'general' is deliberately client-only: manual add hard-codes it and it is
// every pre-V6 record's type, but the model is never asked to produce it.
export const TYPES = ['due', 'start', 'milestone', 'event', 'general', 'task', 'idea'];

export function renderPreview(container, items, { onConfirm, onCancel }) {
  const draft = items.map((it) => ({ ...it }));
  container.hidden = false;
  container.innerHTML = '';

  const heading = document.createElement('p');
  heading.textContent = `Review ${draft.length} item${draft.length === 1 ? '' : 's'} before adding:`;
  container.appendChild(heading);

  draft.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'preview-row';

    const title = document.createElement('input');
    title.type = 'text';
    title.value = it.title;
    title.addEventListener('input', () => { draft[i].title = title.value; });

    const date = document.createElement('input');
    date.type = 'date';
    date.value = it.date;
    date.addEventListener('input', () => { draft[i].date = date.value; });

    const type = document.createElement('select');
    for (const t of TYPES) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      if (t === it.type) opt.selected = true;
      type.appendChild(opt);
    }
    type.addEventListener('change', () => { draft[i].type = type.value; });

    const fields = document.createElement('div');
    fields.className = 'preview-fields';
    const time = document.createElement('input');
    time.type = 'time';
    time.value = it.time || '';
    const end = document.createElement('input');
    end.type = 'time';
    end.value = it.endTime || '';
    time.addEventListener('input', () => { draft[i].time = time.value || null; if (!time.value) { end.value = ''; draft[i].endTime = null; } });
    end.addEventListener('input', () => { draft[i].endTime = end.value || null; });
    fields.append(date, type, time, end);
    row.append(title, fields);
    container.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.className = 'preview-actions';
  const add = document.createElement('button');
  add.textContent = 'Add all';
  add.addEventListener('click', () => {
    if (onConfirm(draft) === false) return; // validation failed — keep edits on screen
    container.hidden = true;
    container.innerHTML = '';
  });
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { container.hidden = true; container.innerHTML = ''; onCancel(); });
  actions.append(add, cancel);
  container.appendChild(actions);
}
