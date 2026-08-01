import { loadItems, saveItems, loadFeeds, loadFeedCache } from './storage.js';
import { makeItem, sortItemsByDate } from './items.js';
import { toISO } from './dateparse.js';
import { buildMonthGrid, groupItemsByDate, monthCellSummary, chronoFirst, itemTypeClass } from './calendar.js';
import { startOfWeek, addDays, formatTime, formatTimeRange } from './timegrid.js';
import { parseViaWorker, decideFlow } from './smartadd.js';
import { renderDayView } from './dayview.js';
import { renderWeekView } from './weekview.js';
import { renderPreview } from './preview.js';
import { isVoiceSupported, dictate } from './voice.js';
import { initSettings } from './settings.js';
import { instancesForRange, syncStale } from './feeds.js';
import { uid } from './uid.js';

const els = {
  text: document.getElementById('entry-text'),
  mic: document.getElementById('mic-btn'),
  date: document.getElementById('entry-date'),
  time: document.getElementById('entry-time'),
  end: document.getElementById('entry-end'),
  add: document.getElementById('add-btn'),
  message: document.getElementById('message'),
  preview: document.getElementById('preview'),
  listView: document.getElementById('list-view'),
  list: document.getElementById('item-list'),
  calView: document.getElementById('calendar-view'),
  prev: document.getElementById('prev-month'),
  next: document.getElementById('next-month'),
  calLabel: document.getElementById('calendar-label'),
  calGrid: document.getElementById('calendar-grid'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsHost: document.getElementById('settings-host'),
  showList: document.getElementById('show-list'),
  showMonth: document.getElementById('show-month'),
  showWeek: document.getElementById('show-week'),
  showDay: document.getElementById('show-day'),
  weekView: document.getElementById('week-view'),
  weekLabel: document.getElementById('week-label'),
  weekGrid: document.getElementById('week-grid'),
  prevWeek: document.getElementById('prev-week'),
  nextWeek: document.getElementById('next-week'),
  dayView: document.getElementById('day-view'),
  dayLabel: document.getElementById('day-label'),
  dayBody: document.getElementById('day-body'),
  prevDay: document.getElementById('prev-day'),
  nextDay: document.getElementById('next-day'),
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let items = loadItems();
let viewMonth = new Date();
let viewDay = toISO(new Date());
let viewWeekStart = startOfWeek(viewDay);

// External calendars (Task 6/7) — feeds + cache are read once at load; the
// only thing that changes them afterward is a background sync settling (see
// bottom of file), which reloads the cache and re-renders once.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const LIST_EXTERNAL_HORIZON_DAYS = 366;
let feeds = loadFeeds();
let feedCache = loadFeedCache();

// visibleItems: own items (unbounded) ++ every visible feed's instances for
// [start, end]. Own items are never range-limited here — only the caller's
// choice of [start, end] bounds how far external instances are expanded.
function visibleItems(start, end) {
  return [...items, ...instancesForRange(feeds, feedCache, start, end, DEVICE_TZ)];
}

// In-app dictation — only surface the mic where the browser supports it.
// (On iPhone, the keyboard's own mic is always available regardless.)
if (els.mic && isVoiceSupported()) {
  els.mic.hidden = false;
  let listening = false;
  els.mic.addEventListener('click', () => {
    if (listening) return;
    dictate({
      onStart: () => { listening = true; els.mic.classList.add('listening'); setMessage('Listening — speak now.'); },
      onResult: (text) => { els.text.value = text; },
      onEnd: () => { listening = false; els.mic.classList.remove('listening'); if (els.text.value) setMessage('Got it — tap Add.'); },
      onError: () => { listening = false; els.mic.classList.remove('listening'); setMessage("Didn't catch that — try again or type it."); },
    });
  });
}

// onFeedsChanged: settings.js's DOM glue (Task 8) mutates feeds/feedCache
// only through storage.js/feeds.js, then calls this so app.js reloads its
// own snapshot and re-renders — same "reload + render once" shape as the
// background sync settle below, just triggered by user action instead of a
// timer.
initSettings({
  button: els.settingsBtn,
  host: els.settingsHost,
  onFeedsChanged: () => { feeds = loadFeeds(); feedCache = loadFeedCache(); render(); },
});

function setMessage(t) { els.message.textContent = t || ''; }

function addItems(list) {
  const made = list.map((it) => makeItem(it, { id: uid(), createdAt: toISO(new Date()) }));
  items.push(...made);
  saveItems(items);
  render();
}

// Manual add: title box + date box, type defaults to general. Works with no network.
function handleManualAdd() {
  const title = els.text.value.trim();
  const date = els.date.value;
  if (!title || !date) { setMessage('For manual add, type a title and pick a date.'); return; }
  try {
    addItems([{ title, date, type: 'general', time: els.time.value || null, endTime: els.end.value || null }]);
  } catch (e) { setMessage(e.message); return; }
  els.text.value = ''; els.date.value = ''; els.time.value = ''; els.end.value = ''; els.end.hidden = true;
  setMessage('Added.');
}

async function handleAdd() {
  if (els.time.value && !els.date.value) {
    setMessage('Add a date to use that time, or clear the time to use smart add.');
    return;
  }
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
    if (e.message === 'too_long') setMessage('That was a lot at once — try adding fewer items in one go.');
    else setMessage('Smart add is unavailable — pick a date below and tap Add to add it manually.');
    return;
  }

  const flow = decideFlow(result);
  if (flow === 'empty') { setMessage("I couldn't find anything to add — try rephrasing."); return; }
  if (flow === 'direct') {
    try {
      addItems(result.items);
    } catch (e) { setMessage(e.message); return; }
    els.text.value = '';
    setMessage('Added.');
    return;
  }
  setMessage('Review the items below.');
  renderPreview(els.preview, result.items, {
    onConfirm: (confirmed) => {
      try { addItems(confirmed); } catch (e) { setMessage(e.message); return false; }
      els.text.value = '';
      setMessage('Added.');
      return true;
    },
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
  // External horizon: today -> today+366d. Own items beyond it still render
  // (visibleItems never range-limits `items`) — only the external instances
  // fetched here are bounded, per the design doc's list-view horizon.
  const todayISO = toISO(new Date());
  const horizonISO = addDays(todayISO, LIST_EXTERNAL_HORIZON_DAYS);
  const sorted = sortItemsByDate(visibleItems(todayISO, horizonISO));
  els.list.innerHTML = '';
  if (sorted.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Add something above.';
    els.list.appendChild(li);
  } else {
    for (const it of sorted) {
      const li = document.createElement('li');
      li.classList.add(itemTypeClass(it));
      if (it.external) li.style.setProperty('--feed-color', it.feedColor);
      const main = document.createElement('div');
      const info = document.createElement('span');
      info.textContent = `${it.date} — ${it.title}`;
      main.appendChild(info);
      if (it.time) {
        const t = document.createElement('div');
        t.className = 'time-line';
        t.textContent = it.endTime ? formatTimeRange(it.time, it.endTime) : formatTime(it.time);
        main.appendChild(t);
      }
      main.appendChild(tagChips(it));
      li.appendChild(main);
      // External items aren't deletable from the planner — there's nothing
      // in `items` to remove, and the feed will just resupply them anyway.
      if (!it.external) {
        const del = document.createElement('button');
        del.className = 'delete';
        del.textContent = 'Delete';
        del.addEventListener('click', () => deleteItem(it.id));
        li.appendChild(del);
      }
      els.list.appendChild(li);
    }
  }
  if (feeds.some((f) => !f.hidden)) {
    const note = document.createElement('li');
    note.className = 'list-note';
    note.textContent = `external calendars shown through ${horizonISO}`;
    els.list.appendChild(note);
  }
}

function renderCalendar() {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  els.calLabel.textContent = `${MONTH_NAMES[month]} ${year}`;
  const weeks = buildMonthGrid(year, month);
  // buildMonthGrid only ever fills cells with dates from this month (blanks
  // elsewhere), so the visible range is simply the month's own first/last day.
  const monthStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthEnd = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const byDate = groupItemsByDate(sortItemsByDate(visibleItems(monthStart, monthEnd)));
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
      const { chips, more } = monthCellSummary(chronoFirst(byDate[cell.date] || []));
      for (const it of chips) {
        const chip = document.createElement('div');
        chip.className = 'cal-item ' + itemTypeClass(it);
        if (it.external) chip.style.setProperty('--feed-color', it.feedColor);
        chip.textContent = it.title;
        div.appendChild(chip);
      }
      if (more > 0) {
        const m = document.createElement('div');
        m.className = 'cal-more';
        m.textContent = `+${more} more`;
        div.appendChild(m);
      }
      div.addEventListener('click', () => openDay(cell.date));
      els.calGrid.appendChild(div);
    }
  }
}

function renderWeek() {
  const end = addDays(viewWeekStart, 6);
  els.weekLabel.textContent = `${viewWeekStart.slice(5).replace('-', '/')} – ${end.slice(5).replace('-', '/')}`;
  renderWeekView(els.weekGrid, viewWeekStart,
    groupItemsByDate(sortItemsByDate(visibleItems(viewWeekStart, end))), toISO(new Date()),
    { onSelectDay: openDay });
}

let lastDayRendered = null;

function renderDay() {
  const [y, m, d] = viewDay.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
  els.dayLabel.textContent = label;
  const byDate = groupItemsByDate(sortItemsByDate(visibleItems(viewDay, viewDay)));
  const visible = !els.dayView.hidden;
  renderDayView(els.dayBody, viewDay, byDate[viewDay] || [], {
    onDelete: deleteItem,
    // Auto-scroll to 07:00 only on a genuine day change while visible; otherwise
    // dayview.js restores the grid's own prior scrollTop (see its `prev` capture).
    // A hidden day-view has scrollTop 0, so lastDayRendered must not advance while hidden —
    // otherwise the first visible open of a day would skip auto-scroll and land at midnight.
    autoScroll: visible && viewDay !== lastDayRendered,
  });
  if (visible) lastDayRendered = viewDay;
}

function render() { renderList(); renderCalendar(); renderWeek(); renderDay(); }

function showView(which) {
  const views = { list: els.listView, month: els.calView, week: els.weekView, day: els.dayView };
  const buttons = { list: els.showList, month: els.showMonth, week: els.showWeek, day: els.showDay };
  for (const [name, el] of Object.entries(views)) el.hidden = name !== which;
  for (const [name, b] of Object.entries(buttons)) b.classList.toggle('active', name === which);
  render();
}

function openDay(dateISO) {
  viewDay = dateISO;
  viewWeekStart = startOfWeek(dateISO);
  showView('day');
}

els.time.addEventListener('input', () => { els.end.hidden = !els.time.value; if (!els.time.value) els.end.value = ''; });
els.add.addEventListener('click', handleAdd);
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdd(); });
els.showList.addEventListener('click', () => showView('list'));
els.showMonth.addEventListener('click', () => showView('month'));
els.showWeek.addEventListener('click', () => showView('week'));
els.showDay.addEventListener('click', () => showView('day'));
els.prev.addEventListener('click', () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1); renderCalendar(); });
els.next.addEventListener('click', () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1); renderCalendar(); });
els.prevDay.addEventListener('click', () => { viewDay = addDays(viewDay, -1); render(); });
els.nextDay.addEventListener('click', () => { viewDay = addDays(viewDay, 1); render(); });
els.prevWeek.addEventListener('click', () => { viewWeekStart = addDays(viewWeekStart, -7); render(); });
els.nextWeek.addEventListener('click', () => { viewWeekStart = addDays(viewWeekStart, 7); render(); });

render();

// Background sync: never block first paint on the network — render() above
// already ran from whatever's in cache. Feeds sync sequentially inside
// syncStale and this settles once for the whole batch, so re-render happens
// exactly once here, not per feed.
//
// syncStale's per-feed failures (unreachable, bad response, parse error) are
// all caught inside syncFeed and returned as {ok:false, error} — those never
// reject this promise. A genuine storage-layer bug (a non-QuotaError thrown
// from saveFeedCache; see feeds.js's syncFeed) is NOT swallowed there by
// design and escapes as a rejection, ending the sequential batch early. Any
// feeds that synced before that throw already landed in the persisted
// cache, so the .catch() below still reloads it and re-renders rather than
// leaving the view stuck on stale first-paint data. The failure itself is
// only logged by error name — never the feed object/URL (capability-token
// rule: a feed URL can carry an access token in its path/query).
if (feeds.length > 0) {
  syncStale(feeds, feedCache, { fetchImpl: fetch }).then(() => {
    feedCache = loadFeedCache();
    render();
  }).catch((err) => {
    feedCache = loadFeedCache();
    render();
    console.error('plaenicke: background calendar sync failed', err && err.name);
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('service-worker.js'); });
}
