// ideasview.js — the Ideas page's list (V6 spec § 6).
//
// Presentation only; it never writes. The page's own capture box lives in
// index.html and is wired in app.js, which owns plaenicke.items.
//
// AN IDEA'S DATE IS NEVER DISPLAYED. It is the day the thought was captured,
// not a day anything happens (spec § 3.1), and showing it would present the
// user with a schedule they never asked for. `type === 'idea'` is the only
// thing that marks a record unscheduled, so the date is a real YYYY-MM-DD
// string like every other record's — it is simply not about time.

export function renderIdeasView(container, ideas, { onOpen, onDelete }) {
  // Required: a missing one would render titles that do nothing on tap.
  if (typeof onOpen !== 'function') throw new Error('renderIdeasView requires onOpen');
  container.innerHTML = '';

  if (ideas.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No ideas yet. Jot one down above.';
    container.appendChild(li);
    return;
  }

  for (const it of ideas) {
    const li = document.createElement('li');
    li.className = 'idea-row type-idea';

    const main = document.createElement('div');
    main.className = 'idea-main';
    // The title opens the idea. Delete is a SIBLING of the row's content,
    // never inside anything with a click handler.
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'item-open idea-title';
    title.textContent = it.title;
    title.addEventListener('click', () => onOpen(it));
    main.appendChild(title);

    // `notes` holds the COMPLETE original text and `title` is a derived label,
    // so notes is null exactly when the title already IS the whole thought
    // (js/ideas.js). Rendering an empty paragraph for that case would show a
    // blank line under every short idea.
    if (typeof it.notes === 'string' && it.notes !== '') {
      const body = document.createElement('p');
      body.className = 'idea-notes';
      body.textContent = it.notes;
      main.appendChild(body);
    }

    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => onDelete(it.id));

    li.append(main, del);
    container.appendChild(li);
  }
}
