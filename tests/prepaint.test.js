// The inline pre-paint script in index.html is a hand copy of the resolvers in
// js/theme.js and js/prefs.js. It runs before any module loads, so it cannot
// import them; this file extracts it and runs it with stubs to keep the copy
// honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHEMES, resolveScheme, LAYOUTS, resolveLayout } from '../js/prefs.js';
import { resolveTheme } from '../js/theme.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(m, 'index.html has an inline pre-paint script');
const SRC = m[1];

// Runs the script; `store` maps key -> value, or is a function that throws.
function run({ store = {}, matchMedia, throwStorage = false } = {}) {
  const root = { dataset: {} };
  const document = { documentElement: root };
  const localStorage = {
    getItem(k) {
      if (throwStorage) throw new Error('denied');
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
  };
  const window = matchMedia === undefined ? {} : { matchMedia };
  let thrown = null;
  try { new Function('document', 'localStorage', 'window', SRC)(document, localStorage, window); } catch (e) { thrown = e; }
  return { dataset: root.dataset, thrown };
}
const systemDark = (dark) => () => ({ matches: dark });

test('pre-paint: the scheme matches resolveScheme for every scheme, bogus and null', () => {
  for (const raw of [...SCHEMES, 'bogus', null]) {
    const store = raw === null ? {} : { 'plaenicke.scheme': raw };
    const { dataset } = run({ store, matchMedia: systemDark(false) });
    const want = resolveScheme(raw);
    assert.equal(dataset.scheme, want === 'classic' ? undefined : want, `stored ${raw}`);
  }
});

test('pre-paint: theme behaviour is unchanged', () => {
  assert.equal(run({ store: { 'plaenicke.theme': 'dark' }, matchMedia: systemDark(false) }).dataset.theme, 'dark');
  assert.equal(run({ store: { 'plaenicke.theme': 'light' }, matchMedia: systemDark(true) }).dataset.theme, undefined);
  assert.equal(run({ matchMedia: systemDark(true) }).dataset.theme, 'dark');
  assert.equal(run({ matchMedia: systemDark(false) }).dataset.theme, undefined);
});

test('pre-paint: the theme equals resolveTheme for every stored value, known or not, with the system dark or light', () => {
  for (const raw of ['dark', 'light', 'auto', null, 'Dark', 'bogus', '']) {
    for (const sysDark of [true, false]) {
      const store = raw === null ? {} : { 'plaenicke.theme': raw };
      const { dataset } = run({ store, matchMedia: systemDark(sysDark) });
      const want = resolveTheme(raw, sysDark);
      assert.equal(dataset.theme, want === 'dark' ? 'dark' : undefined, `stored ${JSON.stringify(raw)}, system dark ${sysDark}`);
    }
  }
});

test('pre-paint: with window.matchMedia undefined nothing throws, the theme falls back to light and the scheme is still applied', () => {
  for (const themeSetting of [null, 'auto', 'light', 'bogus']) {
    const store = { 'plaenicke.scheme': 'plum' };
    if (themeSetting !== null) store['plaenicke.theme'] = themeSetting;
    const { dataset, thrown } = run({ store });
    assert.equal(thrown, null, `theme ${themeSetting}: no throw`);
    assert.equal(dataset.scheme, 'plum', `theme ${themeSetting}: scheme applied`);
    assert.equal(dataset.theme, undefined, `theme ${themeSetting}: light`);
  }
  // An explicit dark still wins without matchMedia.
  assert.equal(run({ store: { 'plaenicke.theme': 'dark' } }).dataset.theme, 'dark');
});

test('pre-paint: a throwing localStorage applies nothing and does not throw', () => {
  const { dataset, thrown } = run({ throwStorage: true, matchMedia: systemDark(false) });
  assert.equal(thrown, null);
  assert.deepEqual(dataset, { layout: 'planner' }, 'the layout still resolves to its default');
});

test('pre-paint: the scheme logic comes before the theme logic, in its own try block', () => {
  const scheme = SRC.indexOf('plaenicke.scheme');
  const theme = SRC.indexOf('plaenicke.theme');
  assert.ok(scheme > -1 && theme > -1 && scheme < theme);
  assert.ok(SRC.slice(0, theme).includes('catch'), 'a catch closes the scheme block before theme starts');
});

test('pre-paint stays ES5: no arrow functions, let, const or template literals', () => {
  assert.doesNotMatch(SRC, /=>|\blet\b|\bconst\b|`/);
});

test('pre-paint: the layout equals resolveLayout for every layout, bogus and null', () => {
  for (const raw of [...LAYOUTS, 'bogus', 'ALL', '', null]) {
    const store = raw === null ? {} : { 'plaenicke.layout': raw };
    const { dataset } = run({ store, matchMedia: systemDark(false) });
    assert.equal(dataset.layout, resolveLayout(raw), `stored ${JSON.stringify(raw)}`);
  }
});

test('pre-paint: the layout is applied even when window.matchMedia is undefined', () => {
  const { dataset } = run({ store: { 'plaenicke.layout': 'all' } });
  assert.equal(dataset.layout, 'all');
});

test('pre-paint: the layout logic is in its own try block, before the theme logic', () => {
  const layout = SRC.indexOf('plaenicke.layout');
  const theme = SRC.indexOf('plaenicke.theme');
  assert.ok(layout > -1 && layout < theme);
  assert.ok(SRC.slice(layout, theme).includes('catch'), 'a catch closes the layout block before theme starts');
  assert.ok(SRC.indexOf('plaenicke.scheme') < layout, 'scheme block first');
});

test('pre-paint: a throwing storage for the layout alone does not stop the scheme', () => {
  const root = { dataset: {} };
  const localStorage = { getItem: (k) => { if (k === 'plaenicke.layout') throw new Error('x'); return k === 'plaenicke.scheme' ? 'plum' : null; } };
  new Function('document', 'localStorage', 'window', SRC)({ documentElement: root }, localStorage, { matchMedia: systemDark(false) });
  assert.equal(root.dataset.scheme, 'plum');
});
