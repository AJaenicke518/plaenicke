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
// checkbox, in its <label class="today-tick">, is the button's sibling. Rows are styled through classes only:
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

// renderTally(node, tally): Today's "N DONE · M LEFT" (rewards concept 2,
// Alex 2026-10-26) in the head's right-hand slot (index.html #today-tally),
// from js/today.js's tally. null: empty and hidden, until the first tick of
// the day. Nothing left: "All N done". Otherwise "N done · M left", the done
// part bold in the accent and the left part in ink (styles.css), so the
// number left keeps you behind. Upper case is the stylesheet's.
export function renderTally(node, tally) {
  node.innerHTML = '';
  node.hidden = tally === null;
  if (tally === null) return;
  if (tally.left === 0) {
    node.appendChild(el('b', null, `All ${tally.done} done`));
    return;
  }
  node.append(el('b', null, `${tally.done} done`), el('span', null, ' · '),
    el('span', 'today-tally-left', `${tally.left} left`));
}

// renderTodayView(container, today, { onOpen, onToggleDone, laterOpen,
//   onToggleLater }) -> { relative }
// `relative` is { node, item } for the one "in N" label (the next event), so
// app.js's 60 s tick can update that text node and nothing else; or null when
// no timed event is still to come. The label is drawn even while it is empty
// (the event over 12 h away).
//
// Coming up (A2, Alex 2026-10-22): when today.later has rows, a full-width
// button under Next 7 days — "Show the next 30 days" while closed; open, the
// days of `later` in Next 7 days' row style with "Show less" at the bottom.
// `laterOpen` is app.js's state (default closed); a tap only reports through
// onToggleLater, and app.js re-renders.
export function renderTodayView(container, today, { onOpen, onToggleDone, laterOpen = false, onToggleLater } = {}) {
  // Required: a missing one would draw rows that do nothing on tap.
  if (typeof onOpen !== 'function') throw new Error('renderTodayView requires onOpen');
  if (typeof onToggleDone !== 'function') throw new Error('renderTodayView requires onToggleDone');
  if (typeof laterOpen !== 'boolean') throw new Error('renderTodayView: laterOpen must be true or false');
  if (today.later.length > 0 && typeof onToggleLater !== 'function') {
    throw new Error('renderTodayView requires onToggleLater when there is something coming up');
  }
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
      // What a tap will do (final review A10).
      box.setAttribute('aria-label', `Mark "${item.title}" ${box.checked ? 'not done' : 'done'}`);
      // What the control now holds, never a hard-coded true.
      box.addEventListener('change', () => onToggleDone(item.id, box.checked === true));
      // The label is the box's 44x44 hit area (styles.css .today-tick; final
      // review A8). Not [data-press], and not inside the open button.
      const tick = el('label', 'today-tick');
      tick.appendChild(box);
      li.appendChild(tick);
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

  // Next 7 days and Coming up draw their days alike.
  function days(s, list) {
    for (const day of list) {
      s.appendChild(el('h4', 'today-day', day.label));
      const ul = el('ul', 'today-list');
      for (const r of day.rows) {
        const t = timeText(r.item);
        ul.appendChild(row(r.item, { meta: t ? [el('span', 'today-time', t)] : [] }));
      }
      s.appendChild(ul);
    }
  }

  if (today.next.length > 0) days(section('Next 7 days'), today.next);

  if (today.later.length > 0) {
    let s;
    if (laterOpen) {
      s = section('Coming up');
      days(s, today.later);
    } else {
      s = el('section', 'today-section');
      container.appendChild(s);
    }
    const more = el('button', laterOpen ? 'today-more today-more-after' : 'today-more',
      laterOpen ? 'Show less' : 'Show the next 30 days');
    more.type = 'button';
    more.setAttribute('aria-expanded', String(laterOpen));
    more.addEventListener('click', () => onToggleLater());
    s.appendChild(more);
  }

  return { relative };
}
