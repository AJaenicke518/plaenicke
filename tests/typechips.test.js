import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeFakeDocument, findAll } from './fake-dom.js';
import { createTypeChips, assertOffered, PRIMARY_TYPES, MORE_TYPES } from '../js/typechips.js';
import { TYPE_LABELS } from '../js/itemsheet.js';
import { TYPES } from '../js/preview.js';

// The manual-add type chips (option A, Alex 2026-10-26). The module only
// draws the chips and reports the choice; app.js decides when the row shows
// and what an Add saves (tests/apply.test.js).

beforeEach(() => { globalThis.document = makeFakeDocument(); });

function mount() {
  const host = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(host);
  const chips = createTypeChips(host);
  return { host, chips };
}
const buttons = (host) => findAll(host, 'BUTTON');
const chipFor = (host, value) => buttons(host).find((b) => b.dataset.type === value);
const moreButton = (host) => buttons(host).find((b) => b.dataset.more === 'true');
const pressed = (host) => buttons(host)
  .filter((b) => b.dataset.type && b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.type);

test('the offered types are Event, Deadline and To-do, then Start and Milestone behind More', () => {
  assert.deepEqual(PRIMARY_TYPES, ['event', 'due', 'task']);
  assert.deepEqual(MORE_TYPES, ['start', 'milestone']);
});

test('every offered value is one of preview.js TYPES, and never general or idea', () => {
  for (const t of [...PRIMARY_TYPES, ...MORE_TYPES]) {
    assert.ok(TYPES.includes(t), `${t} is not in TYPES: the item sheet could not show it`);
  }
  assert.ok(![...PRIMARY_TYPES, ...MORE_TYPES].includes('general'), 'general is never a new choice');
  assert.ok(![...PRIMARY_TYPES, ...MORE_TYPES].includes('idea'), 'Idea is not offered (Alex 2026-10-26)');
});

test('each chip is a real button, its text is the item sheet\'s own label for its type', () => {
  const { host } = mount();
  for (const t of [...PRIMARY_TYPES, ...MORE_TYPES]) {
    const b = chipFor(host, t);
    assert.ok(b, `a chip for ${t}`);
    assert.equal(b.type, 'button', `${t}: type="button", so it never submits anything`);
    assert.equal(b.textContent, TYPE_LABELS[t], `${t}: the label comes from itemsheet.js TYPE_LABELS`);
  }
});

test('the group is named, Event is selected by default, and only Event is pressed', () => {
  const { host, chips } = mount();
  const group = host.children[0];
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), 'Type');
  assert.equal(chips.value(), 'event');
  assert.deepEqual(pressed(host), ['event']);
  for (const b of buttons(host).filter((x) => x.dataset.type)) {
    assert.equal(b.getAttribute('aria-pressed'), String(b.dataset.type === 'event'), `${b.dataset.type} states aria-pressed`);
  }
});

test('a tap selects that type and unpresses every other', () => {
  const { host, chips } = mount();
  chipFor(host, 'due').click();
  assert.equal(chips.value(), 'due');
  assert.deepEqual(pressed(host), ['due']);
  chipFor(host, 'task').click();
  assert.equal(chips.value(), 'task');
  assert.deepEqual(pressed(host), ['task']);
});

test('Start and Milestone are hidden until More; More reveals them and hides itself', () => {
  const { host, chips } = mount();
  const more = moreButton(host);
  assert.ok(more, 'a More button');
  assert.equal(more.type, 'button');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  for (const t of MORE_TYPES) assert.equal(chipFor(host, t).hidden, true, `${t} hidden before More`);
  for (const t of PRIMARY_TYPES) assert.equal(chipFor(host, t).hidden, false, `${t} shown`);
  more.focus();
  more.click();
  for (const t of MORE_TYPES) assert.equal(chipFor(host, t).hidden, false, `${t} shown after More`);
  assert.equal(globalThis.document.activeElement, chipFor(host, 'start'),
    'focus moves to Start, since the focused More just hid itself');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(more.hidden, true, 'More hides itself, so a selected Start or Milestone can never be folded away');
  chipFor(host, 'milestone').click();
  assert.equal(chips.value(), 'milestone');
  assert.deepEqual(pressed(host), ['milestone']);
  assert.equal(chipFor(host, 'milestone').hidden, false, 'a selected Milestone stays in sight');
  assert.equal(more.hidden, true, 'and More stays gone');
});

test('reset() goes back to Event and folds More away again', () => {
  const { host, chips } = mount();
  moreButton(host).click();
  chipFor(host, 'start').click();
  chips.reset();
  assert.equal(chips.value(), 'event');
  assert.deepEqual(pressed(host), ['event']);
  for (const t of MORE_TYPES) assert.equal(chipFor(host, t).hidden, true, `${t} hidden after reset`);
  assert.equal(moreButton(host).hidden, false);
  assert.equal(moreButton(host).getAttribute('aria-expanded'), 'false');
});

test('a second createTypeChips on the same host replaces the chips, never doubles them', () => {
  const { host } = mount();
  createTypeChips(host);
  assert.equal(host.children.length, 1);
  assert.equal(buttons(host).filter((b) => b.dataset.type === 'event').length, 1);
});

// The chip text is READ from TYPE_LABELS when the chips are built, not merely
// equal to it today: change the table and the chips follow.
test('the chips read their text from itemsheet.js TYPE_LABELS at build time', () => {
  const saved = TYPE_LABELS.due;
  try {
    TYPE_LABELS.due = 'Relabelled';
    const { host } = mount();
    assert.equal(chipFor(host, 'due').textContent, 'Relabelled');
  } finally {
    TYPE_LABELS.due = saved;
  }
});

test('assertOffered throws on a type it does not know, or one with no label (no raw-value chip)', () => {
  assert.throws(() => assertOffered(['event', 'nope'], TYPES, TYPE_LABELS), /nope is not a known type/);
  assert.throws(() => assertOffered(['event'], TYPES, { due: 'x' }), /no label for type event/);
  assert.doesNotThrow(() => assertOffered([...PRIMARY_TYPES, ...MORE_TYPES], TYPES, TYPE_LABELS));
});

// NO FIFTH COPY OF THE TYPE LIST (CLAUDE.md, "copied FOUR times"). Two scans
// over every file under js/ (recursively) and index.html:
// - LABELS: only itemsheet.js may spell Deadline or Milestone, the two labels
//   that only ever name a type ('Event', 'Start' and 'To-do' are ordinary
//   words used elsewhere: a field label, a tab title). Comments are NOT
//   stripped, so no string containing '//' can hide a copy; a comment that
//   quotes a label has to be reworded.
// - VALUES: no string-literal list holding three or more of TYPES' values,
//   outside the known holders: preview.js (TYPES), items.js (TODO_TYPES) and
//   typechips.js (the offered subset).
// What they cannot see: a label built by concatenation, or a relabelled
// copy written as a map with fewer than three values. A reviewer still has to.
function sourcesUnder(dirUrl, out = []) {
  for (const ent of readdirSync(dirUrl, { withFileTypes: true })) {
    if (ent.isDirectory()) sourcesUnder(new URL(`${ent.name}/`, dirUrl), out);
    else if (ent.name.endsWith('.js')) out.push({ name: ent.name, src: readFileSync(new URL(ent.name, dirUrl), 'utf8') });
  }
  return out;
}
const SOURCES = [
  ...sourcesUnder(new URL('../js/', import.meta.url)),
  { name: 'index.html', src: readFileSync(new URL('../index.html', import.meta.url), 'utf8') },
];

test('the type labels are written down once: only itemsheet.js spells Deadline or Milestone', () => {
  assert.ok(SOURCES.length >= 30, `fixture check: scanned only ${SOURCES.length} files`);
  const label = /['"`>](Deadline|Milestone)['"`<]/;
  const offenders = [];
  for (const { name, src } of SOURCES) {
    if (name === 'itemsheet.js') {
      assert.match(src, label, 'fixture check: the scan can see the real table');
      continue;
    }
    if (label.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test('no new list of type values: only preview.js, items.js and typechips.js hold three or more', () => {
  const holders = new Set(['preview.js', 'items.js', 'typechips.js']);
  const lists = (src) => [...src.matchAll(/\[([^[\]]*)\]/g)]
    .map((m) => [...m[1].matchAll(/['"`]([a-z]+)['"`]/g)].map((x) => x[1]).filter((v) => TYPES.includes(v)))
    .filter((vals) => new Set(vals).size >= 3);
  const offenders = [];
  for (const { name, src } of SOURCES) {
    if (holders.has(name)) {
      if (name === 'preview.js') assert.ok(lists(src).length >= 1, 'fixture check: the scan can see TYPES');
      continue;
    }
    if (lists(src).length) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
