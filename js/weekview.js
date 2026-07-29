// weekview.js — 7 squeezed columns of colored blocks; the "shape of your week".
// Columns cap at 8 blocks + a "+N" marker so one busy day can't stretch the row.
import { addDays } from './timegrid.js';
import { chronoFirst } from './calendar.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function renderWeekView(container, weekStartISO, itemsByDate, todayISO, { onSelectDay }) {
  container.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const dateISO = addDays(weekStartISO, i);
    const col = document.createElement('div');
    col.className = 'week-col';
    if (dateISO === todayISO) col.classList.add('today');

    const head = document.createElement('div');
    head.className = 'week-head';
    head.textContent = DOW[i];
    const num = document.createElement('b');
    num.textContent = String(Number(dateISO.slice(8)));
    head.appendChild(num);
    col.appendChild(head);

    const dayItems = chronoFirst(itemsByDate[dateISO] || []);
    for (const it of dayItems.slice(0, 8)) {
      const block = document.createElement('div');
      block.className = 'week-block type-' + (it.type || 'general');
      col.appendChild(block);
    }
    if (dayItems.length > 8) {
      const more = document.createElement('div');
      more.className = 'week-more';
      more.textContent = `+${dayItems.length - 8}`;
      col.appendChild(more);
    }

    col.addEventListener('click', () => onSelectDay(dateISO));
    container.appendChild(col);
  }
}
