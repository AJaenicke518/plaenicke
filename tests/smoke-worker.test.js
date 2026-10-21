// smoke-worker.test.js — the PURE parts of scripts/smoke-worker.mjs.
//
// The script itself POSTs to the production Worker and every call spends
// Anthropic credits. Nothing here may reach it. The offline fetch below is
// installed BEFORE the script is imported, so even a module-scope fetch in the
// script (there must be none) would be caught and counted, not sent.
let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  return Promise.reject(new TypeError('network blocked in tests'));
};

import { test } from 'node:test';
import assert from 'node:assert/strict';

const smoke = await import('../scripts/smoke-worker.mjs');
const fetchesDuringImport = fetchCalls;
const {
  PHRASES, EXPECTED_ORIGIN, checkResult, runSmoke, formatTable, isMain,
} = smoke;

import { ITEM_TYPES } from '../worker/src/prompt.js';
import { ALLOWED_ORIGIN } from '../worker/src/cors.js';
import { WORKER_URL } from '../js/config.js';

const TODAY = '2026-10-20';

test('importing the script makes zero fetches and does not run main', () => {
  assert.equal(fetchesDuringImport, 0);
  // Under `node --test`, argv[1] is this test file, never the script.
  assert.equal(isMain(), false);
});

test('the default fetch in this file is offline, not the production Worker', async () => {
  const before = fetchCalls;
  await assert.rejects(globalThis.fetch(WORKER_URL), /network blocked in tests/);
  assert.equal(fetchCalls, before + 1);
});

test('isMain is true only when argv[1] is the script itself', () => {
  const scriptPath = new URL('../scripts/smoke-worker.mjs', import.meta.url).pathname;
  assert.equal(isMain(scriptPath), true);
  assert.equal(isMain(new URL(import.meta.url).pathname), false);
  assert.equal(isMain(undefined), false);
});

test('the expected origin is the app origin the Worker allows', () => {
  assert.equal(EXPECTED_ORIGIN, 'https://ajaenicke518.github.io');
  assert.equal(EXPECTED_ORIGIN, ALLOWED_ORIGIN);
});

test('there is exactly one phrase per ITEM_TYPE, and every accepted type is a real type', () => {
  const primaries = PHRASES.map((p) => p.type).sort();
  assert.deepEqual(primaries, [...ITEM_TYPES].sort());
  for (const p of PHRASES) {
    assert.ok(p.accept.includes(p.type), `${p.type}: accept must include its own type`);
    for (const t of p.accept) assert.ok(ITEM_TYPES.includes(t), `${p.type}: ${t} is not an ITEM_TYPE`);
    assert.equal(typeof p.text, 'string');
    assert.ok(p.text.length > 0);
  }
});

test('no phrase accepts the coerced fallback "event" unless it IS the event phrase', () => {
  for (const p of PHRASES) {
    if (p.type !== 'event') assert.ok(!p.accept.includes('event'), `${p.type} accepts event`);
  }
});

test('the event phrase pins 14:00 and the idea phrase pins date === today', () => {
  const ev = PHRASES.find((p) => p.type === 'event');
  assert.equal(ev.time, '14:00');
  assert.match(ev.text, /at 2pm/);
  const idea = PHRASES.find((p) => p.type === 'idea');
  assert.equal(idea.dateIsToday, true);
  // The prompt forces needsReview on an idea with any date/time words; the
  // phrase avoids them so it is on the unambiguous side.
  assert.doesNotMatch(idea.text,
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|\d{1,2}(:\d\d)?\s*(am|pm))\b/i);
});

// --- checkResult -------------------------------------------------------------

const phrase = (type) => PHRASES.find((p) => p.type === type);
const item = (over) => ({
  title: 'x', date: '2026-10-21', time: null, endTime: null, type: 'task',
  project: null, subject: null, category: null, notes: null, ...over,
});
const ok = (items, acao = EXPECTED_ORIGIN) => ({
  status: 200, acao, body: { items, needsReview: false },
});

test('checkResult passes a good answer for every phrase', () => {
  for (const p of PHRASES) {
    const it = item({
      type: p.type,
      time: p.time ?? null,
      date: p.dateIsToday ? TODAY : '2026-10-21',
    });
    const r = checkResult(p, ok([it]), TODAY);
    assert.deepEqual(r.failures, [], `${p.type}: ${r.failures.join('; ')}`);
    assert.equal(r.pass, true);
  }
});

test('checkResult fails a type coerced to "event" and says so', () => {
  for (const t of ['task', 'idea', 'due', 'start', 'milestone']) {
    const p = phrase(t);
    const r = checkResult(p, ok([item({ type: 'event', date: TODAY })]), TODAY);
    assert.equal(r.pass, false, t);
    assert.ok(r.failures.some((f) => /coerced/.test(f)), `${t}: ${r.failures}`);
  }
});

test('checkResult fails a type outside the accepted set', () => {
  const r = checkResult(phrase('task'), ok([item({ type: 'idea', date: TODAY })]), TODAY);
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => /type/.test(f)));
});

test('checkResult accepts every member of a boundary set', () => {
  const boundary = PHRASES.filter((p) => p.accept.length > 1);
  assert.ok(boundary.length > 0, 'expected at least one boundary phrase');
  for (const p of boundary) {
    for (const t of p.accept) {
      const r = checkResult(p, ok([item({ type: t, time: p.time ?? null })]), TODAY);
      assert.equal(r.pass, true, `${p.type} accepting ${t}: ${r.failures}`);
    }
  }
});

test('checkResult fails the event phrase without 14:00', () => {
  for (const time of [null, '02:00', '14:30']) {
    const r = checkResult(phrase('event'), ok([item({ type: 'event', time })]), TODAY);
    assert.equal(r.pass, false, String(time));
    assert.ok(r.failures.some((f) => /time/.test(f)));
  }
});

test('checkResult fails the idea phrase whose date is not today', () => {
  const r = checkResult(phrase('idea'), ok([item({ type: 'idea', date: '2026-10-21' })]), TODAY);
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => /date/.test(f)));
});

test('checkResult fails a wrong or missing Access-Control-Allow-Origin', () => {
  const good = item({ type: 'task' });
  for (const acao of [null, '*', 'https://example.com', 'https://ajaenicke518.github.io/']) {
    const r = checkResult(phrase('task'), ok([good], acao), TODAY);
    assert.equal(r.pass, false, String(acao));
    assert.ok(r.failures.some((f) => /Access-Control-Allow-Origin/.test(f)));
  }
});

test('checkResult fails a non-200 status, a non-object body, and anything but one item', () => {
  const p = phrase('task');
  assert.equal(checkResult(p, { status: 502, acao: EXPECTED_ORIGIN, body: { error: 'upstream_error' } }, TODAY).pass, false);
  assert.equal(checkResult(p, { status: 200, acao: EXPECTED_ORIGIN, body: null }, TODAY).pass, false);
  assert.equal(checkResult(p, ok([]), TODAY).pass, false);
  assert.equal(checkResult(p, ok([item({}), item({})]), TODAY).pass, false);
});

test('checkResult fails a request that never got a response', () => {
  const r = checkResult(phrase('task'), { error: 'TypeError: fetch failed' }, TODAY);
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => /fetch failed/.test(f)));
});

// --- runSmoke ------------------------------------------------------------------

function fakeWorker(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const { text } = JSON.parse(init.body);
    const p = PHRASES.find((x) => x.text === text);
    const { status = 200, acao = EXPECTED_ORIGIN, body } = answer(p);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (acao !== null) headers.set('Access-Control-Allow-Origin', acao);
    return new Response(JSON.stringify(body), { status, headers });
  };
  return { calls, fetchImpl };
}
const goodAnswer = (p) => ({
  body: {
    needsReview: false,
    items: [item({ type: p.type, time: p.time ?? null, date: p.dateIsToday ? TODAY : '2026-10-21' })],
  },
});

test('runSmoke POSTs each phrase exactly once to url/ with text and today — no retry', async () => {
  const w = fakeWorker(goodAnswer);
  const results = await runSmoke({ fetchImpl: w.fetchImpl, url: 'https://w.test', today: TODAY });
  assert.equal(w.calls.length, PHRASES.length);
  assert.deepEqual(w.calls.map((c) => JSON.parse(c.init.body).text), PHRASES.map((p) => p.text));
  for (const c of w.calls) {
    assert.equal(c.url, 'https://w.test/');
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(c.init.body).today, TODAY);
  }
  assert.equal(results.length, PHRASES.length);
  assert.ok(results.every((r) => r.pass), JSON.stringify(results));
});

test('runSmoke does not retry a failing phrase and still runs the rest', async () => {
  const w = fakeWorker((p) => (p.type === 'event'
    ? { status: 502, body: { error: 'upstream_error' } }
    : goodAnswer(p)));
  const results = await runSmoke({ fetchImpl: w.fetchImpl, url: 'https://w.test', today: TODAY });
  assert.equal(w.calls.length, PHRASES.length);
  assert.equal(results.filter((r) => !r.pass).length, 1);
  assert.equal(results.find((r) => !r.pass).phrase.type, 'event');
});

test('runSmoke reports a coerced type from the real wire shape', async () => {
  const w = fakeWorker((p) => ({
    body: { needsReview: false, items: [item({ type: 'event', time: '14:00', date: TODAY })] },
  }));
  const results = await runSmoke({ fetchImpl: w.fetchImpl, url: 'https://w.test', today: TODAY });
  const failed = results.filter((r) => !r.pass).map((r) => r.phrase.type).sort();
  assert.deepEqual(failed, ITEM_TYPES.filter((t) => t !== 'event').sort());
});

test('runSmoke reads the response ACAO header (a missing one fails every phrase)', async () => {
  const w = fakeWorker((p) => ({ ...goodAnswer(p), acao: null }));
  const results = await runSmoke({ fetchImpl: w.fetchImpl, url: 'https://w.test', today: TODAY });
  assert.ok(results.every((r) => !r.pass));
});

test('runSmoke records a rejected fetch as a failure and continues', async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; throw new TypeError('fetch failed'); };
  const results = await runSmoke({ fetchImpl, url: 'https://w.test', today: TODAY });
  assert.equal(n, PHRASES.length);
  assert.ok(results.every((r) => !r.pass && r.failures.some((f) => /fetch failed/.test(f))));
});

test('runSmoke records an unparseable body as a failure', async () => {
  const fetchImpl = async () => new Response('<html>1101</html>', {
    status: 200, headers: { 'Access-Control-Allow-Origin': EXPECTED_ORIGIN },
  });
  const results = await runSmoke({ fetchImpl, url: 'https://w.test', today: TODAY });
  assert.ok(results.every((r) => !r.pass));
});

test('runSmoke has no default fetch or url — both must be injected', async () => {
  await assert.rejects(runSmoke({ url: 'https://w.test', today: TODAY }), /fetchImpl/);
  await assert.rejects(runSmoke({ fetchImpl: async () => {}, today: TODAY }), /url/);
  await assert.rejects(runSmoke({ fetchImpl: async () => {}, url: 'https://w.test' }), /today/);
});

// --- formatTable -----------------------------------------------------------------

test('formatTable prints one row per phrase with PASS/FAIL and a summary', () => {
  const results = [
    { phrase: phrase('event'), pass: true, failures: [], got: { type: 'event', time: '14:00', date: '2026-10-21' } },
    { phrase: phrase('task'), pass: false, failures: ['type "event" (coerced?)'], got: { type: 'event' } },
  ];
  const out = formatTable(results);
  const lines = out.split('\n');
  assert.ok(lines.some((l) => /PASS/.test(l) && /event/.test(l)));
  assert.ok(lines.some((l) => /FAIL/.test(l) && /task/.test(l) && /coerced/.test(l)));
  assert.match(out, /1\/2 passed/);
});
