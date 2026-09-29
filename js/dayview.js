// dayview.js — render one day: "Other tasks" above, then the hour grid of
// timed items. (V6 § 4 moved the untimed block above the grid; before that it
// was appended below.)
import { bucketDayItems, layoutDayBlocks, formatTime, formatTimeRange } from './timegrid.js';
import { itemTypeClass } from './calendar.js';

const HOUR_PX = 48;
const SCROLL_TO_HOUR = 7; // grid shows 24h; auto-scroll to 07:00

export function renderDayView(container, dateISO, dayItems, { onOpen, onDelete, autoScroll = true }) {
  // Required: a missing one would render blocks that do nothing on tap.
  if (typeof onOpen !== 'function') throw new Error('renderDayView requires onOpen');
  const prev = container.querySelector('.day-grid')?.scrollTop ?? 0;
  container.innerHTML = '';
  const { untimed, timed } = bucketDayItems(dayItems);

  const grid = document.createElement('div');
  grid.className = 'day-grid';

  const hours = document.createElement('div');
  hours.className = 'day-hours';
  const canvas = document.createElement('div');
  canvas.className = 'day-canvas';
  canvas.style.height = `${24 * HOUR_PX}px`;

  for (let h = 0; h < 24; h++) {
    const label = document.createElement('div');
    label.className = 'day-hour';
    label.textContent = formatTime(`${String(h).padStart(2, '0')}:00`);
    hours.appendChild(label);
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = `${h * HOUR_PX}px`;
    canvas.appendChild(line);
  }

  for (const row of layoutDayBlocks(timed)) {
    const el = document.createElement('div');
    el.className = (row.pinned ? 'day-pin' : 'day-block') + ' ' + itemTypeClass(row.item);
    if (row.item.external) el.style.setProperty('--feed-color', row.item.feedColor);
    el.style.top = `${(row.startMin / 60) * HOUR_PX}px`;
    el.style.height = `${((row.endMin - row.startMin) / 60) * HOUR_PX - 2}px`;
    el.style.left = `${(row.col / row.cols) * 100}%`;
    el.style.width = `calc(${100 / row.cols}% - 4px)`;
    const when = row.item.endTime
      ? formatTimeRange(row.item.time, row.item.endTime)
      : formatTime(row.item.time);
    // The block itself carries NO click handler: it contains the ×, and a tap
    // on the × must not also open the sheet. The open control is a button
    // inside the block, and the × is its sibling.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'item-open';
    // How app.js finds this button again to return focus to it.
    open.setAttribute('data-item-id', row.item.id);
    open.textContent = `${when} ${row.item.title}`;
    open.addEventListener('click', () => onOpen(row.item));
    el.appendChild(open);
    // External items aren't deletable — no × for them.
    if (!row.item.external) {
      const del = document.createElement('button');
      del.className = 'day-del';
      del.textContent = '×';
      del.setAttribute('aria-label', `Delete ${row.item.title}`);
      del.addEventListener('click', () => onDelete(row.item.id));
      el.appendChild(del);
    }
    canvas.appendChild(el);
  }

  grid.append(hours, canvas);

  if (untimed.length > 0) {
    const other = document.createElement('div');
    other.className = 'other-tasks';
    const h3 = document.createElement('h3');
    h3.textContent = 'Other tasks';
    other.appendChild(h3);
    const ul = document.createElement('ul');
    ul.className = 'day-other-list'; // shares the list styling via Task 6's selectors
    for (const it of untimed) {
      const li = document.createElement('li');
      // className, NOT classList.add: itemTypeClass can return two tokens
      // ('type-task done') and classList.add throws on a token with a space.
      li.className = itemTypeClass(it);
      if (it.external) li.style.setProperty('--feed-color', it.feedColor);
      // Delete stays a sibling of the open button (see the timed blocks).
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'item-open';
      open.setAttribute('data-item-id', it.id);
      open.textContent = it.title;
      open.addEventListener('click', () => onOpen(it));
      li.appendChild(open);
      // Not deletable — same rule as the timed blocks above.
      if (!it.external) {
        const del = document.createElement('button');
        del.className = 'delete';
        del.textContent = 'Delete';
        del.addEventListener('click', () => onDelete(it.id));
        li.appendChild(del);
      }
      ul.appendChild(li);
    }
    other.appendChild(ul);
    container.appendChild(other);
  }

  // THESE TWO LINES MUST STAY ADJACENT, AND MUST STAY LAST (V6 spec § 4).
  // Assigning scrollTop to an element that is not yet in the document is a
  // SILENT no-op in a browser — the day view would simply open at midnight
  // instead of 07:00, with no error anywhere. The untimed block is appended
  // above, so the grid goes in after it and the scroll position is set once
  // the tree is complete.
  container.appendChild(grid);
  grid.scrollTop = autoScroll ? SCROLL_TO_HOUR * HOUR_PX : prev;
}
