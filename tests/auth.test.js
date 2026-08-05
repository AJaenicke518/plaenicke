import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { generateEncKey, bytesToBase64url, composeLinkCode } from '../js/crypto.js';
import {
  loadSyncState, saveSyncState, loadItems, saveItems,
  loadFeeds, saveFeeds, loadTombstones, saveTombstones, SYNC_STATE_KEY,
} from '../js/storage.js';
import {
  isLinked, getLink, linkWithCode, unlink, tokenHash,
  resetSyncStateIfDeviceChanged, isAdoptionPending, clearAdoptionPending,
} from '../js/auth.js';

const bareToken = () => bytesToBase64url(generateEncKey());

test('an unlinked device reports unlinked and has no link', () => {
  installFakeLocalStorage();
  assert.equal(isLinked(), false);
  assert.equal(getLink(), null);
});

test('a bare token bootstraps a fresh encKey and stores a full link code', async () => {
  installFakeLocalStorage();
  const token = bareToken();
  const link = await linkWithCode(token);
  assert.equal(link.authToken, token);
  assert.equal(link.encKey.length, 32);
  assert.equal(link.code.length, 86);
  assert.equal(isLinked(), true);
});

test('two bootstraps generate DIFFERENT keys — a bare token never joins an existing account', async () => {
  installFakeLocalStorage();
  const a = await linkWithCode(bareToken());
  installFakeLocalStorage();
  const b = await linkWithCode(bareToken());
  assert.notDeepEqual([...a.encKey], [...b.encKey]);
});

test('a full link code joins with the SAME key it carries', async () => {
  installFakeLocalStorage();
  const key = generateEncKey();
  const link = await linkWithCode(composeLinkCode(bareToken(), key));
  assert.deepEqual([...link.encKey], [...key]);
});

test('linkWithCode rejects junk without linking or setting the gate', async () => {
  installFakeLocalStorage();
  await assert.rejects(() => linkWithCode('nonsense!'));
  assert.equal(isLinked(), false);
  assert.equal(isAdoptionPending(), false);
});

test('tokenHash matches the Worker SHA-256 hex shape and is stable', async () => {
  const h = await tokenHash('abc');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await tokenHash('abc'));
  assert.notEqual(h, await tokenHash('abd'));
});

test('linking hard-resets the cursor so a re-link never reuses a stale version', async () => {
  installFakeLocalStorage();
  saveSyncState({ version: 42, tokenHash: 'stale', adoptionPending: false });
  await linkWithCode(bareToken());
  assert.equal(loadSyncState().version, 0);
});

// DA-C2: linking must gate the first sync, or the union is applied and pushed
// before the user is ever offered Merge / Replace / Cancel.
test('linking sets the adoption gate, and only clearAdoptionPending lifts it', async () => {
  installFakeLocalStorage();
  await linkWithCode(bareToken());
  assert.equal(isAdoptionPending(), true, 'a freshly linked device must not sync silently');
  clearAdoptionPending();
  assert.equal(isAdoptionPending(), false);
});

// The bootstrap path has no remote data to union, so the gate is nearly free
// there. A device JOINING an existing account is the entire reason the gate
// exists — this must be checked independently of the bootstrap-path test above.
test('joining an existing account with a full link code also raises the gate', async () => {
  installFakeLocalStorage();
  await linkWithCode(composeLinkCode(bareToken(), generateEncKey()));
  assert.equal(isAdoptionPending(), true, 'a device joining an existing account must not sync silently');
});

// If the cursor write fails AFTER the credential is already stored, the
// device is left linked with the adoption gate down — the one state the gate
// exists to prevent. linkWithCode must write the cursor before the
// credential so a failure here leaves no credential at all.
test('a failure writing the cursor must not leave the device linked with the gate down', async () => {
  installFakeLocalStorage();
  const raw = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === SYNC_STATE_KEY) {
      const err = new Error('Sync state exceeded storage quota');
      err.name = 'QuotaExceededError';
      throw err;
    }
    return raw(key, value);
  };
  await assert.rejects(() => linkWithCode(bareToken()));
  assert.equal(isLinked(), false, 'a write failure must not leave the device linked with the gate down');
});

test('clearAdoptionPending preserves the rest of the cursor', async () => {
  installFakeLocalStorage();
  await linkWithCode(bareToken());
  saveSyncState({ ...loadSyncState(), version: 5 });
  clearAdoptionPending();
  assert.equal(loadSyncState().version, 5);
  assert.equal(loadSyncState().adoptionPending, false);
});

test('resetSyncStateIfDeviceChanged zeroes on a different token and leaves the same one alone', async () => {
  installFakeLocalStorage();
  const token = bareToken();
  await resetSyncStateIfDeviceChanged(token);
  saveSyncState({ ...loadSyncState(), version: 9 });
  await resetSyncStateIfDeviceChanged(token);
  assert.equal(loadSyncState().version, 9, 'same device must not reset');
  await resetSyncStateIfDeviceChanged(bareToken());
  assert.equal(loadSyncState().version, 0, 'different device must reset');
});

// The version reset is only half of what this function does, and the only
// assertion above is `version === 0` — which is 0 whether the gate goes up or
// stays down, so a reset writing `adoptionPending: false` passed 548/548.
// Raising the gate is the load-bearing half: it is what forces the user to be
// asked again instead of this device silently unioning its data into an
// account it was just re-pointed at.
test('resetSyncStateIfDeviceChanged re-raises the adoption gate, not just the cursor', async () => {
  installFakeLocalStorage();
  await linkWithCode(bareToken());
  clearAdoptionPending();
  assert.equal(isAdoptionPending(), false, 'fixture check: the gate starts down');
  await resetSyncStateIfDeviceChanged(bareToken()); // a DIFFERENT device token
  assert.equal(isAdoptionPending(), true,
    'a device pointed at a different account must be asked again, never union silently');
});

test('unlink clears credentials and cursor but NEVER touches local data', async () => {
  installFakeLocalStorage();
  saveItems([{ id: 'a', title: 'keep me', date: '2026-08-02', updatedAt: '2026-08-02T00:00:00.000Z' }]);
  // A wiped feed is a URL nothing on screen can restore (settings.js never
  // renders feed.url), and wiped tombstones would let every deleted item
  // resurrect on the next sync — both are local data, same as items.
  saveFeeds([{ id: 'f1', url: 'https://example.com/feed.ics', name: 'keep me too', color: '#336699', hidden: false, updatedAt: '2026-08-02T00:00:00.000Z' }]);
  saveTombstones([{ id: 'd1', kind: 'item', deletedAt: '2026-08-02T00:00:00.000Z' }]);
  await linkWithCode(bareToken());
  unlink();
  assert.equal(isLinked(), false);
  assert.equal(loadSyncState().version, 0);
  assert.equal(loadItems().length, 1, 'unlinking must never delete local data');
  assert.equal(loadFeeds().length, 1, 'unlinking must never delete feeds');
  assert.equal(loadTombstones().length, 1, 'unlinking must never delete tombstones');
});

test('a corrupt stored link code reads as unlinked rather than throwing on every tick', () => {
  installFakeLocalStorage();
  localStorage.setItem('plaenicke.auth', 'not-a-code');
  assert.equal(getLink(), null);
  assert.equal(isLinked(), false);
});
