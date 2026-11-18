// The inline pre-paint script in index.html is a hand copy of the resolvers in
// js/theme.js and js/prefs.js. It runs before any module loads, so it cannot
// import them; this file extracts it and runs it with stubs to keep the copy
// honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHEMES, resolveScheme } from '../js/prefs.js';

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

test('pre-paint: the scheme is applied even when window.matchMedia is undefined', () => {
  const { dataset } = run({ store: { 'plaenicke.scheme': 'plum' } });
  assert.equal(dataset.scheme, 'plum');
});

test('pre-paint: a throwing localStorage applies nothing and does not throw', () => {
  const { dataset, thrown } = run({ throwStorage: true, matchMedia: systemDark(false) });
  assert.equal(thrown, null);
  assert.deepEqual(dataset, {});
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
