import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import {
  TIME_FORMAT_KEY, WEEK_START_KEY, resolveTimeFormat, resolveWeekStart,
  getTimeFormat, getWeekStart, setTimeFormat, setWeekStart,
  LAYOUT_KEY, LAYOUTS, resolveLayout, getLayout, setLayout, applyLayout,
} from '../js/prefs.js';

test('keys are the documented names', () => {
  assert.equal(TIME_FORMAT_KEY, 'plaenicke.timeFormat');
  assert.equal(WEEK_START_KEY, 'plaenicke.weekStart');
});

test('resolveTimeFormat accepts only 12h/24h, else 12h', () => {
  assert.equal(resolveTimeFormat('24h'), '24h');
  assert.equal(resolveTimeFormat('12h'), '12h');
  for (const bad of [null, undefined, '', '24', 42, '24H']) assert.equal(resolveTimeFormat(bad), '12h');
});

test('resolveWeekStart accepts only sun/mon, else sun', () => {
  assert.equal(resolveWeekStart('mon'), 'mon');
  assert.equal(resolveWeekStart('sun'), 'sun');
  for (const bad of [null, undefined, '', 'monday', 1, 'MON']) assert.equal(resolveWeekStart(bad), 'sun');
});

test('get with an empty store gives defaults', () => {
  installFakeLocalStorage();
  assert.equal(getTimeFormat(), '12h');
  assert.equal(getWeekStart(), 'sun');
});

test('get ignores an unknown stored value', () => {
  const ls = installFakeLocalStorage();
  ls.setItem(TIME_FORMAT_KEY, 'bogus');
  ls.setItem(WEEK_START_KEY, 'bogus');
  assert.equal(getTimeFormat(), '12h');
  assert.equal(getWeekStart(), 'sun');
});

test('set and get round trip, writing the documented keys', () => {
  const ls = installFakeLocalStorage();
  assert.equal(setTimeFormat('24h'), true);
  assert.equal(setWeekStart('mon'), true);
  assert.equal(ls.getItem('plaenicke.timeFormat'), '24h');
  assert.equal(ls.getItem('plaenicke.weekStart'), 'mon');
  assert.equal(getTimeFormat(), '24h');
  assert.equal(getWeekStart(), 'mon');
});

test('set rejects an invalid value and writes nothing', () => {
  const ls = installFakeLocalStorage();
  assert.throws(() => setTimeFormat('25h'), /bad time format/);
  assert.throws(() => setWeekStart('tue'), /bad week start/);
  assert.equal(ls.getItem(TIME_FORMAT_KEY), null);
  assert.equal(ls.getItem(WEEK_START_KEY), null);
});

test('a localStorage that throws: get gives defaults, set returns false', () => {
  const ls = installFakeLocalStorage();
  ls.getItem = () => { throw new Error('denied'); };
  ls.setItem = () => { throw new Error('denied'); };
  assert.equal(getTimeFormat(), '12h');
  assert.equal(getWeekStart(), 'sun');
  assert.equal(setTimeFormat('24h'), false);
  assert.equal(setWeekStart('mon'), false);
});

test('a missing localStorage global also gives defaults', () => {
  delete globalThis.localStorage;
  try {
    assert.equal(getTimeFormat(), '12h');
    assert.equal(setWeekStart('mon'), false);
  } finally {
    installFakeLocalStorage();
  }
});

// --- colour scheme ---------------------------------------------------------
import {
  SCHEME_KEY, SCHEMES, resolveScheme, getScheme, setScheme, applyScheme,
} from '../js/prefs.js';

test('scheme key and list', () => {
  assert.equal(SCHEME_KEY, 'plaenicke.scheme');
  assert.deepEqual(SCHEMES, ['classic', 'sage', 'ocean', 'plum']);
});

test('resolveScheme accepts only known schemes, else classic', () => {
  for (const s of SCHEMES) assert.equal(resolveScheme(s), s);
  for (const bad of [null, undefined, '', 'Sage', 'bogus', 3]) assert.equal(resolveScheme(bad), 'classic');
});

test('getScheme / setScheme round trip and reject bad values', () => {
  const ls = installFakeLocalStorage();
  assert.equal(getScheme(), 'classic');
  assert.equal(setScheme('ocean'), true);
  assert.equal(ls.getItem('plaenicke.scheme'), 'ocean');
  assert.equal(getScheme(), 'ocean');
  assert.throws(() => setScheme('bogus'), /bad scheme/);
  assert.equal(ls.getItem('plaenicke.scheme'), 'ocean');
});

test('scheme storage that throws: get gives classic, set returns false', () => {
  const ls = installFakeLocalStorage();
  ls.getItem = () => { throw new Error('denied'); };
  ls.setItem = () => { throw new Error('denied'); };
  assert.equal(getScheme(), 'classic');
  assert.equal(setScheme('sage'), false);
});

test('applyScheme sets the attribute, and removes it for classic', () => {
  const root = { dataset: {} };
  applyScheme('sage', root);
  assert.equal(root.dataset.scheme, 'sage');
  applyScheme('classic', root);
  assert.equal('scheme' in root.dataset, false);
});

// --- desktop layout ------------------------------------------------------------

test('layout: key and list are the documented ones', () => {
  assert.equal(LAYOUT_KEY, 'plaenicke.layout');
  assert.deepEqual(LAYOUTS, ['planner', 'month', 'all']);
});

test('resolveLayout accepts only the three layouts, else planner', () => {
  for (const ok of LAYOUTS) assert.equal(resolveLayout(ok), ok);
  for (const bad of [null, undefined, '', 'Month', 'everything', 1, {}]) assert.equal(resolveLayout(bad), 'planner');
});

test('getLayout: empty store is planner; a stored value is read back', () => {
  installFakeLocalStorage();
  assert.equal(getLayout(), 'planner');
  localStorage.setItem(LAYOUT_KEY, 'all');
  assert.equal(getLayout(), 'all');
  localStorage.setItem(LAYOUT_KEY, 'junk');
  assert.equal(getLayout(), 'planner');
});

test('getLayout: a throwing localStorage is planner', () => {
  installFakeLocalStorage();
  const real = localStorage.getItem;
  localStorage.getItem = () => { throw new Error('denied'); };
  try { assert.equal(getLayout(), 'planner'); } finally { localStorage.getItem = real; }
});

test('setLayout stores and returns true; a bad value throws; a failed write returns false', () => {
  installFakeLocalStorage();
  assert.equal(setLayout('month'), true);
  assert.equal(localStorage.getItem(LAYOUT_KEY), 'month');
  assert.throws(() => setLayout('grid'), /bad layout/);
  assert.equal(localStorage.getItem(LAYOUT_KEY), 'month');
  const real = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('Quota'); };
  try { assert.equal(setLayout('all'), false); } finally { localStorage.setItem = real; }
});

test('applyLayout sets data-layout to every layout, planner included', () => {
  for (const l of LAYOUTS) {
    const root = { dataset: {} };
    applyLayout(l, root);
    assert.equal(root.dataset.layout, l);
  }
  const root = { dataset: {} };
  applyLayout('bogus', root);
  assert.equal(root.dataset.layout, 'planner');
});
