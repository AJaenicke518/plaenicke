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
  // The network call, the body read, and the decrypt/schema check below must
  // all fail distinguishably: a dropped connection (offline) is not the same
  // failure as a decrypt that throws (undecryptable), and the caller reports
  // each differently. fetch() resolves as soon as headers arrive, so a
  // connection dropped mid-body — or a captive portal returning a 200 HTML
  // page — throws out of res.json(), not out of the fetchImpl call; that read
  // gets its own networkError tag for the same reason the call above does.
  let res;
  try {
    res = await fetchImpl(`${apiBase}/data`, { headers: { authorization: `Bearer ${link.authToken}` } });
  } catch (err) {
    return { networkError: err };
  }
  if (res.status === 401) return { unauthorized: true };
  if (!res.ok) return { failed: res.status };
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { networkError: err };
  }
  const { version, blob } = body;
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
  // adoptChoice is one of exactly three values, and only the linking flow
  // (js/linkui.js) ever sets it:
  //   'adopt-bootstrap' — an empty account, or an empty device. Adopt as-is.
  //   'adopt-merge'     — union both sides AND dedupe. The only dedupe site.
  //   'adopt-replace'   — discard local, take the account.
  // The four tests below are deliberately written against those exact values:
  // isReplace is `=== 'adopt-replace'`, the gate check is `!adoptChoice`, the
  // dedupe is `=== 'adopt-merge'`, and the clear is `if (adoptChoice)`.
  // Relaxing the dedupe to `!== 'adopt-replace'` would silently dedupe the
  // bootstrap path — collapsing two legitimately distinct same-title/date/
  // time records and pushing a tombstone for the loser to every device
  // (DA-C1). tests/sync.test.js pins that.
  const { fetchImpl, now, apiBase, applyState, adoptChoice = null, expectVersion = null } = deps;

  // HAS THIS DEVICE ALREADY BEEN CHANGED? applyState runs BEFORE the push loop
  // (spec 7: apply first, advance the cursor second), so every status returned
  // from that point on describes a device whose local write has already
  // landed. A Wi-Fi drop between the GET and the PUT reaches all of them, and
  // on adopt-replace the local wipe is complete and irreversible by then —
  // applySyncedState has already written items, feeds and tombstones through
  // their owners. The caller is the only thing that can tell the user which of
  // the two happened, and it cannot infer it from the status: 'offline' means
  // opposite things either side of that line. So say it.
  //
  // (Deliberately worded without naming storage.js's writer functions: the
  // single-writer rule above is enforced by a substring scan of this file.)
  let applied = false;
  const done = (status, extra) => ({ status, applied, ...extra });

  const link = getLink();
  if (!link) return done('skipped');
  // Replace is a LOCAL discard, not a tombstone: the user explicitly chose to
  // drop local data, so nothing here should re-merge it back in, and nothing
  // on any other device should ever see it deleted (spec 5.7).
  const isReplace = adoptChoice === 'adopt-replace';

  // A freshly linked device must not pull-merge-push before the user has been
  // offered Merge / Replace / Cancel. Only the linking flow passes adoptChoice
  // (spec 5.7 — never union silently).
  if (isAdoptionPending() && !adoptChoice) return done('adoption-required');

  await resetSyncStateIfDeviceChanged(link.authToken);
  if (isAdoptionPending() && !adoptChoice) return done('adoption-required');

  let pulled;
  try {
    pulled = await fetchRemote({ fetchImpl, apiBase, link });
  } catch (err) {
    // Undecryptable or unparseable. Apply NOTHING: a record silently dropped
    // by a deserializer looks like a local deletion and would propagate a
    // tombstone to every device (spec 6.6).
    record({ lastError: err.name || 'DecryptError' });
    return done('undecryptable');
  }
  if (pulled.networkError) { record({ lastError: 'offline' }); return done('offline'); }
  if (pulled.unauthorized) { record({ lastError: 'unauthorized' }); return done('unauthorized'); }
  if (pulled.failed) { record({ lastError: `http_${pulled.failed}` }); return done('error'); }

  // The account can move between the linking UI's previewRemote and this
  // call. A user who chose "Replace this device" against data they SAW would
  // otherwise get a silent full local wipe with no re-confirmation if the
  // account emptied in between — and nothing in here can tell, because the
  // merge is applied against THIS pull. Re-previewing from linkui.js narrows
  // that window but cannot close it. So the caller pins the version it
  // decided against, and a mismatch applies NOTHING, pushes NOTHING, advances
  // no cursor and leaves the gate raised: the decision goes back to the user
  // (DA-I5). Deliberately no record() — nothing failed.
  if (expectVersion != null && pulled.version !== expectVersion) {
    return done('changed', { version: pulled.version });
  }

  let version = pulled.version;
  let remote = pulled.state || emptyState();
  let merged;
  let pushed;
  try {
    // Replace still runs through merge(), against an EMPTY local side rather
    // than skipping merge entirely: local is still fully discarded (nothing
    // from `local` can survive a union with nothing), but every remote feed
    // still passes through pickFeed. Handing applyState raw wire-form feeds
    // instead — as a bare `merged = remote` would — strips color/hidden
    // entirely (toWire already removed them before this blob was ever
    // pushed), and storage.js's deserializeFeeds drops any feed whose color
    // is not a string. undefined is not null, so that silently destroys
    // every subscription on this device's next page load.
    merged = isReplace ? merge(emptyState(), remote, now()) : merge(localState(), remote, now());
    // Dedupe runs ONLY here, on an explicit adoption. On an ordinary sync it
    // would collapse any two records sharing a title, date and time — silent,
    // permanent, cross-device deletion.
    if (adoptChoice === 'adopt-merge') merged = dedupeState(merged, now());

    // Apply BEFORE advancing the cursor, and push what applyState actually
    // wrote: it re-merges against live storage, so the two can differ. On
    // adopt-replace the owner must NOT re-merge — the user chose to discard
    // local data, and re-merging would union it straight back in and then
    // push it to the account being joined.
    merged = applyState(merged, { replace: isReplace }) || merged;
    // From here the local write HAS happened: spec 7 applies before it
    // advances the cursor, so everything below reports a device that has
    // already changed.
    applied = true;
    // toWire can throw on a structurally incomplete state — e.g. applyState
    // returning `{schemaVersion}` with no items/feeds/tombstones. That is
    // the SAME failure class as applyState throwing directly, and must
    // resolve to the same status, not reject syncOnce's promise.
    pushed = JSON.stringify(toWire(merged)) !== JSON.stringify(toWire(remote));
  } catch (err) {
    record({ lastError: err.name || 'ApplyError' });
    return done('error');
  }

  if (!pushed) {
    record({ version, lastSyncedAt: now().toISOString(), lastError: null });
    if (adoptChoice) clearAdoptionPending();
    return done('ok', { pushed: false });
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Encrypt before the network try: a local crypto failure is a permanent
    // condition, not a transient network one, and must not be reported as
    // 'offline' — that would present an unpushable device as merely offline.
    let blob;
    try {
      blob = await encryptBlob(link.encKey, toWire(merged));
    } catch (err) {
      record({ lastError: err.name || 'EncryptError' });
      return done('error');
    }
    let res;
    try {
      res = await fetchImpl(`${apiBase}/data`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${link.authToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version, blob }),
      });
    } catch {
      record({ lastError: 'offline' });
      return done('offline');
    }
    if (res.status === 401) { record({ lastError: 'unauthorized' }); return done('unauthorized'); }
    if (res.ok) {
      let body;
      try {
        body = await res.json();
      } catch {
        // The write landed server-side, but reading the confirmation body
        // failed. Report offline rather than reject syncOnce's promise —
        // the caller (Task 7's runSync) treats a resolved status as the
        // contract, not a thrown error it happens to catch.
        record({ lastError: 'offline' });
        return done('offline');
      }
      record({ version: body.version, lastSyncedAt: now().toISOString(), lastError: null });
      if (adoptChoice) clearAdoptionPending();
      return done('ok', { pushed: true });
    }
    if (res.status !== 409) { record({ lastError: `http_${res.status}` }); return done('error'); }

    let conflict;
    try {
      conflict = await res.json();
    } catch {
      record({ lastError: 'offline' });
      return done('offline');
    }
    version = conflict.version;

    // Someone wrote first. Re-merge against LIVE local state, not the snapshot
    // from before the PUT: the round trip is long enough for the user to have
    // added or deleted, and replaying the snapshot would destroy that — for a
    // feed, destroying a URL nothing on screen can restore.
    try {
      remote = conflict.blob ? await decryptBlob(link.encKey, conflict.blob) : emptyState();
    } catch (err) {
      record({ lastError: err.name || 'DecryptError' });
      return done('undecryptable');
    }
    try {
      // Replace still means replace after a conflict: adopt the NEW server
      // state, do not quietly convert the user's choice into a merge. Still
      // through merge() against an empty local side — see the main path for
      // why a bare `merged = remote` here would strip every feed's color.
      merged = isReplace ? merge(emptyState(), remote, now()) : merge(localState(), remote, now());
      // No `applied = true` here: this loop is only entered when `pushed` is
      // true, which is computed after the main path's apply, so `applied` is
      // already true. A second assignment would be dead — and dead code that
      // no mutant can reach is exactly what makes a flag look tested when it
      // is not.
      merged = applyState(merged, { replace: isReplace }) || merged;
    } catch (err) {
      // A local apply failure is NOT 'undecryptable' — the remote data was
      // read fine. Same condition as the main path gets the same label.
      record({ lastError: err.name || 'ApplyError' });
      return done('error');
    }
  }

  // Bounded, because the Worker's CAS check fails closed: an unexpected
  // meta.changes shape from D1 makes every PUT 409 forever.
  record({ lastError: 'version_conflict' });
  return done('conflict');
}
