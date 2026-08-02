// auth.js — the link-code lifecycle and the adoption gate.
//
// An 86-character code JOINS the account its key belongs to. A bare
// 43-character token BOOTSTRAPS a new key — correct for the first device,
// wrong for the second, which is why linkui.js warns before doing it.
//
// Linking sets adoptionPending. sync.js refuses to run an ordinary sync while
// it is set, so the union is never applied or pushed before the user has been
// offered Merge / Replace / Cancel (spec 5.7).
//
// Unlinking never deletes local data. Signed-out plaenicke is a complete,
// working, offline app (spec 4.4).

import { parseLinkCode, composeLinkCode, generateEncKey, base64urlToBytes, TOKEN_BYTES } from './crypto.js';
import { loadAuth, saveAuth, clearAuth, loadSyncState, saveSyncState } from './storage.js';

const ZERO = { version: 0, tokenHash: null, lastSyncedAt: null, lastError: null, adoptionPending: false };

export async function tokenHash(authToken) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authToken));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function getLink() {
  const code = loadAuth();
  if (!code) return null;
  try {
    const { authToken, encKey } = parseLinkCode(code);
    return { authToken, encKey, code };
  } catch {
    return null; // corrupt code reads as unlinked; linkui surfaces it
  }
}

export function isLinked() { return getLink() !== null; }

export function isAdoptionPending() { return loadSyncState().adoptionPending === true; }

export function clearAdoptionPending() {
  saveSyncState({ ...loadSyncState(), adoptionPending: false });
}

export async function linkWithCode(input) {
  const trimmed = (input || '').trim();
  const bytes = base64urlToBytes(trimmed); // throws on junk BEFORE anything is stored
  let code;
  if (bytes.length === TOKEN_BYTES) {
    code = composeLinkCode(trimmed, generateEncKey());
  } else {
    parseLinkCode(trimmed); // validate before storing
    code = trimmed;
  }
  const { authToken } = parseLinkCode(code);
  saveAuth(code);
  // Hard reset: a re-link must never reuse a version from a previous device,
  // which would push at a cursor the server never issued (spec 5.7).
  // adoptionPending gates the first sync until the user chooses.
  saveSyncState({ ...ZERO, tokenHash: await tokenHash(authToken), adoptionPending: true });
  return getLink();
}

export function unlink() {
  clearAuth();
  saveSyncState({ ...ZERO });
}

export async function resetSyncStateIfDeviceChanged(authToken) {
  const hash = await tokenHash(authToken);
  const state = loadSyncState();
  if (state.tokenHash !== hash) saveSyncState({ ...ZERO, tokenHash: hash, adoptionPending: true });
}
