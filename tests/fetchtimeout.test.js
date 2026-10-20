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
