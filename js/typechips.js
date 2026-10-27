// typechips.js — the type chips under the top add box's date row (option A,
// Alex 2026-10-26). They draw the choice and report it; app.js decides when
// the row shows (only while a date is picked) and what an Add saves (only the
// manual path reads it: a sentence with no date still goes to smart add,
// which picks its own type).
//
// NOT A FIFTH COPY OF THE TYPE LIST (CLAUDE.md). The values below are a
// CHOICE of preview.js's TYPES, and every one must be in it; the text on each
// chip is itemsheet.js's TYPE_LABELS, read from there. Building throws if
// either ever stops holding, rather than drawing a chip with a raw value or a
// type the item sheet cannot show. tests/typechips.test.js scans js/ for the
// label words, so a second table fails there.

import { TYPES } from './preview.js';
import { TYPE_LABELS } from './itemsheet.js';

// Event is first and the default. Idea is not offered (the Ideas box is its
// home), and 'general' is never a new choice (itemsheet.js typeSelect).
export const PRIMARY_TYPES = ['event', 'due', 'task'];
export const MORE_TYPES = ['start', 'milestone'];
const DEFAULT_TYPE = 'event';

function chip(value) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'type-chip';
  b.dataset.type = value;
  b.textContent = TYPE_LABELS[value];
  return b;
}

// Throws unless every offered value is a known type with a label. Exported
// so the guard itself is tested (tests/typechips.test.js).
export function assertOffered(offered, known, labels) {
  for (const t of offered) {
    if (!known.includes(t)) throw new Error(`createTypeChips: ${t} is not a known type`);
    if (!Object.prototype.hasOwnProperty.call(labels, t)) throw new Error(`createTypeChips: no label for type ${t}`);
  }
}

// Builds the chips into `host`, replacing whatever it held. Returns
// { value(), reset() }: value() is the selected type's value; reset() selects
// Event again and folds Start and Milestone back behind More.
export function createTypeChips(host) {
  assertOffered([...PRIMARY_TYPES, ...MORE_TYPES], TYPES, TYPE_LABELS);

  host.innerHTML = '';
  const group = document.createElement('div');
  group.className = 'type-chip-group';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Type');

  const chips = [...PRIMARY_TYPES, ...MORE_TYPES].map(chip);
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'type-chip type-more';
  more.dataset.more = 'true';
  more.textContent = 'More';
  more.setAttribute('aria-label', 'More types');

  let selected = DEFAULT_TYPE;
  const paint = () => {
    for (const b of chips) b.setAttribute('aria-pressed', String(b.dataset.type === selected));
  };
  // More hides itself once open, so a selected Start or Milestone can never
  // be folded out of sight; only reset() folds them away, and it selects
  // Event in the same step.
  const fold = (open) => {
    for (const b of chips) if (MORE_TYPES.includes(b.dataset.type)) b.hidden = !open;
    more.hidden = open;
    more.setAttribute('aria-expanded', String(open));
  };

  for (const b of chips) {
    b.addEventListener('click', () => { selected = b.dataset.type; paint(); });
  }
  // The focused More hides itself, so focus moves to the first chip it
  // revealed; otherwise a keyboard or screen-reader user lands on <body>.
  more.addEventListener('click', () => {
    fold(true);
    chips.find((b) => b.dataset.type === MORE_TYPES[0]).focus();
  });

  group.append(...chips, more);
  host.appendChild(group);
  paint();
  fold(false);

  return {
    value: () => selected,
    reset() { selected = DEFAULT_TYPE; paint(); fold(false); },
  };
}
