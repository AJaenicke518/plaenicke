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
import { applyTombstones } from './merge.js';
import { loadAuth, loadSyncState, loadItems, loadFeeds, loadTombstones } from './storage.js';
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

// adoptionCounts / chooseAdoption — how this device should join the account.
//
// THE EMPTINESS PREDICATE IS LITERAL, not left to judgement (DA-C2).
// previewRemote returns `state: null` ONLY when the response carries no blob
// at all; an account whose records were all deleted returns a non-null
// {schemaVersion, items: [], feeds: [], tombstones: [...]}. Reading emptiness
// as `state === null` classifies that account as "has data", offers Replace
// this device, and wipes every local item and every feed URL — unrecoverably,
// since js/settings.js never re-displays a feed URL.
//
// BUT A SIDE'S TOMBSTONES ARE PART OF WHAT IT WOULD DO TO THE OTHER SIDE.
// The plan said "tombstones are never counted on either side"; that stopped a
// tombstone-only account being offered "Replace this device" (a ONE-click
// unrecoverable wipe) but classified it 'none' instead — and 'none'/'auto'
// route to adopt-bootstrap, which runs AUTOMATICALLY on panel mount with no
// user interaction. That is a ZERO-click wipe, and it was reproduced in both
// directions:
//   - an account holding only tombstones silently deleted this device's items
//     and calendar subscriptions;
//   - a device that cleared its list while unlinked (spec 4.4: signed-out is
//     a complete app) silently deleted the account's records and tombstoned
//     them to every other device.
//
// Counting tombstones outright is the wrong fix too: it sends a tombstone-only
// account back to 'ask', re-creating the original defect — a Replace button
// beside a dialog reading "0 items, 0 calendars". What matters is how many
// records a side's tombstones would ACTUALLY suppress on the other side, and
// that rule is merge.js's applyTombstones (`deletedAt > updatedAt`, so a
// record re-created after the deletion survives). It is imported, never
// re-implemented: a second copy is a second place for it to drift.
//
// remoteEffective is checked FIRST, so both-empty still resolves to 'none'.
function suppressedCount(records, tombstones, kind) {
  const list = records || [];
  return list.length - applyTombstones(list, tombstones, kind).length;
}

export function adoptionCounts(localState, remoteState) {
  const local = localState || {};
  const remote = remoteState || null;
  const n = (state, key) => ((state && state[key]) || []).length;
  const remoteDeletesLocal = remote
    ? suppressedCount(local.items, remote.tombstones, 'item')
      + suppressedCount(local.feeds, remote.tombstones, 'feed')
    : 0;
  const localDeletesRemote = remote
    ? suppressedCount(remote.items, local.tombstones, 'item')
      + suppressedCount(remote.feeds, local.tombstones, 'feed')
    : 0;
  const localItems = n(local, 'items');
  const localFeeds = n(local, 'feeds');
  const remoteItems = n(remote, 'items');
  const remoteFeeds = n(remote, 'feeds');
  return {
    localItems,
    localFeeds,
    remoteItems,
    remoteFeeds,
    remoteDeletesLocal,
    localDeletesRemote,
    remoteEffective: remoteItems + remoteFeeds + remoteDeletesLocal,
    localEffective: localItems + localFeeds + localDeletesRemote,
  };
}

export function chooseAdoption(localState, remoteState) {
  const c = adoptionCounts(localState, remoteState);
  if (c.remoteEffective === 0) return 'none';
  if (c.localEffective === 0) return 'auto';
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
  'kept-changing': 'The account kept changing while this device was trying to join it, so nothing has been combined. '
    + 'That usually means another device is busy syncing — wait a moment and try again.',
  malformed: "The account's data is incomplete — this device cannot tell what it holds, so nothing has been combined. "
    + 'A device still running an older version of plaenicke can cause this; sync from that device first.',
};

// Statuses where the sensible next step is to try the same thing again, as
// opposed to re-linking with a different code.
const RETRYABLE = new Set(['offline', 'error', 'conflict', 'skipped', 'no-apply', 'kept-changing', 'malformed']);

// Bounded for the same reason syncOnce's CAS loop is (js/sync.js:217): a
// condition that looks transient can be permanent. An account whose version
// advances on every GET — a caching proxy, or simply a busy account — turns
// the 'changed' -> re-preview -> adopt cycle into an unbounded loop with no
// error surface. Measured at 201 GETs before the harness cap, two per
// iteration, with the panel stuck on "Combining…" forever.
const MAX_ADOPT_ATTEMPTS = 3;

// MODULE SCOPE, deliberately. settings.js mounts a NEW initLinkUI on every
// panel open (js/settings.js:70 rebuilds the whole panel; close() empties the
// host at :65), and close() cannot cancel the previous closure's in-flight
// work. Each mount owns its own `inflight` and neither sees the other, so
// with the gate still raised a user who opens Settings, closes it
// mid-adoption and re-opens starts a SECOND concurrent adoption — measured
// ['GET','GET','SYNC','SYNC']. The realistic worst case is clicking "Replace
// this device", closing, re-opening on a slow connection, getting the dialog
// again and clicking "Merge": two applyState writes with conflicting
// semantics, resolved by arrival order. app.js's own syncInFlight guard does
// not cover linkui's syncOnce calls.
//
// IT MUST NOT BE ABLE TO OUTLIVE ITS PURPOSE either. It is cleared in the
// episode's `finally`, and nothing in previewRemote/fetchRemote carries an
// AbortController or a timeout — so an episode whose request never settles
// would hold it for the page's lifetime, and every later panel open would
// render a busy view with no controls at all, on a fully healthy network.
// A joining mount can therefore TAKE OVER — but ONLY during the preview.
//
// THE PHASE DISTINCTION IS THE WHOLE DESIGN, and getting it wrong is how the
// first attempt at this destroyed the exclusion it was written to preserve:
//
//   - A PREVIEW is a read with no side effects. Abandoning one is safe, and
//     `adoptionGeneration` is sufficient: a late-returning preview finds its
//     generation superseded and returns before writing anything.
//   - A WRITE (syncOnceImpl) is NOT abandonable, and a generation check in
//     front of it answers the wrong question. It gates whether an episode may
//     BEGIN a write; it says nothing once an episode is already inside one.
//     Measured, with the generation counter working exactly as designed:
//     Merge held inside syncOnce -> close/reopen -> take over -> Replace, and
//     both writes ran concurrently. The superseded PUT then landed AFTER the
//     replace, putting the record the user explicitly discarded back into the
//     account, at a higher version, with no error and no status anywhere.
//     A Cancel in the same window reported "nothing was combined" while the
//     superseded episode's syncOnce went on to call clearAdoptionPending().
//
// So `writeInFlight` — set immediately before the write and cleared in a
// finally — is what actually excludes. Takeover is refused while it is true.
let activeAdoption = null;
let adoptionGeneration = 0;
let writeInFlight = false;
let activeStartedAt = 0;

// A healthy adoption takes a second or two. Offering "Try again" instantly,
// under text that invites the click, turns every ordinary two-second wait
// into an invitation to start a second episode.
const STALE_ADOPTION_MS = 10000;

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

function readLocal() {
  return { items: loadItems(), feeds: loadFeeds(), tombstones: loadTombstones() };
}

// A blob can decrypt and carry the right schemaVersion and still be
// structurally unusable. Element shape matters as much as the arrays
// themselves: adoptionCounts feeds these lists STRAIGHT to merge.js's
// applyTombstones, which — correctly — throws rather than reading junk as
// "nothing was deleted".
function isWellFormedState(state) {
  const listOk = (list) => Array.isArray(list) && list.every((r) => r && typeof r === 'object');
  return listOk(state.items) && listOk(state.feeds) && listOk(state.tombstones);
}

export function initLinkUI(options = {}) {
  const {
    host, onLinked, onUnlinked, applyState,
    // Effects, injected the way js/feeds.js and js/sync.js already do it. The
    // defaults are the production wiring; tests supply their own.
    fetchImpl = (url, opts) => fetch(url, opts),
    apiBase = WORKER_URL,
    now = () => new Date(),
    syncOnceImpl = syncOnce,
    staleAfterMs = STALE_ADOPTION_MS,
  } = options;

  // stage === null means "derive the view from stored state".
  let stage = null;
  let stageData = {};
  let notice = '';
  let mintedCode = '';
  let inflight = Promise.resolve();
  let joinTimer = null;

  function guarded(fn) {
    return (async () => {
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
  }

  // Local-only work (composing a code for a second device). Never touches the
  // account, so it needs no cross-mount exclusion.
  function run(fn) {
    inflight = guarded(fn);
    return inflight;
  }

  // Attach to the episode already running instead of starting one. This must
  // never be a dead end: it awaits the live episode and re-renders when it
  // settles, and — if that episode is still only PREVIEWING — re-checks once
  // it has been running long enough to look stuck, so the takeover control
  // appears without needing another panel open.
  function joinActive() {
    const elapsed = now().getTime() - activeStartedAt;
    if (writeInFlight) stage = 'saving';
    else if (elapsed >= staleAfterMs) stage = 'joining-stale';
    else stage = 'joining';
    stageData = {};
    render();
    clearTimeout(joinTimer);
    if (stage === 'joining') {
      joinTimer = setTimeout(() => {
        if (stage === 'joining' && activeAdoption) joinActive();
      }, Math.max(0, staleAfterMs - elapsed));
    }
    inflight = activeAdoption.then(() => {
      clearTimeout(joinTimer);
      stage = null;
      stageData = {};
      render();
    });
    return inflight;
  }

  // Anything that talks to the account. At most ONE adoption episode runs
  // across every mounted panel — see `activeAdoption` above.
  function runAdoption(fn, { takeOver = false } = {}) {
    // Takeover is refused outright while a write is in flight — see
    // `writeInFlight`. `takeOver` is only ever passed by a control that is
    // only rendered when it is false, so this is belt-and-braces.
    if (activeAdoption && (!takeOver || writeInFlight)) return joinActive();
    // Starting fresh, or taking over a preview that appears stalled. Either
    // way this becomes the live episode; anything still previewing from
    // before is superseded and will refuse to write.
    const generation = (adoptionGeneration += 1);
    activeStartedAt = now().getTime();
    const episode = (async () => {
      try {
        await guarded(() => fn(generation));
      } finally {
        // A superseded episode must not clear the marker its successor set —
        // that would orphan the successor's exclusion and let a third episode
        // start freely alongside it.
        if (adoptionGeneration === generation) activeAdoption = null;
      }
    })();
    activeAdoption = episode;
    inflight = episode;
    return episode;
  }

  // --- actions -------------------------------------------------------------

  async function doLink(raw, generation) {
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
    await doPreview(1, generation);
  }

  // `attempt` counts one adoption EPISODE's automatic re-previews. A human
  // clicking a button starts a fresh episode at 1 — the loop being bounded
  // here is the automatic one, which nothing else gates.
  async function doPreview(attempt, generation) {
    stage = 'busy';
    stageData = { text: 'Checking the account…' };
    render();
    await handlePreview(await previewRemote({ fetchImpl, apiBase }), attempt, generation);
  }

  // BRANCH ON preview.status BEFORE CONSULTING chooseAdoption (DA-C3).
  // previewRemote can return offline, unauthorized, error, undecryptable or
  // skipped — each with NO `state` key at all. Treating an absent state as
  // "empty server" would run a silent merge on all five, and 'undecryptable'
  // is exactly the signature of pasting a bare token on a second device.
  // chooseAdoption is only ever called with preview.state from a status: 'ok'
  // preview.
  async function handlePreview(preview, attempt, generation) {
    if (preview.status !== 'ok') {
      stage = 'failed';
      stageData = { status: preview.status };
      render();
      return;
    }
    // A blob can decrypt and carry the right schemaVersion and still be
    // structurally incomplete — `items` present, no `feeds` key. That is a
    // diagnosable condition with a real cause, not an unexplained crash, and
    // it must not be papered over by coercing the missing array to empty:
    // "the account has no calendars" and "this device cannot tell what
    // calendars the account has" have opposite safe responses.
    const remote = preview.state;
    if (remote !== null && !isWellFormedState(remote)) {
      stage = 'failed';
      stageData = { status: 'malformed' };
      render();
      return;
    }
    await decideAndAct(remote, preview.version, attempt, generation);
  }

  // The single place the decision is made and acted on. The re-ask path goes
  // through here too: if local emptied while the dialog sat open, the honest
  // answer is no longer "choose" but 'auto', and re-rendering the old dialog
  // would put "This device holds 0 items and 0 calendars" beside a Replace
  // button — the exact shape DA-C2 named as not an informed choice.
  async function decideAndAct(remote, version, attempt, generation) {
    // tombstones are load-bearing on BOTH sides — see adoptionCounts.
    const local = readLocal();
    if (chooseAdoption(local, remote) === 'ask') {
      stage = 'ask';
      stageData = { version, remote, ...adoptionCounts(local, remote) };
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
    await adopt('adopt-bootstrap', version, attempt, generation);
  }

  // The LOCAL half of the same guarantee expectVersion gives for the remote
  // half. The dialog's counts are a snapshot taken at preview time, and the
  // calendar section directly above it stays live while the dialog is open
  // (its controls are disabled only by isBusy(), which covers feed syncing
  // alone), with no focus trap keeping app.js's own add path out either.
  // Measured: dialog read "1 item and 1 calendar", a second calendar was
  // added, Replace was clicked, and BOTH were destroyed — the user consented
  // to discarding one. So re-read at CLICK time and re-ask if it moved.
  async function adoptAgainstFreshCounts(adoptChoice, generation) {
    const shown = stageData;
    const fresh = adoptionCounts(readLocal(), shown.remote);
    // Every count the dialog DESCRIBED, including remoteDeletesLocal, which
    // is a function of local records too.
    const moved = fresh.localItems !== shown.localItems
      || fresh.localFeeds !== shown.localFeeds
      || fresh.localDeletesRemote !== shown.localDeletesRemote
      || fresh.remoteDeletesLocal !== shown.remoteDeletesLocal;
    if (moved) {
      notice = 'This device changed while the dialog was open. Here is what it holds now — please choose again.';
      await decideAndAct(shown.remote, shown.version, 1, generation);
      return;
    }
    await adopt(adoptChoice, shown.version, 1, generation);
  }

  async function adopt(adoptChoice, expectVersion, attempt, generation) {
    // A PREVIEW that another mount has taken over from must not go on to
    // write when it finally returns. This gate is sufficient for that and
    // ONLY that: it says whether this episode may BEGIN a write, never
    // whether one is already under way. `writeInFlight` below is what
    // excludes concurrent writes.
    if (generation !== adoptionGeneration) return;
    if (!applyState) {
      stage = 'failed';
      stageData = { status: 'no-apply' };
      render();
      return;
    }
    stage = 'busy';
    stageData = { text: 'Combining…' };
    render();
    // From here until syncOnceImpl settles there is an unabandonable write in
    // flight. No mount may take over from it — see `writeInFlight`.
    let res;
    writeInFlight = true;
    try {
      res = await syncOnceImpl({
        fetchImpl, now, apiBase, applyState, adoptChoice, expectVersion,
      });
    } finally {
      writeInFlight = false;
    }
    if (res.status === 'changed') {
      // The account moved between the preview and the write, so the choice
      // the user made was against data that is no longer there — a Replace
      // against an account that emptied in between would be a silent full
      // local wipe with no re-confirmation (DA-I5). Re-preview and re-ask
      // rather than acting on a stale choice.
      //
      // BOUNDED. On a 'none'/'auto' decision the re-preview adopts again with
      // no human in the loop, so an account whose version keeps advancing
      // would spin forever. Same reasoning as syncOnce's CAS bound.
      if (attempt >= MAX_ADOPT_ATTEMPTS) {
        stage = 'failed';
        stageData = { status: 'kept-changing' };
        render();
        return;
      }
      notice = 'The account changed while you were deciding. Here is what it holds now — please choose again.';
      await doPreview(attempt + 1, generation);
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
    button.addEventListener('click', () => runAdoption((g) => doLink(input.value, g)));
    input.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') runAdoption((g) => doLink(input.value, g)); });
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

  function unlinkButton(text) {
    const btn = el('button', { type: 'button', className: 'remove', text });
    btn.addEventListener('click', doUnlink);
    return btn;
  }

  function renderBusy(wrap) {
    wrap.appendChild(el('p', { className: 'note', text: stageData.text || 'Working…' }));
  }

  // Shown to a mount that found another episode already PREVIEWING, and not
  // for long enough to look stuck. No takeover control: a healthy adoption
  // takes a second or two, and offering one here under text that invites the
  // click turns every ordinary wait into a second episode. joinActive()
  // re-renders this into renderJoiningStale once the threshold passes, and
  // out of it entirely once the live episode settles, so it is never a dead
  // end even though nothing below this has a timeout.
  function renderJoining(wrap) {
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'Checking the account… this was already under way when the panel opened.',
    }));
  }

  // The live episode has been previewing long enough to look stuck. A preview
  // is a read with no side effects, so abandoning it is safe.
  function renderJoiningStale(wrap) {
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'Still checking the account. This is taking longer than it should.',
    }));
    const takeOver = el('button', { type: 'button', text: 'Try again' });
    takeOver.addEventListener('click', () => runAdoption((g) => doPreview(1, g), { takeOver: true }));
    wrap.append(takeOver, unlinkButton('Unlink this device'));
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'Unlinking stops syncing. Nothing on this device is deleted.',
    }));
  }

  // A write is in flight. It cannot be abandoned and nothing may take over
  // from it: a second, concurrent syncOnce is exactly the failure the
  // exclusion exists to prevent, and Unlink here would leave that write
  // pushing with a token the user just revoked.
  function renderSaving(wrap) {
    // No controls, deliberately — see renderSaving's caller. But a write that
    // never answers would otherwise leave this panel on a bare spinner for
    // ever (nothing under syncOnce has a timeout), so say what is happening
    // and that waiting is not the only option. Reloading IS safe: the gate is
    // still raised, and the compare-and-swap makes a re-run idempotent.
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'Saving your choice… This step cannot be interrupted. '
        + 'If it does not finish, it is safe to reload the page and try again — nothing is lost either way.',
    }));
  }

  function renderAdoptionEntry(wrap) {
    wrap.appendChild(el('p', {
      className: 'note',
      text: 'This device is linked but has not been combined with the account yet. Nothing syncs until you choose.',
    }));
    const go = el('button', { type: 'button', text: 'Continue' });
    go.addEventListener('click', () => runAdoption((g) => doPreview(1, g)));
    wrap.appendChild(go);
  }

  function renderAsk(wrap) {
    const d = stageData;
    // A side can show 0 items and 0 calendars and still carry pending
    // DELETIONS that would remove records from the other side — that is
    // exactly how this dialog gets reached against a tombstone-only account.
    // A bare "0 items, 0 calendars" beside a Replace button is not an
    // informed choice, so the deletions are named.
    let text = `This device holds ${plural(d.localItems, 'item', 'items')} and ${plural(d.localFeeds, 'calendar', 'calendars')}. `
      + `The account holds ${plural(d.remoteItems, 'item', 'items')} and ${plural(d.remoteFeeds, 'calendar', 'calendars')}.`;
    if (d.remoteDeletesLocal > 0) {
      text += ` The account also records deletions that would remove ${d.remoteDeletesLocal} of the items and calendars on this device.`;
    }
    if (d.localDeletesRemote > 0) {
      text += ` This device records deletions that would remove ${d.localDeletesRemote} of the records in the account.`;
    }
    text += ' Choose how to combine them.';
    wrap.appendChild(el('p', { className: 'note', text }));
    const mergeBtn = el('button', { type: 'button', className: 'primary', text: 'Merge (recommended)' });
    mergeBtn.addEventListener('click', () => runAdoption((g) => adoptAgainstFreshCounts('adopt-merge', g)));
    const replaceBtn = el('button', { type: 'button', text: 'Replace this device' });
    replaceBtn.addEventListener('click', () => runAdoption((g) => adoptAgainstFreshCounts('adopt-replace', g)));
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
      retry.addEventListener('click', () => runAdoption((g) => doPreview(1, g)));
      wrap.appendChild(retry);
    } else {
      // 'unauthorized' and 'undecryptable'. Re-linking is the right first
      // answer, but it cannot be the only one — see below.
      pasteField(wrap, 'Re-link this device');
    }
    // EVERY failure state offers Unlink, and the note describing it is
    // rendered with the button rather than beside its absence.
    //
    // Two of these are otherwise inescapable. On 'unauthorized' and
    // 'undecryptable', closing and re-opening the panel just previews
    // straight back into the same state, so a user who pasted a bare token on
    // a second device — precisely the user with no valid 86-character code —
    // could never stop syncing. On 'malformed', "Try again" re-previews the
    // same unusable blob forever.
    if (getLink()) {
      wrap.appendChild(unlinkButton('Unlink this device'));
      wrap.appendChild(el('p', {
        className: 'note',
        text: 'Unlinking stops syncing. Nothing on this device is deleted.',
      }));
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
    wrap.appendChild(unlinkButton('Unlink this device'));
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
    else if (stage === 'joining') renderJoining(wrap);
    else if (stage === 'joining-stale') renderJoiningStale(wrap);
    else if (stage === 'saving') renderSaving(wrap);
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
  if (getLink() && isAdoptionPending()) runAdoption((g) => doPreview(1, g));

  return { settled: () => inflight };
}
