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
  syncFeed, feedStatus, removeFeed, webcalToHttps, inferName,
} from './feeds.js';
import { loadFeeds, saveFeeds, loadFeedCache } from './storage.js';
import { uid } from './uid.js';

const CHOICES = ['light', 'dark', 'auto'];

// The fixed 6-color palette calendars are auto-assigned from, tap-to-cycle.
// Each entry is a CSS custom-property *reference* (not a raw hex) — stored
// verbatim in feed.color and set as the inline `--feed-color` custom
// property at every render site (app.js, Task 7), so the actual displayed
// color resolves through the token cascade and stays theme-correct without
// this module (or app.js) ever special-casing light/dark. Swatch values
// themselves live in styles.css as --feed-palette-1..6.
const PALETTE = [
  'var(--feed-palette-1)', 'var(--feed-palette-2)', 'var(--feed-palette-3)',
  'var(--feed-palette-4)', 'var(--feed-palette-5)', 'var(--feed-palette-6)',
];

function nextColor(color) {
  const idx = PALETTE.indexOf(color);
  return PALETTE[(idx + 1) % PALETTE.length];
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

export function initSettings({ button, host, onFeedsChanged }) {
  // Follow the phone while in auto.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => applyTheme(getSetting()));

  function notifyChanged() { if (onFeedsChanged) onFeedsChanged(); }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    host.innerHTML = '';
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
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
    appearance.append(ah, seg);

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
    function isBusy() { return syncingFeedId !== null || addBusy; }

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

    async function runSync(feed) {
      // Entry-point lock (see comment above `syncErrors`): text inputs have
      // no `.disabled` gate, so this guard — not the buttons' disabled state
      // — is what actually prevents a second concurrent syncFeed call.
      if (isBusy()) return;
      syncingFeedId = feed.id;
      renderCalendars();
      let result;
      try {
        result = await syncFeed(feed, { fetchImpl: fetch, manual: true });
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
      notifyChanged();
    }

    function renderCalendars() {
      body.innerHTML = '';

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
            feed.color = nextColor(feed.color);
            saveFeeds(feeds);
            renderCalendars();
            notifyChanged();
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
            feed.hidden = !feed.hidden;
            saveFeeds(feeds);
            renderCalendars();
            notifyChanged();
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
          removeBtn.addEventListener('click', () => {
            removeFeed(feed.id);
            feeds = feeds.filter((f) => f.id !== feed.id);
            delete feedCache[feed.id];
            delete syncErrors[feed.id];
            renderCalendars();
            notifyChanged();
          });

          actions.append(toggle, syncBtn, removeBtn);
          row.append(main, status, actions);
          list.appendChild(row);
        }
        body.appendChild(list);
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
        urlErrorMsg = '';
        const url = webcalToHttps(raw);
        const name = nameInput.value.trim() || inferName(url);
        const color = PALETTE[feeds.length % PALETTE.length];
        const feed = { id: uid('feed'), url, name, color, hidden: false };

        feeds = [...feeds, feed];
        saveFeeds(feeds);
        urlDraft = '';
        nameDraft = '';
        addBusy = true;
        syncingFeedId = feed.id;
        renderCalendars();
        notifyChanged();

        let result;
        try {
          result = await syncFeed(feed, { fetchImpl: fetch, manual: true });
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
        notifyChanged();
      }

      addBtn.addEventListener('click', handleAdd);
      const onEnter = (e) => { if (e.key === 'Enter') handleAdd(); };
      urlInput.addEventListener('keydown', onEnter);
      nameInput.addEventListener('keydown', onEnter);

      addWrap.append(urlInput, nameInput, addMsg, addBtn);
      body.appendChild(addWrap);
    }

    renderCalendars();

    panel.append(appearance, calendars);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);
    document.body.style.overflow = 'hidden'; // no scrolling behind the modal (iOS)
    document.addEventListener('keydown', onKey);
  }

  button.addEventListener('click', () => { host.childElementCount ? close() : open(); });

  // The inline pre-paint script already applied a theme from its own copy of this
  // logic; re-apply through resolveTheme() so js/theme.js is the source of truth.
  applyTheme(getSetting());
}
