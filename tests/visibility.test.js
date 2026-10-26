import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeLocalStorage } from './fake-localstorage.js';
import {
  saveFeeds, SERIES_VISIBILITY_KEY, readSeriesVisibility, writeSeriesVisibility, QuotaError, FEEDS_KEY,
} from '../js/storage.js';
import {
  parseVisibility, loadVisibility, isShown, filterBySurface, canHideSeries,
  setSeriesVisibility, showSeries, hiddenSeriesFor,
} from '../js/visibility.js';

// Per-series visibility (option A, 2026-10-26): device-local, never synced.
// Ruling 2: a corrupt entry reads as SHOWN and logs once per session.

const feed = (id) => ({
  id, url: `https://example.com/private/${id}-SECRET.ics`, name: id, color: 'var(--feed-palette-1)',
  hidden: false, updatedAt: '2026-08-01T00:00:00.000Z',
});
const inst = (feedId, uid, o = {}) => ({
  id: `${feedId}:${uid}:2026-10-26:12:15`, uid, feedId, external: true, title: uid,
  date: '2026-10-26', time: '12:15', recurring: true, guessedSeries: false, spanKey: `${feedId}:${uid}`, ...o,
});
const entry = (o = {}) => ({ calendar: true, list: true, title: 'T', ...o });

// THIS TEST MUST STAY FIRST: the corruption log is once per session (module
// state), so a corrupt load in an earlier test would leave nothing to count.
test('a corrupt entry reads as shown, and loading it again logs nothing more', () => {
  installFakeLocalStorage();
  localStorage.setItem(SERIES_VISIBILITY_KEY, JSON.stringify({
    f1: { u1: { calendar: 'no', list: false, title: 'Bad' }, u2: entry({ list: false, title: 'Good' }) },
  }));
  const calls = [];
  const orig = console.error;
  console.error = (...a) => calls.push(a);
  let first;
  try {
    first = loadVisibility();
    loadVisibility();
  } finally {
    console.error = orig;
  }
  assert.equal(calls.length, 1, 'one log for the session, not one per load');
  assert.equal(isShown(first, inst('f1', 'u1'), 'calendar'), true, 'the corrupt entry is shown on the calendar');
  assert.equal(isShown(first, inst('f1', 'u1'), 'list'), true, 'and in lists: corrupt means shown, whole entry');
  assert.equal(isShown(first, inst('f1', 'u2'), 'list'), false, 'a valid sibling entry still applies');
});

test('parseVisibility: missing, unparseable or non-object storage is an empty map; only junk is corrupt', () => {
  assert.deepEqual(parseVisibility(null), { map: {}, corrupt: false });
  assert.deepEqual(parseVisibility('{nope'), { map: {}, corrupt: true });
  assert.deepEqual(parseVisibility('[]'), { map: {}, corrupt: true });
  assert.deepEqual(parseVisibility('"x"'), { map: {}, corrupt: true });
  assert.deepEqual(parseVisibility(JSON.stringify({ f1: 'x' })), { map: {}, corrupt: true });
  for (const bad of [
    { calendar: true, list: 'false', title: 'T' },
    { calendar: true, list: false },
    { calendar: true, list: false, title: 7 },
    null,
    [],
  ]) {
    assert.deepEqual(parseVisibility(JSON.stringify({ f1: { u1: bad } })), { map: {}, corrupt: true },
      `${JSON.stringify(bad)} is corrupt`);
  }
});

test('parseVisibility: an entry shown on both surfaces is not kept, and is not corrupt', () => {
  assert.deepEqual(parseVisibility(JSON.stringify({ f1: { u1: entry() } })), { map: {}, corrupt: false });
  const map = parseVisibility(JSON.stringify({ f1: { u1: entry({ calendar: false }) } })).map;
  assert.deepEqual(map, { f1: { u1: entry({ calendar: false }) } });
});

test('isShown: each surface reads its own flag; own items always show; an unknown surface throws', () => {
  const map = { f1: { cal: entry({ calendar: false }), lst: entry({ list: false }) } };
  assert.equal(isShown(map, inst('f1', 'cal'), 'calendar'), false);
  assert.equal(isShown(map, inst('f1', 'cal'), 'list'), true);
  assert.equal(isShown(map, inst('f1', 'lst'), 'calendar'), true);
  assert.equal(isShown(map, inst('f1', 'lst'), 'list'), false);
  // A series is (feedId, uid): the same uid in another feed is another series.
  assert.equal(isShown(map, inst('f2', 'cal'), 'calendar'), true);
  assert.equal(isShown(map, { id: 'own', title: 'cal', uid: 'cal', feedId: 'f1' }, 'calendar'), true,
    'an own item (no external flag) is never hidden');
  assert.throws(() => isShown(map, inst('f1', 'cal'), 'calendars'), /surface/);
});

test('filterBySurface keeps the order and drops exactly the hidden series', () => {
  const map = { f1: { b: entry({ list: false }) } };
  const list = [inst('f1', 'a'), inst('f1', 'b'), inst('f2', 'b'), inst('f1', 'b', { date: '2026-10-27' })];
  assert.deepEqual(filterBySurface(list, map, 'list').map((i) => `${i.feedId}/${i.uid}`), ['f1/a', 'f2/b']);
  assert.equal(filterBySurface(list, map, 'calendar').length, 4);
  assert.throws(() => filterBySurface(list, map, 'grid'), /surface/);
});

test('canHideSeries: a feed event with a uid, never a guessed series (ruling 3), never an own item', () => {
  assert.equal(canHideSeries(inst('f1', 'u')), true);
  assert.equal(canHideSeries(inst('f1', 'u', { recurring: false })), true, 'a one-off is its own series');
  assert.equal(canHideSeries(inst('f1', 'u', { guessedSeries: true })), false);
  assert.equal(canHideSeries(inst('f1', '', {})), false);
  assert.equal(canHideSeries({ id: 'own', title: 'x', type: 'event' }), false);
});

test('setSeriesVisibility writes the one key, with the title, and only that key', () => {
  installFakeLocalStorage();
  saveFeeds([feed('f1')]);
  const feedsBefore = localStorage.getItem(FEEDS_KEY);
  const map = setSeriesVisibility({ feedId: 'f1', uid: 'u1', title: 'CLST 1300' }, 'list', false);
  assert.deepEqual(map, { f1: { u1: { calendar: true, list: false, title: 'CLST 1300' } } });
  assert.deepEqual(JSON.parse(readSeriesVisibility()), map);
  assert.equal(localStorage.getItem(FEEDS_KEY), feedsBefore, 'plaenicke.feeds is byte-identical');
  assert.deepEqual([...localStorage.store.keys()].sort(), [FEEDS_KEY, SERIES_VISIBILITY_KEY].sort());
  setSeriesVisibility({ feedId: 'f1', uid: 'u1', title: 'CLST 1300' }, 'calendar', false);
  assert.deepEqual(loadVisibility(), { f1: { u1: { calendar: false, list: false, title: 'CLST 1300' } } });
});

test('switching a series back on, on both surfaces, removes its entry and an empty feed', () => {
  installFakeLocalStorage();
  saveFeeds([feed('f1')]);
  setSeriesVisibility({ feedId: 'f1', uid: 'u1', title: 'A' }, 'list', false);
  setSeriesVisibility({ feedId: 'f1', uid: 'u1', title: 'A' }, 'list', true);
  assert.deepEqual(JSON.parse(readSeriesVisibility()), {});
});

test('showSeries clears both flags at once', () => {
  installFakeLocalStorage();
  saveFeeds([feed('f1')]);
  setSeriesVisibility({ feedId: 'f1', uid: 'u1', title: 'A' }, 'list', false);
  setSeriesVisibility({ feedId: 'f1', uid: 'u1', title: 'A' }, 'calendar', false);
  setSeriesVisibility({ feedId: 'f1', uid: 'u2', title: 'B' }, 'calendar', false);
  showSeries('f1', 'u1');
  assert.deepEqual(loadVisibility(), { f1: { u2: { calendar: false, list: true, title: 'B' } } });
});

test('a write prunes entries for calendars that no longer exist, and corrupt entries, and nothing else', () => {
  installFakeLocalStorage();
  saveFeeds([feed('f1')]);
  localStorage.setItem(SERIES_VISIBILITY_KEY, JSON.stringify({
    gone: { u9: entry({ list: false, title: 'Old' }) },
    f1: { keep: entry({ calendar: false, title: 'Keep' }), bad: { calendar: 1 } },
  }));
  const orig = console.error;
  console.error = () => {};
  try {
    setSeriesVisibility({ feedId: 'f1', uid: 'u1', title: 'New' }, 'list', false);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(JSON.parse(readSeriesVisibility()), {
    f1: { keep: entry({ calendar: false, title: 'Keep' }), u1: entry({ list: false, title: 'New' }) },
  }, 'a uid that left the feed is kept (its cache may refill); a vanished feedId is not');
});

test('setSeriesVisibility refuses bad arguments and writes nothing', () => {
  installFakeLocalStorage();
  saveFeeds([feed('f1')]);
  for (const [series, surface, shown] of [
    [{ feedId: '', uid: 'u', title: 'T' }, 'list', false],
    [{ feedId: 'f1', uid: '', title: 'T' }, 'list', false],
    [{ feedId: 'f1', uid: 'u', title: 3 }, 'list', false],
    [{ feedId: 'f1', uid: 'u', title: 'T' }, 'lists', false],
    [{ feedId: 'f1', uid: 'u', title: 'T' }, 'list', 'false'],
  ]) {
    assert.throws(() => setSeriesVisibility(series, surface, shown), Error);
  }
  assert.equal(readSeriesVisibility(), null);
  assert.throws(() => showSeries('', 'u'), Error);
});

test('a full device is a QuotaError, and the stored map is unchanged', () => {
  installFakeLocalStorage();
  saveFeeds([feed('f1')]);
  setSeriesVisibility({ feedId: 'f1', uid: 'u1', title: 'A' }, 'list', false);
  const before = readSeriesVisibility();
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    if (k === SERIES_VISIBILITY_KEY) { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
    realSet(k, v);
  };
  assert.throws(() => setSeriesVisibility({ feedId: 'f1', uid: 'u2', title: 'B' }, 'list', false), QuotaError);
  assert.throws(() => writeSeriesVisibility({}), QuotaError);
  assert.equal(readSeriesVisibility(), before);
});

test('hiddenSeriesFor lists one feed\'s hidden series by title', () => {
  const map = {
    f1: { z: entry({ list: false, title: 'Zoology' }), a: entry({ calendar: false, list: false, title: 'Art' }) },
    f2: { m: entry({ calendar: false, title: 'Maths' }) },
  };
  assert.deepEqual(hiddenSeriesFor(map, 'f1'), [
    { uid: 'a', title: 'Art', calendar: false, list: false },
    { uid: 'z', title: 'Zoology', calendar: true, list: false },
  ]);
  assert.deepEqual(hiddenSeriesFor(map, 'nope'), []);
});

// --- the boundaries, read from the source -----------------------------------
// visibility.js is the one writer of its key and writes nothing synced; feeds.js
// (removeFeed included) never touches visibility. These are the controller's
// hard constraints, pinned where a future edit would break them.
const src = (p) => readFileSync(new URL(`../js/${p}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('visibility.js names no writer of a synced key, and no feed remover', () => {
  const code = src('visibility.js');
  for (const name of ['saveFeeds', 'saveItems', 'saveTombstones', 'addTombstone', 'removeFeed', 'applyRemoteFeeds',
    'scheduleSync', 'localStorage']) {
    assert.ok(!code.includes(name), `visibility.js must not mention ${name}`);
  }
});

test('feeds.js, merge.js and sync.js never mention series visibility', () => {
  for (const f of ['feeds.js', 'merge.js', 'sync.js']) {
    assert.ok(!/seriesVisibility|SERIES_VISIBILITY|visibility\.js|SeriesVisibility|hiddenSeries|showSeries/.test(src(f)),
      `${f} must not touch series visibility`);
  }
});
