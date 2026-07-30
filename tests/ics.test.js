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

// ===========================================================================
// Task 4 — VEVENT parsing, RRULE expansion, skipped accounting.
//
// Test helpers build ICS text with CRLF endings (what every real provider
// emits) so parseICS is exercised through unfoldLines the same way a real
// feed is.
// ===========================================================================

import { readFileSync } from 'node:fs';
import {
  parseICS, expandEvents, parseRRule, UnsupportedRRule,
  parseIcsDateValue, parseDuration,
  nextWeeklyInstances, nthWeekdayOfMonth, applyExdates,
} from '../js/ics.js';

const NY = 'America/New_York';

function vevent(...lines) {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

function ics(...veventBlocks) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//plaenicke test//EN',
    ...veventBlocks.flat(),
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}

// shape(): the assertion-friendly projection of an EventInstance.
function shape(inst) {
  return [inst.date, inst.time, inst.endTime];
}

function expand(text, from, to, tz = NY) {
  const parsed = parseICS(text);
  assert.deepEqual(parsed.skipped, [], 'unexpected skipped events in fixture-under-test');
  return expandEvents(parsed, from, to, tz);
}

// ---------------------------------------------------------------------------
// parseICS structure
// ---------------------------------------------------------------------------

test('parseICS returns one ParsedEvent per VEVENT with the compact serializable shape', () => {
  const text = ics(vevent(
    'UID:evt-1',
    'SUMMARY:Statics Lecture',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'DTEND;TZID=America/New_York:20260901T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
  ));
  const { events, skipped } = parseICS(text);
  assert.deepEqual(skipped, []);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    uid: 'evt-1',
    title: 'Statics Lecture',
    form: 'TZID',
    dtstart: { value: '20260901T090000', tzid: NY },
    dtend: { value: '20260901T100000', tzid: NY },
    duration: null,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    exdates: [],
    recurrenceId: null,
  });
  // JSON-serializable (it is persisted in the feed cache).
  assert.deepEqual(JSON.parse(JSON.stringify(events[0])), events[0]);
});

test('parseICS unescapes SUMMARY text and honors a SUMMARY;LANGUAGE param', () => {
  const text = ics(vevent(
    'UID:e',
    'SUMMARY;LANGUAGE=en:Doe\\, John\; bring notes',
    'DTSTART;VALUE=DATE:20260901',
  ));
  assert.equal(parseICS(text).events[0].title, 'Doe, John; bring notes');
});

test('parseICS ignores properties inside a nested VALARM (its DURATION must not become the event duration)', () => {
  const text = ics(vevent(
    'UID:e',
    'SUMMARY:With alarm',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'DTEND;TZID=America/New_York:20260901T100000',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'DURATION:PT5M',
    'REPEAT:2',
    'END:VALARM',
  ));
  const ev = parseICS(text).events[0];
  assert.equal(ev.duration, null);
  assert.deepEqual(ev.dtend, { value: '20260901T100000', tzid: NY });
});

test('parseICS ignores a VTIMEZONE block entirely (its DTSTART/RRULE must not create an event)', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'BEGIN:DAYLIGHT',
    'DTSTART:20070311T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    ...vevent('UID:e', 'SUMMARY:Real event', 'DTSTART;VALUE=DATE:20260901'),
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
  const { events, skipped } = parseICS(text);
  assert.deepEqual(skipped, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Real event');
});

test('parseICS collects EXDATE from both comma-joined values and repeated lines', () => {
  const text = ics(vevent(
    'UID:e',
    'SUMMARY:Daily',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;COUNT=5',
    'EXDATE;TZID=America/New_York:20260902T090000,20260903T090000',
    'EXDATE;TZID=America/New_York:20260904T090000',
  ));
  assert.deepEqual(parseICS(text).events[0].exdates, [
    { value: '20260902T090000', tzid: NY },
    { value: '20260903T090000', tzid: NY },
    { value: '20260904T090000', tzid: NY },
  ]);
});

// ---------------------------------------------------------------------------
// skipped accounting — every skip carries uid, summary and a reason
// ---------------------------------------------------------------------------

test('parseICS skips a BYSETPOS rule with the event summary present (never silently dropped)', () => {
  const text = ics(vevent(
    'UID:setpos-1',
    'SUMMARY:Statics Lecture',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1',
  ));
  const { events, skipped } = parseICS(text);
  assert.deepEqual(events, []);
  assert.deepEqual(skipped, [
    { uid: 'setpos-1', summary: 'Statics Lecture', reason: 'unsupported_bysetpos' },
  ]);
});

test('parseICS skips a malformed DTSTART with reason bad_date', () => {
  const text = ics(vevent(
    'UID:bad-1',
    'SUMMARY:Broken date',
    'DTSTART;TZID=America/New_York:20261301T090000',
  ));
  const { events, skipped } = parseICS(text);
  assert.deepEqual(events, []);
  assert.deepEqual(skipped, [
    { uid: 'bad-1', summary: 'Broken date', reason: 'bad_date' },
  ]);
});

test('parseICS skips an unresolvable TZID with reason unknown_tz', () => {
  const text = ics(vevent(
    'UID:tz-1',
    'SUMMARY:Bad zone',
    'DTSTART;TZID=Not/AZone:20260901T090000',
  ));
  assert.deepEqual(parseICS(text).skipped, [
    { uid: 'tz-1', summary: 'Bad zone', reason: 'unknown_tz' },
  ]);
});

test('parseICS skips a DTEND that precedes DTSTART with reason bad_date', () => {
  const text = ics(vevent(
    'UID:rev-1',
    'SUMMARY:Backwards',
    'DTSTART;TZID=America/New_York:20260901T100000',
    'DTEND;TZID=America/New_York:20260901T090000',
  ));
  assert.deepEqual(parseICS(text).skipped, [
    { uid: 'rev-1', summary: 'Backwards', reason: 'bad_date' },
  ]);
});

test('parseICS skips a VEVENT with no DTSTART and a VEVENT with no UID', () => {
  const text = ics(
    vevent('UID:no-start', 'SUMMARY:No start'),
    vevent('SUMMARY:No uid', 'DTSTART;VALUE=DATE:20260901'),
  );
  const { events, skipped } = parseICS(text);
  assert.deepEqual(events, []);
  assert.deepEqual(skipped, [
    { uid: 'no-start', summary: 'No start', reason: 'missing_dtstart' },
    { uid: null, summary: 'No uid', reason: 'missing_uid' },
  ]);
});

test('parseICS skips an RDATE event rather than silently losing its extra instances', () => {
  const text = ics(vevent(
    'UID:rdate-1',
    'SUMMARY:Has RDATE',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=WEEKLY',
    'RDATE;TZID=America/New_York:20260915T110000',
  ));
  assert.deepEqual(parseICS(text).skipped, [
    { uid: 'rdate-1', summary: 'Has RDATE', reason: 'unsupported_rdate' },
  ]);
});

test('parseICS keeps one bad event from killing the feed (good events still parsed)', () => {
  const text = ics(
    vevent('UID:good-1', 'SUMMARY:Good one', 'DTSTART;VALUE=DATE:20260901'),
    vevent('UID:bad-1', 'SUMMARY:Bad one', 'DTSTART;VALUE=DATE:20261301'),
    vevent('UID:good-2', 'SUMMARY:Good two', 'DTSTART;VALUE=DATE:20260902'),
  );
  const { events, skipped } = parseICS(text);
  assert.deepEqual(events.map((e) => e.uid), ['good-1', 'good-2']);
  assert.deepEqual(skipped, [{ uid: 'bad-1', summary: 'Bad one', reason: 'bad_date' }]);
});

// ---------------------------------------------------------------------------
// parseRRule — the three-list policy
// ---------------------------------------------------------------------------

test('parseRRule accepts the supported parts and defaults INTERVAL to 1', () => {
  const rule = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260116T235959Z');
  assert.equal(rule.freq, 'WEEKLY');
  assert.equal(rule.interval, 1);
  assert.equal(rule.count, null);
  assert.deepEqual(rule.byday, [
    { ordinal: null, dow: 'MO' },
    { ordinal: null, dow: 'WE' },
    { ordinal: null, dow: 'FR' },
  ]);
  assert.equal(rule.until.value, '20260116T235959Z');
});

test('parseRRule accepts ordinal BYDAY with BYMONTH (the real iCloud yearly shape)', () => {
  const rule = parseRRule('FREQ=YEARLY;COUNT=5;BYDAY=-1MO;BYMONTH=5');
  assert.equal(rule.count, 5);
  assert.deepEqual(rule.byday, [{ ordinal: -1, dow: 'MO' }]);
  assert.deepEqual(rule.bymonth, [5]);
});

test('parseRRule ignores WKST when harmless (WEEKLY INTERVAL=1 multi-BYDAY — real Google shape)', () => {
  assert.doesNotThrow(() => parseRRule('FREQ=WEEKLY;WKST=SU;BYDAY=MO,WE,FR;UNTIL=20260116T235959Z'));
});

test('parseRRule ignores WKST=MO even in the otherwise-dangerous combination (it is the default)', () => {
  assert.doesNotThrow(() => parseRRule('FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=MO,WE'));
});

test('parseRRule ignores a non-MO WKST with a single BYDAY and INTERVAL>1 (week start cannot change the result)', () => {
  assert.doesNotThrow(() => parseRRule('FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=WE'));
});

test('parseRRule rejects non-MO WKST with WEEKLY + INTERVAL>1 + multi-day BYDAY (unsupported_wkst)', () => {
  try {
    parseRRule('FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,WE');
    assert.fail('expected parseRRule to throw');
  } catch (err) {
    assert.ok(err instanceof UnsupportedRRule);
    assert.equal(err.reason, 'unsupported_wkst');
  }
});

test('parseRRule ignores X- parts', () => {
  assert.doesNotThrow(() => parseRRule('FREQ=DAILY;X-MICROSOFT-SOMETHING=1'));
});

test('parseRRule rejects each skip-triggering part with its own reason (no permissive catch-all)', () => {
  const cases = [
    ['FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1', 'unsupported_bysetpos'],
    ['FREQ=YEARLY;BYWEEKNO=20', 'unsupported_byweekno'],
    ['FREQ=YEARLY;BYYEARDAY=100', 'unsupported_byyearday'],
    ['FREQ=MONTHLY;BYMONTHDAY=1,15', 'unsupported_bymonthday_multi'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', 'unsupported_bymonthday_negative'],
    ['FREQ=HOURLY;INTERVAL=6', 'unsupported_freq_subdaily'],
    ['FREQ=MINUTELY', 'unsupported_freq_subdaily'],
    ['FREQ=WEIRDLY', 'unsupported_freq'],
    ['FREQ=DAILY;BYHOUR=9', 'unsupported_byhour'],
    ['FREQ=DAILY;BYDAY=MO', 'unsupported_byday_daily'],
    ['FREQ=WEEKLY;BYDAY=2MO', 'unsupported_byday_ordinal_weekly'],
    ['FREQ=MONTHLY;BYDAY=MO', 'unsupported_byday_nonordinal'],
    ['FREQ=DAILY;SOMETHINGELSE=7', 'unsupported_rrule_part_somethingelse'],
    ['INTERVAL=2', 'bad_rrule'],
    ['FREQ=DAILY;INTERVAL=0', 'bad_rrule'],
    ['FREQ=DAILY;UNTIL=20261301', 'bad_date'],
  ];
  for (const [text, reason] of cases) {
    try {
      parseRRule(text);
      assert.fail(`expected ${text} to throw`);
    } catch (err) {
      assert.ok(err instanceof UnsupportedRRule, `${text} threw ${err}`);
      assert.equal(err.reason, reason, `reason for ${text}`);
    }
  }
});

test('parseICS surfaces an unsupported_wkst rule as a skipped event with its summary', () => {
  const text = ics(vevent(
    'UID:wkst-1',
    'SUMMARY:Biweekly standup',
    'DTSTART;TZID=America/New_York:20260105T090000',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,WE',
  ));
  assert.deepEqual(parseICS(text).skipped, [
    { uid: 'wkst-1', summary: 'Biweekly standup', reason: 'unsupported_wkst' },
  ]);
});

// ---------------------------------------------------------------------------
// Small helpers, separately exported and tested
// ---------------------------------------------------------------------------

test('parseIcsDateValue reports the four forms with a resolved tzid', () => {
  assert.deepEqual(parseIcsDateValue('20250101', { VALUE: 'DATE' }), {
    form: 'DATE', tzid: null, year: 2025, month: 1, day: 1, hour: 0, minute: 0, second: 0,
  });
  assert.deepEqual(parseIcsDateValue('20260901T130000Z', {}), {
    form: 'UTC', tzid: null, year: 2026, month: 9, day: 1, hour: 13, minute: 0, second: 0,
  });
  assert.deepEqual(parseIcsDateValue('20260901T090000', { TZID: 'W. Europe Standard Time' }), {
    form: 'TZID', tzid: 'Europe/Berlin', year: 2026, month: 9, day: 1, hour: 9, minute: 0, second: 0,
  });
  assert.deepEqual(parseIcsDateValue('20260901T090000', {}), {
    form: 'FLOATING', tzid: null, year: 2026, month: 9, day: 1, hour: 9, minute: 0, second: 0,
  });
});

test('parseIcsDateValue throws on out-of-range components and on garbage', () => {
  assert.throws(() => parseIcsDateValue('20261301', {}));
  assert.throws(() => parseIcsDateValue('nonsense', {}));
  assert.throws(() => parseIcsDateValue('20260901T250000', {}));
});

test('parseDuration parses the RFC forms used by real feeds', () => {
  assert.equal(parseDuration('PT1H'), 3600000);
  assert.equal(parseDuration('PT30M'), 1800000);
  assert.equal(parseDuration('PT1H30M'), 5400000);
  assert.equal(parseDuration('P1D'), 86400000);
  assert.equal(parseDuration('P1DT2H30M'), 86400000 + 2 * 3600000 + 1800000);
  assert.equal(parseDuration('PT45S'), 45000);
  assert.equal(parseDuration('P1W'), 7 * 86400000);
});

test('parseDuration throws on garbage and on a negative duration', () => {
  assert.throws(() => parseDuration('1 hour'));
  assert.throws(() => parseDuration('P'));
  assert.throws(() => parseDuration('-PT1H'));
});

test('nthWeekdayOfMonth finds positive and negative ordinals', () => {
  assert.equal(nthWeekdayOfMonth(2026, 9, 2, 'TU'), 8);   // 2nd Tuesday, Sep 2026
  assert.equal(nthWeekdayOfMonth(2026, 9, -1, 'FR'), 25); // last Friday, Sep 2026
  assert.equal(nthWeekdayOfMonth(2026, 1, 3, 'MO'), 19);  // MLK Day 2026
  assert.equal(nthWeekdayOfMonth(2026, 6, 5, 'MO'), 29);  // June 2026 has five Mondays
});

test('nthWeekdayOfMonth returns null when the ordinal does not exist that month', () => {
  assert.equal(nthWeekdayOfMonth(2026, 7, 5, 'MO'), null); // July 2026 has four Mondays
  assert.equal(nthWeekdayOfMonth(2026, 9, 5, 'MO'), null);
  assert.equal(nthWeekdayOfMonth(2026, 9, -5, 'FR'), null);
});

test('nextWeeklyInstances anchors the INTERVAL cycle phase to the start date', () => {
  // DTSTART Mon 2026-01-05, INTERVAL=3 -> weeks 0,3,6,9,12,15 = Jan 5, Jan 26,
  // Feb 16, Mar 9, Mar 30, Apr 20.
  assert.deepEqual(
    nextWeeklyInstances('2026-01-05', ['MO'], 3, '2026-01-01', '2026-04-30'),
    ['2026-01-05', '2026-01-26', '2026-02-16', '2026-03-09', '2026-03-30', '2026-04-20'],
  );
  // A window that starts 10 weeks in must still land on the DTSTART-aligned
  // weeks 12 and 15 — not on weeks 10 and 13.
  assert.deepEqual(
    nextWeeklyInstances('2026-01-05', ['MO'], 3, '2026-03-16', '2026-04-26'),
    ['2026-03-30', '2026-04-20'],
  );
});

test('nextWeeklyInstances expands a multi-day BYDAY list and defaults to the start weekday', () => {
  assert.deepEqual(
    nextWeeklyInstances('2026-01-05', ['MO', 'WE', 'FR'], 1, '2026-01-01', '2026-01-16'),
    ['2026-01-05', '2026-01-07', '2026-01-09', '2026-01-12', '2026-01-14', '2026-01-16'],
  );
  assert.deepEqual(
    nextWeeklyInstances('2026-01-05', [], 1, '2026-01-01', '2026-01-31'),
    ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'],
  );
});

test('nextWeeklyInstances never returns a date before the start date', () => {
  // BYDAY includes a weekday earlier in DTSTART's own week (Mon) — the
  // pre-DTSTART Monday of that week must not be emitted.
  assert.deepEqual(
    nextWeeklyInstances('2026-01-07', ['MO', 'WE'], 1, '2026-01-01', '2026-01-14'),
    ['2026-01-07', '2026-01-12', '2026-01-14'],
  );
});

test('applyExdates removes matching occurrences by date (all-day) and by instant (timed)', () => {
  const occurrences = [
    { dateStr: '2026-09-01', instantMs: Date.parse('2026-09-01T09:00:00-04:00') },
    { dateStr: '2026-09-02', instantMs: Date.parse('2026-09-02T09:00:00-04:00') },
    { dateStr: '2026-09-03', instantMs: Date.parse('2026-09-03T09:00:00-04:00') },
  ];
  const byInstant = applyExdates(occurrences, [{ value: '20260902T090000', tzid: NY }], NY);
  assert.deepEqual(byInstant.map((o) => o.dateStr), ['2026-09-01', '2026-09-03']);

  const byDate = applyExdates(occurrences, [{ value: '20260903', tzid: null }], NY);
  assert.deepEqual(byDate.map((o) => o.dateStr), ['2026-09-01', '2026-09-02']);
});

test('applyExdates leaves occurrences untouched when nothing matches', () => {
  const occurrences = [{ dateStr: '2026-09-01', instantMs: 1 }];
  assert.deepEqual(applyExdates(occurrences, [{ value: '20260902', tzid: null }], NY), occurrences);
  assert.deepEqual(applyExdates(occurrences, [], NY), occurrences);
});

// ---------------------------------------------------------------------------
// expandEvents — single (non-recurring) events
// ---------------------------------------------------------------------------

test('expandEvents returns a single timed event inside the range with start and end times', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Lecture',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'DTEND;TZID=America/New_York:20260901T100000',
  ));
  const out = expand(text, '2026-09-01', '2026-09-30');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    uid: 'e', title: 'Lecture', date: '2026-09-01', time: '09:00', endTime: '10:00',
  });
});

test('expandEvents returns nothing for a single timed event outside the range', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Lecture',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'DTEND;TZID=America/New_York:20260901T100000',
  ));
  assert.deepEqual(expand(text, '2026-10-01', '2026-10-31'), []);
});

test('expandEvents converts a UTC-form event into the target zone', () => {
  const text = ics(vevent('UID:e', 'SUMMARY:UTC event', 'DTSTART:20260901T130000Z', 'DTEND:20260901T140000Z'));
  assert.deepEqual(shape(expand(text, '2026-09-01', '2026-09-01')[0]), ['2026-09-01', '09:00', '10:00']);
});

test('expandEvents treats a floating event as target-zone wall time in any target zone', () => {
  const text = ics(vevent('UID:e', 'SUMMARY:Floating', 'DTSTART:20260901T090000', 'DTEND:20260901T100000'));
  assert.deepEqual(shape(expand(text, '2026-09-01', '2026-09-01', NY)[0]), ['2026-09-01', '09:00', '10:00']);
  assert.deepEqual(shape(expand(text, '2026-09-01', '2026-09-01', 'Australia/Sydney')[0]), ['2026-09-01', '09:00', '10:00']);
});

test('expandEvents computes the end from DURATION when DTEND is absent (PT1H)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Duration event',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'DURATION:PT1H',
  ));
  assert.deepEqual(shape(expand(text, '2026-09-01', '2026-09-01')[0]), ['2026-09-01', '09:00', '10:00']);
});

test('expandEvents gives a DTEND==DTSTART timed event a null endTime (Canvas assignment shape)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Assignment due',
    'DTSTART;TZID=America/New_York:20260901T235900',
    'DTEND;TZID=America/New_York:20260901T235900',
  ));
  assert.deepEqual(shape(expand(text, '2026-09-01', '2026-09-01')[0]), ['2026-09-01', '23:59', null]);
});

test('expandEvents gives a timed event with neither DTEND nor DURATION a null endTime', () => {
  const text = ics(vevent('UID:e', 'SUMMARY:Pinned', 'DTSTART;TZID=America/New_York:20260901T090000'));
  assert.deepEqual(shape(expand(text, '2026-09-01', '2026-09-01')[0]), ['2026-09-01', '09:00', null]);
});

test('expandEvents gives an all-day event with no DTEND exactly one untimed day (iCloud shape)', () => {
  const text = ics(vevent('UID:e', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260901'));
  const out = expand(text, '2026-08-25', '2026-09-10');
  assert.equal(out.length, 1);
  assert.deepEqual(shape(out[0]), ['2026-09-01', null, null]);
});

test('expandEvents treats an all-day DTEND as exclusive (Google one-day holiday shape)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Independence Day',
    'DTSTART;VALUE=DATE:20260704', 'DTEND;VALUE=DATE:20260705',
  ));
  const out = expand(text, '2026-07-01', '2026-07-31');
  assert.equal(out.length, 1);
  assert.deepEqual(shape(out[0]), ['2026-07-04', null, null]);
});

// ---------------------------------------------------------------------------
// expandEvents — multi-day and overnight shapes
// ---------------------------------------------------------------------------

test('expandEvents splits an overnight 23:00-01:00 timed event into two per-day segments', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Night shift',
    'DTSTART;TZID=America/New_York:20260901T230000',
    'DTEND;TZID=America/New_York:20260902T010000',
  ));
  const out = expand(text, '2026-09-01', '2026-09-05');
  assert.deepEqual(out.map(shape), [
    ['2026-09-01', '23:00', '23:59'],
    ['2026-09-02', '00:00', '01:00'],
  ]);
});

test('expandEvents emits only the in-range segment of an overnight event at a range edge', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Night shift',
    'DTSTART;TZID=America/New_York:20260901T230000',
    'DTEND;TZID=America/New_York:20260902T010000',
  ));
  assert.deepEqual(expand(text, '2026-09-02', '2026-09-05').map(shape), [['2026-09-02', '00:00', '01:00']]);
});

test('expandEvents renders a 4-day timed event as four untimed instances', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Conference',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'DTEND;TZID=America/New_York:20260904T170000',
  ));
  assert.deepEqual(expand(text, '2026-08-01', '2026-09-30').map(shape), [
    ['2026-09-01', null, null],
    ['2026-09-02', null, null],
    ['2026-09-03', null, null],
    ['2026-09-04', null, null],
  ]);
});

test('expandEvents renders a 3-day all-day event as three untimed instances (DTEND exclusive)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Trip',
    'DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260904',
  ));
  assert.deepEqual(expand(text, '2026-08-01', '2026-09-30').map(shape), [
    ['2026-09-01', null, null],
    ['2026-09-02', null, null],
    ['2026-09-03', null, null],
  ]);
});

test('expandEvents emits only the in-range days of a multi-day all-day event', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Trip',
    'DTSTART;VALUE=DATE:20260901', 'DTEND;VALUE=DATE:20260904',
  ));
  assert.deepEqual(expand(text, '2026-09-02', '2026-09-02').map(shape), [['2026-09-02', null, null]]);
});

test('expandEvents keeps a timed event ending exactly at midnight on its start day', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Late',
    'DTSTART;TZID=America/New_York:20260901T220000',
    'DTEND;TZID=America/New_York:20260902T000000',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-05').map(shape), [['2026-09-01', '22:00', '23:59']]);
});

// ---------------------------------------------------------------------------
// expandEvents — RRULE matrix
// ---------------------------------------------------------------------------

test('expandEvents expands weekly BYDAY=MO,WE,FR with UNTIL and WKST=SU present (real Google shape)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Statics',
    'DTSTART;TZID=America/New_York:20260105T090000',
    'DTEND;TZID=America/New_York:20260105T095000',
    'RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20260116T235959Z;BYDAY=MO,WE,FR',
  ));
  const out = expand(text, '2026-01-01', '2026-01-31');
  assert.deepEqual(out.map((i) => i.date), [
    '2026-01-05', '2026-01-07', '2026-01-09', '2026-01-12', '2026-01-14', '2026-01-16',
  ]);
  assert.deepEqual(out.map(shape)[0], ['2026-01-05', '09:00', '09:50']);
});

test('expandEvents applies COUNT from DTSTART and then filters to the range', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Weekly five',
    'DTSTART;TZID=America/New_York:20260105T090000',
    'DTEND;TZID=America/New_York:20260105T100000',
    'RRULE:FREQ=WEEKLY;COUNT=5',
  ));
  // Occurrences: Jan 5, 12, 19, 26, Feb 2. Range starts Jan 20 and extends
  // well past the fifth — COUNT must not be re-seeded from the range start.
  assert.deepEqual(expand(text, '2026-01-20', '2026-03-01').map((i) => i.date), ['2026-01-26', '2026-02-02']);
});

test('expandEvents handles weekly INTERVAL=2', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Biweekly',
    'DTSTART;TZID=America/New_York:20260105T090000',
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
  ));
  assert.deepEqual(expand(text, '2026-01-01', '2026-02-28').map((i) => i.date), [
    '2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16',
  ]);
});

test('expandEvents anchors an INTERVAL=3 weekly cycle to DTSTART when the range starts 10 weeks later', () => {
  // DTSTART Mon 2026-01-05. Cycle weeks 0,3,6,9,12,15 -> Jan 5, Jan 26,
  // Feb 16, Mar 9, Mar 30, Apr 20. A range opening at week 10 (Mar 16) must
  // yield weeks 12 (Mar 30) and 15 (Apr 20) — NOT weeks 10 (Mar 16) and 13
  // (Apr 6), which is what a range-seeded phase would produce.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Every three weeks',
    'DTSTART;TZID=America/New_York:20260105T090000',
    'RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=MO',
  ));
  const dates = expand(text, '2026-03-16', '2026-04-26').map((i) => i.date);
  assert.deepEqual(dates, ['2026-03-30', '2026-04-20']);
  assert.ok(!dates.includes('2026-03-16'));
  assert.ok(!dates.includes('2026-04-06'));
});

test('expandEvents handles daily INTERVAL with phase anchored to DTSTART', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Every 3 days',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;INTERVAL=3',
  ));
  // From Sep 1: Sep 1,4,7,10,13,16,19,22,25,28. Range Sep 10-Sep 20 -> 10,13,16,19.
  assert.deepEqual(expand(text, '2026-09-10', '2026-09-20').map((i) => i.date), [
    '2026-09-10', '2026-09-13', '2026-09-16', '2026-09-19',
  ]);
});

test('expandEvents on a monthly rule anchored to the 31st produces no instance in months without a 31st (no clamping)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Month end',
    'DTSTART;TZID=America/New_York:20260131T090000',
    'RRULE:FREQ=MONTHLY',
  ));
  assert.deepEqual(expand(text, '2026-01-01', '2026-07-31').map((i) => i.date), [
    '2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31',
  ]);
});

test('expandEvents handles a single BYMONTHDAY monthly rule', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:15th',
    'DTSTART;TZID=America/New_York:20260115T090000',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=15',
  ));
  assert.deepEqual(expand(text, '2026-01-01', '2026-04-30').map((i) => i.date), [
    '2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15',
  ]);
});

test('expandEvents handles monthly BYDAY=2TU', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Second Tuesday',
    'DTSTART;TZID=America/New_York:20260908T190000',
    'RRULE:FREQ=MONTHLY;BYDAY=2TU',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-12-31').map((i) => i.date), [
    '2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08',
  ]);
});

test('expandEvents handles monthly BYDAY=-1FR', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Last Friday',
    'DTSTART;TZID=America/New_York:20260925T170000',
    'RRULE:FREQ=MONTHLY;BYDAY=-1FR',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-12-31').map((i) => i.date), [
    '2026-09-25', '2026-10-30', '2026-11-27', '2026-12-25',
  ]);
});

test('expandEvents on a "5th Monday" monthly rule skips months without one — no instance, no error', () => {
  // June 2026 and August 2026 have five Mondays; July and September do not.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Fifth Monday',
    'DTSTART;TZID=America/New_York:20260629T090000',
    'RRULE:FREQ=MONTHLY;BYDAY=5MO',
  ));
  const parsed = parseICS(text);
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(expandEvents(parsed, '2026-06-01', '2026-09-30', NY).map((i) => i.date), [
    '2026-06-29', '2026-08-31',
  ]);
});

test('expandEvents handles a yearly rule with COUNT (real iCloud holiday shape)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:New Year’s Day',
    'DTSTART;VALUE=DATE:20250101',
    'RRULE:FREQ=YEARLY;COUNT=5',
  ));
  assert.deepEqual(expand(text, '2025-01-01', '2030-12-31').map((i) => i.date), [
    '2025-01-01', '2026-01-01', '2027-01-01', '2028-01-01', '2029-01-01',
  ]);
  assert.deepEqual(expand(text, '2026-01-01', '2026-12-31').map(shape), [['2026-01-01', null, null]]);
});

test('expandEvents handles yearly ordinal BYDAY with BYMONTH (MLK Day)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Martin Luther King Jr. Day',
    'DTSTART;VALUE=DATE:20250120',
    'RRULE:FREQ=YEARLY;COUNT=5;BYDAY=3MO;BYMONTH=1',
  ));
  assert.deepEqual(expand(text, '2025-01-01', '2029-12-31').map((i) => i.date), [
    '2025-01-20', '2026-01-19', '2027-01-18', '2028-01-17', '2029-01-15',
  ]);
});

test('expandEvents on a yearly Feb 29 rule produces instances only in leap years', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Leap day',
    'DTSTART;VALUE=DATE:20240229',
    'RRULE:FREQ=YEARLY',
  ));
  assert.deepEqual(expand(text, '2024-01-01', '2032-12-31').map((i) => i.date), [
    '2024-02-29', '2028-02-29', '2032-02-29',
  ]);
});

test('expandEvents excludes the boundary instance when a Z-form UNTIL lands mid-local-day', () => {
  // UNTIL 2026-09-03T12:00Z = 08:00 EDT, which is BEFORE the 09:00 EDT
  // occurrence that day: Sep 3 must not be admitted.
  const before = ics(vevent(
    'UID:e', 'SUMMARY:Daily',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;UNTIL=20260903T120000Z',
  ));
  assert.deepEqual(expand(before, '2026-09-01', '2026-09-30').map((i) => i.date), ['2026-09-01', '2026-09-02']);

  // UNTIL 2026-09-03T14:00Z = 10:00 EDT, after the occurrence: Sep 3 is in
  // (UNTIL is inclusive per RFC 5545).
  const after = ics(vevent(
    'UID:e', 'SUMMARY:Daily',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;UNTIL=20260903T140000Z',
  ));
  assert.deepEqual(expand(after, '2026-09-01', '2026-09-30').map((i) => i.date), [
    '2026-09-01', '2026-09-02', '2026-09-03',
  ]);
});

test('expandEvents treats a Z-form UNTIL exactly equal to an occurrence instant as inclusive', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;UNTIL=20260903T130000Z', // 09:00 EDT exactly
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), [
    '2026-09-01', '2026-09-02', '2026-09-03',
  ]);
});

test('expandEvents compares a DATE-form UNTIL against the end of that day in the event zone', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily all-day',
    'DTSTART;VALUE=DATE:20260901',
    'RRULE:FREQ=DAILY;UNTIL=20260903',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), [
    '2026-09-01', '2026-09-02', '2026-09-03',
  ]);
});

test('expandEvents interprets a naive-local UNTIL in the event TZID', () => {
  // UNTIL without Z, read as 08:00 New York on Sep 3 — before the 09:00
  // occurrence, so Sep 3 is excluded.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;UNTIL=20260903T080000',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), ['2026-09-01', '2026-09-02']);
});

test('expandEvents keeps a TZID recurrence at the same wall time across a DST transition', () => {
  // DST ends 2026-11-01 in New York; a TZID-anchored daily rule stays at 09:00.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily local',
    'DTSTART;TZID=America/New_York:20261031T090000',
    'RRULE:FREQ=DAILY;COUNT=3',
  ));
  assert.deepEqual(expand(text, '2026-10-01', '2026-11-30').map(shape), [
    ['2026-10-31', '09:00', null],
    ['2026-11-01', '09:00', null],
    ['2026-11-02', '09:00', null],
  ]);
});

test('expandEvents pins a timed event inside the DST fall-back hour instead of a backwards range', () => {
  // 2026-11-01 01:30 EDT + 30 min = 01:00 EST — the same wall hour repeats, so
  // the local end reads earlier than the local start. A backwards range would
  // give Day view a negative block height and break the endTime > time
  // invariant, so the end is dropped and the instance renders as a pinned chip.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Inside the repeated hour',
    'DTSTART;TZID=America/New_York:20261101T013000',
    'DURATION:PT30M',
  ));
  assert.deepEqual(expand(text, '2026-11-01', '2026-11-01').map(shape), [
    ['2026-11-01', '01:30', null],
  ]);
});

test('expandEvents keeps a normal same-day end time (fall-back guard does not over-reach)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Ordinary',
    'DTSTART;TZID=America/New_York:20261101T013000',
    'DURATION:PT2H',
  ));
  // 01:30 EDT + 2h = 02:30 EST (the fall-back adds an hour of wall-clock slack).
  assert.deepEqual(expand(text, '2026-11-01', '2026-11-01').map(shape), [
    ['2026-11-01', '01:30', '02:30'],
  ]);
});

test('expandEvents lets a UTC recurrence shift wall time across a DST transition (RFC behavior)', () => {
  // A UTC-anchored 06:00Z daily rule is 02:00 EDT before the 2026-11-01
  // fall-back and 01:00 EST after it.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily UTC',
    'DTSTART:20261031T060000Z',
    'RRULE:FREQ=DAILY;COUNT=3',
  ));
  assert.deepEqual(expand(text, '2026-10-01', '2026-11-30').map(shape), [
    ['2026-10-31', '02:00', null],
    ['2026-11-01', '01:00', null],
    ['2026-11-02', '01:00', null],
  ]);
});

test('expandEvents recomputes each recurring instance end from the start (DURATION preserved)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Hour long',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'DURATION:PT1H',
    'RRULE:FREQ=DAILY;COUNT=2',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map(shape), [
    ['2026-09-01', '09:00', '10:00'],
    ['2026-09-02', '09:00', '10:00'],
  ]);
});

test('expandEvents splits every overnight instance of a recurring overnight event', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Night shift',
    'DTSTART;TZID=America/New_York:20260901T230000',
    'DTEND;TZID=America/New_York:20260902T010000',
    'RRULE:FREQ=DAILY;COUNT=2',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-10').map(shape), [
    ['2026-09-01', '23:00', '23:59'],
    ['2026-09-02', '00:00', '01:00'],
    ['2026-09-02', '23:00', '23:59'],
    ['2026-09-03', '00:00', '01:00'],
  ]);
});

// ---------------------------------------------------------------------------
// EXDATE / RECURRENCE-ID
// ---------------------------------------------------------------------------

test('expandEvents removes instances listed in a comma-joined EXDATE', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;COUNT=5',
    'EXDATE;TZID=America/New_York:20260902T090000,20260904T090000',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), [
    '2026-09-01', '2026-09-03', '2026-09-05',
  ]);
});

test('expandEvents removes instances listed in repeated EXDATE lines', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;COUNT=5',
    'EXDATE;TZID=America/New_York:20260902T090000',
    'EXDATE;TZID=America/New_York:20260904T090000',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), [
    '2026-09-01', '2026-09-03', '2026-09-05',
  ]);
});

test('expandEvents removes an all-day instance listed in a VALUE=DATE EXDATE', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily all-day',
    'DTSTART;VALUE=DATE:20260901',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;VALUE=DATE:20260902',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), ['2026-09-01', '2026-09-03']);
});

test('expandEvents does not let EXDATE change how many instances COUNT generates', () => {
  // RFC 5545: COUNT bounds the rule's generated set; EXDATE then removes
  // instances from it — an excluded instance is not backfilled.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;TZID=America/New_York:20260902T090000',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), ['2026-09-01', '2026-09-03']);
});

test('expandEvents replaces a master instance with its RECURRENCE-ID override (same UID)', () => {
  const text = ics(
    vevent(
      'UID:series-1', 'SUMMARY:Standup',
      'DTSTART;TZID=America/New_York:20260901T090000',
      'DTEND;TZID=America/New_York:20260901T100000',
      'RRULE:FREQ=DAILY;COUNT=3',
    ),
    vevent(
      'UID:series-1', 'SUMMARY:Standup (moved)',
      'RECURRENCE-ID;TZID=America/New_York:20260902T090000',
      'DTSTART;TZID=America/New_York:20260902T140000',
      'DTEND;TZID=America/New_York:20260902T150000',
    ),
  );
  const out = expand(text, '2026-09-01', '2026-09-30');
  assert.deepEqual(out.map((i) => [i.date, i.time, i.endTime, i.title]), [
    ['2026-09-01', '09:00', '10:00', 'Standup'],
    ['2026-09-02', '14:00', '15:00', 'Standup (moved)'],
    ['2026-09-03', '09:00', '10:00', 'Standup'],
  ]);
});

test('expandEvents matches a RECURRENCE-ID on the master original instance time, not the override start', () => {
  // The override moves the Sep 2 instance to Sep 5. The Sep 2 slot must be
  // empty and the override must appear once, on Sep 5.
  const text = ics(
    vevent(
      'UID:series-1', 'SUMMARY:Standup',
      'DTSTART;TZID=America/New_York:20260901T090000',
      'RRULE:FREQ=DAILY;COUNT=3',
    ),
    vevent(
      'UID:series-1', 'SUMMARY:Standup (rescheduled)',
      'RECURRENCE-ID;TZID=America/New_York:20260902T090000',
      'DTSTART;TZID=America/New_York:20260905T110000',
    ),
  );
  const out = expand(text, '2026-09-01', '2026-09-30');
  assert.deepEqual(out.map((i) => [i.date, i.time]), [
    ['2026-09-01', '09:00'],
    ['2026-09-03', '09:00'],
    ['2026-09-05', '11:00'],
  ]);
});

test('expandEvents matches an all-day RECURRENCE-ID on the instance date', () => {
  const text = ics(
    vevent(
      'UID:series-1', 'SUMMARY:Holiday',
      'DTSTART;VALUE=DATE:20260901',
      'RRULE:FREQ=DAILY;COUNT=3',
    ),
    vevent(
      'UID:series-1', 'SUMMARY:Holiday (observed)',
      'RECURRENCE-ID;VALUE=DATE:20260902',
      'DTSTART;VALUE=DATE:20260907',
    ),
  );
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => [i.date, i.title]), [
    ['2026-09-01', 'Holiday'],
    ['2026-09-03', 'Holiday'],
    ['2026-09-07', 'Holiday (observed)'],
  ]);
});

test('expandEvents emits an orphan RECURRENCE-ID override as a standalone instance (never silently lost)', () => {
  const text = ics(vevent(
    'UID:orphan-1', 'SUMMARY:Orphan override',
    'RECURRENCE-ID;TZID=America/New_York:20260902T090000',
    'DTSTART;TZID=America/New_York:20260902T140000',
    'DTEND;TZID=America/New_York:20260902T150000',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map(shape), [['2026-09-02', '14:00', '15:00']]);
});

// An override's own DTSTART is authoritative and independent of where the
// master's generation window happens to fall. A reschedule that lands outside
// the window the master would be expanded over must still appear on its new
// date — a Day view of the moved-to date is exactly that case.
const MOVED_PLUS_8 = ics(
  vevent(
    'UID:series-1', 'SUMMARY:Weekly sync',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'DTEND;TZID=America/New_York:20260901T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4',
  ),
  vevent(
    'UID:series-1', 'SUMMARY:Weekly sync (moved)',
    'RECURRENCE-ID;TZID=America/New_York:20260908T090000',
    'DTSTART;TZID=America/New_York:20260916T110000',
    'DTEND;TZID=America/New_York:20260916T120000',
  ),
);

test('expandEvents emits a RECURRENCE-ID override in a range covering only the moved-to day', () => {
  const out = expand(MOVED_PLUS_8, '2026-09-16', '2026-09-16');
  assert.deepEqual(out.map((i) => [i.date, i.time, i.endTime, i.title]), [
    ['2026-09-16', '11:00', '12:00', 'Weekly sync (moved)'],
  ]);
});

test('expandEvents emits nothing on the original slot day of a moved RECURRENCE-ID override', () => {
  assert.deepEqual(expand(MOVED_PLUS_8, '2026-09-08', '2026-09-08'), []);
});

test('expandEvents emits a RECURRENCE-ID override moved into the next month in that month\'s range', () => {
  const text = ics(
    vevent(
      'UID:series-1', 'SUMMARY:Weekly sync',
      'DTSTART;TZID=America/New_York:20260901T090000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4',
    ),
    vevent(
      'UID:series-1', 'SUMMARY:Weekly sync (next month)',
      'RECURRENCE-ID;TZID=America/New_York:20260908T090000',
      'DTSTART;TZID=America/New_York:20261006T110000',
    ),
  );
  assert.deepEqual(expand(text, '2026-10-01', '2026-10-31').map((i) => [i.date, i.time, i.title]), [
    ['2026-10-06', '11:00', 'Weekly sync (next month)'],
  ]);
});

test('expandEvents emits an all-day RECURRENCE-ID override moved beyond the master window', () => {
  const text = ics(
    vevent(
      'UID:series-1', 'SUMMARY:Holiday',
      'DTSTART;VALUE=DATE:20260901',
      'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4',
    ),
    vevent(
      'UID:series-1', 'SUMMARY:Holiday (observed)',
      'RECURRENCE-ID;VALUE=DATE:20260908',
      'DTSTART;VALUE=DATE:20261013',
    ),
  );
  assert.deepEqual(expand(text, '2026-10-13', '2026-10-13').map((i) => [i.date, i.title]), [
    ['2026-10-13', 'Holiday (observed)'],
  ]);
});

test('expandEvents emits a RECURRENCE-ID override exactly once when the master window also covers it', () => {
  // Guards against the override being emitted twice: once directly and once as
  // a side effect of the master's suppressed slot.
  const out = expand(MOVED_PLUS_8, '2026-09-01', '2026-09-30');
  assert.deepEqual(out.map((i) => [i.date, i.time, i.title]), [
    ['2026-09-01', '09:00', 'Weekly sync'],
    ['2026-09-15', '09:00', 'Weekly sync'],
    ['2026-09-16', '11:00', 'Weekly sync (moved)'],
    ['2026-09-22', '09:00', 'Weekly sync'],
  ]);
});

test('parseICS skips a RECURRENCE-ID carrying RANGE=THISANDFUTURE rather than applying it to one instance', () => {
  const text = ics(vevent(
    'UID:series-1', 'SUMMARY:Shifted forever',
    'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20260902T090000',
    'DTSTART;TZID=America/New_York:20260902T140000',
  ));
  assert.deepEqual(parseICS(text).skipped, [
    { uid: 'series-1', summary: 'Shifted forever', reason: 'unsupported_recurrence_id_range' },
  ]);
});

// ---------------------------------------------------------------------------
// expandEvents — contract details
// ---------------------------------------------------------------------------

test('expandEvents accepts either the parseICS result or a bare ParsedEvent array', () => {
  const parsed = parseICS(ics(vevent('UID:e', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20260901')));
  const fromResult = expandEvents(parsed, '2026-09-01', '2026-09-01', NY);
  const fromArray = expandEvents(parsed.events, '2026-09-01', '2026-09-01', NY);
  assert.deepEqual(fromArray, fromResult);
});

test('expandEvents returns instances ordered by date then time, untimed first', () => {
  const text = ics(
    vevent('UID:a', 'SUMMARY:Timed late', 'DTSTART;TZID=America/New_York:20260901T170000'),
    vevent('UID:b', 'SUMMARY:All day', 'DTSTART;VALUE=DATE:20260901'),
    vevent('UID:c', 'SUMMARY:Timed early', 'DTSTART;TZID=America/New_York:20260901T080000'),
  );
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-01').map((i) => i.title), [
    'All day', 'Timed early', 'Timed late',
  ]);
});

test('expandEvents rejects a malformed or inverted range instead of guessing', () => {
  const parsed = parseICS(ics(vevent('UID:e', 'SUMMARY:X', 'DTSTART;VALUE=DATE:20260901')));
  assert.throws(() => expandEvents(parsed, '2026-9-1', '2026-09-30', NY));
  assert.throws(() => expandEvents(parsed, '20260901', '20260930', NY));
  assert.throws(() => expandEvents(parsed, '2026-09-30', '2026-09-01', NY));
  assert.throws(() => expandEvents(parsed, '2026-09-01', '2026-09-30', undefined));
});

test('expandEvents is lazy per range: a decade-long unbounded weekly rule costs only the queried window', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Forever weekly',
    'DTSTART;TZID=America/New_York:20200106T090000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO',
  ));
  const out = expand(text, '2030-01-01', '2030-01-31');
  assert.deepEqual(out.map((i) => i.date), ['2030-01-07', '2030-01-14', '2030-01-21', '2030-01-28']);
});

// ---------------------------------------------------------------------------
// Real fixtures, end to end (Task 0 captures)
// ---------------------------------------------------------------------------

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

test('fixture google-holidays.ics parses with an empty skipped list (317 pre-expanded all-day VEVENTs)', () => {
  const parsed = parseICS(fixture('google-holidays.ics'));
  assert.deepEqual(parsed.skipped, []);
  assert.equal(parsed.events.length, 317);
  // This feed carries no RRULE, no TZID and no VTIMEZONE — every occurrence is
  // pre-materialized as its own VALUE=DATE VEVENT with an exclusive DTEND.
  assert.equal(parsed.events.filter((e) => e.rrule !== null).length, 0);
  assert.ok(parsed.events.every((e) => e.form === 'DATE'));
  assert.ok(parsed.events.every((e) => e.dtend !== null));
});

test('fixture google-holidays.ics expands July 2026 to exactly its two holiday instances', () => {
  const parsed = parseICS(fixture('google-holidays.ics'));
  const out = expandEvents(parsed, '2026-07-01', '2026-07-31', NY);
  assert.deepEqual(out.map((i) => [i.date, i.time, i.endTime, i.title]), [
    ['2026-07-03', null, null, 'Independence Day (substitute)'],
    ['2026-07-04', null, null, 'Independence Day'],
  ]);
});

test('fixture icloud-sample.ics parses with an empty skipped list (120 VEVENTs, 28 yearly RRULEs)', () => {
  const parsed = parseICS(fixture('icloud-sample.ics'));
  assert.deepEqual(parsed.skipped, []);
  assert.equal(parsed.events.length, 120);
  assert.equal(parsed.events.filter((e) => e.rrule !== null).length, 28);
  // All-day, no DTEND at all, no DURATION — Apple's holiday-generator shape.
  assert.ok(parsed.events.every((e) => e.form === 'DATE'));
  assert.ok(parsed.events.every((e) => e.dtend === null && e.duration === null));
});

test('fixture icloud-sample.ics expands July 2026 to exactly two instances, one of them from a YEARLY rule', () => {
  const parsed = parseICS(fixture('icloud-sample.ics'));
  const out = expandEvents(parsed, '2026-07-01', '2026-07-31', NY);
  assert.deepEqual(out.map((i) => [i.date, i.time, i.endTime, i.title]), [
    ['2026-07-03', null, null, 'Independence Day (observed)'],
    ['2026-07-04', null, null, 'Independence Day'], // FREQ=YEARLY;COUNT=5 from 2025-07-04
  ]);
});

test('fixture icloud-sample.ics expands ordinal-BYDAY yearly rules onto the right 2026 dates', () => {
  const parsed = parseICS(fixture('icloud-sample.ics'));
  const jan = expandEvents(parsed, '2026-01-01', '2026-01-31', NY);
  const byTitle = new Map(jan.map((i) => [i.title, i.date]));
  assert.equal(byTitle.get('New Year’s Day'), '2026-01-01');          // FREQ=YEARLY;COUNT=5
  assert.equal(byTitle.get('Martin Luther King Jr. Day'), '2026-01-19'); // BYDAY=3MO;BYMONTH=1
  const may = expandEvents(parsed, '2026-05-01', '2026-05-31', NY);
  const mayByTitle = new Map(may.map((i) => [i.title, i.date]));
  assert.equal(mayByTitle.get('Memorial Day'), '2026-05-25');          // BYDAY=-1MO;BYMONTH=5
  assert.equal(mayByTitle.get('Mother’s Day'), '2026-05-10');          // BYDAY=2SU;BYMONTH=5
});

test('fixtures: every expanded instance carries the EventInstance fields the merge layer needs', () => {
  for (const name of ['google-holidays.ics', 'icloud-sample.ics']) {
    const parsed = parseICS(fixture(name));
    const out = expandEvents(parsed, '2026-01-01', '2026-12-31', NY);
    assert.ok(out.length > 0, `${name} produced no 2026 instances`);
    for (const inst of out) {
      assert.deepEqual(Object.keys(inst).sort(), ['date', 'endTime', 'time', 'title', 'uid']);
      assert.match(inst.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(inst.time, null);
      assert.equal(inst.endTime, null);
      assert.equal(typeof inst.uid, 'string');
      assert.equal(typeof inst.title, 'string');
    }
  }
});

// ---------------------------------------------------------------------------
// Iteration-bound regressions (found in self-review: a fixed cycle cap is
// indistinguishable from silently dropping instances once it is hit).
// ---------------------------------------------------------------------------

test('expandEvents returns every instance of a daily rule over a multi-year window (no silent cycle cap)', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily forever',
    'DTSTART;VALUE=DATE:20200101',
    'RRULE:FREQ=DAILY',
  ));
  const out = expand(text, '2020-01-01', '2029-12-31');
  // 10 calendar years, 1970-epoch day arithmetic: 3653 days (2020, 2024, 2028 leap).
  assert.equal(out.length, 3653);
  assert.equal(out[0].date, '2020-01-01');
  assert.equal(out[out.length - 1].date, '2029-12-31');
});

test('expandEvents terminates on a rule whose date can never exist (February 30) instead of spinning', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Impossible',
    'DTSTART;VALUE=DATE:20260301',
    'RRULE:FREQ=YEARLY;COUNT=5;BYMONTH=2;BYMONTHDAY=30',
  ));
  // DTSTART is the first instance per RFC 5545; the rule itself never fires.
  assert.deepEqual(expand(text, '2026-01-01', '2030-12-31').map((i) => i.date), ['2026-03-01']);
});

test('expandEvents on a huge COUNT stops walking once occurrences pass the window end', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Ten thousand days',
    'DTSTART;VALUE=DATE:20260101',
    'RRULE:FREQ=DAILY;COUNT=10000',
  ));
  const out = expand(text, '2026-01-01', '2026-01-05');
  assert.deepEqual(out.map((i) => i.date), [
    '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05',
  ]);
});

// ---------------------------------------------------------------------------
// Review round 1: three silent-loss / fabrication paths.
// ---------------------------------------------------------------------------

test('parseICS reports an unterminated VEVENT as skipped instead of dropping it', () => {
  // A truncated body (connection cut mid-feed) — no END:VEVENT, no END:VCALENDAR.
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    ...vevent('UID:complete-1', 'SUMMARY:Complete', 'DTSTART;VALUE=DATE:20260901'),
    'BEGIN:VEVENT',
    'UID:truncated-1',
    'SUMMARY:Truncated',
    'DTSTART;VALUE=DATE:20260902',
  ].join('\r\n') + '\r\n';
  const { events, skipped } = parseICS(text);
  assert.deepEqual(events.map((e) => e.uid), ['complete-1']);
  assert.deepEqual(skipped, [
    { uid: 'truncated-1', summary: 'Truncated', reason: 'unterminated_vevent' },
  ]);
});

test('parseICS reports a VEVENT closed only by END:VCALENDAR as skipped', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:unclosed-1',
    'SUMMARY:Missing END:VEVENT',
    'DTSTART;VALUE=DATE:20260901',
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
  const { events, skipped } = parseICS(text);
  assert.deepEqual(events, []);
  assert.deepEqual(skipped, [
    { uid: 'unclosed-1', summary: 'Missing END:VEVENT', reason: 'unterminated_vevent' },
  ]);
});

test('expandEvents removes an all-day instance named by a midnight DATE-TIME EXDATE', () => {
  // Type-mismatched per RFC (EXDATE should be VALUE=DATE for an all-day
  // series) but emitted by real producers. It must not be a silent no-op.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily all-day',
    'DTSTART;VALUE=DATE:20260901',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE:20260902T000000Z',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), ['2026-09-01', '2026-09-03']);
});

test('expandEvents removes an all-day instance named by a TZID DATE-TIME EXDATE', () => {
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily all-day',
    'DTSTART;VALUE=DATE:20260901',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;TZID=America/New_York:20260903T000000',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), ['2026-09-01', '2026-09-02']);
});

test('expandEvents keeps DATE-TIME EXDATE matching exact for a timed series (a wrong time cancels nothing)', () => {
  // The date-part reading is only for all-day series. On a timed series an
  // EXDATE naming a different instant refers to a different instance, so it
  // must not cancel this one.
  const text = ics(vevent(
    'UID:e', 'SUMMARY:Daily timed',
    'DTSTART;TZID=America/New_York:20260901T090000',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;TZID=America/New_York:20260902T113000',
  ));
  assert.deepEqual(expand(text, '2026-09-01', '2026-09-30').map((i) => i.date), [
    '2026-09-01', '2026-09-02', '2026-09-03',
  ]);
});

test('parseICS skips a RECURRENCE-ID event that carries its own RRULE (never fabricates instances)', () => {
  const text = ics(
    vevent(
      'UID:series-1', 'SUMMARY:Standup',
      'DTSTART;TZID=America/New_York:20260901T090000',
      'DTEND;TZID=America/New_York:20260901T100000',
      'RRULE:FREQ=DAILY;COUNT=3',
    ),
    vevent(
      'UID:series-1', 'SUMMARY:Standup (moved, with its own rule)',
      'RECURRENCE-ID;TZID=America/New_York:20260902T090000',
      'DTSTART;TZID=America/New_York:20260902T140000',
      'DTEND;TZID=America/New_York:20260902T150000',
      'RRULE:FREQ=DAILY;COUNT=3',
    ),
  );
  const { events, skipped } = parseICS(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].rrule, 'FREQ=DAILY;COUNT=3');
  assert.deepEqual(skipped, [{
    uid: 'series-1',
    summary: 'Standup (moved, with its own rule)',
    reason: 'unsupported_recurrence_id_rrule',
  }]);
  // The master series expands unchanged — exactly its three instances, and no
  // day that exists in no calendar.
  assert.deepEqual(expandEvents({ events, skipped }, '2026-09-01', '2026-09-30', NY).map(shape), [
    ['2026-09-01', '09:00', '10:00'],
    ['2026-09-02', '09:00', '10:00'],
    ['2026-09-03', '09:00', '10:00'],
  ]);
});
