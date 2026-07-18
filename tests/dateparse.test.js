import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmartAdd, toISO } from '../js/dateparse.js';

const JUNE_1 = new Date(2026, 5, 1); // months are 0-based: 5 = June

test('toISO formats a local date', () => {
  assert.equal(toISO(new Date(2026, 6, 2)), '2026-07-02');
});

test('parses the ordinal-word example', () => {
  const r = parseSmartAdd('physics assignment due July second', JUNE_1);
  assert.equal(r.title, 'physics assignment');
  assert.equal(r.date, '2026-07-02');
});

test('parses a numeric month/day', () => {
  const r = parseSmartAdd('Bio midterm on July 2', JUNE_1);
  assert.equal(r.title, 'Bio midterm');
  assert.equal(r.date, '2026-07-02');
});

test('parses a numeric ordinal suffix (July 2nd)', () => {
  const r = parseSmartAdd('physics assignment due July 2nd', JUNE_1);
  assert.equal(r.title, 'physics assignment');
  assert.equal(r.date, '2026-07-02');
});

test('parses a compound ordinal word (July twenty-first)', () => {
  const r = parseSmartAdd('quiz July twenty-first', JUNE_1);
  assert.equal(r.title, 'quiz');
  assert.equal(r.date, '2026-07-21');
});

test('parses tomorrow', () => {
  const r = parseSmartAdd('call mom tomorrow', JUNE_1);
  assert.equal(r.date, '2026-06-02');
});

test('parses in N days', () => {
  const r = parseSmartAdd('gym in 3 days', JUNE_1);
  assert.equal(r.date, '2026-06-04');
});

test('parses an ISO date', () => {
  const r = parseSmartAdd('essay 2026-09-15', JUNE_1);
  assert.equal(r.date, '2026-09-15');
});

test('a past month/day rolls to next year', () => {
  const r = parseSmartAdd('reunion May 1', JUNE_1); // May 1 already passed
  assert.equal(r.date, '2027-05-01');
});

test('no date returns null and keeps the text as the title', () => {
  const r = parseSmartAdd('buy groceries', JUNE_1);
  assert.equal(r.date, null);
  assert.equal(r.title, 'buy groceries');
});

test('ordinal words in a title (no month) are NOT mangled', () => {
  const r = parseSmartAdd('buy first aid kit', JUNE_1);
  assert.equal(r.date, null);
  assert.equal(r.title, 'buy first aid kit');
});

test('invalid ISO dates are ignored, not stored', () => {
  const r = parseSmartAdd('essay 2026-13-45', JUNE_1);
  assert.equal(r.date, null);
});
