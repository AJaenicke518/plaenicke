import {
  loadItems, saveItems, loadFeeds, loadFeedCache, addTombstone,
  loadTombstones, saveTombstones, recordLaunch,
} from './storage.js';
import { followToday, formatDayLabel } from './freshness.js';
import {
  makeItem, sortItemsByDate, isScheduled, isTodo, isIdea, sortIdeasNewestFirst,
} from './items.js';
import { normalizeIdea } from './ideas.js';
import { renderTodoView } from './todoview.js';
import { renderIdeasView } from './ideasview.js';
import { toISO, nowISO } from './dateparse.js';
import { buildMonthGrid, groupItemsByDate, monthCellSummary, chronoFirst, itemTypeClass } from './calendar.js';
import { startOfWeek, addDays, formatTime, formatTimeRange } from './timegrid.js';
import { parseViaWorker, decideFlow } from './smartadd.js';
import { renderDayView } from './dayview.js';
import { renderWeekView } from './weekview.js';
import { renderPreview } from './preview.js';
import { isVoiceSupported, dictate } from './voice.js';
import { initSettings } from './settings.js';
import { instancesForRange, syncStale, applyRemoteFeeds, inferName } from './feeds.js';
import { openItemSheet } from './itemsheet.js';
import { showToast } from './toast.js';
import { applyEdit, typeChangePatch, snapshotOf, EDITABLE_FIELDS } from './edit.js';
import { uid } from './uid.js';
import { syncOnce } from './sync.js';
import { isLinked, isAdoptionPending } from './auth.js';
import { merge, SCHEMA_VERSION } from './merge.js';
import { renderSyncStatus } from './linkui.js';
import { WORKER_URL } from './config.js';

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
  sheetHost: document.getElementById('sheet-host'),
  toastHost: document.getElementById('toast-host'),
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
  // V6 — the To-do and Ideas pages.
  showTodo: document.getElementById('show-todo'),
  showIdeas: document.getElementById('show-ideas'),
  todoView: document.getElementById('todo-view'),
  todoList: document.getElementById('todo-list'),
  ideasView: document.getElementById('ideas-view'),
  ideaList: document.getElementById('idea-list'),
  ideaText: document.getElementById('idea-text'),
  ideaAdd: document.getElementById('idea-add'),
  updatedStamp: document.getElementById('updated-stamp'),
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let items = loadItems();
let viewMonth = new Date();
let viewDay = toISO(new Date());
let viewWeekStart = startOfWeek(viewDay);
// What app.js believed "today" was the last time it looked. iOS resumes a
// home-screen web app instead of reloading it, so the cursors above would
// otherwise stay on the day the app was first opened. refreshForToday() moves
// every cursor that was showing this day onto the real one.
let lastToday = viewDay;

// External calendars (Task 6/7) — feeds + cache are read once at load; the
// only thing that changes them afterward is a background sync settling (see
// bottom of file), which reloads the cache and re-renders once.
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const LIST_EXTERNAL_HORIZON_DAYS = 366;
let feeds = loadFeeds();
let feedCache = loadFeedCache();

// Deletes offered for Undo (edit-items Task 4b). A pending id is still in
// `items` and in storage — nothing is written until commitDelete — but it is
// hidden from every page. liveItems() is the one place that hides it, and
// every page reads through it, so a delete tapped on one page cannot linger
// on another.
const pendingDeletes = new Set();

function liveItems() { return items.filter((it) => !pendingDeletes.has(it.id)); }

// visibleItems: own items (unbounded) ++ every visible feed's instances for
// [start, end]. Own items are never range-limited here — only the caller's
// choice of [start, end] bounds how far external instances are expanded.
//
// THE isScheduled FILTER IS THE SINGLE CHOKEPOINT for list, month, week and
// day (V6 § 7.1), so one filter covers all four. It has to be here and not in
// groupItemsByDate: renderList calls sortItemsByDate(visibleItems(...))
// DIRECTLY and iterates the result — groupItemsByDate is never involved on the
// default view. Forgetting this is visible (an idea turns up on the calendar
// on its capture day) rather than silently correct.
//
// External feed instances carry no `type`, so isScheduled passes them through
// — by design, not by accident: a feed event is always a scheduled thing.
function visibleItems(start, end) {
  return [
    ...liveItems().filter(isScheduled),
    ...instancesForRange(feeds, feedCache, start, end, DEVICE_TZ),
  ];
}

// THE To-do AND Ideas PAGES READ `items` DIRECTLY, never visibleItems (V6
// § 3.3). External feed instances carry no `type`, so they would fail both
// predicates by ACCIDENT rather than by design — and a feed that ever grew a
// type-shaped field would start populating the To-do page.
function todoItems() { return sortItemsByDate(liveItems().filter(isTodo)); }

function ideaItems() { return sortIdeasNewestFirst(liveItems().filter(isIdea)); }

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
//
// applyState threads applySyncedState (declared below — a hoisted function
// declaration, so the reference is live here) down to linkui.js's adoption
// flow, which hands it to syncOnce. It is injected rather than imported
// there because linkui.js already supplies THIS file with renderSyncStatus;
// importing it back would close a module cycle (DA-C6).
initSettings({
  button: els.settingsBtn,
  host: els.settingsHost,
  onFeedsChanged: () => { feeds = loadFeeds(); feedCache = loadFeedCache(); render(); },
  // Adding or removing a calendar mutates SYNCED data (spec 6.3): the feed
  // record itself, and for a removal the feed tombstone removeFeed() writes.
  // onFeedsChanged fires on every colour tap too, so it is the wrong signal to
  // push on — settings.js separates the two and only this one means "the
  // account needs to know". Without it a feed change had NO push trigger at
  // all: scheduleSync's other call sites are the item writers (addItems,
  // deleteItem, setDone, editItem) and runSync's re-arm, and closing the settings modal changes neither
  // visibilityState nor connectivity.
  onSyncedDataChanged: () => scheduleSync(),
  applyState: applySyncedState,
});

function setMessage(t) { els.message.textContent = t || ''; }

export function addItems(list) {
  // createdAt stays a local calendar date (toISO) — sortItemsByDate depends
  // on its current format. updatedAt is a full-precision UTC instant
  // (nowISO), matching feed updatedAt and tombstone deletedAt so sync's
  // last-write-wins comparisons are all apples-to-apples.
  //
  // normalizeIdea is applied HERE, at the single point every capture path
  // funnels through (V6 § 6): the Ideas box, a direct smart-add, and a
  // preview confirmation — including one where the user changed the type TO
  // 'idea' in the preview. It re-derives title/notes from the complete text,
  // so the model's own split never matters and nothing can lose words. It is
  // idempotent and a no-op on every other type.
  const made = list.map((it) => makeItem(normalizeIdea(it), {
    id: uid(), createdAt: toISO(new Date()), updatedAt: nowISO(),
  }));
  items.push(...made);
  saveItems(items);
  render();
  scheduleSync();
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
  // Tombstone BEFORE the destructive write: if addTombstone throws (quota
  // exhausted, or storage blocked as in Safari Private Browsing), the item
  // is still present locally and nothing else has changed — that converges
  // to the user's intent (retry, or the item just stays). The old order
  // (save first, tombstone second) let a tombstone-write failure delete the
  // item locally with no tombstone to propagate — a silent, self-reversing
  // delete once sync ships.
  addTombstone(id, 'item', nowISO());
  items = items.filter((it) => it.id !== id);
  saveItems(items);
  render();
  scheduleSync();
}

// handleDelete: DOM-facing wrapper around deleteItem, same catch+setMessage
// shape as addItems' call sites below. Since Task 4b its ONLY caller is
// commitDelete: every view and the sheet call requestDelete, which offers
// Undo first. Calling this directly from a view would commit at once with no
// Undo. It catches so that commitDelete, run from a toast's timer or dismiss,
// never throws.
function handleDelete(id) {
  try {
    deleteItem(id);
  } catch (e) {
    setMessage(e.message);
    // commitDelete has already taken the id out of pendingDeletes, so re-render
    // from `items`. If the TOMBSTONE write failed, nothing was written and the
    // item reappears — a failed delete must not look like a successful one. If
    // the tombstone landed and saveItems then failed, `items` no longer holds
    // the record, so it stays hidden; storage still does, and the tombstone
    // removes it on the next sync (the pre-4b deleteItem behaved the same).
    render();
  }
}

// setDone — V6's To-do checkbox, and THE APP'S FIRST EDIT PATH (spec § 5.1).
//
// THE WRITE LANDS HERE, deliberately. app.js owns plaenicke.items and saves
// from this module-scope array (CLAUDE.md's ownership invariant, spec § 5.5),
// so the record is mutated IN this array and then saved — exactly the shape of
// deleteItem above. A write performed anywhere else is silently discarded the
// next time app.js saves from its own snapshot.
//
// updatedAt IS BUMPED, and that is the horn that was chosen after examining
// both. unionById's ties go to REMOTE (`>=`), so leaving updatedAt alone would
// make the next sync silently REVERT the tick — self-reverting, not
// self-correcting. Bumping it means applyTombstones can resurrect an item
// deleted on another device before the tick synced; that costs a reappearing,
// re-deletable calendar entry rather than lost data, and it is the only horn
// that converges. js/merge.js's header carries the full reasoning.
function setDone(id, done) {
  const record = items.find((it) => it.id === id);
  if (!record) return;
  record.done = done === true;
  record.updatedAt = nowISO();
  saveItems(items);
  render();
  scheduleSync();
}

// editItem — the sheet's Save (edit-items Task 4c). Returns { ok, error }.
//
// Same write shape as setDone above: the record is replaced IN the module-scope
// `items` and saved from it (the ownership invariant), with a fresh updatedAt
// from applyEdit, because unionById's ties go to remote.
//
// The index comes from `items`, NOT liveItems(): a pending delete is hidden
// from liveItems() but still in `items`, so an index found there is off by one
// for every record after it (Task 4c review I1).
//
// typeChangePatch runs HERE, against the CURRENT record. The sheet sends only
// the raw diff; filling title/notes from the record the sheet opened with
// wrote stale text back over a sync that arrived while it was open (Task 3
// review I1).
//
// `raw` skips typeChangePatch and is used ONLY by an edit's own Undo. The undo
// snapshot already holds every field the edit changed; re-running the type
// adjustment on it would treat undoing task -> idea as an idea -> task switch
// and split the idea's text instead of restoring the task's own fields.
function editItem(id, patch, { toast = true, raw = false } = {}) {
  if (pendingDeletes.has(id)) return { ok: false, error: 'This item is being deleted.' };
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return { ok: false, error: 'This item no longer exists.' };
  const before = items[idx];
  let applied;
  let next;
  try {
    applied = raw ? patch : typeChangePatch(before, patch);
    next = applyEdit(before, applied, nowISO());
  } catch (e) {
    return { ok: false, error: e.message };
  }
  items[idx] = next;
  try {
    saveItems(items);
  } catch (e) {
    items[idx] = before;
    return { ok: false, error: e.message };
  }
  render();
  scheduleSync();
  if (toast) {
    // Every key the edit could have changed: the ones applied (typeChangePatch
    // adds notes and times to the caller's), plus any editable field that
    // differs afterwards (normalizeIdea re-derives an idea's title). Only
    // these are restored, so a field a sync changed in between is kept.
    const keys = new Set(Object.keys(applied).filter((k) => EDITABLE_FIELDS.includes(k)));
    for (const k of EDITABLE_FIELDS) if (before[k] !== next[k]) keys.add(k);
    const undoSnap = snapshotOf(before, [...keys]);
    activeToast = showToast(els.toastHost, 'Saved', {
      undo: () => {
        const r = editItem(id, undoSnap, { toast: false, raw: true });
        if (!r.ok) setMessage(r.error);
      },
    });
  }
  return { ok: true };
}

// The handle of the toast currently on screen, or null. Tasks 4b and 4c assign
// it (delete and edit both offer Undo); openItem only ever dismisses it.
let activeToast = null;

// requestDelete — every delete control in the app, and the sheet's Delete,
// comes here (edit-items Task 4b). The item is hidden at once and nothing is
// written: the delete is committed by commitDelete when the toast expires or
// is dismissed (the next delete, opening an item, or going to the background).
// Undo simply stops hiding it. Showing a new toast settles the previous one
// first (js/toast.js), so deleting B commits A.
function requestDelete(id) {
  const it = items.find((x) => x.id === id);
  pendingDeletes.add(id);
  render();
  activeToast = showToast(els.toastHost, it ? `Deleted "${it.title}"` : 'Deleted.', {
    undo: () => undoDelete(id),
    onExpire: () => commitDelete(id),
  });
}

// toast.js runs undo and onExpire at most once between them, so a toast can
// never undo a delete it has already committed. The message is for any path
// that ever reaches here after a commit: say so, never silently do nothing.
// There is no "too late" branch: toast.js runs undo and onExpire at most once
// between them, so an Undo can never arrive after its commit (Task 4b review —
// that branch was unreachable and untestable, and was removed rather than kept
// as a guard that guards nothing). What CAN happen is a sync removing the item
// while its toast is up — deleted on the other device — and then the Undo has
// nothing to bring back. Say so, rather than leave a button that looks broken.
function undoDelete(id) {
  pendingDeletes.delete(id);
  render();
  if (!items.some((it) => it.id === id)) {
    setMessage('That item was deleted on your other device, so it could not be brought back.');
  }
}

// The commit is the pre-4b delete, unchanged: handleDelete writes the
// tombstone BEFORE removing the item, and catches, so an onExpire never throws
// out of a timer or a dismiss.
function commitDelete(id) {
  if (!pendingDeletes.has(id)) return;
  pendingDeletes.delete(id);
  handleDelete(id);
}

// openItem — tapping any item's title opens its sheet (edit-items spec § 3.2).
//
// The sheet gets a calendar NAME and an optional Google day link, NEVER the
// feed's URL: that URL is a capability token that is never re-displayed
// (CLAUDE.md, "Feed URLs are unrecoverable"). inferName reads the URL here, in
// app.js, and only its one-word verdict crosses into the sheet.
function openItem(item) {
  // Only the latest action can be undone, and an Undo left sitting over the
  // sheet's own buttons is a mis-tap waiting to happen. Dismissing settles
  // the toast (for a delete, that commits it).
  if (activeToast) activeToast.dismiss();
  let calendarName = null;
  let googleDayUrl = null;
  if (item.external) {
    const feed = feeds.find((f) => f.id === item.feedId);
    calendarName = feed ? feed.name : 'a linked calendar';
    if (feed && inferName(feed.url) === 'Google') {
      const [y, m, d] = item.date.split('-').map(Number);
      googleDayUrl = `https://calendar.google.com/calendar/r/day/${y}/${m}/${d}`;
    }
  }
  // openItemSheet validates BEFORE touching the host (an unknown type, a
  // missing callback), so on a throw the screen is unchanged and only the
  // message says why.
  try {
    openItemSheet(els.sheetHost, item, {
      todayISO: toISO(new Date()),
      calendarName,
      googleDayUrl,
      onSave: (p) => editItem(item.id, p),
      onDelete: () => requestDelete(item.id),
      onClose: () => {},
    });
  } catch (e) {
    setMessage(`This item can't be edited here (${e.message}).`);
  }
}

function handleToggleDone(id, done) {
  try {
    setDone(id, done);
  } catch (e) {
    setMessage(e.message);
  }
}

// The Ideas page's own capture box (spec § 6). Offline, deterministic, and the
// fallback when the Worker is unreachable — it goes through addItems like
// every other capture, so normalizeIdea and makeItem apply unchanged.
//
// The capture DATE is today, and it is a real YYYY-MM-DD string. `type` is
// what marks an idea unscheduled (spec § 3.4), never a null date.
function handleIdeaAdd() {
  const text = els.ideaText.value.trim();
  if (!text) { setMessage('Type a thought first.'); return; }
  try {
    addItems([{ title: text, notes: text, date: toISO(new Date()), type: 'idea', time: null, endTime: null }]);
  } catch (e) { setMessage(e.message); return; }
  els.ideaText.value = '';
  setMessage('Kept.');
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
      // className, NOT classList.add: itemTypeClass can return two tokens
      // ('type-task done') and classList.add throws on a token with a space.
      li.className = itemTypeClass(it);
      if (it.external) li.style.setProperty('--feed-color', it.feedColor);
      const main = document.createElement('div');
      // The title opens the item. Delete is appended to the <li> below, a
      // SIBLING of `main` — never inside anything with a click handler, so a
      // tap on Delete cannot also open the sheet.
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'item-open';
      open.textContent = `${formatDayLabel(it.date, todayISO)} — ${it.title}`;
      open.addEventListener('click', () => openItem(it));
      main.appendChild(open);
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
        del.addEventListener('click', () => requestDelete(it.id));
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
    onOpen: openItem,
    onDelete: requestDelete,
    // Auto-scroll to 07:00 only on a genuine day change while visible; otherwise
    // dayview.js restores the grid's own prior scrollTop (see its `prev` capture).
    // A hidden day-view has scrollTop 0, so lastDayRendered must not advance while hidden —
    // otherwise the first visible open of a day would skip auto-scroll and land at midnight.
    autoScroll: visible && viewDay !== lastDayRendered,
  });
  if (visible) lastDayRendered = viewDay;
}

function renderTodos() {
  renderTodoView(els.todoList, todoItems(), {
    todayISO: toISO(new Date()), onOpen: openItem, onDelete: requestDelete, onToggleDone: handleToggleDone,
  });
}

function renderIdeas() {
  renderIdeasView(els.ideaList, ideaItems(), { onOpen: openItem, onDelete: requestDelete });
}

// Every page is re-rendered on every change, so a to-do ticked on the To-do
// page also leaves the calendar views correct with no second trigger.
function render() {
  renderList(); renderCalendar(); renderWeek(); renderDay(); renderTodos(); renderIdeas();
}

function showView(which) {
  const views = {
    list: els.listView, month: els.calView, week: els.weekView, day: els.dayView,
    todo: els.todoView, ideas: els.ideasView,
  };
  const buttons = {
    list: els.showList, month: els.showMonth, week: els.showWeek, day: els.showDay,
    todo: els.showTodo, ideas: els.showIdeas,
  };
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
els.showTodo.addEventListener('click', () => showView('todo'));
els.showIdeas.addEventListener('click', () => showView('ideas'));
els.ideaAdd.addEventListener('click', handleIdeaAdd);
els.prev.addEventListener('click', () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1); renderCalendar(); });
els.next.addEventListener('click', () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1); renderCalendar(); });
els.prevDay.addEventListener('click', () => { viewDay = addDays(viewDay, -1); render(); });
els.nextDay.addEventListener('click', () => { viewDay = addDays(viewDay, 1); render(); });
els.prevWeek.addEventListener('click', () => { viewWeekStart = addDays(viewWeekStart, -7); render(); });
els.nextWeek.addEventListener('click', () => { viewWeekStart = addDays(viewWeekStart, 7); render(); });

render();
noteLaunch();
stampUpdated();

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
//
// Extracted to a named function so applySyncedState (below) can reuse the
// EXACT same quota-aware fetch + error handling for a device's freshly
// pulled feeds, rather than a second, drifting fetch path (DA-M5): a feed
// this device just learned about from sync has no cache entry yet, and the
// call below only ever runs once, at module load, over the feed list from
// that moment.
function backgroundSyncFeeds(feedList) {
  if (feedList.length === 0) return;
  syncStale(feedList, feedCache, { fetchImpl: fetch }).then(() => {
    feedCache = loadFeedCache();
    render();
  }).catch((err) => {
    feedCache = loadFeedCache();
    render();
    console.error('plaenicke: background calendar sync failed', err && err.name);
  });
}
backgroundSyncFeeds(feeds);

// --- account sync (Task 5's syncOnce, wired to the page) -------------------
//
// Sync applies through the owners of each key, never through storage
// directly. app.js owns `items`; feeds.js owns feeds. See spec 5.5.
//
// It re-merges against LIVE storage first: between the merge that produced
// `state` (in sync.js, possibly across a CAS retry) and this call there may
// have been a full PUT round trip, during which the user may have added or
// deleted here. Writing `state` wholesale would destroy those edits — and
// for a feed, destroy a URL that is never rendered anywhere and so cannot be
// re-entered. Returns what it actually wrote; sync.js pushes THAT, not the
// state it was handed.
export function applySyncedState(state, opts = {}) {
  // opts.replace is set only by the linking flow's "Replace this device".
  // The user explicitly chose to discard local data, so re-merging would
  // union it straight back in — and sync would then push it to the account
  // being joined. Replace is a LOCAL discard: nothing is tombstoned, so the
  // other devices keep their own copies.
  const live = {
    schemaVersion: SCHEMA_VERSION,
    items: loadItems(), feeds: loadFeeds(), tombstones: loadTombstones(),
  };
  const written = opts.replace ? state : merge(live, state, new Date());
  items = written.items;
  saveItems(items);
  // applyRemoteFeeds requires the COMPLETE merged feed list (written.feeds,
  // never a delta) — it deletes+tombstones every local feed absent from its
  // argument, and a partial list would propagate a deletion of every other
  // feed to every device.
  //
  // ORDER MATTERS here. On replace, applyRemoteFeeds's own removeFeed() call
  // (for every local feed absent from written.feeds) writes a real feed
  // tombstone via addTombstone() as it runs. The saveTombstones() line below
  // is what erases that: on replace, written IS state — the caller's raw
  // incoming state, not a merge — so written.tombstones carries none of
  // those just-written tombstones, and this full-overwrite save discards
  // them, keeping the "Replace is a LOCAL discard, nothing is tombstoned"
  // guarantee above true. Swap these two lines and a replace would tombstone
  // every feed it discarded locally and push those deletions to the account
  // being joined on the very next sync.
  const { added } = applyRemoteFeeds(written.feeds);
  saveTombstones(written.tombstones);
  feeds = loadFeeds();
  feedCache = loadFeedCache();
  render();
  // Newly pulled feeds must actually be fetched — otherwise a freshly linked
  // device shows the right subscriptions with zero events until a full page
  // reload (backgroundSyncFeeds above only ran once, over the load-time feed
  // list). Same quota-aware path and error handling, just fed the added ids.
  backgroundSyncFeeds(feeds.filter((f) => added.includes(f.id)));
  return written;
}

let syncInFlight = false;
let syncPending = false;
let syncTimer = null;

async function runSync() {
  // Never run while the user hasn't chosen Merge / Replace / Cancel yet
  // (spec 5.7) — that choice is what supplies opts.replace above.
  if (!isLinked() || isAdoptionPending()) return;
  if (syncInFlight) { syncPending = true; return; }
  syncInFlight = true;
  try {
    await syncOnce({
      fetchImpl: (u, o) => fetch(u, o),
      now: () => new Date(),
      apiBase: WORKER_URL,
      applyState: applySyncedState,
    });
  } catch (err) {
    // Never let a sync failure break the app; local data keeps rendering.
    console.error('sync', err && err.name);
  } finally {
    syncInFlight = false;
    renderSyncStatus();
    // A trigger that arrived mid-sync must not be dropped — otherwise it
    // would wait for an unrelated later trigger instead of running promptly.
    if (syncPending) { syncPending = false; scheduleSync(); }
  }
}

// Debounced so one smart-add batch is one push, not one per item.
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 2000);
}

// Another tab wrote. Reload our module-scope snapshot rather than letting the
// next addItems()/deleteItem() write a stale array back over it. This event
// does not fire in the tab that performed the write, so no echo guard is
// needed. Narrowed to the three data keys — plaenicke.syncState is written on
// every sync tick and would otherwise force a full re-render in every other
// tab on every tick.
const CROSS_TAB_KEYS = ['plaenicke.items', 'plaenicke.feeds', 'plaenicke.syncTombstones'];
window.addEventListener('storage', (e) => {
  if (!CROSS_TAB_KEYS.includes(e.key)) return;
  items = loadItems();
  feeds = loadFeeds();
  feedCache = loadFeedCache();
  render();
});

// --- Phase 0: staying current across a resume -----------------------------
//
// A cursor the user navigated away from is left alone (followToday); only one
// that was showing the old today follows the clock.
function refreshForToday() {
  const today = toISO(new Date());
  if (today === lastToday) return;
  viewDay = followToday(viewDay, lastToday, today);
  viewWeekStart = followToday(viewWeekStart, startOfWeek(lastToday), startOfWeek(today));
  const shownMonth = toISO(viewMonth).slice(0, 7);
  if (followToday(shownMonth, lastToday.slice(0, 7), today.slice(0, 7)) !== shownMonth) {
    const now = new Date();
    viewMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  lastToday = today;
}

// The Phase 0 baseline. A failed write is reported, not swallowed — but it
// must never stop the app from opening, so it does not propagate.
function noteLaunch() {
  try {
    recordLaunch(nowISO());
  } catch (err) {
    console.error('plaenicke: launch log write failed', err && err.name);
  }
}

function stampUpdated() {
  const d = new Date();
  els.updatedStamp.textContent = `Updated ${formatTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)}`;
}

document.addEventListener('visibilitychange', () => {
  // Going to the background (Critical C1): iOS may kill the app without
  // warning, which would lose a pending delete, and on return a stale Undo
  // would sit over a delete that was in fact saved. Dismissing the toast runs
  // its onExpire — commitDelete — and clears it; then anything still pending
  // is committed as a safety net. KEEP THIS ORDER, and keep commitDelete's
  // pending check: with the loop first, the toast's later onExpire would
  // commit the same id again with a later deletedAt (Task 4b review, item 5).
  if (document.visibilityState === 'hidden') {
    if (activeToast) activeToast.dismiss();
    for (const id of [...pendingDeletes]) commitDelete(id);
    return;
  }
  if (document.visibilityState !== 'visible') return;
  refreshForToday();
  noteLaunch();
  render();
  stampUpdated();
  // Honours syncStale's 30-minute threshold, so a quick app switch does not
  // refetch every calendar.
  backgroundSyncFeeds(feeds);
  runSync();
});
window.addEventListener('online', runSync);

// PAINT THE SHELL INDICATOR BEFORE runSync, unconditionally (V6 spec § 9
// step 0). runSync's `finally` is the only other caller of renderSyncStatus in
// this file, and runSync returns BEFORE its try/finally whenever
// `!isLinked() || isAdoptionPending()` — which is exactly the pair of states
// step 0 exists to make visible: a stuck adoption, and a corrupt stored code
// (which makes isLinked() read false while a credential is stored). Without
// this line the indicator would light for every failure EXCEPT the two it was
// built for.
//
// The guard's early return must NOT be changed to paint instead: the assertion
// that runSync never reaches its finally while adoption is pending is the only
// live anchor on app.js's "never union silently" guard (see
// tests/apply.test.js).
renderSyncStatus();
runSync();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('service-worker.js'); });
}
