import { loadItems, saveItems } from './storage.js';
import { makeItem, sortItemsByDate } from './items.js';
import { toISO } from './dateparse.js';
import { buildMonthGrid, groupItemsByDate } from './calendar.js';
import { parseViaWorker, decideFlow } from './smartadd.js';
import { renderPreview } from './preview.js';
import { getPassphrase, setPassphrase } from './config.js';

const els = {
  text: document.getElementById('entry-text'),
  pass: document.getElementById('passphrase'),
  date: document.getElementById('entry-date'),
  add: document.getElementById('add-btn'),
  message: document.getElementById('message'),
  preview: document.getElementById('preview'),
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

if (els.pass) {
  els.pass.value = getPassphrase();
  els.pass.addEventListener('change', () => setPassphrase(els.pass.value));
}

function uid() { return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e6); }
function setMessage(t) { els.message.textContent = t || ''; }

function addItems(list) {
  for (const it of list) {
    items.push(makeItem(it, { id: uid(), createdAt: toISO(new Date()) }));
  }
  saveItems(items);
  render();
}

// Manual add: title box + date box, type defaults to general. Works with no network.
function handleManualAdd() {
  const title = els.text.value.trim();
  const date = els.date.value;
  if (!title || !date) { setMessage('For manual add, type a title and pick a date.'); return; }
  addItems([{ title, date, type: 'general' }]);
  els.text.value = '';
  els.date.value = '';
  setMessage('Added.');
}

async function handleAdd() {
  // If a date is picked, treat Add as an explicit MANUAL add — no Worker needed.
  // This is the always-available fallback (works offline and on iPhone).
  if (els.date.value) { handleManualAdd(); return; }

  const raw = els.text.value.trim();
  if (!raw) { setMessage('Type something first.'); return; }
  setMessage('Thinking…');

  let result;
  try {
    result = await parseViaWorker(raw);
  } catch (e) {
    if (e.message === 'unauthorized') setMessage('Wrong or missing passphrase — check the field above.');
    else if (e.message === 'too_long') setMessage('That was a lot at once — try adding fewer items in one go.');
    else setMessage('Smart add is unavailable — pick a date below and tap Add to add it manually.');
    return;
  }

  const flow = decideFlow(result);
  if (flow === 'empty') { setMessage("I couldn't find anything to add — try rephrasing."); return; }
  if (flow === 'direct') {
    addItems(result.items);
    els.text.value = '';
    setMessage('Added.');
    return;
  }
  setMessage('Review the items below.');
  renderPreview(els.preview, result.items, {
    onConfirm: (confirmed) => { addItems(confirmed); els.text.value = ''; setMessage('Added.'); },
    onCancel: () => setMessage('Cancelled.'),
  });
}

function deleteItem(id) {
  items = items.filter((it) => it.id !== id);
  saveItems(items);
  render();
}

function tagChips(it) {
  const wrap = document.createElement('div');
  wrap.className = 'tags';
  for (const val of [it.project, it.subject, it.category]) {
    if (val) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = val; wrap.appendChild(s); }
  }
  return wrap;
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
    li.classList.add('type-' + (it.type || 'general'));
    const main = document.createElement('div');
    const info = document.createElement('span');
    info.textContent = `${it.date} — ${it.title}`;
    main.appendChild(info);
    main.appendChild(tagChips(it));
    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteItem(it.id));
    li.append(main, del);
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
      if (!cell) { div.classList.add('blank'); els.calGrid.appendChild(div); continue; }
      if (cell.date === todayISO) div.classList.add('today');
      const num = document.createElement('div');
      num.className = 'cal-day';
      num.textContent = cell.day;
      div.appendChild(num);
      for (const it of byDate[cell.date] || []) {
        const chip = document.createElement('div');
        chip.className = 'cal-item type-' + (it.type || 'general');
        chip.textContent = it.title;
        div.appendChild(chip);
      }
      els.calGrid.appendChild(div);
    }
  }
}

function render() { renderList(); renderCalendar(); }

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
els.prev.addEventListener('click', () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1); renderCalendar(); });
els.next.addEventListener('click', () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1); renderCalendar(); });

render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('service-worker.js'); });
}
