import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncFeed, syncStale, feedStatus, instancesForRange, removeFeed,
  webcalToHttps, inferName, applyRemoteFeeds, feedShape, describeFeedShape, seriesComputations,
} from '../js/feeds.js';
import {
  loadFeeds, saveFeeds, loadFeedCache, saveFeedCache, loadTombstones,
} from '../js/storage.js';
import { isTodo, isIdea, isScheduled } from '../js/items.js';
import { parseICS } from '../js/ics.js';
import { merge, toWire, SCHEMA_VERSION } from '../js/merge.js';

// --- fakes -------------------------------------------------------------

class FakeLocalStorage {
  constructor() { this.store = new Map(); }
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; }
  setItem(key, value) { this.store.set(key, String(value)); }
  removeItem(key) { this.store.delete(key); }
  clear() { this.store.clear(); }
}

// Wraps a real FakeLocalStorage but makes the first `failCount` setItem
// calls throw QuotaExceededError (mirroring how a real browser's quota
// failure surfaces), then behaves normally. Lets a test simulate
// "1st save overflows, 2nd (post-prune) succeeds" or "1st and 2nd overflow,
// 3rd (post-drop) succeeds" without needing real localStorage quotas.
class QuotaThrottledLocalStorage {
  constructor(inner, failCount) {
    this.inner = inner;
    this.failCount = failCount;
    this.calls = 0;
  }
  getItem(key) { return this.inner.getItem(key); }
  setItem(key, value) {
    this.calls += 1;
    if (this.calls <= this.failCount) {
      const err = new Error('quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.inner.setItem(key, value);
  }
  removeItem(key) { this.inner.removeItem(key); }
}

function fakeOkResponse(icsText) {
  return {
    ok: true,
    status: 200,
    text: async () => icsText,
    json: async () => { throw new Error('not json'); },
  };
}

function fakeErrorResponse(status, error) {
  return {
    ok: false,
    status,
    json: async () => ({ error }),
  };
}

function icsWith(...vevents) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${vevents.join('')}END:VCALENDAR\r\n`;
}

function vevent({ uid, summary, dtstart, dtend, rrule }) {
  let s = `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART:${dtstart}\r\n`;
  if (dtend) s += `DTEND:${dtend}\r\n`;
  if (rrule) s += `RRULE:${rrule}\r\n`;
  s += 'END:VEVENT\r\n';
  return s;
}

const FEED_A = { id: 'feedA', url: 'https://example.com/a.ics', name: 'A', color: '#f00', hidden: false };
const FEED_B = { id: 'feedB', url: 'https://example.com/b.ics', name: 'B', color: '#0f0', hidden: false };

function resetStorage() {
  globalThis.localStorage = new FakeLocalStorage();
}

// Opposite throttle from QuotaThrottledLocalStorage above: the first
// `succeedCount` setItem calls go through normally, then every call after
// that throws QuotaExceededError. Lets a test simulate "the small write
// succeeds, a later larger write overflows" — e.g. a tombstone save going
// through while the subsequent feeds save doesn't.
class QuotaFailsAfterLocalStorage {
  constructor(inner, succeedCount) {
    this.inner = inner;
    this.succeedCount = succeedCount;
    this.calls = 0;
  }
  getItem(key) { return this.inner.getItem(key); }
  setItem(key, value) {
    this.calls += 1;
    if (this.calls > this.succeedCount) {
      const err = new Error('quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.inner.setItem(key, value);
  }
  removeItem(key) { this.inner.removeItem(key); }
}

// --- syncFeed: success ---------------------------------------------------

test('syncFeed: success writes the cache entry and preserves other feeds', async () => {
  resetStorage();
  saveFeeds([FEED_A, FEED_B]);
  saveFeedCache({ feedB: { fetchedAt: '2026-07-01T00:00:00.000Z', events: [{ uid: 'old' }], skipped: [] } });

  const ics = icsWith(vevent({ uid: 'e1', summary: 'Lecture', dtstart: '20260801T090000Z' }));
  let capturedUrl = null;
  let capturedOpts = null;
  const fetchImpl = async (url, opts) => { capturedUrl = url; capturedOpts = opts; return fakeOkResponse(ics); };
  const now = () => new Date('2026-07-28T12:00:00.000Z');

  const result = await syncFeed(FEED_A, { fetchImpl, now });

  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, []);
  assert.ok(capturedUrl.includes(encodeURIComponent(FEED_A.url)));
  assert.equal(capturedOpts.method, 'GET');
  assert.equal(capturedOpts.headers['Cache-Control'], undefined);

  const cache = loadFeedCache();
  assert.equal(cache.feedA.fetchedAt, '2026-07-28T12:00:00.000Z');
  assert.equal(cache.feedA.events.length, 1);
  assert.equal(cache.feedA.events[0].uid, 'e1');
  // Other feed's cache entry is untouched.
  assert.deepEqual(cache.feedB.events, [{ uid: 'old' }]);
});

test('syncFeed: manual sync sends Cache-Control: no-cache', async () => {
  resetStorage();
  let capturedOpts = null;
  const fetchImpl = async (url, opts) => { capturedOpts = opts; return fakeOkResponse(icsWith()); };
  await syncFeed(FEED_A, { fetchImpl, now: () => new Date(), manual: true });
  assert.equal(capturedOpts.headers['Cache-Control'], 'no-cache');
});

test('syncFeed: non-manual sync omits Cache-Control header', async () => {
  resetStorage();
  let capturedOpts = null;
  const fetchImpl = async (url, opts) => { capturedOpts = opts; return fakeOkResponse(icsWith()); };
  await syncFeed(FEED_A, { fetchImpl, now: () => new Date(), manual: false });
  assert.equal(Object.prototype.hasOwnProperty.call(capturedOpts.headers, 'Cache-Control'), false);
});

// --- syncFeed: feed removed mid-flight ------------------------------------

test('syncFeed: a feed removed while its fetch was in flight writes no cache entry', async () => {
  resetStorage();
  // The feed being synced is NOT in stored feeds — exactly the state left
  // behind when Remove ran while this fetch was still outstanding.
  saveFeeds([FEED_B]);
  saveFeedCache({ feedB: { fetchedAt: '2026-07-01T00:00:00.000Z', events: [{ uid: 'keep' }], skipped: [] } });

  const ics = icsWith(vevent({ uid: 'e1', summary: 'Lecture', dtstart: '20260801T090000Z' }));
  const fetchImpl = async () => fakeOkResponse(ics);

  const result = await syncFeed(FEED_A, { fetchImpl, now: () => new Date('2026-07-28T12:00:00.000Z') });

  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  const cache = loadFeedCache();
  assert.equal(Object.prototype.hasOwnProperty.call(cache, 'feedA'), false);
  assert.deepEqual(cache.feedB.events, [{ uid: 'keep' }]);
});

test('syncFeed: a feed still present in stored feeds writes its cache entry as normal', async () => {
  resetStorage();
  saveFeeds([FEED_A]);
  const ics = icsWith(vevent({ uid: 'e1', summary: 'Lecture', dtstart: '20260801T090000Z' }));
  const fetchImpl = async () => fakeOkResponse(ics);

  const result = await syncFeed(FEED_A, { fetchImpl, now: () => new Date('2026-07-28T12:00:00.000Z') });

  assert.equal(result.ok, true);
  assert.equal(result.removed, undefined);
  assert.equal(loadFeedCache().feedA.events.length, 1);
});

// --- syncFeed: failure keeps last-good ------------------------------------

test('syncFeed: upstream error response keeps last-good cache and reports the error', async () => {
  resetStorage();
  saveFeedCache({ feedA: { fetchedAt: '2026-07-01T00:00:00.000Z', events: [{ uid: 'good' }], skipped: [] } });
  const fetchImpl = async () => fakeErrorResponse(422, 'not_an_ics_feed');

  const result = await syncFeed(FEED_A, { fetchImpl, now: () => new Date() });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_an_ics_feed');
  const cache = loadFeedCache();
  assert.deepEqual(cache.feedA.events, [{ uid: 'good' }]);
  assert.equal(cache.feedA.fetchedAt, '2026-07-01T00:00:00.000Z');
});

test('syncFeed: network failure (fetchImpl throws) reports unreachable and keeps cache untouched', async () => {
  resetStorage();
  saveFeedCache({ feedA: { fetchedAt: '2026-07-01T00:00:00.000Z', events: [{ uid: 'good' }], skipped: [] } });
  const fetchImpl = async () => { throw new Error('DNS failure'); };

  const result = await syncFeed(FEED_A, { fetchImpl, now: () => new Date() });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'unreachable');
  assert.deepEqual(loadFeedCache().feedA.events, [{ uid: 'good' }]);
});

// --- syncFeed: quota recovery ---------------------------------------------

test('syncFeed: QuotaError prunes out-of-window events and retries once, succeeding', async () => {
  const inner = new FakeLocalStorage();
  globalThis.localStorage = inner;
  saveFeeds([FEED_A]); // syncFeed only writes a cache entry for a feed that is still stored
  const oldEvent = { uid: 'stale', dtstart: { value: '20250101T090000Z' } }; // ~19 months in the past
  const futureRecurring = { uid: 'rec', dtstart: { value: '20260101T090000Z' }, rrule: 'FREQ=WEEKLY' };
  const inWindow = { uid: 'ok', dtstart: { value: '20260801T090000Z' } };
  saveFeedCache({ feedB: { fetchedAt: '2026-07-01T00:00:00.000Z', events: [oldEvent, futureRecurring, inWindow], skipped: [] } });

  globalThis.localStorage = new QuotaThrottledLocalStorage(inner, 1); // 1st save overflows, 2nd succeeds
  const ics = icsWith(vevent({ uid: 'e1', summary: 'New', dtstart: '20260801T090000Z' }));
  const fetchImpl = async () => fakeOkResponse(ics);
  const now = () => new Date('2026-07-28T12:00:00.000Z');

  const result = await syncFeed(FEED_A, { fetchImpl, now });

  assert.equal(result.ok, true);
  assert.equal(result.quotaPruned, true);
  const cache = loadFeedCache();
  const keptUids = cache.feedB.events.map((e) => e.uid).sort();
  assert.deepEqual(keptUids, ['ok', 'rec']); // stale non-recurring event pruned; recurring + in-window kept
  assert.equal(cache.feedB.quotaPruned, true);
  assert.equal(cache.feedA.events.length, 1); // this sync's own write went through on the retry
});

test('syncFeed: quota prune keeps events whose RANGE overlaps the window, not just DTSTART', async () => {
  const inner = new FakeLocalStorage();
  globalThis.localStorage = inner;
  saveFeeds([FEED_A]); // syncFeed only writes a cache entry for a feed that is still stored
  // (a) started 60 days ago (outside the -30d edge) but DTEND is 10 days from
  // now, inside the window — must survive: it's still ongoing/relevant.
  const spanningEvent = {
    uid: 'spanning',
    dtstart: { value: '20260529T090000Z' }, // 2026-07-28 minus 60 days
    dtend: { value: '20260807T090000Z' }, // 2026-07-28 plus 10 days
  };
  // (b) unbounded weekly rule (no UNTIL/COUNT) with an old DTSTART — must
  // survive regardless of how old its own DTSTART is.
  const unboundedRecurring = {
    uid: 'unbounded',
    dtstart: { value: '20200101T090000Z' },
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
  };
  // (c) a genuinely past single (non-recurring, no span) event — must still
  // be pruned.
  const genuinelyPast = { uid: 'past', dtstart: { value: '20250101T090000Z' } };

  saveFeedCache({
    feedB: {
      fetchedAt: '2026-07-01T00:00:00.000Z',
      events: [spanningEvent, unboundedRecurring, genuinelyPast],
      skipped: [],
    },
  });

  globalThis.localStorage = new QuotaThrottledLocalStorage(inner, 1); // 1st save overflows, 2nd succeeds
  const fetchImpl = async () => fakeOkResponse(icsWith(vevent({ uid: 'e1', summary: 'New', dtstart: '20260801T090000Z' })));
  const now = () => new Date('2026-07-28T12:00:00.000Z');

  const result = await syncFeed(FEED_A, { fetchImpl, now });

  assert.equal(result.ok, true);
  assert.equal(result.quotaPruned, true);
  const keptUids = loadFeedCache().feedB.events.map((e) => e.uid).sort();
  assert.deepEqual(keptUids, ['spanning', 'unbounded']);
});

test('syncFeed: quota prune keeps a recurring master whose UNTIL still reaches the window', async () => {
  const inner = new FakeLocalStorage();
  globalThis.localStorage = inner;
  saveFeeds([FEED_A]); // syncFeed only writes a cache entry for a feed that is still stored
  const stillRelevant = {
    uid: 'until-future',
    dtstart: { value: '20200101T090000Z' },
    rrule: 'FREQ=WEEKLY;UNTIL=20270101T000000Z', // ends well after the window start
  };
  const trulyOver = {
    uid: 'until-past',
    dtstart: { value: '20200101T090000Z' },
    rrule: 'FREQ=WEEKLY;UNTIL=20210101T000000Z', // ended long before the window start
  };
  saveFeedCache({
    feedB: { fetchedAt: '2026-07-01T00:00:00.000Z', events: [stillRelevant, trulyOver], skipped: [] },
  });

  globalThis.localStorage = new QuotaThrottledLocalStorage(inner, 1);
  const fetchImpl = async () => fakeOkResponse(icsWith(vevent({ uid: 'e1', summary: 'New', dtstart: '20260801T090000Z' })));
  const now = () => new Date('2026-07-28T12:00:00.000Z');

  await syncFeed(FEED_A, { fetchImpl, now });

  const keptUids = loadFeedCache().feedB.events.map((e) => e.uid).sort();
  assert.deepEqual(keptUids, ['until-future']);
});

test('syncFeed: QuotaError survives prune+retry, drops the largest feed cache, and surfaces it', async () => {
  const inner = new FakeLocalStorage();
  globalThis.localStorage = inner;
  saveFeeds([FEED_A]); // syncFeed only writes a cache entry for a feed that is still stored
  // feedB is the pre-existing, much larger cache entry — it should be the one dropped.
  const bigEvents = Array.from({ length: 50 }, (_, i) => ({
    uid: `b${i}`,
    dtstart: { value: '20260801T090000Z' },
    summary: 'x'.repeat(200),
  }));
  saveFeedCache({ feedB: { fetchedAt: '2026-07-01T00:00:00.000Z', events: bigEvents, skipped: [] } });

  globalThis.localStorage = new QuotaThrottledLocalStorage(inner, 2); // 1st + 2nd overflow, 3rd succeeds
  const ics = icsWith(vevent({ uid: 'e1', summary: 'New', dtstart: '20260801T090000Z' }));
  const fetchImpl = async () => fakeOkResponse(ics);
  const now = () => new Date('2026-07-28T12:00:00.000Z');

  const result = await syncFeed(FEED_A, { fetchImpl, now });

  assert.equal(result.ok, true);
  assert.equal(result.quotaDropped, true);
  assert.equal(result.droppedFeedId, 'feedB');

  const cache = loadFeedCache();
  assert.equal(cache.feedB.quotaDropped, true);
  assert.deepEqual(cache.feedB.events, []);
  // The feed actually being synced wasn't the one dropped, so its fetch result persisted normally.
  assert.equal(cache.feedA.events.length, 1);
  assert.equal(cache.feedA.quotaDropped, undefined);
});

test('syncFeed: QuotaError that persists even after dropping the largest feed reports storage_full', async () => {
  const inner = new FakeLocalStorage();
  globalThis.localStorage = inner;
  saveFeeds([FEED_A]); // syncFeed only writes a cache entry for a feed that is still stored
  saveFeedCache({});
  globalThis.localStorage = new QuotaThrottledLocalStorage(inner, 3); // every attempt overflows
  const fetchImpl = async () => fakeOkResponse(icsWith());
  const result = await syncFeed(FEED_A, { fetchImpl, now: () => new Date() });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'storage_full');
});

// --- syncStale: staleness boundary -----------------------------------------

test('syncStale: a feed 29 minutes old is not stale and is not synced', async () => {
  resetStorage();
  const now = () => new Date('2026-07-28T12:00:00.000Z');
  const cache = { feedA: { fetchedAt: '2026-07-28T11:31:00.000Z', events: [], skipped: [] } }; // 29 min old
  let called = false;
  const fetchImpl = async () => { called = true; return fakeOkResponse(icsWith()); };

  const results = await syncStale([FEED_A], cache, { fetchImpl, now });

  assert.equal(called, false);
  assert.deepEqual(results, {});
});

test('syncStale: a feed 31 minutes old is stale and gets synced', async () => {
  resetStorage();
  saveFeeds([FEED_A]); // stored, so syncFeed's remove-during-sync guard lets the write through
  const now = () => new Date('2026-07-28T12:00:00.000Z');
  const cache = { feedA: { fetchedAt: '2026-07-28T11:29:00.000Z', events: [], skipped: [] } }; // 31 min old
  let called = false;
  const fetchImpl = async () => { called = true; return fakeOkResponse(icsWith()); };

  const results = await syncStale([FEED_A], cache, { fetchImpl, now });

  assert.equal(called, true);
  assert.equal(results.feedA.ok, true);
});

test('syncStale: a feed with no cache entry at all is treated as stale', async () => {
  resetStorage();
  saveFeeds([FEED_A]); // stored, so syncFeed's remove-during-sync guard lets the write through
  let called = false;
  const fetchImpl = async () => { called = true; return fakeOkResponse(icsWith()); };
  const results = await syncStale([FEED_A], {}, { fetchImpl, now: () => new Date() });
  assert.equal(called, true);
  assert.ok(results.feedA);
});

// --- feedStatus -------------------------------------------------------------

test('feedStatus: "fetched Xm ago" wording, never "synced"', () => {
  const now = new Date('2026-07-28T12:05:00.000Z');
  const entry = { fetchedAt: '2026-07-28T12:00:00.000Z', events: [], skipped: [] };
  const status = feedStatus(FEED_A, entry, now);
  assert.equal(status, 'fetched 5m ago, 0 events');
  assert.ok(!status.includes('synced'));
});

test('feedStatus: no cache entry yet', () => {
  assert.equal(feedStatus(FEED_A, undefined, new Date()), 'not yet synced');
});

test('feedStatus: skipped titles, count + first title + reason', () => {
  const now = new Date('2026-07-28T12:05:00.000Z');
  const entry = {
    fetchedAt: '2026-07-28T12:00:00.000Z',
    events: [],
    skipped: [
      { uid: 'u1', summary: 'Statics Lecture', reason: 'unsupported_freq_subdaily' },
      { uid: 'u2', summary: 'Other', reason: 'bad_date' },
    ],
  };
  const status = feedStatus(FEED_A, entry, now);
  assert.equal(status, "fetched 5m ago, 0 events, 2 skipped: 'Statics Lecture' — unsupported recurrence");
});

// Real incident (punchlist, 2026-08-27): a subscription to the wrong calendar
// looked exactly like a broken one. "0 events" says the feed itself is empty.
test('feedStatus: says how many events the feed holds, singular for one', () => {
  const now = new Date('2026-07-28T12:05:00.000Z');
  const ev = (uid) => ({ uid, title: uid, dtstart: { value: '20260801T090000Z' }, recurrenceId: null });
  const entry = (n) => ({ fetchedAt: '2026-07-28T12:00:00.000Z', events: Array.from({ length: n }, (_, i) => ev(`e${i}`)), skipped: [] });
  assert.equal(feedStatus(FEED_A, entry(0), now), 'fetched 5m ago, 0 events');
  assert.equal(feedStatus(FEED_A, entry(1), now), 'fetched 5m ago, 1 event');
  assert.equal(feedStatus(FEED_A, entry(12), now), 'fetched 5m ago, 12 events');
});

// A dropped entry's events were emptied to free storage, not missing from the
// feed: a count there would read "0 events" for a calendar that has them.
test('feedStatus: no event count when the events were dropped for storage', () => {
  const now = new Date('2026-07-28T12:05:00.000Z');
  const entry = { fetchedAt: '2026-07-28T12:00:00.000Z', events: [], skipped: [], quotaDropped: true };
  const status = feedStatus(FEED_A, entry, now);
  assert.match(status, /storage limit reached/, 'fixture check');
  assert.doesNotMatch(status, /\d+ events?\b/);
});

test('feedStatus: quota-prune note', () => {
  const now = new Date('2026-07-28T12:05:00.000Z');
  const entry = { fetchedAt: '2026-07-28T12:00:00.000Z', events: [], skipped: [], quotaPruned: true };
  const status = feedStatus(FEED_A, entry, now);
  assert.match(status, /storage space/);
});

test('feedStatus: quota-drop note', () => {
  const now = new Date('2026-07-28T12:05:00.000Z');
  const entry = { fetchedAt: '2026-07-28T12:00:00.000Z', events: [], skipped: [], quotaDropped: true };
  const status = feedStatus(FEED_A, entry, now);
  assert.match(status, /storage limit reached/);
});

test('feedStatus: error text', () => {
  const entry = { error: 'upstream_unreachable' };
  const status = feedStatus(FEED_A, entry, new Date());
  assert.equal(status, 'error: calendar server unreachable');
});

// --- instancesForRange -------------------------------------------------------

test('instancesForRange: excludes hidden feeds', () => {
  const hidden = { ...FEED_A, hidden: true };
  const cache = {
    feedA: {
      fetchedAt: '2026-07-28T12:00:00.000Z',
      events: [{ uid: 'e1', title: 'X', form: 'UTC', dtstart: { value: '20260801T090000Z' }, dtend: null, duration: null, rrule: null, exdates: [], recurrenceId: null }],
      skipped: [],
    },
  };
  const out = instancesForRange([hidden], cache, '2026-08-01', '2026-08-01', 'UTC');
  assert.deepEqual(out, []);
});

test('instancesForRange: stamps id, createdAt (untimed -> 00:00), feedId, feedColor, external', () => {
  const cache = {
    feedA: {
      fetchedAt: '2026-07-28T12:00:00.000Z',
      events: [{
        uid: 'e1', title: 'All-day thing', form: 'DATE', dtstart: { value: '20260801', tzid: null },
        dtend: null, duration: null, rrule: null, exdates: [], recurrenceId: null,
      }],
      skipped: [],
    },
  };
  const out = instancesForRange([FEED_A], cache, '2026-08-01', '2026-08-01', 'America/New_York');
  assert.equal(out.length, 1);
  const inst = out[0];
  assert.equal(inst.id, 'feedA:e1:2026-08-01:null');
  assert.equal(inst.createdAt, '2026-08-01T00:00');
  assert.equal(inst.feedId, 'feedA');
  assert.equal(inst.feedColor, FEED_A.color);
  assert.equal(inst.external, true);
  assert.equal(inst.time, null);
});

// V6 § 3.3 — THE PROPERTY THE To-do AND Ideas PAGES DEPEND ON.
//
// Those pages read `items` directly rather than visibleItems(), and the stated
// reason is that an external instance "would fail the predicates by accident
// rather than by design". This pins the accident: an EventInstance carries NO
// `type` and NO `done`, so isTodo/isIdea reject it because there is nothing to
// match, not because anything checks `external`.
//
// Give an instance a `type` and a subscribed calendar starts populating the
// To-do page with events the user cannot complete or delete. Whoever adds one
// has to come back through this comment.
test('an external instance carries no type and no done, which is why the V6 predicates reject it', () => {
  const cache = {
    feedA: {
      fetchedAt: '2026-07-28T12:00:00.000Z',
      events: [{
        uid: 'e1', title: 'Standup', form: 'DATE', dtstart: { value: '20260801', tzid: null },
        dtend: null, duration: null, rrule: null, exdates: [], recurrenceId: null,
      }],
      skipped: [],
    },
  };
  const [inst] = instancesForRange([FEED_A], cache, '2026-08-01', '2026-08-01', 'UTC');
  assert.ok(inst, 'fixture check: an instance must actually have been produced');
  assert.equal('type' in inst, false, 'a feed event with a type would land on the To-do page');
  assert.equal('done' in inst, false, 'and a completable feed event is not a thing the user can act on');
  assert.equal(isTodo(inst), false);
  assert.equal(isIdea(inst), false);
  assert.equal(isScheduled(inst), true, 'a feed event is always a scheduled thing');
});

test('instancesForRange: timed event stamps createdAt with its time', () => {
  const cache = {
    feedA: {
      fetchedAt: '2026-07-28T12:00:00.000Z',
      events: [{
        uid: 'e2', title: 'Timed', form: 'UTC', dtstart: { value: '20260801T140000Z', tzid: null },
        dtend: null, duration: null, rrule: null, exdates: [], recurrenceId: null,
      }],
      skipped: [],
    },
  };
  const out = instancesForRange([FEED_A], cache, '2026-08-01', '2026-08-01', 'UTC');
  assert.equal(out.length, 1);
  assert.equal(out[0].time, '14:00');
  assert.equal(out[0].createdAt, '2026-08-01T14:00');
  assert.equal(out[0].id, 'feedA:e2:2026-08-01:14:00');
});

test('instancesForRange: feed with no cache entry contributes nothing', () => {
  const out = instancesForRange([FEED_A], {}, '2026-08-01', '2026-08-01', 'UTC');
  assert.deepEqual(out, []);
});

test('instancesForRange: an expansion throw is logged by error name only, never the feed URL', () => {
  // A cache entry whose events are structurally wrong (no dtstart) makes
  // expandEvents throw. The feed is still skipped rather than blanking every
  // other calendar, but the failure is no longer silent.
  const cache = {
    feedA: { fetchedAt: '2026-07-28T12:00:00.000Z', events: [{ uid: 'broken', title: 'Broken' }], skipped: [] },
    feedB: {
      fetchedAt: '2026-07-28T12:00:00.000Z',
      events: [{ uid: 'ok', title: 'Fine', dtstart: { value: '20260801T090000Z' }, recurrenceId: null }],
      skipped: [],
    },
  };
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  let out;
  try {
    out = instancesForRange([FEED_A, FEED_B], cache, '2026-08-01', '2026-08-01', 'UTC');
  } finally {
    console.error = realError;
  }

  // The good feed still renders.
  assert.deepEqual(out.map((i) => i.feedId), ['feedB']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /TypeError/);
  // Capability rule: a feed URL is a secret — it must never reach the console.
  assert.ok(!logged[0].includes(FEED_A.url), 'log leaked the feed URL');
  assert.ok(!logged[0].includes('example.com'), 'log leaked the feed host');
});

// instancesForRange runs on EVERY render (four views each), so an entry that
// fails expansion used to log on every tap and every sync. Once per feed per
// session says the same thing.
test('instancesForRange: a feed that fails expansion is logged once per session, not once per render', () => {
  const broken = { fetchedAt: '2026-07-28T12:00:00.000Z', events: [{ uid: 'broken', title: 'Broken' }], skipped: [] };
  const feedX = { ...FEED_A, id: 'feedOnceX' };
  const feedY = { ...FEED_A, id: 'feedOnceY' };
  const cache = { feedOnceX: broken, feedOnceY: broken };
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    for (let i = 0; i < 3; i += 1) instancesForRange([feedX], cache, '2026-08-01', '2026-08-01', 'UTC');
    assert.equal(logged.length, 1, 'three renders, one log');
    instancesForRange([feedX, feedY], cache, '2026-08-01', '2026-08-01', 'UTC');
    assert.equal(logged.length, 2, 'a second broken feed is still reported, once');
  } finally {
    console.error = realError;
  }
});

// --- removeFeed --------------------------------------------------------------

test('removeFeed: removes both the feed and its cache entry, leaves others intact', () => {
  resetStorage();
  saveFeeds([FEED_A, FEED_B]);
  saveFeedCache({
    feedA: { fetchedAt: '2026-07-01T00:00:00.000Z', events: [], skipped: [] },
    feedB: { fetchedAt: '2026-07-02T00:00:00.000Z', events: [{ uid: 'keep' }], skipped: [] },
  });

  removeFeed('feedA');

  const feeds = loadFeeds();
  assert.deepEqual(feeds.map((f) => f.id), ['feedB']);
  const cache = loadFeedCache();
  assert.equal(Object.prototype.hasOwnProperty.call(cache, 'feedA'), false);
  assert.deepEqual(cache.feedB.events, [{ uid: 'keep' }]);
});

test('removeFeed: removing a feed with no cache entry does not throw', () => {
  resetStorage();
  saveFeeds([FEED_A]);
  saveFeedCache({});
  assert.doesNotThrow(() => removeFeed('feedA'));
  assert.deepEqual(loadFeeds(), []);
});

test('removeFeed records a feed tombstone', () => {
  globalThis.localStorage = new FakeLocalStorage();
  saveFeeds([{ id: 'f1', url: 'https://x/c.ics', name: 'X', color: '#111', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z' }]);

  removeFeed('f1');

  assert.deepEqual(loadFeeds(), []);
  const tombs = loadTombstones();
  assert.equal(tombs.length, 1);
  assert.equal(tombs[0].id, 'f1');
  assert.equal(tombs[0].kind, 'feed');
  assert.ok(Date.parse(tombs[0].deletedAt) > 0);
});

test('removeFeed: tombstone-first ordering means the tombstone survives even when the feed-save step throws', () => {
  const inner = new FakeLocalStorage();
  globalThis.localStorage = inner;
  saveFeeds([{ id: 'f1', url: 'https://x/c.ics', name: 'X', color: '#111', hidden: false,
    updatedAt: '2026-08-01T00:00:00.000Z' }]);

  // removeFeed's first setItem is its own addTombstone call — let that
  // succeed. Its second setItem (saveFeeds, the destructive write) throws,
  // simulating storage that can take the small tombstone write but not the
  // larger feeds write. Fix 3 requires the tombstone to be written FIRST,
  // so it must be durable even though the feed removal itself then fails.
  globalThis.localStorage = new QuotaFailsAfterLocalStorage(inner, 1);

  let threw = false;
  try {
    removeFeed('f1');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'removeFeed should propagate the storage failure rather than swallow it');

  const tombs = loadTombstones();
  assert.equal(tombs.length, 1);
  assert.equal(tombs[0].id, 'f1');
  assert.equal(tombs[0].kind, 'feed');
  // The destructive write never completed, so the feed is still present
  // locally — that's the "converges to the user's intent" half of the fix:
  // a tombstone now exists for a record still present, rather than a
  // record gone with no tombstone to propagate the deletion.
  assert.deepEqual(loadFeeds().map((f) => f.id), ['f1']);
});

// A feed record written by a device whose clock runs AHEAD carries an
// updatedAt in this device's future. applyTombstones keeps a record whose
// updatedAt is at or after the deletion, so a removal stamped with this
// device's plain `now` loses to the very record it removes: the feed comes
// back on the next sync, here and on every other device. removeFeed must
// stamp strictly later than the record it removes (merge.js's nextStamp),
// the same rule every item write already follows.
const syncedState = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });
const localSyncedState = () => syncedState({ feeds: loadFeeds(), tombstones: loadTombstones() });

test('removeFeed: a feed stamped in this device\'s future stays removed after merge, here and on a second device', () => {
  resetStorage();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const ahead = { ...FEED_A, updatedAt: future };
  saveFeeds([ahead]);
  // What the account and the second device hold: the same feed, unremoved.
  const otherDevice = syncedState({ feeds: [ahead] });

  removeFeed('feedA');

  const [tomb] = loadTombstones();
  assert.ok(Date.parse(tomb.deletedAt) > Date.parse(future),
    'the tombstone must be stamped strictly after the record it removes');
  const now = new Date();
  // This device pulls the account, which still has the feed.
  assert.deepEqual(merge(localSyncedState(), otherDevice, now).feeds, [],
    'this device must not resurrect the feed it just removed');
  // The second device pulls this device's push.
  assert.deepEqual(merge(otherDevice, localSyncedState(), now).feeds, [],
    'the second device must apply the removal');
});

// MUST NOT CHANGE: removing one feed touches no other feed. Feed URLs are
// unrecoverable (CLAUDE.md), so every survivor is compared byte for byte —
// in storage, after this device's merge with the account, after the second
// device's merge, and on the wire — including one survivor that is itself
// stamped in this device's future.
test('removeFeed: every other feed is byte-identical through a full merge round trip', () => {
  resetStorage();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const feeds = [
    { ...FEED_A, updatedAt: '2026-08-01T00:00:00.000Z' },
    { ...FEED_B, updatedAt: future },
    { id: 'feedC', url: 'https://example.com/c.ics', name: 'C', color: '#00f', hidden: true, updatedAt: '2026-07-01T00:00:00.000Z' },
  ];
  saveFeeds(feeds);
  const survivors = JSON.stringify(feeds.filter((f) => f.id !== 'feedA'));
  const otherDevice = syncedState({ feeds });

  const before = Date.now();
  removeFeed('feedA');
  const after = Date.now();

  // feedA is stamped in the past, so its tombstone is plain now — not pushed
  // into the future, where it would outrank a later legitimate write.
  const stamp = Date.parse(loadTombstones()[0].deletedAt);
  assert.ok(stamp >= before && stamp <= after, 'a past-stamped feed is tombstoned at now');
  assert.equal(JSON.stringify(loadFeeds()), survivors, 'storage');
  const now = new Date();
  const here = merge(localSyncedState(), otherDevice, now);
  assert.equal(JSON.stringify(here.feeds.slice().sort((a, b) => (a.id < b.id ? -1 : 1))), survivors, 'this device after merge');
  const there = merge(otherDevice, here, now);
  assert.equal(JSON.stringify(there.feeds.slice().sort((a, b) => (a.id < b.id ? -1 : 1))), survivors, 'second device after merge');
  assert.deepEqual(toWire(there).feeds, toWire(syncedState({ feeds: JSON.parse(survivors) })).feeds, 'wire form');
  assert.deepEqual(loadTombstones().map((t) => `${t.kind}:${t.id}`), ['feed:feedA'], 'exactly one tombstone, for the removed feed');
});

// --- applyRemoteFeeds --------------------------------------------------------

// The wire form pickFeed hands a first-seen feed (see js/merge.js): color is
// explicitly null, a marker feeds.js MUST replace before saving.
test('applyRemoteFeeds: a first-seen feed with color:null gets a string colour and hidden:false, surviving a save/load round trip', () => {
  resetStorage();
  const merged = [
    { id: 'feedA', url: 'https://example.com/a.ics', name: 'A', updatedAt: '2026-08-01T00:00:00.000Z', color: null, hidden: false },
  ];

  applyRemoteFeeds(merged);

  // Round trip through storage's own deserializer, not just the in-memory
  // return value — this is what a reviewer found actually breaks: a
  // non-string color survives the write but deserializeFeeds drops the
  // whole feed on the very next load.
  const stored = loadFeeds();
  assert.equal(stored.length, 1);
  assert.equal(typeof stored[0].color, 'string');
  assert.equal(stored[0].hidden, false);
});

// A raw wire-form feed (toWire strips color/hidden entirely) has no `color`
// key at all — distinct from color:null, and the shape an `color === null`
// check would silently miss.
test('applyRemoteFeeds: a first-seen feed with no color key at all gets a string colour and hidden:false, surviving a save/load round trip', () => {
  resetStorage();
  const merged = [
    { id: 'feedA', url: 'https://example.com/a.ics', name: 'A', updatedAt: '2026-08-01T00:00:00.000Z' },
  ];

  applyRemoteFeeds(merged);

  const stored = loadFeeds();
  assert.equal(stored.length, 1);
  assert.equal(typeof stored[0].color, 'string');
  assert.equal(stored[0].hidden, false);
});

test('applyRemoteFeeds: preserves local color/hidden for a known feed while accepting a changed name', () => {
  resetStorage();
  saveFeeds([
    { id: 'feedA', url: 'https://example.com/a.ics', name: 'Old Name', color: 'var(--feed-palette-3)', hidden: true, updatedAt: '2026-07-01T00:00:00.000Z' },
  ]);

  const merged = [
    // Same id, changed name, and (per pickFeed's own wire shape) a
    // non-string color/hidden that must never overwrite the local values.
    { id: 'feedA', url: 'https://example.com/a.ics', name: 'New Name', updatedAt: '2026-08-01T00:00:00.000Z', color: null, hidden: false },
  ];

  applyRemoteFeeds(merged);

  const stored = loadFeeds();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'New Name');
  assert.equal(stored[0].color, 'var(--feed-palette-3)');
  assert.equal(stored[0].hidden, true);
});

test('applyRemoteFeeds: removes a feed dropped from mergedFeeds and its cache entry', () => {
  resetStorage();
  saveFeeds([FEED_A, FEED_B]);
  saveFeedCache({
    feedA: { fetchedAt: '2026-07-01T00:00:00.000Z', events: [], skipped: [] },
    feedB: { fetchedAt: '2026-07-02T00:00:00.000Z', events: [{ uid: 'keep' }], skipped: [] },
  });

  // feedA is absent from mergedFeeds — dropped remotely.
  const merged = [{ ...FEED_B, updatedAt: '2026-08-01T00:00:00.000Z' }];

  applyRemoteFeeds(merged);

  assert.deepEqual(loadFeeds().map((f) => f.id), ['feedB']);
  const cache = loadFeedCache();
  assert.equal(Object.prototype.hasOwnProperty.call(cache, 'feedA'), false);
  // The surviving feed's cache entry is untouched.
  assert.deepEqual(cache.feedB.events, [{ uid: 'keep' }]);
});

test('applyRemoteFeeds: returns the added ids for feeds with no local counterpart', () => {
  resetStorage();
  saveFeeds([FEED_A]);
  saveFeedCache({});

  const merged = [
    { ...FEED_A, updatedAt: '2026-08-01T00:00:00.000Z' }, // known — not "added"
    { id: 'feedC', url: 'https://example.com/c.ics', name: 'C', updatedAt: '2026-08-01T00:00:00.000Z', color: null, hidden: false },
  ];

  const result = applyRemoteFeeds(merged);

  assert.deepEqual(result.added, ['feedC']);
  assert.deepEqual(result.removed, []);
});

test('applyRemoteFeeds: returns the removed ids for feeds dropped from mergedFeeds', () => {
  resetStorage();
  saveFeeds([FEED_A, FEED_B]);
  saveFeedCache({});

  const result = applyRemoteFeeds([{ ...FEED_B, updatedAt: '2026-08-01T00:00:00.000Z' }]);

  assert.deepEqual(result.removed, ['feedA']);
  assert.deepEqual(result.added, []);
});

// --- webcalToHttps -------------------------------------------------------------

test('webcalToHttps: converts webcal:// to https://', () => {
  assert.equal(webcalToHttps('webcal://p01.icloud.com/published/2/abc'), 'https://p01.icloud.com/published/2/abc');
});

test('webcalToHttps: leaves https:// untouched', () => {
  assert.equal(webcalToHttps('https://example.com/a.ics'), 'https://example.com/a.ics');
});

test('webcalToHttps: is case-insensitive on the scheme', () => {
  assert.equal(webcalToHttps('WEBCAL://example.com/a.ics'), 'https://example.com/a.ics');
});

// --- inferName -------------------------------------------------------------

test('inferName: Google Calendar host', () => {
  assert.equal(inferName('https://calendar.google.com/calendar/ical/abc/basic.ics'), 'Google');
});

test('inferName: iCloud host', () => {
  assert.equal(inferName('https://p01-calendars.icloud.com/published/2/abc'), 'iCloud');
});

test('inferName: Outlook host', () => {
  assert.equal(inferName('https://outlook.live.com/owa/calendar/abc/calendar.ics'), 'Outlook');
});

test('inferName: Canvas (instructure.com) host', () => {
  assert.equal(inferName('https://canvas.instructure.com/feeds/calendars/abc.ics'), 'Canvas');
});

test('inferName: unknown host falls back to Calendar', () => {
  assert.equal(inferName('https://example.org/feed.ics'), 'Calendar');
});

test('inferName: unparseable URL falls back to Calendar', () => {
  assert.equal(inferName('not a url'), 'Calendar');
});

// --- feedShape (home-screen spec § 2.4, stage 1) -----------------------------
//
// A read-only classification of one feed's cache: which method stage 3a would
// use for it (the RRULE, or the Canvas heuristic) and what each counts. Alex
// reads its Settings line for LMU Classes before 3a starts.

// A ParsedEvent as parseICS stores it (ics.js buildParsedEvent).
function pe({
  uid, title = uid, form = 'UTC', value, tzid = null, rrule = null, recurrenceId = null, dtend = null, duration = null,
}) {
  return {
    uid, title, form, dtstart: { value, tzid }, dtend, duration,
    rrule, exdates: [], recurrenceId,
  };
}

// '2026-08-24' + n weeks -> 'YYYYMMDD'
function weeksAfter(firstISO, n) {
  const d = new Date(`${firstISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// `weeks` separate VEVENTs, one per week, each with its own UID and no RRULE:
// the Canvas shape (provider-format notes: "No RRULE, ever"). Each meeting
// lasts 50 minutes: stage 3a's heuristic never groups an event with no length
// (a Canvas deadline is DTSTART == DTEND).
function canvasWeekly(title, firstISO, weeks, hhmm, tzid = 'America/Los_Angeles') {
  const out = [];
  for (let i = 0; i < weeks; i += 1) {
    out.push(pe({
      uid: `${title}-${i}`, title, form: 'TZID', tzid, value: `${weeksAfter(firstISO, i)}T${hhmm}00`, duration: 'PT50M',
    }));
  }
  return out;
}

const sumOf = (s) => s.repeatingSeries + s.repeatingChanged + s.otherRuleEvents + s.inGuessedSeries + s.single;

test('feedShape: an empty cache has nothing to classify, and says so', () => {
  const shape = feedShape([], 'UTC');
  assert.deepEqual(shape, {
    total: 0, method: 'heuristic', repeatingSeries: 0, repeatingChanged: 0, otherRuleEvents: 0,
    guessedSeries: 0, inGuessedSeries: 0, single: 0,
  });
  assert.equal(describeFeedShape(shape), 'No events to classify.');
});

test('feedShape: a rule feed reads as the spec\'s example line', () => {
  const events = [];
  for (let i = 0; i < 6; i += 1) {
    events.push(pe({ uid: `course-${i}`, value: '20260824T170000Z', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' }));
  }
  for (let i = 0; i < 136; i += 1) events.push(pe({ uid: `one-${i}`, value: '20260901T170000Z' }));
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.method, 'rule');
  assert.equal(shape.repeatingSeries, 6);
  assert.equal(shape.single, 136);
  assert.equal(describeFeedShape(shape), '142 events: 6 repeat (RRULE), 136 single. Uses the rule.');
});

test('feedShape: only FREQ=DAILY and FREQ=WEEKLY repeat, however the RRULE is written', () => {
  const events = [
    pe({ uid: 'w-lower', value: '20260824T170000Z', rrule: 'freq=weekly' }),
    pe({ uid: 'w-second', value: '20260824T170000Z', rrule: 'INTERVAL=2;FREQ=WEEKLY' }),
    pe({ uid: 'd', value: '20260824T170000Z', rrule: 'FREQ=DAILY;COUNT=5' }),
    pe({ uid: 'y', value: '20260824T170000Z', rrule: 'FREQ=YEARLY' }),
    pe({ uid: 'm', value: '20260824T170000Z', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' }),
  ];
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.repeatingSeries, 3, 'lower-case, not-first and DAILY all count');
  assert.equal(shape.otherRuleEvents, 2, 'YEARLY and MONTHLY are one-offs (spec § 2.4, question 7)');
  assert.equal(shape.single, 0);
  assert.equal(describeFeedShape(shape),
    '5 events: 3 repeat (RRULE), 2 yearly/monthly (shown as one-offs), 0 single. Uses the rule.');
});

test('feedShape: overrides belong to their series; a master-less override is single', () => {
  const rid = (value) => ({ value, tzid: null });
  const events = [
    pe({ uid: 'class', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }),
    pe({ uid: 'class', value: '20260901T180000Z', recurrenceId: rid('20260831T170000Z') }),
    pe({ uid: 'class', value: '20260908T180000Z', recurrenceId: rid('20260907T170000Z') }),
    pe({ uid: 'bday', value: '20260824', form: 'DATE', rrule: 'FREQ=YEARLY' }),
    pe({ uid: 'bday', value: '20260825', form: 'DATE', recurrenceId: rid('20260824') }),
    pe({ uid: 'orphan', value: '20260910T170000Z', recurrenceId: rid('20260910T170000Z') }),
  ];
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.repeatingSeries, 1);
  assert.equal(shape.repeatingChanged, 2);
  assert.equal(shape.otherRuleEvents, 2, 'a yearly override is a yearly one-off too');
  assert.equal(shape.single, 1, 'expanded alone (ics.js), it has no FREQ');
  assert.equal(describeFeedShape(shape),
    '6 events: 1 repeat (RRULE), 2 changed instances, 2 yearly/monthly (shown as one-offs), 1 single. Uses the rule.');
});

test('feedShape: one RRULE of any FREQ switches the heuristic off for the whole feed', () => {
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 5, '1000'),
    pe({ uid: 'bday', value: '20260824', form: 'DATE', rrule: 'FREQ=YEARLY' }),
  ];
  const shape = feedShape(events, 'America/Los_Angeles');
  assert.equal(shape.method, 'rule');
  assert.equal(shape.guessedSeries, 0, 'its RRULE-less events stay one-offs, never guessed');
  assert.equal(shape.single, 5);
  assert.equal(shape.otherRuleEvents, 1);
});

test('feedShape: a Canvas-shaped feed reads as the spec\'s heuristic example line', () => {
  const tz = 'America/Los_Angeles';
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 20, '1000'),
    ...canvasWeekly('Stats 101', '2026-08-26', 20, '1000'),
    ...canvasWeekly('Physics', '2026-08-25', 20, '0900'),
    ...canvasWeekly('Physics lab', '2026-08-27', 20, '1400'),
    ...canvasWeekly('Writing', '2026-08-28', 20, '1100'),
    ...canvasWeekly('Seminar', '2026-08-24', 18, '1500'),
  ];
  for (let i = 0; i < 18; i += 1) events.push(pe({ uid: `quiz-${i}`, title: `Quiz ${i}`, value: '20260903T170000Z' }));
  const shape = feedShape(events, tz);
  assert.equal(shape.method, 'heuristic');
  assert.equal(shape.guessedSeries, 6, 'Stats on Monday and on Wednesday are two series');
  assert.equal(shape.inGuessedSeries, 118);
  assert.equal(shape.single, 18);
  assert.equal(describeFeedShape(shape),
    '136 events: no RRULE — 118 in 6 guessed series, 18 single. Uses the heuristic.');
});

test('feedShape: the heuristic needs 3 distinct weeks, not 3 events', () => {
  const twoWeeks = canvasWeekly('Stats 101', '2026-08-24', 2, '1000');
  const doubled = [...twoWeeks, ...twoWeeks.map((ev) => ({ ...ev, uid: `${ev.uid}-copy` }))];
  const shape = feedShape(doubled, 'America/Los_Angeles');
  assert.equal(shape.guessedSeries, 0, 'four events on two dates is two weeks');
  assert.equal(shape.single, 4);
  const three = feedShape(canvasWeekly('Stats 101', '2026-08-24', 3, '1000'), 'America/Los_Angeles');
  assert.equal(three.guessedSeries, 1, 'three weeks is a series');
  assert.equal(three.inGuessedSeries, 3);
});

test('feedShape: the heuristic groups on title, weekday and start time — all three', () => {
  const tz = 'America/Los_Angeles';
  const base = canvasWeekly('Stats 101', '2026-08-24', 2, '1000');
  const cases = [
    ['another title', canvasWeekly('Stats 102', '2026-09-07', 1, '1000')],
    ['another weekday', canvasWeekly('Stats 101', '2026-09-08', 1, '1000')],
    ['another time', canvasWeekly('Stats 101', '2026-09-07', 1, '1100')],
  ];
  for (const [label, third] of cases) {
    const shape = feedShape([...base, ...third.map((ev) => ({ ...ev, uid: `${ev.uid}-x` }))], tz);
    assert.equal(shape.guessedSeries, 0, `${label}: no 3-week group`);
    assert.equal(shape.single, 3, label);
  }
});

test('feedShape: an untimed event has no start time, so it is never guessed', () => {
  const events = [0, 1, 2, 3].map((i) => pe({
    uid: `reading-${i}`, title: 'Reading response', form: 'DATE', value: weeksAfter('2026-08-28', i),
  }));
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.guessedSeries, 0);
  assert.equal(shape.single, 4);
});

// Canvas writes every time in UTC (`DTSTART:...Z`, provider-format notes). A
// 10:00 Pacific class is 17:00Z until 1 Nov 2026 and 18:00Z after it. Read in
// UTC that is two series with a gap; read in the device zone it is one.
test('feedShape: a UTC-stamped weekly class stays one series across the DST change', () => {
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    const day = weeksAfter('2026-09-21', i); // Mondays, 21 Sep .. 7 Dec
    const hour = day < '20261101' ? '17' : '18';
    events.push(pe({ uid: `stats-${i}`, title: 'Stats 101', value: `${day}T${hour}0000Z`, duration: 'PT50M' }));
  }
  const local = feedShape(events, 'America/Los_Angeles');
  assert.equal(local.guessedSeries, 1, 'one class, one series');
  assert.equal(local.inGuessedSeries, 12);
  const utc = feedShape(events, 'UTC');
  assert.equal(utc.guessedSeries, 2, 'fixture check: the zone is what joins them');
});

test('feedShape: every event is counted exactly once', () => {
  const fixtures = [
    [...canvasWeekly('A', '2026-08-24', 4, '1000'), pe({ uid: 'x', value: '20260901', form: 'DATE' })],
    [pe({ uid: 'w', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }), pe({ uid: 'o', value: '20260824T170000Z' })],
  ];
  for (const events of fixtures) {
    const shape = feedShape(events, 'America/Los_Angeles');
    assert.equal(sumOf(shape), shape.total);
    assert.equal(shape.total, events.length);
  }
});

test('describeFeedShape: one event is singular', () => {
  assert.equal(describeFeedShape(feedShape([pe({ uid: 'o', value: '20260824T170000Z' })], 'UTC')),
    '1 event: no RRULE — 0 in 0 guessed series, 1 single. Uses the heuristic.');
});

// --- recurring: which instances repeat (home-screen spec § 2.4, stage 3a) ----
//
// Today shows a repeating event only on its own day and keeps it out of Next 7
// days. A series is (feedId, uid); it repeats if that feed's cache holds a
// master with FREQ=DAILY or FREQ=WEEKLY. Every instance says so in a boolean
// `recurring`, and `guessedSeries` says whether the heuristic decided it.

const RFEED = { id: 'feedR', url: 'https://example.com/r.ics', name: 'Classes', color: '#00f', hidden: false };
const SFEED = { id: 'feedS', url: 'https://example.com/s.ics', name: 'Other', color: '#0ff', hidden: false };
const cacheFor = (byFeed) => Object.fromEntries(Object.entries(byFeed)
  .map(([id, events]) => [id, { fetchedAt: '2026-08-01T00:00:00.000Z', events, skipped: [] }]));
const flagsByUid = (instances) => {
  const out = {};
  for (const i of instances) (out[i.uid] ||= []).push([i.recurring, i.guessedSeries]);
  return out;
};

test('instancesForRange: every instance carries recurring and guessedSeries, both booleans', () => {
  const events = [pe({ uid: 'one', value: '20260825T170000Z' }), pe({ uid: 'w', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' })];
  const out = instancesForRange([RFEED], cacheFor({ feedR: events }), '2026-08-24', '2026-08-30', 'UTC');
  assert.equal(out.length, 2, 'fixture check');
  for (const inst of out) {
    assert.deepEqual(Object.keys(inst).sort(), [
      'createdAt', 'date', 'endTime', 'external', 'feedColor', 'feedId', 'guessedSeries', 'id',
      'recurring', 'spanKey', 'time', 'title', 'uid',
    ]);
    assert.equal(typeof inst.spanKey, 'string');
    assert.equal(typeof inst.recurring, 'boolean');
    assert.equal(typeof inst.guessedSeries, 'boolean');
  }
});

test('instancesForRange: only a DAILY or WEEKLY series is recurring; YEARLY, MONTHLY and one-offs are not', () => {
  const events = [
    pe({ uid: 'weekly', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }),
    pe({ uid: 'daily', value: '20260824T080000Z', rrule: 'freq=daily;COUNT=3' }),
    pe({ uid: 'yearly', value: '20260826T120000Z', rrule: 'FREQ=YEARLY' }),
    pe({ uid: 'monthly', value: '20260827T120000Z', rrule: 'FREQ=MONTHLY' }),
    pe({ uid: 'once', value: '20260828T120000Z' }),
  ];
  const flags = flagsByUid(instancesForRange([RFEED], cacheFor({ feedR: events }), '2026-08-24', '2026-08-30', 'UTC'));
  assert.deepEqual(flags, {
    weekly: [[true, false]],
    daily: [[true, false], [true, false], [true, false]],
    yearly: [[false, false]],
    monthly: [[false, false]],
    once: [[false, false]],
  }, 'a rule-detected series is never labelled guessed');
});

// Final fixes 2, C5: a WEEKLY rule with COUNT=1 has exactly one occurrence.
// It is a one-off, kept in Next 7 days, and the Settings line says single.
// Parsed from real ICS, so the stored rrule text is what parseICS keeps.
test('instancesForRange and feedShape: a DAILY or WEEKLY rule with COUNT=1 is a one-off', () => {
  const { events } = parseICS(icsWith(
    vevent({ uid: 'once-w', summary: 'Once weekly', dtstart: '20260824T170000Z', dtend: '20260824T180000Z', rrule: 'FREQ=WEEKLY;COUNT=1' }),
    vevent({ uid: 'once-d', summary: 'Once daily', dtstart: '20260825T170000Z', dtend: '20260825T180000Z', rrule: 'count=1;freq=daily' }),
    vevent({ uid: 'twice', summary: 'Twice', dtstart: '20260826T170000Z', dtend: '20260826T180000Z', rrule: 'FREQ=WEEKLY;COUNT=2' }),
  ));
  assert.equal(events.length, 3, 'fixture check: parseICS kept all three');
  const flags = flagsByUid(instancesForRange([RFEED], cacheFor({ feedR: events }), '2026-08-24', '2026-09-06', 'UTC'));
  assert.deepEqual(flags, {
    'once-w': [[false, false]],
    'once-d': [[false, false]],
    twice: [[true, false], [true, false]],
  });
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.repeatingSeries, 1, 'only COUNT=2 repeats');
  assert.equal(shape.single, 2, 'the COUNT=1 masters are single');
  assert.equal(sumOf(shape), shape.total);
});

// Stage 3 round-2 re-review leftover (2): the same holds for YEARLY and
// MONTHLY. A COUNT=1 rule of either reads "single" in the Settings line, not
// "yearly/monthly (shown as one-offs)". The COUNT=2 rules are the control:
// they still read as yearly/monthly.
test('feedShape and describeFeedShape: a YEARLY or MONTHLY rule with COUNT=1 reads "single"', () => {
  const { events } = parseICS(icsWith(
    vevent({ uid: 'once-y', summary: 'Once yearly', dtstart: '20260824T170000Z', dtend: '20260824T180000Z', rrule: 'FREQ=YEARLY;COUNT=1' }),
    vevent({ uid: 'once-m', summary: 'Once monthly', dtstart: '20260825T170000Z', dtend: '20260825T180000Z', rrule: 'count=1;freq=monthly' }),
    vevent({ uid: 'twice-y', summary: 'Twice yearly', dtstart: '20260826T170000Z', dtend: '20260826T180000Z', rrule: 'FREQ=YEARLY;COUNT=2' }),
    vevent({ uid: 'twice-m', summary: 'Twice monthly', dtstart: '20260827T170000Z', dtend: '20260827T180000Z', rrule: 'FREQ=MONTHLY;COUNT=2' }),
  ));
  assert.equal(events.length, 4, 'fixture check: parseICS kept all four');
  const shape = feedShape(events, 'UTC');
  assert.equal(shape.single, 2, 'the COUNT=1 masters are single');
  assert.equal(shape.otherRuleEvents, 2, 'the COUNT=2 masters are yearly/monthly');
  assert.equal(sumOf(shape), shape.total);
  assert.equal(describeFeedShape(shape),
    '4 events: 0 repeat (RRULE), 2 yearly/monthly (shown as one-offs), 2 single. Uses the rule.');
});

test('instancesForRange: an override belongs to its weekly series, wherever it moved; a master-less override is a one-off', () => {
  const rid = (value) => ({ value, tzid: null });
  const events = [
    pe({ uid: 'class', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }),
    // Monday 31 Aug moved to Wednesday 2 Sep.
    pe({ uid: 'class', value: '20260902T180000Z', recurrenceId: rid('20260831T170000Z') }),
    pe({ uid: 'orphan', value: '20260901T170000Z', recurrenceId: rid('20260901T170000Z') }),
  ];
  const out = instancesForRange([RFEED], cacheFor({ feedR: events }), '2026-08-31', '2026-09-06', 'UTC');
  assert.deepEqual(out.map((i) => [i.uid, i.date, i.recurring]), [
    ['orphan', '2026-09-01', false],
    ['class', '2026-09-02', true],
  ]);
});

test('instancesForRange: a series is per feed — the same uid in another feed is not recurring', () => {
  const out = instancesForRange([RFEED, SFEED], cacheFor({
    feedR: [pe({ uid: 'x', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' })],
    feedS: [pe({ uid: 'x', value: '20260825T170000Z' })],
  }), '2026-08-24', '2026-08-30', 'UTC');
  assert.deepEqual(out.map((i) => [i.feedId, i.recurring]), [['feedR', true], ['feedS', false]]);
});

// --- guessedSeries: the Canvas heuristic at render time (spec § 2.4) ---------
//
// A feed with no RRULE at all (the Canvas shape) has each meeting as its own
// VEVENT. The same title, weekday and start time on 3+ distinct weeks is
// guessed to be one weekly series. feedShape (the Settings line) and
// instancesForRange (Today) read the same grouping, so they cannot disagree.
//
// THE CANVAS-DEADLINE RISK (spec, end notes): a weekly assignment with the
// same title, weekday and time would be grouped, and the repeating rule would
// then keep that DEADLINE out of Next 7 days. Canvas writes a timed assignment
// as DTSTART == DTEND and an untimed one as an all-day DATE (provider-format
// notes). So the heuristic groups only events with a length: a point in time
// is never part of a guessed series.

const TZ_LA = 'America/Los_Angeles';
const guessIn = (events, start, end) => instancesForRange([RFEED], cacheFor({ feedR: events }), start, end, TZ_LA);

test('instancesForRange: in a feed with no RRULE, a class on 3+ weeks is a guessed repeating series', () => {
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 4, '1000'),
    pe({ uid: 'midterm', title: 'Midterm', form: 'TZID', tzid: TZ_LA, value: '20260916T100000', duration: 'PT2H' }),
  ];
  const out = guessIn(events, '2026-09-14', '2026-09-20');
  assert.deepEqual(out.map((i) => [i.title, i.date, i.recurring, i.guessedSeries]), [
    ['Stats 101', '2026-09-14', true, true],
    ['Midterm', '2026-09-16', false, false],
  ]);
});

test('instancesForRange: two weeks is not a series, so both meetings stay one-offs', () => {
  const out = guessIn(canvasWeekly('Stats 101', '2026-08-24', 2, '1000'), '2026-08-24', '2026-09-06');
  assert.deepEqual(out.map((i) => [i.recurring, i.guessedSeries]), [[false, false], [false, false]]);
});

test('instancesForRange: one RRULE anywhere in the feed switches the heuristic off for all of it', () => {
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 4, '1000'),
    pe({ uid: 'bday', form: 'DATE', value: '20260301', rrule: 'FREQ=YEARLY' }),
  ];
  const stats = guessIn(events, '2026-09-14', '2026-09-14');
  assert.equal(stats.length, 1, 'fixture check');
  assert.equal(stats[0].recurring, false, 'its RRULE-less events stay one-offs, never guessed (spec § 2.4)');
  assert.equal(stats[0].guessedSeries, false);
});

test('instancesForRange: a weekly deadline (DTSTART == DTEND, the Canvas assignment shape) is never guessed', () => {
  const quiz = [0, 1, 2, 3].map((i) => {
    const value = `${weeksAfter('2026-08-28', i)}T235900`;
    return pe({ uid: `quiz-${i}`, title: 'Reading quiz', form: 'TZID', tzid: TZ_LA, value, dtend: { value, tzid: TZ_LA } });
  });
  const noEnd = [0, 1, 2, 3].map((i) => pe({
    uid: `essay-${i}`, title: 'Weekly essay', form: 'TZID', tzid: TZ_LA, value: `${weeksAfter('2026-08-27', i)}T170000`,
  }));
  // A zero DURATION is a point in time too (final review A11f).
  const zero = [0, 1, 2, 3].map((i) => pe({
    uid: `lab-due-${i}`, title: 'Lab due', form: 'TZID', tzid: TZ_LA, value: `${weeksAfter('2026-08-26', i)}T090000`,
    duration: 'PT0S',
  }));
  const out = guessIn([...quiz, ...noEnd, ...zero], '2026-09-09', '2026-09-18');
  assert.deepEqual(out.map((i) => [i.title, i.date, i.recurring]), [
    ['Lab due', '2026-09-09', false],
    ['Weekly essay', '2026-09-10', false],
    ['Reading quiz', '2026-09-11', false],
    ['Lab due', '2026-09-16', false],
    ['Weekly essay', '2026-09-17', false],
    ['Reading quiz', '2026-09-18', false],
  ], 'every deadline stays a one-off, so Next 7 days shows it');
  const shape = feedShape([...quiz, ...noEnd, ...zero], TZ_LA);
  assert.equal(shape.guessedSeries, 0, 'and the Settings line says the same');
  assert.equal(shape.single, 12);
});

test('instancesForRange: a class written with DTEND after DTSTART is guessable, like one with a DURATION', () => {
  const events = [0, 1, 2].map((i) => {
    const day = weeksAfter('2026-08-25', i);
    return pe({
      uid: `lab-${i}`, title: 'Physics lab', form: 'TZID', tzid: TZ_LA, value: `${day}T140000`,
      dtend: { value: `${day}T165000`, tzid: TZ_LA },
    });
  });
  const out = guessIn(events, '2026-09-08', '2026-09-08');
  assert.deepEqual(out.map((i) => [i.recurring, i.guessedSeries]), [[true, true]]);
});

// Four Monday meetings, two each side of 1 Nov 2026: in UTC that is two
// 2-week groups (17:00Z, then 18:00Z), neither a series; in the device zone it
// is one 4-week series at 10:00.
test('instancesForRange: a guessed UTC-stamped class stays one series across the DST change', () => {
  const events = [];
  for (let i = 0; i < 4; i += 1) {
    const day = weeksAfter('2026-10-19', i);
    const hour = day < '20261101' ? '17' : '18';
    events.push(pe({ uid: `stats-${i}`, title: 'Stats 101', value: `${day}T${hour}0000Z`, duration: 'PT50M' }));
  }
  const out = guessIn(events, '2026-10-26', '2026-11-08');
  assert.deepEqual(out.map((i) => [i.date, i.time, i.recurring]), [
    ['2026-10-26', '10:00', true],
    ['2026-11-02', '10:00', true],
  ]);
});

test('feedShape and instancesForRange agree on which events are in guessed series', () => {
  const events = [
    ...canvasWeekly('Stats 101', '2026-08-24', 5, '1000'),
    ...canvasWeekly('Physics', '2026-08-25', 2, '0900'),
    pe({ uid: 'due', title: 'Problem set', form: 'TZID', tzid: TZ_LA, value: '20260901T235900' }),
  ];
  const shape = feedShape(events, TZ_LA);
  const out = guessIn(events, '2026-08-24', '2026-09-30');
  assert.equal(out.length, events.length, 'fixture check: every event expanded once');
  assert.equal(out.filter((i) => i.guessedSeries).length, shape.inGuessedSeries);
  assert.equal(out.filter((i) => !i.recurring).length, shape.single);
});

// --- spanKey: which instances are the same occurrence (spec § 2.3, 2026-10-22) -
//
// One multi-day all-day event emits one instance per day, all with one uid.
// But a uid can also be shared by DIFFERENT events: master-less overrides and
// duplicate-UID one-offs. spanKey is `${feedId}:${uid}` only where the uid has
// exactly one ParsedEvent without an rrule; every other instance is its own.

test('instancesForRange: a plain one-off\'s per-day copies share one spanKey', () => {
  const trip = pe({ uid: 'trip', value: '20260825', form: 'DATE', dtend: { value: '20260828', tzid: null } });
  const out = instancesForRange([RFEED], cacheFor({ feedR: [trip] }), '2026-08-24', '2026-08-30', 'UTC');
  assert.ok(out.length > 1, 'fixture check: several per-day instances');
  for (const i of out) assert.equal(i.spanKey, 'feedR:trip');
});

test('instancesForRange: a uid shared by several events, or carrying a rule, gives each instance its own spanKey', () => {
  const rid = (value) => ({ value, tzid: null });
  const events = [
    pe({ uid: 'dup', value: '20260825T170000Z' }),
    pe({ uid: 'dup', value: '20260827T170000Z' }),
    pe({ uid: 'orphan', value: '20260826T170000Z', recurrenceId: rid('20260826T170000Z') }),
    pe({ uid: 'orphan', value: '20260828T170000Z', recurrenceId: rid('20260828T170000Z') }),
    pe({ uid: 'w', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }),
  ];
  const out = instancesForRange([RFEED], cacheFor({ feedR: events }), '2026-08-24', '2026-08-30', 'UTC');
  assert.ok(out.length >= 5, 'fixture check');
  for (const i of out) assert.equal(i.spanKey, i.id, `${i.uid} ${i.date}`);
});

// --- the series memo (render-perf, 2026-10-27) --------------------------------
//
// instancesForRange runs ~6 times per render, and the heuristic's grouping of
// a large no-RRULE feed was ~41 % of a render at 4x CPU throttling. The series
// work (seriesIndex + spanKeyUids) is memoized per `entry.events` ARRAY and
// targetTz. Every cache writer builds a new events array (syncFeed, the quota
// prune, loadFeedCache's JSON.parse), so a refetch invalidates the memo by
// itself. The memo never changes WHAT is computed — only how often.

test('series memo: repeated calls, and a fresh copy of the same events, give identical instances', () => {
  const heuristic = [
    ...canvasWeekly('Stats 101', '2026-08-24', 4, '1000'),
    pe({ uid: 'midterm', title: 'Midterm', form: 'TZID', tzid: TZ_LA, value: '20260916T100000', duration: 'PT2H' }),
  ];
  const rule = [
    pe({ uid: 'w', value: '20260824T170000Z', rrule: 'FREQ=WEEKLY' }),
    pe({ uid: 'one', value: '20260915T170000Z', duration: 'PT1H' }),
  ];
  const cache = cacheFor({ feedR: heuristic, feedS: rule });
  const first = instancesForRange([RFEED, SFEED], cache, '2026-09-14', '2026-09-20', TZ_LA);
  assert.ok(first.some((i) => i.guessedSeries) && first.some((i) => i.recurring && !i.guessedSeries), 'fixture check');
  assert.deepEqual(instancesForRange([RFEED, SFEED], cache, '2026-09-14', '2026-09-20', TZ_LA), first);
  const copy = cacheFor({ feedR: structuredClone(heuristic), feedS: structuredClone(rule) });
  assert.deepEqual(instancesForRange([RFEED, SFEED], copy, '2026-09-14', '2026-09-20', TZ_LA), first);
});

// The memo is used: seriesComputations() counts the times the series work
// actually ran. Same array and zone: once, however many calls. A new array
// (a refetch, a reload) or another zone: once more.
test('series memo: computed once per events array and zone, not once per call', () => {
  const events = canvasWeekly('Stats 101', '2026-08-24', 4, '1000');
  const cache = cacheFor({ feedR: events });
  const before = seriesComputations();
  for (let k = 0; k < 6; k += 1) instancesForRange([RFEED], cache, '2026-09-14', '2026-09-20', TZ_LA);
  assert.equal(seriesComputations() - before, 1, 'six calls, one computation');
  instancesForRange([RFEED], cacheFor({ feedR: [...events] }), '2026-09-14', '2026-09-20', TZ_LA);
  assert.equal(seriesComputations() - before, 2, 'a new array is computed again');
  instancesForRange([RFEED], cache, '2026-09-14', '2026-09-20', 'UTC');
  assert.equal(seriesComputations() - before, 3, 'another zone is computed again');
});

test('series memo: a refetch that replaces the cache entry is never answered from the memo', async () => {
  resetStorage();
  saveFeeds([FEED_A]);
  const weekly = (n) => icsWith(...Array.from({ length: n }, (_, i) => vevent({
    uid: `m${i}`, summary: 'Meeting', dtstart: `${weeksAfter('2026-08-24', 3 - i)}T170000Z`,
    dtend: `${weeksAfter('2026-08-24', 3 - i)}T175000Z`,
  })));
  const now = () => new Date('2026-09-14T12:00:00.000Z');
  const on14 = (cache) => instancesForRange([FEED_A], cache, '2026-09-14', '2026-09-14', 'UTC')
    .map((i) => [i.uid, i.recurring, i.guessedSeries]);

  assert.equal((await syncFeed(FEED_A, { fetchImpl: async () => fakeOkResponse(weekly(4)), now })).ok, true);
  const snapshot = loadFeedCache(); // as app.js holds it: one object, rendered many times
  for (let k = 0; k < 3; k += 1) assert.deepEqual(on14(snapshot), [['m0', true, true]]);
  assert.equal((await syncFeed(FEED_A, { fetchImpl: async () => fakeOkResponse(weekly(2)), now })).ok, true);
  assert.deepEqual(on14(loadFeedCache()), [['m0', false, false]], 'two weeks after the refetch: no longer a series');
  assert.equal((await syncFeed(FEED_A, { fetchImpl: async () => fakeOkResponse(weekly(4)), now })).ok, true);
  assert.deepEqual(on14(loadFeedCache()), [['m0', true, true]], 'and back');
});

// A UTC-stamped 10:00 Pacific class is 17:00Z before 1 Nov 2026 and 18:00Z
// after it: read in Los Angeles, four Mondays are one series; read in UTC they
// are two groups of two weeks, neither a series.
test('series memo: the zone is part of the key — the same array in another zone is recomputed', () => {
  const events = ['20261019T170000Z', '20261026T170000Z', '20261102T180000Z', '20261109T180000Z']
    .map((value, i) => pe({ uid: `stats-${i}`, title: 'Stats 101', value, duration: 'PT50M' }));
  const cache = cacheFor({ feedR: events });
  const on9 = (tz) => instancesForRange([RFEED], cache, '2026-11-09', '2026-11-09', tz).map((i) => i.recurring);
  assert.deepEqual(on9(TZ_LA), [true]);
  assert.deepEqual(on9('UTC'), [false]);
  assert.deepEqual(on9(TZ_LA), [true]);
});
