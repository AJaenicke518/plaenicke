// accountui.js — the Account section, its forms, the recovery screen and the
// app-shell banner (accounts spec §§ 6.1–6.7, 6.10, D8, D16, D17, D27).
//
// js/account.js is INJECTED as `api` everywhere here, so no test runs PBKDF2
// and no test reaches a server. The offline fetch is imported first anyway:
// a call that slips past the injection rejects instead of leaving the process.
import './offline-fetch.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { makeFakeDocument, makeFakeWindow, allText, findAll } from './fake-dom.js';
import {
  initAccountUI, refreshAccount, initAccountBanner, errorCopy,
  BANNER_ID, BANNER_TEXT, REVOKE_FAILED_TEXT,
} from '../js/accountui.js';
import { AccountError, recoveryLink, mailtoHref } from '../js/account.js';
import { ACCOUNT_COPY, initLinkUI, accountModeFromStorage } from '../js/linkui.js';
import { checkPassword } from '../js/password-policy.js';
import { bytesToBase64url, generateEncKey, composeLinkCode, parseLinkCode } from '../js/crypto.js';
import {
  saveAuth, loadAuth, saveItems, saveLocalOwner, loadLocalOwner, loadLegacyOwner, saveLegacyOwner, loadSyncState,
} from '../js/storage.js';

// --- harness ---------------------------------------------------------------

const GOOD_PW = 'correct-horse-7!';
const API_NAMES = ['signUp', 'logIn', 'recover', 'changePassword', 'newRecoveryLink', 'upgrade',
  'getAccount', 'listDevices', 'signOutOthers', 'confirmRecovery', 'logOut'];

function setup() {
  globalThis.window = makeFakeWindow();
  globalThis.document = makeFakeDocument();
  installFakeLocalStorage();
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.hidden = true;
  document.body.appendChild(banner);
  const host = document.createElement('div');
  document.body.appendChild(host);
  initAccountBanner({ onOpen: () => {} }); // app.js always wires it; a test re-wires to observe
  return { host, banner };
}

// Every api function records its call; one the test did not supply rejects,
// so an unexpected request fails the test rather than passing silently.
function fakeApi(impl = {}, log = []) {
  const calls = [];
  const api = {};
  for (const name of API_NAMES) {
    api[name] = async (args) => {
      calls.push({ name, args });
      log.push(name);
      if (!impl[name]) throw new Error(`unexpected api.${name}`);
      return impl[name](args);
    };
  }
  return { api, calls };
}

const newToken = () => bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
const newCode = () => composeLinkCode(newToken(), generateEncKey());

// A linkui handle whose linkAndAdopt links the way the real one does when
// nothing blocks: the credential, then the owner.
function fakeLinkui(log = []) {
  return {
    async linkAndAdopt(code, { accountId }) {
      log.push('link');
      saveAuth(code);
      saveLocalOwner(accountId);
      return 'linked';
    },
  };
}

function byId(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = byId(c, id);
    if (f) return f;
  }
  return null;
}

function input(host, id, value) {
  const el = byId(host, id);
  assert.ok(el, `#${id} is rendered`);
  el.value = value;
  for (const fn of el._listeners.input || []) fn({ target: el });
  return el;
}

// Returns the handlers' own promises, so a test can await the submit itself
// settling — a deterministic signal, never a fixed number of ticks.
function submit(host) {
  const form = byId(host, 'acct-form');
  assert.ok(form, 'the form is rendered');
  let prevented = false;
  const settled = (form._listeners.submit || []).map((fn) => fn({ target: form, preventDefault() { prevented = true; } }));
  assert.equal(prevented, true, 'submit never navigates');
  return Promise.all(settled);
}

function click(el) {
  assert.ok(el, 'element exists');
  for (const fn of el._listeners.click || []) fn({ target: el, preventDefault() {} });
}

async function until(pred, rounds = 200) {
  for (let i = 0; i < rounds && !pred(); i += 1) await new Promise((r) => { setImmediate(r); });
  return pred();
}

const downloadTimers = [];
function mount(host, { api, linkui = fakeLinkui(), intent = null, onSignedOut = () => {} }) {
  return initAccountUI({
    host, api, linkui: () => linkui, intent, onSignedOut,
    setTimeoutImpl: (fn, ms) => { downloadTimers.push({ fn, ms }); },
  });
}

// A linked account device: credential + owner.
function linkedAccount(owner = 5) {
  const code = newCode();
  saveAuth(code);
  saveLocalOwner(owner);
  return parseLinkCode(code).authToken;
}

const errorText = (host) => byId(host, 'acct-error').textContent;

// No call anywhere may carry minKdfIters: the floor is account.js's own.
function assertNoMinKdfIters(calls) {
  for (const c of calls) {
    assert.ok(!(c.args && Object.prototype.hasOwnProperty.call(c.args, 'minKdfIters')), `${c.name} carries minKdfIters`);
  }
}

// --- 1. what each device sees ----------------------------------------------

test('accountui: an unlinked device shows Sign in, I have an invite, Forgot password', () => {
  const { host } = setup();
  const { api, calls } = fakeApi();
  mount(host, { api });
  assert.equal(byId(host, 'acct-login').textContent, 'Sign in');
  assert.equal(byId(host, 'acct-invite').textContent, 'I have an invite');
  assert.equal(byId(host, 'acct-forgot').textContent, 'Forgot password');
  assert.equal(byId(host, 'acct-signout'), null);
  assert.equal(calls.length, 0, 'no request on mount');
});

test('accountui: a linked account device shows its email, change password, new recovery link, devices, sign-out controls', async () => {
  const { host } = setup();
  linkedAccount(5);
  const { api, calls } = fakeApi({ getAccount: async () => ({ accountId: 5, email: 'a@x.de', recoveryConfirmed: true }) });
  await refreshAccount({ api });
  calls.length = 0;
  mount(host, { api });
  assert.match(allText(host), /a@x\.de/);
  assert.ok(byId(host, 'acct-change-password'));
  assert.ok(byId(host, 'acct-new-recovery'));
  assert.ok(byId(host, 'acct-devices'));
  assert.equal(byId(host, 'acct-signout-others').textContent, 'Sign out other devices');
  assert.equal(byId(host, 'acct-signout').textContent, 'Sign out');
  assert.equal(byId(host, 'acct-login'), null, 'no login on a linked device (D17)');
  assert.equal(calls.length, 0, 'opening Settings makes no request');
});

test('accountui: a legacy device whose account has no email shows Create your login', async () => {
  const { host } = setup();
  saveAuth(newCode());
  const { api } = fakeApi({ getAccount: async () => ({ accountId: 1, email: null, recoveryConfirmed: false }) });
  await refreshAccount({ api });
  mount(host, { api });
  assert.equal(byId(host, 'acct-upgrade').textContent, 'Create your login');
  assert.equal(byId(host, 'acct-signout'), null, 'a legacy device keeps linkui\'s Unlink, not Sign out');
});

test('accountui: a legacy device whose account was never checked offers Check again, never a guessed upgrade', async () => {
  const { host } = setup();
  saveAuth(newCode());
  const { api, calls } = fakeApi({ getAccount: async () => ({ accountId: 1, email: null, recoveryConfirmed: false }) });
  mount(host, { api });
  assert.equal(byId(host, 'acct-upgrade'), null);
  assert.equal(calls.length, 0);
  click(byId(host, 'acct-check'));
  assert.ok(await until(() => byId(host, 'acct-upgrade')));
  assert.deepEqual(calls.map((c) => c.name), ['getAccount']);
});

// --- 2. sign-up ------------------------------------------------------------

test('accountui: sign-up calls signUp, then linkAndAdopt, then shows the recovery screen', async () => {
  const { host } = setup();
  const log = [];
  const code = newCode();
  const { api, calls } = fakeApi({
    signUp: async () => ({ code, accountId: 7, recoveryCode: 'RECOVERYCODE1234567890' }),
  }, log);
  const linkui = {
    async linkAndAdopt(c, { accountId }) {
      log.push('link');
      assert.equal(c, code);
      assert.equal(accountId, 7);
      assert.equal(byId(host, 'acct-recovery-screen'), null, 'the recovery screen waits for the link');
      saveAuth(c);
      saveLocalOwner(accountId);
      return 'linked';
    },
  };
  mount(host, { api, linkui });
  click(byId(host, 'acct-invite'));
  input(host, 'acct-invite-code', 'INVITE123');
  input(host, 'acct-email', 'tester@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  assert.equal(byId(host, 'acct-submit').disabled, false);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  log.push('recovery-screen');
  assert.deepEqual(log, ['signUp', 'link', 'recovery-screen']);
  const args = calls[0].args;
  assert.deepEqual(Object.keys(args).sort(), ['deviceName', 'email', 'invite', 'password']);
  assert.equal(args.invite, 'INVITE123');
  assert.equal(args.email, 'tester@example.com');
  assert.equal(byId(host, 'acct-recovery-value').textContent, 'RECOVERYCODE1234567890');
  assert.equal(byId(host, 'acct-recovery-email').tagName, 'A');
  assert.equal(byId(host, 'acct-recovery-email').href, mailtoHref('tester@example.com', 'RECOVERYCODE1234567890'));
  assert.equal(byId(host, 'acct-recovery-email').textContent, 'Email it to me');
  assert.equal(byId(host, 'acct-recovery-copy').textContent, 'Copy');
  assert.equal(byId(host, 'acct-recovery-download').textContent, 'Download');
  assertNoMinKdfIters(calls);
});

test('accountui: sign-up on a device holding another account\'s planner is refused BEFORE any request', async () => {
  const { host } = setup();
  saveLocalOwner(5);
  saveItems([{ id: 'i1', title: 'mine', date: '2026-11-11', time: null, updatedAt: '2026-11-11T00:00:00.000Z' }]);
  const { api, calls } = fakeApi({ signUp: async () => { throw new Error('must not be called'); } });
  mount(host, { api });
  click(byId(host, 'acct-invite'));
  input(host, 'acct-invite-code', 'INVITE123');
  input(host, 'acct-email', 'tester@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), ACCOUNT_COPY.other_account_data);
  assert.equal(calls.length, 0, 'nothing was sent');
});

// --- 3/4. the recovery screen and the banner -------------------------------

test('accountui: Done is disabled until "I saved my recovery link" is ticked, then calls confirmRecovery and hides the banner', async () => {
  const { host, banner } = setup();
  initAccountBanner({ onOpen: () => {} });
  const code = newCode();
  const { api, calls } = fakeApi({
    signUp: async () => ({ code, accountId: 7, recoveryCode: 'RECOVERYCODE1234567890' }),
    confirmRecovery: async () => ({ ok: true }),
  });
  mount(host, { api });
  click(byId(host, 'acct-invite'));
  input(host, 'acct-invite-code', 'INVITE123');
  input(host, 'acct-email', 'tester@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  assert.equal(banner.hidden, false, 'unconfirmed: the banner shows on every device (D8)');
  const done = byId(host, 'acct-recovery-done');
  const saved = byId(host, 'acct-recovery-saved');
  assert.equal(done.textContent, 'Done');
  assert.equal(saved.type, 'checkbox');
  assert.match(allText(host), /I saved my recovery link/);
  assert.equal(done.disabled, true);
  click(done);
  assert.equal(calls.some((c) => c.name === 'confirmRecovery'), false, 'a disabled Done does nothing');
  saved.checked = true;
  for (const fn of saved._listeners.change || []) fn({ target: saved });
  assert.equal(done.disabled, false);
  click(done);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen') === null));
  const confirm = calls.find((c) => c.name === 'confirmRecovery');
  assert.ok(confirm);
  assert.equal(confirm.args.link.authToken, parseLinkCode(code).authToken);
  assert.equal(confirm.args.recoveryCode, 'RECOVERYCODE1234567890', 'W3-I2: the code on screen is what is confirmed');
  assert.equal(banner.hidden, true);
});

test('W3-I2: a code replaced on another device (409 recovery_changed) says so, leaves the screen and keeps the banner', async () => {
  const { host, banner } = setup();
  initAccountBanner({ onOpen: () => {} });
  const { api } = fakeApi({
    signUp: async () => ({ code: newCode(), accountId: 7, recoveryCode: 'RECOVERYCODE1234567890' }),
    confirmRecovery: async () => { throw new AccountError('recovery_changed', {}, 409); },
  });
  mount(host, { api });
  click(byId(host, 'acct-invite'));
  input(host, 'acct-invite-code', 'INVITE123');
  input(host, 'acct-email', 'tester@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  const saved = byId(host, 'acct-recovery-saved');
  saved.checked = true;
  for (const fn of saved._listeners.change || []) fn({ target: saved });
  click(byId(host, 'acct-recovery-done'));
  assert.ok(await until(() => byId(host, 'acct-recovery-screen') === null));
  assert.equal(errorText(host), 'This recovery link was replaced on another device — make a new one.');
  assert.equal(byId(host, 'acct-recovery-value'), null, 'the dead code is no longer on screen');
  assert.ok(byId(host, 'acct-new-recovery'), 'Make a new recovery link is one tap away');
  assert.equal(banner.hidden, false, 'still unconfirmed: the banner stays');
});

test('accountui: a failed confirmRecovery keeps the recovery screen and says why', async () => {
  const { host } = setup();
  const { api } = fakeApi({
    signUp: async () => ({ code: newCode(), accountId: 7, recoveryCode: 'RECOVERYCODE1234567890' }),
    confirmRecovery: async () => { throw new AccountError('unreachable'); },
  });
  mount(host, { api });
  click(byId(host, 'acct-invite'));
  input(host, 'acct-invite-code', 'INVITE123');
  input(host, 'acct-email', 'tester@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  const saved = byId(host, 'acct-recovery-saved');
  saved.checked = true;
  for (const fn of saved._listeners.change || []) fn({ target: saved });
  click(byId(host, 'acct-recovery-done'));
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), "Can't reach the server. Check your connection.");
  assert.ok(byId(host, 'acct-recovery-screen'), 'the code is still on screen');
});

test('accountui: the banner shows while recoveryConfirmed is false on load, and its button opens Make a new recovery link', async () => {
  const { banner } = setup();
  linkedAccount(5);
  const opened = [];
  initAccountBanner({ onOpen: () => opened.push('new-recovery') });
  const { api } = fakeApi({ getAccount: async () => ({ accountId: 5, email: 'a@x.de', recoveryConfirmed: false }) });
  assert.equal(await refreshAccount({ api }), 'ok');
  assert.equal(banner.hidden, false);
  assert.match(allText(banner), new RegExp(BANNER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(BANNER_TEXT, 'Save your recovery link — without it, a forgotten password means losing your planner.');
  const btn = findAll(banner, 'BUTTON')[0];
  assert.ok(btn);
  click(btn);
  assert.deepEqual(opened, ['new-recovery']);
});

test('accountui: a failed or malformed getAccount keeps the banner\'s last state and writes nothing', async () => {
  const { banner } = setup();
  saveAuth(newCode());
  initAccountBanner({ onOpen: () => {} });
  const good = fakeApi({ getAccount: async () => ({ accountId: 5, email: 'a@x.de', recoveryConfirmed: false }) });
  await refreshAccount({ api: good.api });
  assert.equal(banner.hidden, false, 'fixture check: painted');
  assert.equal(loadLocalOwner(), 5, 'fixture check: owner recorded');
  localStorage.removeItem('plaenicke.localOwner');
  const offline = fakeApi({ getAccount: async () => { throw new AccountError('unreachable'); } });
  assert.equal(await refreshAccount({ api: offline.api }), 'failed');
  assert.equal(banner.hidden, false, 'an offline load keeps the last painted state');
  for (const body of [
    { accountId: 0, email: 'a@x.de', recoveryConfirmed: true },
    { accountId: 1.5, email: 'a@x.de', recoveryConfirmed: true },
    { accountId: '5', email: 'a@x.de', recoveryConfirmed: true },
    { accountId: 5, email: 7, recoveryConfirmed: true },
    { accountId: 5, email: 'a@x.de', recoveryConfirmed: 'yes' },
    { accountId: 5, email: 'a@x.de' },
    null,
  ]) {
    const bad = fakeApi({ getAccount: async () => body });
    assert.equal(await refreshAccount({ api: bad.api }), 'failed', JSON.stringify(body));
    assert.equal(loadLocalOwner(), null, `never writes localOwner from ${JSON.stringify(body)}`);
    assert.equal(banner.hidden, false, 'and keeps the banner');
  }
  const confirmed = fakeApi({ getAccount: async () => ({ accountId: 5, email: 'a@x.de', recoveryConfirmed: true }) });
  await refreshAccount({ api: confirmed.api });
  assert.equal(banner.hidden, true, 'the next successful answer repaints it');
});

test('accountui: refreshAccount on an unlinked device makes no request and hides the banner', async () => {
  const { banner } = setup();
  initAccountBanner({ onOpen: () => {} });
  const { api, calls } = fakeApi();
  assert.equal(await refreshAccount({ api }), 'unlinked');
  assert.equal(calls.length, 0);
  assert.equal(banner.hidden, true);
});

// --- 15. app load on a legacy device ---------------------------------------

test('accountui: on a legacy device, getAccount with an email records localOwner (the second phone after the upgrade)', async () => {
  const { banner } = setup();
  saveAuth(newCode());
  initAccountBanner({ onOpen: () => {} });
  const { api } = fakeApi({ getAccount: async () => ({ email: 'a@x.de', accountId: 1, recoveryConfirmed: true }) });
  await refreshAccount({ api });
  assert.equal(loadLocalOwner(), 1);
  assert.equal(banner.hidden, true);
});

// Sweep W2-C1 (was: "email null writes nothing"). An unlinked legacy device
// with no owner tag let its account-1 planner — feed URLs included — be
// adopted into the next account to sign in on it (scen/s1b.mjs). Every
// validated answer now records the owner; the legacy-vs-account mode comes
// from plaenicke.legacyOwner, not from the owner tag's presence.
test('accountui: on a legacy device, getAccount with email null records owner 1 and keeps the legacy UI, with no banner', async () => {
  const { host, banner } = setup();
  saveAuth(newCode());
  initAccountBanner({ onOpen: () => {} });
  const { api } = fakeApi({ getAccount: async () => ({ email: null, accountId: 1, recoveryConfirmed: false }) });
  assert.equal(await refreshAccount({ api }), 'ok');
  assert.equal(loadLocalOwner(), 1, 'the planner here is account 1\'s');
  assert.equal(loadLegacyOwner(), 1, 'and account 1 has no login yet');
  assert.equal(accountModeFromStorage(), 'legacy');
  assert.equal(banner.hidden, true, 'a legacy account has no recovery link to save yet');
  mount(host, { api });
  assert.equal(byId(host, 'acct-upgrade').textContent, 'Create your login');
  assert.equal(byId(host, 'acct-signout'), null, 'still linkui\'s Unlink, not Sign out');
});

test('W2-C1: an email answer for the legacy owner clears the legacy marker (another device upgraded it)', async () => {
  setup();
  saveAuth(newCode());
  saveLocalOwner(1);
  saveLegacyOwner(1);
  const { api } = fakeApi({ getAccount: async () => ({ email: 'a@x.de', accountId: 1, recoveryConfirmed: true }) });
  assert.equal(await refreshAccount({ api }), 'ok');
  assert.equal(loadLegacyOwner(), null);
  assert.equal(accountModeFromStorage(), 'account');
});

// Sweep W2 observation (TEST C7): the owner tag is never overwritten by an
// answer naming a different account — that would hand this device's planner
// to it. The mismatch is a failed check, said, not a silent write.
test('W2-C1: an existing owner and an answer naming a different account — nothing overwritten, reported failed', async () => {
  const { banner } = setup();
  saveAuth(newCode());
  saveLocalOwner(5);
  initAccountBanner({ onOpen: () => {} });
  const { api } = fakeApi({ getAccount: async () => ({ email: null, accountId: 1, recoveryConfirmed: false }) });
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.equal(await refreshAccount({ api }), 'failed');
  } finally {
    console.error = origErr;
  }
  assert.equal(loadLocalOwner(), 5, 'not overwritten');
  assert.equal(loadLegacyOwner(), null, 'nothing recorded about the other account');
  assert.equal(banner.hidden, true);
  assert.ok(errors.some((e) => e.includes('owner_mismatch')), 'logged by name');
});

test('W2-C1: Create your login turns a legacy device into an account device', async () => {
  const { host } = setup();
  saveAuth(newCode());
  const { api } = fakeApi({
    getAccount: async () => ({ accountId: 1, email: null, recoveryConfirmed: false }),
    upgrade: async () => ({ recoveryCode: 'UPGRADERECOVERY1234567', accountId: 1 }),
  });
  await refreshAccount({ api });
  assert.equal(accountModeFromStorage(), 'legacy', 'fixture check');
  mount(host, { api });
  click(byId(host, 'acct-upgrade'));
  input(host, 'acct-upgrade-code', 'UPGRADECODE12345678901');
  input(host, 'acct-email', 'alex@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  assert.equal(loadLocalOwner(), 1);
  assert.equal(loadLegacyOwner(), null);
  assert.equal(accountModeFromStorage(), 'account');
});

test('accountui: an answer for a session that changed meanwhile is dropped', async () => {
  const { banner } = setup();
  saveAuth(newCode());
  initAccountBanner({ onOpen: () => {} });
  const { api } = fakeApi({
    getAccount: async () => {
      saveAuth(newCode()); // signed out and in again while the request was out
      return { email: 'a@x.de', accountId: 1, recoveryConfirmed: false };
    },
  });
  assert.equal(await refreshAccount({ api }), 'failed');
  assert.equal(loadLocalOwner(), null);
  assert.equal(banner.hidden, true);
});

// --- 5. error copy ---------------------------------------------------------

const MAPPED = {
  bad_credentials: 'Email or password is wrong.',
  invalid_invite: "That invite code doesn't work. Ask Alex for a new one.",
  email_taken: "There's already an account with that email. Sign in instead.",
  no_account: 'No account with that email.',
  disabled: 'This account is turned off. Ask Alex.',
  bad_recovery: "That recovery link doesn't match this email.",
  other_account_data: "This device holds another account's planner. Signing in here would copy it into that account.",
  dek_check_failed: "Something is wrong with this account's keys. Nothing was changed. Tell Alex.",
  wrong_key_on_device: "Something is wrong with this account's keys. Nothing was changed. Tell Alex.",
  kdf_iters_too_low: 'The server asked for unsafe settings. Nothing was sent.',
  unreachable: "Can't reach the server. Check your connection.",
  not_configured: "The server isn't set up right. Tell Alex.",
  at_rest_key_mismatch: "The server isn't set up right. Tell Alex.",
  server: "The server isn't set up right. Tell Alex.",
  no_password: 'This account has no password yet. Use Create your login.',
  password_changed: 'Your account changed on another device. Try again.',
  recovery_changed: 'Your account changed on another device. Try again.',
};

test('accountui: every mapped error code renders its exact copy in #acct-error (role=alert)', async () => {
  for (const [code, copy] of Object.entries(MAPPED)) {
    const { host } = setup();
    const { api } = fakeApi({ logIn: async () => { throw new AccountError(code); } });
    mount(host, { api });
    click(byId(host, 'acct-login'));
    input(host, 'acct-email', 'a@x.de');
    input(host, 'acct-password', 'whatever');
    submit(host);
    assert.ok(await until(() => errorText(host) !== ''), code);
    assert.equal(errorText(host), copy, code);
    assert.equal(byId(host, 'acct-error').getAttribute('role'), 'alert');
  }
});

test('accountui: locked names the local time of retryAt', async () => {
  const retryAt = '2026-11-11T21:30:00.000Z';
  const when = new Date(retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  assert.equal(errorCopy('locked', { retryAt }), `Too many tries. Try again after ${when}.`);
  const { host } = setup();
  const { api } = fakeApi({ logIn: async () => { throw new AccountError('locked', { retryAt }, 429); } });
  mount(host, { api });
  click(byId(host, 'acct-login'));
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-password', 'whatever');
  submit(host);
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), `Too many tries. Try again after ${when}.`);
});

test('accountui: an unmapped code shows itself — never a generic fallback', async () => {
  assert.equal(errorCopy('weird_code'), 'Unexpected error: weird_code');
  assert.equal(errorCopy('locked', {}), 'Unexpected error: locked', 'locked without a readable retryAt names the code');
  const { host } = setup();
  const { api } = fakeApi({ logIn: async () => { throw new AccountError('weird_code'); } });
  mount(host, { api });
  click(byId(host, 'acct-login'));
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-password', 'whatever');
  submit(host);
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), 'Unexpected error: weird_code');
});

test('accountui: the two linkui strings are linkui\'s own (ruling R2)', () => {
  assert.equal(errorCopy('other_account_data'), ACCOUNT_COPY.other_account_data);
  assert.equal(errorCopy('already_linked'), ACCOUNT_COPY.already_linked);
});

// --- 6. blocked inside linkAndAdopt ----------------------------------------

test('accountui: other_account_data from linkAndAdopt shows its copy, leaves nothing half-linked, and revokes the fresh session', async () => {
  const { host } = setup();
  const linkHost = document.createElement('div');
  document.body.appendChild(linkHost);
  const linkui = initLinkUI({ host: linkHost, applyState: (s) => s });
  const code = newCode();
  const { api, calls } = fakeApi({
    // Another tab synced a different account's planner in while the request
    // was out: the pre-check passed, linkui's own guard must catch it.
    signUp: async () => {
      saveLocalOwner(5);
      saveItems([{ id: 'i1', title: 'theirs', date: '2026-11-11', time: null, updatedAt: '2026-11-11T00:00:00.000Z' }]);
      return { code, accountId: 7, recoveryCode: 'RECOVERYCODE1234567890' };
    },
    logOut: async () => ({ revoked: true }),
  });
  mount(host, { api, linkui });
  click(byId(host, 'acct-invite'));
  input(host, 'acct-invite-code', 'INVITE123');
  input(host, 'acct-email', 'tester@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), `${ACCOUNT_COPY.other_account_data} Your account was created — sign in on another device, then make a new recovery link.`);
  assert.equal(loadAuth(), null, 'not linked');
  assert.equal(loadLocalOwner(), 5, 'the owner is untouched');
  assert.equal(byId(host, 'acct-recovery-screen'), null);
  const out = calls.find((c) => c.name === 'logOut');
  assert.ok(out, 'the new device row is not orphaned');
  assert.equal(out.args.link.authToken, parseLinkCode(code).authToken);
});

test('accountui: a linkAndAdopt that rejects (a post-link throw) shows a specific error and revokes nothing', async () => {
  const { host } = setup();
  const { api, calls } = fakeApi({ logIn: async () => ({ code: newCode(), accountId: 7, recoveryConfirmed: true }) });
  // linkui rejects only AFTER the link landed (the preview threw).
  const linkui = { linkAndAdopt: async (code, { accountId }) => { saveAuth(code); saveLocalOwner(accountId); throw new TypeError('preview blew up'); } };
  mount(host, { api, linkui });
  click(byId(host, 'acct-login'));
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-password', 'whatever');
  submit(host);
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), 'Signed in, but this device could not finish linking. See Sync below.');
  assert.deepEqual(calls.map((c) => c.name), ['logIn'], 'the device is linked: its session stays');
});

test('accountui: link_failed and joined_other from linkAndAdopt show their own copy (sweep W3-I8; was the bare code)', async () => {
  for (const outcome of ['link_failed', 'joined_other']) {
    const { host } = setup();
    const code = newCode();
    const { api, calls } = fakeApi({
      logIn: async () => ({ code, accountId: 7, recoveryConfirmed: true }),
      logOut: async () => ({ revoked: true }),
    });
    mount(host, { api, linkui: { linkAndAdopt: async () => outcome } });
    click(byId(host, 'acct-login'));
    input(host, 'acct-email', 'a@x.de');
    input(host, 'acct-password', 'whatever');
    submit(host);
    assert.ok(await until(() => errorText(host) !== ''), outcome);
    assert.equal(errorText(host), W3_MAPPED[outcome]);
    const out = calls.find((c) => c.name === 'logOut');
    assert.ok(out, `${outcome}: not linked, so the fresh session is revoked`);
    assert.equal(out.args.link.authToken, parseLinkCode(code).authToken);
  }
});

// --- 7. sign-out (D27) -----------------------------------------------------

test('accountui: sign-out offline unlinks, keeps localOwner, and says the session could not be revoked', async () => {
  const { host } = setup();
  linkedAccount(5);
  let signedOut = 0;
  const { api, calls } = fakeApi({ logOut: async () => ({ revoked: false }) });
  mount(host, { api, onSignedOut: () => { signedOut += 1; } });
  click(byId(host, 'acct-signout'));
  assert.ok(await until(() => loadAuth() === null));
  assert.equal(loadAuth(), null, 'unlinked (signOutLocal)');
  assert.equal(loadLocalOwner(), 5, 'localOwner is kept (D16)');
  assert.ok(await until(() => allText(host).includes(REVOKE_FAILED_TEXT)));
  assert.equal(REVOKE_FAILED_TEXT, "This device's session could not be revoked — use Sign out other devices from another device.");
  assert.deepEqual(calls.map((c) => c.name), ['logOut']);
  assert.ok(byId(host, 'acct-login'), 'back to the signed-out buttons');
  assert.equal(signedOut, 1, 'Settings is told, so the Sync section re-renders');
});

test('accountui: sign-out online shows no revoke warning and still keeps localOwner', async () => {
  const { host } = setup();
  const token = linkedAccount(5);
  const { api, calls } = fakeApi({ logOut: async () => ({ revoked: true }) });
  mount(host, { api });
  click(byId(host, 'acct-signout'));
  assert.ok(await until(() => loadAuth() === null && byId(host, 'acct-login')));
  assert.equal(calls[0].args.link.authToken, token);
  assert.ok(!allText(host).includes(REVOKE_FAILED_TEXT));
  assert.equal(loadLocalOwner(), 5);
});

test('accountui: the handle\'s signOut returns signOutLocal\'s result (linkui shows the refusal)', async () => {
  const { host } = setup();
  linkedAccount(5);
  const { api } = fakeApi({ logOut: async () => ({ revoked: true }) });
  const handle = mount(host, { api });
  assert.equal(await handle.signOut(), 'signed_out');
  assert.equal(loadAuth(), null);
});

test('accountui: signIn (linkui\'s Sign in on a revoked device) signs out locally and opens the login form', async () => {
  const { host } = setup();
  linkedAccount(5);
  const { api, calls } = fakeApi();
  const handle = mount(host, { api });
  assert.equal(handle.signIn(), 'signed_out');
  assert.equal(loadAuth(), null);
  assert.equal(loadLocalOwner(), 5);
  assert.ok(byId(host, 'acct-form'));
  assert.equal(byId(host, 'acct-password').autocomplete, 'current-password');
  assert.equal(calls.length, 0, 'the session is already gone: nothing to revoke');
});

// --- 8. the password policy ------------------------------------------------

function openForm(host, which) {
  click(byId(host, which));
  assert.ok(byId(host, 'acct-form'), `${which} opens a form`);
}

function policyItems(host) {
  return findAll(byId(host, 'acct-policy'), 'LI').map((li) => li.textContent);
}

for (const [label, prepare, opener, fill] of [
  ['sign-up', () => {}, 'acct-invite', (host) => { input(host, 'acct-invite-code', 'INV'); }],
  ['reset', () => {}, 'acct-forgot', (host) => { input(host, 'acct-recovery-code', 'RECOVERYCODE1234567890'); }],
  ['change-password', () => { linkedAccount(5); }, 'acct-change-password', (host) => { input(host, 'acct-current-password', 'old-one-1!'); }],
]) {
  test(`accountui: on the ${label} form the policy list updates on input and Submit waits for it and a matching confirm`, () => {
    const { host } = setup();
    prepare();
    const { api } = fakeApi();
    mount(host, { api });
    openForm(host, opener);
    fill(host);
    assert.equal(byId(host, 'acct-password').autocomplete, 'new-password');
    input(host, 'acct-email', 'alexander@example.com');
    input(host, 'acct-password', 'short');
    input(host, 'acct-password2', 'short');
    assert.deepEqual(policyItems(host), checkPassword('short', 'alexander@example.com').problems);
    assert.ok(policyItems(host).length > 0);
    assert.equal(byId(host, 'acct-submit').disabled, true, 'a failing policy gates Submit');
    input(host, 'acct-password', 'alexander-99!x');
    input(host, 'acct-password2', 'alexander-99!x');
    assert.deepEqual(policyItems(host), checkPassword('alexander-99!x', 'alexander@example.com').problems);
    assert.equal(byId(host, 'acct-submit').disabled, true, 'the email name is refused too');
    input(host, 'acct-password', GOOD_PW);
    assert.deepEqual(policyItems(host), []);
    assert.equal(byId(host, 'acct-submit').disabled, true, 'confirm differs');
    input(host, 'acct-password2', GOOD_PW);
    assert.equal(byId(host, 'acct-submit').disabled, false);
  });
}

test('accountui: a gated form refuses a submit (Enter) while the policy fails, and sends nothing', async () => {
  const { host } = setup();
  const { api, calls } = fakeApi({ signUp: async () => { throw new Error('must not be called'); } });
  mount(host, { api });
  openForm(host, 'acct-invite');
  input(host, 'acct-invite-code', 'INV');
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-password', 'short');
  input(host, 'acct-password2', 'short');
  await submit(host); // the handler has returned: refused, or it would have called signUp
  assert.equal(calls.length, 0);
});

test('accountui: the login form shows no policy and never gates on it', async () => {
  const { host } = setup();
  const { api, calls } = fakeApi({ logIn: async () => { throw new AccountError('bad_credentials'); } });
  mount(host, { api });
  openForm(host, 'acct-login');
  assert.equal(byId(host, 'acct-policy'), null);
  assert.equal(byId(host, 'acct-password2'), null);
  assert.equal(byId(host, 'acct-password').autocomplete, 'current-password');
  assert.equal(byId(host, 'acct-email').type, 'email');
  assert.equal(byId(host, 'acct-email').autocomplete, 'username');
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-password', 'password');
  assert.equal(byId(host, 'acct-submit').disabled, false, 'a weak (old) password can still log in');
  submit(host);
  assert.ok(await until(() => calls.length === 1));
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['deviceName', 'email', 'password']);
});

// --- 9/16. boot intents: pre-filled, and no request ------------------------

test('accountui: intent invite opens the sign-up form pre-filled, with no request', () => {
  const { host } = setup();
  const { api, calls } = fakeApi();
  mount(host, { api, intent: { kind: 'invite', code: 'INVITEFROMLINK' } });
  assert.equal(byId(host, 'acct-invite-code').value, 'INVITEFROMLINK');
  assert.ok(byId(host, 'acct-password2'), 'the sign-up form');
  assert.equal(calls.length, 0);
});

test('accountui: intent recover opens the reset form pre-filled, with no request', () => {
  const { host } = setup();
  const { api, calls } = fakeApi();
  const handle = mount(host, { api });
  handle.open({ kind: 'recover', code: 'RECOVERYFROMLINK123456' });
  assert.equal(byId(host, 'acct-recovery-code').value, 'RECOVERYFROMLINK123456');
  assert.equal(byId(host, 'acct-password').autocomplete, 'new-password');
  assert.equal(calls.length, 0);
});

test('accountui: an invite intent on a linked device is refused with already_linked (D17), no request', () => {
  const { host } = setup();
  linkedAccount(5);
  const { api, calls } = fakeApi();
  mount(host, { api, intent: { kind: 'invite', code: 'X' } });
  assert.equal(byId(host, 'acct-invite-code'), null);
  assert.equal(errorText(host), ACCOUNT_COPY.already_linked);
  assert.equal(calls.length, 0);
});

// --- 13. login blocked after the response ----------------------------------

test('accountui: login into account 6 on a device holding account 5\'s planner logs the fresh session out and shows the copy', async () => {
  const { host } = setup();
  saveLocalOwner(5);
  saveItems([{ id: 'i1', title: 'mine', date: '2026-11-11', time: null, updatedAt: '2026-11-11T00:00:00.000Z' }]);
  const code = newCode();
  const log = [];
  const { api, calls } = fakeApi({
    logIn: async () => ({ code, accountId: 6, recoveryConfirmed: true }),
    logOut: async () => ({ revoked: true }),
  }, log);
  mount(host, { api, linkui: fakeLinkui(log) });
  openForm(host, 'acct-login');
  input(host, 'acct-email', 'b@x.de');
  input(host, 'acct-password', 'whatever');
  submit(host);
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), ACCOUNT_COPY.other_account_data);
  assert.deepEqual(log, ['logIn', 'logOut'], 'never linked');
  assert.equal(calls[1].args.link.authToken, parseLinkCode(code).authToken, 'with the NEW token');
  assert.equal(loadAuth(), null);
  assert.equal(loadLocalOwner(), 5);
});

test('accountui: login back into the same account (owner 5, data) links and paints the banner from the answer', async () => {
  const { host, banner } = setup();
  initAccountBanner({ onOpen: () => {} });
  saveLocalOwner(5);
  saveItems([{ id: 'i1', title: 'mine', date: '2026-11-11', time: null, updatedAt: '2026-11-11T00:00:00.000Z' }]);
  const log = [];
  const { api } = fakeApi({ logIn: async () => ({ code: newCode(), accountId: 5, recoveryConfirmed: false }) }, log);
  mount(host, { api, linkui: fakeLinkui(log) });
  openForm(host, 'acct-login');
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-password', 'whatever');
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-signout')));
  assert.deepEqual(log, ['logIn', 'link']);
  assert.match(allText(host), /a@x\.de/);
  assert.equal(banner.hidden, false);
});

test('accountui: login on a linked device is refused up front (already_linked), nothing sent', () => {
  const { host } = setup();
  const { api } = fakeApi();
  const handle = mount(host, { api });
  linkedAccount(5);
  handle.open({ kind: 'login' });
  assert.equal(byId(host, 'acct-form'), null);
  assert.equal(errorText(host), ACCOUNT_COPY.already_linked);
});

// --- 14. recover blocked before finish -------------------------------------

test('accountui: recover aborts in onAccountKnown when the device holds another account\'s planner — finish is never reached', async () => {
  const { host } = setup();
  saveLocalOwner(5);
  saveItems([{ id: 'i1', title: 'mine', date: '2026-11-11', time: null, updatedAt: '2026-11-11T00:00:00.000Z' }]);
  const log = [];
  const { api, calls } = fakeApi({
    recover: async ({ onAccountKnown }) => {
      log.push('recover/start');
      await onAccountKnown(6);
      log.push('recover/finish');
      return { code: newCode(), accountId: 6, recoveryCode: 'NEWRECOVERYCODE1234567' };
    },
  }, log);
  mount(host, { api, intent: { kind: 'recover', code: 'RECOVERYFROMLINK123456' } });
  input(host, 'acct-email', 'b@x.de');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), ACCOUNT_COPY.other_account_data);
  assert.deepEqual(log, ['recover', 'recover/start'], 'recover/finish was never reached');
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['deviceName', 'email', 'newPassword', 'onAccountKnown', 'recoveryCode']);
  assert.equal(loadAuth(), null);
});

test('accountui: recover into the same account links and shows the NEW recovery code', async () => {
  const { host } = setup();
  saveLocalOwner(6);
  const log = [];
  const { api, calls } = fakeApi({
    recover: async ({ onAccountKnown }) => {
      await onAccountKnown(6);
      log.push('recover/finish');
      return { code: newCode(), accountId: 6, recoveryCode: 'NEWRECOVERYCODE1234567' };
    },
  }, log);
  mount(host, { api, linkui: fakeLinkui(log), intent: { kind: 'recover', code: 'RECOVERYFROMLINK123456' } });
  input(host, 'acct-email', 'b@x.de');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  assert.deepEqual(log, ['recover', 'recover/finish', 'link']);
  assert.equal(byId(host, 'acct-recovery-value').textContent, 'NEWRECOVERYCODE1234567');
  assertNoMinKdfIters(calls);
});

// --- signed-in actions -----------------------------------------------------

test('accountui: upgrade (Create your login) saves localOwner, then shows the recovery screen', async () => {
  const { host } = setup();
  const token = parseLinkCode((() => { const c = newCode(); saveAuth(c); return c; })()).authToken;
  const { api, calls } = fakeApi({
    getAccount: async () => ({ accountId: 1, email: null, recoveryConfirmed: false }),
    upgrade: async () => ({ recoveryCode: 'UPGRADERECOVERY1234567', accountId: 1 }),
  });
  await refreshAccount({ api });
  mount(host, { api });
  click(byId(host, 'acct-upgrade'));
  assert.equal(byId(byId(host, 'acct-upgrade-code').parentNode, 'acct-upgrade-code').parentNode.children[0].textContent, 'Upgrade code from Alex');
  input(host, 'acct-upgrade-code', 'UPGRADECODE12345678901');
  input(host, 'acct-email', 'alex@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  assert.equal(loadLocalOwner(), 1, 'plan review I6');
  const up = calls.find((c) => c.name === 'upgrade');
  assert.deepEqual(Object.keys(up.args).sort(), ['email', 'link', 'password', 'upgradeCode']);
  assert.equal(up.args.upgradeCode, 'UPGRADECODE12345678901', 'W3-I3');
  assert.equal(up.args.link.authToken, token);
  assert.equal(byId(host, 'acct-recovery-value').textContent, 'UPGRADERECOVERY1234567');
  assertNoMinKdfIters(calls);
});

test('accountui: change password sends current + new + the sign-out-others choice', async () => {
  const { host } = setup();
  linkedAccount(5);
  const { api, calls } = fakeApi({
    getAccount: async () => ({ accountId: 5, email: 'a@x.de', recoveryConfirmed: true }),
    changePassword: async () => ({ ok: true }),
  });
  await refreshAccount({ api });
  mount(host, { api });
  click(byId(host, 'acct-change-password'));
  assert.equal(byId(host, 'acct-email').value, 'a@x.de', 'the email is known');
  input(host, 'acct-current-password', 'old-one-1!');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  const others = byId(host, 'acct-signout-others-too');
  others.checked = true;
  for (const fn of others._listeners.change || []) fn({ target: others });
  submit(host);
  assert.ok(await until(() => calls.some((c) => c.name === 'changePassword') && byId(host, 'acct-form') === null));
  const ch = calls.find((c) => c.name === 'changePassword');
  assert.deepEqual(Object.keys(ch.args).sort(), ['currentPassword', 'email', 'link', 'newPassword', 'signOutOthers']);
  assert.equal(ch.args.currentPassword, 'old-one-1!');
  assert.equal(ch.args.newPassword, GOOD_PW);
  assert.equal(ch.args.signOutOthers, true);
  assert.match(allText(host), /Password changed\./);
  assertNoMinKdfIters(calls);
});

test('accountui: Make a new recovery link asks for the password, then shows the recovery screen; the banner shows until Done', async () => {
  const { host, banner } = setup();
  initAccountBanner({ onOpen: () => {} });
  linkedAccount(5);
  const { api, calls } = fakeApi({
    getAccount: async () => ({ accountId: 5, email: 'a@x.de', recoveryConfirmed: true }),
    newRecoveryLink: async () => ({ recoveryCode: 'FRESHRECOVERY123456789' }),
  });
  await refreshAccount({ api });
  assert.equal(banner.hidden, true, 'fixture check');
  const handle = mount(host, { api });
  handle.open({ kind: 'new-recovery' });
  assert.equal(byId(host, 'acct-policy'), null, 'the current password is not policed');
  input(host, 'acct-current-password', 'old-one-1!');
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  const nr = calls.find((c) => c.name === 'newRecoveryLink');
  assert.deepEqual(Object.keys(nr.args).sort(), ['currentPassword', 'email', 'link']);
  assert.equal(byId(host, 'acct-recovery-value').textContent, 'FRESHRECOVERY123456789');
  assert.equal(byId(host, 'acct-recovery-email').href, mailtoHref('a@x.de', 'FRESHRECOVERY123456789'));
  assert.equal(banner.hidden, false, 'the server cleared recovery_confirmed_at');
});

test('accountui: devices load on request and list each, marking this one', async () => {
  const { host } = setup();
  linkedAccount(5);
  const { api, calls } = fakeApi({
    listDevices: async () => ({
      devices: [
        { name: 'iPhone', createdAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-10T00:00:00.000Z', current: true },
        { name: 'Mac', createdAt: '2026-11-02T00:00:00.000Z', lastSeenAt: null, current: false },
      ],
    }),
  });
  mount(host, { api });
  assert.equal(calls.length, 0);
  click(byId(host, 'acct-devices-load'));
  assert.ok(await until(() => findAll(byId(host, 'acct-devices'), 'LI').length === 2));
  const items = findAll(byId(host, 'acct-devices'), 'LI').map((li) => allText(li));
  assert.match(items[0], /iPhone/);
  assert.match(items[0], /this device/);
  assert.match(items[1], /Mac/);
  assert.doesNotMatch(items[1], /this device/);
});

test('accountui: a malformed devices answer is an error, not an empty list', async () => {
  const { host } = setup();
  linkedAccount(5);
  const { api } = fakeApi({ listDevices: async () => ({ devices: [{ name: 3 }] }) });
  mount(host, { api });
  click(byId(host, 'acct-devices-load'));
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), "The server isn't set up right. Tell Alex.");
});

test('accountui: Sign out other devices calls signOutOthers and says so', async () => {
  const { host } = setup();
  linkedAccount(5);
  const { api, calls } = fakeApi({ signOutOthers: async () => ({ signedOut: 2 }) });
  mount(host, { api });
  click(byId(host, 'acct-signout-others'));
  assert.ok(await until(() => allText(host).includes('Other devices were signed out.')));
  assert.deepEqual(calls.map((c) => c.name), ['signOutOthers']);
});

test('accountui: the recovery screen\'s Download saves a .txt holding the link and the sentence', async () => {
  const { host } = setup();
  const { api } = fakeApi({ signUp: async () => ({ code: newCode(), accountId: 7, recoveryCode: 'RECOVERYCODE1234567890' }) });
  const made = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { made.push(blob); return 'blob:fake'; };
  URL.revokeObjectURL = () => {};
  const anchors = [];
  const realCreateEl = document.createElement;
  document.createElement = (tag) => {
    const el = realCreateEl(tag);
    if (tag === 'a') { el.click = () => anchors.push({ href: el.href, download: el.download }); }
    return el;
  };
  try {
    mount(host, { api });
    click(byId(host, 'acct-invite'));
    input(host, 'acct-invite-code', 'INV');
    input(host, 'acct-email', 'tester@example.com');
    input(host, 'acct-password', GOOD_PW);
    input(host, 'acct-password2', GOOD_PW);
    submit(host);
    assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
    click(byId(host, 'acct-recovery-download'));
    assert.equal(made.length, 1);
    const text = await made[0].text();
    assert.ok(text.includes(recoveryLink('RECOVERYCODE1234567890')));
    assert.ok(text.includes('If you forget your password, open this link to reset it.'));
    assert.deepEqual(anchors, [{ href: 'blob:fake', download: 'plaenicke-recovery-link.txt' }]);
    const revoke = downloadTimers.pop();
    assert.equal(revoke.ms, 1000, 'the blob URL is revoked a moment later, by an injected timer');
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    document.createElement = realCreateEl;
  }
});

// --- review fixes: a link that landed still owes its recovery code ----------

test('accountui: sign-up whose linkAndAdopt rejects AFTER the link still shows the recovery screen, with the error', async () => {
  const { host } = setup();
  const { api, calls } = fakeApi({ signUp: async () => ({ code: newCode(), accountId: 7, recoveryCode: 'RECOVERYCODE1234567890' }) });
  const linkui = { linkAndAdopt: async (code, { accountId }) => { saveAuth(code); saveLocalOwner(accountId); throw new TypeError('preview blew up'); } };
  mount(host, { api, linkui });
  click(byId(host, 'acct-invite'));
  input(host, 'acct-invite-code', 'INV');
  input(host, 'acct-email', 'tester@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  assert.equal(byId(host, 'acct-recovery-value').textContent, 'RECOVERYCODE1234567890');
  assert.equal(errorText(host), 'Signed in, but this device could not finish linking. See Sync below.');
  assert.deepEqual(calls.map((c) => c.name), ['signUp'], 'linked: nothing revoked');
});

test('accountui: a reset whose linkAndAdopt rejects AFTER the link still shows the NEW recovery code', async () => {
  const { host } = setup();
  const { api } = fakeApi({
    recover: async ({ onAccountKnown }) => { await onAccountKnown(6); return { code: newCode(), accountId: 6, recoveryCode: 'NEWRECOVERYCODE1234567' }; },
  });
  const linkui = { linkAndAdopt: async (code, { accountId }) => { saveAuth(code); saveLocalOwner(accountId); throw new TypeError('x'); } };
  mount(host, { api, linkui, intent: { kind: 'recover', code: 'RECOVERYFROMLINK123456' } });
  input(host, 'acct-email', 'b@x.de');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  assert.equal(byId(host, 'acct-recovery-value').textContent, 'NEWRECOVERYCODE1234567');
  assert.equal(errorText(host), 'Signed in, but this device could not finish linking. See Sync below.');
});

test('accountui: a reset blocked after recover/finish says the password was reset', async () => {
  const { host } = setup();
  const { api } = fakeApi({
    recover: async () => ({ code: newCode(), accountId: 6, recoveryCode: 'NEWRECOVERYCODE1234567' }),
    logOut: async () => ({ revoked: true }),
  });
  mount(host, { api, linkui: { linkAndAdopt: async () => 'link_failed' }, intent: { kind: 'recover', code: 'RECOVERYFROMLINK123456' } });
  input(host, 'acct-email', 'b@x.de');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  submit(host);
  assert.ok(await until(() => errorText(host) !== ''));
  assert.equal(errorText(host), `${W3_MAPPED.link_failed} Your password was reset — sign in with it, then make a new recovery link.`);
});

test('accountui: a new recovery link before any account check still shows the code, and leaves the banner to the next check', async () => {
  const { host, banner } = setup();
  linkedAccount(5);
  const { api } = fakeApi({ newRecoveryLink: async () => ({ recoveryCode: 'FRESHRECOVERY123456789' }) });
  const handle = mount(host, { api });
  handle.open({ kind: 'new-recovery' });
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-current-password', 'old-one-1!');
  submit(host);
  assert.ok(await until(() => byId(host, 'acct-recovery-screen')));
  assert.equal(banner.hidden, true, 'no account id was confirmed for this session, so nothing is remembered');
});

// W2 re-review: an answer for this session shows the stored link is the
// owner's, so linkui may preview a pending adoption on the now-owned device.
test('W2-rr: a validated getAccount records that this link belongs to the owner', async () => {
  setup();
  saveAuth(newCode());
  const { api } = fakeApi({ getAccount: async () => ({ email: null, accountId: 1, recoveryConfirmed: false }) });
  assert.equal(await refreshAccount({ api }), 'ok');
  assert.equal(loadSyncState().linkOwner, 1);
});

test('W2-rr: an owner-mismatch answer records nothing about the link', async () => {
  setup();
  saveAuth(newCode());
  saveLocalOwner(5);
  const { api } = fakeApi({ getAccount: async () => ({ email: null, accountId: 1, recoveryConfirmed: false }) });
  const origErr = console.error;
  console.error = () => {};
  try { assert.equal(await refreshAccount({ api }), 'failed'); } finally { console.error = origErr; }
  assert.equal(loadSyncState().linkOwner, null);
});

test('W3-I3: upgrade-code refusals have their own copy', () => {
  assert.equal(errorCopy('invalid_upgrade_code'), "That upgrade code doesn't work — it may be used or expired. Mint a new one (docs/admin.md).");
  assert.equal(errorCopy('missing_upgrade_code'), 'Paste the upgrade code first.');
});

// --- sweep W3: forms ---------------------------------------------------------

const RESET_LINK = 'https://ajaenicke518.github.io/plaenicke/#recover=AAAAAAAAAAAAAAAAAAAAAA';

function labelOf(host, id) {
  return byId(host, id).parentNode.children[0].textContent;
}

test('W3-C1: a whole recovery link pasted into Reset sends just its code', async () => {
  const { host } = setup();
  const { api, calls } = fakeApi({ recover: async () => { throw new AccountError('bad_recovery'); } });
  mount(host, { api });
  openForm(host, 'acct-forgot');
  assert.equal(labelOf(host, 'acct-recovery-code'), 'Recovery link or code');
  input(host, 'acct-recovery-code', `  ${RESET_LINK}\n`);
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  await submit(host);
  assert.equal(calls[0].args.recoveryCode, 'AAAAAAAAAAAAAAAAAAAAAA');
});

test('W3-C1: a whole invite link pasted into sign-up sends just its code', async () => {
  const { host } = setup();
  const { api, calls } = fakeApi({ signUp: async () => { throw new AccountError('invalid_invite'); } });
  mount(host, { api });
  openForm(host, 'acct-invite');
  assert.equal(labelOf(host, 'acct-invite-code'), 'Invite link or code');
  input(host, 'acct-invite-code', 'https://ajaenicke518.github.io/plaenicke/#invite=INVITECODE_x-1 ');
  input(host, 'acct-email', 'a@x.de');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  await submit(host);
  assert.equal(calls[0].args.invite, 'INVITECODE_x-1');
});

test('W3-C1: bad_recovery_code says what to paste', () => {
  assert.equal(errorCopy('bad_recovery_code'), "That isn't a recovery code — paste the whole link or the 22-character code.");
});

test('W3-I8: an email that is not an email is refused on the device, nothing sent', async () => {
  const { host } = setup();
  const { api, calls } = fakeApi();
  mount(host, { api });
  openForm(host, 'acct-login');
  input(host, 'acct-email', 'alex at example');
  input(host, 'acct-password', 'whatever');
  await submit(host);
  assert.equal(errorText(host), "That doesn't look like an email address.");
  assert.equal(calls.length, 0);
});

const W3_MAPPED = {
  already_upgraded: 'This account already has a login — it was made on another device.',
  unwrap_failed: "Something is wrong with this account's keys. Nothing was changed. Tell Alex.",
  bad_salt: "The server isn't set up right. Tell Alex.",
  kdf_iters_out_of_range: 'The server asked for unsafe settings. Nothing was sent.',
  bad_config: "The server isn't set up right. Tell Alex.",
  bad_seal: "The server isn't set up right. Tell Alex.",
  bad_request: "The app sent something the server didn't accept. Tell Alex.",
  joined_other: 'Another sign-in was already under way on this device. Wait for it to finish, then try again.',
  link_failed: 'This device could not be linked — the Sync section below says why.',
  blocked: "This device can't be linked to that account — the Sync section below says why.",
};

test('W3-I8: every code the client can meet has its own copy', () => {
  for (const [code, copy] of Object.entries(W3_MAPPED)) assert.equal(errorCopy(code), copy, code);
});

test('W3-I8: email_taken on Create your login names the other account, not "sign in instead"', async () => {
  const { host } = setup();
  saveAuth(newCode());
  const { api } = fakeApi({
    getAccount: async () => ({ accountId: 1, email: null, recoveryConfirmed: false }),
    upgrade: async () => { throw new AccountError('email_taken', {}, 409); },
  });
  await refreshAccount({ api });
  mount(host, { api });
  click(byId(host, 'acct-upgrade'));
  input(host, 'acct-upgrade-code', 'UPGRADECODE12345678901');
  input(host, 'acct-email', 'alex@example.com');
  input(host, 'acct-password', GOOD_PW);
  input(host, 'acct-password2', GOOD_PW);
  await submit(host);
  assert.equal(errorText(host), 'That email is used by another account.');
});

test('W3-I9: a confirm that differs says "Passwords don\'t match" (and only then)', () => {
  const { host } = setup();
  const { api } = fakeApi();
  mount(host, { api });
  openForm(host, 'acct-invite');
  const mismatch = () => byId(host, 'acct-mismatch').textContent;
  input(host, 'acct-password', GOOD_PW);
  assert.equal(mismatch(), '', 'an empty confirm is not a mismatch yet');
  input(host, 'acct-password2', 'correct-horse');
  assert.equal(mismatch(), "Passwords don't match");
  input(host, 'acct-password2', GOOD_PW);
  assert.equal(mismatch(), '');
});

test('W3-I9: every form keeps Submit disabled until its required fields are filled (login: no policy gate)', () => {
  const cases = [
    ['acct-login', () => {}, [['acct-email', 'a@x.de'], ['acct-password', 'x']]],
    ['acct-invite', () => {}, [['acct-invite-code', 'INV'], ['acct-email', 'a@x.de'], ['acct-password', GOOD_PW], ['acct-password2', GOOD_PW]]],
    ['acct-forgot', () => {}, [['acct-recovery-code', 'R'], ['acct-email', 'a@x.de'], ['acct-password', GOOD_PW], ['acct-password2', GOOD_PW]]],
    ['acct-new-recovery', () => linkedAccount(5), [['acct-email', 'a@x.de'], ['acct-current-password', 'old']]],
    ['acct-change-password', () => linkedAccount(5), [['acct-email', 'a@x.de'], ['acct-current-password', 'old'], ['acct-password', GOOD_PW], ['acct-password2', GOOD_PW]]],
  ];
  for (const [opener, prepare, fields] of cases) {
    const { host } = setup();
    prepare();
    mount(host, { api: fakeApi().api });
    openForm(host, opener);
    for (const [id] of fields) input(host, id, '');
    assert.equal(byId(host, 'acct-submit').disabled, true, `${opener}: empty`);
    for (const [id, v] of fields.slice(0, -1)) input(host, id, v);
    assert.equal(byId(host, 'acct-submit').disabled, true, `${opener}: last field empty`);
    const [lastId, lastV] = fields[fields.length - 1];
    input(host, lastId, lastV);
    assert.equal(byId(host, 'acct-submit').disabled, false, `${opener}: all filled`);
  }
});

test('W3 #11: the gate also follows change events (autofill fires change, not input)', () => {
  const { host } = setup();
  mount(host, { api: fakeApi().api });
  openForm(host, 'acct-login');
  const email = byId(host, 'acct-email');
  const pw = byId(host, 'acct-password');
  email.value = 'a@x.de';
  pw.value = 'from-keychain';
  for (const fn of pw._listeners.change || []) fn({ target: pw });
  assert.equal(byId(host, 'acct-submit').disabled, false);
});

test('W3 #13: invite, recovery and upgrade-code fields switch off autocorrect and autocomplete (attributes)', async () => {
  for (const [opener, id, prepare] of [['acct-invite', 'acct-invite-code'], ['acct-forgot', 'acct-recovery-code']]) {
    const { host } = setup();
    mount(host, { api: fakeApi().api });
    openForm(host, opener);
    assert.equal(byId(host, id).getAttribute('autocorrect'), 'off', id);
    assert.equal(byId(host, id).getAttribute('autocomplete'), 'off', id);
    assert.equal(byId(host, id).getAttribute('autocapitalize'), 'off', id);
    void prepare;
  }
  const { host } = setup();
  saveAuth(newCode());
  const { api } = fakeApi({ getAccount: async () => ({ accountId: 1, email: null, recoveryConfirmed: false }) });
  await refreshAccount({ api });
  mount(host, { api });
  click(byId(host, 'acct-upgrade'));
  assert.equal(byId(host, 'acct-upgrade-code').getAttribute('autocorrect'), 'off');
  assert.equal(byId(host, 'acct-upgrade-code').getAttribute('autocomplete'), 'off');
});

test('W3 #16: status, notice and policy are polite live regions; the error stays an alert', () => {
  const { host } = setup();
  mount(host, { api: fakeApi().api });
  openForm(host, 'acct-invite');
  for (const id of ['acct-status', 'acct-notice', 'acct-policy', 'acct-mismatch']) {
    assert.equal(byId(host, id).getAttribute('aria-live'), 'polite', id);
  }
  assert.equal(byId(host, 'acct-error').getAttribute('role'), 'alert');
});

test('W3 #18: it is "Sign in" everywhere, never "Log in"', () => {
  const { host } = setup();
  mount(host, { api: fakeApi().api });
  assert.equal(byId(host, 'acct-login').textContent, 'Sign in');
  openForm(host, 'acct-login');
  assert.equal(byId(host, 'acct-submit').textContent, 'Sign in');
  assert.doesNotMatch(allText(host), /Log in/i);
  assert.equal(errorCopy('email_taken'), "There's already an account with that email. Sign in instead.");
});

test('SEC #11: the recovery note says the link itself is the secret', async () => {
  const { RECOVERY_NOTE } = await import('../js/account.js');
  assert.match(RECOVERY_NOTE, /Anyone with this link can reset your password and read your planner\. Keep it private\.$/);
});
