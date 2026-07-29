import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unfoldLines, parseProperty, unescapeText,
  zonedWallClockToInstant, resolveTzid, icsDateToLocal, UnknownTz,
} from '../js/ics.js';

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

test('parseProperty upper-cases param keys (RFC 5545 param names are case-insensitive), values untouched', () => {
  const result = parseProperty('DTSTART;tzid=America/New_York:20260901T090000');
  assert.deepEqual(result, {
    name: 'DTSTART',
    params: { TZID: 'America/New_York' }, // key upper-cased; value case preserved
    value: '20260901T090000',
  });
});

test('parseProperty upper-cases a mixed-case param key too (not just all-lowercase)', () => {
  const result = parseProperty('DTSTART;TzId=America/New_York:20260901T090000');
  assert.deepEqual(result.params, { TZID: 'America/New_York' });
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

test('unescapeText: an escaped backslash followed by a literal n is backslash+n, not a newline', () => {
  // Regression pin for if-chain ordering: input is TWO literal backslashes
  // followed by a literal 'n' (String.raw makes the actual characters
  // explicit: \, \, n). A left-to-right single pass must consume the pair
  // as one \\->\  escape first, then treat the trailing 'n' as an ordinary
  // character — NOT interpret the second backslash + 'n' as a \n newline
  // escape. If the if-chain were ever reordered to check \n/\N before \\,
  // or the pair-consumption were dropped, this would wrongly collapse to
  // a newline.
  const input = String.raw`foo\\nbar`; // foo, \, \, n, b, a, r
  const expected = String.raw`foo\nbar`; // foo, \, n, b, a, r (literal, no newline)
  const result = unescapeText(input);
  assert.equal(result, expected);
  assert.equal(result.includes('\n'), false);
});

// ---------------------------------------------------------------------------
// resolveTzid
// ---------------------------------------------------------------------------

test('resolveTzid passes through a valid IANA zone name unchanged', () => {
  assert.equal(resolveTzid('America/New_York'), 'America/New_York');
  assert.equal(resolveTzid('Australia/Sydney'), 'Australia/Sydney');
  assert.equal(resolveTzid('UTC'), 'UTC');
});

test('resolveTzid maps a Windows TZID via the CLDR windowsZones table', () => {
  assert.equal(resolveTzid('W. Europe Standard Time'), 'Europe/Berlin');
  assert.equal(resolveTzid('Pacific Standard Time'), 'America/Los_Angeles');
  assert.equal(resolveTzid('AUS Eastern Standard Time'), 'Australia/Sydney');
});

test('resolveTzid throws UnknownTz for a garbage TZID (zero fallback, no guessing)', () => {
  assert.throws(() => resolveTzid('Not/AZone'), UnknownTz);
  assert.throws(() => resolveTzid('Bogus Standard Time'), UnknownTz);
  try {
    resolveTzid('Totally Made Up Zone');
    assert.fail('expected resolveTzid to throw');
  } catch (err) {
    assert.equal(err.name, 'UnknownTz');
    assert.equal(err.raw, 'Totally Made Up Zone');
  }
});

// ---------------------------------------------------------------------------
// zonedWallClockToInstant — the inverse of Intl.DateTimeFormat.
//
// Expected instants below are cross-checked against Date.parse of an ISO
// string with an explicit numeric UTC offset (e.g. '-04:00'), which is
// parsed per ECMA-262 independent of the host's tzdata / Intl — a ground
// truth that doesn't rely on the same machinery under test.
// ---------------------------------------------------------------------------

test('zonedWallClockToInstant: ordinary wall time, no nearby DST transition (America/New_York, EDT)', () => {
  const parts = { year: 2026, month: 9, day: 1, hour: 9, minute: 0, second: 0 };
  const got = zonedWallClockToInstant(parts, 'America/New_York');
  assert.equal(got, Date.parse('2026-09-01T09:00:00-04:00'));
});

test('zonedWallClockToInstant: ordinary wall time in America/Los_Angeles (PDT)', () => {
  const parts = { year: 2026, month: 9, day: 1, hour: 9, minute: 0, second: 0 };
  const got = zonedWallClockToInstant(parts, 'America/Los_Angeles');
  assert.equal(got, Date.parse('2026-09-01T09:00:00-07:00'));
});

test('zonedWallClockToInstant: UTC zone is its own inverse', () => {
  const parts = { year: 2026, month: 6, day: 15, hour: 12, minute: 30, second: 0 };
  const got = zonedWallClockToInstant(parts, 'UTC');
  assert.equal(got, Date.UTC(2026, 5, 15, 12, 30, 0));
});

test('zonedWallClockToInstant: Australia/Sydney southern-hemisphere DST sign (AEDT, +11)', () => {
  // January is high summer in Sydney: AEDT is in effect, UTC+11 — the
  // opposite seasonal sign from the northern-hemisphere zones above.
  const parts = { year: 2026, month: 1, day: 15, hour: 10, minute: 0, second: 0 };
  const got = zonedWallClockToInstant(parts, 'Australia/Sydney');
  assert.equal(got, Date.parse('2026-01-15T10:00:00+11:00'));
});

test('zonedWallClockToInstant: Australia/Sydney standard time (AEST, +10)', () => {
  // July is midwinter in Sydney: AEST, UTC+10.
  const parts = { year: 2026, month: 7, day: 15, hour: 10, minute: 0, second: 0 };
  const got = zonedWallClockToInstant(parts, 'Australia/Sydney');
  assert.equal(got, Date.parse('2026-07-15T10:00:00+10:00'));
});

test('zonedWallClockToInstant: DST fall-back ambiguity (America/New_York) resolves to first occurrence / DST offset', () => {
  // 2026-11-01 02:00:00 EDT -> 01:00:00 EST. Wall times 01:00-01:59 occur
  // twice. Policy: first occurrence, i.e. the EDT (UTC-4) reading.
  const parts = { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 };
  const got = zonedWallClockToInstant(parts, 'America/New_York');
  assert.equal(got, Date.parse('2026-11-01T01:30:00-04:00'));
  assert.notEqual(got, Date.parse('2026-11-01T01:30:00-05:00'));
});

test('zonedWallClockToInstant: DST fall-back ambiguity (Australia/Sydney) resolves to first occurrence / DST offset', () => {
  // 2026-04-05 03:00:00 AEDT -> 02:00:00 AEST. Wall times 02:00-02:59 occur
  // twice. Policy: first occurrence, i.e. the AEDT (UTC+11) reading.
  const parts = { year: 2026, month: 4, day: 5, hour: 2, minute: 30, second: 0 };
  const got = zonedWallClockToInstant(parts, 'Australia/Sydney');
  assert.equal(got, Date.parse('2026-04-05T02:30:00+11:00'));
  assert.notEqual(got, Date.parse('2026-04-05T02:30:00+10:00'));
});

test('zonedWallClockToInstant: spring-forward gap (America/New_York) shifts forward by the gap width', () => {
  // 2026-03-08 02:00:00 EST -> 03:00:00 EDT. Wall times 02:00-02:59 never
  // occur. Policy: shift forward by the 1-hour gap width, landing at 03:30 EDT.
  const parts = { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 };
  const got = zonedWallClockToInstant(parts, 'America/New_York');
  assert.equal(got, Date.parse('2026-03-08T03:30:00-04:00'));
});

test('zonedWallClockToInstant: spring-forward gap (Australia/Sydney) shifts forward by the gap width', () => {
  // 2026-10-04 02:00:00 AEST -> 03:00:00 AEDT. Wall times 02:00-02:59 never
  // occur. Policy: shift forward by the 1-hour gap width, landing at 03:30 AEDT.
  const parts = { year: 2026, month: 10, day: 4, hour: 2, minute: 30, second: 0 };
  const got = zonedWallClockToInstant(parts, 'Australia/Sydney');
  assert.equal(got, Date.parse('2026-10-04T03:30:00+11:00'));
});

// ---------------------------------------------------------------------------
// icsDateToLocal — all DTSTART/DTEND forms.
// ---------------------------------------------------------------------------

test('icsDateToLocal: VALUE=DATE (all-day) form has a null time', () => {
  const result = icsDateToLocal('20250101', { VALUE: 'DATE' }, 'America/New_York');
  assert.deepEqual(result, { date: '2025-01-01', time: null });
});

test('icsDateToLocal: VALUE=DATE form recognized even without an explicit VALUE param (no "T")', () => {
  const result = icsDateToLocal('20250101', {}, 'America/New_York');
  assert.deepEqual(result, { date: '2025-01-01', time: null });
});

test('icsDateToLocal: UTC "Z" form converts the instant into targetTz wall clock', () => {
  // 13:00 UTC in September is 09:00 EDT (America/New_York, UTC-4, no nearby transition).
  const result = icsDateToLocal('20260901T130000Z', {}, 'America/New_York');
  assert.deepEqual(result, { date: '2026-09-01', time: '09:00' });
});

test('icsDateToLocal: floating time (no Z, no TZID) is targetTz wall time as-is, no conversion', () => {
  const result = icsDateToLocal('20260901T090000', {}, 'America/Los_Angeles');
  assert.deepEqual(result, { date: '2026-09-01', time: '09:00' });
});

test('icsDateToLocal: TZID form converts a zoned wall clock across two fixed zones (America/New_York -> America/Los_Angeles)', () => {
  // 09:00 EDT (America/New_York, UTC-4) = 13:00 UTC = 06:00 PDT (America/Los_Angeles, UTC-7).
  const result = icsDateToLocal('20260901T090000', { TZID: 'America/New_York' }, 'America/Los_Angeles');
  assert.deepEqual(result, { date: '2026-09-01', time: '06:00' });
});

test('icsDateToLocal: TZID form round-trips when targetTz equals the source TZID', () => {
  const result = icsDateToLocal('20260901T090000', { TZID: 'America/New_York' }, 'America/New_York');
  assert.deepEqual(result, { date: '2026-09-01', time: '09:00' });
});

test('icsDateToLocal: TZID form resolves a Windows TZID via tzmap before converting', () => {
  // "W. Europe Standard Time" -> Europe/Berlin. 2026-09-01 09:00 CEST (UTC+2)
  // = 07:00 UTC = 03:00 EDT (America/New_York, UTC-4).
  const result = icsDateToLocal(
    '20260901T090000',
    { TZID: 'W. Europe Standard Time' },
    'America/New_York',
  );
  assert.deepEqual(result, { date: '2026-09-01', time: '03:00' });
});

test('icsDateToLocal: TZID form throws UnknownTz for a garbage TZID (caller skips the event)', () => {
  assert.throws(
    () => icsDateToLocal('20260901T090000', { TZID: 'Not/AZone' }, 'America/New_York'),
    UnknownTz,
  );
});

test('icsDateToLocal: TZID form on a DST fall-back ambiguous wall clock uses the first-occurrence policy end to end', () => {
  const result = icsDateToLocal(
    '20261101T013000',
    { TZID: 'America/New_York' },
    'America/New_York',
  );
  // Round-tripping through the same zone on an ambiguous wall clock should
  // reproduce the same wall clock (first/DST occurrence), not silently
  // shift to the other (EST) occurrence.
  assert.deepEqual(result, { date: '2026-11-01', time: '01:30' });
});

// ---------------------------------------------------------------------------
// Case-insensitive param names (review fix): RFC 5545 param names are
// case-insensitive; a producer writing "tzid=" or "value=" must convert
// exactly the same as the canonical uppercase form — parseProperty upper-
// cases keys so every consumer (icsDateToLocal included) benefits.
// ---------------------------------------------------------------------------

test('icsDateToLocal: a lowercase "tzid" param still converts correctly (not silently treated as floating)', () => {
  const { params, value } = parseProperty('DTSTART;tzid=America/New_York:20260901T090000');
  const result = icsDateToLocal(value, params, 'America/Los_Angeles');
  // 09:00 EDT (America/New_York) = 13:00 UTC = 06:00 PDT (America/Los_Angeles).
  assert.deepEqual(result, { date: '2026-09-01', time: '06:00' });
});

test('icsDateToLocal: a lowercase "value=DATE" param still detected as all-day', () => {
  const { params, value } = parseProperty('DTSTART;value=DATE:20250101');
  const result = icsDateToLocal(value, params, 'America/New_York');
  assert.deepEqual(result, { date: '2025-01-01', time: null });
});

// ---------------------------------------------------------------------------
// Range validation (review fix): Date.UTC silently normalizes out-of-range
// components (month 13 rolls into the next year, day 32 rolls into the next
// month, etc.) — a malformed ICS value must throw, not silently produce a
// different, wrong-but-valid-looking date.
// ---------------------------------------------------------------------------

test('icsDateToLocal: throws on an out-of-range month (13) in a DATE value', () => {
  assert.throws(() => icsDateToLocal('20261301', {}, 'America/New_York'));
});

test('icsDateToLocal: throws on an out-of-range month (00) in a DATE value', () => {
  assert.throws(() => icsDateToLocal('20260001', {}, 'America/New_York'));
});

test('icsDateToLocal: throws on an out-of-range day (32) in a DATE-TIME value', () => {
  assert.throws(() => icsDateToLocal('20260932T090000', {}, 'America/New_York'));
});

test('icsDateToLocal: throws on an out-of-range day (00) in a DATE value', () => {
  assert.throws(() => icsDateToLocal('20260900', {}, 'America/New_York'));
});

test('icsDateToLocal: throws on an out-of-range hour (24) in a DATE-TIME value', () => {
  assert.throws(() => icsDateToLocal('20260901T240000', {}, 'America/New_York'));
});

test('icsDateToLocal: throws on an out-of-range minute (60) in a DATE-TIME value', () => {
  assert.throws(() => icsDateToLocal('20260901T096000', {}, 'America/New_York'));
});

test('icsDateToLocal: throws on an out-of-range second (60) in a DATE-TIME value', () => {
  assert.throws(() => icsDateToLocal('20260901T090060', {}, 'America/New_York'));
});

test('icsDateToLocal: valid boundary values (month 12, day 31, hour 23, minute 59, second 59) do not throw', () => {
  assert.doesNotThrow(() => icsDateToLocal('20261231T235959', {}, 'America/New_York'));
});
