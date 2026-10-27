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
// Every style rule as { sel, body }, in source order. An at-rule's block
// (@media) is opened and its rules read as if they stood outside it (final
// fixes 2, C7): the old regex read `@media (…) { .x { … } }` as one rule whose
// selector was the prelude, so nothing inside an @media was ever checked.
// Braces that do not balance throw rather than yield a partial parse.
function rulesOf(source) {
  const out = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  let bodyStart = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '{') {
      if (depth === 0) { prelude = source.slice(start, i).trim(); bodyStart = i + 1; }
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth < 0) throw new Error(`unbalanced braces at ${i}`);
      if (depth === 0) {
        const body = source.slice(bodyStart, i);
        if (prelude.startsWith('@')) out.push(...rulesOf(body));
        else out.push({ sel: prelude, body });
        start = i + 1;
      }
    }
  }
  if (depth !== 0) throw new Error('unbalanced braces at end of source');
  return out;
}

function declsOf(selector, source = css) {
  const out = [];
  for (const { sel, body } of rulesOf(source)) {
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

// Final fixes 2, C7: the rule regex read `@media (…) { .x { … } }` as ONE
// rule whose selector is the @media prelude, so a declaration inside any
// @media block was invisible to every test that reads declarations.
test('the rule parser reads rules inside @media blocks (C7)', () => {
  const src = '.b { color: blue; } @media (prefers-color-scheme: dark) { .a { color: red; } .b { color: green; } }';
  assert.equal(declOf('.a', 'color', src), 'red', 'a rule inside @media is seen');
  assert.equal(declOf('.b', 'color', src), 'green', 'in source order with the rules outside it');
  assert.deepEqual(rulesOf(src).map((r) => r.sel), ['.b', '.a', '.b'], 'the @media prelude is not a selector');
  assert.throws(() => rulesOf('.a { color: red;'), /unbalanced/, 'a parse it cannot finish fails the test');
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
// Home-screen stage 3c (spec § 4): the bar (56px), the capture button's row
// (72px, stage 4) and the home indicator. Final review B2: computed from
// styles.css, the toast's top is 130-134px up, so it can still cover the
// last 2-6px of the last row (see the comment on body's padding-bottom).
test('body leaves room at the bottom for the tab bar, the capture button and the toast', () => {
  assert.equal(declOf('body', 'padding-bottom'), 'calc(56px + 72px + env(safe-area-inset-bottom))');
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

// Stage 3d removed the List view; its own selectors go with it. The
// Day page's "Other tasks" list keeps the row styling it shared.
test('no List-only selectors are left', () => {
  // .time-line and .tags/.tag were drawn only by the List's renderList.
  assert.doesNotMatch(css, /#item-list|\.list-main|\.list-note|\.time-line|\.tags?\b/);
  assert.ok(declOf('.day-other-list', 'list-style'), 'fixture check: the shared list styling stays for Day');
});

// U12: the own-item heading sits in the top bar, between Cancel and Save.
test('the heading in the top bar has no margin of its own', () => {
  assert.equal(declOf('.sheet-bar .sheet-heading', 'margin'), '0');
});

// Sweep F, UI O5: the heading is centred on the SHEET. Cancel (77px) and Save
// (61px) differ in width, so in a flex row the heading sits centred between
// them, 8px right of the middle, and `flex: 1` on it moves nothing (measured
// at 390px in Chrome: 203.3px either way, bar centre 195px). Equal outer
// columns put it on the centre (195px).
test('sF: the top bar centres the heading on the sheet, whatever the button widths', () => {
  assert.equal(declOf('.sheet-bar', 'display'), 'grid');
  assert.equal(declOf('.sheet-bar', 'grid-template-columns'), '1fr auto 1fr');
  assert.equal(declOf('.sheet-bar .sheet-cancel', 'justify-self'), 'start');
  assert.equal(declOf('.sheet-bar .sheet-save', 'justify-self'), 'end');
  // The external sheet's bar holds Close alone. A grid cell stretches its item
  // by default, which would make Close a full-width bar.
  assert.equal(declOf('.sheet-bar .sheet-close', 'justify-self'), 'start');
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

// --- home-screen stage 2: the overdue-start colour (spec § 2.3, § 5) --------
// Two themes, two surfaces each. The contrast is COMPUTED from the declared
// values, so a later tweak that makes the orange unreadable fails here
// rather than on the phone. Red/orange distinguishability is not computable
// this way and stays on the on-device checklist.
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  assert.ok(m, `cannot read a #rrggbb colour from ${JSON.stringify(hex)}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('--overdue-start is the spec\'s orange in both themes', () => {
  assert.equal(declOf(':root', '--overdue-start'), '#9c5418');
  assert.equal(declOf('[data-theme="dark"]', '--overdue-start'), '#e39a52');
});

for (const theme of [':root', '[data-theme="dark"]']) {
  test(`${theme}: --overdue-start reads at WCAG AA (4.5:1) on --bg and on --card`, () => {
    const fg = declOf(theme, '--overdue-start');
    for (const surface of ['--bg', '--card']) {
      const ratio = contrast(fg, declOf(theme, surface));
      assert.ok(ratio >= 4.5, `${theme} ${surface}: ${ratio.toFixed(2)} < 4.5`);
    }
  });
  test(`${theme}: --overdue-start is not --danger`, () => {
    assert.notEqual(declOf(theme, '--overdue-start').toLowerCase(), declOf(theme, '--danger').toLowerCase());
  });
}

test('contrast() reproduces the spec\'s computed ratios (fixture check on the helper)', () => {
  assert.equal(contrast('#9c5418', '#f4f1ea').toFixed(2), '5.04');
  assert.equal(contrast('#9c5418', '#fffdf8').toFixed(2), '5.59');
  assert.equal(contrast('#e39a52', '#14161a').toFixed(2), '7.77');
  assert.equal(contrast('#e39a52', '#1e2126').toFixed(2), '6.93');
});

// --- home-screen stage 2: spacing and radii (spec § 5) ----------------------
const SPACING = { '--space-1': '4px', '--space-2': '8px', '--space-3': '12px', '--space-4': '16px', '--space-5': '24px', '--space-6': '32px' };
const RADII = { '--radius-control': '8px', '--radius-sheet': '14px', '--radius-round': '50%' };

test('the spacing and radius scales are the spec\'s values', () => {
  for (const [name, value] of Object.entries({ ...SPACING, ...RADII })) {
    assert.equal(declOf(':root', name), value, name);
  }
});

test('spacing and radii are theme-independent: dark mode never redefines them', () => {
  for (const name of Object.keys({ ...SPACING, ...RADII })) {
    assert.equal(declOf('[data-theme="dark"]', name), null, `${name} must have one definition`);
  }
});

// Every form control and button rule that sets a corner. Containers (cards,
// panels, list rows, the day grid) keep their own radius.
const CONTROL_RULES = [
  'button', '.icon-btn', '#entry-text', '#entry-date', '#entry-time', '#entry-end',
  '.feed-add input', '.link-ui input', '.preview-row input', '.preview-row select',
  '.idea-add textarea', '.sheet input', '.sheet select', '.sheet textarea',
];
for (const sel of CONTROL_RULES) {
  test(`${sel} uses the control radius`, () => {
    assert.ok(ruleExists(sel), `no rule for ${sel}`);
    assert.equal(declOf(sel, 'border-radius'), 'var(--radius-control)');
  });
}

test('the item sheet uses the sheet radius on its top corners', () => {
  assert.equal(declOf('.sheet', 'border-radius'), 'var(--radius-sheet) var(--radius-sheet) 0 0');
});

// --- home-screen stage 2: 16px on every input (spec § 5) --------------------
// Under 16px, iOS Safari zooms the whole page when the field takes focus.
// Two checks: every known control rule resolves to >= 16px, and NO rule
// anywhere that targets a form control declares a smaller font-size — so a
// control added later with a small size fails here without being listed.
// (The item sheet's three are pinned by the edit-items tests above.)
const INPUT_RULES = [
  '#entry-text', '#entry-date', '#entry-time', '#entry-end', '.idea-add textarea',
  '.feed-add input', '.link-ui input', '.preview-row input', '.preview-row select',
  '.capture-text',
];
for (const sel of INPUT_RULES) {
  test(`${sel} is at least 16px`, () => {
    assert.ok(ruleExists(sel), `no rule for ${sel}`);
    const fs = declOf(sel, 'font-size');
    assert.ok(fs !== null, `${sel} declares no font-size`);
    assert.ok(px(fs) >= 16, `expected ${sel} font-size >= 16px, got ${fs}`);
  });
}

const CONTROL_SELECTOR = /(^|[\s>+~])(input|select|textarea)\b|#entry-|#idea-text|\.link-(code|token)-/;
test('no rule that targets a form control sets a font-size under 16px', () => {
  const offenders = [];
  let seen = 0;
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = sel.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (!selectors.some((s) => CONTROL_SELECTOR.test(s))) continue;
    seen += 1;
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0 || decl.slice(0, i).trim().toLowerCase() !== 'font-size') continue;
      const value = decl.slice(i + 1).trim();
      if (px(value) < 16) offenders.push(`${sel.trim()}: ${value}`);
    }
  }
  assert.ok(seen >= 10, `fixture check: the scan found only ${seen} control rules`);
  assert.deepEqual(offenders, []);
});

// --- home-screen stage 2: the type scale is for NEW screens only (spec § 5) --
test('the new screens\' type scale is defined', () => {
  assert.equal(declOf(':root', '--text-label'), '13px');
  assert.equal(declOf(':root', '--text-row'), '16px');
  assert.equal(declOf(':root', '--text-title'), '20px');
  assert.equal(declOf(':root', '--text-hero'), '28px');
  assert.equal(declOf(':root', '--label-tracking'), '0.06em');
  assert.equal(declOf(':root', '--sans'), 'system-ui, -apple-system, sans-serif');
});

// Month, Week and Day keep their compact sizes. Pinned at their values on
// main (d7b3b30) so a "consistency" pass that moves them onto the new scale
// fails here: a 13px label in a 72px month cell or a 22px Day block clips.
const CALENDAR_SIZES = {
  '.cal-head': '0.75rem', '.cal-cell': '0.72rem',
  '.week-head': '0.7rem', '.week-head b': '0.85rem', '.week-more': '0.65rem',
  '.day-hour': '0.7rem', '.day-block': '0.75rem', '.day-pin': '0.75rem',
};
for (const [sel, size] of Object.entries(CALENDAR_SIZES)) {
  test(`${sel} keeps its compact font-size (${size})`, () => {
    assert.equal(declOf(sel, 'font-size'), size);
  });
}

// Stage 3b is the first consumer. Every rule that reads the scale belongs to
// a new screen (its selectors all name one); Month, Week and Day never do.
// The sheet's tag chips are the one other reader: first the 13px label scale
// (Commit 1b), now the 16px row scale (2026-10-25). The List's tags moved into the sheet. The Week
// page's list (wlist-, stage 3 Commit 3) is a new screen under the grid; the
// grid itself (week-) keeps its compact sizes. The capture box (capture-,
// stage 4) is the spec's third new screen.
const NEW_SCREEN = /\.(today-|tab-|cal-switch|wlist-|capture-|sheet-tags?(?![\w-]))/;
test('only the new screens read the new type scale', () => {
  const readers = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/var\(--(text-label|text-row|text-title|text-hero|label-tracking|sans)\)/.test(body)) readers.push(sel.trim());
  }
  assert.ok(readers.length >= 3, `fixture check: found ${readers.length} readers`);
  for (const sel of readers) {
    for (const part of sel.split(',')) assert.match(part.trim(), NEW_SCREEN, `${part.trim()} is not a new screen`);
  }
});

// --- home-screen stage 2: press state (spec § 5) ----------------------------
test('every tap skips the double-tap-zoom wait', () => {
  assert.equal(declOf('html', 'touch-action'), 'manipulation');
});

test('pressed buttons dim and pressed rows take the chip background', () => {
  assert.equal(declOf('button.pressed', 'opacity'), '0.7');
  assert.equal(declOf('[data-press].pressed', 'background'), 'var(--chip-bg)');
});

test('the grey iOS tap highlight is off exactly where .pressed replaces it', () => {
  assert.equal(declOf('button', '-webkit-tap-highlight-color'), 'transparent');
  assert.equal(declOf('[data-press]', '-webkit-tap-highlight-color'), 'transparent');
  assert.equal(declOf('html', '-webkit-tap-highlight-color'), null, 'links and checkboxes keep the native highlight');
});

// Feedback on touch-down means instantly. Stage 4's capture box is the one
// animation in the app (spec § 5: "Nothing else animates"), and it carries
// the prefers-reduced-motion override.
//
// The body of the top-level at-rule whose prelude is exactly `prelude`
// (`@media (prefers-reduced-motion: reduce)`, `@keyframes capture-grow`), so
// a test can read declarations inside it alone. Throws when there is none.
function atRuleBody(prelude, source = css) {
  let depth = 0;
  let start = 0;
  let bodyStart = 0;
  let current = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '{') {
      if (depth === 0) { current = source.slice(start, i).trim(); bodyStart = i + 1; }
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        if (current === prelude) return source.slice(bodyStart, i);
        start = i + 1;
      }
    }
  }
  throw new Error(`styles.css has no ${prelude} block`);
}
const CAPTURE_KEYFRAMES = ['capture-fade-in', 'capture-fade-out', 'capture-grow', 'capture-shrink'];

test('press state is instant, nothing transitions, and the only animation is the capture panel\'s', () => {
  assert.equal(declOf('button.pressed', 'transition'), null);
  assert.equal(declOf('[data-press].pressed', 'transition'), null);
  assert.doesNotMatch(css, /(^|[;{\s])transition(-[a-z-]+)?\s*:/);
  const animated = rulesOf(css)
    .filter(({ body }) => /(^|[;{\s])animation(-[a-z-]+)?\s*:/.test(body))
    .map(({ sel }) => sel.replace(/\s+/g, ' '));
  assert.deepEqual([...new Set(animated)].sort(), [
    '.capture-box.closing .capture-panel', '.capture-box.closing.fade .capture-panel', '.capture-panel',
  ]);
  assert.deepEqual([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]).sort(), CAPTURE_KEYFRAMES);
});

test('the capture panel grows from the button\'s corner in 250ms and shrinks back; with the keyboard up it fades', () => {
  assert.equal(declOf('.capture-panel', 'animation'), 'capture-grow 250ms ease-out');
  assert.equal(declOf('.capture-panel', 'transform-origin'), 'bottom right');
  assert.equal(declOf('.capture-box.closing .capture-panel', 'animation'), 'capture-shrink 250ms ease-out forwards');
  assert.equal(declOf('.capture-box.closing.fade .capture-panel', 'animation-name'), 'capture-fade-out');
  // transform and opacity only (spec § 5).
  for (const name of CAPTURE_KEYFRAMES) {
    for (const { body } of rulesOf(atRuleBody(`@keyframes ${name}`))) {
      for (const decl of body.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        assert.ok(['transform', 'opacity'].includes(decl.slice(0, i).trim()), `${name} animates ${decl.trim()}`);
      }
    }
  }
});

test('under reduced motion the capture panel only fades', () => {
  const reduced = atRuleBody('@media (prefers-reduced-motion: reduce)');
  assert.equal(declOf('.capture-panel', 'animation-name', reduced), 'capture-fade-in');
  assert.equal(declOf('.capture-box.closing .capture-panel', 'animation-name', reduced), 'capture-fade-out');
});

// --- home-screen stage 3b: the guessed-series line on the sheet (spec § 2.4) --
test('the sheet\'s "Repeats weekly (guessed)" line reads like its other details', () => {
  assert.equal(declOf('.sheet-repeat', 'color'), 'var(--muted)');
  assert.equal(declOf('.sheet-repeat', 'margin'), '0 0 6px');
});

// --- home-screen stage 3b: the Today page (spec § 2.3, § 5) -----------------
test('Today rows are full-width hairline rows, at least 44px, in 16px type', () => {
  assert.equal(declOf('.today-row', 'min-height'), '44px');
  assert.equal(declOf('.today-row', 'border-bottom'), '1px solid var(--line)');
  assert.equal(declOf('.today-open', 'font-size'), 'var(--text-row)');
  assert.equal(declOf(':root', '--text-row'), '16px', 'fixture check');
  assert.ok(px(declOf('.item-open', 'min-height')) >= 44, 'the open button is a 44px target too');
});

test('Today labels are 13px, uppercase, tracked and muted; the heading is 28px Georgia', () => {
  for (const sel of ['.today-label', '.today-day', '.today-date']) {
    assert.equal(declOf(sel, 'font-size'), 'var(--text-label)', sel);
    assert.equal(declOf(sel, 'text-transform'), 'uppercase', sel);
    assert.equal(declOf(sel, 'letter-spacing'), 'var(--label-tracking)', sel);
    assert.equal(declOf(sel, 'color'), 'var(--muted)', sel);
    assert.equal(declOf(sel, 'font-family'), 'var(--sans)', sel);
  }
  assert.equal(declOf('.today-title', 'font-size'), 'var(--text-hero)');
  assert.equal(declOf('.today-title', 'font-family'), 'var(--serif)');
  assert.equal(declOf('.today-text', 'font-family'), 'var(--serif)', 'titles in Georgia');
  for (const sel of ['.today-time', '.today-age', '.today-rel']) {
    assert.equal(declOf(sel, 'font-family'), 'var(--sans)', sel);
    assert.equal(declOf(sel, 'font-variant-numeric'), 'tabular-nums', sel);
  }
});

test('an overdue age is red past a deadline and orange past a start date', () => {
  assert.equal(declOf('.today-age.deadline', 'color'), 'var(--danger)');
  assert.equal(declOf('.today-age.start', 'color'), 'var(--overdue-start)');
});

test('the next event\'s "in N" is in the accent; a finished event is greyed; a ticked to-do is struck through', () => {
  assert.equal(declOf('.today-rel', 'color'), 'var(--accent)');
  assert.equal(declOf('.today-row.past .today-open', 'color'), 'var(--muted)');
  assert.equal(declOf('.today-row.done .today-text', 'text-decoration'), 'line-through');
});

// Final fixes 2, C3: an event over 12 h away keeps an EMPTY "in N" span (so
// the tick can fill it, final review A2), and as a flex item it still took
// the row's 8px gap after the time. Empty, it is not laid out at all; the
// tick fills the node it kept, and :empty stops matching.
test('an empty "in N" takes no space', () => {
  assert.equal(declOf('.today-rel:empty', 'display'), 'none');
});

// Final review A8: the <label class="today-tick"> around each Today checkbox
// is its hit area, at least 44x44, so a near miss no longer opens the sheet.
test('the Today checkbox\'s label is a 44x44 hit area around the box', () => {
  assert.equal(declOf('.today-tick', 'min-width'), '44px');
  assert.equal(declOf('.today-tick', 'min-height'), '44px');
  assert.equal(declOf('.today-tick', 'display'), 'flex');
  assert.equal(declOf('.today-tick', 'align-items'), 'center');
  assert.equal(declOf('.today-tick', 'justify-content'), 'center');
  assert.equal(declOf('.today-tick', 'flex'), '0 0 auto', 'never squeezed by the title');
});

// Final fixes 2, C8: To-do's checkbox gets the same 44x44 label as Today's.
test('the To-do checkbox\'s label is a 44x44 hit area around the box', () => {
  assert.equal(declOf('.todo-tick', 'min-width'), '44px');
  assert.equal(declOf('.todo-tick', 'min-height'), '44px');
  assert.equal(declOf('.todo-tick', 'display'), 'flex');
  assert.equal(declOf('.todo-tick', 'align-items'), 'center');
  assert.equal(declOf('.todo-tick', 'justify-content'), 'center');
  assert.equal(declOf('.todo-tick', 'flex'), '0 0 auto', 'never squeezed by the title');
});

// Final review A6: the global `.done { opacity: 0.55 }` reached Today's
// rows. A ticked Today row is struck through only (spec § 2.3).
test('a ticked Today row is struck through, not dimmed', () => {
  assert.equal(declOf('.done', 'opacity'), '0.55', 'fixture check: the global rule it overrides');
  assert.equal(declOf('.today-row.done', 'opacity'), '1');
  assert.equal(declOf('.today-row.done .today-text', 'text-decoration'), 'line-through');
});

// Alex, 2026-10-22: a to-do ticked today stays on the To-do page until
// tomorrow, drawn as Today draws it: struck through, not dimmed. The title is
// the .item-open button ("<day> — <title>").
test('a ticked To-do row is struck through, not dimmed', () => {
  assert.equal(declOf('.done', 'opacity'), '0.55', 'fixture check: the global rule it overrides');
  assert.equal(declOf('.todo-row.done', 'opacity'), '1');
  assert.equal(declOf('.todo-row.done .item-open', 'text-decoration'), 'line-through');
});

// Final review A7: the meta spans squeezed the title. "Repeats weekly
// (guessed)" takes its own line under the title; time and "in N" stay on the
// title line. The open button pads itself so a two-line title clears the
// hairlines.
test('Today\'s guessed-series note wraps under the title; a two-line title clears the hairlines', () => {
  assert.equal(declOf('.today-open', 'flex-wrap'), 'wrap');
  assert.equal(declOf('.today-guess', 'flex-basis'), '100%');
  for (const sel of ['.today-time', '.today-rel']) {
    assert.equal(declOf(sel, 'flex'), '0 0 auto', `${sel} stays on the title line`);
  }
  assert.equal(declOf('.today-open', 'padding-top'), 'var(--space-2)');
  assert.equal(declOf('.today-open', 'padding-bottom'), 'var(--space-2)');
  const at = (sel) => css.search(new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{`));
  assert.ok(at('.item-open') >= 0 && at('.today-open') > at('.item-open'),
    '.today-open after .item-open, whose padding: 0 it overrides');
});

// Final review A9: the gear was under Apple's 44px minimum. It is the only
// .icon-btn in index.html and js/.
test('the settings gear (.icon-btn) is at least 44x44', () => {
  assert.equal(declOf('.icon-btn', 'min-width'), '44px');
  assert.equal(declOf('.icon-btn', 'min-height'), '44px');
});

// Alex, 2026-10-22: the gear is back in the shell header, top right on every
// page (spec § 2.2 amendment). index.html puts it last (apply.test.js); the
// header is a flex row, and the stamp's auto left margin pushes the stamp and
// the gear to the right edge, with a small gap between them.
test('the header puts the stamp and then the gear at its right edge', () => {
  assert.equal(declOf('header', 'display'), 'flex');
  assert.equal(declOf('.stamp', 'margin-left'), 'auto');
  assert.equal(declOf('.stamp', 'margin-right'), 'var(--space-2)', 'a small gap before the gear');
});

test('a pressed Today row is tinted, not dimmed like a pressed button', () => {
  assert.equal(declOf('button[data-press].pressed', 'opacity'), '1');
  assert.equal(declOf('[data-press].pressed', 'background'), 'var(--chip-bg)', 'fixture check: the tint');
});

// The punchlist's carry-over (2): [data-press].pressed is (0,2,0). An id
// selector on a Today row would outrank it, and a pressed row would show
// nothing.
test('no rule styles Today through an id', () => {
  const sels = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((sel) => /today/.test(sel));
  assert.ok(sels.length >= 10, `fixture check: found ${sels.length} Today rules`);
  for (const sel of sels) assert.doesNotMatch(sel, /#/, sel);
});

test('every Today colour is a theme token, so dark mode follows', () => {
  let seen = 0;
  for (const { sel, body } of rulesOf(css)) {
    if (!/\.today-/.test(sel)) continue;
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      if (!/^(color|background|border)/.test(prop)) continue;
      seen += 1;
      assert.match(value, /var\(--/, `${sel.trim()} { ${prop}: ${value} }`);
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${sel.trim()} { ${prop}: ${value} }`);
    }
  }
  assert.ok(seen >= 8, `fixture check: ${seen} colour declarations`);
});

// Stage 3 Commit 2 (Alex, 2026-10-22: "i like A2"): Coming up's button is the
// mockup's quiet full-width one — card ground, accent text, a hairline — at
// least 44px tall; open, "Show less" sits a gap below the last day.
test('Coming up\'s button is full-width, quiet and at least 44px; "Show less" is spaced off the list', () => {
  assert.equal(declOf('.today-more', 'width'), '100%');
  assert.equal(declOf('.today-more', 'min-height'), '44px');
  assert.equal(declOf('.today-more', 'background'), 'var(--card)');
  assert.equal(declOf('.today-more', 'color'), 'var(--accent)');
  assert.equal(declOf('.today-more', 'border'), '1px solid var(--line)');
  assert.equal(declOf('.today-more', 'font-family'), 'var(--sans)');
  assert.equal(declOf('.today-more', 'font-size'), '15px');
  assert.equal(declOf('.today-more-after', 'margin-top'), 'var(--space-4)');
});

// --- stage 3 Commit 3: the Week page's list (B2, Alex 2026-10-22) ----------
// The mockup's B2: the day in a 48px left column ("FRI" over a bold "23"),
// rows beside it in Today's row style with the time leading in a fixed 64px
// column, on one line. The day label is a real button, so it is reset off the
// global accent chip and kept a 44px target.
test('the Week list sits a gap under the grid; each day is a 48px column beside its rows', () => {
  assert.equal(declOf('.wlist', 'margin-top'), 'var(--space-5)');
  assert.equal(declOf('.wlist-day', 'display'), 'grid');
  assert.equal(declOf('.wlist-day', 'grid-template-columns'), '48px minmax(0, 1fr)');
  assert.equal(declOf('.wlist-day', 'border-top'), '1px solid var(--line)');
});

test('the Week list\'s day label is a quiet 44px button: a muted label over a bold day number', () => {
  assert.equal(declOf('.wlist-label', 'background'), 'transparent');
  assert.equal(declOf('.wlist-label', 'border'), 'none');
  assert.equal(declOf('.wlist-label', 'border-radius'), '0');
  assert.equal(declOf('.wlist-label', 'padding'), 'var(--space-3) 0 0');
  assert.equal(declOf('.wlist-label', 'min-height'), '44px');
  assert.equal(declOf('.wlist-label', 'align-self'), 'start');
  assert.equal(declOf('.wlist-label', 'text-align'), 'left');
  assert.equal(declOf('.wlist-label', 'font-family'), 'var(--sans)');
  assert.equal(declOf('.wlist-label', 'font-size'), 'var(--text-label)');
  assert.equal(declOf('.wlist-label', 'text-transform'), 'uppercase');
  assert.equal(declOf('.wlist-label', 'letter-spacing'), 'var(--label-tracking)');
  assert.equal(declOf('.wlist-label', 'color'), 'var(--muted)');
  assert.equal(declOf('.wlist-label b', 'display'), 'block');
  assert.equal(declOf('.wlist-label b', 'font-size'), 'var(--text-title)');
  assert.equal(declOf('.wlist-label b', 'color'), 'var(--ink)');
  assert.equal(declOf('.wlist-label b', 'line-height'), '1.1');
  assert.equal(declOf('.wlist-label b', 'letter-spacing'), '0');
});

test('a Week list row stays on one line, its time leading in a 64px column', () => {
  assert.equal(declOf('.wlist-open', 'flex-wrap'), 'nowrap');
  assert.equal(declOf('.wlist-time', 'flex'), '0 0 64px');
});

test('every Week list colour is a token', () => {
  let seen = 0;
  for (const { sel, body } of rulesOf(css)) {
    if (!/\.wlist/.test(sel)) continue;
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      if (!/^(color|background|border)/.test(prop) || value === 'transparent' || value === 'none' || value === '0') continue;
      seen += 1;
      assert.match(value, /var\(--/, `${sel.trim()} { ${prop}: ${value} }`);
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${sel.trim()} { ${prop}: ${value} }`);
    }
  }
  assert.ok(seen >= 3, `fixture check: ${seen} colour declarations`);
});

// --- home-screen stage 3c: the tab bar and the switcher (spec § 4) ----------
test('the tab bar is fixed at the bottom, 56px plus the home-indicator inset', () => {
  assert.equal(declOf('.tab-bar', 'position'), 'fixed');
  assert.equal(declOf('.tab-bar', 'bottom'), '0');
  assert.equal(declOf('.tab-bar', 'left'), '0');
  assert.equal(declOf('.tab-bar', 'right'), '0');
  assert.equal(declOf('.tab-bar', 'height'), 'calc(56px + env(safe-area-inset-bottom))');
  assert.equal(declOf('.tab-bar', 'padding-bottom'), 'env(safe-area-inset-bottom)');
  assert.equal(declOf('.tab-bar', 'background'), 'var(--card)');
  assert.equal(declOf('.tab-bar', 'border-top'), '1px solid var(--line)');
});

test('layers: tab bar 5 < capture button 6 < capture box 8 < settings 10 < item sheet 15 < toast 20 (spec § 4)', () => {
  assert.equal(zIndexOf('.tab-bar'), 5);
  assert.equal(zIndexOf('.capture-btn'), 6);
  assert.equal(zIndexOf('.capture-box'), 8);
  assert.equal(zIndexOf('.settings-backdrop'), 10);
  assert.equal(zIndexOf('.sheet-backdrop'), 15);
  assert.equal(zIndexOf('.toast'), 20);
});

test('the toast sits above the tab bar and clears the capture button\'s corner', () => {
  assert.equal(declOf('.toast', 'bottom'), 'calc(56px + 12px + env(safe-area-inset-bottom))');
  assert.equal(declOf('.toast', 'right'), '88px');
  assert.equal(declOf('.toast', 'left'), '16px');
});

test('a tab is a 44px target; the active one is in the accent', () => {
  assert.ok(px(declOf('.tab-bar button', 'min-height')) >= 44);
  assert.equal(declOf('.tab-bar button', 'font-size'), 'var(--text-label)');
  assert.equal(declOf('.tab-bar button.active', 'color'), 'var(--accent)');
});

test('the tab title is 20px; Today\'s own heading stays 28px', () => {
  assert.equal(declOf('.tab-title', 'font-size'), 'var(--text-title)');
  assert.equal(declOf(':root', '--text-title'), '20px', 'fixture check');
  assert.equal(declOf('.today-title', 'font-size'), 'var(--text-hero)');
});

// Final review B1: the switcher's buttons were ~37.5px tall. Height only:
// each stays flex: 1 with the same side padding, so the four still share the
// row's width as before.
test('Calendar\'s switcher buttons are at least 44px tall, and still share the row equally', () => {
  assert.ok(px(declOf('.cal-switch button', 'min-height')) >= 44);
  assert.equal(declOf('.cal-switch button', 'flex'), '1');
  assert.equal(declOf('.cal-switch button', 'padding-left'), '4px');
  assert.equal(declOf('.cal-switch button', 'padding-right'), '4px');
});

// Final review B2: a long toast message pushed Undo off the toast and grew it
// without bound. The message wraps anywhere and stops at two lines; Undo
// never shrinks.
test('a toast message wraps and stops at two lines; Undo keeps its size', () => {
  assert.equal(declOf('.toast span', 'min-width'), '0');
  assert.equal(declOf('.toast span', 'overflow-wrap'), 'anywhere');
  assert.equal(declOf('.toast span', 'display'), '-webkit-box');
  assert.equal(declOf('.toast span', '-webkit-line-clamp'), '2');
  assert.equal(declOf('.toast span', '-webkit-box-orient'), 'vertical');
  assert.equal(declOf('.toast span', 'overflow'), 'hidden');
  assert.equal(declOf('.toast-undo', 'flex-shrink'), '0');
});

// Final review B3: on Today the tab title is visually hidden, not removed,
// so the header would lose its height and the add box would jump by it. The
// header keeps the height the title gives it on every other tab: one line of
// --text-title at the body's line-height, plus the h1's 16px margins.
test('the header keeps the tab title\'s height on every tab', () => {
  assert.equal(declOf(':root', '--text-title'), '20px', 'fixture check');
  assert.equal(lineHeightOf('body'), 1.5, 'fixture check');
  assert.equal(declOf('header h1', 'margin-top'), '16px', 'fixture check');
  assert.equal(declOf('header h1', 'margin-bottom'), '16px', 'fixture check');
  assert.equal(declOf('header', 'min-height'), `${20 * 1.5 + 16 + 16}px`);
});

// .cal-switch sets display: flex, which beats the `hidden` attribute's
// display: none. Without this rule the switcher would show on every tab.
test('a hidden switcher is not displayed', () => {
  assert.equal(declOf('.cal-switch', 'display'), 'flex', 'fixture check');
  assert.equal(declOf('.cal-switch[hidden]', 'display'), 'none');
});

test('the six-button view toggle is gone from the stylesheet', () => {
  assert.equal(ruleExists('.view-toggle'), false);
  assert.equal(ruleExists('.view-toggle button'), false);
});

// --- stage 3d follow-up: item tags in the details sheet ---------------------
// The List drew them; the sheet does now (Alex, 2026-10-22). Chips at the 16px
// row size, coloured by name through --tag-color, token colours only.
test('the sheet\'s tag chips are 16px pills tinted by their own --tag-color', () => {
  assert.equal(declOf('.sheet-tags', 'display'), 'flex');
  assert.equal(declOf('.sheet-tags', 'flex-wrap'), 'wrap');
  assert.equal(declOf('.sheet-tags', 'gap'), '6px');
  assert.equal(declOf('.sheet-tags', 'margin'), '0 0 6px');
  assert.equal(declOf('.sheet-tag', 'font-size'), 'var(--text-row)');
  assert.equal(declOf('.sheet-tag', 'background'), 'color-mix(in srgb, var(--tag-color) 18%, var(--card))');
  assert.equal(declOf('.sheet-tag', 'color'), 'var(--ink)');
  assert.equal(declOf('.sheet-tag', 'border-radius'), '999px');
  assert.equal(declOf('.sheet-tag', 'padding'), '2px 12px');
  assert.equal(declOf('.sheet-tag', 'display'), 'inline-flex');
  assert.equal(declOf('.sheet-tag', 'align-items'), 'center');
});

test('each tag chip starts with a solid dot of its colour', () => {
  assert.ok(ruleExists('.sheet-tag::before'));
  assert.equal(declOf('.sheet-tag::before', 'background'), 'var(--tag-color)');
  assert.equal(declOf('.sheet-tag::before', 'content'), '""');
  assert.equal(declOf('.sheet-tag::before', 'border-radius'), '50%');
});

test('no tag-chip rule carries a hex literal', () => {
  for (const sel of ['.sheet-tags', '.sheet-tag', '.sheet-tag::before']) {
    const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, s]) => s.trim() === sel);
    assert.ok(m.length, sel);
    for (const [, , body] of m) assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, sel);
  }
});

// --- home-screen stage 4: the capture button and box (spec § 3, § 4, § 5) ---
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the capture button is a 56px accent circle, 16px from the right and 16px above the tab bar', () => {
  assert.equal(declOf('.capture-btn', 'position'), 'fixed');
  assert.equal(declOf('.capture-btn', 'right'), '16px');
  assert.equal(declOf('.capture-btn', 'bottom'), 'calc(56px + 16px + env(safe-area-inset-bottom))');
  assert.equal(declOf('.capture-btn', 'width'), '56px');
  assert.equal(declOf('.capture-btn', 'height'), '56px');
  assert.equal(declOf('.capture-btn', 'border-radius'), 'var(--radius-round)');
  assert.equal(declOf('.capture-btn', 'background'), 'var(--accent)');
  assert.equal(declOf('.capture-btn', 'color'), 'var(--accent-ink)');
  assert.equal(declOf('.capture-btn', 'box-shadow'), null, 'shadows are for the box, sheets and the toast only');
});

test('pressed, the capture button scales instead of dimming', () => {
  assert.equal(declOf('.capture-btn.pressed', 'transform'), 'scale(0.94)');
  assert.equal(declOf('.capture-btn.pressed', 'opacity'), '1');
});

test('listening, the capture button shows a stop square instead of the mic', () => {
  assert.equal(declOf('.capture-btn .icon-stop', 'display'), 'none');
  assert.equal(declOf('.capture-btn.listening .icon-mic', 'display'), 'none');
  assert.equal(declOf('.capture-btn.listening .icon-stop', 'display'), 'block');
});

test('the capture button is not shown while Settings or the item sheet is open', () => {
  assert.equal(declOf('#settings-host:not(:empty) ~ .capture-btn', 'display'), 'none');
  assert.equal(declOf('#sheet-host:not(:empty) ~ .capture-btn', 'display'), 'none');
});

// `~` matches a LATER sibling only, so the rules above depend on the order.
test('index.html puts the capture button after both hosts, as siblings in body', () => {
  const at = (needle) => {
    const i = indexHtml.indexOf(needle);
    assert.ok(i >= 0, `index.html has no ${needle}`);
    return i;
  };
  const btn = at('<button id="capture-btn" class="capture-btn" type="button"');
  assert.ok(btn > at('<div id="settings-host"></div>'));
  assert.ok(btn > at('<div id="sheet-host"></div>'));
  assert.ok(at('<script type="module" src="js/app.js"></script>') > btn);
  assert.match(indexHtml, /<div id="capture-box" class="capture-box" hidden>/, 'the box starts hidden');
});

test('the capture box sits just above the button, and 8px above the keyboard while typing', () => {
  assert.equal(declOf('.capture-box', '--capture-lift'), 'calc(56px + 16px + 56px + 8px + env(safe-area-inset-bottom))');
  assert.equal(declOf('.capture-box', 'bottom'), 'var(--capture-lift)');
  assert.equal(declOf('.capture-box.typing', '--capture-lift'), '8px');
  assert.equal(declOf('.capture-box', 'position'), 'fixed');
  assert.equal(declOf('.capture-box', 'left'), '16px');
  assert.equal(declOf('.capture-box', 'right'), '16px');
  assert.equal(declOf('.capture-box', 'max-height'), '50dvh');
  assert.equal(declOf('.capture-box[hidden]', 'display'), 'none');
});

test('the capture panel has the sheet radius and a shadow, and scrolls inside itself', () => {
  assert.equal(declOf('.capture-panel', 'border-radius'), 'var(--radius-sheet)');
  assert.notEqual(declOf('.capture-panel', 'box-shadow'), null);
  assert.equal(declOf('.capture-panel', 'overflow-y'), 'auto');
  assert.equal(declOf('.capture-panel', 'overscroll-behavior'), 'contain');
  assert.equal(declOf('.capture-panel', 'min-height'), '0');
});

test('every capture control is a 44px target', () => {
  assert.ok(px(declOf('.capture-close', 'min-width')) >= 44);
  assert.ok(px(declOf('.capture-actions button', 'min-height')) >= 44, 'x, Cancel and Add are all in this row');
  assert.ok(px(declOf('.capture-type', 'min-height')) >= 44);
  assert.match(indexHtml, /<div class="capture-actions">\s*<button id="capture-close"/, 'x is in the actions row');
});

// Add must stay reachable in a box that may be ~200px tall with the keyboard
// up (DA I3): the field stops growing at five lines, and the actions row is
// the panel's last child, stuck to its bottom edge.
test('Add stays reachable: the field stops growing, and the actions row sticks to the bottom', () => {
  assert.equal(declOf('.capture-text', 'max-height'), '120px');
  assert.equal(declOf('.capture-text', 'overflow-y'), 'auto');
  assert.equal(declOf('.capture-actions', 'position'), 'sticky');
  assert.equal(declOf('.capture-actions', 'bottom'), '0');
  assert.equal(declOf('.capture-actions', 'background'), 'var(--card)', 'opaque, so scrolled content does not show through');
  const panel = indexHtml.slice(indexHtml.indexOf('<div class="capture-panel"'), indexHtml.indexOf('<button id="capture-btn"'));
  assert.ok(panel.lastIndexOf('<div class="capture-actions">') > panel.indexOf('id="capture-preview"'),
    'the actions row comes after the preview');
});

test('a closing capture box lets taps through to the page', () => {
  assert.equal(declOf('.capture-box.closing', 'pointer-events'), 'none');
});

test('the capture box\'s Cancel is secondary, like the preview\'s and the sheet\'s', () => {
  assert.match(indexHtml, /<button id="capture-cancel" class="cancel" type="button" hidden>Cancel<\/button>/);
  assert.equal(declOf('.capture-actions .cancel', 'background'), 'var(--card)');
  assert.equal(declOf('.capture-actions .cancel', 'border'), '1px solid var(--line)');
});
