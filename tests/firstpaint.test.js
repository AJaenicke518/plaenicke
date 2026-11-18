// The first paint on a computer shows the layout's own calendar (Week in the
// planner), not Day: app.js seeds the calendar BEFORE its first showView. Only
// load can show it, so this file's one import of app.js happens with the
// desktop gate already matching. Setup mirrors tests/weekstartinit.test.js.
process.env.TZ = 'America/Los_Angeles';
import './offline-fetch.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeLocalStorage } from './fake-localstorage.js';
import { makeFakeDocument, makeFakeWindow, mountIds, indexHtmlIds } from './fake-dom.js';
import { DESKTOP_QUERY } from '../js/layout.js';

globalThis.setInterval = () => 'interval';
globalThis.clearInterval = () => {};
globalThis.setTimeout = () => ({ recorded: true });
globalThis.clearTimeout = () => {};
globalThis.window = makeFakeWindow();
globalThis.window.matchMedia = (query) => ({
  media: query, matches: query === DESKTOP_QUERY, addEventListener() {},
});
globalThis.document = makeFakeDocument();
mountIds(globalThis.document, indexHtmlIds(readFileSync(new URL('../index.html', import.meta.url), 'utf8')));

test('first paint at desktop size seeds the planner\'s Week before the panes are chosen', async () => {
  installFakeLocalStorage();
  await import('../js/app.js');
  const hidden = (id) => globalThis.document.getElementById(id).hidden;
  assert.equal(hidden('today-view'), false);
  assert.equal(hidden('week-view'), false, 'the calendar beside Today is the planner\'s Week');
  assert.equal(hidden('day-view'), true, 'not Day');
});
