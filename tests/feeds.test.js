import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncFeed, syncStale, feedStatus, instancesForRange, removeFeed,
  webcalToHttps, inferName, applyRemoteFeeds,
} from '../js/feeds.js';
import {
  loadFeeds, saveFeeds, loadFeedCache, saveFeedCache, loadTombstones,
} from '../js/storage.js';

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
  assert.equal(status, 'fetched 5m ago');
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
  assert.equal(status, "fetched 5m ago, 2 skipped: 'Statics Lecture' — unsupported recurrence");
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
