import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFlow, parseViaWorker, SMART_ADD_TIMEOUT_MS } from '../js/smartadd.js';
import { WORKER_URL } from '../js/config.js';

// parseViaWorker calls fetch, so this file must never reach the production
// Worker: every fetch a test has not stubbed rejects the way an offline device
// does. Tests that stub fetch restore it in finally.
globalThis.fetch = () => Promise.reject(new TypeError('network blocked in tests'));

test('the default fetch in this file is offline, not the production Worker', async () => {
  await assert.rejects(globalThis.fetch(WORKER_URL), /network blocked in tests/);
});

test('single confident item → direct', () => {
  assert.equal(decideFlow({ items: [{}], needsReview: false }), 'direct');
});

test('single item but needsReview → preview', () => {
  assert.equal(decideFlow({ items: [{}], needsReview: true }), 'preview');
});

test('multiple items → preview', () => {
  assert.equal(decideFlow({ items: [{}, {}], needsReview: false }), 'preview');
});

test('no items → empty', () => {
  assert.equal(decideFlow({ items: [], needsReview: false }), 'empty');
});

// --- parseViaWorker --------------------------------------------------------
//
// It goes through fetchWithTimeout with its own budget, so a Worker that never
// answers ends in 'unreachable' (app.js: "Smart add is unavailable — pick a
// date below …") instead of leaving the add box on "Thinking…" for good.
// Every path that returns or throws must also leave the deadline DISARMED:
// fetchWithTimeout disarms only when the body read settles, so an error path
// that never read the body would abort a finished request a minute later.

// setImmediate is not mocked here (apis: ['setTimeout'] only), so this lets
// every pending promise chain run to completion.
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => { setImmediate(r); }); };

function stubFetch(respond) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => { calls.push({ url, init }); return respond(url, init); };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function response(status, { json, text } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {},
    json: json || (async () => ({})),
    text: text || (async () => ''),
  };
}

test('the smart-add budget is 60 s', () => {
  assert.equal(SMART_ADD_TIMEOUT_MS, 60000);
});

test('parseViaWorker: success returns the parsed reply, and leaves no deadline armed', async (t) => {
  const reply = { items: [{ title: 'Dentist', date: '2099-01-02', type: 'event' }], needsReview: false };
  const net = stubFetch(async () => response(200, { json: async () => reply }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.deepEqual(await parseViaWorker('dentist on jan 2'), reply);
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].url, WORKER_URL);
    assert.equal(net.calls[0].init.method, 'POST');
    assert.equal(JSON.parse(net.calls[0].init.body).text, 'dentist on jan 2');
    t.mock.timers.tick(SMART_ADD_TIMEOUT_MS);
    assert.equal(net.calls[0].init.signal.aborted, false, 'a finished request must not be aborted later');
  } finally {
    t.mock.timers.reset();
    net.restore();
  }
});

test('parseViaWorker: 413 → too_long, and the body is read so no deadline stays armed', async (t) => {
  let bodyRead = false;
  const net = stubFetch(async () => response(413, { text: async () => { bodyRead = true; return '{"error":"too_long"}'; } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(parseViaWorker('x'), { message: 'too_long' });
    assert.equal(bodyRead, true, 'the error body is read before throwing');
    t.mock.timers.tick(SMART_ADD_TIMEOUT_MS);
    assert.equal(net.calls[0].init.signal.aborted, false, 'the 413 path must disarm the deadline');
  } finally {
    t.mock.timers.reset();
    net.restore();
  }
});

test('parseViaWorker: 500 → server, and the body is read so no deadline stays armed', async (t) => {
  let bodyRead = false;
  const net = stubFetch(async () => response(500, { text: async () => { bodyRead = true; return 'oops'; } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(parseViaWorker('x'), { message: 'server' });
    assert.equal(bodyRead, true, 'the error body is read before throwing');
    t.mock.timers.tick(SMART_ADD_TIMEOUT_MS);
    assert.equal(net.calls[0].init.signal.aborted, false, 'the 500 path must disarm the deadline');
  } finally {
    t.mock.timers.reset();
    net.restore();
  }
});

test('parseViaWorker: an error body that fails to read still gives the status error', async (t) => {
  const net = stubFetch(async () => response(500, { text: async () => { throw new TypeError('body lost'); } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(parseViaWorker('x'), { message: 'server' });
  } finally {
    t.mock.timers.reset();
    net.restore();
  }
});

test('parseViaWorker: a fetch that rejects → unreachable', async (t) => {
  const net = stubFetch(() => Promise.reject(new TypeError('offline')));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(parseViaWorker('x'), { message: 'unreachable' });
  } finally {
    t.mock.timers.reset();
    net.restore();
  }
});

test('parseViaWorker: a Worker that never answers → unreachable at the budget, not before', async (t) => {
  const net = stubFetch(() => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let outcome = null;
    parseViaWorker('x').then(() => { outcome = 'resolved'; }, (err) => { outcome = err.message; });
    await flush();
    t.mock.timers.tick(SMART_ADD_TIMEOUT_MS - 1);
    await flush();
    assert.equal(outcome, null, 'still waiting just before the budget');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(outcome, 'unreachable', 'a hung request gives up at the budget');
    assert.equal(net.calls[0].init.signal.aborted, true, 'and the request is aborted');
  } finally {
    t.mock.timers.reset();
    net.restore();
  }
});

test('parseViaWorker: a reply body that stalls → unreachable at the budget', async (t) => {
  const net = stubFetch(async () => response(200, { json: () => new Promise(() => {}) }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let outcome = null;
    parseViaWorker('x').then(() => { outcome = 'resolved'; }, (err) => { outcome = err.message; });
    await flush();
    t.mock.timers.tick(SMART_ADD_TIMEOUT_MS);
    await flush();
    assert.equal(outcome, 'unreachable', 'a body that never finishes is the same as no answer');
  } finally {
    t.mock.timers.reset();
    net.restore();
  }
});

test('parseViaWorker: a 200 whose body is not JSON → server', async (t) => {
  const net = stubFetch(async () => response(200, { json: async () => { throw new SyntaxError('Unexpected token'); } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await assert.rejects(parseViaWorker('x'), { message: 'server' });
  } finally {
    t.mock.timers.reset();
    net.restore();
  }
});
