import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeFakeDocument, findAll } from './fake-dom.js';
import { createTypeChips, PRIMARY_TYPES, MORE_TYPES } from '../js/typechips.js';
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
  more.click();
  for (const t of MORE_TYPES) assert.equal(chipFor(host, t).hidden, false, `${t} shown after More`);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(more.hidden, true, 'More hides itself, so a selected Start or Milestone can never be folded away');
  chipFor(host, 'milestone').click();
  assert.equal(chips.value(), 'milestone');
  assert.deepEqual(pressed(host), ['milestone']);
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

// NO FIFTH COPY OF THE TYPE LIST (CLAUDE.md, "copied FOUR times"). The labels
// live in itemsheet.js's TYPE_LABELS, and the chips read them from there. A
// label literal anywhere else in js/ is a new copy that would drift: this
// scan fails on it. 'Event', 'Start' and 'To-do' are ordinary words used
// elsewhere (a field label, a tab title), so the scan takes the two labels
// that only ever name a type.
test('the type labels are written down once: only itemsheet.js spells Deadline or Milestone', () => {
  const dir = new URL('../js/', import.meta.url);
  const offenders = [];
  let scanned = 0;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    scanned += 1;
    const src = readFileSync(new URL(name, dir), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (name === 'itemsheet.js') {
      assert.match(src, /['"]Deadline['"]/, 'fixture check: the scan can see the real table');
      continue;
    }
    if (/['"`]Deadline['"`]|['"`]Milestone['"`]/.test(src)) offenders.push(name);
  }
  assert.ok(scanned >= 30, `fixture check: scanned only ${scanned} files`);
  assert.deepEqual(offenders, []);
});
