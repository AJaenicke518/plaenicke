// GET /version (deploy marker) and the smart-add latency log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { VERSION } from '../src/version.js';

const ALLOWED_ORIGIN = 'https://ajaenicke518.github.io';
const ENV = { ANTHROPIC_API_KEY: 'sk-ant-SECRET-KEY', ADMIN_SECRET: 'admin-SECRET' };

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

const CHANNELS = ['log', 'info', 'warn', 'error', 'debug'];
async function captureLog(fn) {
  const originals = CHANNELS.map((c) => console[c]);
  const lines = [];
  for (const c of CHANNELS) console[c] = (...args) => lines.push(args.join(' '));
  try { return { result: await fn(), lines }; } finally {
    CHANNELS.forEach((c, i) => { console[c] = originals[i]; });
  }
}

function smartAdd(text) {
  return new Request('https://worker.example/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

test('GET /version returns 200 and { version } with CORS, unauthenticated', async () => {
  const res = await worker.fetch(new Request('https://worker.example/version'), {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: VERSION });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert.equal(typeof VERSION, 'string');
  assert.ok(VERSION.length > 0);
});

test('GET /version never calls fetch, never touches D1, never reveals a secret', async () => {
  let fetchCalls = 0;
  const db = new Proxy({}, { get() { throw new Error('D1 touched'); } });
  const res = await withFetch(async () => { fetchCalls += 1; throw new Error('no network'); },
    () => worker.fetch(new Request('https://worker.example/version'), { ...ENV, DB: db }));
  assert.equal(fetchCalls, 0);
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['version']);
  for (const s of [ENV.ANTHROPIC_API_KEY, ENV.ADMIN_SECRET]) assert.ok(!raw.includes(s));
});

test('POST /version is not routed to smart-add: no Claude call', async () => {
  let fetchCalls = 0;
  const res = await withFetch(async () => { fetchCalls += 1; throw new Error('no network'); },
    () => worker.fetch(new Request('https://worker.example/version', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'dentist tomorrow' }),
    }), ENV));
  assert.equal(fetchCalls, 0);
  assert.equal(res.status, 405);
});

test('smart-add logs Claude latency in ms and status — and no user text, reply or key', async () => {
  const userText = 'secret dentist appointment with Dr Zorblax tomorrow';
  const replyMarker = 'REPLY-MARKER-9137';
  const stub = async () => new Response(JSON.stringify({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ needsReview: false, note: replyMarker, items: [] }) }],
  }), { status: 200 });
  const delayed = async () => { await new Promise((r) => setTimeout(r, 40)); return stub(); };
  const { lines } = await captureLog(() => withFetch(delayed, () => worker.fetch(smartAdd(userText), ENV)));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^smart-add claude_ms=\d+ status=200$/);
  const ms = Number(/claude_ms=(\d+)/.exec(lines[0])[1]);
  assert.ok(ms >= 30 && ms < 5000, `claude_ms ${ms} is not a duration`);
  const all = lines.join('\n');
  for (const frag of ['Zorblax', 'dentist', replyMarker, ENV.ANTHROPIC_API_KEY]) {
    assert.ok(!all.includes(frag), `log leaked ${frag}`);
  }
});

test('smart-add logs the upstream status on an error reply, and unreachable on a throw', async () => {
  const bad = await captureLog(() => withFetch(async () => new Response('UPSTREAM-BODY-4410', { status: 529 }),
    () => worker.fetch(smartAdd('call mom'), ENV)));
  assert.equal(bad.lines.length, 1);
  assert.match(bad.lines[0], /^smart-add claude_ms=\d+ status=529$/);
  assert.ok(!bad.lines.join('\n').includes('UPSTREAM-BODY-4410') && !bad.lines.join('\n').includes('call mom'));
  const down = await captureLog(() => withFetch(async () => { throw new Error('call mom down'); },
    () => worker.fetch(smartAdd('call mom'), ENV)));
  assert.match(down.lines[0], /^smart-add claude_ms=\d+ status=unreachable$/);
  assert.ok(!down.lines.join('\n').includes('call mom'));
});

test('smart-add logs nothing when it never reaches Claude (empty text)', async () => {
  const { lines } = await captureLog(() => worker.fetch(smartAdd('   '), ENV));
  assert.deepEqual(lines, []);
});

test('an unparseable 200 body from Claude logs no fragment of that body', async () => {
  const { result: res, lines } = await captureLog(() => withFetch(
    async () => new Response('REPLY secret text', { status: 200 }),
    () => worker.fetch(smartAdd('call mom'), ENV)));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'unparseable_model_output' });
  assert.ok(!lines.join('\n').includes('secret'), lines.join('\n'));
  assert.ok(!lines.join('\n').includes('REPLY'));
});
