// smoke-worker.mjs — classify a fixed phrase set through the DEPLOYED Worker.
//
//   npm run smoke:worker
//
// EVERY RUN SPENDS ANTHROPIC CREDITS: one smart-add call (one Claude request)
// per phrase below. Run it on purpose, after a Worker deploy — never as part of
// `npm test`.
//
// IT MUST NEVER RUN UNDER `npm test`. `npm test` is `node --test` with no
// arguments, which recurses and runs every file matching its default patterns
// (`*.test.*`, `*-test.*`, `*_test.*`, `test-*.*`, `test.*`, anything under a
// `test/` directory). This file is outside all of them today. Renaming it to
// `test-*.mjs` (or any of those shapes) or moving it under `test/` would make
// every `npm test` call production and spend credits. `node --test
// scripts/smoke-worker.mjs` named directly would too, since argv[1] in that
// child IS the script — so isMain() is false whenever NODE_TEST_CONTEXT is set
// (node --test sets it in every child it runs). tests/smoke-worker.test.js
// imports it with an offline fetch installed and asserts the import makes zero
// fetches; keep everything that touches the network inside main().
//
// What it checks, per phrase (each runs ONCE — there is no propagation retry;
// see below):
//   - HTTP 200 and exactly one item back;
//   - the type is in the phrase's accepted set. The set never contains 'event'
//     for a non-event phrase, because normalize.js's clamp COERCES an unknown
//     type to 'event' — V6 shipped with every task and idea coming back as
//     'event', and that is the regression this exists to catch;
//   - the event phrase's time is "14:00" ("at 2pm", the prompt's own example);
//   - the idea phrase is type 'idea' with date === the `today` sent;
//   - the response's Access-Control-Allow-Origin is the app's origin. The
//     Worker does not read the request's Origin on POST /, so none is sent.
//
// No propagation retry: a deploy takes ~20 s to reach the edge, and nothing the
// Worker returns says which version answered, so a retry could only wait, not
// confirm. Wait before running it. (A `GET /version` marker would fix this; it
// needs a Worker deploy — see the punchlist.)
//
// Phrases come from worker/src/prompt.js's own instruction examples, on the
// unambiguous side. A phrase on a real boundary in that text accepts a set.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchWithTimeout } from '../js/fetchtimeout.js';
import { WORKER_URL } from '../js/config.js';
import { toISO } from '../js/dateparse.js';

// The origin the app is served from (GitHub Pages). worker/src/cors.js's
// ALLOWED_ORIGIN must equal it; tests/smoke-worker.test.js pins the two.
export const EXPECTED_ORIGIN = 'https://ajaenicke518.github.io';

// `type` is the ITEM_TYPE the phrase is for; `accept` is what passes.
export const PHRASES = Object.freeze([
  // "event" for a meeting or appointment; "at 2pm" -> "14:00".
  { type: 'event', accept: ['event'], time: '14:00', text: 'dentist appointment tomorrow at 2pm' },
  // "due" for a hard deadline (words like due, submit, deadline).
  { type: 'due', accept: ['due'], text: 'physics paper due Friday' },
  // "start" for begin/start-working reminders. Boundary: it is also something
  // to DO, which the prompt calls "task".
  { type: 'start', accept: ['start', 'task'], text: 'start working on the physics paper Monday' },
  // "milestone" for a draft/checkpoint/partial step. Boundary: a dated draft
  // also reads as a deadline.
  // The prompt also prefers 'task' whenever a note reads either way, and
  // writing a draft is something to DO.
  { type: 'milestone', accept: ['milestone', 'due', 'task'], text: 'first draft of the physics paper Wednesday' },
  // The prompt's own example: "look into housing utilities" ... is a "task".
  { type: 'task', accept: ['task'], text: 'look into housing utilities' },
  // "idea for the app: …". No date or time words, so it is not on the
  // "idea or not" edge the prompt flags with needsReview.
  {
    type: 'idea',
    accept: ['idea'],
    dateIsToday: true,
    text: 'idea for the app: the to-do page could group tasks by project so related errands sit together',
  },
].map(Object.freeze));

// Pure. `response` is { status, acao, body } for a request that got an
// answer, or { error } for one that did not.
export function checkResult(phrase, response, today) {
  const failures = [];
  if ('error' in response) {
    return { pass: false, failures: [`no response: ${response.error}`], got: null };
  }
  const { status, acao, body } = response;
  if (status !== 200) failures.push(`status ${status}${body && body.error ? ` (${body.error})` : ''}`);
  if (acao !== EXPECTED_ORIGIN) {
    failures.push(`Access-Control-Allow-Origin ${JSON.stringify(acao)}, want ${JSON.stringify(EXPECTED_ORIGIN)}`);
  }
  const items = body && typeof body === 'object' && Array.isArray(body.items) ? body.items : null;
  if (!items) {
    failures.push('body has no items array');
    return { pass: false, failures, got: null };
  }
  if (items.length !== 1) {
    failures.push(`${items.length} items, want exactly 1`);
    return { pass: false, failures, got: null };
  }
  const it = items[0];
  const got = { type: it.type, time: it.time, date: it.date };
  if (!phrase.accept.includes(it.type)) {
    const coerced = it.type === 'event' ? ' (coerced to the clamp fallback?)' : '';
    failures.push(`type ${JSON.stringify(it.type)}${coerced}, want ${phrase.accept.join('|')}`);
  }
  if (phrase.time !== undefined && it.time !== phrase.time) {
    failures.push(`time ${JSON.stringify(it.time)}, want ${JSON.stringify(phrase.time)}`);
  }
  if (phrase.dateIsToday && it.date !== today) {
    failures.push(`date ${JSON.stringify(it.date)}, want today ${today}`);
  }
  return { pass: failures.length === 0, failures, got };
}

// Every phrase once, in order, sequentially. No default fetch and no default
// URL: a caller that forgets to inject one gets a throw, not production.
export async function runSmoke({ fetchImpl, url, today, phrases = PHRASES } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('runSmoke: fetchImpl is required');
  if (typeof url !== 'string' || !url) throw new TypeError('runSmoke: url is required');
  if (typeof today !== 'string' || !today) throw new TypeError('runSmoke: today is required');
  const endpoint = new URL('/', url).href;
  const results = [];
  for (const phrase of phrases) {
    let response;
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: phrase.text, today }),
      });
      const raw = await res.text();
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      response = { status: res.status, acao: res.headers.get('Access-Control-Allow-Origin'), body };
    } catch (err) {
      response = { error: `${err?.name}: ${err?.message}` };
    }
    results.push({ phrase, ...checkResult(phrase, response, today) });
  }
  return results;
}

export function formatTable(results) {
  const rows = results.map((r) => [
    r.pass ? 'PASS' : 'FAIL',
    r.phrase.type,
    r.got ? `${r.got.type ?? '-'} ${r.got.time ?? '-'} ${r.got.date ?? '-'}` : '-',
    r.pass ? '' : r.failures.join('; '),
  ]);
  const head = ['RESULT', 'PHRASE', 'GOT (type time date)', 'WHY'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const passed = results.filter((r) => r.pass).length;
  return [line(head), ...rows.map(line), '', `${passed}/${results.length} passed`].join('\n');
}

// Compared by real path: through a symlink, import.meta.url is the target
// while argv[1] is the link, and a plain comparison exited 0 having run
// nothing. Never true inside a node --test child (NODE_TEST_CONTEXT set).
// Never true inside the test runner: node --test children carry
// NODE_TEST_CONTEXT, and --experimental-test-isolation=none runs files inside
// the --test process itself, where only its own flags give it away.
export function isMain(argv1 = process.argv[1], execArgv = process.execArgv) {
  if (process.env.NODE_TEST_CONTEXT) return false;
  if (execArgv.some((a) => a === '--test' || a.startsWith('--test-') || a.startsWith('--experimental-test'))) return false;
  if (!argv1) return false;
  let real;
  try { real = realpathSync(argv1); } catch { return false; }
  return import.meta.url === pathToFileURL(real).href;
}

// A real run's fetch: the shared deadline, so one stalled request cannot hang
// the script until Ctrl-C.
export const MAIN_FETCH = fetchWithTimeout;

async function main() {
  const today = toISO(new Date());
  console.log(`smoke:worker -> ${WORKER_URL} (today ${today}; ${PHRASES.length} Claude calls)`);
  const results = await runSmoke({ fetchImpl: MAIN_FETCH, url: WORKER_URL, today });
  console.log(formatTable(results));
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
}

if (isMain()) await main();
