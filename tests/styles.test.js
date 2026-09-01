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
