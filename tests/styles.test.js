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

// --- reading the WINNING declaration (sweep S-11) --------------------------
//
// Every declaration of every rule whose selector list contains `selector`
// exactly, in source order. Rules with the same selector have the same
// specificity, so the LAST declaration of a property wins, and a shorthand
// counts: `padding: 0` after `padding-bottom: 12px` resets the bottom.
// The first version of these helpers took the last LONGHAND only, so a later
// shorthand that undid it read as the longhand still being in force.
function declsOf(selector, source = css) {
  const out = [];
  for (const [, sel, body] of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = sel.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (!selectors.includes(selector)) continue;
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      out.push({ prop: decl.slice(0, i).trim().toLowerCase(), value: decl.slice(i + 1).trim() });
    }
  }
  return out;
}

const SIDES = ['top', 'right', 'bottom', 'left'];
// Each shorthand and the longhands it sets (only those this stylesheet uses).
const LONGHANDS = {
  padding: SIDES.map((x) => `padding-${x}`),
  margin: SIDES.map((x) => `margin-${x}`),
  overflow: ['overflow-x', 'overflow-y'],
  background: ['background-color', 'background-image'],
  font: ['font-size', 'font-family', 'font-weight', 'font-style', 'line-height'],
  border: ['border-color', 'border-width', 'border-style',
    ...SIDES.map((x) => `border-${x}`)],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
};
const SHORTHAND_OF = {};
for (const [sh, longs] of Object.entries(LONGHANDS)) for (const l of longs) SHORTHAND_OF[l] = sh;

// The winning value of `prop` for `selector`, or null if nothing sets it.
// When a shorthand wins, the longhand is read out of it where that is exact
// (box sides, overflow); anywhere else the test THROWS rather than guess.
function declOf(selector, prop, source = css) {
  const sh = SHORTHAND_OF[prop];
  const longs = LONGHANDS[prop] || [];
  const decls = declsOf(selector, source);
  let win = null;
  for (const d of decls) if (d.prop === prop || d.prop === sh) win = d;
  if (!win) return null;
  // Asking for a shorthand that a later longhand partly overrides: there is
  // no single value to return.
  const later = decls.slice(decls.indexOf(win) + 1).find((d) => longs.includes(d.prop));
  if (later) throw new Error(`${selector}: ${prop} is partly overridden by a later ${later.prop}`);
  if (win.prop === prop) return win.value;
  const parts = win.value.split(/\s+(?![^(]*\))/);
  if (sh === 'padding' || sh === 'margin') {
    const [t, r = t, b = t, l = r] = parts;
    return { top: t, right: r, bottom: b, left: l }[prop.split('-')[1]];
  }
  if (sh === 'overflow') return prop === 'overflow-x' ? parts[0] : (parts[1] || parts[0]);
  throw new Error(`${selector}: ${prop} is set by the shorthand ${win.prop}: ${win.value}; read that instead`);
}

// The winning line-height as a number, or null.
function lineHeightOf(selector) {
  const v = declOf(selector, 'line-height');
  return v === null ? null : parseFloat(v);
}

test('declOf reads the winning declaration, shorthands included (S-11)', () => {
  assert.equal(declOf('.a', 'padding-bottom', '.a { padding-bottom: 5px; padding: 1px 2px 3px; }'), '3px',
    'a later shorthand wins over an earlier longhand');
  assert.equal(declOf('.a', 'padding-bottom', '.a { padding: 1px; padding-bottom: 7px; }'), '7px');
  assert.equal(declOf('.a', 'padding-left', '.a { padding: 1px 2px; }'), '2px');
  assert.equal(declOf('.a', 'padding-bottom', '.a { padding: 0 16px; }'), '0');
  assert.equal(declOf('.a', 'padding-bottom', '.a { padding: calc(1px + 2px) 4px; }'), 'calc(1px + 2px)');
  assert.equal(declOf('.a', 'color', '.a { color: red; } .b { color: blue; } .a, .c { color: green; }'), 'green',
    'the later of two rules for the same selector wins');
  assert.equal(declOf('.a', 'color', '.a b { color: red; }'), null, 'a different selector is not this one');
  assert.equal(declOf('.a', 'overflow-y', '.a { overflow-y: auto; overflow: hidden; }'), 'hidden');
  assert.throws(() => declOf('.a', 'font-size', '.a { font-size: 16px; font: inherit; }'), /shorthand font/,
    'a font shorthand after the size cannot be read as a size; the test must fail, not pass');
  assert.throws(() => declOf('.a', 'padding', '.a { padding: 0; padding-top: 4px; }'), /partly overridden/);
  assert.equal(lineHeightOf('.x'), null);
});

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

// --- the open control (edit-items plan, Task 4a) ---------------------------
// Every item title is now a <button class="item-open">. The global `button`
// rule paints buttons as accent-filled chips with 10px 16px padding, so the
// reset is what keeps a title looking like a title. In a list it is a 44px
// tap target; inside a Day block (~22px tall, overflow hidden) that same
// minimum would push the title out of view, so the block override is pinned.

test('.item-open is reset to look like text', () => {
  assert.ok(ruleExists('.item-open'), 'no rule for .item-open');
  assert.equal(declOf('.item-open', 'background'), 'transparent');
  assert.equal(declOf('.item-open', 'color'), 'inherit');
  assert.equal(declOf('.item-open', 'font'), 'inherit');
  assert.equal(declOf('.item-open', 'text-align'), 'left');
  assert.equal(declOf('.item-open', 'padding'), '0');
  assert.equal(declOf('.item-open', 'width'), '100%');
});

test('.item-open is at least 44px tall in a list', () => {
  const mh = declOf('.item-open', 'min-height');
  assert.ok(mh !== null, '.item-open declares no min-height');
  assert.ok(px(mh) >= 44, `expected .item-open min-height >= 44px, got ${mh}`);
});

for (const sel of ['.day-block .item-open', '.day-pin .item-open']) {
  test(`${sel} drops the 44px minimum so the title stays visible in a ~22px block`, () => {
    assert.ok(ruleExists(sel), `no rule for ${sel}`);
    assert.equal(declOf(sel, 'min-height'), '0');
    assert.equal(declOf(sel, 'line-height'), 'inherit');
  });
}

// --- Task 3 review: layering and the sticky Save bar ------------------------
function zIndexOf(selector) {
  assert.ok(ruleExists(selector), `expected a ${selector} rule`);
  const z = declOf(selector, 'z-index');
  assert.ok(z !== null, `${selector} must set a z-index`);
  assert.match(z, /^\d+$/);
  return Number(z);
}

test('the toast sits above the sheet, which sits above settings', () => {
  assert.ok(zIndexOf('.toast') > zIndexOf('.sheet-backdrop'), 'an Undo must never be hidden under a sheet');
  assert.ok(zIndexOf('.sheet-backdrop') > zIndexOf('.settings-backdrop'));
});

test('the sheet top bar is sticky, so Save stays reachable while the form scrolls', () => {
  assert.ok(ruleExists('.sheet-bar'), 'expected a .sheet-bar rule');
  assert.equal(declOf('.sheet-bar', 'position'), 'sticky');
  assert.equal(declOf('.sheet-bar', 'top'), '0');
});

// --- Task 4b (Task 2 review, O1): the toast must never cover the last row ---
// .toast is position: fixed at the bottom. Without room under the content,
// the final list row — often the very item whose delete it offers to undo —
// sits under it with no way to scroll it clear.
test('body leaves room at the bottom for the toast', () => {
  assert.equal(declOf('body', 'padding-bottom'), 'calc(96px + env(safe-area-inset-bottom))');
});

// --- Task 4a review O1, O2, O3 ----------------------------------------------
test('.item-open comes before .idea-title, so font: inherit cannot cancel the bold', () => {
  const a = css.search(/(^|\})\s*\.item-open\s*\{/m);
  const b = css.search(/(^|\})\s*\.idea-title\s*\{/m);
  assert.ok(a >= 0 && b >= 0, 'both rules must exist');
  assert.ok(a < b, '.idea-title must come AFTER .item-open');
});

test('a done item keeps its strikethrough on the title button', () => {
  assert.match(css, /li\.done \.item-open[^{]*\{[^}]*text-decoration:\s*line-through/);
});

test('in a Day block the open button fills the block, so any tap on it opens', () => {
  const m = css.match(/\.day-block \.item-open, \.day-pin \.item-open\s*\{([^}]*)\}/);
  assert.ok(m);
  assert.match(m[1], /height:\s*100%/);
});

// --- Sweep S-11: pins the review found missing ------------------------------
test('.toast-undo is at least 44px tall', () => {
  assert.ok(ruleExists('.toast-undo'), 'no rule for .toast-undo');
  assert.ok(px(declOf('.toast-undo', 'min-height')) >= 44);
});

test('an empty .sheet-error takes no space', () => {
  assert.equal(declOf('.sheet-error:empty', 'display'), 'none');
});

// --- Sweep U: the real-browser review ---------------------------------------
// U1: Delete was the global accent chip with danger text on it — unreadable.
test('.sheet-delete is a transparent danger outline', () => {
  assert.equal(declOf('.sheet-delete', 'background'), 'transparent');
  assert.equal(declOf('.sheet-delete', 'border'), '1px solid var(--danger)');
  assert.equal(declOf('.sheet-delete', 'color'), 'var(--danger)');
});

// U2: one primary action. Everything else is the secondary look that
// .preview-actions .cancel already uses.
test('Save is the primary button', () => {
  assert.equal(declOf('.sheet-save', 'background'), 'var(--accent)');
  assert.equal(declOf('.sheet-save', 'color'), 'var(--accent-ink)');
});
for (const sel of ['.sheet-cancel', '.sheet-close', '.sheet-move']) {
  test(`${sel} is a secondary button, like the preview's Cancel`, () => {
    assert.equal(declOf(sel, 'background'), declOf('.preview-actions .cancel', 'background'));
    assert.equal(declOf(sel, 'color'), declOf('.preview-actions .cancel', 'color'));
    assert.equal(declOf(sel, 'border'), declOf('.preview-actions .cancel', 'border'));
    assert.equal(declOf(sel, 'background'), 'var(--card)', 'fixture check: the preview Cancel is what it was');
  });
}

// U3
test('the Google link is in the accent colour', () => {
  assert.equal(declOf('.sheet-google', 'color'), 'var(--accent)');
});

// U4: native controls (date and time pickers, scrollbars) follow the theme,
// and the scrim still dims a near-black page.
test('dark mode sets color-scheme and a darker scrim', () => {
  assert.equal(declOf('[data-theme="dark"]', 'color-scheme'), 'dark');
  const alpha = (v) => {
    const m = /^rgba\(\s*0,\s*0,\s*0,\s*([\d.]+)\s*\)$/.exec(v || '');
    assert.ok(m, `cannot read an alpha from ${JSON.stringify(v)}`);
    return parseFloat(m[1]);
  };
  assert.ok(alpha(declOf('[data-theme="dark"]', '--scrim')) > alpha(declOf(':root', '--scrim')));
});

// U5
test('the sheet contains its own overscroll', () => {
  assert.equal(declOf('.sheet', 'overscroll-behavior'), 'contain');
});

// U9: a Day block's title sits at the top-left, not centred in the button.
test('in a Day block the open button\'s content is top-left', () => {
  for (const sel of ['.day-block .item-open', '.day-pin .item-open']) {
    assert.equal(declOf(sel, 'display'), 'flex', sel);
    assert.equal(declOf(sel, 'align-items'), 'flex-start', sel);
    assert.equal(declOf(sel, 'justify-content'), 'flex-start', sel);
  }
});

// U10
test('the List row\'s main block takes the free width', () => {
  assert.equal(declOf('.list-main', 'flex'), '1');
  assert.equal(declOf('.list-main', 'min-width'), '0');
});

// U12: the own-item heading sits in the top bar, between Cancel and Save.
test('the heading in the top bar has no margin of its own', () => {
  assert.equal(declOf('.sheet-bar .sheet-heading', 'margin'), '0');
});

// U13: #toast-live is read, not seen.
test('.visually-hidden hides from sight only', () => {
  assert.equal(declOf('.visually-hidden', 'position'), 'absolute');
  assert.equal(declOf('.visually-hidden', 'width'), '1px');
  assert.equal(declOf('.visually-hidden', 'height'), '1px');
  assert.equal(declOf('.visually-hidden', 'overflow'), 'hidden');
  assert.equal(declOf('.visually-hidden', 'clip-path'), 'inset(50%)');
  assert.equal(declOf('.visually-hidden', 'display'), null, 'display: none would hide it from screen readers too');
});

// U15
test('the external sheet has room after its last line', () => {
  assert.equal(declOf('.sheet-external', 'padding-bottom'), 'calc(16px + env(safe-area-inset-bottom))');
});
