// sync.js — pull, merge, apply, push. All effects injected, matching feeds.js.
//
// THE OWNERSHIP RULE (spec 5.5): this module never writes items or feeds. It
// hands merged state to applyState(), and app.js/feeds.js — which own those
// keys — perform the write and RETURN what they actually wrote. app.js holds
// `let items` at module scope for the page's lifetime and writes the whole
// array back; a second writer here means the next addItems() silently reverts
// every pulled record, deterministically. That is why this file imports no
// save function.

import { merge, dedupeState, toWire, emptyState, SCHEMA_VERSION } from './merge.js';
import { encryptBlob, decryptBlob } from './crypto.js';
import { getLink, resetSyncStateIfDeviceChanged, isAdoptionPending, clearAdoptionPending } from './auth.js';
import { loadItems, loadFeeds, loadTombstones, loadSyncState, saveSyncState } from './storage.js';

export const MAX_ATTEMPTS = 3;

function localState() {
  return { schemaVersion: SCHEMA_VERSION, items: loadItems(), feeds: loadFeeds(), tombstones: loadTombstones() };
}

function record(patch) { saveSyncState({ ...loadSyncState(), ...patch }); }

async function fetchRemote({ fetchImpl, apiBase, link }) {
  // The network call and the decrypt/schema check below must fail
  // distinguishably: a thrown fetch (offline) is not the same failure as a
  // decrypt that throws (undecryptable), and the caller reports each
  // differently. Catching only here, and tagging the result rather than
  // rethrowing, keeps that distinction visible one level up.
  let res;
  try {
    res = await fetchImpl(`${apiBase}/data`, { headers: { authorization: `Bearer ${link.authToken}` } });
  } catch (err) {
    return { networkError: err };
  }
  if (res.status === 401) return { unauthorized: true };
  if (!res.ok) return { failed: res.status };
  const { version, blob } = await res.json();
  if (!blob) return { version, state: null };          // empty server — first push
  const state = await decryptBlob(link.encKey, blob);  // throws → caller halts
  if (!state || state.schemaVersion !== SCHEMA_VERSION) throw new Error('Unrecognised schemaVersion');
  return { version, state };
}

// Pull only. Applies nothing and pushes nothing — the linking UI uses this to
// decide whether to offer Merge / Replace / Cancel before any write happens.
export async function previewRemote({ fetchImpl, apiBase }) {
  const link = getLink();
  if (!link) return { status: 'skipped' };
  try {
    const pulled = await fetchRemote({ fetchImpl, apiBase, link });
    if (pulled.networkError) return { status: 'offline' };
    if (pulled.unauthorized) return { status: 'unauthorized' };
    if (pulled.failed) return { status: 'error' };
    return { status: 'ok', version: pulled.version, state: pulled.state };
  } catch {
    return { status: 'undecryptable' };
  }
}

export async function syncOnce(deps) {
  const { fetchImpl, now, apiBase, applyState, adoptChoice = null } = deps;
  const link = getLink();
  if (!link) return { status: 'skipped' };

  // A freshly linked device must not pull-merge-push before the user has been
  // offered Merge / Replace / Cancel. Only the linking flow passes adoptChoice
  // (spec 5.7 — never union silently).
  if (isAdoptionPending() && !adoptChoice) return { status: 'adoption-required' };

  await resetSyncStateIfDeviceChanged(link.authToken);
  if (isAdoptionPending() && !adoptChoice) return { status: 'adoption-required' };

  let pulled;
  try {
    pulled = await fetchRemote({ fetchImpl, apiBase, link });
  } catch (err) {
    // Undecryptable or unparseable. Apply NOTHING: a record silently dropped
    // by a deserializer looks like a local deletion and would propagate a
    // tombstone to every device (spec 6.6).
    record({ lastError: err.name || 'DecryptError' });
    return { status: 'undecryptable' };
  }
  if (pulled.networkError) { record({ lastError: 'offline' }); return { status: 'offline' }; }
  if (pulled.unauthorized) { record({ lastError: 'unauthorized' }); return { status: 'unauthorized' }; }
  if (pulled.failed) { record({ lastError: `http_${pulled.failed}` }); return { status: 'error' }; }

  let version = pulled.version;
  let remote = pulled.state || emptyState();
  let merged;
  try {
    merged = adoptChoice === 'adopt-replace' && pulled.state
      ? remote
      : merge(localState(), remote, now());
    // Dedupe runs ONLY here, on an explicit adoption. On an ordinary sync it
    // would collapse any two records sharing a title, date and time — silent,
    // permanent, cross-device deletion.
    if (adoptChoice === 'adopt-merge') merged = dedupeState(merged, now());

    // Apply BEFORE advancing the cursor, and push what applyState actually
    // wrote: it re-merges against live storage, so the two can differ.
    merged = applyState(merged) || merged;
  } catch (err) {
    record({ lastError: err.name || 'ApplyError' });
    return { status: 'error' };
  }

  if (JSON.stringify(toWire(merged)) === JSON.stringify(toWire(remote))) {
    record({ version, lastSyncedAt: now().toISOString(), lastError: null });
    if (adoptChoice) clearAdoptionPending();
    return { status: 'ok', pushed: false };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}/data`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${link.authToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version, blob: await encryptBlob(link.encKey, toWire(merged)) }),
      });
    } catch {
      record({ lastError: 'offline' });
      return { status: 'offline' };
    }
    if (res.status === 401) { record({ lastError: 'unauthorized' }); return { status: 'unauthorized' }; }
    if (res.ok) {
      const body = await res.json();
      record({ version: body.version, lastSyncedAt: now().toISOString(), lastError: null });
      if (adoptChoice) clearAdoptionPending();
      return { status: 'ok', pushed: true };
    }
    if (res.status !== 409) { record({ lastError: `http_${res.status}` }); return { status: 'error' }; }

    // Someone wrote first. Re-merge against LIVE local state, not the snapshot
    // from before the PUT: the round trip is long enough for the user to have
    // added or deleted, and replaying the snapshot would destroy that — for a
    // feed, destroying a URL nothing on screen can restore.
    const conflict = await res.json();
    version = conflict.version;
    try {
      remote = conflict.blob ? await decryptBlob(link.encKey, conflict.blob) : emptyState();
      merged = merge(localState(), remote, now());
      merged = applyState(merged) || merged;
    } catch (err) {
      record({ lastError: err.name || 'DecryptError' });
      return { status: 'undecryptable' };
    }
  }

  // Bounded, because the Worker's CAS check fails closed: an unexpected
  // meta.changes shape from D1 makes every PUT 409 forever.
  record({ lastError: 'version_conflict' });
  return { status: 'conflict' };
}
