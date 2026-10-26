// threedayview.js — the 3-day view (option A, Alex 2026-10-26): three columns
// of Day's hour grid, an "All day" strip above them for untimed items, and a
// heading per day that opens that day in Day view.
//
// Presentation only: it NEVER writes. A block or chip reports through onOpen
// and a heading through onSelectDay, and app.js acts. app.js passes the items
// from visibleItems(), so repeating feed instances are here (the Week list,
// which leaves them out, is a different rule).
import { addDays, bucketDayItems, layoutDayBlocks, formatTime, formatTimeRange } from './timegrid.js';
import { itemTypeClass } from './calendar.js';

const HOUR_PX = 48; // as Day (js/dayview.js)
const SCROLL_TO_HOUR = 7; // as Day: the grid shows 24h and opens at 07:00
const DAYS = 3;

const utcOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
const DAY_NAME = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

// "9:25 AM" -> "9:25": a column is about 100px wide on a phone.
const shortTime = (hhmm) => formatTime(hhmm).split(' ')[0];
// "1 PM": the hour gutter is narrow.
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderThreeDayView(container, startISO, itemsByDate, todayISO, { onOpen, onSelectDay, autoScroll = true } = {}) {
  // Required: a missing one would draw blocks or headings that do nothing on tap.
  if (typeof onOpen !== 'function') throw new Error('renderThreeDayView requires onOpen');
  if (typeof onSelectDay !== 'function') throw new Error('renderThreeDayView requires onSelectDay');
  const prev = container.querySelector('.tday-grid')?.scrollTop ?? 0;
  container.innerHTML = '';

  const dates = Array.from({ length: DAYS }, (_, i) => addDays(startISO, i));
  const days = dates.map((date) => bucketDayItems(itemsByDate[date] || []));

  const heads = el('div', 'tday-heads');
  heads.appendChild(el('span', 'tday-corner'));
  for (const date of dates) {
    const head = el('button', date === todayISO ? 'tday-head today' : 'tday-head', WEEKDAY.format(utcOf(date)));
    head.type = 'button';
    head.setAttribute('aria-label', `Open ${DAY_NAME.format(utcOf(date))} in Day view`);
    head.appendChild(el('b', '', String(Number(date.slice(8)))));
    head.addEventListener('click', () => onSelectDay(date));
    heads.appendChild(head);
  }
  container.appendChild(heads);

  if (days.some((d) => d.untimed.length > 0)) {
    const strip = el('div', 'tday-allday');
    strip.appendChild(el('span', 'tday-allday-label', 'All day'));
    for (const { untimed } of days) {
      const cell = el('div', 'tday-cell');
      for (const it of untimed) {
        // className, NOT classList.add: itemTypeClass can return two tokens.
        const chip = el('button', `item-open tday-chip ${itemTypeClass(it)}`, it.title);
        chip.type = 'button';
        // How app.js's focusOpener finds this button again.
        chip.setAttribute('data-item-id', it.id);
        if (it.external) chip.style.setProperty('--feed-color', it.feedColor);
        chip.addEventListener('click', () => onOpen(it));
        cell.appendChild(chip);
      }
      strip.appendChild(cell);
    }
    container.appendChild(strip);
  }

  const grid = el('div', 'tday-grid');
  const hours = el('div', 'tday-hours');
  for (let h = 0; h < 24; h++) hours.appendChild(el('div', 'tday-hour', hourLabel(h)));
  grid.appendChild(hours);

  for (const { timed } of days) {
    const col = el('div', 'tday-col');
    col.style.height = `${24 * HOUR_PX}px`;
    for (let h = 0; h < 24; h++) {
      const line = el('div', 'hour-line');
      line.style.top = `${h * HOUR_PX}px`;
      col.appendChild(line);
    }
    for (const row of layoutDayBlocks(timed)) {
      const block = el('div', `${row.pinned ? 'day-pin' : 'day-block'} tday-block ${itemTypeClass(row.item)}`);
      if (row.item.external) block.style.setProperty('--feed-color', row.item.feedColor);
      block.style.top = `${(row.startMin / 60) * HOUR_PX}px`;
      block.style.height = `${((row.endMin - row.startMin) / 60) * HOUR_PX - 2}px`;
      block.style.left = `${(row.col / row.cols) * 100}%`;
      block.style.width = `calc(${100 / row.cols}% - 2px)`;
      const when = row.item.endTime ? formatTimeRange(row.item.time, row.item.endTime) : formatTime(row.item.time);
      // No ×: a column is too narrow for one, and the sheet has Delete.
      const open = el('button', 'item-open');
      open.type = 'button';
      open.setAttribute('data-item-id', row.item.id);
      // The visible time drops AM/PM; the accessible name keeps it.
      open.setAttribute('aria-label', `${when} ${row.item.title}`);
      open.append(el('span', 'tday-time', shortTime(row.item.time)), el('span', 'tday-title', row.item.title));
      open.addEventListener('click', () => onOpen(row.item));
      block.appendChild(open);
      col.appendChild(block);
    }
    grid.appendChild(col);
  }

  // THESE TWO LINES MUST STAY ADJACENT, AND MUST STAY LAST (as in
  // js/dayview.js): scrollTop written to an element not yet in the document
  // is a SILENT no-op in a browser, and the grid would open at midnight.
  container.appendChild(grid);
  grid.scrollTop = autoScroll ? SCROLL_TO_HOUR * HOUR_PX : prev;
}
