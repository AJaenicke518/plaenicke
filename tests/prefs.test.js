import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLocalStorage } from './fake-localstorage.js';
import {
  TIME_FORMAT_KEY, WEEK_START_KEY, resolveTimeFormat, resolveWeekStart,
  getTimeFormat, getWeekStart, setTimeFormat, setWeekStart,
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
