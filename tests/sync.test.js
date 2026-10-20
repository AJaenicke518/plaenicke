import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { syncOnce as realSyncOnce, previewRemote as realPreviewRemote, MAX_ATTEMPTS } from '../js/sync.js';
import { fetchWithTimeout, FETCH_TIMEOUT_MS } from '../js/fetchtimeout.js';
import { linkWithCode, clearAdoptionPending, tokenHash } from '../js/auth.js';
import { encryptBlob, decryptBlob, generateEncKey, bytesToBase64url, composeLinkCode } from '../js/crypto.js';
import { SCHEMA_VERSION, toWire } from '../js/merge.js';
import { saveItems, loadItems, loadFeeds, saveFeeds, saveAuth, loadSyncState, saveSyncState } from '../js/storage.js';

const NOW = () => new Date('2026-08-02T12:00:00.000Z');
const item = (id, updatedAt) => ({ id, title: `t-${id}`, date: '2026-08-02', time: null, updatedAt });
const state = (o = {}) => ({ schemaVersion: SCHEMA_VERSION, items: [], feeds: [], tombstones: [], ...o });
const echo = (s) => s;   // simplest applyState: writes nothing, returns what it got

// READS AND WRITES ARE SEPARATE INJECTIONS: syncOnce/previewRemote take a
// readFetchImpl for GET /data (production passes fetchWithTimeout) and a
// fetchImpl for the PUT (never timed out). Almost every test here drives both
// through ONE fake server, so these two adapters hand the test's fetchImpl in
// as the read fetch too, unless the test passes its own. The tests that are
// ABOUT the split call realSyncOnce / realPreviewRemote directly.
const syncOnce = (deps) => realSyncOnce({ readFetchImpl: deps.fetchImpl, ...deps });
const previewRemote = (deps) => realPreviewRemote({ readFetchImpl: deps.fetchImpl, ...deps });

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
//
// The plaintext marker must be a string the wire cannot contain BY CHANCE.
// It used to be the title 't-a', and every character of that is in the
// base64url alphabet the random 43-character authToken is drawn from — so
// the Bearer header carried 't-a' in about 1 run in 6000 and the test failed
// on correct code. A space is in neither base64url nor standard base64, so no
// token or ciphertext can produce this; and it has no quote or backslash, so
// it would survive JSON escaping intact if the title ever did go out in clear.
const PLAINTEXT_MARKER = 'plaintext title marker';
test('the Bearer token is sent and the encryption key is NEVER on the wire', async () => {
  const link = await linked();
  saveItems([{ ...item('a', '2026-08-01T00:00:00.000Z'), title: PLAINTEXT_MARKER }]);
  const server = fakeServer();
  await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.ok(server.calls.some(c => c.method === 'PUT'), 'the test must actually exercise a push');
  assert.ok(server.calls.every(c => c.headers.authorization === `Bearer ${link.authToken}`));
  const pushed = await decryptBlob(link.encKey, server.row.blob);
  assert.deepEqual(pushed.items.map(i => i.title), [PLAINTEXT_MARKER],
    'fixture check: the marker is the content that was pushed, encrypted');
  const wire = JSON.stringify(server.calls);
  assert.ok(!wire.includes(bytesToBase64url(link.encKey)), 'encKey must never be transmitted');
  assert.ok(!wire.includes(PLAINTEXT_MARKER), 'plaintext must never be transmitted');
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

// adoptChoice has exactly three legal values: null (an ordinary sync),
// 'adopt-merge' and 'adopt-bootstrap'. "Replace this device" (adopt-replace)
// was removed on 2026-10-19. Any other value is a wiring bug, and it must stop
// before the network rather than be read as one of the others: silently
// treating a caller that asked to DISCARD as a caller that asked to merge is
// the opposite of what it asked for.
test('an unknown adoptChoice — including the retired adopt-replace — is refused before anything is pulled or applied', async () => {
  for (const adoptChoice of ['adopt-replace', 'merge', true]) {
    installFakeLocalStorage();
    await linkWithCode(bytesToBase64url(generateEncKey()));
    saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
    let called = false;
    let applied = false;
    await assert.rejects(
      syncOnce({ fetchImpl: async () => { called = true; }, now: NOW, apiBase: 'https://w.example',
        applyState: () => { applied = true; }, adoptChoice }),
      /adoptChoice/,
      `${String(adoptChoice)} must be refused`,
    );
    assert.equal(called, false, 'nothing may be pulled');
    assert.equal(applied, false, 'nothing may be applied');
    assert.equal(loadSyncState().adoptionPending, true, 'the gate stays raised');
    assert.deepEqual(loadItems().map((i) => i.id), ['local'], 'local data is untouched');
  }
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

// DA-C1. 'adopt-bootstrap' is the third legal adoptChoice: it lifts the gate
// and adopts, but it must NOT dedupe. It is used on the first device's
// bootstrap (spec 5.7 step 2 — an empty server means local uploads AS-IS) and
// on a device with nothing local to dedupe against. sync.js's dedupe
// condition is `=== 'adopt-merge'` for exactly this reason; without this test
// a later refactor to a truthiness check would silently restore a
// permanent, cross-device collapse of any two records sharing title, date and
// time — and push a tombstone for the loser to every device.
test("'adopt-bootstrap' adopts and lifts the gate WITHOUT deduping", async () => {
  installFakeLocalStorage();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  saveItems([
    { id: 'l1', title: 'Call mom', date: '2026-08-05', time: null, updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'l2', title: 'Call mom', date: '2026-08-05', time: null, updatedAt: '2026-08-01T00:00:00.000Z' },
  ]);
  saveFeeds([
    { id: 'f1', url: 'https://cal.example/a.ics', name: 'A', color: '#111', hidden: false, updatedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'f2', url: 'https://cal.example/a.ics/', name: 'A again', color: '#222', hidden: false, updatedAt: '2026-08-01T00:00:00.000Z' },
  ]);
  const server = fakeServer(); // empty account — the first device's bootstrap
  let applied = null;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { applied = s; return s; }, adoptChoice: 'adopt-bootstrap' });
  assert.equal(res.status, 'ok');
  assert.equal(applied.items.length, 2, 'a bootstrap must upload local records AS-IS, never collapse two distinct ones');
  assert.equal(applied.feeds.length, 2, 'two feeds whose URLs differ only by a trailing slash are two subscriptions');
  assert.deepEqual(applied.tombstones, [], 'a bootstrap must not invent tombstones to push to every other device');
  const pushed = await decryptBlob(link.encKey, server.row.blob);
  assert.equal(pushed.items.length, 2);
  assert.deepEqual(pushed.tombstones, []);
  assert.equal(loadSyncState().adoptionPending, false, 'a completed adoption lifts the gate');
});

// DA-I5. The account can empty (or change) between the linking UI's
// previewRemote and its syncOnce. A user who chose against data they SAW
// would otherwise have that choice acted on against data they never saw, and
// sync.js cannot see it. Re-previewing from linkui.js
// narrows the window but does not close it — the merge is applied against the
// pull INSIDE syncOnce.
test('expectVersion matching the pulled version proceeds normally', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 5, blob: await encryptBlob(link.encKey, state()) });
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: echo, expectVersion: 5 });
  assert.equal(res.status, 'ok');
  assert.equal(server.row.version, 6, 'a matching version must not block the push');
});

test('expectVersion that no longer matches applies nothing, pushes nothing and hands the decision back', async () => {
  // Linked WITHOUT clearing the gate: this is the adoption flow, which is the
  // only caller that passes expectVersion.
  installFakeLocalStorage();
  const link = await linkWithCode(bytesToBase64url(generateEncKey()));
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 9, blob: await encryptBlob(link.encKey, state({ items: [item('r', '2026-08-01T00:00:00.000Z')] })) });
  let applied = false;
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: () => { applied = true; }, adoptChoice: 'adopt-merge', expectVersion: 4 });
  assert.equal(res.status, 'changed');
  assert.equal(res.version, 9, 'the caller needs the version it must re-decide against');
  assert.equal(applied, false, 'a choice made against data that has since moved must not be acted on');
  assert.equal(server.row.version, 9, 'nothing may be pushed');
  assert.deepEqual(JSON.parse(localStorage.getItem('plaenicke.items')).map(i => i.id), ['local']);
  assert.equal(loadSyncState().adoptionPending, true, 'the gate stays raised so the user is asked again');
  assert.equal(loadSyncState().version, 0, 'the cursor must not advance past a pull that was never applied');
});

// THE DEVICE-CHANGE PATH INTO THE GATE, END TO END.
//
// syncOnce carries a three-link safety chain — reset on a changed device
// token, then re-check the gate the reset just raised — and `linked()` above
// always syncs with the token it linked with, so the branch never fired.
// Three separate mutants survived 548/548 because of it: writing
// `adoptionPending: false` in resetSyncStateIfDeviceChanged (the auth test
// asserted only `version === 0`, which is 0 either way), deleting the
// `resetSyncStateIfDeviceChanged` call, and deleting the SECOND gate check.
// Deleting BOTH gate copies IS caught, so the gate itself was tested — only
// the way in was not.
//
// Production effect: a device re-pointed at a different account silently
// unions its local data into that account and pushes it, which is the exact
// silent union spec 5.7 exists to prevent.
test('a device whose credential now names a different account is asked again, and syncs nothing', async () => {
  const link = await linked();
  saveItems([item('mine', '2026-08-01T00:00:00.000Z')]);
  saveSyncState({ ...loadSyncState(), version: 7, lastSyncedAt: '2026-08-01T00:00:00.000Z' });
  const hashBefore = loadSyncState().tokenHash;
  assert.ok(hashBefore, 'fixture check: the cursor records which device it belongs to');

  // The stored credential now carries a DIFFERENT device token. The encKey is
  // unchanged, so decryption is emphatically not what stops this — only the
  // token-hash comparison is.
  const otherToken = bytesToBase64url(generateEncKey());
  saveAuth(composeLinkCode(otherToken, link.encKey));

  const server = fakeServer({
    version: 12,
    blob: await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z')] })),
  });
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });

  assert.equal(res.status, 'adoption-required',
    'the reset raises the gate and the SECOND check is what turns that into a refusal');
  assert.deepEqual(server.calls, [],
    'nothing may be pulled or pushed — the union must not reach the account at all');
  assert.equal(server.row.version, 12);
  const after = loadSyncState();
  assert.equal(after.adoptionPending, true, 'the user must be offered Merge / Cancel again');
  assert.equal(after.version, 0, 'a stale cursor from the previous account must never be reused');
  assert.equal(after.lastSyncedAt, null);
  assert.equal(after.tokenHash, await tokenHash(otherToken), 'and the cursor must now name the new device token');
  assert.deepEqual(loadItems().map((i) => i.id), ['mine'], 'and local data is untouched');
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

// --- `applied`: has this device already been changed? ----------------------
//
// syncOnce applies BEFORE the push loop, so 'offline', 'error' and 'conflict'
// are all reachable with the local write already landed — a Wi-Fi drop between
// the GET and the PUT reaches every one of them. The caller cannot infer it
// from the status, and linkui.js's failure text said "Nothing has been
// combined yet" on all three, and Unlink is offered right beside the false
// report.

test('applied is false on every status returned before applyState could run', async () => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);

  const offline = await syncOnce({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.deepEqual([offline.status, offline.applied], ['offline', false]);

  await linked();
  const unauth = await syncOnce({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.deepEqual([unauth.status, unauth.applied], ['unauthorized', false]);

  await linked();
  const httpErr = await syncOnce({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.deepEqual([httpErr.status, httpErr.applied], ['error', false]);

  await linked();
  const bad = fakeServer({ version: 2, blob: await encryptBlob(generateEncKey(), state()) });
  const undec = await syncOnce({ fetchImpl: bad.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.deepEqual([undec.status, undec.applied], ['undecryptable', false]);

  // linked() re-installs storage and mints a FRESH key, so the blob below must
  // be encrypted with THIS device's key, not the one captured at the top.
  const fresh = await linked();
  const applyThrew = await syncOnce({
    fetchImpl: fakeServer({ version: 2, blob: await encryptBlob(fresh.encKey, state()) }).fetchImpl,
    now: NOW,
    apiBase: 'https://w.example',
    applyState: () => { throw new Error('quota'); },
  });
  assert.deepEqual([applyThrew.status, applyThrew.applied], ['error', false],
    'an applyState that threw wrote nothing — this one really is "nothing has been combined"');
});

test('a PUT that never lands still reports that the local write DID — the Wi-Fi drop between GET and PUT', async () => {
  const link = await linked();
  saveItems([item('mine', '2026-08-01T00:00:00.000Z')]);
  let wrote = null;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ version: 3, blob: await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z')] })) }) };
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { wrote = s; return s; } });
  assert.equal(res.status, 'offline');
  assert.equal(res.applied, true,
    'the account records are already on this device — reporting "nothing has been combined" would be false');
  assert.deepEqual(wrote.items.map(i => i.id).sort(), ['mine', 'theirs'], 'fixture check: the apply really ran');
});

test('a non-409 HTTP failure on the PUT reports applied, because the apply already happened', async () => {
  const link = await linked();
  saveItems([item('mine', '2026-08-01T00:00:00.000Z')]);
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ version: 3, blob: await encryptBlob(link.encKey, state({ items: [item('theirs', '2026-08-01T00:00:00.000Z')] })) }) };
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.deepEqual([res.status, res.applied], ['error', true]);
});

test('CAS exhaustion reports applied — the merge is on this device, only the push failed', async () => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') {
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', version: 99, blob: '' }) };
    }
    return { ok: true, status: 200, json: async () => ({ version: 0, blob: '' }) };
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.deepEqual([res.status, res.applied], ['conflict', true]);
});

test('a successful sync also reports applied, and a version mismatch does not', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  const ok = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
  assert.deepEqual([ok.status, ok.applied], ['ok', true]);

  installFakeLocalStorage();
  const link2 = await linkWithCode(bytesToBase64url(generateEncKey()));
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const moved = fakeServer({ version: 9, blob: await encryptBlob(link2.encKey, state({ items: [item('r', '2026-08-01T00:00:00.000Z')] })) });
  const changed = await syncOnce({ fetchImpl: moved.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: () => { throw new Error('must not be called'); }, adoptChoice: 'adopt-merge', expectVersion: 4 });
  assert.deepEqual([changed.status, changed.applied], ['changed', false],
    "'changed' is the guard that hands the decision back — it applies nothing by construction");
  assert.ok(link.encKey.length === 32); // fixture sanity
});

// The whole wire for a device that fills up while applying calendars:
// saveFeeds -> QuotaError -> syncOnce's apply catch records err.name, which
// linkui.js labels "this device has run out of storage".
test('a calendar save that runs out of storage during apply is recorded as QuotaError', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state({ items: [item('r', '2026-08-01T00:00:00.000Z')] })) });
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => {
    if (k === 'plaenicke.feeds') { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }
    return real(k, v);
  };
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: (s) => { saveFeeds(s.feeds); return s; } });
  assert.equal(res.status, 'error');
  assert.equal(loadSyncState().lastError, 'QuotaError');
  assert.equal(server.row.version, 1, 'nothing is pushed after a failed apply');
});

// --- timeouts: the read gives up, the write does not (punchlist L63) -------
//
// A read is side-effect free, so abandoning it is always safe and it is
// reported exactly like being offline. A PUT is never abandoned: a client-side
// timeout does not stop the server's write, so timing one out would report
// 'offline' about a write that may have landed.

test('syncOnce and previewRemote refuse to run without a readFetchImpl', async () => {
  await linked();
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(realSyncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo }), /readFetchImpl/);
  await assert.rejects(realPreviewRemote({ apiBase: 'https://w.example' }), /readFetchImpl/);
  assert.equal(called, false, 'nothing may be fetched through the write fetch instead');
});

test('the read goes through readFetchImpl and only the PUT goes through fetchImpl', async () => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state()) });
  const reads = [];
  const writes = [];
  const res = await realSyncOnce({
    readFetchImpl: (u, o) => { reads.push((o && o.method) || 'GET'); return server.fetchImpl(u, o); },
    fetchImpl: (u, o) => { writes.push((o && o.method) || 'GET'); return server.fetchImpl(u, o); },
    now: NOW, apiBase: 'https://w.example', applyState: echo,
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(reads, ['GET']);
  assert.deepEqual(writes, ['PUT']);
});

test('a read that times out is reported as offline: nothing applied, nothing pushed', async (t) => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = () => { reads += 1; return new Promise(() => {}); }; // a GET that never answers
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let applied = false;
  let wrote = false;
  try {
    let settled = false;
    const pending = realSyncOnce({
      readFetchImpl: fetchWithTimeout,
      fetchImpl: async () => { wrote = true; },
      now: NOW, apiBase: 'https://w.example', applyState: () => { applied = true; },
    });
    pending.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(reads, 1, 'fixture check: the read really went out');
    assert.equal(settled, false, 'fixture check: and is still waiting before the deadline');
    t.mock.timers.tick(FETCH_TIMEOUT_MS);
    const res = await pending;
    assert.deepEqual([res.status, res.applied], ['offline', false]);
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
  assert.equal(loadSyncState().lastError, 'offline', 'reported exactly like being offline');
  assert.equal(applied, false);
  assert.equal(wrote, false);
});

test('previewRemote reports a timed-out read as offline', async (t) => {
  await linked();
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = () => { reads += 1; return new Promise(() => {}); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const pending = realPreviewRemote({ readFetchImpl: fetchWithTimeout, apiBase: 'https://w.example' });
    pending.then(() => { settled = true; });
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(reads, 1, 'fixture check: the read really went out');
    assert.equal(settled, false, 'fixture check: and is still waiting before the deadline');
    t.mock.timers.tick(FETCH_TIMEOUT_MS);
    assert.equal((await pending).status, 'offline');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = originalFetch;
  }
});

// Must not change: the PUT has no deadline. One that takes twice the read's
// budget still lands and is reported as the success it is.
test('a PUT slower than the read deadline is still waited for, and lands', async (t) => {
  const link = await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 1, blob: await encryptBlob(link.encKey, state()) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let putStarted = false;
    const pending = realSyncOnce({
      readFetchImpl: server.fetchImpl,
      fetchImpl: (u, o) => {
        putStarted = true;
        return new Promise((resolve) => { setTimeout(() => resolve(server.fetchImpl(u, o)), 2 * FETCH_TIMEOUT_MS); });
      },
      now: NOW, apiBase: 'https://w.example', applyState: echo,
    });
    for (let i = 0; i < 50 && !putStarted; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
    assert.ok(putStarted, 'fixture check: the PUT is in flight');
    t.mock.timers.tick(2 * FETCH_TIMEOUT_MS);
    const res = await pending;
    assert.equal(res.status, 'ok');
    assert.equal(res.pushed, true);
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(server.row.version, 2, 'the write landed');
  assert.equal(loadSyncState().lastError, null);
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

// --- Third-pass review findings ---

// Finding 5 (first found on the since-removed adopt-replace path; pinned here
// on adopt-merge): every remote feed must be routed through merge()'s pickFeed, which stamps color:null/hidden:false for a first-seen
// feed. Server blobs are always wire form (toWire already stripped
// color/hidden before this blob was ever pushed), and storage.js's
// deserializeFeeds drops any feed whose color is not a string — undefined is
// not null, so handing applyState the raw remote feed silently destroys the
// subscription the moment a real applyState calls saveFeeds.
test('adopt-merge hands applyState a feed with a color key and boolean hidden, and it survives a save/load round trip', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const remoteFeed = { id: 'fRemote', url: 'https://cal.example/a.ics', name: 'A', updatedAt: '2026-08-01T00:00:00.000Z' };
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({ feeds: [remoteFeed] })) });
  let handedFeeds = null;
  const applyState = (s) => {
    handedFeeds = s.feeds;
    // Mimics feeds.js's applyRemoteFeeds: a first-seen feed's null color
    // MUST be replaced before it is ever saved.
    const assigned = s.feeds.map(f => (f.color === null ? { ...f, color: '#111' } : f));
    saveFeeds(assigned);
    return { ...s, feeds: assigned };
  };
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState, adoptChoice: 'adopt-merge' });
  assert.equal(res.status, 'ok');
  assert.equal(handedFeeds.length, 1);
  assert.ok('color' in handedFeeds[0], 'color key must be present (null is fine) so a real applyState can assign one');
  assert.equal(typeof handedFeeds[0].hidden, 'boolean');
  const survivors = loadFeeds();
  assert.deepEqual(survivors.map(f => f.id), ['fRemote'],
    'the feed must survive a real save/load round trip, not be silently dropped by deserializeFeeds');
});

// Isolates the RETRY's own routing from the main path's: this drops a
// malformed item so the first apply differs from what was pulled and a push
// (and the forced conflict) is reached, then checks the feed handed to
// applyState AFTER the conflict, not before.
test('a sync that hits a 409 mid-retry also routes the new remote feed through pickFeed', async () => {
  const link = await linked();
  saveItems([item('local', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer({ version: 2, blob: await encryptBlob(link.encKey, state({
    items: [item('remote', '2026-08-01T00:00:00.000Z'), { id: 'bad', title: 'Bad', date: null, time: null, updatedAt: '2026-08-01T00:00:00.000Z' }],
  })) });
  let lastFeeds = null;
  const applyState = (s) => {
    lastFeeds = s.feeds;
    return { ...s, items: s.items.filter(i => typeof i.date === 'string') };
  };
  const conflictFeed = { id: 'fConflict', url: 'https://cal.example/b.ics', name: 'B', updatedAt: '2026-08-01T00:00:00.000Z' };
  let forced = false;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT' && !forced) {
      forced = true;
      server.row.version += 1;
      server.row.blob = await encryptBlob(link.encKey, state({ items: [item('remote2', '2026-08-01T00:00:00.000Z')], feeds: [conflictFeed] }));
      return { ok: false, status: 409, json: async () => ({ error: 'version_conflict', version: server.row.version, blob: server.row.blob }) };
    }
    return server.fetchImpl(url, opts);
  };
  const res = await syncOnce({ fetchImpl, now: NOW, apiBase: 'https://w.example', applyState });
  assert.equal(res.status, 'ok');
  assert.equal(lastFeeds.length, 1);
  assert.ok('color' in lastFeeds[0], 'the retry must also route feeds through pickFeed before handing them to applyState');
  assert.equal(typeof lastFeeds[0].hidden, 'boolean');
});

// Finding 6: a toWire() failure while deciding whether to push is the SAME
// failure class as applyState throwing directly (both mean "what applyState
// wrote cannot be turned into a valid push"), and must resolve to 'error'
// like every other apply-time failure — not reject syncOnce's promise, which
// would leave Task 7's runSync silently swallowing it via `catch (err) {
// console.error('sync', err && err.name); }` and the status line still
// reading "last synced" successfully.
test('an applyState that returns a structurally incomplete state reports error instead of rejecting', async () => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example',
    applyState: () => ({ schemaVersion: SCHEMA_VERSION }) });
  assert.equal(res.status, 'error');
});

// Finding 7: the encrypt-before-network-try hoist has no direct test. Poison
// crypto.subtle.encrypt so encryptBlob itself rejects, and confirm the
// failure is classified as a permanent local error, not a transient network
// one — catching it as 'offline' would present an unpushable device as
// merely offline forever.
test('an encrypt failure before the PUT reports error, not offline', async () => {
  await linked();
  saveItems([item('a', '2026-08-01T00:00:00.000Z')]);
  const server = fakeServer();
  const originalEncrypt = crypto.subtle.encrypt;
  crypto.subtle.encrypt = async () => { throw new Error('encrypt failed'); };
  try {
    const res = await syncOnce({ fetchImpl: server.fetchImpl, now: NOW, apiBase: 'https://w.example', applyState: echo });
    assert.equal(res.status, 'error');
  } finally {
    crypto.subtle.encrypt = originalEncrypt;
  }
});
