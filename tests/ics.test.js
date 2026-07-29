import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unfoldLines, parseProperty, unescapeText } from '../js/ics.js';

test('unfoldLines joins a folded SUMMARY spanning 3 lines (CRLF, single-space continuation)', () => {
  // Two leading spaces on each continuation: one is real content, the other is
  // the fold-artifact whitespace that unfolding strips — leaving one real space.
  const raw = 'SUMMARY:This is a long summary that keeps going and going and\r\n' +
    '  going across multiple folded content lines and\r\n' +
    '  finally ends here\r\n' +
    'UID:abc123\r\n';
  const lines = unfoldLines(raw);
  assert.deepEqual(lines, [
    'SUMMARY:This is a long summary that keeps going and going and going across multiple folded content lines and finally ends here',
    'UID:abc123',
  ]);
});

test('unfoldLines strips exactly one leading space/tab from a continuation, CRLF', () => {
  // Two leading spaces on the continuation: unfolding removes only the first.
  const raw = 'DESCRIPTION:Foo\r\n' +
    '  Bar\r\n';
  const lines = unfoldLines(raw);
  assert.deepEqual(lines, ['DESCRIPTION:Foo Bar']);
});

test('unfoldLines handles a tab-prefixed continuation', () => {
  const raw = 'DESCRIPTION:Foo\r\n' +
    '\tBar\r\n';
  const lines = unfoldLines(raw);
  assert.deepEqual(lines, ['DESCRIPTION:FooBar']);
});

test('unfoldLines handles bare LF-only input (no CR)', () => {
  const raw = 'SUMMARY:Line one\n' +
    '  continues here\n' +
    'UID:xyz\n';
  const lines = unfoldLines(raw);
  assert.deepEqual(lines, ['SUMMARY:Line one continues here', 'UID:xyz']);
});

test('unfoldLines unfolds a real 76-char-folded line from a fixture-style DESCRIPTION', () => {
  // Taken verbatim (structure) from tests/fixtures/icloud-sample.ics: a DESCRIPTION
  // folded at 76 chars mid-word, with an escaped semicolon split across the fold.
  const raw = 'DESCRIPTION:This date is approximate because it is based on a lunar calenda\r\n' +
    ' r\\; the beginning of Ramadan is the day after the new moon.\r\n' +
    'SUMMARY;LANGUAGE=en:First Night of Ramadan\r\n';
  const lines = unfoldLines(raw);
  assert.deepEqual(lines, [
    'DESCRIPTION:This date is approximate because it is based on a lunar calendar\\; the beginning of Ramadan is the day after the new moon.',
    'SUMMARY;LANGUAGE=en:First Night of Ramadan',
  ]);
});

test('unfoldLines drops trailing blank lines produced by a final CRLF', () => {
  const raw = 'UID:only\r\n';
  const lines = unfoldLines(raw);
  assert.deepEqual(lines, ['UID:only']);
});

test('parseProperty parses a simple property with no params', () => {
  const result = parseProperty('UID:237447d9-0387-3a3d-b47b-b6e13049edd9');
  assert.deepEqual(result, {
    name: 'UID',
    params: {},
    value: '237447d9-0387-3a3d-b47b-b6e13049edd9',
  });
});

test('parseProperty parses DTSTART with a TZID param', () => {
  const result = parseProperty('DTSTART;TZID=America/New_York:20260901T090000');
  assert.deepEqual(result, {
    name: 'DTSTART',
    params: { TZID: 'America/New_York' },
    value: '20260901T090000',
  });
});

test('parseProperty parses a quoted param containing a comma', () => {
  const result = parseProperty('ORGANIZER;CN="Doe, John":mailto:john@example.com');
  assert.deepEqual(result, {
    name: 'ORGANIZER',
    params: { CN: 'Doe, John' },
    value: 'mailto:john@example.com',
  });
});

test('parseProperty parses a quoted param containing a colon and semicolon', () => {
  const result = parseProperty('ATTENDEE;CN="Weird: Name; Here":mailto:weird@example.com');
  assert.deepEqual(result, {
    name: 'ATTENDEE',
    params: { CN: 'Weird: Name; Here' },
    value: 'mailto:weird@example.com',
  });
});

test('parseProperty parses multiple params, mixing quoted and bare', () => {
  const result = parseProperty('DTSTART;TZID=America/New_York;VALUE=DATE-TIME:20260901T090000');
  assert.deepEqual(result, {
    name: 'DTSTART',
    params: { TZID: 'America/New_York', VALUE: 'DATE-TIME' },
    value: '20260901T090000',
  });
});

test('parseProperty handles VALUE=DATE all-day properties', () => {
  const result = parseProperty('DTSTART;VALUE=DATE:20250101');
  assert.deepEqual(result, {
    name: 'DTSTART',
    params: { VALUE: 'DATE' },
    value: '20250101',
  });
});

test('unescapeText converts escaped commas', () => {
  assert.equal(unescapeText('Doe\\, John'), 'Doe, John');
});

test('unescapeText converts escaped semicolons', () => {
  assert.equal(unescapeText('the beginning of Ramadan\\; the day after'), 'the beginning of Ramadan; the day after');
});

test('unescapeText converts escaped newlines, lowercase n and uppercase N', () => {
  assert.equal(unescapeText('line one\\nline two'), 'line one\nline two');
  assert.equal(unescapeText('line one\\Nline two'), 'line one\nline two');
});

test('unescapeText converts escaped backslashes', () => {
  assert.equal(unescapeText('C:\\\\Users\\\\test'), 'C:\\Users\\test');
});

test('unescapeText handles a mix of escapes in a SUMMARY-like string', () => {
  assert.equal(
    unescapeText('Meeting with Doe\\, John\\; bring notes\\nsee you there'),
    'Meeting with Doe, John; bring notes\nsee you there'
  );
});

test('unescapeText leaves unescaped text untouched', () => {
  assert.equal(unescapeText('Plain text, no escapes; here'), 'Plain text, no escapes; here');
});
