// smartadd.js — the single spot that turns text into items (now via Claude).
import { WORKER_URL } from './config.js';
import { toISO } from './dateparse.js';
import { fetchWithTimeout } from './fetchtimeout.js';

// How long smart add waits for the Worker before giving up (app.js then says
// "Smart add is unavailable — pick a date below and tap Add to add it
// manually."). Its own constant, not fetchtimeout.js's FETCH_TIMEOUT_MS: the
// two budgets guard different things (a calendar download vs. one Claude
// reply) and should be tuned separately. 60 s is a backstop, not a measured
// number — there is no latency data yet, and the Worker's max_tokens of 4096
// allows a long legitimate reply.
export const SMART_ADD_TIMEOUT_MS = 60000;

// Pure: decide whether to add directly or show a preview.
export function decideFlow(result) {
  if (!result.items || result.items.length === 0) return 'empty';
  if (result.items.length === 1 && !result.needsReview) return 'direct';
  return 'preview';
}

// Browser: call the Worker. Sends the user's LOCAL date so relative dates
// resolve in their timezone. Throws Error with a code-ish message on failure:
//   'unreachable' — the request failed, or no complete answer arrived within
//                   SMART_ADD_TIMEOUT_MS (headers and body, end to end);
//   'too_long'    — 413;
//   'server'      — any other non-ok status, or a 200 whose body is not JSON
//                   or not an object with an `items` array.
//
// THE BODY IS ALWAYS READ, even on an error status: fetchWithTimeout disarms
// its deadline only when a body read settles, so throwing straight from the
// status would leave the timer to abort a finished request a minute later.
export async function parseViaWorker(text) {
  let res;
  try {
    res = await fetchWithTimeout(WORKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, today: toISO(new Date()) }),
    }, SMART_ADD_TIMEOUT_MS);
  } catch {
    throw new Error('unreachable');
  }
  if (!res.ok) {
    // Drained, not awaited: the status already decides the error, and a
    // stalled body must not hold the message back. Draining lets
    // fetchWithTimeout disarm once the body settles.
    res.text().catch(() => {});
    throw new Error(res.status === 413 ? 'too_long' : 'server');
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    // By name, not instanceof: WebKit rejects a malformed body with a
    // DOMException named 'SyntaxError', which is no SyntaxError instance.
    throw new Error(err && err.name === 'SyntaxError' ? 'server' : 'unreachable');
  }
  // A 200 that is not { items: [...] } (null, say) would otherwise reach
  // decideFlow, whose TypeError left "Thinking…" up for good; an item that is
  // not an object would surface makeItem's raw TypeError to the user.
  const isRecord = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every(isRecord)) throw new Error('server');
  return body;
}
