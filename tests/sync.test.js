import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { syncOnce, previewRemote, MAX_ATTEMPTS } from '../js/sync.js';
import { linkWithCode, clearAdoptionPending } from '../js/auth.js';
import { encryptBlob, decryptBlob, generateEncKey, bytesToBase64url } from '../js/crypto.js';
import { SCHEMA_VERSION, toWire, merge } from '../js/merge.js';
import { saveItems, loadItems, loadFeeds, loadSyncState, saveSyncState } from '../js/storage.js';

const NOW = () => new Date('2026-08-02T12:00:00.000Z');
const item = (id, updatedAt) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });
const echo = (s) => s;   // simplest applyState: writes nothing, returns what it got

// A fake Worker holding one row, enforcing the real compare-and-swap rule.
// It records the FULL request, body included — a fake that drops the body
// makes any "the key never goes on the wire" assertion vacuous.
function fakeServer({ version = 0, blob = '' } = {}) {
  const row = { version, blob };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, headers: opts.headers || {}, body: opts.body });
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ ...row }) };
    const body = JSON.parse(opts.body);
    if (body.version !== row.version) {
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', ...row }) };
    }
    row.version += 1;
    row.blob = body.blob;
    return { ok: true, status: 200, json: async () => ({ version: row.version }) };
  };
  return { fetchImpl, row, calls };
}

async function linked() {
  installFakeLocalStorage();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  clearAdoptionPending();   // most tests exercise the steady state
  return link;
}

test('sync.js never imports a storage writer — the single-writer rule, enforced', () => {
  const src = readFileSync(new URL('../js/sync.js', import.meta.url), 'utf8');
  for (const forbidden of ['saveItems', 'saveFeeds', 'saveFeedCache']) {
    assert.ok(!src.includes(forbidden),
      `sync.js references ${forbidden}; a second writer silently reverts pulled records (spec 5.5)`);
  }
});

test('an unlinked device does not sync and does not call the network', async () => {
  installFakeLocalStorage();
  let called = false;
  const res = await syncOnce({ fetchImpl: async () => { called = true; }, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'skipped');
  assert.equal(called, false);
});

// DA-C2
test('a freshly linked device refuses to sync until adoption is resolved', async () => {
  installFakeLocalStorage();
  await linkWithCode(bytesToBase64url(generateEncKey()));
  let called = false;
  const res = await syncOnce({ fetchImpl: async () => { called = true; }, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'adoption-required');
  assert.equal(called, false, 'nothing may be pulled, applied or pushed before the user chooses');
});

test('previewRemote pulls without applying or pushing', async () => {
  const link = await linked();
  const server = fakeServer({ version: 3, blob: await encryptBlob(link.encKey, state({ items: [item('r', '2026-08-01T00:00:00.000Z')] })) });
  let applied = false;
  const res = await previewRemote({ fetchImpl: server.fetchImpl, apiBase: 'https://w.example', applyState: () => { applied = true; } });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.state.items.map(i => i.id), ['r']);
  assert.equal(applied, false);
  assert.equal(server.row.version, 3);
  assert.ok(server.calls.every(c => c.method === 'GET'));
});

test('an empty server accepts the local state as the first push', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'ok');
  assert.equal(server.row.version, 1);
  assert.deepEqual((await decryptBlob(link.encKey, server.row.blob)).items.map(i => i.id), ['a']);
});

// DA-M4: the fake records the body, so this assertion can actually fail.
test('the Bearer token is sent and the encryption key is NEVER on the wire', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.ok(server.calls.some(c => c.method === 'PUT'), 'the test must actually exercise a push');
  assert.ok(server.calls.every(c => c.headers.authorization === `Bearer ${link.authToken}`));
  const wire = JSON.stringify(server.calls);
  assert.ok(!wire.includes(bytesToBase64url(link.encKey)), 'encKey must never be transmitted');
  assert.ok(!wire.includes('t-a'), 'plaintext must never be transmitted');
});

test('remote records are merged and handed to applyState, not written directly', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 3, blob: await encryptBlob(link.encKey, state({ items: [item('remote', '2026-08-01T00:00:00.000Z')] })) });
  let applied = null;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; } });
  assert.equal(res.status, 'ok');
  assert.deepEqual(applied.items.map(i => i.id).sort(), ['local', 'remote']);
});

// DA-C1: the single most important test in this file.
test('an ordinary sync does NOT dedupe items sharing title, date and time', async () => {
  const link = await linked();
  saveItems([{ id: 'l', title: 'Call mom', date: '2026-08-05', time: null, updatedAt: '2026-08-01T00:00:00.000Z' }]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state({
    items: [{ id: 'r', title: 'Call mom', date: '2026-08-05', time: null, updatedAt: '2026-08-01T00:00:00.000Z' }] })) });
  let applied = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; } });
  assert.equal(applied.items.length, 2, 'ordinary sync must never collapse distinct records');
});

test('applyState runs BEFORE the version is advanced', async () => {
  const link = await linked();
  const server = fakeServer({ version: 5, blob: await encryptBlob(link.encKey, state()) });
  let versionAtApply = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { versionAtApply = loadSyncState().version; return s; } });
  assert.equal(versionAtApply, 0);
  assert.ok(loadSyncState().version >= 5);
});

test('a failure inside applyState does not advance the version and does not push', async () => {
  const link = await linked();
  const server = fakeServer({ version: 5, blob: await encryptBlob(link.encKey, state({ items: [item('r', '2026-08-01T00:00:00.000Z')] })) });
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: () => { throw new Error('quota'); } });
  assert.equal(res.status, 'error');
  assert.equal(loadSyncState().version, 0);
  assert.equal(server.row.version, 5);
});

// DA-C4: the retry must re-read local state, not replay a pre-PUT snapshot.
test('a record created DURING the retry window survives', async () => {
  const link = await linked();
  saveItems([item('mine', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z')] })) });
  let raced = false;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT' && !raced) {
      raced = true;
      // The user adds an item while our first PUT is in flight...
      saveItems([...JSON.parse(localStorage.getItem('plaenicke.items')), item('during', '2026-08-02T00:00:00.000Z')]);
      // ...and another device lands a write first, forcing our retry.
      server.row.version += 1;
      server.row.blob = await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z'), item('third', '2026-08-01T00:00:00.000Z')] }));
    }
    return server.fetchImpl(url, opts);
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'ok');
  const final = await decryptBlob(link.encKey, server.row.blob);
  assert.deepEqual(final.items.map(i => i.id).sort(), ['during', 'mine', 'theirs', 'third'],
    'an item added during the retry window must not be destroyed');
});

test('a server that 409s forever gives up after MAX_ATTEMPTS instead of spinning', async () => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  let puts = 0;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') {
      puts += 1;
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', version: 99, blob: '' }) };
    }
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) };
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'conflict');
  assert.equal(puts, MAX_ATTEMPTS);
});

test('an undecryptable blob halts and applies NOTHING', async () => {
  await linked();
  const server = fakeServer({ version: 2, blob: await encryptBlob(generateEncKey(), state({ items: [item('x', '2026-08-01T00:00:00.000Z')] })) });
  let applied = false;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => { applied = true; } });
  assert.equal(res.status, 'undecryptable');
  assert.equal(applied, false, 'partially applying an unreadable blob would propagate phantom deletions');
  assert.equal(server.row.version, 2);
});

test('an unknown schemaVersion halts and applies nothing', async () => {
  const link = await linked();
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, { ...state(), schemaVersion: 99 }) });
  let applied = false;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: () => { applied = true; } });
  assert.equal(res.status, 'undecryptable');
  assert.equal(applied, false);
});

test('a 401 reports unauthorized and never clears local data', async () => {
  await linked();
  saveItems([item('keep', '2026-08-01T00:00:00.000Z')]);
  const res = await syncOnce({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'unauthorized');
  assert.equal(JSON.parse(localStorage.getItem('plaenicke.items')).length, 1);
});

test('a network failure reports offline and records the error without throwing', async () => {
  await linked();
  const res = await syncOnce({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'offline');
  assert.equal(typeof loadSyncState().lastError, 'string');
});

test('syncing when nothing changed does not push', async () => {
  const link = await linked();
  const server = fakeServer({ version: 4, blob: await encryptBlob(link.encKey, toWire(state())) });
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(server.row.version, 4, 'an unchanged state must not burn a version');
  assert.equal(loadSyncState().version, 4);
});

// DA-C3: two devices differing only in per-device fields and array order must
// reach a fixed point, not push at each other forever.
test('a device whose only difference is colour, hidden and array order does not push', async () => {
  const link = await linked();
  const remote = toWire(state({
    feeds: [{ id: 'f1', url: 'https://cal.example/a.ics', name: 'A', updatedAt: '2026-08-01T00:00:00.000Z' },
            { id: 'f2', url: 'https://cal.example/b.ics', name: 'B', updatedAt: '2026-08-01T00:00:00.000Z' }],
  }));
  const server = fakeServer({ version: 9, blob: await encryptBlob(link.encKey, remote) });
  // Local holds the same feeds in the other order with its own colours.
  localStorage.setItem('plaenicke.feeds', JSON.stringify([
    { id: 'f2', url: 'https://cal.example/b.ics', name: 'B', color: '#222', hidden: true, updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'f1', url: 'https://cal.example/a.ics', name: 'A', color: '#111', hidden: false, updatedAt: '2026-08-01T00:00:00.000Z' },
  ]));
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.pushed, false, 'per-device fields and array order must not count as a change');
  assert.equal(server.row.version, 9);
});

test('a successful sync records lastSyncedAt and clears lastError', async () => {
  const link = await linked();
  saveSyncState({ ...loadSyncState(), lastError: 'previous failure' });
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, toWire(state())) });
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(loadSyncState().lastError, null);
  assert.equal(loadSyncState().lastSyncedAt, NOW().toISOString());
});

test('adopt-replace discards local state instead of merging it', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({ items: [item('remote', '2026-08-01T00:00:00.000Z')] })) });
  let applied = null;
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; }, adoptChoice: 'adopt-replace' });
  assert.deepEqual(applied.items.map(i => i.id), ['remote']);
});

test('adopt-merge dedupes, and clears the adoption gate on success', async () => {
  installFakeLocalStorage();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  saveItems([{ id: 'l', title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: '2026-08-01T00:00:00.000Z' }]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({
    items: [{ id: 'r', title: 'Dentist', date: '2026-08-05', time: '09:00', updatedAt: '2026-08-01T00:00:00.000Z' }] })) });
  let applied = null;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; }, adoptChoice: 'adopt-merge' });
  assert.equal(res.status, 'ok');
  assert.equal(applied.items.length, 1, 'linking must not double every record');
  assert.equal(loadSyncState().adoptionPending, false, 'a completed adoption lifts the gate');
});

test('a failed adoption leaves the gate up so the user is asked again', async () => {
  installFakeLocalStorage();
  await linkWithCode(bytesToBase64url(generateEncKey()));
  const res = await syncOnce({ fetchImpl: async () => { throw new TypeError('offline'); },
    now: NOW, apiBase: 'https://w.example', applyState: echo, adoptChoice: 'adopt-merge' });
  assert.equal(res.status, 'offline');
  assert.equal(loadSyncState().adoptionPending, true);
});

// applyState re-merges against live storage, so what lands may differ from
// what was handed in. The push must send what LANDED.
test('the pushed blob is what applyState returned, not what it was given', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => ({ ...s, items: [...s.items, item('added-by-apply', '2026-08-03T00:00:00.000Z')] }) });
  const pushed = await decryptBlob(link.encKey, server.row.blob);
  assert.ok(pushed.items.some(i => i.id === 'added-by-apply'));
});

// --- Second-pass review findings ---

// Finding 1: fetch() resolves as soon as headers arrive. A connection dropped
// mid-body, or a captive portal answering with a 200 HTML page, throws out of
// res.json() — not out of the fetchImpl call — and that must still report
// 'offline', not 'undecryptable'. Reporting 'undecryptable' here is worse
// than the original bug: the linking flow would tell a merely-offline user
// their data cannot be decrypted, inviting a needless re-link.
test('a GET response whose body cannot be read reports offline, not undecryptable', async () => {
  await linked();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'offline');
});

test('previewRemote reports offline, not undecryptable, when the GET body cannot be read', async () => {
  await linked();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });
  const res = await previewRemote({ fetchImpl, apiBase: 'https://w.example' });
  assert.equal(res.status, 'offline');
});

// Finding 2: a body-read failure on the PUT response must resolve syncOnce to
// a status, never reject its promise. Task 7's runSync only logs a
// rejection's err.name, so a rejected syncOnce would still leave the status
// line reading "last synced" successfully.
test('a PUT 200 response whose confirmation body cannot be read reports offline instead of rejecting', async () => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') {
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } };
    }
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) };
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'offline');
});

test('a 409 response whose conflict body cannot be read reports offline instead of rejecting', async () => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') {
      return { ok: false, status: 409, json: async () => { throw new SyntaxError('bad json'); } };
    }
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) };
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.equal(res.status, 'offline');
});

// Finding 3: the retry's decrypt and its call into applyState are different
// failure classes. An applyState that throws after a successful decrypt is a
// LOCAL failure (quota, a corrupt local record) — the remote blob was read
// fine — and must not be reported as if the remote were unreadable.
test('an applyState failure during the retry reports error, not undecryptable', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z')] })) });
  let calls = 0;
  const applyState = (s) => {
    calls += 1;
    if (calls === 1) return s;   // the initial apply succeeds, so a push is attempted
    throw new Error('quota');    // the retry's own apply fails locally
  };
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') {
      // Force a conflict on the very first PUT attempt.
      server.row.version += 1;
      server.row.blob = await encryptBlob(link.encKey, state({
        items: [item('theirs', '2026-08-01T00:00:00.000Z'), item('other', '2026-08-01T00:00:00.000Z')] }));
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', version: server.row.version, blob: server.row.blob }) };
    }
    return server.fetchImpl(url, opts);
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState });
  assert.equal(res.status, 'error', 'a local apply failure is not the same as an unreadable remote blob');
});

// Finding 4: `adopt-replace` must produce a state that a REAL applyState —
// which re-merges against live storage before writing (Task 7) — does not
// union local content back into. `echo`, used everywhere else in this file,
// cannot see this bug: echo writes nothing, so `toWire(merged) ===
// toWire(remote)` trivially and the push loop is never entered. These two
// tests use an applyState that behaves like the real one instead.
function fakeApplySyncedState(state, opts = {}) {
  const live = { schemaVersion: SCHEMA_VERSION, items: loadItems(), feeds: loadFeeds(), tombstones: [] };
  const written = opts.replace ? state : merge(live, state, new Date());
  saveItems(written.items);
  return written;
}

test('adopt-replace discards local records even when applyState re-merges against live storage, like Task 7 does', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({ items: [item('remote', '2026-08-01T00:00:00.000Z')] })) });
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: fakeApplySyncedState, adoptChoice: 'adopt-replace' });
  assert.equal(res.status, 'ok');
  assert.equal(res.pushed, false, 'a faithful replace already matches the remote it discarded local for — nothing needs pushing');
  const written = JSON.parse(localStorage.getItem('plaenicke.items'));
  assert.deepEqual(written.map(i => i.id), ['remote'], 'the record the user chose to discard must not survive a real re-merging applyState');
});

// Isolates the retry's OWN re-merge from the main path's fix: an item with an
// unparseable date is dropped by the simulated write path (mirroring how
// smartadd.js already drops items missing a valid ISO date elsewhere in this
// app), so the first apply legitimately differs from what was pulled and a
// push — followed by a conflict — becomes unavoidable even under a
// byte-faithful replace, which otherwise never has anything to push.
function fakeApplySyncedStateValidating(state, opts = {}) {
  const cleaned = { ...state, items: state.items.filter(i => typeof i.date === 'string') };
  const live = { schemaVersion: SCHEMA_VERSION, items: loadItems(), feeds: loadFeeds(), tombstones: [] };
  const written = opts.replace ? cleaned : merge(live, cleaned, new Date());
  saveItems(written.items);
  return written;
}

test('adopt-replace that hits a 409 mid-retry still replaces with the new server state, not a merge', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({
    items: [item('remote', '2026-08-01T00:00:00.000Z'), { id: 'bad', title: 'Bad', date: null, time: null, updatedAt: '2026-08-01T00:00:00.000Z' }],
  })) });
  let forced = false;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT' && !forced) {
      forced = true;
      server.row.version += 1;
      server.row.blob = await encryptBlob(link.encKey, state({ items: [item('remote2', '2026-08-01T00:00:00.000Z')] }));
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', version: server.row.version, blob: server.row.blob }) };
    }
    return server.fetchImpl(url, opts);
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: fakeApplySyncedStateValidating, adoptChoice: 'adopt-replace' });
  assert.equal(res.status, 'ok');
  const pushed = await decryptBlob(link.encKey, server.row.blob);
  assert.deepEqual(pushed.items.map(i => i.id), ['remote2'],
    'a 409 mid-replace must not silently convert into a merge that unions in what the previous apply already wrote locally');
});
