import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, THEME_KEY } from '../js/theme.js';

test('explicit settings win regardless of system', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('auto and unknown settings follow the system', () => {
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme('garbage', false), 'light');
});

test('storage key is stable', () => {
  assert.equal(THEME_KEY, 'plaenicke.theme');
});
