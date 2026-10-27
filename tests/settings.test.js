import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { makeFakeDocument, makeFakeWindow, allText } from './fake-dom.js';
import {
  loadFeeds, saveFeeds, saveItems, loadItems, loadSyncState, loadTombstones, loadFeedCache, saveFeedCache,
} from '../js/storage.js';
import { initSettings } from '../js/settings.js';
import { linkWithCode } from '../js/auth.js';
import { bytesToBase64url, generateEncKey, encryptBlob } from '../js/crypto.js';
import { SCHEMA_VERSION } from '../js/merge.js';

// --- fake DOM: tests/fake-dom.js ---------------------------------------------
//
// The shared harness. Its getElementById returns null for an id that is not
// mounted (js/linkui.js's render() looks up the app shell's sync indicator;
// these tests never mount one), so "safe when unmounted" stays non-vacuous.

// Recursively finds the first BUTTON descendant whose textContent matches.
function findButtonByText(el, text) {
  for (const c of el.children) {
    if (c.tagName === 'BUTTON' && c.textContent === text) return c;
    const found = findButtonByText(c, text);
    if (found) return found;
  }
  return null;
}

function openPanel(feeds, seed = () => {}) {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  saveFeeds(feeds);
  seed(); // extra storage the panel should see when it opens

  const button = document.createElement('button');
  const host = document.createElement('div');
  // Every notification this panel emits, in order, tagged by kind: 'view' for
  // onFeedsChanged (this device's own re-render) and 'synced' for
  // onSyncedDataChanged (something the account must be told about).
  const notified = [];
  const fetched = [];
  initSettings({
    button,
    host,
    onFeedsChanged: () => notified.push('view'),
    onSyncedDataChanged: () => notified.push('synced'),
    // Every fetch's result, in order: [feedId, ok].
    onFeedFetched: (id, ok) => fetched.push([id, ok]),
    // Not exercised by any test that uses this helper — they drive the theme
    // and calendar controls — but open() mounts initLinkUI, which refuses to
    // mount without one. app.js always passes applySyncedState here.
    applyState: (s) => s,
  });
  button.click(); // host.childElementCount === 0 -> open()
  return { host, notified, button, fetched };
}

// --- the second-writer fix --------------------------------------------------

test('settings: toggling hidden on one feed does not discard a feed that arrived in storage after the panel opened', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host } = openPanel([feedA]); // captures the panel's `feeds` binding as [feedA] only

  // A second, already-linked device's feed lands in storage while THIS
  // device's panel is sitting open. `initSettings` mounts inside this same
  // panel (Task 8), so a newly linked device's first sync races exactly
  // this window. It's a same-tab write, so the cross-tab `storage` event
  // (Task 7) never fires here — the panel has no other way to learn about it.
  const feedC = {
    id: 'feedC', url: 'https://example.com/c.ics', name: 'C', color: 'var(--feed-palette-2)', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  saveFeeds([feedA, feedC]);

  const toggleBtn = findButtonByText(host, 'Hide');
  assert.ok(toggleBtn, 'expected to find the Hide button for feedA');
  toggleBtn.click();

  const stored = loadFeeds();
  assert.deepEqual(stored.map((f) => f.id).sort(), ['feedA', 'feedC']);
  const storedA = stored.find((f) => f.id === 'feedA');
  assert.equal(storedA.hidden, true);
});

test('settings: cycling a feed\'s color does not discard a feed that arrived in storage after the panel opened', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host } = openPanel([feedA]);

  const feedC = {
    id: 'feedC', url: 'https://example.com/c.ics', name: 'C', color: 'var(--feed-palette-2)', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  saveFeeds([feedA, feedC]);

  const dotBtn = host.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Change color for A');
  assert.ok(dotBtn, 'expected to find the color-cycle dot for feedA');
  dotBtn.click();

  const stored = loadFeeds();
  assert.deepEqual(stored.map((f) => f.id).sort(), ['feedA', 'feedC']);
});

// A hidden calendar's "Show" button names its calendar for assistive tech,
// which otherwise hears a row of identical "Show" buttons. The name only:
// a feed URL is a capability token and is never displayed or announced.
test('settings: a hidden calendar\'s Show button is named "Show <calendar name>", never its URL', () => {
  const work = {
    id: 'feedW', url: 'https://calendar.example.com/private-s3cr3tT0ken/basic.ics', name: 'Work',
    color: 'var(--feed-palette-2)', hidden: true, updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const home = {
    id: 'feedH', url: 'webcal://p01-caldav.example.com/published/2/h0meT0ken', name: 'Home',
    color: 'var(--feed-palette-3)', hidden: true, updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const school = {
    id: 'feedS', url: 'https://school.example.com/feed/sch00lT0ken.ics', name: 'School',
    color: 'var(--feed-palette-4)', hidden: false, updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host } = openPanel([work, school, home]);
  const hide = findButtonByText(host, 'Hide');
  assert.ok(hide, 'fixture check: the visible calendar has a Hide button');
  assert.equal(hide.getAttribute('aria-label'), null, 'a Hide button is not announced as "Show …"');
  const shows = host.querySelectorAll('button').filter((b) => b.textContent === 'Show');
  assert.equal(shows.length, 2, 'fixture check: one Show button per hidden calendar');
  assert.deepEqual(shows.map((b) => b.getAttribute('aria-label')), ['Show Work', 'Show Home']);
  for (const b of shows) {
    const label = b.getAttribute('aria-label');
    for (const secret of ['s3cr3tT0ken', 'h0meT0ken', 'sch00lT0ken', 'example.com', 'https:', 'webcal:']) {
      assert.ok(!label.includes(secret), `the label carries no part of a feed URL (${secret})`);
    }
  }
});

// --- synced mutations vs per-device view preferences (spec 6.3) ------------
//
// The panel's seven notification sites are NOT interchangeable. Two of them
// mutate plaenicke.feeds/plaenicke.syncTombstones — the data the account
// actually holds — and must reach app.js's scheduleSync, or a subscription
// added or dropped on the laptop sits unpushed until the next page load,
// `visibilitychange` or `online` event. Closing this modal fires none of
// those, so the obvious gesture triggers nothing at all, and a feed URL is
// the one record in this app that cannot be re-entered from anything on
// screen. The other five are per-device: `color` and `hidden` are stripped by
// toWire and never reach the wire (spec 6.3), and the feed cache is not
// synced at all — pushing on those would fire a sync on every colour tap.

test('settings: removing a calendar is a SYNCED change, not just a re-render', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host, notified } = openPanel([feedA]);
  notified.length = 0;

  findButtonByText(host, 'Remove').click();
  findButtonByText(host, 'Remove from every device').click();

  assert.deepEqual(loadFeeds(), [], 'fixture check: the feed really was removed');
  assert.ok(notified.includes('synced'),
    'an unsubscribe writes a feed tombstone the account must be told about — nothing else in the app pushes it');
});

test('settings: adding a calendar is a SYNCED change, not just a re-render', async () => {
  const { host, notified } = openPanel([]);
  notified.length = 0;

  const originalFetch = globalThis.fetch;
  // handleAdd's own first syncFeed() goes to the real /feed proxy; this suite
  // makes no network calls, so answer it with a plain server error. syncFeed
  // returns {ok:false} rather than throwing, which is the path the panel
  // already handles.
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'server' }) });
  try {
    const urlInput = host.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'Calendar link');
    assert.ok(urlInput, 'fixture check: the Add form must offer a URL field');
    urlInput.value = 'https://example.com/new.ics';
    findButtonByText(host, 'Add calendar').click();

    // saveFeeds and the notification both run synchronously, before
    // handleAdd's first await — the assertion does not depend on the sync.
    assert.deepEqual(loadFeeds().map((f) => f.url), ['https://example.com/new.ics'], 'fixture check');
    assert.ok(notified.includes('synced'),
      'a new subscription must be pushed — a feed URL is unrecoverable if this device is lost before it syncs');
    await waitFor(() => findButtonByText(host, 'Add calendar') !== null, 'the initial sync to settle');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The one write path in this panel that was never converted to re-read
// storage. Its three siblings — reapplyFeedField, handleAdd and
// refreshCalendars — all do, and its own comment claimed parity with them,
// but it rebuilt the list from the snapshot open() captured. A calendar
// pulled in by a sync while the panel sat open therefore vanished from the
// list on any Remove. Display only (storage stayed correct), but the panel is
// the only place a calendar's existence is visible.
test('settings: removing a calendar keeps one that arrived in storage after the panel opened', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host } = openPanel([feedA]); // the panel's `feeds` binding is [feedA] only

  // An adoption lands while the panel is open. Same-tab write, so the
  // cross-tab `storage` event never fires here.
  const feedC = {
    id: 'feedC', url: 'https://example.com/c.ics', name: 'C', color: 'var(--feed-palette-2)', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  saveFeeds([feedA, feedC]);

  findButtonByText(host, 'Remove').click(); // feedA's row is first
  findButtonByText(host, 'Remove from every device').click();

  assert.deepEqual(loadFeeds().map((f) => f.id), ['feedC'], 'fixture check: storage is right either way');
  assert.ok(allText(host).includes('C'),
    'the panel must show the calendar sync pulled in, not the snapshot it opened with');
  assert.ok(!allText(host).includes('No calendars linked yet'),
    'a subscription that exists must never be rendered as if the device had none');
});

// --- Remove asks first (punchlist L88 fix (1), decided 2026-10-19) ----------
//
// A feed URL is a capability token this panel never shows again, and since
// sweep fix 1 a Remove is pushed to the account within 2 s — so one mis-tap
// used to delete the subscription from EVERY device, with nothing on screen
// that could restore it. Remove now asks, inline, naming the calendar.
function twoFeeds() {
  return [
    {
      id: 'feedA', url: 'https://example.com/a.ics', name: 'Classes', color: 'var(--feed-palette-1)', hidden: false,
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 'feedB', url: 'https://example.com/b.ics', name: 'Work', color: 'var(--feed-palette-2)', hidden: true,
      updatedAt: '2026-07-02T00:00:00.000Z',
    },
  ];
}

test('settings: the first Remove tap removes nothing and asks, naming the calendar', () => {
  const { host, notified } = openPanel(twoFeeds());
  notified.length = 0;

  findButtonByText(host, 'Remove').click(); // Classes' row is first

  assert.deepEqual(loadFeeds().map((f) => f.id), ['feedA', 'feedB'], 'nothing may be removed on the first tap');
  assert.deepEqual(loadTombstones(), [], 'no tombstone may be written on the first tap');
  assert.deepEqual(notified, [], 'nothing may be scheduled or re-rendered app-wide on the first tap');
  const text = allText(host);
  assert.ok(text.includes('Classes'), 'the question names the calendar');
  assert.match(text, /every device/, 'the question says it is removed from every device');
  assert.match(text, /cannot be typed back in/, 'the question says the link cannot be re-entered');
  assert.ok(!text.includes('https://example.com/a.ics'), 'the feed URL is never rendered, even here');
  assert.ok(findButtonByText(host, 'Remove from every device'), 'a confirm control is offered');
  assert.ok(findButtonByText(host, 'Cancel'), 'a Cancel control is offered');
});

test('settings: Cancel on the Remove question leaves everything untouched', () => {
  const { host, notified } = openPanel(twoFeeds());
  const before = JSON.stringify(loadFeeds());
  notified.length = 0;

  findButtonByText(host, 'Remove').click();
  findButtonByText(host, 'Cancel').click();

  assert.equal(JSON.stringify(loadFeeds()), before, 'Cancel must not touch plaenicke.feeds');
  assert.deepEqual(loadTombstones(), [], 'Cancel must not write a tombstone');
  assert.deepEqual(notified, [], 'Cancel must not schedule a sync');
  assert.equal(findButtonByText(host, 'Remove from every device'), null, 'the question goes away');
  assert.equal(host.querySelectorAll('button').filter((b) => b.textContent === 'Remove').length, 2,
    'both rows offer Remove again');
});

test('settings: a confirmed Remove removes exactly one calendar and nothing else', () => {
  const { host, notified } = openPanel(twoFeeds(), () => {
    saveItems([{ id: 'i1', title: 'Keep me', date: '2026-08-01', type: 'event', updatedAt: '2026-08-01T00:00:00.000Z' }]);
    const entry = { fetchedAt: '2026-08-01T00:00:00.000Z', events: [], skipped: [] };
    saveFeedCache({ feedA: entry, feedB: entry });
  });
  assert.deepEqual(Object.keys(loadFeedCache()), ['feedA', 'feedB'], 'fixture check: both calendars are cached');
  const feedBBefore = JSON.stringify(loadFeeds()[1]);
  const itemsBefore = JSON.stringify(loadItems());
  notified.length = 0;

  findButtonByText(host, 'Remove').click(); // Classes
  findButtonByText(host, 'Remove from every device').click();

  assert.deepEqual(loadFeeds().map((f) => f.id), ['feedB'], 'only the confirmed calendar is removed');
  assert.equal(JSON.stringify(loadFeeds()[0]), feedBBefore, 'the other calendar is untouched, field for field');
  assert.deepEqual(loadTombstones().map((t) => [t.id, t.kind]), [['feedA', 'feed']], 'exactly one feed tombstone');
  assert.equal(JSON.stringify(loadItems()), itemsBefore, 'items are untouched');
  assert.deepEqual(Object.keys(loadFeedCache()), ['feedB'], "only the removed calendar's cache goes");
  assert.deepEqual(notified, ['view', 'synced'], 'a confirmed Remove is still a synced change');
});

// The confirm must follow the CALENDAR, not the row position. A sync can land
// while the question sits open and re-order the list or insert a calendar
// ahead of the one being asked about; the next re-render (any row action
// re-reads storage) must keep asking about the same calendar, and the confirm
// must remove that one. The test above confirms on the FIRST row, where
// "the row at this index" and "feeds[0]" both happen to be right.
test('settings: a Remove question stays on its calendar when a re-render moves it to another row', () => {
  const F = (id, name, i) => ({
    id, url: `https://example.com/${id}.ics`, name, color: `var(--feed-palette-${i})`, hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  });
  const { host, notified } = openPanel([F('A', 'Alpha', 1), F('B', 'Bravo', 2), F('C', 'Charlie', 3)]);
  const removes = host.querySelectorAll('button').filter((b) => b.textContent === 'Remove');
  assert.equal(removes.length, 3, 'fixture check: three rows offer Remove');
  removes[1].click(); // Bravo, the second row
  assert.match(allText(host), /Remove "Bravo"/, 'fixture check: the question names Bravo');

  // A sync lands while the question is open: a new calendar ahead of Bravo,
  // and the rest re-ordered, so Bravo is now the third row, not the second.
  saveFeeds([F('Z', 'Zulu', 4), F('C', 'Charlie', 3), F('B', 'Bravo', 2), F('A', 'Alpha', 1)]);
  const othersBefore = Object.fromEntries(loadFeeds().filter((f) => f.id !== 'B').map((f) => [f.id, JSON.stringify(f)]));
  // Re-render through a row action that re-reads storage: Hide then Show on
  // Zulu (the first row) leaves Zulu field-identical.
  findButtonByText(host, 'Hide').click();
  findButtonByText(host, 'Show').click();
  assert.equal(JSON.stringify(loadFeeds()[0]), othersBefore.Z, 'fixture check: Hide then Show restores Zulu');

  const confirms = host.querySelectorAll('button').filter((b) => b.textContent === 'Remove from every device');
  assert.equal(confirms.length, 1, 'exactly one question is open');
  assert.match(allText(host), /Remove "Bravo"/, 'the question still names Bravo after the re-render');
  assert.doesNotMatch(allText(host), /Remove "(Zulu|Charlie|Alpha)"/, 'and no other calendar');
  notified.length = 0;

  confirms[0].click();

  assert.deepEqual(loadFeeds().map((f) => f.id), ['Z', 'C', 'A'], 'exactly Bravo is removed');
  for (const f of loadFeeds()) {
    assert.equal(JSON.stringify(f), othersBefore[f.id], `${f.name} is untouched, field for field`);
  }
  assert.deepEqual(loadTombstones().map((t) => [t.id, t.kind]), [['B', 'feed']], 'exactly one feed tombstone, for Bravo');
  assert.deepEqual(notified, ['view', 'synced'], 'a confirmed Remove is still a synced change');
});

// Punchlist L130 (decided 2026-10-19): Google serves its calendar feeds with
// a lag of hours, so a just-made change can be missing after a manual Sync
// and look like a broken app. One line, beside the calendars' Sync buttons.
test('settings: the calendar list carries one line about Google lag, beside the Sync buttons', () => {
  const { host } = openPanel(twoFeeds());
  const notes = host.querySelectorAll('p').filter((p) => /Google calendars can take a few hours to show recent changes/.test(p.textContent));
  assert.equal(notes.length, 1, 'exactly one note, not one per calendar');
  assert.equal(host.querySelectorAll('button').filter((b) => b.textContent === 'Sync').length, 2,
    'every calendar still offers its own Sync button');
  const list = host.querySelectorAll('ul').find((u) => u.className === 'feed-list');
  const section = list.parentNode;
  assert.equal(section.children.indexOf(notes[0]), section.children.indexOf(list) + 1,
    'the note sits directly under the list of calendars and their Sync buttons');
});

test('settings: with no calendars there is no Sync button, and no Google note', () => {
  const { host } = openPanel([]);
  assert.ok(allText(host).includes('No calendars linked yet'), 'fixture check');
  assert.doesNotMatch(allText(host), /Google calendars/);
});

test('settings: colour and hidden are per-device preferences and never schedule a sync', () => {
  const feedA = {
    id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const { host, notified } = openPanel([feedA]);
  notified.length = 0;

  host.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Change color for A').click();
  findButtonByText(host, 'Hide').click();
  findButtonByText(host, 'Show').click();

  assert.ok(notified.includes('view'), 'fixture check: the panel must still re-render on a view change');
  assert.ok(!notified.includes('synced'),
    'toWire strips color and hidden, so pushing on them would burn a sync per colour tap and change nothing anywhere else');
});

test('settings: initSettings refuses to mount without a synced-change callback', () => {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  assert.throws(
    () => initSettings({
      button: document.createElement('button'),
      host: document.createElement('div'),
      onFeedsChanged: () => {},
    }),
    /onSyncedDataChanged/,
    'a missing wire here is silent data loss, not a degraded feature — it must fail at mount',
  );
});

// Pins the WIRE, not just linkui.js's own guard. settings.js destructures
// applyState and forwards it without using or checking it, so if that forward
// were dropped, linkui.js's mount guard would still be green in its own suite
// and only this test would notice. Same shape as the unpinned reads this branch
// has already been bitten by (the newly-pulled-feed fetch; the caller's
// loadTombstones read).
test('settings: the panel refuses to open its sync section without an applyState', () => {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  const button = document.createElement('button');
  initSettings({
    button,
    host: document.createElement('div'),
    onFeedsChanged: () => {},
    onSyncedDataChanged: () => {},
    onFeedFetched: () => {},
  });
  assert.throws(() => button.click(), /applyState/,
    'a settings panel that cannot save synced data must say so at mount, not after a round trip to the account');
});

// --- the linking UI mounted inside this panel (Task 8) ---------------------
//
// End-to-end through the REAL mount: initSettings -> open() -> initLinkUI ->
// previewRemote -> chooseAdoption -> syncOnce -> applyState. Nothing here is
// stubbed except the network and the state owner.
//
// The bug: onLinked was `notifyChanged`, which refreshes app.js's snapshot but
// not open()'s own `feeds`/`feedCache` bindings, and never re-runs
// renderCalendars(). After adopting an account with calendars the panel still
// read "No calendars linked yet". Display only — reapplyFeedField, handleAdd
// and removeFeed all re-read storage before writing — but wrong on screen.
async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  throw new Error(`timed out waiting for: ${label}`);
}

test('settings: the calendar list refreshes when an adoption lands while the panel is open', async () => {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  saveFeeds([]);
  saveItems([]); // empty device + an account with data -> 'auto', no dialog

  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  const remoteFeed = {
    id: 'fRemote', url: 'https://cal.example/r.ics', name: 'Pulled Calendar',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const blob = await encryptBlob(link.encKey, {
    schemaVersion: SCHEMA_VERSION, items: [], feeds: [remoteFeed], tombstones: [],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ version: 3, blob }) });

  try {
    const button = document.createElement('button');
    const host = document.createElement('div');
    initSettings({
      button,
      host,
      onFeedsChanged: () => {},
      onSyncedDataChanged: () => {},
      onFeedFetched: () => {},
      // Stands in for app.js's applySyncedState: the feed owner assigns a
      // real colour before saving (merge.js hands a first-seen feed
      // color: null, and deserializeFeeds drops any feed whose color is not
      // a string).
      applyState: (s) => {
        const assigned = s.feeds.map((f) => (typeof f.color === 'string' ? f : { ...f, color: 'var(--feed-palette-1)' }));
        saveFeeds(assigned);
        return { ...s, feeds: assigned };
      },
    });
    button.click();

    await waitFor(() => loadSyncState().adoptionPending === false, 'the adoption to complete');
    assert.deepEqual(loadFeeds().map((f) => f.id), ['fRemote'], 'the pulled calendar must have been written');
    await waitFor(() => allText(host).includes('Pulled Calendar'), 'the panel to show the pulled calendar');
    assert.ok(!allText(host).includes('No calendars linked yet'),
      'the panel must not still claim the device has no calendars after adopting an account that has one');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Note: Add is deliberately NOT exercised here the same way — handleAdd
// awaits a real syncFeed() call against the live Worker (no fetchImpl hook
// is reachable from outside initSettings), and this suite must not make
// network calls. The :330-337 write site gets the identical
// re-read-before-write fix as the two sites above; app.js/Task 7's
// integration tests are where an Add flow with a real fetchImpl belongs.

// --- Phase 0 baseline: the launch count is readable in Settings -------------
import { recordLaunch } from '../js/storage.js';

test('settings: shows on how many of the last 7 days the app was opened, and when it was last', () => {
  const now = Date.now();
  const { host } = openPanel([], () => {
    recordLaunch(new Date(now - 60 * 60 * 1000).toISOString());
    recordLaunch(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString());
    recordLaunch(new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()); // outside the window
  });
  // An hour ago is today or, just after midnight, yesterday; either way it is
  // a different local day from two days ago.
  assert.match(allText(host), /Opened on 2 of the last 7 days\. Last opened (Today|Yesterday), \d{1,2}:\d{2} (AM|PM)\./);
});

// Sweep S-8: a launch log that parses to something other than an array (here
// an object) reads as empty, and the panel still opens rather than throwing
// out of the Settings button.
test('settings: a stored launch log of {} reads as no launches, and Settings opens', () => {
  const { host } = openPanel([], () => { localStorage.setItem('plaenicke.launches', '{}'); });
  assert.equal(host.childElementCount > 0, true, 'the panel must open');
  assert.match(allText(host), /Not opened in the last 7 days\./);
  assert.doesNotMatch(allText(host), /Last opened/);
});

// --- focus management (punchlist: a11y) ------------------------------------
//
// The panel is a modal dialog: focus moves into it on open and goes back to
// the Settings button on close, by every close path. Without this a keyboard
// or screen-reader user is left on the page BEHIND the modal, and after a
// close focus falls back to the top of the document.

function findByTag(el, tag) {
  for (const c of el.children) {
    if (c.tagName === tag) return c;
    const found = findByTag(c, tag);
    if (found) return found;
  }
  return null;
}

test('settings: opening moves focus to the panel heading, focusable by script only', () => {
  const { host } = openPanel([]);
  const heading = findByTag(host, 'H2');
  assert.equal(heading.textContent, 'Settings', 'fixture check');
  assert.equal(document.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1', 'a target for focus, never a Tab stop');
});

test('settings: every close path returns focus to the Settings button, without scrolling', () => {
  const closers = {
    'the Settings button': ({ button }) => button.click(),
    Escape: () => document._listeners.keydown.slice().forEach((fn) => fn({ key: 'Escape' })),
    'a backdrop tap': ({ host }) => host.children[0].click(),
  };
  for (const [label, closeIt] of Object.entries(closers)) {
    const opened = openPanel([]);
    assert.notEqual(document.activeElement, opened.button, `fixture check (${label}): focus moved in`);
    document.lastFocusOptions = undefined;
    closeIt(opened);
    assert.equal(opened.host.childElementCount, 0, `fixture check (${label}): closed`);
    assert.equal(document.activeElement, opened.button, `${label}: focus back on the opener`);
    assert.deepEqual(document.lastFocusOptions, { preventScroll: true }, label);
  }
});

// --- a Name that is itself a link (punchlist: secrets F3) -------------------
//
// A feed's name is displayed on every row and synced to the account; its URL
// is a capability token that is never displayed again. A link pasted into the
// Name box would put that token on screen and on the wire, so the add is
// refused with an inline message, like an empty link is.
test('settings: a calendar Name that is itself a link is refused, with a message, and nothing is added', () => {
  for (const badName of ['https://calendar.google.com/secret.ics', '  WEBCAL://p01.icloud.com/secret', 'http:x']) {
    const { host, notified } = openPanel([]);
    notified.length = 0;
    const originalFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched += 1; return { ok: false, status: 500, json: async () => ({}) }; };
    try {
      const inputs = host.querySelectorAll('input');
      inputs.find((i) => i.getAttribute('aria-label') === 'Calendar link').value = 'https://example.com/new.ics';
      inputs.find((i) => i.getAttribute('aria-label') === 'Calendar name (optional)').value = badName;
      findButtonByText(host, 'Add calendar').click();
      assert.deepEqual(loadFeeds(), [], `${badName}: nothing is saved`);
      assert.equal(fetched, 0, `${badName}: nothing is fetched`);
      assert.deepEqual(notified, [], `${badName}: nothing is pushed`);
      const msg = host.querySelectorAll('p').find((p) => p._classes.has('feed-add-msg'));
      assert.match(msg.textContent, /\S/, `${badName}: the panel says why`);
      assert.ok(!msg.textContent.includes('secret'), 'the message never repeats the link');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

// --- manual fetches have a deadline (punchlist: sF review) ------------------
//
// The background refresh aborts a download after 60 s (js/fetchtimeout.js).
// The panel's own Sync and Add calendar fetched with bare fetch, so a server
// that never answered left the row on "Syncing…" with every button disabled
// until a reload. They go through the same fetchWithTimeout now.
const settleMicro = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => { setImmediate(r); }); };

for (const [label, start] of [
  ['Sync', (host) => findButtonByText(host, 'Sync').click()],
  ['Add calendar', (host) => {
    host.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'Calendar link').value = 'https://example.com/new.ics';
    findButtonByText(host, 'Add calendar').click();
  }],
]) {
  test(`settings: a manual ${label} that never answers is aborted at 60 s and the panel recovers`, async (t) => {
    const feedA = {
      id: 'feedT', url: 'https://example.com/t.ics', name: 'T', color: 'var(--feed-palette-1)', hidden: false,
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const signals = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => { signals.push(init && init.signal); return new Promise(() => {}); };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { host } = openPanel(label === 'Sync' ? [feedA] : []);
      start(host);
      await settleMicro();
      assert.equal(signals.length, 1, 'fixture check: one fetch in flight');
      assert.ok(signals[0], 'the fetch is given an abort signal');
      const addReady = () => { const b = findButtonByText(host, 'Add calendar'); return Boolean(b) && !b.disabled; };
      assert.equal(addReady(), false, 'fixture check: busy while it runs');
      t.mock.timers.tick(59999);
      await settleMicro();
      assert.equal(signals[0].aborted, false, 'not before the 60 s budget');
      t.mock.timers.tick(1);
      await settleMicro();
      assert.equal(signals[0].aborted, true, 'aborted at 60 s');
      assert.equal(addReady(), true, 'the panel is usable again');
      assert.ok(findButtonByText(host, 'Sync'), 'and the row is no longer "Syncing…"');
    } finally {
      t.mock.timers.reset();
      globalThis.fetch = originalFetch;
    }
  });
}

// The wire app.js's "Updated" stamp depends on (punchlist L211): c6cfbf5
// reverted a stamp memory because these results never reached it.
test('settings: initSettings refuses to mount without an onFeedFetched callback', () => {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  assert.throws(
    () => initSettings({
      button: document.createElement('button'),
      host: document.createElement('div'),
      onFeedsChanged: () => {},
      onSyncedDataChanged: () => {},
      applyState: (x) => x,
    }),
    /onFeedFetched/,
  );
});

test('settings: a manual Sync and an Add each report their fetch result, before the view notification', async () => {
  const feedA = {
    id: 'feedR', url: 'https://example.com/r.ics', name: 'R', color: 'var(--feed-palette-1)', hidden: false,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes(encodeURIComponent('r.ics'))
    ? { ok: true, status: 200, text: async () => '' }
    : { ok: false, status: 502, json: async () => ({ error: 'upstream_error' }) });
  try {
    const { host, fetched, notified } = openPanel([feedA]);
    const order = [];
    notified.push = (x) => { order.push(`view:${x}`); return Array.prototype.push.call(notified, x); };
    fetched.push = (x) => { order.push(`fetched:${x[1]}`); return Array.prototype.push.call(fetched, x); };
    findButtonByText(host, 'Sync').click();
    await waitFor(() => fetched.length === 1, 'the manual Sync to settle');
    assert.deepEqual(fetched[0], ['feedR', true]);
    assert.deepEqual(order, ['fetched:true', 'view:view'], 'reported before the repaint it feeds');
    host.querySelectorAll('input').find((i) => i.getAttribute('aria-label') === 'Calendar link').value = 'https://example.com/bad.ics';
    findButtonByText(host, 'Add calendar').click();
    await waitFor(() => fetched.length === 2, 'the Add\'s first fetch to settle');
    const added = loadFeeds().find((f) => f.url === 'https://example.com/bad.ics');
    assert.deepEqual(fetched[1], [added.id, false]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- the feed-shape readout (home-screen spec § 2.4, stage 1) ---------------
//
// One read-only line per calendar row: how its cached events repeat and which
// method stage 3a would use. Alex reads it for LMU Classes.

const SHAPE_FEED = {
  id: 'feedS', url: 'https://calendar.example/private-token-abc/basic.ics', name: 'LMU Classes',
  color: 'var(--feed-palette-1)', hidden: false, updatedAt: '2026-07-01T00:00:00.000Z',
};

function shapeEvent(uid, value, rrule = null) {
  return {
    uid, title: uid, form: 'UTC', dtstart: { value, tzid: null }, dtend: null, duration: null,
    rrule, exdates: [], recurrenceId: null,
  };
}

function cacheWith(entry) {
  return () => saveFeedCache({ feedS: { fetchedAt: new Date().toISOString(), skipped: [], ...entry } });
}

function byClass(el, cls) {
  const out = [];
  const walk = (node) => { for (const c of node.children) { if (c._classes.has(cls)) out.push(c); walk(c); } };
  walk(el);
  return out;
}

test('settings: a synced calendar row says how its events repeat and which method it uses', () => {
  const events = [
    shapeEvent('stats', '20260824T170000Z', 'FREQ=WEEKLY;BYDAY=MO,WE'),
    shapeEvent('midterm', '20261015T170000Z'),
    shapeEvent('final', '20261210T170000Z'),
  ];
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events }));
  const lines = byClass(host, 'feed-shape');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, '3 events: 1 repeat (RRULE), 2 single. Uses the rule.');
  const row = byClass(host, 'feed-row')[0];
  const status = byClass(row, 'feed-status')[0];
  assert.equal(row.children.indexOf(lines[0]), row.children.indexOf(status) + 1, 'directly under the status line');
});

test('settings: the shape line never shows the calendar link', () => {
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events: [shapeEvent('a', '20260824T170000Z')] }));
  assert.ok(byClass(host, 'feed-shape').length === 1, 'fixture check: the line is there');
  const text = allText(host);
  assert.ok(!text.includes('private-token-abc'), 'the capability token is never rendered');
  assert.ok(!text.includes('calendar.example'), 'nor the host');
});

test('settings: no shape line before a calendar\'s first sync', () => {
  const { host } = openPanel([SHAPE_FEED]);
  assert.match(allText(host), /not yet synced/, 'fixture check');
  assert.equal(byClass(host, 'feed-shape').length, 0);
});

test('settings: a synced calendar with no events says there is nothing to classify', () => {
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events: [] }));
  assert.equal(byClass(host, 'feed-shape')[0].textContent, 'No events to classify.');
});

test('settings: no shape line after a quota drop — the empty cache is not the calendar', () => {
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events: [], quotaDropped: true }));
  assert.match(allText(host), /storage limit reached/, 'fixture check: the status explains the drop');
  assert.equal(byClass(host, 'feed-shape').length, 0);
});

test('settings: a cache the readout cannot read says so on its row, logs the error name only, and the panel still works', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const other = { ...SHAPE_FEED, id: 'feedO', name: 'Other' };
  const { host } = openPanel([SHAPE_FEED, other], () => saveFeedCache({
    feedS: { fetchedAt: new Date().toISOString(), skipped: [], events: [{ uid: 'broken', title: 'Broken' }] },
    feedO: { fetchedAt: new Date().toISOString(), skipped: [], events: [shapeEvent('a', '20260824T170000Z')] },
  }));
  const lines = byClass(host, 'feed-shape');
  assert.equal(lines.length, 2, 'both rows still render');
  assert.equal(lines[0].textContent, "Couldn't classify this calendar's events.");
  assert.match(lines[1].textContent, /Uses the heuristic\.$/);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0].arguments.length, 1, 'one string, no error object or feed');
  assert.match(errors.mock.calls[0].arguments[0], /^plaenicke: feed shape failed \(TypeError\)$/);
  assert.equal(host.querySelectorAll('button').filter((b) => b.textContent === 'Sync').length, 2);
});

test('settings: the shape line stays while the row asks to confirm a Remove', () => {
  const { host } = openPanel([SHAPE_FEED], cacheWith({ events: [shapeEvent('a', '20260824T170000Z')] }));
  findButtonByText(host, 'Remove').click();
  assert.ok(findButtonByText(host, 'Remove from every device'), 'fixture check: asking');
  assert.equal(byClass(host, 'feed-shape').length, 1);
});

// --- the Tab trap (final fixes 2, C6) ----------------------------------------
//
// Settings is a modal (aria-modal), but Tab walked out of it into the page
// behind — the nav included. It mirrors js/itemsheet.js's trap: only the two
// edges, and focus outside the panel, are taken over; every other Tab is the
// browser's own. The panel's controls change while it is open (a Remove
// question, the sync section), so they are read at each Tab press.

// A Tab press; returns whether the panel cancelled the browser's own move.
function pressTab(shiftKey = false) {
  let prevented = false;
  [...(document._listeners.keydown || [])].forEach((fn) => fn({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } }));
  return prevented;
}

test('settings: Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last', () => {
  const { host } = openPanel(twoFeeds());
  const first = findButtonByText(host, 'Light');
  const last = findButtonByText(host, 'Link this device');
  assert.ok(first && last, 'fixture check: the first and last controls');
  last.focus();
  assert.equal(pressTab(), true, 'Tab on the last control is taken over');
  assert.equal(document.activeElement, first);
  assert.equal(pressTab(true), true, 'Shift+Tab on the first is taken over');
  assert.equal(document.activeElement, last);
  const middle = findButtonByText(host, 'Add calendar');
  middle.focus();
  assert.equal(pressTab(), false, 'a Tab in the middle is left to the browser');
  assert.equal(pressTab(true), false);
  assert.equal(document.activeElement, middle);
});

test('settings: Tab from the heading, or from anywhere outside the panel, goes to its first control', () => {
  const { host, button } = openPanel(twoFeeds());
  assert.equal(document.activeElement.tagName, 'H2', 'fixture check: focus starts on the heading');
  assert.equal(pressTab(), true);
  assert.equal(document.activeElement, findButtonByText(host, 'Light'));
  button.focus(); // the gear, outside the panel, as the nav would be
  assert.equal(pressTab(true), true, 'Shift+Tab from outside is taken over too');
  assert.equal(document.activeElement, findButtonByText(host, 'Link this device'));
});

test('settings: a control drawn after the panel opened is inside the Tab order; a disabled one is not', () => {
  const { host } = openPanel(twoFeeds());
  findButtonByText(host, 'Remove').click(); // draws the question's two buttons
  const confirm = findButtonByText(host, 'Remove from every device');
  assert.ok(confirm, 'fixture check: the question is drawn');
  confirm.focus();
  assert.equal(pressTab(), false, 'not treated as focus outside the panel');
  const last = findButtonByText(host, 'Link this device');
  last.disabled = true;
  const findClass = (el, cls) => {
    for (const c of el.children) {
      if (c._classes.has(cls)) return c;
      const found = findClass(c, cls);
      if (found) return found;
    }
    return null;
  };
  const input = findClass(host, 'link-code-input');
  assert.ok(input && input.tagName === 'INPUT', 'fixture check: the link-code input before the last button');
  input.focus();
  assert.equal(pressTab(), true, 'with the last button disabled, the input is the last stop');
  assert.equal(document.activeElement, findButtonByText(host, 'Light'));
  last.disabled = false;
  last.hidden = true; // a hidden control is not a stop either
  input.focus();
  assert.equal(pressTab(), true, 'with the last button hidden, the input is the last stop');
  assert.equal(document.activeElement, findButtonByText(host, 'Light'));
});
