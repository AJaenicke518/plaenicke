import {
  loadItems, saveItems, loadFeeds, loadFeedCache, addTombstone,
  saveTombstones, recordLaunch, STORAGE_KEY, FEEDS_KEY, TOMBSTONES_KEY, SERIES_VISIBILITY_KEY, QuotaError,
} from './storage.js';
import {
  loadVisibility, filterBySurface, isShown, canHideSeries, setSeriesVisibility, CALENDAR, LISTS,
  UnlinkedCalendarError,
} from './visibility.js';
import { followToday, formatDayLabel } from './freshness.js';
import {
  makeItem, sortItemsByDate, isScheduled, isTodo, isTodoType, isIdea, sortIdeasNewestFirst,
} from './items.js';
import { normalizeIdea } from './ideas.js';
import { renderTodoView } from './todoview.js';
import { renderIdeasView } from './ideasview.js';
import { toISO, nowISO } from './dateparse.js';
import { buildMonthGrid, groupItemsByDate, monthCellSummary, chronoFirst, itemTypeClass } from './calendar.js';
import { startOfWeek, addDays, formatTime, weekLabel } from './timegrid.js';
import { parseViaWorker, decideFlow } from './smartadd.js';
import { renderDayView } from './dayview.js';
import { renderThreeDayView } from './threedayview.js';
import { renderWeekView } from './weekview.js';
import { buildWeekList, renderWeekList } from './weeklist.js';
import { renderPreview } from './preview.js';
import { isVoiceSupported, listen, errorKind } from './voice.js';
import { initSettings } from './settings.js';
import { instancesForRange, syncStale, applyRemoteFeeds } from './feeds.js';
import { openItemSheet } from './itemsheet.js';
import { showToast } from './toast.js';
import { applyEdit, typeChangePatch, snapshotOf, nextStamp, EDITABLE_FIELDS } from './edit.js';
import { uid } from './uid.js';
import { syncOnce, recordSyncFailure, localState } from './sync.js';
import { isLinked, isAdoptionPending } from './auth.js';
import { merge } from './merge.js';
import { renderSyncStatus, syncWriteStarted, syncWriteSettled } from './linkui.js';
import { WORKER_URL } from './config.js';
import { fetchWithTimeout } from './fetchtimeout.js';
import { installPress } from './press.js';
import { buildToday, relativeLabel, NEXT_DAYS, LOOKAHEAD_DAYS, tickedToday, tally } from './today.js';
import { renderTodayView, renderTally } from './todayview.js';
import { createCapture } from './capture.js';
import { createTypeChips, PRIMARY_TYPES, MORE_TYPES } from './typechips.js';

const els = {
  text: document.getElementById('entry-text'),
  date: document.getElementById('entry-date'),
  time: document.getElementById('entry-time'),
  end: document.getElementById('entry-end'),
  types: document.getElementById('entry-types'),
  add: document.getElementById('add-btn'),
  message: document.getElementById('message'),
  preview: document.getElementById('preview'),
  calView: document.getElementById('calendar-view'),
  prev: document.getElementById('prev-month'),
  next: document.getElementById('next-month'),
  calLabel: document.getElementById('calendar-label'),
  calGrid: document.getElementById('calendar-grid'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsHost: document.getElementById('settings-host'),
  sheetHost: document.getElementById('sheet-host'),
  toastHost: document.getElementById('toast-host'),
  toastLive: document.getElementById('toast-live'),
  showMonth: document.getElementById('show-month'),
  showWeek: document.getElementById('show-week'),
  showDay: document.getElementById('show-day'),
  show3day: document.getElementById('show-3day'),
  threeDayView: document.getElementById('three-day-view'),
  threeDayLabel: document.getElementById('three-day-label'),
  threeDayBody: document.getElementById('three-day-body'),
  prev3day: document.getElementById('prev-3day'),
  next3day: document.getElementById('next-3day'),
  weekView: document.getElementById('week-view'),
  weekLabel: document.getElementById('week-label'),
  weekGrid: document.getElementById('week-grid'),
  weekList: document.getElementById('week-list'),
  prevWeek: document.getElementById('prev-week'),
  nextWeek: document.getElementById('next-week'),
  dayView: document.getElementById('day-view'),
  dayLabel: document.getElementById('day-label'),
  dayBody: document.getElementById('day-body'),
  prevDay: document.getElementById('prev-day'),
  nextDay: document.getElementById('next-day'),
  // V6 — the To-do and Ideas pages.
  todoView: document.getElementById('todo-view'),
  todoList: document.getElementById('todo-list'),
  ideasView: document.getElementById('ideas-view'),
  ideaList: document.getElementById('idea-list'),
  ideaText: document.getElementById('idea-text'),
  ideaAdd: document.getElementById('idea-add'),
  updatedStamp: document.getElementById('updated-stamp'),
  // Home-screen stage 3b — the Today page.
  todayView: document.getElementById('today-view'),
  todayBody: document.getElementById('today-body'),
  todayDate: document.getElementById('today-date'),
  todayTally: document.getElementById('today-tally'),
  // Home-screen stage 3c — the tab bar, the tab title and Calendar's switcher.
  tabToday: document.getElementById('tab-today'),
  tabCalendar: document.getElementById('tab-calendar'),
  tabTodo: document.getElementById('tab-todo'),
  tabIdeas: document.getElementById('tab-ideas'),
  tabTitle: document.getElementById('tab-title'),
  calSwitch: document.getElementById('cal-switch'),
  // Home-screen stage 4 — the capture button and its box.
  captureBtn: document.getElementById('capture-btn'),
  captureBox: document.getElementById('capture-box'),
  captureText: document.getElementById('capture-text'),
  captureAdd: document.getElementById('capture-add'),
  captureCancel: document.getElementById('capture-cancel'),
  captureClose: document.getElementById('capture-close'),
  captureType: document.getElementById('capture-type'),
  captureMessage: document.getElementById('capture-message'),
  capturePreview: document.getElementById('capture-preview'),
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// A message line, with a token bumped by EVERY message on it, so a smart add
// can tell whether the "Thinking…" it set is still the one on screen (see
// handleAdd). Each capture box has its own line (home-screen spec § 3): the
// top box's #message, which also carries every message unrelated to capture,
// and from stage 4 the capture box's #capture-message.
function messageLine(el) {
  let token = 0;
  return {
    set(text) { token += 1; el.textContent = text || ''; },
    token: () => token,
  };
}
const topLine = messageLine(els.message);
const captureLine = messageLine(els.captureMessage);

let items = loadItems();
let viewMonth = new Date();
let viewDay = toISO(new Date());
let viewWeekStart = startOfWeek(viewDay);
// The 3-day view's first day: its own cursor, not Day's (option A, Alex
// 2026-10-26). It starts on today and follows today as viewDay does; opening
// a day in Day view does not move it.
let viewThreeDayStart = viewDay;
// What app.js believed "today" was the last time it looked. iOS resumes a
// home-screen web app instead of reloading it, so the cursors above would
// otherwise stay on the day the app was first opened. refreshForToday() moves
// every cursor that was showing this day onto the real one.
let lastToday = viewDay;

// External calendars (Task 6/7) — feeds + cache are read once at load; the
// only thing that changes them afterward is a background sync settling (see
// bottom of file), which reloads the cache and re-renders once.
// Re-read by refreshForToday (sweep D5): a device that changes zone while
// the app is resumed rather than reloaded must not keep placing feed events
// in the zone it was opened in.
let deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
let feeds = loadFeeds();
let feedCache = loadFeedCache();
// Calendars whose latest fetch failed, by id, for the "Updated" stamp (see
// stampFromFeeds). Fed by every fetch this page makes: each background batch
// and Settings' own Sync and Add calendar (onFeedFetched below).
const failedFeedIds = new Set();
// Which feed series this device hides, and where (js/visibility.js; option A,
// 2026-10-26). DEVICE-LOCAL, NEVER SYNCED: nothing in this file that touches
// it calls scheduleSync. Re-read at the top of every render(), so a write from
// the sheet, from Settings or from another tab is never shown stale.
let visibility = loadVisibility();

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
// THE isScheduled FILTER IS THE SINGLE CHOKEPOINT for month, week and day
// (V6 § 7.1), so one filter covers all three. (It also covered the List view,
// which iterated visibleItems directly, until stage 3d removed List.) The
// list under the Week grid does not read it: like Today, it takes
// liveItems() through upcomingRows, whose own rule (isUpcomingOwn) also
// rejects ideas.
// Forgetting this is visible (an idea turns up on the calendar on its capture
// day) rather than silently correct.
//
// External feed instances carry no `type`, so isScheduled passes them through
// — by design, not by accident: a feed event is always a scheduled thing.
//
// Month and Day read the CALENDAR surface: a series hidden from the calendar
// on this device (js/visibility.js) is left out here.
function visibleItems(start, end) {
  return [
    ...liveItems().filter(isScheduled),
    ...filterBySurface(instancesForRange(feeds, feedCache, start, end, deviceTz), visibility, CALENDAR),
  ];
}

// THE To-do AND Ideas PAGES READ `items` DIRECTLY, never visibleItems (V6
// § 3.3). External feed instances carry no `type`, so they would fail both
// predicates by ACCIDENT rather than by design — and a feed that ever grew a
// type-shaped field would start populating the To-do page.
//
// Every undone to-do, soonest first; then, last, every to-do ticked TODAY,
// soonest first, so a tick can be undone until tomorrow (Alex, 2026-10-22:
// "i also want to see the crossed out version in the to do tab as well").
// "Ticked today" is Today's own rule, imported, not restated. A to-do ticked
// on an earlier day does not show.
function todoItems(todayISO) {
  const live = liveItems();
  const tickedTodayTodo = (it) => isTodoType(it) && it.done === true && tickedToday(it, todayISO);
  return [...sortItemsByDate(live.filter(isTodo)), ...sortItemsByDate(live.filter(tickedTodayTodo))];
}

function ideaItems() { return sortIdeasNewestFirst(liveItems().filter(isIdea)); }

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
// importing it back would close a module cycle (DA-C6). The cycle is the
// incidental reason. The durable one is dependency inversion at the DOM
// boundary: this file touches `document` at module scope, so anything that
// imports it cannot be unit-tested in Node (`ReferenceError: document is not
// defined`). Keep the injection even if renderSyncStatus moves and the cycle
// goes away.
initSettings({
  button: els.settingsBtn,
  host: els.settingsHost,
  // The stamp is repainted too (sweep F, O5): adding, removing or hiding a
  // calendar changes what is on screen, and so what the stamp is about.
  onFeedsChanged: () => {
    feeds = loadFeeds(); feedCache = loadFeedCache(); render();
    stampUpdated(); stampFromFeeds();
  },
  // Settings' manual Sync and Add calendar fetch outside the background batch.
  // Their results must reach the stamp's failure memory, or a successful
  // manual Sync leaves "Couldn't refresh" up, and a calendar added there whose
  // first fetch failed is counted as not yet fetched (both regressions of
  // b8ea190's memory, reverted in c6cfbf5). Settings calls this before
  // onFeedsChanged, which repaints.
  onFeedFetched: (id, ok) => { if (ok) failedFeedIds.delete(id); else failedFeedIds.add(id); },
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

// The top box's line: Ideas, ticks, deletes, edits and the top box's own adds.
function setMessage(t) { topLine.set(t); }

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
  // A failed save must not leave the new records in `items`: app.js saves
  // from that array, so the next successful save of ANY item would quietly
  // write a capture the user was told had failed.
  const prev = items;
  items = [...items, ...made];
  try {
    saveItems(items);
  } catch (e) {
    items = prev;
    throw e;
  }
  render();
  scheduleSync();
}

// The manual add's type chips (option A, Alex 2026-10-26; js/typechips.js).
// The row shows only while a date is picked, since only the manual path reads
// it; whenever it hides it goes back to Event, so a choice the user can no
// longer see is never brought back or saved. Run on the date box's input and
// change, after a manual add clears the date, and on pageshow, which fires on
// every load too: a browser that restores the date box's value, or a page
// back from the back/forward cache, brings a date back with no input event.
// Before that first pageshow the row is hidden by index.html.
const typeChips = createTypeChips(els.types);
const OFFERED_TYPES = [...PRIMARY_TYPES, ...MORE_TYPES];
function syncTypeRow() {
  const show = Boolean(els.date.value);
  if (!show) typeChips.reset();
  els.types.hidden = !show;
}

// Manual add: title box + date box, saved as the type the chips hold (Event
// unless the user picked another). Works with no network.
function handleManualAdd(type) {
  const title = els.text.value.trim();
  const date = els.date.value;
  if (!title || !date) { setMessage('For manual add, type a title and pick a date.'); return 'refused'; }
  // Never saved as a type the chips do not offer: makeItem would quietly turn
  // a missing one into 'general', which no page treats as a to-do.
  if (!OFFERED_TYPES.includes(type)) { setMessage(`Manual add: unknown type ${type}`); return 'failed'; }
  try {
    addItems([{ title, date, type, time: els.time.value || null, endTime: els.end.value || null }]);
  } catch (e) { setMessage(e.message); return 'failed'; }
  els.text.value = ''; els.date.value = ''; els.time.value = ''; els.end.value = ''; els.end.hidden = true;
  syncTypeRow(); // the date is now empty: hides the chips and puts them back on Event
  setMessage('Added.');
  return 'added';
}

// Which Add is the latest. parseViaWorker can take up to SMART_ADD_TIMEOUT_MS
// to settle, and by then the user may have added manually or started another
// smart add; a result or error from a superseded request changes nothing, or
// it would overwrite the newer outcome ("Added." → "unavailable") or add items
// the user has moved past. Bumped by every Add that passes validation, manual
// ones included; a refused Add (time with no date, empty box) leaves the
// pending smart add alone.
//
// Whether a CURRENT request may still change the message is separate: only
// if its box's line still shows the "Thinking…" it set (the line's token).
// Another action's message — the Ideas box's "Kept." — is left alone, while
// the request still adds its items (the Ideas box does not cancel them). The
// one exception is a failed save of those items: that is shown regardless,
// since nothing else would tell the user the capture was lost.
let addGeneration = 0;
// The box, trimmed text and generation of the smart add in flight, so a second
// Add of the same text from the same box sends no second (paid) request.
let pendingSmart = null;

// THE BOXES THAT ADD (home-screen spec § 3). handleAdd keeps one logic and
// takes the box it was called from: its field, its date row (null for a box
// without one: smart add only), its message line, its preview container, its
// "unavailable" text (each names the way that box's user can still add), and
// what to do once an add from it has landed.
const topTarget = {
  field: els.text,
  dates: { date: els.date, time: els.time, end: els.end },
  // Read only on the manual path (a date picked), never by smart add.
  type: typeChips,
  line: topLine,
  preview: els.preview,
  unavailable: 'Smart add is unavailable — pick a date below and tap Add to add it manually.',
  onAdded() {},
  onSuperseded() {},
  onPreviewClosed() {},
};
// The capture box has no date row, so its failure names the top box's.
// `capture` is created below; these run only after an Add, long after.
const captureTarget = {
  field: els.captureText,
  dates: null,
  type: null,
  line: captureLine,
  preview: els.capturePreview,
  unavailable: 'Smart add is unavailable — use the box at the top with a date to add it.',
  onAdded() { capture.added(); },
  onSuperseded() { capture.released(); },
  // Its own Add is hidden while its preview is open (js/capture.js).
  onPreviewClosed() { capture.previewClosed(); },
};
const TARGETS = [topTarget, captureTarget];

// A new capture closes any open preview, in EVERY box (spec § 3 step 8), and
// that box's line says so. A preview is open while its container has content
// (renderPreview fills it; every close empties it). Called by every Add that
// passes validation, before its own message, so in the box that started it
// the newer message replaces this one.
const PREVIEW_CLOSED = 'Preview closed — nothing was added from it.';
function closePreviews() {
  for (const t of TARGETS) {
    if (t.preview.children.length === 0) continue;
    t.preview.hidden = true;
    t.preview.innerHTML = '';
    t.line.set(PREVIEW_CLOSED);
    t.onPreviewClosed();
  }
}

// Makes the smart add in flight superseded, as a newer Add would: its reply,
// whenever it comes, changes nothing (spec § 3 step 7: the capture box's
// Cancel). The same text can then be sent again: the duplicate guard above
// only holds for the current generation. The request itself is not aborted,
// so it may still spend credit (spec § 8, Later). Only the capture box calls
// this, and only while its latch is set; a newer Add from the top box
// releases that latch at once (supersedePending), so its Cancel can never
// reach the top box's request.
function cancelAdd() {
  addGeneration += 1;
}

// A newer Add (either box, manual or smart) is about to supersede the smart
// add in flight. Its reply will change nothing, so its box is told NOW, not
// when the reply comes up to SMART_ADD_TIMEOUT_MS later: its "Thinking…" goes
// (if still showing) and the capture box drops its adding latch. Without this
// a request superseded from the OTHER box left "Thinking…" up, and the
// capture box's Cancel then cancelled the NEWER request (DA I1).
function supersedePending() {
  if (pendingSmart && pendingSmart.generation === addGeneration) pendingSmart.release();
}

// Resolves to how it ended: 'refused' (validation; nothing started),
// 'duplicate' (the same text from the same box is already in flight),
// 'added', 'preview', 'empty', 'failed', or 'superseded' (a newer Add, or a
// Cancel, came first, so this request changed nothing).
async function handleAdd(target) {
  const { field, dates, line } = target;
  if (dates && dates.time.value && !dates.date.value) {
    line.set('Add a date to use that time, or clear the time to use smart add.');
    return 'refused';
  }
  // If a date is picked, treat Add as an explicit MANUAL add — no Worker needed.
  // This is the always-available fallback (works offline and on iPhone). Only
  // the top box has a date row.
  if (dates && dates.date.value) {
    // Refused here, before the bump, so a refused manual add (no title) starts
    // nothing and leaves a pending smart add alone; a landed one supersedes it
    // and closes any open preview.
    if (!field.value.trim()) { line.set('For manual add, type a title and pick a date.'); return 'refused'; }
    supersedePending();
    addGeneration += 1;
    closePreviews();
    return handleManualAdd(target.type.value());
  }

  const raw = field.value.trim();
  if (!raw) { line.set('Type something first.'); return 'refused'; }
  if (pendingSmart && pendingSmart.generation === addGeneration
    && pendingSmart.target === target && pendingSmart.raw === raw) return 'duplicate';
  supersedePending();
  const generation = ++addGeneration;
  // An earlier request's preview must not stay confirmable under a new one.
  closePreviews();
  line.set('Thinking…');
  const thinking = line.token();
  const say = (t) => { if (line.token() === thinking) line.set(t); };
  pendingSmart = { generation, raw, target, release: () => { say(''); target.onSuperseded(); } };
  // Only clear the box if it still holds what was sent: text typed while
  // waiting (or reviewing) is the user's next entry.
  const clearSentText = () => { if (field.value.trim() === raw) field.value = ''; };

  let result;
  try {
    result = await parseViaWorker(raw);
  } catch (e) {
    if (generation !== addGeneration) return 'superseded';
    pendingSmart = null;
    if (e.message === 'too_long') say('That was a lot at once — try adding fewer items in one go.');
    else say(target.unavailable);
    return 'failed';
  }
  if (generation !== addGeneration) return 'superseded';
  pendingSmart = null;

  const flow = decideFlow(result);
  if (flow === 'empty') { say("I couldn't find anything to add — try rephrasing."); return 'empty'; }
  if (flow === 'direct') {
    try {
      addItems(result.items);
    } catch (e) { line.set(e.message); return 'failed'; }
    clearSentText();
    say('Added.');
    target.onAdded();
    return 'added';
  }
  say('Review the items below.');
  renderPreview(target.preview, result.items, {
    onConfirm: (confirmed) => {
      // A preview's confirm checks its request is still the newest (spec § 3
      // step 8). A newer Add closed this preview, but a button of it can still
      // be tapped (a tap already on its way). false: renderPreview then leaves
      // the container alone, which may now hold the NEWER request's preview.
      // Silent, like a stale Cancel: the line belongs to the newer request, and
      // writing on it would bump its token and swallow its own "Added." or
      // "Review the items below." (Task 5 review). Closing this preview already
      // said "Preview closed — nothing was added from it."
      if (generation !== addGeneration) return false;
      try { addItems(confirmed); } catch (e) { line.set(e.message); return false; }
      clearSentText();
      line.set('Added.');
      target.onAdded();
      return true;
    },
    // The same check for its Cancel: a stale Cancel changes nothing, and
    // returns false so renderPreview leaves the container alone (DA M5).
    onCancel: () => {
      if (generation !== addGeneration) return false;
      line.set('Cancelled.');
      target.onPreviewClosed();
      return true;
    },
  });
  return 'preview';
}

function deleteItem(id) {
  // Tombstone BEFORE the destructive write: if addTombstone throws (quota
  // exhausted, or storage blocked as in Safari Private Browsing), the item
  // is still present locally and nothing else has changed — that converges
  // to the user's intent (retry, or the item just stays). The old order
  // (save first, tombstone second) let a tombstone-write failure delete the
  // item locally with no tombstone to propagate — a silent, self-reversing
  // delete once sync ships.
  //
  // deletedAt is strictly later than the record's own updatedAt (nextStamp),
  // or a record from a clock-ahead device outlives its own deletion.
  const rec = items.find((it) => it.id === id);
  addTombstone(id, 'item', nextStamp(nowISO(), rec && rec.updatedAt));
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
//
// The stamp is strictly later than the record's own (nextStamp), and a failed
// save restores the record, as editItem does: `items` is what the next save
// of any item writes.
//
// setDone does NOT render; handleToggleDone, its only caller, does. So a
// throw out of setDone always means the save failed and the record was
// restored, and a throw out of the render that follows always means the tick
// saved (stage 3 leftover 3, 2026-10-26).
function setDone(id, done) {
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return;
  const before = items[idx];
  items[idx] = { ...before, done: done === true, updatedAt: nextStamp(nowISO(), before.updatedAt) };
  try {
    saveItems(items);
  } catch (e) {
    items[idx] = before;
    throw e;
  }
  // The save succeeded, so the push is scheduled BEFORE the render (final
  // fixes 2, C9): a render that throws must not leave a saved tick unsent.
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
//
// `openedType` is the type the sheet was built for (openItem passes it). The
// idea sheet and the others collect different fields, so if a sync changed
// the type while the sheet was open, its diff no longer describes the record:
// refuse rather than guess. Undo passes none.
//
// The stamp is strictly later than the record's own (nextStamp), so an edit —
// or an Undo in the same millisecond as its edit — never loses to the copy it
// replaced because of clock skew.
//
// `keep` is used ONLY by an Undo that skips fields (sweep F, I1): the fields it
// promises to leave as they are. applyEdit can still change one of them
// (normalizeIdea re-derives an idea's title from its notes; an idea clears its
// times), so the rebuilt record is checked, and the write refused, rather than
// telling the user their other device's change was kept when it was not.
function editItem(id, patch, { toast = true, raw = false, openedType, keep = [] } = {}) {
  if (pendingDeletes.has(id)) return { ok: false, error: 'This item is being deleted.' };
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return { ok: false, error: 'This item no longer exists.' };
  const before = items[idx];
  if (openedType !== undefined && before.type !== openedType) {
    return { ok: false, error: 'This item changed elsewhere (another device or tab) — close and reopen it.' };
  }
  let applied;
  let next;
  try {
    applied = raw ? patch : typeChangePatch(before, patch);
    next = applyEdit(before, applied, nextStamp(nowISO(), before.updatedAt));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (keep.some((k) => next[k] !== before[k])) return { ok: false, error: UNDO_REFUSED };
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
      live: els.toastLive,
      undo: () => {
        // Restore a field only while it still holds what this edit wrote. A
        // sync may have brought a newer value from the other device since;
        // Undo must not write over it. A record that is gone falls through to
        // editItem, which says so.
        //
        // time and endTime are ONE value, a range (sweep F, I2): both are
        // restored only if neither changed since. Restoring one of them would
        // pair it with the other device's, a range nobody set, or an
        // invalid one.
        const current = items.find((it) => it.id === id);
        let restore = undoSnap;
        const skipped = [];
        if (current) {
          restore = {};
          const timesUnchanged = current.time === next.time && current.endTime === next.endTime;
          for (const k of Object.keys(undoSnap)) {
            const unchanged = k === 'time' || k === 'endTime' ? timesUnchanged : current[k] === next[k];
            if (unchanged) restore[k] = undoSnap[k];
            else skipped.push(k);
          }
        }
        const kept = skipped.length > 0;
        // A partial Undo across the idea line is refused whole (sweep F, I1).
        // The idea sheet and the others hold different fields, and the
        // switch rewrote title, notes and times together; putting back some
        // of them re-derives the rest from the other device's text.
        if (kept && 'type' in restore && (restore.type === 'idea') !== (current.type === 'idea')) {
          setMessage(UNDO_REFUSED);
          return;
        }
        // Nothing left to restore: write nothing, since a write would only
        // bump updatedAt over the other device's version.
        if (!current || Object.keys(restore).length > 0) {
          const r = editItem(id, restore, { toast: false, raw: true, keep: skipped });
          // A filtered restore that fails says it could not be undone, never
          // the validator's text about a field the user did not touch.
          if (!r.ok) { setMessage(kept ? UNDO_REFUSED : r.error); return; }
        }
        if (kept) setMessage('Some changes from your other device were kept.');
      },
    });
  }
  return { ok: true };
}

// What an Undo says when it would have to write over, or re-derive, a change
// that came from the other device (sweep F, I1 and I2). Nothing is written.
const UNDO_REFUSED = "Changes from your other device were kept, so this couldn't be undone.";

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
    live: els.toastLive,
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
// (CLAUDE.md, "Feed URLs are unrecoverable"). isGoogleHost reads the URL here,
// in app.js, and only its yes/no verdict crosses into the sheet.
function openItem(item) {
  // Only the latest action can be undone, and an Undo left sitting over the
  // sheet's own buttons is a mis-tap waiting to happen. Dismissing settles
  // the toast (for a delete, that commits it).
  if (activeToast) activeToast.dismiss();
  let calendarName = null;
  let googleDayUrl = null;
  let vis = null;
  if (item.external) {
    const feed = feeds.find((f) => f.id === item.feedId);
    calendarName = feed ? feed.name : 'a linked calendar';
    if (feed && isGoogleHost(feed.url)) {
      const [y, m, d] = item.date.split('-').map(Number);
      googleDayUrl = `https://calendar.google.com/calendar/r/day/${y}/${m}/${d}`;
    }
    // The two per-series switches, except on a guessed series (controller
    // ruling 3): there each meeting has its own uid, and a switch would hide
    // one meeting while looking as if it hid the class.
    if (canHideSeries(item)) {
      vis = {
        calendar: isShown(visibility, item, CALENDAR),
        list: isShown(visibility, item, LISTS),
        every: seriesHasMany(item),
      };
    }
  }
  // openItemSheet validates BEFORE touching the host (an unknown type, a
  // missing callback), so on a throw the screen is unchanged and only the
  // message says why.
  try {
    openItemSheet(els.sheetHost, item, {
      // A function, read when a quick move is tapped (sweep D3): the sheet can
      // stay open across midnight.
      today: () => toISO(new Date()),
      calendarName,
      googleDayUrl,
      onSave: (p) => editItem(item.id, p, { openedType: item.type }),
      onDelete: () => requestDelete(item.id),
      onClose: () => focusOpener(item.id),
      visibility: vis,
      onVisibilityChange: (surface, shown) => changeSeriesVisibility(item, surface, shown),
    });
  } catch (e) {
    // The reason is for a developer (e.g. "Unknown type: x"), not the user.
    console.error('openItemSheet refused to open', item.id, e);
    setMessage("This item can't be edited here.");
  }
  // Opening a sheet stops a listen and keeps its text (spec § 3 step 4).
  // Last, after the sheet is up: nothing here may stop it opening.
  capture.stopAndKeep();
}

// Whether one switch covers more than this occurrence: the calendar holds
// several ParsedEvents with this uid (overrides, duplicates), or a rule. Not
// `recurring`, which is DAILY/WEEKLY only: a monthly series is one switch
// over every month too.
function seriesHasMany(item) {
  const entry = feedCache[item.feedId];
  const evs = entry && Array.isArray(entry.events) ? entry.events.filter((ev) => ev.uid === item.uid) : [];
  return evs.length > 1 || evs.some((ev) => typeof ev.rrule === 'string');
}

// The sheet's switch tap. Writes plaenicke.seriesVisibility ONLY, through
// js/visibility.js, and NEVER schedules a sync: the choice is per device
// (Alex, 2026-10-19; option A, 2026-10-26). The write's result and the
// render's are reported apart, as handleToggleDone does for a tick: a hide
// that saved is never reported as failed because the screen did not redraw.
function changeSeriesVisibility(item, surface, shown) {
  try {
    setSeriesVisibility({ feedId: item.feedId, uid: item.uid, title: item.title || 'Untitled event' }, surface, shown);
  } catch (e) {
    // In words for the two causes a user can meet; anything else is a bug,
    // logged by name and shown as one.
    console.error('plaenicke: a visibility change was not saved', e && e.name);
    if (e instanceof UnlinkedCalendarError) {
      return { ok: false, error: 'This calendar is no longer linked on this device, so this can’t be changed.' };
    }
    if (e instanceof QuotaError) return { ok: false, error: 'This device is out of storage, so that wasn’t saved.' };
    return { ok: false, error: `That wasn’t saved (${e && e.name ? e.name : 'error'}).` };
  }
  try {
    render();
  } catch (e) {
    setMessage(TICK_SAVED_RENDER_FAILED);
    console.error('plaenicke: render after a visibility change failed', e && e.name);
  }
  return { ok: true };
}

// Is this feed Google's own? The link is offered only for a host of exactly
// calendar.google.com or one ending in .google.com (sweep U14). inferName's
// substring test is fine for a display name but says "Google" for
// evilgoogle.com too. The URL is a capability token: it is parsed here and
// never logged, rendered or put in a message — an unparseable one simply
// gets no link.
function isGoogleHost(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === 'calendar.google.com' || hostname.endsWith('.google.com');
}

// When the sheet closes, focus goes back to the item's opener (sweep U6). A
// Save or a Delete has re-rendered every page by now, so the button that was
// tapped is gone: the NEW one is found by item id, on the page that is
// showing (every page renders every item's opener, hidden pages included).
// Month has no openers; Week's openers are in its list (the grid has none). An item that is no longer listed — deleted,
// or moved off the Day being shown — has none to return to, and focus is left
// where the browser puts it.
function focusOpener(id) {
  const pages = [
    [els.todayView, els.todayBody], [els.dayView, els.dayBody], [els.threeDayView, els.threeDayBody],
    [els.weekView, els.weekList],
    [els.todoView, els.todoList], [els.ideasView, els.ideaList],
  ];
  const shown = pages.find(([section]) => !section.hidden);
  if (!shown) return;
  // A NodeList has no .find; spread it into an array first.
  const opener = [...shown[1].querySelectorAll('button')]
    .find((b) => b.classList.contains('item-open') && b.getAttribute('data-item-id') === id);
  // preventScroll (sweep F, I1): the opener is where the user just was, and
  // the browser's own scroll-into-view can jump the page under the closing
  // sheet.
  if (opener) opener.focus({ preventScroll: true });
}

// A tick keeps keyboard focus (final fixes 2, C4), on Today and, since a
// to-do ticked today stays on the To-do page too (2026-10-22), on To-do. The
// tick re-renders every page, so the box that had focus is gone; when it did
// have focus, the NEW box in the row for the same item is focused. The row is
// found by its class, and the item by the open button's data-item-id, as
// focusOpener finds an opener. One function serves both pages.
function rowOf(el, rowClass) {
  let n = el;
  while (n && !(n.classList && n.classList.contains(rowClass))) n = n.parentNode;
  return n;
}

function rowItemId(row) {
  const opener = [...row.querySelectorAll('button')].find((b) => b.getAttribute('data-item-id') !== null);
  return opener ? opener.getAttribute('data-item-id') : null;
}

function toggleDoneKeepingFocus(container, rowClass) {
  return (id, done) => {
    const active = document.activeElement;
    const row = active && active.type === 'checkbox' ? rowOf(active, rowClass) : null;
    const hadFocus = !!row && rowItemId(row) === id;
    handleToggleDone(id, done);
    if (!hadFocus) return;
    const opener = [...container.querySelectorAll('button')].find((b) => b.getAttribute('data-item-id') === id);
    const newRow = opener && rowOf(opener, rowClass);
    const box = newRow && newRow.querySelector('input');
    if (box) box.focus({ preventScroll: true });
  };
}

// The tick moment (rewards concept 1, Alex 2026-10-26): the id of the item a
// tick just marked done, set only for the one render() that follows a saved
// tick and cleared in its finally, so no later render (a sync, a tab switch)
// plays it again. An untick and a failed save never set it. Module state,
// never stored. The row plays where it lands (controller ruling): nothing
// holds the reorder.
let justTicked = null;

const TICK_SAVED_RENDER_FAILED = "Saved, but the screen couldn't update — reload.";

function handleToggleDone(id, done) {
  try {
    setDone(id, done);
  } catch (e) {
    setMessage(e.message);
    // The save failed and setDone restored the record, but the checkbox the
    // user tapped still shows the tick. Re-render from `items`, so a failed
    // tick looks failed.
    render();
    return;
  }
  // The tick saved and its sync is scheduled. A render that throws now must
  // not report the tick as failed, and must not be retried (it would throw
  // again). The error is rethrown, not swallowed: the user is told to reload
  // and the error still reaches the console.
  justTicked = done === true ? id : null;
  try {
    render();
  } catch (e) {
    setMessage(TICK_SAVED_RENDER_FAILED);
    throw e;
  } finally {
    justTicked = null;
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
      // A button to Tab and to assistive tech, not a bare clickable <div>:
      // Enter or Space opens the same day a click does (Space is cancelled, or
      // it would also scroll the page). Blank cells above open nothing and
      // stay out of the tab order.
      div.setAttribute('role', 'button');
      div.setAttribute('tabindex', '0');
      div.addEventListener('click', () => openDay(cell.date));
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDay(cell.date); }
      });
      els.calGrid.appendChild(div);
    }
  }
}

// The grid, and under it the list of the week's days (B2, Alex 2026-10-22).
// The list's own items come from liveItems(), like Today's: upcomingRows
// (via buildWeekList) leaves out ideas and done items itself. Its instances
// are expanded for exactly the days it lists. The arrows re-render both.
function renderWeek() {
  const end = addDays(viewWeekStart, 6);
  const todayISO = toISO(new Date());
  els.weekLabel.textContent = weekLabel(viewWeekStart, end);
  // One expansion for the whole week: the grid merges it with the own items
  // (as visibleItems does) and the list takes the slice it lists.
  // The grid is the calendar surface and the list the list surface
  // (js/visibility.js), so each takes its own filter of the one expansion.
  const weekInsts = instancesForRange(feeds, feedCache, viewWeekStart, end, deviceTz);
  const gridInsts = filterBySurface(weekInsts, visibility, CALENDAR);
  const listInsts = filterBySurface(weekInsts, visibility, LISTS);
  renderWeekView(els.weekGrid, viewWeekStart,
    groupItemsByDate(sortItemsByDate([...liveItems().filter(isScheduled), ...gridInsts])), todayISO,
    { onSelectDay: openDay });
  const list = buildWeekList(liveItems(),
    (from, to) => listInsts.filter((i) => i.date >= from && i.date <= to), viewWeekStart, todayISO);
  renderWeekList(els.weekList, list, { onOpen: openItem, onSelectDay: openDay });
}

// Three columns of Day's grid (option A, Alex 2026-10-26). visibleItems, as
// Day reads it: own scheduled items plus every visible feed's instances for
// the three days, repeating ones included, so the classes show.
let lastThreeDayRendered = null;

function renderThreeDay() {
  const end = addDays(viewThreeDayStart, 2);
  els.threeDayLabel.textContent = weekLabel(viewThreeDayStart, end);
  const visible = !els.threeDayView.hidden;
  renderThreeDayView(els.threeDayBody, viewThreeDayStart,
    groupItemsByDate(sortItemsByDate(visibleItems(viewThreeDayStart, end))), toISO(new Date()), {
      onOpen: openItem,
      onSelectDay: openDay,
      // Scroll to 07:00 when the window changed or the page has just come
      // back into view; otherwise keep the grid where the user left it. A
      // grid drawn while hidden holds no scroll position (a browser reports
      // 0), so a hidden render forgets the window: without that, returning
      // to Calendar on the same window opened the grid at midnight.
      autoScroll: visible && viewThreeDayStart !== lastThreeDayRendered,
    });
  lastThreeDayRendered = visible ? viewThreeDayStart : null;
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
    // A grid drawn while hidden holds no scroll position (a browser reports 0), so a hidden
    // render FORGETS the day rather than only not advancing it. Every showView re-renders
    // every page: leaving Day re-draws its grid hidden, and coming back to the same day
    // would otherwise skip auto-scroll and restore that 0, opening the grid at midnight.
    autoScroll: visible && viewDay !== lastDayRendered,
  });
  lastDayRendered = visible ? viewDay : null;
}

function renderTodos() {
  const todayISO = toISO(new Date());
  renderTodoView(els.todoList, todoItems(todayISO), {
    todayISO, onOpen: openItem, onDelete: requestDelete,
    onToggleDone: toggleDoneKeepingFocus(els.todoList, 'todo-row'), justTicked,
  });
}

function renderIdeas() {
  renderIdeasView(els.ideaList, ideaItems(), { onOpen: openItem, onDelete: requestDelete });
}

// The Today page (home-screen spec § 2.3). Own items come from liveItems(),
// so a delete waiting for its Undo is already gone; feed instances are
// expanded for today .. today + 7, and the 30-day look-ahead (today + 1 ..
// today + 30) for Coming up and the "Next" line, which buildToday calls once
// per render. One clock reading for the whole page.
//
// todayRelative is the one "in N" label on the page and its event, kept for
// the 60 s tick below; todayRenderedFor is the day that render was for.
//
// laterOpen is whether Coming up ("Show the next 30 days", A2, Alex
// 2026-10-22) is open. Module state, never stored: closed on each app load,
// kept across re-renders (the 60 s tick's new-day render, syncs, taps), and
// closed again when a render is for a new day.
let todayRelative = null;
let todayRenderedFor = null;
let laterOpen = false;
const minutesNow = (d) => d.getHours() * 60 + d.getMinutes();

function renderToday() {
  const now = new Date();
  const todayISO = toISO(now);
  els.todayDate.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  // Every section of Today is the list surface, the look-ahead included, so
  // a series hidden from lists is not the "Next:" line either (ruling 1).
  const today = buildToday(
    liveItems(),
    filterBySurface(instancesForRange(feeds, feedCache, todayISO, addDays(todayISO, NEXT_DAYS), deviceTz), visibility, LISTS),
    todayISO,
    minutesNow(now),
    () => filterBySurface(
      instancesForRange(feeds, feedCache, addDays(todayISO, 1), addDays(todayISO, LOOKAHEAD_DAYS), deviceTz),
      visibility, LISTS,
    ),
  );
  // The head's "N DONE · M LEFT" (rewards concept 2), from the same rows.
  renderTally(els.todayTally, tally(today));
  if (todayISO !== todayRenderedFor) laterOpen = false;
  todayRenderedFor = todayISO;
  todayRelative = renderTodayView(els.todayBody, today, {
    onOpen: openItem, onToggleDone: toggleDoneKeepingFocus(els.todayBody, 'today-row'),
    laterOpen, onToggleLater: toggleLater, justTicked,
  }).relative;
}

// The tap opens or closes Coming up, then redraws Today only. The button is
// rebuilt ("Show less" at the bottom, or the closed one), so focus moves to
// the new one rather than being lost; preventScroll keeps the page still.
//
// A tap after midnight and before the 60 s tick is on a stale page: render()
// first (it resets the page, and laterOpen, for the new day), so the tap then
// opens the new day's section instead of being swallowed by that reset.
function toggleLater() {
  if (toISO(new Date()) !== todayRenderedFor) render();
  laterOpen = !laterOpen;
  renderToday();
  const more = els.todayBody.querySelector('.today-more');
  if (more) more.focus({ preventScroll: true });
}

// THE 60 s TICK (spec § 2.3) updates that one text node and never rebuilds
// the page. Greying, and which event is next, change on the next ordinary
// render (resume, add, sync); an event that has ended leaves an empty label
// until then. It runs only while Today AND the page are visible:
// syncTodayTick is called wherever either can change (load, showView,
// visibilitychange).
//
// It lands on the minute (final review A3): arming first sets a timeout to
// the next minute boundary, whose callback ticks and then starts the 60 s
// interval. `todayTick` is the one handle, in either phase —
// { kind: 'align' | 'interval', id } or null — so clearing works in both and
// there are never two. tests/apply.test.js recognises the timeout by its
// callback's name, startTodayTick: keep it.
const TODAY_TICK_MS = 60 * 1000;
let todayTick = null;

// relativeLabel reads minutes of the day only, never the date, so after
// midnight the kept event may be yesterday's: a tick on a new day renders the
// whole app instead — render(), not renderToday(): refreshForToday, inside
// render, catches the other pages' cursors up — and repaints the "Updated"
// stamp (final review A4). Both stamp painters run, the pair onFeedsChanged
// uses: with a visible calendar stampUpdated paints nothing, and a fetch time
// from before midnight must now name its day (final fixes 2, C1).
function tickToday() {
  if (toISO(new Date()) !== todayRenderedFor) {
    render();
    stampUpdated(); stampFromFeeds();
    return;
  }
  if (!todayRelative) return;
  todayRelative.node.textContent = relativeLabel(todayRelative.item, minutesNow(new Date())) || '';
}

// The interval is armed BEFORE the first tick (final fixes 2, C2): a first
// tick that throws must not leave Today with no tick at all.
function startTodayTick() {
  todayTick = { kind: 'interval', id: setInterval(tickToday, TODAY_TICK_MS) };
  tickToday();
}

function syncTodayTick() {
  const wanted = !els.todayView.hidden && document.visibilityState !== 'hidden';
  if (wanted && todayTick === null) {
    todayTick = { kind: 'align', id: setTimeout(startTodayTick, TODAY_TICK_MS - (Date.now() % TODAY_TICK_MS)) };
  }
  if (!wanted && todayTick !== null) {
    if (todayTick.kind === 'align') clearTimeout(todayTick.id);
    else clearInterval(todayTick.id);
    todayTick = null;
  }
}

// Every page is re-rendered on every change, so a to-do ticked on the To-do
// page also leaves the calendar views correct with no second trigger.
//
// refreshForToday runs first (sweep D4), so ANY render — a sync landing, a
// tap, a tab switch — catches the cursors up with the clock, not only a
// resume. It returns at once when the day has not changed.
function render() {
  refreshForToday();
  visibility = loadVisibility();
  renderToday(); renderCalendar(); renderWeek(); renderThreeDay(); renderDay(); renderTodos(); renderIdeas();
}

// The tab bar (home-screen spec § 4): Today | Calendar | To-do | Ideas.
// Calendar holds three views, chosen by its switcher, and opens on the one
// last used there (Day until another is picked; this session only). List was
// a fourth until stage 3d (Alex, 2026-10-22: "you can get rid of the list
// view").
const CALENDAR_VIEWS = ['day', '3day', 'week', 'month'];
const TAB_TITLES = { today: 'Today', calendar: 'Calendar', todo: 'To-do', ideas: 'Ideas' };
let lastCalendarView = 'day';

function showView(which) {
  const views = {
    today: els.todayView, month: els.calView, week: els.weekView, '3day': els.threeDayView, day: els.dayView,
    todo: els.todoView, ideas: els.ideasView,
  };
  const tabs = { today: els.tabToday, calendar: els.tabCalendar, todo: els.tabTodo, ideas: els.tabIdeas };
  const segments = { day: els.showDay, '3day': els.show3day, week: els.showWeek, month: els.showMonth };
  const tab = CALENDAR_VIEWS.includes(which) ? 'calendar' : which;
  if (tab === 'calendar') lastCalendarView = which;
  for (const [name, el] of Object.entries(views)) el.hidden = name !== which;
  // The markup says which page is showing to assistive tech, which does not
  // read the class; index.html carries the load-time values. A tab is
  // navigation: the showing one is aria-current="page" and the others carry
  // nothing (final fixes 2, D1). Calendar's segments are toggles: aria-pressed.
  for (const [name, b] of Object.entries(tabs)) {
    b.classList.toggle('active', name === tab);
    if (name === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const [name, b] of Object.entries(segments)) {
    b.classList.toggle('active', name === which);
    b.setAttribute('aria-pressed', String(name === which));
  }
  els.calSwitch.hidden = tab !== 'calendar';
  // Out of sight on Today, never out of the accessibility tree (final review
  // B3); the header keeps its height either way (styles.css).
  els.tabTitle.textContent = TAB_TITLES[tab];
  els.tabTitle.classList.toggle('visually-hidden', tab === 'today');
  render();
  syncTodayTick();
}

// A SPECIFIC day was chosen, so catch up with the clock BEFORE setting the
// cursors. Otherwise the render below would treat a tap on the old today's
// cell, just after midnight, as "the view that was showing today" and carry it
// to the new one. The arrows below do the same (sweep F, I3), for the same
// reason: an arrow acts on the day the user can see, and the render after it
// must not read the new cursor as "showing the old today".
function openDay(dateISO) {
  refreshForToday();
  viewDay = dateISO;
  viewWeekStart = startOfWeek(dateISO);
  showView('day');
}

els.time.addEventListener('input', () => { els.end.hidden = !els.time.value; if (!els.time.value) els.end.value = ''; });
els.date.addEventListener('input', syncTypeRow);
els.date.addEventListener('change', syncTypeRow);
window.addEventListener('pageshow', syncTypeRow);
els.add.addEventListener('click', () => { handleAdd(topTarget); });
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdd(topTarget); });
els.tabToday.addEventListener('click', () => showView('today'));
els.tabCalendar.addEventListener('click', () => showView(lastCalendarView));
els.tabTodo.addEventListener('click', () => showView('todo'));
els.tabIdeas.addEventListener('click', () => showView('ideas'));
els.showMonth.addEventListener('click', () => showView('month'));
els.showWeek.addEventListener('click', () => showView('week'));
els.showDay.addEventListener('click', () => showView('day'));
els.show3day.addEventListener('click', () => showView('3day'));
els.ideaAdd.addEventListener('click', handleIdeaAdd);

// The capture button and its box (home-screen spec § 3, js/capture.js). It
// adds through handleAdd with the capture box's own target, so its messages
// go to #capture-message and its preview to #capture-preview.
const capture = createCapture({
  els: {
    button: els.captureBtn, box: els.captureBox, field: els.captureText, add: els.captureAdd,
    cancel: els.captureCancel, close: els.captureClose, typeInstead: els.captureType, preview: els.capturePreview,
  },
  line: captureLine,
  voice: { isVoiceSupported, listen, errorKind },
  // The home-screen app and a Safari tab need different words when voice is
  // refused (spec § 3).
  isStandalone: () => navigator.standalone === true,
  submit: () => handleAdd(captureTarget),
  cancelSubmit: cancelAdd,
  closePreviews,
});
// Opening Settings stops a listen and keeps its text (spec § 3 step 4).
// settings.js's own listener on this button opens or closes the panel.
els.settingsBtn.addEventListener('click', () => { capture.stopAndKeep(); });
// An arrow steps from what is ON SCREEN (batch-F review, Important 1). It
// remembers the cursor the user can see, lets refreshForToday catch the OTHER
// cursors and lastToday up with the clock, then sets this one to the shown
// value ±1. Refreshing first and stepping from the caught-up cursor skipped a
// day on a stale screen (next from the old today landed on the day after the
// new one); not refreshing at all made the render bounce the step back (I3).
function stepFrom(shown, set) { refreshForToday(); set(shown); render(); }
els.prev.addEventListener('click', () => { const m = viewMonth; stepFrom(m, (v) => { viewMonth = new Date(v.getFullYear(), v.getMonth() - 1, 1); }); });
els.next.addEventListener('click', () => { const m = viewMonth; stepFrom(m, (v) => { viewMonth = new Date(v.getFullYear(), v.getMonth() + 1, 1); }); });
els.prevDay.addEventListener('click', () => stepFrom(viewDay, (v) => { viewDay = addDays(v, -1); }));
els.nextDay.addEventListener('click', () => stepFrom(viewDay, (v) => { viewDay = addDays(v, 1); }));
els.prevWeek.addEventListener('click', () => stepFrom(viewWeekStart, (v) => { viewWeekStart = addDays(v, -7); }));
els.nextWeek.addEventListener('click', () => stepFrom(viewWeekStart, (v) => { viewWeekStart = addDays(v, 7); }));
els.prev3day.addEventListener('click', () => stepFrom(viewThreeDayStart, (v) => { viewThreeDayStart = addDays(v, -3); }));
els.next3day.addEventListener('click', () => stepFrom(viewThreeDayStart, (v) => { viewThreeDayStart = addDays(v, 3); }));

render();
syncTodayTick();
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
//
// ONE BATCH AT A TIME (sweep D6). Two quick resumes must not fetch every
// calendar twice. A call that arrives while a batch is in flight is dropped
// for the feeds that batch already covers; any OTHER feed it names (one that
// applySyncedState just pulled) is queued and fetched when the batch settles,
// or a freshly linked calendar would sit empty until the next resume.
//
// When the batch settles it repaints the "Updated" stamp from the calendars
// themselves (sweep D1); see stampFromFeeds.
//
// EACH DOWNLOAD IS ABORTED AFTER 60 s (sweep F, I4): fetchWithTimeout, in
// js/fetchtimeout.js, which Settings' manual Sync and Add calendar share. A
// download that never finishes would otherwise hold the one batch slot
// forever: every later refresh dropped, every queued calendar never fetched.
// The timeout is per DOWNLOAD, not per batch: syncStale fetches calendars one
// after another, so a batch timeout failed slow-but-progressing batches and
// left the loop running (a resume could then fetch one calendar twice at
// once). A timed-out download is aborted and rejects, and syncFeed reports it
// {ok:false} — 'unreachable' if it timed out waiting for headers, 'parse_error'
// or 'server' if it timed out reading the body — and the loop moves on. Only
// `ok` is read here.
let feedBatch = null; // ids in the batch in flight, or null
const feedQueue = new Set();

function backgroundSyncFeeds(feedList) {
  if (feedBatch) {
    for (const f of feedList) if (!feedBatch.has(f.id)) feedQueue.add(f.id);
    return;
  }
  if (feedList.length === 0) return;
  feedBatch = new Set(feedList.map((f) => f.id));
  // results is syncStale's per-feed map (only the calendars it fetched), or
  // null when the whole batch failed and which calendars it reached is
  // unknown: then every one in it counts as failed. A calendar this batch did
  // not fetch (still fresh) keeps whatever its last fetch said.
  const settle = (results) => {
    feedBatch = null;
    feedCache = loadFeedCache();
    render();
    if (results === null) for (const f of feedList) failedFeedIds.add(f.id);
    else for (const [id, r] of Object.entries(results)) { if (r.ok) failedFeedIds.delete(id); else failedFeedIds.add(id); }
    stampFromFeeds();
    if (feedQueue.size > 0) {
      const queued = new Set(feedQueue);
      feedQueue.clear();
      backgroundSyncFeeds(feeds.filter((f) => queued.has(f.id)));
    }
  };
  syncStale(feedList, feedCache, { fetchImpl: fetchWithTimeout }).then((results) => {
    // A per-feed failure comes back as {ok:false}, never as a rejection.
    settle(results);
  }, (err) => {
    console.error('plaenicke: background calendar sync failed', err && err.name);
    settle(null); // the whole batch failed; which feeds it reached is unknown
  });
}
backgroundSyncFeeds(feeds);

// --- account sync (Task 5's syncOnce, wired to the page) -------------------
//
// Sync applies through the owners of each key, never through storage
// directly. app.js owns `items`; feeds.js owns feeds. See spec 5.5.
//
// It re-merges against LIVE storage first. Today sync.js calls this
// synchronously right after the merge that produced `state` (no await between
// them, in the main path or the CAS retry), so live storage still equals that
// merge's local input. The re-merge is the guard that keeps this correct if an
// await is ever added there: the user may then have added or deleted here,
// and writing `state` wholesale would destroy those edits — and
// for a feed, destroy a URL that is never rendered anywhere and so cannot be
// re-entered. Returns what it actually wrote; sync.js pushes THAT, not the
// state it was handed.
//
// There is no discard path. It existed only for the linking flow's "Replace
// this device", which was removed on 2026-10-19: every caller is re-merged.
export function applySyncedState(state) {
  const live = localState();
  // keepRemoteTombstones: `state` is already pruned, and every tombstone in it
  // is one the first merge kept — including one that suppressed a record only
  // the server held, which live storage never had. Re-pruning here dropped
  // it and pushed the deletion away (js/merge.js, prune()).
  const written = merge(live, state, new Date(), { keepRemoteTombstones: true });
  // Save BEFORE assigning, as addItems does: app.js saves from `items`, so a
  // failed write (QuotaError) that had already replaced it would render
  // records storage does not hold and have the next save of ANY item persist
  // them outside the sync path.
  saveItems(written.items);
  items = written.items;
  // applyRemoteFeeds requires the COMPLETE merged feed list (written.feeds,
  // never a delta) — it deletes+tombstones every local feed absent from its
  // argument, and a partial list would propagate a deletion of every other
  // feed to every device.
  //
  // ORDER MATTERS here. applyRemoteFeeds's own removeFeed() call (for every
  // local feed absent from written.feeds — i.e. one a merged tombstone
  // suppresses) writes a feed tombstone via addTombstone() stamped by THIS
  // device (now, or just after the feed's own updatedAt — nextStamp). The
  // full-overwrite saveTombstones() below then leaves the stored tombstones
  // exactly equal to written.tombstones, so a deletion pulled from another
  // device keeps its original deletedAt. Swap these two
  // lines and every such deletion is re-stamped with this device's clock.
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
  // Never run while the user hasn't chosen Merge / Cancel yet (spec 5.7) —
  // only the linking flow's adoption may lift the gate.
  if (!isLinked() || isAdoptionPending()) return;
  // ONLY THE VISIBLE TAB SYNCS (decided 2026-10-19, instead of a cross-tab
  // lock). Every trigger comes through here — the scheduleSync timer, the
  // `online` listener, the load-time call, the visible-again call — so this
  // one check gates all of them. A hidden tab's skipped sync is not queued:
  // the visibilitychange listener below runs runSync on EVERY return to
  // visible, and a sync pushes the whole local state rather than replaying a
  // queue, so whatever a hidden tab skipped (including the delete that
  // backgrounding itself commits) goes out then. A flag would add a second
  // thing to forget. `undefined` (no Page Visibility API) is not 'hidden',
  // so it syncs as before. This decides whether a sync STARTS; one already
  // in flight when the tab hides runs to completion.
  //
  // ACCEPTED GAP: two windows visible at once (side by side on a desktop) can
  // both sync. That is bounded by the server's version check (every PUT is a
  // compare-and-swap on the version it read; adoption also pins
  // expectVersion), not by this gate.
  if (document.visibilityState === 'hidden') return;
  if (syncInFlight) { syncPending = true; return; }
  syncInFlight = true;
  try {
    await syncOnce({
      // The read gives up at the shared download deadline and reports as
      // offline; the write never does (js/sync.js, punchlist L63).
      readFetchImpl: fetchWithTimeout,
      // The write, wrapped so the shell indicator can say "taking longer than
      // usual" once it has been in flight past linkui.js's SLOW_WRITE_MS, and
      // clear it when it settles. Only the PUT travels through fetchImpl, so
      // a slow read never shows it, and sync.js needs no change.
      fetchImpl: async (u, o) => {
        syncWriteStarted();
        try {
          return await fetch(u, o);
        } finally {
          syncWriteSettled();
        }
      },
      now: () => new Date(),
      apiBase: WORKER_URL,
      applyState: applySyncedState,
    });
  } catch (err) {
    // Never let a sync failure break the app; local data keeps rendering.
    console.error('sync', err && err.name);
    // But never let it be SILENT either: record it, so the renderSyncStatus
    // below lights the shell indicator instead of leaving it dark. Recording
    // writes storage, which can itself throw when the device is full; that
    // must not escape either, since runSync is called from listeners/timers.
    try {
      recordSyncFailure(err);
    } catch (recordErr) {
      console.error('sync record', recordErr && recordErr.name);
    }
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
// tab on every tick. storage.js's own constants, never literals: a renamed
// key would otherwise leave this listener silently dead.
//
// All three keys are in the synced blob, so the event also SCHEDULES A SYNC.
// Only the visible tab syncs (runSync's gate): a write made in a tab that
// hides inside the 2 s debounce has its push skipped there, and without this
// it would wait, unpushed, for as long as the user works in this tab instead.
// A hidden tab receiving the event schedules too, and its runSync returns at
// the gate. This cannot ping-pong between two visible tabs: an applied sync
// that changes nothing rewrites the three keys with byte-identical values,
// and setItem with an unchanged value fires no storage event (HTML Living
// Standard, Web Storage, setItem steps). tests/apply.test.js runs the loop.
const CROSS_TAB_KEYS = [STORAGE_KEY, FEEDS_KEY, TOMBSTONES_KEY];
window.addEventListener('storage', (e) => {
  // Series visibility is device-local, not synced data: another tab's hide is
  // shown here (render() re-reads it) and NO sync is scheduled.
  if (e.key === SERIES_VISIBILITY_KEY) { render(); return; }
  if (!CROSS_TAB_KEYS.includes(e.key)) return;
  items = loadItems();
  feeds = loadFeeds();
  feedCache = loadFeedCache();
  render();
  scheduleSync();
});

// --- Phase 0: staying current across a resume -----------------------------
//
// A cursor the user navigated away from is left alone (followToday); only one
// that was showing the old today follows the clock.
function refreshForToday() {
  // Before the early return: a zone change need not change the date.
  deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = toISO(new Date());
  if (today === lastToday) return;
  viewDay = followToday(viewDay, lastToday, today);
  viewThreeDayStart = followToday(viewThreeDayStart, lastToday, today);
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

// The "Updated" stamp says how current the screen is (sweep D1).
//
// With no visible calendars, everything on screen is local, so a render is
// the refresh: stampUpdated paints the render time. With visible calendars,
// the calendars are the part that goes stale, so the stamp waits for the
// feed batch to settle and stampFromFeeds paints it from their fetch times.
//
// A time from an earlier day names the day ("Yesterday, 9:02 AM"), so a
// days-old fetch can never pass for this morning's.
function clockLabel(d) {
  const clock = formatTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  const today = toISO(new Date());
  return toISO(d) === today ? clock : `${formatDayLabel(toISO(d), today)}, ${clock}`;
}

function visibleFeeds() { return feeds.filter((f) => !f.hidden); }

function stampUpdated() {
  if (visibleFeeds().length > 0) return; // painted when the feed batch settles
  els.updatedStamp.textContent = `Updated ${clockLabel(new Date())}`;
}

// The OLDEST fetch among the visible calendars: the stamp promises that
// everything on screen is at least that fresh.
//
// A visible calendar whose latest fetch failed (failedFeedIds) has not been
// refreshed, and the stamp says so until a fetch of THAT calendar succeeds. The
// memory is what keeps a later repaint — a colour tap in Settings — from
// painting an old time over "Couldn't refresh". A visible calendar with no
// cached fetch and no failure is still being fetched for the first time (one
// just added in Settings, or queued behind a running batch); it is left out
// rather than reported failed, and if nothing visible has been fetched yet the
// stamp is left as it is. Hidden calendars are not on screen and do not count
// either way.
function stampFromFeeds() {
  const visible = visibleFeeds();
  if (visible.length === 0) return; // keep the render-time stamp
  if (visible.some((f) => failedFeedIds.has(f.id))) {
    els.updatedStamp.textContent = "Couldn't refresh calendars";
    return;
  }
  const times = visible
    .map((f) => Date.parse(feedCache[f.id] && feedCache[f.id].fetchedAt))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return; // nothing fetched yet: keep what is shown
  els.updatedStamp.textContent = `Updated ${clockLabel(new Date(Math.min(...times)))}`;
}

// Touch-down feedback on every button and [data-press] row (home-screen spec
// § 5, js/press.js). Once, for the page's lifetime: never uninstalled.
installPress(document);

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
    syncTodayTick();
    // A listen stops and keeps its text; nothing is added (spec § 3 step 4).
    // Last: committing pending deletes matters more, and must not wait on it.
    capture.stopAndKeep();
    return;
  }
  if (document.visibilityState !== 'visible') return;
  noteLaunch();
  render(); // refreshForToday runs first, inside render
  syncTodayTick();
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
