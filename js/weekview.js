// weekview.js — 7 squeezed columns of colored blocks; the "shape of your week".
// Columns cap at 8 blocks + a "+N" marker so one busy day can't stretch the row.
import { addDays, weekdayNames } from './timegrid.js';
import { chronoFirst, itemTypeClass } from './calendar.js';

// The head name comes from the date itself (Sunday-indexed), not from the
// column index, so a Monday-start week reads Mon..Sun.
const DOW = weekdayNames('sun');
const dowOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };

export function renderWeekView(container, weekStartISO, itemsByDate, todayISO, { onSelectDay }) {
  container.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const dateISO = addDays(weekStartISO, i);
    const col = document.createElement('div');
    col.className = 'week-col';
    if (dateISO === todayISO) col.classList.add('today');

    const head = document.createElement('div');
    head.className = 'week-head';
    head.textContent = DOW[dowOf(dateISO)];
    const num = document.createElement('b');
    num.textContent = String(Number(dateISO.slice(8)));
    head.appendChild(num);
    col.appendChild(head);

    const dayItems = chronoFirst(itemsByDate[dateISO] || []);
    for (const it of dayItems.slice(0, 8)) {
      const block = document.createElement('div');
      block.className = 'week-block ' + itemTypeClass(it);
      if (it.external) block.style.setProperty('--feed-color', it.feedColor);
      col.appendChild(block);
    }
    if (dayItems.length > 8) {
      const more = document.createElement('div');
      more.className = 'week-more';
      more.textContent = `+${dayItems.length - 8}`;
      col.appendChild(more);
    }

    // Keyboard-reachable like a button: Enter or Space selects the day too
    // (Space is cancelled, or it would also scroll the page).
    col.setAttribute('role', 'button');
    col.setAttribute('tabindex', '0');
    col.addEventListener('click', () => onSelectDay(dateISO));
    col.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDay(dateISO); }
    });
    container.appendChild(col);
  }
}
