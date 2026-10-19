import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEED_PALETTE } from '../js/palette.js';

// The calendar colour cycle was copied into settings.js (Add) and feeds.js
// (a calendar first seen through sync), justified by an import cycle that
// extraction removes. One list now, and nothing else may carry its own.
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the palette is the six --feed-palette tokens, in order', () => {
  assert.deepEqual(FEED_PALETTE, [1, 2, 3, 4, 5, 6].map((n) => `var(--feed-palette-${n})`));
});

test('every palette token is defined in styles.css, for both themes', () => {
  const css = src('styles.css');
  for (const entry of FEED_PALETTE) {
    const name = entry.match(/^var\((--feed-palette-\d)\)$/)[1];
    const defs = css.match(new RegExp(`${name}:`, 'g')) || [];
    assert.ok(defs.length >= 2, `${name} needs a light and a dark value; found ${defs.length}`);
  }
});

test('settings.js and feeds.js use the shared palette and keep no copy of their own', () => {
  for (const f of ['js/settings.js', 'js/feeds.js']) {
    const s = src(f);
    assert.match(s, /from '\.\/palette\.js'/, `${f} must import the palette`);
    assert.doesNotMatch(s, /'var\(--feed-palette-\d\)'/, `${f} must not carry its own palette`);
  }
});
