// todoview.js — the To-do page's list (V6 spec § 5).
//
// Presentation only. It NEVER writes: the checkbox reports upward through
// onToggleDone, and app.js performs the write against its own module-scope
// `items` array. That is CLAUDE.md's ownership invariant (spec § 5.5) —
// app.js owns plaenicke.items and writes from that snapshot, so a writer
// anywhere else is silently lost the next time app.js saves.
//
// No add box, deliberately: to-dos are captured by voice through the main
// entry box and classified by the model (spec § 3.3).
import { itemTypeClass } from './calendar.js';

export function renderTodoView(container, todos, { onDelete, onToggleDone }) {
  container.innerHTML = '';

  if (todos.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing to do. Anything you capture that needs doing shows up here.';
    container.appendChild(li);
    return;
  }

  // Rendered in the order given. The caller sorts, using items.js's single
  // comparator — a second ordering rule in here is a second place for it to
  // drift (spec § 7.6 already flags one such copy in feeds.js).
  for (const it of todos) {
    const li = document.createElement('li');
    // className, NOT classList.add: itemTypeClass can return two tokens
    // ('type-task done') and classList.add throws on a token with a space.
    li.className = `todo-row ${itemTypeClass(it)}`;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = it.done === true;
    // The row's own text is the label; without this the control is an
    // unnamed checkbox in the accessibility tree.
    box.setAttribute('aria-label', `Mark "${it.title}" done`);
    // Report what the CONTROL now holds, never a hard-coded true: hard-coding
    // it would make unticking silently re-complete the item.
    box.addEventListener('change', () => onToggleDone(it.id, box.checked === true));

    const main = document.createElement('div');
    main.className = 'todo-main';
    const info = document.createElement('span');
    info.textContent = `${it.date} — ${it.title}`;
    main.appendChild(info);

    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => onDelete(it.id));

    li.append(box, main, del);
    container.appendChild(li);
  }
}
