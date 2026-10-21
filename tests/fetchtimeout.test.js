import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, FETCH_TIMEOUT_MS } from '../js/fetchtimeout.js';

// The two timer paths tests/apply.test.js's sF3 tests do not reach (review of
// c6cfbf5, O3/O4). Losing either would abort an already-finished request up
// to 60 s later. Driven directly here: no app, no DOM.

test('the budget is 60 s', () => {
  assert.equal(FETCH_TIMEOUT_MS, 60000);
});

test('a fetch that rejects later clears its timer: nothing is aborted afterwards', async (t) => {
  let signal = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { signal = init.signal; return Promise.reject(new TypeError('offline')); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(fetchWithTimeout('https://example.com/x'), /offline/);
    t.mock.timers.tick(FETCH_TIMEOUT_MS);
    assert.equal(signal.aborted, false, 'the timer must be disarmed when the fetch itself rejects');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

test('a body read with json() disarms the timer once it settles', async (t) => {
  let signal = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    signal = init.signal;
    return Promise.resolve({ ok: false, status: 502, headers: {}, json: async () => ({ error: 'upstream_error' }) });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const res = await fetchWithTimeout('https://example.com/x');
    assert.deepEqual(await res.json(), { error: 'upstream_error' });
    t.mock.timers.tick(FETCH_TIMEOUT_MS);
    assert.equal(signal.aborted, false, 'the timer must be disarmed once json() has settled');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

// Smart add passes its own budget (js/smartadd.js SMART_ADD_TIMEOUT_MS). The
// third argument is optional: every existing caller passes two and keeps 60 s.
test('an explicit budget is honoured: aborted at that budget, not before', async (t) => {
  let signal = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { signal = init.signal; return new Promise(() => {}); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = fetchWithTimeout('https://example.com/x', {}, 1000);
    let rejected = null;
    pending.catch((err) => { rejected = err; });
    t.mock.timers.tick(999);
    await Promise.resolve();
    assert.equal(signal.aborted, false, 'not aborted before the budget');
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(signal.aborted, true, 'aborted at the budget');
    await assert.rejects(pending, /timeout/);
    assert.ok(rejected);
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

// A typo'd budget (a string, NaN, 0, a negative) used to reach setTimeout,
// which treats it as 0 or 1 ms and aborts every request at once. Only an
// omitted budget defaults.
for (const bad of [null, '1000', NaN, 0, -1, Infinity]) {
  test(`a budget of ${String(bad)} is refused with a TypeError, before any fetch`, () => {
    let fetched = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { fetched += 1; return new Promise(() => {}); };
    try {
      assert.throws(() => fetchWithTimeout('https://example.com/x', {}, bad), TypeError);
      assert.equal(fetched, 0, 'nothing is fetched with a bad budget');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('an omitted budget still defaults to FETCH_TIMEOUT_MS', async (t) => {
  let signal = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { signal = init.signal; return new Promise(() => {}); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = fetchWithTimeout('https://example.com/x', {}, undefined);
    pending.catch(() => {});
    t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});
