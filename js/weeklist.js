// weeklist.js — the Week page's list under the grid (stage 3 Commit 3; Alex,
// 2026-10-22: "a list of events coming up for that week in the open space
// below the week"; design B2: the day in a narrow left column, each row
// starting with its time).
//
// buildWeekList is pure. renderWeekList is presentation only: it NEVER
// writes; a row reports through onOpen and a day label through onSelectDay,
// and app.js acts. Rows are styled through classes only: an id selector would
// outrank `[data-press].pressed` (styles.css).
import { addDays, formatTime } from './timegrid.js';
import { itemTypeClass } from './calendar.js';
import { upcomingRows } from './today.js';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const utcOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
const DAY_NAME = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

// buildWeekList(items, instancesFor, weekStartISO, todayISO) -> { heading, days }
//   items         own items (app.js passes liveItems())
//   instancesFor  (fromISO, toISO) => instancesForRange(..., fromISO, toISO, ...)
//                 called once, for exactly the range listed
//   weekStartISO  the Sunday of the week shown
//   todayISO      the device's today
// The range is the week's days: from today for the current week ("Rest of
// this week"), all seven for any other week, past or future ("This week").
// `days` is upcomingRows over that range — the one row rule Next 7 days and
// Coming up use: no repeating instance, no done item, no idea; a multi-day
// one-off once, on its first day in range. The instances are asked for that
// range only, so nothing is dropped as "already shown before it": the Week
// list is its own page and lists what Today also shows (controller ruling,
// 2026-10-22).
export function buildWeekList(items, instancesFor, weekStartISO, todayISO) {
  if (typeof weekStartISO !== 'string' || !ISO_DAY.test(weekStartISO)) throw new Error('buildWeekList requires weekStartISO');
  if (typeof todayISO !== 'string' || !ISO_DAY.test(todayISO)) throw new Error('buildWeekList requires todayISO');
  if (typeof instancesFor !== 'function') throw new Error('buildWeekList requires instancesFor');
  const weekEnd = addDays(weekStartISO, 6);
  const current = todayISO >= weekStartISO && todayISO <= weekEnd;
  const fromISO = current ? todayISO : weekStartISO;
  return {
    heading: current ? 'Rest of this week' : 'This week',
    days: upcomingRows(items, instancesFor(fromISO, weekEnd), fromISO, weekEnd, todayISO),
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// renderWeekList(container, { heading, days }, { onOpen, onSelectDay })
// B2: under the heading, one block per day — a narrow left column with the
// day ("Fri" over a bold "23"), a button that opens that day in Day view —
// beside its rows. A row begins with its start time ("All day" when untimed),
// then the title; a feed row takes its calendar's colour through
// --feed-color. Nothing to list: "Nothing else this week."
export function renderWeekList(container, list, { onOpen, onSelectDay } = {}) {
  // Required: a missing one would draw rows or labels that do nothing on tap.
  if (typeof onOpen !== 'function') throw new Error('renderWeekList requires onOpen');
  if (typeof onSelectDay !== 'function') throw new Error('renderWeekList requires onSelectDay');
  container.innerHTML = '';
  container.appendChild(el('h3', 'today-label', list.heading));
  if (list.days.length === 0) {
    container.appendChild(el('p', 'today-empty', 'Nothing else this week.'));
    return;
  }
  for (const day of list.days) {
    const block = el('div', 'wlist-day');
    const label = el('button', 'wlist-label', WEEKDAY.format(utcOf(day.date)));
    label.type = 'button';
    label.setAttribute('aria-label', `Open ${DAY_NAME.format(utcOf(day.date))} in Day view`);
    label.appendChild(el('b', '', String(Number(day.date.slice(8)))));
    label.addEventListener('click', () => onSelectDay(day.date));
    block.appendChild(label);

    const ul = el('ul', 'today-list');
    for (const { item } of day.rows) {
      // className, NOT classList.add: itemTypeClass can return two tokens.
      const li = el('li', `today-row ${itemTypeClass(item)}`);
      if (item.external) li.style.setProperty('--feed-color', item.feedColor);
      const open = el('button', 'item-open today-open wlist-open');
      open.type = 'button';
      open.setAttribute('data-press', '');
      // How app.js's focusOpener finds this button again.
      open.setAttribute('data-item-id', item.id);
      open.addEventListener('click', () => onOpen(item));
      open.append(
        el('span', 'today-time wlist-time', item.time ? formatTime(item.time) : 'All day'),
        el('span', 'today-text', item.title),
      );
      li.appendChild(open);
      ul.appendChild(li);
    }
    block.appendChild(ul);
    container.appendChild(block);
  }
}
