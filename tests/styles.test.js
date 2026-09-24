import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// styles.test.js — the first CSS test in this repo, and it exists for one
// reason: the failure it guards is silent and visual, so nothing else can
// catch it.
//
// Body text got a looser line-height for readability (there was NO
// line-height rule at all before — everything ran at the browser default,
// roughly 1.2, which is tight for a serif read at arm's length on a phone).
//
// The dense grids must NOT inherit it. `.day-block` and `.day-pin` are
// absolutely positioned with heights computed in js/dayview.js from
// HOUR_PX = 48 — a 30-minute event is ~22px tall with `overflow: hidden`,
// so loosening the leading inside one silently clips its title. `.cal-item`
// is a single-line month chip that would grow its cell.
//
// Parses declarations rather than substring-searching, so a line-height
// mentioned in a comment cannot satisfy it — comments are stripped up front,
// which makes that true by construction. (The first draft of this file did
// NOT strip them and instead required each declaration to follow `;` or the
// start of the rule; every rule here that carries an explanatory comment
// above its line-height then read as having none. The test failed while the
// CSS was correct.)

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Return the last line-height declared in the rule whose selector list
// matches `selector` exactly, or null. Last wins, as in the cascade.
function lineHeightOf(selector) {
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  let found = null;
  for (const [, sel, body] of rules) {
    const selectors = sel.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    const m = [...body.matchAll(/(?:^|;)\s*line-height\s*:\s*([^;]+)/g)].pop();
    if (m) found = parseFloat(m[1]);
  }
  return found;
}

test('body sets a readable line-height', () => {
  const lh = lineHeightOf('body');
  assert.ok(lh !== null, 'body declares no line-height — the readability fix is gone');
  assert.ok(lh >= 1.4, `expected body line-height >= 1.4 for breathing room, got ${lh}`);
});

// The guard. Each of these renders text inside a box whose height is fixed
// by JS or by the grid, with overflow hidden.
for (const sel of ['.day-block', '.day-pin', '.cal-item']) {
  test(`${sel} keeps a tight line-height so its text is not clipped`, () => {
    const lh = lineHeightOf(sel);
    assert.ok(lh !== null,
      `${sel} declares no line-height, so it inherits body's — a 30-minute day block is ~22px tall with overflow:hidden and will clip its title`);
    assert.ok(lh <= 1.25, `expected ${sel} line-height <= 1.25, got ${lh}`);
  });
}

// --- the item sheet (edit-items plan, Task 3) ------------------------------
// Two silent, visual failures on iOS: a form control under 16px makes Safari
// zoom the whole page on focus, and a button under 44px is a missed tap.
// Existence is asserted FIRST, so deleting a rule fails loudly instead of
// "no declaration found, nothing to check".

// The last value of `prop` declared in any rule whose selector list contains
// `selector` exactly, or null.
function declOf(selector, prop) {
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  let found = null;
  for (const [, sel, body] of rules) {
    const selectors = sel.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'g');
    const m = [...body.matchAll(re)].pop();
    if (m) found = m[1].trim();
  }
  return found;
}

function ruleExists(selector) {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .some(([, sel]) => sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).includes(selector));
}

// In px, for the two units these rules use. Anything else is a test failure,
// not a pass: an unparsed unit must not read as "big enough".
function px(value) {
  const m = /^([\d.]+)(px|rem)$/.exec(value || '');
  assert.ok(m, `cannot read a px/rem length from ${JSON.stringify(value)}`);
  return m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
}

for (const sel of ['.sheet input', '.sheet select', '.sheet textarea']) {
  test(`${sel} is at least 16px, so iOS does not zoom on focus`, () => {
    assert.ok(ruleExists(sel), `no rule for ${sel}`);
    const fs = declOf(sel, 'font-size');
    assert.ok(fs !== null, `${sel} declares no font-size`);
    assert.ok(px(fs) >= 16, `expected ${sel} font-size >= 16px, got ${fs}`);
  });
}

test('.sheet button is at least 44px tall', () => {
  assert.ok(ruleExists('.sheet button'), 'no rule for .sheet button');
  const mh = declOf('.sheet button', 'min-height');
  assert.ok(mh !== null, '.sheet button declares no min-height');
  assert.ok(px(mh) >= 44, `expected .sheet button min-height >= 44px, got ${mh}`);
});

test('.sheet scrolls inside itself and clears the home indicator', () => {
  assert.equal(declOf('.sheet', 'max-height'), '85dvh');
  assert.equal(declOf('.sheet', 'overflow-y'), 'auto');
  assert.equal(declOf('.sheet', 'padding-bottom'), 'env(safe-area-inset-bottom)');
});
