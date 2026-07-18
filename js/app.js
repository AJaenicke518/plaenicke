import { loadItems, saveItems } from './storage.js';
import { makeItem, sortItemsByDate } from './items.js';
import { parseSmartAdd, toISO } from './dateparse.js';
import { buildMonthGrid, groupItemsByDate } from './calendar.js';

const els = {
  text: document.getElementById('entry-text'),
  date: document.getElementById('entry-date'),
  add: document.getElementById('add-btn'),
  message: document.getElementById('message'),
  showList: document.getElementById('show-list'),
  showCal: document.getElementById('show-calendar'),
  listView: document.getElementById('list-view'),
  list: document.getElementById('item-list'),
  calView: document.getElementById('calendar-view'),
  prev: document.getElementById('prev-month'),
  next: document.getElementById('next-month'),
  calLabel: document.getElementById('calendar-label'),
  calGrid: document.getElementById('calendar-grid'),
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let items = loadItems();
let viewMonth = new Date();

function uid() {
  return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

function setMessage(text) {
  els.message.textContent = text || '';
}

function handleAdd() {
  const raw = els.text.value;
  const parsed = parseSmartAdd(raw, new Date());
  const title = parsed.title || raw.trim();
  const date = parsed.date || els.date.value || '';

  if (!title) { setMessage('Please enter a title.'); return; }
  if (!date) {
    setMessage("I couldn't find a date in that — please pick one below.");
    els.date.focus();
    return;
  }

  items.push(makeItem(title, date, { id: uid(), createdAt: toISO(new Date()) }));
  saveItems(items);
  els.text.value = '';
  els.date.value = '';
  setMessage('Added.');
  render();
}

function deleteItem(id) {
  items = items.filter(it => it.id !== id);
  saveItems(items);
  render();
}

function renderList() {
  const sorted = sortItemsByDate(items);
  els.list.innerHTML = '';
  if (sorted.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Add something above.';
    els.list.appendChild(li);
    return;
  }
  for (const it of sorted) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.textContent = `${it.date} — ${it.title}`;
    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteItem(it.id));
    li.append(info, del);
    els.list.appendChild(li);
  }
}

function renderCalendar() {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  els.calLabel.textContent = `${MONTH_NAMES[month]} ${year}`;

  const weeks = buildMonthGrid(year, month);
  const byDate = groupItemsByDate(items);
  const todayISO = toISO(new Date());

  els.calGrid.innerHTML = '';
  for (const d of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    const h = document.createElement('div');
    h.className = 'cal-head';
    h.textContent = d;
    els.calGrid.appendChild(h);
  }
  for (const week of weeks) {
    for (const cell of week) {
      const div = document.createElement('div');
      div.className = 'cal-cell';
      if (!cell) {
        div.classList.add('blank');
        els.calGrid.appendChild(div);
        continue;
      }
      if (cell.date === todayISO) div.classList.add('today');
      const num = document.createElement('div');
      num.className = 'cal-day';
      num.textContent = cell.day;
      div.appendChild(num);
      for (const it of byDate[cell.date] || []) {
        const chip = document.createElement('div');
        chip.className = 'cal-item';
        chip.textContent = it.title;
        div.appendChild(chip);
      }
      els.calGrid.appendChild(div);
    }
  }
}

function render() {
  renderList();
  renderCalendar();
}

function showView(which) {
  const isList = which === 'list';
  els.listView.hidden = !isList;
  els.calView.hidden = isList;
  els.showList.classList.toggle('active', isList);
  els.showCal.classList.toggle('active', !isList);
}

els.add.addEventListener('click', handleAdd);
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdd(); });
els.showList.addEventListener('click', () => showView('list'));
els.showCal.addEventListener('click', () => showView('calendar'));
els.prev.addEventListener('click', () => {
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1);
  renderCalendar();
});
els.next.addEventListener('click', () => {
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1);
  renderCalendar();
});

render();

// Register the service worker so the app can be installed to the home screen.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js');
  });
}
