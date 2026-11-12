// accountui.js — Settings → Account: sign-up, log in, forgot password, change
// password, a new recovery link, devices, sign-out, Alex's upgrade, and the
// app-shell "Save your recovery link" banner (accounts spec §§ 6.1–6.7, 6.10,
// D8, D16, D17, D27).
//
// DOM GLUE OVER js/account.js, which is INJECTED (`api`) so the tests never
// run PBKDF2 or reach a server; the default is the real module. Every link goes
// through linkui's linkAndAdopt (D15) — this file never calls linkWithCode or
// unlink() itself — and every sign-out ends in linkui's signOutLocal() (D27,
// plan review I8). localOwner is written after an upgrade and from every
// validated GET /account (sweep W2-C1: a legacy answer included); it is
// NEVER cleared here (D16). plaenicke.legacyOwner — whether that owner has a
// login yet — is what tells the legacy UI from the account UI.
//
// MOUNTED PER OPEN, like linkui: settings.js rebuilds its panel on every open
// and empties it on close, so initAccountUI runs against a fresh element each
// time and no listener accumulates. NO REQUEST ON MOUNT — not on a plain open,
// and not for a boot intent (#invite= / #recover=): a link scanner that opens
// the URL must not spend the invite or touch the account (spec § 6.1 step 1,
// § 6.3 step 1). Everything that talks to the server is behind a tap.
//
// SECRETS: passwords, recovery codes, link codes and tokens are never logged
// and never rendered except the recovery code on its own screen. Errors are
// logged by name only.

import * as accountApi from './account.js';
import { AccountError, recoveryLink, mailtoHref, RECOVERY_NOTE } from './account.js';
import {
  ACCOUNT_COPY, adoptionBlocker, accountModeFromStorage, signOutLocal, signOutBlocked,
} from './linkui.js';
import { getLink, isAdoptionPending } from './auth.js';
import {
  loadLocalOwner, saveLocalOwner, loadLegacyOwner, saveLegacyOwner, clearLegacyOwner, loadSyncState, saveSyncState,
} from './storage.js';
import { checkPassword } from './password-policy.js';
import { parseLinkCode } from './crypto.js';

export const BANNER_ID = 'account-banner';
export const BANNER_TEXT = 'Save your recovery link — without it, a forgotten password means losing your planner.';
export const REVOKE_FAILED_TEXT = "This device's session could not be revoked — use Sign out other devices from another device.";

// --- error copy (zero fallback) ----------------------------------------------
//
// One line per code. An UNMAPPED code is shown as itself ("Unexpected error:
// <code>"), never as a generic message: a visible code is something Alex can
// look up; "something went wrong" is not. The two D16/D17 strings are linkui's
// own (ruling R2), never restated here.
const KEYS_BROKEN = "Something is wrong with this account's keys. Nothing was changed. Tell Alex.";
const SERVER_BROKEN = "The server isn't set up right. Tell Alex.";
const UNSAFE_SETTINGS = 'The server asked for unsafe settings. Nothing was sent.';
const CHANGED_ELSEWHERE = 'Your account changed on another device. Try again.';
// email_taken on Create your login: the address belongs to someone else's
// account, so "sign in instead" would be wrong advice (W3-I8).
const UPGRADE_EMAIL_TAKEN = 'That email is used by another account.';
// The Worker's own email rule (worker/src/input.js EMAIL_RE), checked here
// first so a typo is said at once instead of after a key derivation.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Done on a recovery screen whose code was replaced meanwhile (W3-I2).
const REPLACED_ELSEWHERE = 'This recovery link was replaced on another device — make a new one.';
const ERROR_COPY = {
  bad_credentials: 'Email or password is wrong.',
  invalid_invite: "That invite code doesn't work. Ask Alex for a new one.",
  email_taken: "There's already an account with that email. Sign in instead.",
  no_account: 'No account with that email.',
  disabled: 'This account is turned off. Ask Alex.',
  bad_recovery: "That recovery link doesn't match this email.",
  other_account_data: ACCOUNT_COPY.other_account_data,
  already_linked: ACCOUNT_COPY.already_linked,
  dek_check_failed: KEYS_BROKEN,
  wrong_key_on_device: KEYS_BROKEN,
  kdf_iters_too_low: UNSAFE_SETTINGS,
  kdf_iters_out_of_range: UNSAFE_SETTINGS,
  unwrap_failed: KEYS_BROKEN,
  bad_salt: SERVER_BROKEN,
  bad_config: SERVER_BROKEN,
  bad_seal: SERVER_BROKEN,
  bad_request: "The app sent something the server didn't accept. Tell Alex.",
  bad_recovery_code: "That isn't a recovery code — paste the whole link or the 22-character code.",
  invalid_email: "That doesn't look like an email address.",
  already_upgraded: 'This account already has a login — it was made on another device.',
  // linkAndAdopt's outcomes when it did not link (sweep W3-I8). linkui's own
  // section already says why in its words, so this line points there rather
  // than saying it twice.
  link_failed: 'This device could not be linked — the Sync section below says why.',
  blocked: "This device can't be linked to that account — the Sync section below says why.",
  joined_other: 'Another sign-in was already under way on this device. Wait for it to finish, then try again.',
  unreachable: "Can't reach the server. Check your connection.",
  not_configured: SERVER_BROKEN,
  at_rest_key_mismatch: SERVER_BROKEN,
  server: SERVER_BROKEN,
  no_password: 'This account has no password yet. Use Create your login.',
  invalid_upgrade_code: "That upgrade code doesn't work — it may be used or expired. Mint a new one (docs/admin.md).",
  missing_upgrade_code: 'Paste the upgrade code first.',
  password_changed: CHANGED_ELSEWHERE,
  recovery_changed: CHANGED_ELSEWHERE,
  // A bearer route answered 401: this device's session is gone (§ 6.10).
  unauthorized: ACCOUNT_COPY.signed_out,
  // linkAndAdopt REJECTED after the link landed (the preview threw): the
  // device is linked, and linkui's own section says what happened.
  adopt_failed: 'Signed in, but this device could not finish linking. See Sync below.',
  // The browser offers no clipboard here (an insecure context, say).
  copy_unavailable: "Copy isn't available here — use Email it to me or Download.",
};

export function errorCopy(code, extra = {}) {
  if (code === 'locked') {
    const at = Date.parse(extra && extra.retryAt);
    // No readable retry time is not "try again later": name the code.
    if (Number.isNaN(at)) return 'Unexpected error: locked';
    return `Too many tries. Try again after ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
  if (Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code];
  return `Unexpected error: ${code}`;
}

// D17's refusal, in the words this device can act on (sweep W3 #19): a
// legacy device's way out is Unlink in Sync, not Sign out.
function alreadyLinkedCopy() {
  return accountModeFromStorage() === 'legacy' ? ACCOUNT_COPY.already_linked_legacy : ACCOUNT_COPY.already_linked;
}

function copyFor(err) {
  if (err instanceof AccountError) return errorCopy(err.code, err.extra);
  console.error('plaenicke: account action failed', err && err.name);
  return errorCopy((err && err.name) || 'unknown');
}

// Thrown from recover's onAccountKnown to abort before recover/finish.
class Blocked extends Error {
  constructor(code) { super(code); this.name = 'Blocked'; this.code = code; }
}

// --- what this device knows about its account ----------------------------
//
// The last VALIDATED GET /account answer, tied to the session it was asked
// with: a sign-out or a different session reads as unknown, so one session's
// email or banner never shows under another. Module scope, so a Settings
// mount and the app shell share it. Not persisted: app load asks again.
let known = null; // { token, info: { accountId, email, recoveryConfirmed } }
// The session GET /account last answered 401 for (sweep W3-I4): this device
// still holds it, but the server has deleted it.
let rejectedToken = null;
// The latest Account section mount, so an answer that arrives after it
// rendered can repaint it (W3-I11) and tell Settings the mode changed
// (W3-I5). settings.js mounts one per open; an older one renders into a
// detached element, which is harmless.
let live = null;

function currentInfo() {
  const link = getLink();
  return link && known && known.token === link.authToken ? known.info : null;
}

// The email is kept in the server's form (D1: trimmed, lowercased), so what
// a form typed and what GET /account answers read the same (sweep W3 #27).
function remember(link, info) {
  const email = typeof info.email === 'string' ? info.email.trim().toLowerCase() : info.email;
  known = { token: link.authToken, info: { ...info, email } };
  paintBanner();
}

// Task 10's review: account.js returns GET /account's 2xx body unvalidated,
// and this file writes localOwner from it. Anything off-shape is a failed
// answer — never a partial one.
function validAccount(body) {
  if (!body || typeof body !== 'object') return null;
  const { accountId, email, recoveryConfirmed } = body;
  if (!(Number.isSafeInteger(accountId) && accountId > 0)) return null;
  if (!(email === null || typeof email === 'string')) return null;
  if (typeof recoveryConfirmed !== 'boolean') return null;
  return { accountId, email, recoveryConfirmed };
}

function validDevices(body) {
  if (!body || !Array.isArray(body.devices)) return null;
  const ok = body.devices.every((d) => d && typeof d.name === 'string' && typeof d.createdAt === 'string'
    && (d.lastSeenAt === null || typeof d.lastSeenAt === 'string') && typeof d.current === 'boolean');
  return ok ? body.devices : null;
}

async function fetchAccount(api) {
  const link = getLink();
  if (!link) {
    paintBanner();
    return { status: 'unlinked' };
  }
  const modeBefore = accountModeFromStorage();
  let body;
  try {
    body = await api.getAccount({ link });
  } catch (err) {
    const still = getLink();
    if (err instanceof AccountError && err.status === 401 && still && still.authToken === link.authToken) {
      rejectedToken = link.authToken;
      if (live) live.refresh();
    }
    return { status: 'failed', err };
  }
  // Signed out (or into another session) while the request was out: the
  // answer is about a session this device no longer holds.
  const now = getLink();
  if (!now || now.authToken !== link.authToken) return { status: 'failed', err: new AccountError('unauthorized') };
  const info = validAccount(body);
  if (!info) return { status: 'failed', err: new AccountError('server') };
  // THE OWNER IS RECORDED FROM EVERY VALIDATED ANSWER (sweep W2-C1) — a
  // legacy account (email null) included. A legacy device used to record
  // nothing here, so once unlinked it held account 1's planner under no
  // owner, and the next account to sign in on it adopted that planner, feed
  // URLs included (reproduced: scen/s1b.mjs).
  //
  // An owner already recorded is NEVER overwritten by an answer naming a
  // different account: that would hand this device's planner to it. Linking
  // records the owner first (linkui's doLink), so a mismatch means something
  // upstream went wrong — reported by name, nothing written, nothing shown.
  const owner = loadLocalOwner();
  if (owner !== null && owner !== info.accountId) {
    console.error('plaenicke: account check failed', 'owner_mismatch');
    return { status: 'failed', err: new AccountError('owner_mismatch') };
  }
  // The legacy marker first: if the owner write then fails, a marker with no
  // owner reads as a legacy device, which is what this one is. The other
  // order could leave an account-1 owner with no marker — the account UI on
  // an account with no login.
  if (info.email === null) saveLegacyOwner(info.accountId);
  else if (loadLegacyOwner() === info.accountId) clearLegacyOwner();
  // Alex's second phone after the upgrade (§ 6.7 step 4) lands here too.
  if (owner === null) saveLocalOwner(info.accountId);
  // This answer was for this session: its link is now shown to be the
  // owner's (W2 re-review), so a pending adoption may be previewed.
  if (loadSyncState().linkOwner !== info.accountId) saveSyncState({ linkOwner: info.accountId });
  if (rejectedToken === link.authToken) rejectedToken = null;
  remember(link, info);
  if (live) {
    if (accountModeFromStorage() !== modeBefore) live.modeChanged();
    live.refresh();
  }
  return { status: 'ok' };
}

// App load, on every linked device (legacy included). Resolves 'ok',
// 'failed' or 'unlinked'; never rejects for a network or shape failure. On
// 'failed' nothing is written and the banner keeps its last painted state.
export async function refreshAccount({ api = accountApi } = {}) {
  return (await fetchAccount(api)).status;
}

// --- the app-shell banner (D8) ---------------------------------------------

let bannerOpen = null;

// app.js wires the banner's button to Settings → Make a new recovery link.
export function initAccountBanner({ onOpen } = {}) {
  if (typeof onOpen !== 'function') throw new Error('initAccountBanner requires an onOpen function');
  bannerOpen = onOpen;
  paintBanner();
}

// Looked up by id at each paint, as linkui paints the shell indicator. Shown
// only while the account has a login whose recovery link is unconfirmed.
export function paintBanner() {
  const banner = document.getElementById(BANNER_ID);
  if (!banner) return;
  const info = currentInfo();
  const show = info !== null && info.email !== null && info.recoveryConfirmed === false;
  banner.innerHTML = '';
  banner.hidden = !show;
  if (!show) return;
  // A banner whose button goes nowhere is a dead control: fail at the paint.
  if (!bannerOpen) throw new Error('paintBanner: initAccountBanner was never called');
  const text = document.createElement('p');
  text.textContent = BANNER_TEXT;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Make a new recovery link';
  btn.addEventListener('click', () => bannerOpen());
  banner.append(text, btn);
}

// --- the Account section -----------------------------------------------------

function el(tag, props = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else node[key] = value;
  }
  return node;
}

// What a code field holds: the code itself, or a whole link carrying it
// (W3-C1). Testers paste the link they were sent, so the text after
// '#<kind>=' is the code; anything else is taken as typed. A link copied out
// of Mail or a chat can arrive percent-encoded ('%23recover%3D…') or wrapped
// in punctuation ('<…>', '(…).', quotes), so it is decoded first (undecodable
// text is taken as typed) and the code loses any leading or trailing
// character outside the base64url alphabet (W3 re-review). A malformed code
// is still the server's (or keys.js's) to refuse.
function decoded(raw) {
  const text = String(raw || '').trim();
  try { return decodeURIComponent(text); } catch { return text; }
}

export function codeFrom(raw, kind) {
  const text = decoded(raw);
  const marker = `#${kind}=`;
  const at = text.lastIndexOf(marker);
  const code = at === -1 ? text : text.slice(at + marker.length);
  return code.trim().replace(/^[^A-Za-z0-9_-]+/, '').replace(/[^A-Za-z0-9_-]+$/, '');
}

// The OTHER kind's link pasted into this field ('invite' <-> 'recover'):
// sending it would only earn a refusal for the wrong reason (W3 re-review).
function otherKindIn(raw, kind) {
  const other = kind === 'invite' ? 'recover' : 'invite';
  return decoded(raw).includes(`#${other}=`) ? other : null;
}

// True only where iOS says this is a Safari tab rather than the Home Screen
// app (sweep W3 #22): navigator.standalone is iOS-only and false in a tab.
// Anywhere else it is undefined, and nothing is claimed.
export function isSafariTab(nav = globalThis.navigator) {
  return Boolean(nav) && nav.standalone === false;
}

// The session this device holds was refused by the server (§ 6.10): a sync
// answered 401, or GET /account did.
function sessionRefused() {
  const link = getLink();
  return Boolean(link) && (rejectedToken === link.authToken || loadSyncState().lastError === 'unauthorized');
}

function within(root, node) {
  for (let n = node; n; n = n.parentNode) if (n === root) return true;
  return false;
}

function deviceName() {
  const ua = (globalThis.navigator && globalThis.navigator.userAgent) || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

// Each form: its fields in order, whether the D10 policy gates its Submit, and
// its labels. The LOGIN form never shows or gates on the policy: an existing
// password that a later blocklist update would refuse must still log in.
const FORMS = {
  login: { title: 'Sign in', fields: ['email', 'password'], policy: false, submit: 'Sign in' },
  signup: { title: 'Create your account', fields: ['invite', 'email', 'newPassword', 'password2'], policy: true, submit: 'Create account' },
  forgot: { title: 'Reset your password', fields: ['recovery', 'email', 'newPassword', 'password2'], policy: true, submit: 'Reset password' },
  change: { title: 'Change password', fields: ['email', 'current', 'newPassword', 'password2', 'signOutOthers'], policy: true, submit: 'Change password' },
  'new-recovery': { title: 'Make a new recovery link', fields: ['email', 'current'], policy: false, submit: 'Make a new link' },
  upgrade: { title: 'Create your login', fields: ['upgradeCode', 'email', 'newPassword', 'password2'], policy: true, submit: 'Create login' },
};

export function initAccountUI({
  host, api = accountApi, linkui, intent = null, onSignedOut = () => {},
  // Settings re-mounts linkui when the UI mode changes under it (legacy ->
  // account, W3-I5), and refetches calendars once a sign-in linked (#20).
  onAccountChanged = () => {}, onSignedIn = () => {},
  // The Account heading: focus returns there when a re-render removes the
  // focused control (#15).
  focusTarget = null,
  isSafariTab: inSafariTab = () => isSafariTab(),
  // Injected so tests leave no timer behind (the Download handler's revoke).
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  // The live linkui handle, read at use: settings.js re-mounts linkui after a
  // sign-out from here, and linkAndAdopt must reach the mount on screen.
  if (typeof linkui !== 'function') throw new Error('initAccountUI requires linkui: () => handle');

  let view = 'home';
  let prefill = { invite: '', recovery: '' };
  let error = '';
  let notice = '';
  let recovery = null; // { code, email } while the recovery screen is up
  let devices = null; // null until loaded on request
  let busy = false;
  let errorEl = null;
  let noticeEl = null;
  let askSignOutOthers = false; // #23: the first tap only asks

  function showError(text) {
    error = text;
    if (errorEl) errorEl.textContent = text;
  }

  function showNotice(text) {
    notice = text;
    if (noticeEl) noticeEl.textContent = text;
  }

  // A tap's handler: one at a time, and every failure is said on screen.
  function action(fn) {
    return async () => {
      if (busy) return;
      busy = true;
      showError('');
      try {
        await fn();
      } catch (err) {
        showError(copyFor(err));
      } finally {
        busy = false;
      }
    };
  }

  function requireLink() {
    const link = getLink();
    if (!link) throw new AccountError('unauthorized');
    return link;
  }

  function emailKnown() {
    const info = currentInfo();
    return info && typeof info.email === 'string' ? info.email : '';
  }

  // The server minted a session for this device that nothing will hold: a
  // device row nobody can sign out never expires (§ 6.2, plan review I4).
  // account.logOut never throws.
  async function revokeFresh(code) {
    const { authToken } = parseLinkCode(code);
    await api.logOut({ link: { authToken } });
  }

  // linkAndAdopt, and what to do with each outcome. Resolves 'linked',
  // 'adopt_failed' (linked, but the step after the link threw), or
  // { notLinked: copy } — not linked, the fresh session revoked, and `copy`
  // the line to show (the caller decides where; nothing is shown here).
  async function adopt(code, accountId) {
    let outcome;
    try {
      outcome = await linkui().linkAndAdopt(code, { accountId });
    } catch (err) {
      // The link landed and the preview (or onLinked) threw: linked, so the
      // session is NOT revoked; linkui's section shows the failure. The
      // caller still shows what it owes a linked device (a recovery code).
      console.error('plaenicke: account link failed', err && err.name);
      return 'adopt_failed';
    }
    if (outcome === 'linked') return 'linked';
    await revokeFresh(code);
    return { notLinked: outcome === 'blocked' ? errorCopy(adoptionBlocker(accountId) || 'blocked') : errorCopy(outcome) };
  }

  // After a recovery screen is up: the link landed but its next step threw.
  function sayIfAdoptFailed(result) {
    if (result === 'adopt_failed') showError(errorCopy('adopt_failed'));
  }

  // `linked: false` (sweep W3-I1c): sign-up or a reset minted this code and
  // then could not link this device. The account HAS this code now — after
  // a reset it is the only one — so it is shown all the same, without Done
  // (there is no session here to confirm it with), and with `error` saying
  // what happened.
  function showRecovery(code, email, { linked = true, error: why = '' } = {}) {
    recovery = { code, email, linked };
    view = 'recovery';
    error = why;
    notice = '';
    render();
  }

  const ACTIONS = {
    async signup(v) {
      // D16 before anything is sent (plan review I4): sign-up has no account
      // id yet, so any other owner's data blocks it.
      const blocker = adoptionBlocker(null);
      if (blocker) { showError(blocker === 'already_linked' ? alreadyLinkedCopy() : errorCopy(blocker)); return; }
      const res = await api.signUp({ invite: v.invite, email: v.email, password: v.newPassword, deviceName: deviceName() });
      // Link FIRST (§ 6.1 step 6), so the credential is stored before the
      // recovery screen sends the user off to Mail and the app is evicted.
      const linked = await adopt(res.code, res.accountId);
      if (linked.notLinked) {
        showRecovery(res.recoveryCode, v.email, {
          linked: false,
          error: `${linked.notLinked} Your account was created — save this recovery link, then sign in on another device.`,
        });
        return;
      }
      remember(getLink(), { accountId: res.accountId, email: v.email, recoveryConfirmed: false });
      onSignedIn();
      showRecovery(res.recoveryCode, v.email);
      sayIfAdoptFailed(linked);
    },
    async login(v) {
      // Up front only D17: the account id is unknown until the answer.
      if (adoptionBlocker(null) === 'already_linked') { showError(alreadyLinkedCopy()); return; }
      const res = await api.logIn({ email: v.email, password: v.password, deviceName: deviceName() });
      const blocker = adoptionBlocker(res.accountId);
      if (blocker) {
        await revokeFresh(res.code);
        showError(errorCopy(blocker));
        return;
      }
      const linked = await adopt(res.code, res.accountId);
      if (linked.notLinked) { showError(linked.notLinked); return; }
      remember(getLink(), { accountId: res.accountId, email: v.email, recoveryConfirmed: res.recoveryConfirmed });
      onSignedIn();
      view = 'home';
      render();
      sayIfAdoptFailed(linked);
    },
    async forgot(v) {
      if (adoptionBlocker(null) === 'already_linked') { showError(alreadyLinkedCopy()); return; }
      let res;
      try {
        res = await api.recover({
          email: v.email,
          recoveryCode: v.recovery,
          newPassword: v.newPassword,
          deviceName: deviceName(),
          // recover/start is read-only; this runs before recover/finish
          // changes anything, so a blocked device leaves the account as it was.
          onAccountKnown: (accountId) => {
            const blocker = adoptionBlocker(accountId);
            if (blocker) throw new Blocked(blocker);
          },
        });
      } catch (err) {
        if (err instanceof Blocked) { showError(errorCopy(err.code)); return; }
        throw err;
      }
      // recover/finish already replaced the old recovery code: the new one
      // is shown whenever this device is linked, even if a later step threw.
      const linked = await adopt(res.code, res.accountId);
      if (linked.notLinked) {
        showRecovery(res.recoveryCode, v.email, {
          linked: false,
          error: `${linked.notLinked} Your password was reset — save this new recovery link, then sign in with the new password.`,
        });
        return;
      }
      remember(getLink(), { accountId: res.accountId, email: v.email, recoveryConfirmed: false });
      onSignedIn();
      showRecovery(res.recoveryCode, v.email);
      sayIfAdoptFailed(linked);
    },
    async change(v) {
      const link = requireLink();
      await api.changePassword({
        link, email: v.email, currentPassword: v.current, newPassword: v.newPassword, signOutOthers: v.signOutOthers,
      });
      devices = null;
      view = 'home';
      notice = 'Password changed.';
      render();
    },
    async 'new-recovery'(v) {
      const link = requireLink();
      const res = await api.newRecoveryLink({ link, email: v.email, currentPassword: v.current });
      // The server cleared recovery_confirmed_at: the banner shows until Done.
      // The account id this session last confirmed; unknown (no check has
      // answered yet) leaves the banner to the next successful check.
      const info = currentInfo();
      if (info) remember(link, { ...info, email: v.email, recoveryConfirmed: false });
      showRecovery(res.recoveryCode, v.email);
    },
    async upgrade(v) {
      const link = requireLink();
      let res;
      try {
        res = await api.upgrade({ link, email: v.email, password: v.newPassword, upgradeCode: v.upgradeCode });
      } catch (err) {
        if (err instanceof AccountError && err.code === 'email_taken') { showError(UPGRADE_EMAIL_TAKEN); return; }
        throw err;
      }
      // Plan review I6: the data here now belongs to an account with a login
      // — no longer a legacy one (sweep W2-C1).
      saveLocalOwner(res.accountId);
      if (loadLegacyOwner() === res.accountId) clearLegacyOwner();
      remember(link, { accountId: res.accountId, email: v.email, recoveryConfirmed: false });
      // Legacy -> account: linkui's section still shows Unlink and the
      // code tools until Settings re-mounts it (W3-I5).
      onAccountChanged();
      showRecovery(res.recoveryCode, v.email);
    },
  };

  // --- rendering -------------------------------------------------------------

  function messages(wrap) {
    noticeEl = el('p', { className: 'note account-notice', id: 'acct-notice', text: notice });
    noticeEl.setAttribute('aria-live', 'polite');
    errorEl = el('p', { className: 'note account-error', id: 'acct-error', text: error });
    errorEl.setAttribute('role', 'alert');
    wrap.append(noticeEl, errorEl);
  }

  function button(id, text, onClick, className = '') {
    const b = el('button', { type: 'button', id, text });
    if (className) b.className = className;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderHome(wrap) {
    const mode = accountModeFromStorage();
    if (mode === 'unlinked') {
      wrap.appendChild(el('p', { className: 'note', text: 'Sign in to sync your planner and use smart add and calendars.' }));
      wrap.append(
        button('acct-login', 'Sign in', () => open({ kind: 'login' }), 'primary'),
        button('acct-invite', 'I have an invite', () => open({ kind: 'invite' })),
        button('acct-forgot', 'Forgot password', () => open({ kind: 'recover' })),
      );
    } else if (mode === 'account' && sessionRefused()) {
      // § 6.10 / W3-I4: the server deleted this session. Nothing here works
      // until the device signs in again.
      wrap.appendChild(el('p', { className: 'note', text: ACCOUNT_COPY.signed_out }));
      wrap.appendChild(button('acct-signin', 'Sign in', action(async () => { await signIn(); }), 'primary'));
    } else if (mode === 'account') {
      if (isAdoptionPending()) {
        // #25: the Merge choice lives in linkui's section.
        wrap.appendChild(el('p', { className: 'note', text: "This device isn't syncing yet — choose how to combine it in Sync below." }));
      }
      const email = emailKnown();
      wrap.appendChild(el('p', { className: 'account-email', text: email ? `Signed in as ${email}` : 'Signed in.' }));
      wrap.append(
        button('acct-change-password', 'Change password', () => goForm('change')),
        button('acct-new-recovery', 'Make a new recovery link', () => goForm('new-recovery')),
      );
      wrap.appendChild(el('h4', { text: 'Devices' }));
      const list = el('ul', { id: 'acct-devices', className: 'account-devices' });
      for (const d of devices || []) {
        const li = el('li');
        li.appendChild(el('span', { className: 'account-device-name', text: `${d.name}${d.current ? ' (this device)' : ''}` }));
        const seen = d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toLocaleDateString()}` : 'not seen yet';
        li.appendChild(el('span', { className: 'note', text: ` — ${seen}` }));
        list.appendChild(li);
      }
      wrap.append(
        list,
        button('acct-devices-load', devices === null ? 'Show devices' : 'Refresh devices', action(async () => {
          const body = await api.listDevices({ link: requireLink() });
          const listed = validDevices(body);
          if (!listed) throw new AccountError('server');
          devices = listed;
          render();
        })),
        ...signOutOthersControls(),
        button('acct-signout', 'Sign out', action(async () => {
          if ((await signOut()) === 'signed_out') onSignedOut();
        }), 'remove'),
      );
    } else {
      // Legacy (linked, no owner): linkui keeps today's UI and its Unlink.
      // Create your login only once GET /account has said the account has no
      // email — offering it on a guess would send an upgrade the server
      // refuses for an account that already has one.
      const info = currentInfo();
      if (info && info.email === null) {
        wrap.appendChild(el('p', { className: 'note', text: 'Create a login so you can sign in with your email and a password on a new device.' }));
        wrap.appendChild(button('acct-upgrade', 'Create your login', () => goForm('upgrade'), 'primary'));
      } else if (info) {
        wrap.appendChild(el('p', { className: 'account-email', text: `Signed in as ${info.email}` }));
      } else {
        wrap.appendChild(el('p', { className: 'note', text: "This device hasn't checked its account yet." }));
        wrap.appendChild(button('acct-check', 'Check again', action(async () => {
          const res = await fetchAccount(api);
          if (res.status === 'failed') throw res.err;
          render();
        })));
      }
    }
    messages(wrap);
  }

  // #23: signing every other device out is not undoable from here, so the
  // first tap asks.
  function signOutOthersControls() {
    if (!askSignOutOthers) {
      return [button('acct-signout-others', 'Sign out other devices', () => { askSignOutOthers = true; error = ''; render(); })];
    }
    const ask = el('p', { className: 'note', text: 'Sign out every other device? Each will need to sign in again.' });
    return [
      ask,
      button('acct-signout-others-confirm', 'Sign them out', action(async () => {
        await api.signOutOthers({ link: requireLink() });
        askSignOutOthers = false;
        devices = null;
        notice = 'Other devices were signed out.';
        render();
      }), 'remove'),
      button('acct-signout-others-cancel', 'Cancel', () => { askSignOutOthers = false; render(); }),
    ];
  }

  function field(form, kind, refs) {
    const make = (id, label, props) => {
      const wrapLabel = el('label', { className: 'account-field' });
      wrapLabel.appendChild(el('span', { text: label }));
      const input = el('input', { id, ...props });
      wrapLabel.appendChild(input);
      form.appendChild(wrapLabel);
      return input;
    };
    const plain = { autocapitalize: 'off', spellcheck: false };
    // A pasted code is not a word: no autocorrect, autocomplete or
    // capitalisation (W3 #13). autocorrect has no DOM property, so these are
    // attributes.
    const codeField = (id, label, value) => {
      const node = make(id, label, { type: 'text', value, spellcheck: false });
      for (const a of ['autocorrect', 'autocomplete', 'autocapitalize']) node.setAttribute(a, 'off');
      return node;
    };
    if (kind === 'invite') refs.invite = codeField('acct-invite-code', 'Invite link or code', prefill.invite);
    else if (kind === 'recovery') refs.recovery = codeField('acct-recovery-code', 'Recovery link or code', prefill.recovery);
    // Sweep W1-C1 / W3-I3: the server upgrades only with a one-time code Alex
    // mints with curl (docs/admin.md).
    else if (kind === 'upgradeCode') refs.upgradeCode = codeField('acct-upgrade-code', 'Upgrade code from Alex', '');
    else if (kind === 'email') refs.email = make('acct-email', 'Email', { type: 'email', autocomplete: 'username', value: emailKnown(), ...plain });
    else if (kind === 'password') refs.password = make('acct-password', 'Password', { type: 'password', autocomplete: 'current-password' });
    else if (kind === 'current') refs.current = make('acct-current-password', 'Current password', { type: 'password', autocomplete: 'current-password' });
    else if (kind === 'newPassword') refs.newPassword = make('acct-password', view === 'signup' ? 'Password' : 'New password', { type: 'password', autocomplete: 'new-password' });
    else if (kind === 'password2') refs.password2 = make('acct-password2', 'Confirm password', { type: 'password', autocomplete: 'new-password' });
    else if (kind === 'signOutOthers') {
      const label = el('label', { className: 'account-check' });
      refs.signOutOthers = el('input', { type: 'checkbox', id: 'acct-signout-others-too' });
      label.append(refs.signOutOthers, el('span', { text: 'Also sign out other devices' }));
      form.appendChild(label);
    } else throw new Error(`accountui: unknown field ${kind}`);
  }

  function renderForm(wrap) {
    const spec = FORMS[view];
    const which = view;
    wrap.appendChild(el('h4', { text: spec.title }));
    if ((which === 'signup' || which === 'forgot') && inSafariTab()) {
      // #22: a Safari tab's storage is not the Home Screen app's (D24), so
      // an account made here is not in the app.
      wrap.appendChild(el('p', {
        id: 'acct-safari-warning',
        className: 'note account-error',
        text: "You're in Safari, not the plaenicke app — open the app from your Home Screen and paste the code there.",
      }));
    }
    const form = el('form', { id: 'acct-form', className: 'account-form' });
    form.setAttribute('novalidate', '');
    const refs = {};
    for (const kind of spec.fields) field(form, kind, refs);
    let policy = null;
    let mismatch = null;
    if (spec.policy) {
      policy = el('ul', { id: 'acct-policy', className: 'account-policy' });
      policy.setAttribute('aria-live', 'polite');
      mismatch = el('p', { className: 'note account-error', id: 'acct-mismatch' });
      mismatch.setAttribute('aria-live', 'polite');
      form.append(policy, mismatch);
    }
    const status = el('p', { className: 'note', id: 'acct-status' });
    status.setAttribute('aria-live', 'polite');
    const submitBtn = el('button', { type: 'submit', id: 'acct-submit', className: 'primary', text: spec.submit });
    const cancel = button('acct-cancel', 'Cancel', () => { view = 'home'; error = ''; render(); });
    form.append(status, submitBtn, cancel);
    wrap.appendChild(form);
    messages(wrap);

    const values = () => ({
      invite: refs.invite ? codeFrom(refs.invite.value, 'invite') : undefined,
      recovery: refs.recovery ? codeFrom(refs.recovery.value, 'recover') : undefined,
      upgradeCode: refs.upgradeCode ? refs.upgradeCode.value.trim() : undefined,
      email: refs.email ? refs.email.value.trim() : undefined,
      password: refs.password ? refs.password.value : undefined,
      current: refs.current ? refs.current.value : undefined,
      newPassword: refs.newPassword ? refs.newPassword.value : undefined,
      signOutOthers: refs.signOutOthers ? refs.signOutOthers.checked === true : undefined,
    });

    // Every text field on a form is required (W3-I9): Submit stays off
    // until each holds something. Only the policy forms add the D10 gate.
    const required = [refs.invite, refs.recovery, refs.upgradeCode, refs.email, refs.password, refs.current,
      refs.newPassword, refs.password2].filter(Boolean);
    function gateOk() {
      if (required.some((node) => node.value.trim() === '')) return false;
      if (!spec.policy) return true;
      const pw = refs.newPassword.value;
      return checkPassword(pw, refs.email.value.trim()).ok && pw === refs.password2.value;
    }

    function refreshGate() {
      if (policy) {
        policy.innerHTML = '';
        for (const p of checkPassword(refs.newPassword.value, refs.email.value.trim()).problems) {
          policy.appendChild(el('li', { text: p }));
        }
        const differs = refs.password2.value !== '' && refs.password2.value !== refs.newPassword.value;
        mismatch.textContent = differs ? "Passwords don't match" : '';
      }
      submitBtn.disabled = busy || !gateOk();
    }

    // `change` too (W3 #11): iOS autofill and Keychain fill a field without
    // an input event.
    for (const node of required) {
      node.addEventListener('input', refreshGate);
      node.addEventListener('change', refreshGate);
    }
    refreshGate();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Enter in a field submits even while the button is disabled.
      if (busy || !gateOk()) return;
      if (refs.invite && otherKindIn(refs.invite.value, 'invite')) {
        showError("That's a recovery link — use Forgot password.");
        return;
      }
      if (refs.recovery && otherKindIn(refs.recovery.value, 'recover')) {
        showError("That's an invite link — use I have an invite.");
        return;
      }
      if (refs.email && !EMAIL_RE.test(refs.email.value.trim())) {
        showError(errorCopy('invalid_email'));
        return;
      }
      busy = true;
      refreshGate();
      showError('');
      showNotice('');
      status.textContent = 'Working… this can take a few seconds.';
      try {
        await ACTIONS[which](values());
      } catch (err) {
        showError(copyFor(err));
      } finally {
        busy = false;
        status.textContent = '';
        refreshGate();
      }
    });
  }

  function renderRecovery(wrap) {
    const { code, email } = recovery;
    const screen = el('div', { id: 'acct-recovery-screen', className: 'account-recovery' });
    screen.appendChild(el('h4', { text: 'Save your recovery link' }));
    screen.appendChild(el('p', {
      className: 'note',
      text: 'If you forget your password, this link is the only way back into your planner. Save it where only you can reach it.',
    }));
    if (recovery.linked) {
      // Mail can evict the Home Screen app (sweep W3-I1a); D8's banner
      // catches that, but the code on screen is lost with it.
      screen.appendChild(el('p', { className: 'note', text: 'Tick the box and tap Done right after sending — Mail may close this app.' }));
    }
    screen.appendChild(el('p', { id: 'acct-recovery-value', className: 'account-recovery-value', text: code }));
    const mail = el('a', { id: 'acct-recovery-email', className: 'account-link-button', text: 'Email it to me', href: mailtoHref(email, code) });
    const copy = button('acct-recovery-copy', 'Copy', action(async () => {
      const clip = globalThis.navigator && globalThis.navigator.clipboard;
      if (!clip || typeof clip.writeText !== 'function') {
        throw new AccountError('copy_unavailable');
      }
      await clip.writeText(recoveryLink(code));
      showNotice('Copied.');
    }));
    const download = button('acct-recovery-download', 'Download', () => {
      const blob = new Blob([`${recoveryLink(code)}\n\n${RECOVERY_NOTE}\n`], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'plaenicke-recovery-link.txt';
      a.click();
      // Revoked later, not at once: some browsers start the save after the
      // click returns, and iOS can take a while over its save sheet (W3 #26).
      setTimeoutImpl(() => URL.revokeObjectURL(url), 60000);
      showNotice("If the file didn't save, use Copy or Email it to me.");
    });
    const actionsRow = el('div', { className: 'account-recovery-actions' });
    actionsRow.append(mail, copy, download);
    screen.appendChild(actionsRow);
    // The one deliberate way off this screen besides Done (W3-I1b): Escape
    // and a backdrop tap no longer close the panel here.
    // Not gated on `busy` (W3 re-review): a Done still out answers into the
    // home view, which is harmless; a gate here was part of a trap.
    const later = button('acct-recovery-later', recovery.linked ? 'Not now' : 'Close', () => {
      recovery = null;
      view = 'home';
      error = '';
      notice = '';
      render();
    });
    if (!recovery.linked) {
      screen.appendChild(later);
      wrap.appendChild(screen);
      messages(wrap);
      return;
    }
    const savedLabel = el('label', { className: 'account-check' });
    const saved = el('input', { type: 'checkbox', id: 'acct-recovery-saved' });
    savedLabel.append(saved, el('span', { text: 'I saved my recovery link' }));
    screen.appendChild(savedLabel);
    const done = el('button', { type: 'button', id: 'acct-recovery-done', className: 'primary', text: 'Done' });
    done.disabled = true;
    saved.addEventListener('change', () => { done.disabled = busy || saved.checked !== true; });
    done.addEventListener('click', async () => {
      if (done.disabled || busy || saved.checked !== true) return;
      busy = true;
      done.disabled = true;
      showError('');
      try {
        const link = requireLink();
        // The code ON SCREEN is what is confirmed (sweep W3-I2): a link
        // replaced on another device meanwhile answers recovery_changed.
        await api.confirmRecovery({ link, recoveryCode: code });
        const info = currentInfo();
        if (info) remember(link, { ...info, recoveryConfirmed: true });
        recovery = null;
        view = 'home';
        notice = 'Recovery link saved.';
        render();
      } catch (err) {
        if (err instanceof AccountError && err.code === 'recovery_changed') {
          // This code is no longer the account's: saving it would be saving
          // a dead link. Off the screen; the banner stays (still unconfirmed).
          recovery = null;
          view = 'home';
          notice = '';
          error = REPLACED_ELSEWHERE;
          render();
        } else showError(copyFor(err));
      } finally {
        busy = false;
        if (view === 'recovery') done.disabled = saved.checked !== true;
      }
    });
    screen.append(done, later);
    wrap.appendChild(screen);
    messages(wrap);
  }

  function render() {
    const hadFocus = within(host, document.activeElement);
    host.innerHTML = '';
    const wrap = el('div', { className: 'account-ui' });
    if (view === 'recovery') renderRecovery(wrap);
    else if (FORMS[view]) renderForm(wrap);
    else renderHome(wrap);
    host.appendChild(wrap);
    // #15: the focused control went with the old tree; without this, focus
    // falls to the top of the document.
    if (hadFocus && focusTarget && !within(host, document.activeElement)) focusTarget.focus({ preventScroll: true });
  }

  // #14: a form opened from outside (a boot link, the banner) can be far
  // below the top of the panel.
  function reveal() {
    if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'start' });
  }

  function focusFirstEmpty() {
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tagName === 'INPUT' && c.type !== 'checkbox' && !c.value) return c;
        const f = walk(c);
        if (f) return f;
      }
      return null;
    };
    const target = walk(host);
    if (target) target.focus({ preventScroll: true });
  }

  function goForm(name) {
    view = name;
    error = '';
    notice = '';
    render();
    focusFirstEmpty();
  }

  // --- the handle ------------------------------------------------------------

  // intent: null (the Account home) or {kind, code?} from a boot fragment, the
  // banner, or a button. NEVER makes a request. Login, sign-up and reset are
  // reachable only on an unlinked device (D17).
  function open(next) {
    error = '';
    notice = '';
    if (!next) { view = 'home'; render(); return; }
    const { kind } = next;
    if (kind === 'invite' || kind === 'recover' || kind === 'login') {
      const legacyHolder = getLink() !== null && accountModeFromStorage() === 'legacy';
      if (getLink() !== null && !(legacyHolder && next.code)) {
        view = 'home';
        error = alreadyLinkedCopy();
        render();
        return;
      }
      prefill = {
        invite: kind === 'invite' ? (next.code || '') : '',
        recovery: kind === 'recover' ? (next.code || '') : '',
      };
      goForm(kind === 'invite' ? 'signup' : kind === 'recover' ? 'forgot' : 'login');
      // W3-I6: js/fragment.js could not read a code out of the link.
      if (next.malformed) showError('That link looks damaged — paste the code instead.');
      // #19: a boot link opened on a linked legacy device. js/fragment.js has
      // already stripped it from the URL, so the form keeps it; its submit
      // stays refused (D17) until the device is unlinked in Sync.
      else if (legacyHolder) showError(alreadyLinkedCopy());
      return;
    }
    if (kind === 'new-recovery') {
      if (accountModeFromStorage() !== 'account') { view = 'home'; render(); return; }
      goForm('new-recovery');
      return;
    }
    throw new Error(`accountui: unknown intent ${kind}`);
  }

  // D27: revoke this session if reachable, then linkui's signOutLocal().
  // localOwner is kept (D16). Returns signOutLocal()'s result, which linkui's
  // own Sign out (options.onSignOut) shows when it is a refusal (ruling R12).
  // A retry after a refusal is safe: logOut treats a 401 as revoked.
  async function signOut() {
    // Asked FIRST: logOut revokes the session, and a signOutLocal() refusal
    // after that would leave this device linked on a dead one (linkui's own
    // Sign out checks the same way before onSignOut). No request is made.
    if (signOutBlocked()) {
      view = 'home';
      error = ACCOUNT_COPY.sign_out_refused;
      notice = '';
      render();
      return 'refused_write_in_flight';
    }
    const link = getLink();
    let revoked = true;
    if (link) revoked = (await api.logOut({ link })).revoked === true;
    const result = signOutLocal();
    if (result !== 'signed_out') {
      view = 'home';
      error = ACCOUNT_COPY.sign_out_refused;
      notice = '';
      render();
      return result;
    }
    paintBanner();
    devices = null;
    recovery = null;
    view = 'home';
    error = '';
    notice = revoked ? '' : REVOKE_FAILED_TEXT;
    render();
    return result;
  }

  // Sign in on an account device whose session was deleted (§ 6.10), or
  // whose saved key cannot read the account (linkui's undecryptable): the
  // session may still be live in that second case, so it is revoked best
  // effort first (sweep W3-I12; logOut never throws, and a 401 is the goal
  // already met). Then sign out locally, then the sign-in form. Asked first,
  // as signOut does: revoking and then being refused would strand the device
  // on a dead session.
  async function signIn() {
    if (signOutBlocked()) {
      view = 'home';
      error = ACCOUNT_COPY.sign_out_refused;
      render();
      return 'refused_write_in_flight';
    }
    // The check above and the revoke below have no await between them.
    // RESIDUAL WINDOW (controller ruling R13, as for signOut): an adoption
    // write or sync that starts while logOut is on the network still gets
    // revoke-then-refuse. It is one request long; that write then meets a 401
    // (no data loss), the refusal is SAID below, and the next 401 brings the
    // device back to Sign in, where a retry is safe (logOut treats a 401 as
    // revoked).
    const link = getLink();
    if (link) await api.logOut({ link });
    const result = signOutLocal();
    if (result !== 'signed_out') {
      view = 'home';
      error = ACCOUNT_COPY.sign_out_refused;
      render();
      return result;
    }
    paintBanner();
    open({ kind: 'login' });
    return result;
  }

  const mine = {
    refresh: () => { if (view === 'home') render(); },
    modeChanged: () => onAccountChanged(),
  };
  live = mine;

  if (intent) { open(intent); reveal(); } else render();

  // settings.js asks before Escape or a backdrop tap closes the panel (sweep
  // W3-I1b): not while a recovery code is on screen. NOT while a submit is
  // merely out (W3 re-review): a request that never settled locked the user
  // in Settings. A submit whose answer lands after the panel closed renders
  // into the detached host; an unconfirmed recovery link is then caught by
  // D8's banner.
  const holdsPanel = () => view === 'recovery';

  // settings.js calls this on close (W3 re-review): a late GET /account
  // answer must not re-mount linkui into a panel that is gone.
  function detach() {
    if (live === mine) live = null;
  }

  function openFromOutside(next) {
    open(next);
    if (next) reveal();
  }

  return { open: openFromOutside, signOut, signIn, holdsPanel, detach };
}
