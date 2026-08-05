// linkui.js — the linking UI: paste a code, choose how this device joins the
// account, see sync status, unlink, and mint a code for a second device.
//
// NO IMPORT FROM app.js (DA-C6). syncOnce needs an applyState and the only
// implementation is app.js's applySyncedState — which already imports
// renderSyncStatus from here. Importing it back would create a cycle that
// drags the whole DOM-bound app.js into this module's unit tests, so the
// pure-helper tests below could not run at all (executed: `ReferenceError:
// document is not defined`). app.js passes applySyncedState into
// initSettings, which forwards it here.
//
// THE OWNERSHIP RULE (spec 5.5). This file owns neither plaenicke.items nor
// plaenicke.feeds and never writes either. Adoption goes through syncOnce,
// which hands merged state to applyState — the key's actual owner.
//
// SECRETS. A link code carries encKey. It is rendered in exactly ONE place —
// the `value` of the field the user copies from — and never in textContent,
// never in an aria-label or a title (both land in the accessibility tree),
// and never in a log. The same rule covers the PASTED input: on a transient
// failure that string IS a real link code, so no error path may echo it.

import { getLink, linkWithCode, unlink, isAdoptionPending } from './auth.js';
import { composeForNewDevice, base64urlToBytes, TOKEN_BYTES, KEY_BYTES } from './crypto.js';
import { previewRemote, syncOnce } from './sync.js';
import { loadAuth, loadSyncState, loadItems, loadFeeds } from './storage.js';
import { WORKER_URL } from './config.js';

const LINK_CODE_BYTES = TOKEN_BYTES + KEY_BYTES;

// app.js's runSync finally-block calls renderSyncStatus() with no arguments;
// it finds the status line by this id, or does nothing at all when the
// settings panel is closed and there is no such element.
export const SYNC_STATUS_ID = 'sync-status';

const NOT_LINKED_TEXT = 'Not linked. Everything stays on this device.';
const NEVER_SYNCED_TEXT = 'Linked. Nothing has synced yet.';
const PENDING_TEXT = 'Linked — but nothing syncs until you choose how to combine this device with the account.';
const CORRUPT_TEXT = "This device's saved code is unreadable, so it will never sync. Re-link with the 86-character code from a device that is already linked.";

const ERROR_LABELS = {
  offline: 'this device could not reach the account',
  unauthorized: "the account rejected this device's code",
  version_conflict: 'another device kept changing the account',
  DecryptError: "this device could not read the account's data",
  EncryptError: 'this device could not encrypt its data',
  ApplyError: 'this device could not save what it pulled',
  QuotaError: 'this device has run out of storage',
};

function errorLabel(code) {
  if (ERROR_LABELS[code]) return ERROR_LABELS[code];
  if (typeof code === 'string' && code.startsWith('http_')) return 'the server returned an error';
  return 'something went wrong';
}

function relative(iso, now) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'at an unknown time';
  const secs = Math.floor((now.getTime() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// describeSyncStatus — the one line that tells the user whether their app is
// actually syncing.
//
// BRANCH PRECEDENCE IS FIXED: adoptionPending outranks lastError (DA-I1).
// Linking while offline sets BOTH — js/sync.js:96 records lastError and does
// not lower the gate — and that is the exact scenario this string was written
// for. A device in that state syncs NOTHING until the user completes the
// dialog; the failure mode is "silently does nothing". If lastError won, the
// load-bearing signal would be hidden behind an offline banner precisely when
// it matters.
export function describeSyncStatus(syncState, now) {
  const s = syncState || {};
  if (s.adoptionPending === true) return PENDING_TEXT;
  if (s.lastError) {
    const tail = s.lastSyncedAt ? ` Last synced ${relative(s.lastSyncedAt, now)}.` : '';
    return `Sync problem: ${errorLabel(s.lastError)}.${tail}`;
  }
  if (!s.lastSyncedAt) return NEVER_SYNCED_TEXT;
  return `Last synced ${relative(s.lastSyncedAt, now)}.`;
}

// classifyPastedCode — DECODE, never count characters (DA-I3).
//
// linkWithCode branches on `base64urlToBytes(trimmed).length === TOKEN_BYTES`
// (js/auth.js:45), so a character count disagrees with it on valid-length,
// invalid-alphabet input — standard base64 with `+`/`/`, or 43 characters of
// junk. The UI would show the "creates a NEW account" warning, the user would
// confirm, and base64urlToBytes would throw out of linkWithCode.
export function classifyPastedCode(input) {
  try {
    const n = base64urlToBytes(String(input == null ? '' : input).trim()).length;
    return n === LINK_CODE_BYTES ? 'linkcode' : n === TOKEN_BYTES ? 'token' : 'invalid';
  } catch {
    return 'invalid';
  }
}

// chooseAdoption — how this device should join the account.
//
// THE EMPTINESS PREDICATE IS LITERAL, not left to judgement (DA-C2).
// previewRemote returns `state: null` ONLY when the response carries no blob
// at all; an account whose records were all deleted returns a non-null
// {schemaVersion, items: [], feeds: [], tombstones: [...]}. Reading emptiness
// as `state === null` classifies that account as "has data", offers Replace
// this device, and wipes every local item and every feed URL — unrecoverably,
// since js/settings.js never re-displays a feed URL.
//
// TOMBSTONES ARE NEVER COUNTED, on either side: a tombstone is the record of
// something that is gone, not something to keep.
//
// remoteEmpty is checked FIRST, so both-empty resolves to 'none'.
export function chooseAdoption(localState, remoteState) {
  const count = (state, key) => ((state && state[key]) || []).length;
  const remoteEmpty = remoteState == null
    || (count(remoteState, 'items') === 0 && count(remoteState, 'feeds') === 0);
  if (remoteEmpty) return 'none';
  const localEmpty = count(localState, 'items') === 0 && count(localState, 'feeds') === 0;
  if (localEmpty) return 'auto';
  return 'ask';
}

// The status text is derived from storage, not from a caller-held snapshot,
// because renderSyncStatus is called from app.js with no arguments.
//
// A CORRUPT STORED CODE IS ITS OWN STATE (DA-I2). getLink() returns null for
// an unparseable code (js/auth.js:30), so isLinked() reads false while a
// credential IS stored: runSync returns before its try/finally and
// plaenicke.syncState keeps showing the last good lastSyncedAt — a
// permanently frozen "synced N minutes ago" on an app that will never sync
// again. describeSyncStatus cannot express this; the discriminator is not in
// syncState, so it is checked here.
function statusText(now) {
  const stored = loadAuth();
  if (!stored) return NOT_LINKED_TEXT;
  if (!getLink()) return CORRUPT_TEXT;
  return describeSyncStatus(loadSyncState(), now);
}

function paintStatus(el, now) {
  const text = statusText(now);
  el.textContent = text;
  const state = loadSyncState();
  const bad = text === CORRUPT_TEXT || (state.adoptionPending !== true && !!state.lastError);
  el.className = bad ? 'sync-status sync-status-problem' : 'sync-status';
}

// Safe to call when the status line is not mounted — which is most of the
// time, since it lives inside the settings panel and settings.js empties its
// host on close. app.js invokes this from runSync's `finally` (js/app.js:483),
// OUTSIDE the try, and runSync is called un-awaited from four sites, so a
// throw here would be an unhandled rejection that also drops the queued
// syncPending re-arm at :486.
export function renderSyncStatus(now = new Date()) {
  const el = document.getElementById(SYNC_STATUS_ID);
  if (!el) return;
  paintStatus(el, now);
}

// --- the panel -------------------------------------------------------------

const FAILURE_TEXT = {
  offline: 'This device is linked, but it could not reach the account. Nothing has been combined yet, and nothing will sync until this succeeds.',
  unauthorized: "The account rejected this device's code — it may have been revoked. Paste a fresh 86-character link code to re-link.",
  undecryptable: "This device cannot read the account's data. That is what happens when a 43-character device token is pasted on a SECOND device: it starts a brand-new encryption key. Paste the 86-character link code from a device that is already linked instead.",
  error: 'The account could not be checked — the server returned an error. Nothing has been combined yet.',
  skipped: 'This device is not linked.',
  conflict: 'Another device kept changing the account while this one was combining. Nothing has been combined yet.',
  'no-apply': 'This device cannot save synced data — the app is wired up wrong. Reload the page and try again.',
};

// Statuses where the sensible next step is to try the same thing again, as
// opposed to re-linking with a different code.
const RETRYABLE = new Set(['offline', 'error', 'conflict', 'skipped', 'no-apply']);

function el(tag, props = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else node[key] = value;
  }
  return node;
}

function labelled(node, text) {
  node.setAttribute('aria-label', text);
  return node;
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

export function initLinkUI(options = {}) {
  const {
    host, onLinked, onUnlinked, applyState,
    // Effects, injected the way js/feeds.js and js/sync.js already do it. The
    // defaults are the production wiring; tests supply their own.
    fetchImpl = (url, opts) => fetch(url, opts),
    apiBase = WORKER_URL,
    now = () => new Date(),
    syncOnceImpl = syncOnce,
  } = options;

  // stage === null means "derive the view from stored state".
  let stage = null;
  let stageData = {};
  let notice = '';
  let mintedCode = '';
  let inflight = Promise.resolve();

  function run(fn) {
    inflight = (async () => {
      try {
        await fn();
      } catch (err) {
        // Never log the pasted or composed code — see the header note.
        console.error('plaenicke: linking action failed', err && err.name);
        notice = 'Something went wrong on this device. Try again.';
        stage = null;
        render();
      }
    })();
    return inflight;
  }

  // --- actions -------------------------------------------------------------

  async function doLink(raw) {
    notice = '';
    try {
      await linkWithCode(raw);
    } catch (err) {
      // `raw` is NEVER interpolated: on a transient failure it is a real
      // link code. crypto.js/auth.js messages never echo their input.
      notice = `Could not link this device: ${(err && err.message) || 'unknown error'}`;
      stage = null;
      render();
      return;
    }
    if (onLinked) onLinked();
    await doPreview();
  }

  async function doPreview() {
    stage = 'busy';
    stageData = { text: 'Checking the account…' };
    render();
    await handlePreview(await previewRemote({ fetchImpl, apiBase }));
  }

  // BRANCH ON preview.status BEFORE CONSULTING chooseAdoption (DA-C3).
  // previewRemote can return offline, unauthorized, error, undecryptable or
  // skipped — each with NO `state` key at all. Treating an absent state as
  // "empty server" would run a silent merge on all five, and 'undecryptable'
  // is exactly the signature of pasting a bare token on a second device.
  // chooseAdoption is only ever called with preview.state from a status: 'ok'
  // preview.
  async function handlePreview(preview) {
    if (preview.status !== 'ok') {
      stage = 'failed';
      stageData = { status: preview.status };
      render();
      return;
    }
    const local = { items: loadItems(), feeds: loadFeeds() };
    const decision = chooseAdoption(local, preview.state);
    if (decision === 'ask') {
      stage = 'ask';
      stageData = {
        version: preview.version,
        localItems: local.items.length,
        localFeeds: local.feeds.length,
        remoteItems: preview.state.items.length,
        remoteFeeds: preview.state.feeds.length,
      };
      render();
      return;
    }
    // 'none' (an empty account — this device bootstraps it) and 'auto'
    // (nothing local to lose) both adopt WITHOUT dedupe.
    //
    // NEITHER MAY PASS 'adopt-merge' (DA-C1). js/sync.js:118 runs dedupeState
    // on exactly that value, and js/merge.js writes a tombstone per dropped
    // id which is then pushed to the account. On 'none' that collapses two
    // legitimately distinct same-title/date/time records into one,
    // permanently, and destroys one of two feeds whose URLs differ only in a
    // trailing slash. Spec 5.7 step 2 says an empty server means local
    // uploads AS-IS. On 'auto' there is nothing local to dedupe *against*,
    // yet it would deduplicate the account's OWN records and propagate the
    // tombstones to every other device.
    await adopt('adopt-bootstrap', preview.version);
  }

  async function adopt(adoptChoice, expectVersion) {
    if (!applyState) {
      stage = 'failed';
      stageData = { status: 'no-apply' };
      render();
      return;
    }
    stage = 'busy';
    stageData = { text: 'Combining…' };
    render();
    const res = await syncOnceImpl({
      fetchImpl, now, apiBase, applyState, adoptChoice, expectVersion,
    });
    if (res.status === 'changed') {
      // The account moved between the preview and the write, so the choice
      // the user made was against data that is no longer there — a Replace
      // against an account that emptied in between would be a silent full
      // local wipe with no re-confirmation (DA-I5). Re-preview and re-ask
      // rather than acting on a stale choice.
      notice = 'The account changed while you were deciding. Here is what it holds now — please choose again.';
      await doPreview();
      return;
    }
    if (res.status === 'ok') {
      notice = '';
      stage = null;
      render();
      if (onLinked) onLinked();
      return;
    }
    stage = 'failed';
    stageData = { status: res.status };
    render();
  }

  function doUnlink() {
    unlink();
    stage = null;
    stageData = {};
    mintedCode = '';
    notice = 'Unlinked. Everything on this device was kept — items, calendars and all.';
    render();
    if (onUnlinked) onUnlinked();
  }

  function doMint(rawToken) {
    // composeForNewDevice fails closed on a null link and on an 86-character
    // token (js/crypto.js:58, :40). An uncaught throw here would leave the
    // dialog frozen with no diagnostic at all.
    try {
      mintedCode = composeForNewDevice(rawToken, getLink());
      notice = '';
    } catch (err) {
      mintedCode = '';
      notice = `Could not create a code: ${(err && err.message) || 'unknown error'}`;
    }
    render();
  }

  // --- views ---------------------------------------------------------------

  function pasteField(wrap, buttonText, hint) {
    if (hint) wrap.appendChild(el('p', { className: 'note', text: hint }));
    const input = labelled(el('input', {
      type: 'text',
      className: 'link-code-input',
      placeholder: 'Paste your link code',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: false,
    }), 'Link code');
    const warning = el('p', { className: 'note link-warning' });
    const refresh = () => {
      const raw = input.value;
      if (!String(raw).trim()) { warning.textContent = ''; return; }
      const kind = classifyPastedCode(raw);
      if (kind === 'token') {
        warning.textContent = 'That is a 43-character device token. Linking with it creates a NEW, empty account. '
          + 'To join an account you already use, paste the 86-character link code from a device that is already linked.';
      } else if (kind === 'invalid') {
        warning.textContent = "That doesn't look like a link code.";
      } else {
        warning.textContent = 'That is an 86-character link code — this device will join the account it belongs to.';
      }
    };
    input.addEventListener('input', refresh);
    const button = el('button', { type: 'button', text: buttonText });
    button.addEventListener('click', () => run(() => doLink(input.value)));
    input.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') run(() => doLink(input.value)); });
    wrap.append(input, warning, button);
  }

  function renderCorrupt(wrap) {
    wrap.appendChild(el('p', { className: 'note', text: CORRUPT_TEXT }));
    pasteField(wrap, 'Re-link this device');
  }

  function renderUnlinked(wrap) {
    pasteField(wrap, 'Link this device',
      'Link this device to keep your items and calendar subscriptions in step with your other devices. '
      + 'Everything is encrypted here first — the server only ever holds ciphertext.');
  }

  function renderBusy(wrap) {
    wrap.appendChild(el('p', { className: 'note', text: stageData.text || 'Working…' }));
  }

  function renderAdoptionEntry(wrap) {
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'This device is linked but has not been combined with the account yet. Nothing syncs until you choose.',
    }));
    const go = el('button', { type: 'button', text: 'Continue' });
    go.addEventListener('click', () => run(doPreview));
    wrap.appendChild(go);
  }

  function renderAsk(wrap) {
    const d = stageData;
    wrap.appendChild(el('p', {
      className: 'note',
      text: `This device holds ${plural(d.localItems, 'item', 'items')} and ${plural(d.localFeeds, 'calendar', 'calendars')}. `
        + `The account already holds ${plural(d.remoteItems, 'item', 'items')} and ${plural(d.remoteFeeds, 'calendar', 'calendars')}. `
        + 'Choose how to combine them.',
    }));
    const mergeBtn = el('button', { type: 'button', className: 'primary', text: 'Merge (recommended)' });
    mergeBtn.addEventListener('click', () => run(() => adopt('adopt-merge', d.version)));
    const replaceBtn = el('button', { type: 'button', text: 'Replace this device' });
    replaceBtn.addEventListener('click', () => run(() => adopt('adopt-replace', d.version)));
    const cancelBtn = el('button', { type: 'button', text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      notice = 'Nothing was combined. This device will not sync until you choose.';
      stage = null;
      stageData = {};
      render();
    });
    wrap.append(mergeBtn, replaceBtn, cancelBtn);
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'Merge keeps everything from both sides and folds together anything that is obviously the same. '
        + 'Replace this device throws away what is on this device — including its calendar links, whose addresses '
        + 'are never shown again and cannot be typed back in.',
    }));
  }

  function renderFailed(wrap) {
    const status = stageData.status;
    wrap.appendChild(el('p', {
      className: 'note link-failure',
      text: FAILURE_TEXT[status] || `Something went wrong (${status}).`,
    }));
    if (RETRYABLE.has(status)) {
      const retry = el('button', { type: 'button', text: 'Try again' });
      retry.addEventListener('click', () => run(doPreview));
      wrap.appendChild(retry);
    } else {
      pasteField(wrap, 'Re-link this device');
    }
  }

  function renderNewDevice(wrap) {
    wrap.appendChild(el('h4', { text: 'Link another device' }));
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'Mint a device token for the new device, paste it here, and this device will turn it into a link code '
        + 'that carries this account\'s encryption key. That key never leaves your devices, so this is the only way '
        + 'a second device can read your data.',
    }));
    const tokenInput = labelled(el('input', {
      type: 'text',
      className: 'link-token-input',
      placeholder: 'Paste the new device token',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: false,
    }), 'New device token');
    const makeBtn = el('button', { type: 'button', text: 'Create a code' });
    makeBtn.addEventListener('click', () => run(() => doMint(tokenInput.value)));
    // The ONLY place a link code is ever rendered. aria-label and title
    // describe the field; they never carry its value.
    const out = labelled(el('input', {
      type: 'text',
      className: 'link-code-output',
      readOnly: true,
      value: mintedCode,
    }), 'Link code for the new device');
    wrap.append(tokenInput, makeBtn, out);
    if (mintedCode) {
      wrap.appendChild(el('p', {
        className: 'note',
        text: 'Copy this into the new device. Treat it like a password — anyone holding it can read your data.',
      }));
    }
  }

  function renderLinked(wrap) {
    const state = loadSyncState();
    if (state.lastError) {
      wrap.appendChild(el('p', {
        className: 'note link-failure',
        text: `Last sync failed: ${errorLabel(state.lastError)}.`,
      }));
    }
    const unlinkBtn = el('button', { type: 'button', className: 'remove', text: 'Unlink this device' });
    unlinkBtn.addEventListener('click', doUnlink);
    wrap.appendChild(unlinkBtn);
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'Unlinking stops syncing. Nothing on this device is deleted, and the other devices keep their copies.',
    }));
    renderNewDevice(wrap);
  }

  function render() {
    host.innerHTML = '';
    const wrap = el('div', { className: 'link-ui' });

    // The status line is always present and always carries the id
    // renderSyncStatus() looks up, so a sync settling while the panel is open
    // repaints it in place.
    const status = el('div', { className: 'sync-status' });
    status.id = SYNC_STATUS_ID;
    paintStatus(status, now());
    wrap.appendChild(status);

    const stored = loadAuth();
    const link = getLink();
    if (stored && !link) renderCorrupt(wrap);
    else if (!link) renderUnlinked(wrap);
    else if (stage === 'busy') renderBusy(wrap);
    else if (stage === 'ask') renderAsk(wrap);
    else if (stage === 'failed') renderFailed(wrap);
    else if (isAdoptionPending()) renderAdoptionEntry(wrap);
    else renderLinked(wrap);

    if (notice) wrap.appendChild(el('p', { className: 'note link-notice', text: notice }));
    host.appendChild(wrap);
  }

  render();
  // NO NETWORK ON MOUNT except for an adoption that is already pending.
  // settings.js rebuilds its whole panel on every click (js/settings.js:70)
  // and empties the host on close (:65), so this runs once per panel open
  // against a fresh sub-element — never accumulating listeners, and never
  // firing a request just because the user opened Settings.
  if (getLink() && isAdoptionPending()) run(doPreview);

  return { settled: () => inflight };
}
