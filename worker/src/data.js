// data.js — the sync store. One row, one opaque blob, updated by
// compare-and-swap.
//
// The server never decrypts or parses `blob`; it is ciphertext produced by the
// client. It therefore also never appears in an error message or a log — feed
// URLs are capability tokens and live inside it.
//
// Compare-and-swap rather than read-modify-write because D1 has no interactive
// transactions: the UPDATE below is a single atomic statement, so two devices
// writing concurrently cannot both win.
import { json } from './cors.js';

// A BYTE cap, not a character cap: D1 has a 2 MB row limit, and one CJK
// character is 3 UTF-8 bytes, so measuring `.length` (UTF-16 code units) would
// let a 3 MB blob through to an unhandled D1 rejection instead of a clean 413.
export const MAX_BLOB_BYTES = 1_000_000;

export async function handleGetData(env) {
  const row = await env.DB.prepare('SELECT version, blob FROM data WHERE id = 1').first();
  if (!row) return json({ error: 'not_initialised' }, 500);
  return json({ version: row.version, blob: row.blob });
}

export async function handlePutData(request, env, now) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const version = payload && Number.isInteger(payload.version) ? payload.version : null;
  const blob = payload && typeof payload.blob === 'string' ? payload.blob : null;
  if (version === null || version < 0 || blob === null) return json({ error: 'bad_request' }, 400);
  if (new TextEncoder().encode(blob).length > MAX_BLOB_BYTES) {
    return json({ error: 'blob_too_large', max: MAX_BLOB_BYTES }, 413);
  }

  const res = await env.DB.prepare(
    'UPDATE data SET blob = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?',
  ).bind(blob, now, version).run();

  // Written to fail CLOSED: anything other than a positive `changes` count —
  // undefined, null, a string — is treated as "the write did not land". No
  // local test can cover that, because the test double fabricates `meta`; a
  // false 200 here would make the client advance its version pointer over a
  // write that never happened, which is the exact loss this design prevents.
  if (!(res.meta?.changes > 0)) {
    // Someone else wrote first. Hand back current state so the client can
    // merge and retry rather than guessing.
    const cur = await env.DB.prepare('SELECT version, blob FROM data WHERE id = 1').first();
    if (!cur) return json({ error: 'not_initialised' }, 500);
    return json({ error: 'version_conflict', version: cur.version, blob: cur.blob }, 409);
  }

  return json({ version: version + 1 });
}
