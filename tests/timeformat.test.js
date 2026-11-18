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

// Minimum top-level argument count.
const MIN_ARGS = { formatTime: 2, formatTimeRange: 3, hourLabel: 2 };
const NAMES = '(formatTimeRange|formatTime|hourLabel)';

// Blanks `//` and `/* */` comments (newlines kept) so nothing inside a comment
// is scanned or counted. Strings and template literals are skipped over so a
// `//` inside one is not taken for a comment.
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      i -= 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i += 1; }
      i += 1;
      out += ' ';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      out += c;
      for (i += 1; i < src.length && src[i] !== c; i += 1) {
        if (src[i] === '\\') { out += src[i]; i += 1; }
        out += src[i];
      }
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

// Walks from each `name(` (also `name (`, `name\n(` and `name?.(`) to its
// matching `)`, tracking nesting, string and template literals (including
// `${}`), and returns the call sites whose top-level argument count is below
// the minimum, or whose last argument is the literal `undefined`, `null` or a
// quoted string (a format must be a value, never a literal). A trailing comma
// does not count as an argument. Member calls (`tg.formatTime(`) are scanned
// like any other call, so they are flagged when they lack a format.
export function findCallsMissingFormat(raw) {
  const src = stripComments(raw);
  const bad = [];
  const re = new RegExp(`\\b${NAMES}\\s*(\\?\\.)?\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    // Skip declarations: `function hourLabel(`.
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    let i = m.index + m[0].length;
    let depth = 1;
    const args = [];
    let lastStart = i;
    const stack = []; // 'T' marks a `${` opened inside template text
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
        continue;
      }
      if (c === '`') { inTemplate = true; continue; }
      if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
      if (c === ')' || c === ']' || c === '}') {
        depth -= 1;
        if (c === '}' && stack.length && depth >= 1 && stack[stack.length - 1] === 'T') {
          stack.pop();
          inTemplate = true;
        }
        continue;
      }
      if (c === ',' && depth === 1) { args.push(src.slice(lastStart, i)); lastStart = i + 1; }
    }
    args.push(src.slice(lastStart, i - 1)); // i is one past the closing paren
    const kept = args.map((a) => a.trim());
    if (kept.length && kept[kept.length - 1] === '') kept.pop(); // empty last arg: no args, or a trailing comma
    const last = kept[kept.length - 1];
    const literal = last !== undefined && (last === 'undefined' || last === 'null' || /^['"`]/.test(last));
    if (kept.length < MIN_ARGS[name] || literal) {
      bad.push({ name, at: m.index, text: src.slice(m.index, i) });
    }
  }
  return bad;
}

// Names that appear without being called (`.map(formatTime)`,
// `const f = formatTime`): such a use cannot carry a format. Import and export
// lists are not uses.
export function findUncalledReferences(raw) {
  const src = stripComments(raw)
    .replace(/^\s*import\b[\s\S]*?\bfrom\s*['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^\s*import\s*['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}(\s*from\s*['"][^'"]+['"])?\s*;?/gm, '');
  const found = [];
  const re = new RegExp(`\\b${NAMES}\\b(?!\\s*(\\?\\.)?\\()`, 'g');
  let m;
  while ((m = re.exec(src))) found.push(m[0]);
  return found;
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
  assert.deepEqual(findCallsMissingFormat('formatTime(x, fmt)'), []);
  assert.deepEqual(findCallsMissingFormat('formatTime(x, fmt,)'), []);
  assert.equal(findCallsMissingFormat('formatTimeRange(a.time, a.end)').length, 1);
  assert.equal(findCallsMissingFormat('hourLabel(f(h, 1))').length, 1);
});

test('the scanner flags every call shape that evades a plain `name(` match', () => {
  for (const shape of [
    'formatTime (x)',
    'formatTime\n(x)',
    'formatTime?.(x)',
    'formatTime(x,)',
    'formatTime(x, undefined)',
    'formatTime(x, null)',
    "formatTime(x, '12h')",
    'formatTime(x // a, b\n)',
    'formatTime(x /* a, b */)',
    'formatTimeRange(a, b, undefined)',
    'hourLabel(h, "24h")',
    'tg.formatTime(x)',
  ]) {
    assert.equal(findCallsMissingFormat(shape).length, 1, `not flagged: ${JSON.stringify(shape)}`);
  }
});

test('the scanner ignores a call that sits inside a comment', () => {
  assert.deepEqual(findCallsMissingFormat('// formatTime(x)\n/* hourLabel(h) */ ok(1)'), []);
});

test('the reference check flags a bare use of a formatter and ignores imports and comments', () => {
  assert.deepEqual(findUncalledReferences('times.map(formatTime)'), ['formatTime']);
  assert.deepEqual(findUncalledReferences('const f = hourLabel;'), ['hourLabel']);
  assert.deepEqual(findUncalledReferences('x = formatTimeRange'), ['formatTimeRange']);
  assert.deepEqual(findUncalledReferences("import { formatTime, hourLabel } from './timegrid.js';"), []);
  assert.deepEqual(findUncalledReferences("import {\n  formatTime,\n  hourLabel,\n} from './timegrid.js';"), []);
  assert.deepEqual(findUncalledReferences('export { formatTime };'), []);
  assert.deepEqual(findUncalledReferences('// formatTime is used\nformatTime(x, f); formatTime?.(x, f); formatTime (x, f)'), []);
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
    seen += (src.match(/\b(formatTimeRange|formatTime|hourLabel)\s*(\?\.)?\(/g) || []).length;
    assert.deepEqual(findCallsMissingFormat(src).map((b) => b.text), [], `${file}: call without a format`);
  }
  assert.ok(seen >= 8, `fixture check: the scanner saw the render sites (saw ${seen})`);
});

test('(b2) outside timegrid.js the formatters are only ever called, never passed or aliased', () => {
  for (const { file, src } of sources) {
    if (file === 'timegrid.js') continue;
    assert.deepEqual(findUncalledReferences(src), [], `${file}: formatter referenced without a call`);
  }
});

test('(c) the 3-day view does not derive its short time by splitting text', () => {
  const src = sources.find((s) => s.file === 'threedayview.js').src;
  assert.ok(!src.includes('.split(\' \')'));
});
