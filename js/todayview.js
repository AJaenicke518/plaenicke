// todayview.js — draws the Today screen (home-screen spec § 2.3) from
// js/today.js's buildToday result.
//
// Presentation only. It NEVER writes: the checkbox reports upward through
// onToggleDone and the title through onOpen, and app.js performs the write
// against its own `items` (CLAUDE.md's ownership invariant).
//
// THE PRESSABLE PART OF A ROW IS ITS OPEN BUTTON, never the <li>. press.js
// presses the nearest `button, [data-press]` above a touch, so a checkbox
// inside a pressable row would press the whole row on every tick. The
// checkbox is the button's sibling. Rows are styled through classes only:
// an id selector would outrank `[data-press].pressed` (styles.css).
import { itemTypeClass } from './calendar.js';
import { formatTime, formatTimeRange } from './timegrid.js';

const SECTIONS = [
  ['overdue', 'Overdue', true],
  ['todo', 'To do today', true],
  ['events', "Today's events", false],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function timeText(item) {
  if (!item.time) return null;
  return item.endTime ? formatTimeRange(item.time, item.endTime) : formatTime(item.time);
}

// renderTodayView(container, today, { onOpen, onToggleDone }) -> { relative }
// `relative` is { node, item } for the one "in N" label (the next event), so
// app.js's 60 s tick can update that text node and nothing else; or null when
// no timed event is still to come. The label is drawn even while it is empty
// (the event over 12 h away).
export function renderTodayView(container, today, { onOpen, onToggleDone } = {}) {
  // Required: a missing one would draw rows that do nothing on tap.
  if (typeof onOpen !== 'function') throw new Error('renderTodayView requires onOpen');
  if (typeof onToggleDone !== 'function') throw new Error('renderTodayView requires onToggleDone');
  container.innerHTML = '';
  let relative = null;

  function row(item, { check = false, meta = [] } = {}) {
    // className, NOT classList.add: itemTypeClass can return two tokens.
    const li = el('li', `today-row ${itemTypeClass(item)}`);
    if (item.external) li.style.setProperty('--feed-color', item.feedColor);
    if (check) {
      const box = el('input', 'today-check');
      box.type = 'checkbox';
      box.checked = item.done === true;
      box.setAttribute('aria-label', `Mark "${item.title}" done`);
      // What the control now holds, never a hard-coded true.
      box.addEventListener('change', () => onToggleDone(item.id, box.checked === true));
      li.appendChild(box);
    }
    const open = el('button', 'item-open today-open');
    open.type = 'button';
    open.setAttribute('data-press', '');
    // How app.js's focusOpener finds this button again.
    open.setAttribute('data-item-id', item.id);
    open.addEventListener('click', () => onOpen(item));
    open.append(el('span', 'today-text', item.title), ...meta);
    li.appendChild(open);
    return li;
  }

  function section(label) {
    const s = el('section', 'today-section');
    s.appendChild(el('h3', 'today-label', label));
    container.appendChild(s);
    return s;
  }

  if (today.emptyLine) container.appendChild(el('p', 'today-empty', today.emptyLine));

  for (const [key, label, check] of SECTIONS) {
    const rows = today[key];
    if (rows.length === 0) continue;
    const list = el('ul', 'today-list');
    for (const r of rows) {
      const meta = [];
      if (key === 'overdue') meta.push(el('span', `today-age ${r.tone}`, r.age));
      if (key === 'todo' && timeText(r.item)) meta.push(el('span', 'today-time', timeText(r.item)));
      if (key === 'events') {
        meta.push(el('span', 'today-time', timeText(r.item) || 'All day'));
        // '' is drawn too: the event is over 12 h away and the tick fills it in.
        if (r.relative !== null) {
          const rel = el('span', 'today-rel', r.relative);
          relative = { node: rel, item: r.item };
          meta.push(rel);
        }
        if (r.item.guessedSeries === true) meta.push(el('span', 'today-guess', 'Repeats weekly (guessed)'));
      }
      const li = row(r.item, { check, meta });
      if (key === 'events' && r.past) li.classList.add('past');
      list.appendChild(li);
    }
    section(label).appendChild(list);
  }

  if (today.next.length > 0) {
    const s = section('Next 7 days');
    for (const day of today.next) {
      s.appendChild(el('h4', 'today-day', day.label));
      const list = el('ul', 'today-list');
      for (const r of day.rows) {
        const t = timeText(r.item);
        list.appendChild(row(r.item, { meta: t ? [el('span', 'today-time', t)] : [] }));
      }
      s.appendChild(list);
    }
  }

  return { relative };
}
