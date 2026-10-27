// settings.js — the settings overlay: appearance + linked calendars.
//
// Linked calendars (Task 8) is DOM glue over js/feeds.js (Task 6): this file
// never touches localStorage directly (the theme key below is the one
// historical exception) and never prunes/deletes feed cache entries itself —
// `feeds.removeFeed(id)` is the only sanctioned way to remove a feed, and
// `syncFeed`'s own cache read-modify-write is the only writer of
// plaenicke.feedCache. Feed URLs are secrets (capability tokens can live in
// the path/query) — once a feed is added, its URL is never re-displayed in
// the DOM and never logged; only `feed.name` and `feedStatus(...)` text are
// shown.
import { resolveTheme, THEME_KEY } from './theme.js';
import {
  syncFeed, feedStatus, removeFeed, webcalToHttps, inferName, feedShape, describeFeedShape,
} from './feeds.js';
import { loadFeeds, saveFeeds, loadFeedCache, loadLaunches, QuotaError } from './storage.js';
import { describeLaunches } from './freshness.js';
import { initLinkUI } from './linkui.js';
import { uid } from './uid.js';
import { nowISO } from './dateparse.js';
import { lock } from './scrolllock.js';
import { fetchWithTimeout } from './fetchtimeout.js';
import { FEED_PALETTE } from './palette.js';
import {
  loadVisibility, hiddenSeriesFor, showSeries, UnlinkedCalendarError,
} from './visibility.js';

const CHOICES = ['light', 'dark', 'auto'];

// Calendars are auto-assigned from FEED_PALETTE (js/palette.js) and cycle
// through it on a tap of the colour dot.
function nextColor(color) {
  const idx = FEED_PALETTE.indexOf(color);
  return FEED_PALETTE[(idx + 1) % FEED_PALETTE.length];
}

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(setting) {
  const resolved = resolveTheme(setting, systemPrefersDark());
  if (resolved === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

function getSetting() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
  return CHOICES.includes(t) ? t : 'auto';
}

// applyState is app.js's applySyncedState, threaded straight through to
// linkui.js. It is INJECTED rather than imported there because linkui.js
// already supplies app.js with renderSyncStatus; importing applySyncedState
// back would close a cycle that drags the whole DOM-bound app.js into
// linkui.js's unit tests (DA-C6).
// The Tab stops under `root`, in DOM order: the enabled buttons and form
// controls outside any `hidden` subtree. These are the only kinds the panel
// draws (its heading is a script-only target, tabindex -1); a link added to
// it would need adding here.
const TAB_STOP_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
function tabStops(root) {
  const out = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (c.hidden) continue;
      if (TAB_STOP_TAGS.has(c.tagName) && !c.disabled) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

export function initSettings({
  button, host, onFeedsChanged, onSyncedDataChanged, onFeedFetched, applyState,
}) {
  // A missing wire here is silent data loss, not a degraded feature: without
  // it a calendar added or removed in this panel never reaches the account
  // until something unrelated happens to trigger a sync. Fail at mount, where
  // it is a one-line fix, rather than at the moment a subscription is lost.
  if (typeof onSyncedDataChanged !== 'function') {
    throw new Error('initSettings requires an onSyncedDataChanged callback');
  }
  // Every fetch this panel makes reports its result (feed id, ok) here, before
  // the view notification: app.js's "Updated" stamp remembers which calendars
  // failed, and a fetch it never heard about leaves that memory wrong.
  if (typeof onFeedFetched !== 'function') {
    throw new Error('initSettings requires an onFeedFetched callback');
  }

  // Follow the phone while in auto.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => applyTheme(getSetting()));

  // TWO KINDS OF CHANGE, AND THEY ARE NOT INTERCHANGEABLE (spec 6.3).
  //
  // notifyViewChanged: this device's own view moved and nothing the account
  // holds did. `color` and `hidden` are per-device preferences that toWire
  // strips before anything is encrypted, and the feed cache is not synced at
  // all — so pushing on these would fire a sync on every colour tap and change
  // nothing on any other device. They are also this panel's highest-frequency
  // writes, which is exactly why spec 6.3 keeps them off the wire.
  //
  // notifySyncedChanged: plaenicke.feeds (and, on a removal, the feed
  // tombstone in plaenicke.syncTombstones) changed — that IS what the account
  // holds. It must reach app.js's scheduleSync, because nothing else will: a
  // feed change has no other push trigger, closing this modal changes neither
  // `visibilityState` nor connectivity, and a feed URL is the single record in
  // this app that cannot be re-entered from anything on screen (this file
  // never re-displays one). An unpushed item is a re-typed line; an unpushed
  // feed lost with the device is gone.
  function notifyViewChanged() { if (onFeedsChanged) onFeedsChanged(); }

  function notifySyncedChanged() {
    // View first: app.js reloads its snapshot before the sync it is about to
    // schedule reads storage back.
    notifyViewChanged();
    onSyncedDataChanged();
  }

  // Tab is kept inside the panel while it is open (final fixes 2, C6), as the
  // item sheet keeps it inside the sheet (js/itemsheet.js, sweep U6), with the
  // same rule: only the two edges, and focus outside the panel (its heading,
  // or the page behind), are taken over; every other Tab is the browser's
  // own. The sheet builds its list once; this panel's controls change while
  // it is open (a Remove question, the sync section, a disabled Add), so the
  // list is read from the panel at each Tab press.
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Tab') return;
    const focusables = tabStops(host);
    if (focusables.length === 0) return;
    const i = focusables.indexOf(document.activeElement);
    const last = focusables.length - 1;
    if (e.shiftKey ? i <= 0 : (i === -1 || i === last)) {
      e.preventDefault();
      focusables[e.shiftKey ? last : 0].focus();
    }
  }

  // The page scroll lock is shared with the item sheet (js/scrolllock.js,
  // sweep F O2); this panel's own hold, or null while it is closed.
  let releaseScroll = null;

  // Focus goes back to the Settings button on every close path (the button,
  // Escape, a backdrop tap), as the item sheet returns it to its opener (app.js's
  // focusOpener): otherwise it falls back to the top of the document. Without
  // scrolling, for the same reason.
  function close() {
    host.innerHTML = '';
    if (releaseScroll) { releaseScroll(); releaseScroll = null; }
    document.removeEventListener('keydown', onKey);
    button.focus({ preventScroll: true });
  }

  function open() {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', 'Settings');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    const h = document.createElement('h2');
    h.textContent = 'Settings';
    // Focus moves here once the panel is mounted (below), as the item sheet's
    // does to its heading: focusable by script only (tabindex -1), never by Tab.
    h.setAttribute('tabindex', '-1');
    panel.appendChild(h);

    const appearance = document.createElement('div');
    appearance.className = 'settings-section';
    const ah = document.createElement('h3');
    ah.textContent = 'Appearance';
    const seg = document.createElement('div');
    seg.className = 'seg';
    const current = getSetting();
    for (const choice of CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = choice[0].toUpperCase() + choice.slice(1);
      if (choice === current) b.classList.add('active');
      b.addEventListener('click', () => {
        try { localStorage.setItem(THEME_KEY, choice); } catch { /* private mode */ }
        applyTheme(choice);
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      });
      seg.appendChild(b);
    }
    // Phase 0 baseline: how often this device actually opens the app.
    // Local-only (storage.js's launch log), never synced.
    const usage = document.createElement('p');
    usage.className = 'note usage-note';
    usage.textContent = describeLaunches(loadLaunches(), new Date());
    appearance.append(ah, seg, usage);

    // --- Linked calendars ---------------------------------------------
    //
    // Local state for the lifetime of this open panel. Re-read from storage
    // every time the panel opens (open() runs fresh each click); everything
    // below mutates these same bindings in place rather than closing over
    // stale copies, so handlers built in an earlier renderCalendars() pass
    // still see later writes.
    let feeds = loadFeeds();
    let feedCache = loadFeedCache();
    // In-flight/last sync errors, keyed by feed id — EPHEMERAL (per feeds.js's
    // feedStatus contract): never written to storage, only fed into
    // feedStatus's `cacheEntry.error` so a just-failed sync shows an inline
    // error even when nothing was ever persisted for that feed.
    const syncErrors = {};
    // Only one sync (add's first sync, or a row's Sync button) runs at a
    // time: syncFeed's cache read-modify-write isn't safe under concurrent
    // calls for different feeds (same reasoning as syncStale's sequential
    // loop). The actual lock is an `isBusy()` early-return at the top of both
    // syncFeed-calling entry points (`runSync`, `handleAdd`) — every disabled
    // button/input below is UX only (so the click/Enter never fires in the
    // first place); the early-return is what makes it safe even when a
    // handler *does* fire while busy (e.g. Enter on a text input, which
    // .disabled on a button can't intercept).
    // syncingFeedId is null when idle, or the id currently mid-sync — used
    // both to gate every button (`busy`) and to label just that one row's
    // Sync button "Syncing…" (an id not yet in `feeds` during Add's own
    // first sync still gets its "Syncing…" label via the new row's own render).
    let syncingFeedId = null;
    let addBusy = false;
    let urlErrorMsg = '';
    // renderCalendars() rebuilds the whole section (including the Add form)
    // on every row action, e.g. toggling a different feed's Hide button —
    // draft text must survive that rebuild rather than being wiped.
    let urlDraft = '';
    let nameDraft = '';
    // The row whose Remove is waiting for its confirmation, or null. Remove is
    // TWO taps (punchlist, decided 2026-10-19): since sweep fix 1 a removal is
    // pushed to the account within 2 s, so one mis-tap deleted the calendar
    // from every device, and its link — a capability token this panel never
    // shows again — could not be typed back in. The first tap only asks; Cancel
    // leaves storage, tombstones and the sync schedule exactly as they were.
    let confirmingRemoveId = null;
    function isBusy() { return syncingFeedId !== null || addBusy; }
    // A Show under "Hidden on this device" that could not be saved, by feed
    // id: shown on that calendar's list until the next Show there.
    const hiddenErrors = {};

    // reapplyFeedField: closes the "two writers on plaenicke.feeds" gap —
    // this panel opened with a possibly-stale `feeds` snapshot, and Task 8
    // mounts the linking UI inside this same panel, so a newly linked
    // device's first sync can land in storage while the panel is still open.
    // The `storage` event doesn't fire in the tab that wrote (Task 7's
    // cross-tab listener can't help here), so a stale-snapshot write is the
    // ONLY way this bug can be reached. Re-reading storage immediately
    // before writing, then patching only the field the user actually
    // changed onto that fresh read, means the write is always "sync's
    // latest plus this one edit" — never "sync's latest minus everything
    // sync did since the panel opened".
    function reapplyFeedField(id, computePatch) {
      const fresh = loadFeeds();
      const next = fresh.map((f) => (f.id === id ? { ...f, ...computePatch(f) } : f));
      saveFeeds(next);
      feeds = next;
      return next;
    }

    const calendars = document.createElement('div');
    calendars.className = 'settings-section';
    const ch = document.createElement('h3');
    ch.textContent = 'Linked calendars';
    const body = document.createElement('div');
    calendars.append(ch, body);

    function statusFor(feed) {
      const entry = syncErrors[feed.id]
        ? { ...(feedCache[feed.id] || {}), error: syncErrors[feed.id] }
        : feedCache[feed.id];
      return feedStatus(feed, entry, new Date());
    }

    // The stage-1 readout (home-screen spec § 2.4): how this calendar's cached
    // events repeat, and whether stage 3a reads it by RRULE or by the
    // heuristic. Cache only — no network, and the feed URL is never read. No
    // line before a first sync (no entry), and none after a quota drop: those
    // events were emptied to free storage (feedStatus says so), and counting
    // the empty list would describe a calendar that is not there. A throw is
    // shown on the row and logged by error name only, never swallowed.
    function shapeLineFor(feed) {
      const entry = feedCache[feed.id];
      if (!entry || entry.quotaDropped || !Array.isArray(entry.events)) return null;
      const line = document.createElement('div');
      line.className = 'feed-shape';
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        line.textContent = describeFeedShape(feedShape(entry.events, tz));
      } catch (err) {
        line.textContent = "Couldn't classify this calendar's events.";
        console.error(`plaenicke: feed shape failed (${err && err.name ? err.name : 'unknown'})`);
      }
      return line;
    }

    // "Hidden on this device (N)" (option A, 2026-10-26): every series this
    // device hides from this calendar, with a Show button, because a series
    // hidden from both the calendar and the lists has no row left to tap.
    // DEVICE-LOCAL: Show writes plaenicke.seriesVisibility only (through
    // js/visibility.js) and is a VIEW change — notifyViewChanged, never
    // notifySyncedChanged. Read fresh on every renderCalendars(), so the list
    // is never a snapshot from when the panel opened. Names only: a series is
    // listed by its event title, never by anything from the feed's URL.
    function hiddenBlockFor(feed, visMap) {
      const rows = hiddenSeriesFor(visMap, feed.id);
      if (rows.length === 0) return null;
      const block = document.createElement('div');
      block.className = 'feed-hidden';
      const head = document.createElement('p');
      head.className = 'feed-hidden-head';
      head.textContent = `Hidden on this device (${rows.length})`;
      block.appendChild(head);
      for (const r of rows) {
        const name = r.title || 'Untitled event';
        const row = document.createElement('div');
        row.className = 'feed-hidden-row';
        const n = document.createElement('span');
        n.className = 'feed-hidden-name';
        n.textContent = name;
        const where = document.createElement('span');
        where.className = 'feed-hidden-where';
        where.textContent = !r.calendar && !r.list ? 'everywhere' : (!r.list ? 'from Today & lists' : 'from calendar');
        const show = document.createElement('button');
        show.type = 'button';
        show.textContent = 'Show';
        show.setAttribute('aria-label', `Show ${name} again`);
        show.addEventListener('click', () => {
          try {
            showSeries(feed.id, r.uid);
          } catch (err) {
            let why = `an error (${err && err.name ? err.name : 'unknown'})`;
            if (err instanceof QuotaError) why = 'this device is out of storage';
            else if (err instanceof UnlinkedCalendarError) why = 'this calendar is no longer linked on this device';
            hiddenErrors[feed.id] = `${name} couldn't be shown again: ${why}.`;
            console.error('plaenicke: showing a hidden series failed', err && err.name);
            renderCalendars();
            return;
          }
          delete hiddenErrors[feed.id];
          renderCalendars();
          notifyViewChanged();
        });
        row.append(n, where, show);
        block.appendChild(row);
      }
      if (hiddenErrors[feed.id]) {
        const err = document.createElement('p');
        err.className = 'note feed-hidden-error';
        err.setAttribute('role', 'alert');
        err.textContent = hiddenErrors[feed.id];
        block.appendChild(err);
      }
      return block;
    }

    async function runSync(feed) {
      // Entry-point lock (see comment above `syncErrors`): text inputs have
      // no `.disabled` gate, so this guard — not the buttons' disabled state
      // — is what actually prevents a second concurrent syncFeed call.
      if (isBusy()) return;
      syncingFeedId = feed.id;
      renderCalendars();
      let result;
      try {
        result = await syncFeed(feed, { fetchImpl: fetchWithTimeout, manual: true });
      } catch (err) {
        // syncFeed only throws on a genuine non-quota storage bug (see
        // feeds.js); never include the feed object/URL in the log, same
        // capability-token rule app.js's background sync follows.
        result = { ok: false, error: 'server' };
        console.error('plaenicke: manual calendar sync failed', err && err.name);
      }
      if (result.ok) delete syncErrors[feed.id];
      else syncErrors[feed.id] = result.error;
      feedCache = loadFeedCache();
      syncingFeedId = null;
      renderCalendars();
      onFeedFetched(feed.id, result.ok);
      notifyViewChanged();
    }

    function renderCalendars() {
      body.innerHTML = '';
      const visMap = loadVisibility();

      if (feeds.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'feed-empty';
        empty.textContent = 'No calendars linked yet.';
        body.appendChild(empty);
      } else {
        const list = document.createElement('ul');
        list.className = 'feed-list';
        for (const feed of feeds) {
          const row = document.createElement('li');
          row.className = 'feed-row';

          const main = document.createElement('div');
          main.className = 'feed-row-main';

          const dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'feed-dot';
          dot.style.setProperty('--feed-color', feed.color);
          dot.setAttribute('aria-label', `Change color for ${feed.name}`);
          dot.disabled = isBusy();
          dot.addEventListener('click', () => {
            reapplyFeedField(feed.id, (f) => ({ color: nextColor(f.color) }));
            renderCalendars();
            notifyViewChanged();
          });

          const name = document.createElement('span');
          name.className = 'feed-name';
          name.textContent = feed.name;

          main.append(dot, name);

          const status = document.createElement('div');
          status.className = 'feed-status';
          status.textContent = statusFor(feed);

          const actions = document.createElement('div');
          actions.className = 'feed-actions';

          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.textContent = feed.hidden ? 'Show' : 'Hide';
          toggle.disabled = isBusy();
          toggle.addEventListener('click', () => {
            reapplyFeedField(feed.id, (f) => ({ hidden: !f.hidden }));
            renderCalendars();
            notifyViewChanged();
          });

          const syncBtn = document.createElement('button');
          syncBtn.type = 'button';
          syncBtn.textContent = syncingFeedId === feed.id ? 'Syncing…' : 'Sync';
          syncBtn.disabled = isBusy();
          syncBtn.addEventListener('click', () => runSync(feed));

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'remove';
          removeBtn.textContent = 'Remove';
          removeBtn.disabled = syncingFeedId === feed.id;
          // First tap: ask, and touch nothing else.
          removeBtn.addEventListener('click', () => {
            confirmingRemoveId = feed.id;
            renderCalendars();
          });

          // The question names the calendar (feed.name — never its URL) and
          // says what the second tap does.
          const confirmNote = document.createElement('p');
          confirmNote.className = 'note feed-remove-confirm';
          confirmNote.textContent = `Remove "${feed.name}" from every device? `
            + 'Its calendar link is never shown again and cannot be typed back in.';

          const cancelRemoveBtn = document.createElement('button');
          cancelRemoveBtn.type = 'button';
          cancelRemoveBtn.textContent = 'Cancel';
          cancelRemoveBtn.addEventListener('click', () => {
            confirmingRemoveId = null;
            renderCalendars();
          });

          const confirmRemoveBtn = document.createElement('button');
          confirmRemoveBtn.type = 'button';
          confirmRemoveBtn.className = 'remove';
          confirmRemoveBtn.textContent = 'Remove from every device';
          confirmRemoveBtn.disabled = syncingFeedId === feed.id;
          confirmRemoveBtn.addEventListener('click', () => {
            confirmingRemoveId = null;
            // Same catch+surface shape as runSync/handleAdd above: removeFeed
            // only throws on a genuine storage failure (see feeds.js), never
            // include the feed object/URL in the log. On failure, leave
            // `feeds`/`feedCache` untouched — removeFeed's own tombstone-first
            // ordering means a thrown error left the feed still linked, so
            // the row should keep showing it, now with an inline error.
            try {
              removeFeed(feed.id);
            } catch (err) {
              syncErrors[feed.id] = 'remove_failed';
              console.error('plaenicke: calendar remove failed', err && err.name);
              renderCalendars();
              return;
            }
            // RE-READ, never rebuild from the snapshot open() captured — same
            // reasoning as reapplyFeedField and handleAdd above.
            // removeFeed() has already done its own load-filter-save, so this
            // is "storage's latest, minus the one just removed". Filtering the
            // stale closure instead dropped any feed a sync pulled in while
            // this panel sat open, and the list went straight to "No calendars
            // linked yet" beside a subscription that still existed.
            feeds = loadFeeds();
            delete feedCache[feed.id];
            delete syncErrors[feed.id];
            renderCalendars();
            // SYNCED: removeFeed wrote a feed tombstone, and nothing else in
            // the app will push it.
            notifySyncedChanged();
          });

          const shapeLine = shapeLineFor(feed);
          const hiddenBlock = hiddenBlockFor(feed, visMap);
          const head = [main, status, shapeLine, hiddenBlock].filter(Boolean);
          if (confirmingRemoveId === feed.id) {
            actions.append(confirmRemoveBtn, cancelRemoveBtn);
            row.append(...head, confirmNote, actions);
          } else {
            actions.append(toggle, syncBtn, removeBtn);
            row.append(...head, actions);
          }
          list.appendChild(row);
        }
        body.appendChild(list);
        // Google serves calendar feeds with a lag of hours, so a change made a
        // minute ago can still be missing after a manual Sync (punchlist L130).
        const lag = document.createElement('p');
        lag.className = 'note feed-lag-note';
        lag.textContent = 'Google calendars can take a few hours to show recent changes.';
        body.appendChild(lag);
      }

      // --- Add calendar ---
      const addWrap = document.createElement('div');
      addWrap.className = 'feed-add';

      const urlInput = document.createElement('input');
      urlInput.type = 'text'; // not type=url — webcal:// must be enterable without native validation blocking it
      urlInput.name = 'feed-url';
      urlInput.placeholder = 'Calendar link (https:// or webcal://)';
      urlInput.setAttribute('aria-label', 'Calendar link');
      urlInput.autocomplete = 'off';
      urlInput.autocapitalize = 'off';
      urlInput.spellcheck = false;
      urlInput.value = urlDraft;
      // UX belt-and-braces alongside handleAdd's own isBusy() early-return
      // (the actual lock): a disabled input also can't receive focus/typing,
      // so this keeps the field from looking editable while a sync no-ops.
      urlInput.disabled = isBusy();
      urlInput.addEventListener('input', () => { urlDraft = urlInput.value; });

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.name = 'feed-name';
      nameInput.placeholder = 'Name (optional)';
      nameInput.setAttribute('aria-label', 'Calendar name (optional)');
      nameInput.value = nameDraft;
      nameInput.disabled = isBusy();
      nameInput.addEventListener('input', () => { nameDraft = nameInput.value; });

      const addMsg = document.createElement('p');
      addMsg.className = 'note feed-add-msg';
      addMsg.textContent = urlErrorMsg;

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.textContent = addBusy ? 'Adding…' : 'Add calendar';
      addBtn.disabled = isBusy();

      async function handleAdd() {
        // Entry-point lock — same reasoning as runSync's guard. Reachable via
        // Enter in urlInput/nameInput even while the Add button is disabled,
        // since keydown on a text input isn't blocked by another element's
        // `.disabled` attribute.
        if (isBusy()) return;
        const raw = urlInput.value.trim();
        if (!raw) {
          urlErrorMsg = 'Enter a calendar link.';
          renderCalendars();
          return;
        }
        // A name is shown on every row and synced; the link is a capability
        // token that is never shown again. A link pasted into the Name box
        // would put it on screen and on the wire, so it is refused, and the
        // message never repeats it.
        if (/^(https?|webcal):/i.test(nameInput.value.trim())) {
          urlErrorMsg = 'That name is a link. Put the link in the first box, and a name (or nothing) in the second.';
          renderCalendars();
          return;
        }
        urlErrorMsg = '';
        const url = webcalToHttps(raw);
        const name = nameInput.value.trim() || inferName(url);
        // Re-read immediately before the write (same reasoning as
        // reapplyFeedField above): appending onto the stale `feeds` closure
        // would silently drop anything sync wrote while this panel sat open.
        const fresh = loadFeeds();
        const color = FEED_PALETTE[fresh.length % FEED_PALETTE.length];
        const feed = {
          id: uid('feed'), url, name, color, hidden: false,
          updatedAt: nowISO(),
        };

        feeds = [...fresh, feed];
        saveFeeds(feeds);
        urlDraft = '';
        nameDraft = '';
        addBusy = true;
        syncingFeedId = feed.id;
        renderCalendars();
        // SYNCED: the subscription is already in plaenicke.feeds. Push it now
        // rather than after the ICS fetch below — the URL is unrecoverable and
        // the fetch may never succeed.
        notifySyncedChanged();

        let result;
        try {
          result = await syncFeed(feed, { fetchImpl: fetchWithTimeout, manual: true });
        } catch (err) {
          result = { ok: false, error: 'server' };
          console.error('plaenicke: initial calendar sync failed', err && err.name);
        }
        if (result.ok) delete syncErrors[feed.id];
        else syncErrors[feed.id] = result.error;
        feedCache = loadFeedCache();
        addBusy = false;
        syncingFeedId = null;
        renderCalendars();
        onFeedFetched(feed.id, result.ok);
        notifyViewChanged();
      }

      addBtn.addEventListener('click', handleAdd);
      const onEnter = (e) => { if (e.key === 'Enter') handleAdd(); };
      urlInput.addEventListener('keydown', onEnter);
      nameInput.addEventListener('keydown', onEnter);

      addWrap.append(urlInput, nameInput, addMsg, addBtn);
      body.appendChild(addWrap);
    }

    // Re-read this panel's own snapshot from storage and redraw the list.
    // Used when something OUTSIDE this panel's own handlers wrote feeds —
    // today that is only an adoption landing while the panel sits open.
    function refreshCalendars() {
      feeds = loadFeeds();
      feedCache = loadFeedCache();
      renderCalendars();
      notifyViewChanged();
    }

    renderCalendars();

    // --- Sync (Task 8) ------------------------------------------------
    //
    // MOUNTED HERE, not from initSettings, and against its own sub-element.
    // open() rebuilds the whole panel on every click and close() does
    // `host.innerHTML = ''` (both in initSettings, above), so a single initLinkUI call from
    // initSettings against the panel host would be wiped on the first open.
    // Mounting per open against a fresh `linkHost` is what keeps it
    // idempotent: no listener ever accumulates, because the element every
    // listener is attached to is discarded with the panel. initLinkUI itself
    // makes no network call on mount unless an adoption is already pending.
    const account = document.createElement('div');
    account.className = 'settings-section';
    const sh = document.createElement('h3');
    sh.textContent = 'Sync';
    const linkHost = document.createElement('div');
    account.append(sh, linkHost);

    panel.append(appearance, calendars, account);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);
    // AFTER the panel is in the document: linkui.js's status line is found by
    // id (renderSyncStatus), and an element that is not in the document is
    // not findable.
    initLinkUI({
      host: linkHost,
      applyState,
      // Adoption can pull an entire account's worth of calendars. notifyChanged
      // alone only refreshes app.js's snapshot — THIS panel's own `feeds` and
      // `feedCache` bindings were captured when open() ran, and
      // renderCalendars() would never re-run, so the list sitting directly
      // above still read "No calendars linked yet" next to five freshly pulled
      // subscriptions. Display only (reapplyFeedField, handleAdd and Remove
      // all re-read storage before writing), but wrong on screen.
      onLinked: refreshCalendars,
      onUnlinked: refreshCalendars,
    });
    if (!releaseScroll) releaseScroll = lock(); // no scrolling behind the modal (iOS)
    document.addEventListener('keydown', onKey);
    h.focus();
  }

  button.addEventListener('click', () => { host.childElementCount ? close() : open(); });

  // The inline pre-paint script already applied a theme from its own copy of this
  // logic; re-apply through resolveTheme() so js/theme.js is the source of truth.
  applyTheme(getSetting());
}
