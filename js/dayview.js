// dayview.js — render one day: hour grid of timed items + "Other tasks" below.
import { bucketDayItems, layoutDayBlocks, formatTime, formatTimeRange } from './timegrid.js';

const HOUR_PX = 48;
const SCROLL_TO_HOUR = 7; // grid shows 24h; auto-scroll to 07:00

export function renderDayView(container, dateISO, dayItems, { onDelete, autoScroll = true }) {
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
    el.className = (row.pinned ? 'day-pin' : 'day-block') + ' type-' + (row.item.type || 'general');
    el.style.top = `${(row.startMin / 60) * HOUR_PX}px`;
    el.style.height = `${((row.endMin - row.startMin) / 60) * HOUR_PX - 2}px`;
    el.style.left = `${(row.col / row.cols) * 100}%`;
    el.style.width = `calc(${100 / row.cols}% - 4px)`;
    const when = row.item.endTime
      ? formatTimeRange(row.item.time, row.item.endTime)
      : formatTime(row.item.time);
    el.textContent = `${when} ${row.item.title}`;
    const del = document.createElement('button');
    del.className = 'day-del';
    del.textContent = '×';
    del.setAttribute('aria-label', `Delete ${row.item.title}`);
    del.addEventListener('click', () => onDelete(row.item.id));
    el.appendChild(del);
    canvas.appendChild(el);
  }

  grid.append(hours, canvas);
  container.appendChild(grid);
  grid.scrollTop = autoScroll ? SCROLL_TO_HOUR * HOUR_PX : prev;

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
      li.classList.add('type-' + (it.type || 'general'));
      const span = document.createElement('span');
      span.textContent = it.title;
      const del = document.createElement('button');
      del.className = 'delete';
      del.textContent = 'Delete';
      del.addEventListener('click', () => onDelete(it.id));
      li.append(span, del);
      ul.appendChild(li);
    }
    other.appendChild(ul);
    container.appendChild(other);
  }
}
