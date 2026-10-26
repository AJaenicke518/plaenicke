import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEED_PALETTE, tagColour } from '../js/palette.js';

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

// --- tag colours (2026-10-25): a tag's text picks one palette colour --------
const SAMPLE = ['PHYS 2100', 'Thesis', 'Biology', 'Lab', 'Garden', 'Work', 'Home', 'Errands', 'Health', 'Finance',
  'Reading', 'Chem 101', 'Math 220', 'Essay', 'Exam', 'Project X', 'Admin', 'Travel', 'Cooking', 'Fitness',
  'Music', 'Taxes', 'Car', 'Pets', 'Family', 'Friends', 'Writing', 'Research', 'Seminar', 'Homework'];

test('tagColour: the same name gives the same colour, whatever its case or surrounding whitespace', () => {
  assert.equal(tagColour('PHYS 2100'), tagColour(' phys 2100 '));
  assert.equal(tagColour('Thesis'), tagColour('\tTHESIS\n'));
  assert.equal(tagColour('Lab'), tagColour('Lab'));
});

test('tagColour: always one of the six palette strings', () => {
  for (const n of [...SAMPLE, '', '   ', 'x', 'ünïcödé', 'a'.repeat(500)]) {
    assert.ok(FEED_PALETTE.includes(tagColour(n)), `${JSON.stringify(n)} -> ${tagColour(n)}`);
  }
});

test('tagColour: a realistic spread of names uses at least 4 of the 6 colours', () => {
  assert.ok(new Set(SAMPLE.map(tagColour)).size >= 4);
});

// Pinned (32-bit FNV-1a of the trimmed, lower-cased UTF-8 text, mod 6, 1-based),
// computed independently of js/palette.js. A change to the hash changes colours
// on every device, so it must fail here.
test('tagColour: known names keep their colours', () => {
  const pins = { 'PHYS 2100': 1, Thesis: 4, Biology: 5, Lab: 3, Garden: 1, Work: 1, Home: 3, Errands: 5, Travel: 2, Reading: 6 };
  for (const [name, n] of Object.entries(pins)) assert.equal(tagColour(name), `var(--feed-palette-${n})`, name);
});
