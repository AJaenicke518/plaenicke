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
import { formatDayLabel } from './freshness.js';

// justTicked: the tick moment (rewards concept 1, Alex 2026-10-26), as on
// Today (js/todayview.js): the id of the item a tick just marked done, for the
// one render after the tick, else null. That row, if done, gets `tick-just`
// and its title button's text goes in <span class="tick-strike">.
export function renderTodoView(container, todos, { todayISO, onOpen, onDelete, onToggleDone, justTicked = null }) {
  // Required, not defaulted: without it every row would silently fall back to
  // a raw ISO date, and "Today"/"Tomorrow" are computed against it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayISO || '')) throw new Error('renderTodoView requires todayISO');
  // Required too: a missing one would render titles that do nothing on tap.
  if (typeof onOpen !== 'function') throw new Error('renderTodoView requires onOpen');
  if (justTicked !== null && typeof justTicked !== 'string') throw new Error('renderTodoView: justTicked must be an id or null');
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
    // unnamed checkbox in the accessibility tree. It says what a tap will do,
    // as Today's does (final review A10): a to-do ticked today is listed too.
    box.setAttribute('aria-label', `Mark "${it.title}" ${box.checked ? 'not done' : 'done'}`);
    // Report what the CONTROL now holds, never a hard-coded true: hard-coding
    // it would make unticking silently re-complete the item.
    box.addEventListener('change', () => onToggleDone(it.id, box.checked === true));
    // The label is the box's 44x44 hit area (styles.css .todo-tick; final
    // fixes 2, C8), as Today's is. Not [data-press], and not inside the open
    // button or anything else that listens for a click.
    const tick = document.createElement('label');
    tick.className = 'todo-tick';
    tick.appendChild(box);

    const main = document.createElement('div');
    main.className = 'todo-main';
    // The title opens the item. The checkbox and Delete are SIBLINGS of this
    // button, never inside it and never inside anything with a click handler:
    // a tap on either must not also open the sheet.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'item-open';
    // How app.js finds this button again to return focus to it.
    open.setAttribute('data-item-id', it.id);
    const label = `${formatDayLabel(it.date, todayISO)} — ${it.title}`;
    const just = it.done === true && it.id === justTicked;
    if (just) {
      li.classList.add('tick-just');
      const strike = document.createElement('span');
      strike.className = 'tick-strike';
      strike.textContent = label;
      open.appendChild(strike);
    } else {
      open.textContent = label;
    }
    open.addEventListener('click', () => onOpen(it));
    main.appendChild(open);

    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => onDelete(it.id));

    li.append(tick, main, del);
    container.appendChild(li);
  }
}
