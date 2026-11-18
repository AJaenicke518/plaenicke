import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Static guard for the time-format preference: every rendered time goes through
// timegrid.js's formatters with an explicit format, and no view keeps its own
// AM/PM copy. The rendered tests in each view's test file prove behaviour; this
// proves no site was forgotten.

const JS_DIR = new URL('../js/', import.meta.url);
const sources = readdirSync(JS_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: f, src: readFileSync(new URL(f, JS_DIR), 'utf8') }));

// Minimum top-level argument count (so top-level commas >= min - 1).
const MIN_ARGS = { formatTime: 2, formatTimeRange: 3, hourLabel: 2 };

// Walks from each `name(` to its matching `)`, tracking nesting, string and
// template literals (including `${}`), and returns the call sites whose
// top-level argument count is below the minimum.
export function findCallsMissingFormat(src) {
  const bad = [];
  const re = /\b(formatTimeRange|formatTime|hourLabel)\(/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    // Skip declarations and imports: `function hourLabel(`.
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    let i = m.index + m[0].length;
    let depth = 1;
    let commas = 0;
    let hasArg = false;
    const stack = []; // template literal brace tracking: 'T' = in template text, 'E' = in ${ }
    let inTemplate = false;
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i];
      if (inTemplate) {
        if (c === '\\') { i += 1; continue; }
        if (c === '`') { inTemplate = false; continue; }
        if (c === '$' && src[i + 1] === '{') { stack.push('T'); inTemplate = false; i += 1; depth += 1; }
        continue;
      }
      if (c === '\'' || c === '"') {
        const q = c;
        for (i += 1; i < src.length && src[i] !== q; i += 1) if (src[i] === '\\') i += 1;
        hasArg = true;
        continue;
      }
      if (c === '`') { inTemplate = true; hasArg = true; continue; }
      if (c === '(' || c === '[' || c === '{') { depth += 1; hasArg = true; continue; }
      if (c === ')' || c === ']' || c === '}') {
        depth -= 1;
        if (c === '}' && stack.length && depth >= 1 && stack[stack.length - 1] === 'T') {
          // closing a ${ } inside a template: back into template text
          stack.pop();
          inTemplate = true;
        }
        continue;
      }
      if (c === ',' && depth === 1) { commas += 1; continue; }
      if (!/\s/.test(c)) hasArg = true;
    }
    const args = hasArg ? commas + 1 : 0;
    if (args < MIN_ARGS[name]) bad.push({ name, at: m.index, text: src.slice(m.index, i) });
  }
  return bad;
}

test('the scanner flags a call whose argument is a template literal with nested parens', () => {
  const flagged = findCallsMissingFormat('x = formatTime(`${String(h).padStart(2, \'0\')}:00`);');
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].name, 'formatTime');
});

test('the scanner passes calls that carry a format, and counts commas only at the top level', () => {
  assert.deepEqual(findCallsMissingFormat('formatTime(`${a(1, 2)}:00`, fmt)'), []);
  assert.deepEqual(findCallsMissingFormat('formatTimeRange(a.time, a.end, fmt)'), []);
  assert.deepEqual(findCallsMissingFormat('hourLabel(h, fmt)'), []);
  assert.equal(findCallsMissingFormat('formatTimeRange(a.time, a.end)').length, 1);
  assert.equal(findCallsMissingFormat('hourLabel(f(h, 1))').length, 1);
});

test('(a) no module except timegrid.js spells an AM/PM suffix', () => {
  for (const { file, src } of sources) {
    if (file === 'timegrid.js') continue;
    assert.doesNotMatch(src, /['"]\s?[AP]M['"]/, `${file} carries its own AM/PM`);
  }
});

test('(b) every formatTime, formatTimeRange and hourLabel call outside timegrid.js passes a format', () => {
  let seen = 0;
  for (const { file, src } of sources) {
    if (file === 'timegrid.js') continue;
    seen += (src.match(/\b(formatTimeRange|formatTime|hourLabel)\(/g) || []).length;
    assert.deepEqual(findCallsMissingFormat(src).map((b) => b.text), [], `${file}: call without a format`);
  }
  assert.ok(seen >= 8, `fixture check: the scanner saw the render sites (saw ${seen})`);
});

test('(c) the 3-day view does not derive its short time by splitting text', () => {
  const src = sources.find((s) => s.file === 'threedayview.js').src;
  assert.ok(!src.includes('.split(\' \')'));
});
