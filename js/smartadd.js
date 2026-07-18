// smartadd.js — the single spot that turns text into items (now via Claude).
import { WORKER_URL, getPassphrase } from './config.js';
import { toISO } from './dateparse.js';

// Pure: decide whether to add directly or show a preview.
export function decideFlow(result) {
  if (!result.items || result.items.length === 0) return 'empty';
  if (result.items.length === 1 && !result.needsReview) return 'direct';
  return 'preview';
}

// Browser: call the Worker. Sends the user's LOCAL date so relative dates
// resolve in their timezone. Throws Error with a code-ish message on failure.
export async function parseViaWorker(text) {
  let res;
  try {
    res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, passphrase: getPassphrase(), today: toISO(new Date()) }),
    });
  } catch {
    throw new Error('unreachable');
  }
  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 413) throw new Error('too_long');
  if (!res.ok) throw new Error('server');
  return res.json();
}
