// A stored 'mon' must be honoured by app.js's module-load week cursor. Only
// load can show it (the cursor is re-anchored on every later pref change), so
// this file seeds storage BEFORE the one import of app.js its process makes.
// The setup mirrors tests/apply.test.js: offline fetch first, timers and
// intervals recorded (never scheduled) so the process exits, every id
// index.html declares mounted.
process.env.TZ = 'America/Los_Angeles';
import './offline-fetch.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { makeFakeDocument, makeFakeWindow, mountIds, indexHtmlIds } from './fake-dom.js';
import { addDays, startOfWeek, weekLabel } from '../js/timegrid.js';

globalThis.setInterval = () => 'interval';
globalThis.clearInterval = () => {};
globalThis.setTimeout = () => ({ recorded: true });
globalThis.clearTimeout = () => {};
globalThis.window = makeFakeWindow();
globalThis.document = makeFakeDocument();
mountIds(globalThis.document, indexHtmlIds(readFileSync(new URL('../index.html', import.meta.url), 'utf8')));

const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('a stored Monday week start anchors the Week view at module load', async () => {
  const ls = installFakeLocalStorage();
  ls.setItem('plaenicke.weekStart', 'mon');
  await import('../js/app.js');
  const monday = startOfWeek(localISO(new Date()), 'mon');
  assert.notEqual(monday, startOfWeek(localISO(new Date())), 'fixture check: the two anchors differ');
  assert.equal(globalThis.document.getElementById('week-label').textContent, weekLabel(monday, addDays(monday, 6)));
});
