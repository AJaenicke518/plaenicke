// ics.js — pure RFC 5545 ICS parsing primitives. No DOM.

import { windowsToIana } from './tzmap.js';

// unfoldLines: RFC 5545 §3.1 line unfolding. Content lines are split by CRLF
// (or bare LF); a line that begins with a single space or tab is a
// continuation of the previous line — join it after stripping that one
// leading whitespace char. Trailing blank lines (from a final line ending)
// are dropped.
export function unfoldLines(text) {
  const rawLines = text.split(/\r\n|\r|\n/);
  // A trailing line ending produces one trailing empty string; drop it.
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const lines = [];
  for (const raw of rawLines) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

// parseProperty: parse a single unfolded content line of the form
//   NAME;PARAM=VALUE;PARAM2="quoted,value":value
// into { name, params: { PARAM: value, ... }, value }.
// Params precede the first unquoted `:`. A param value may be double-quoted,
// in which case it can contain `:`, `;`, `,` literally. Multi-value params
// (comma-separated) are returned as a single string; later tasks split them.
export function parseProperty(line) {
  let i = 0;
  const len = line.length;

  // NAME: up to the first ';' or ':'.
  let nameEnd = i;
  while (nameEnd < len && line[nameEnd] !== ';' && line[nameEnd] !== ':') nameEnd++;
  const name = line.slice(0, nameEnd);
  i = nameEnd;

  const params = {};
  while (i < len && line[i] === ';') {
    i++; // skip ';'
    let keyEnd = i;
    while (keyEnd < len && line[keyEnd] !== '=') keyEnd++;
    // Param names are case-insensitive per RFC 5545 §3.2 — upper-case the key
    // so every consumer can match against a canonical form (e.g. "tzid=" and
    // "TZID=" both land in params.TZID). Param *values* are left untouched.
    const key = line.slice(i, keyEnd).toUpperCase();
    i = keyEnd + 1; // skip '='

    let value;
    if (line[i] === '"') {
      i++; // skip opening quote
      let valEnd = i;
      while (valEnd < len && line[valEnd] !== '"') valEnd++;
      value = line.slice(i, valEnd);
      i = valEnd + 1; // skip closing quote
    } else {
      let valEnd = i;
      while (valEnd < len && line[valEnd] !== ';' && line[valEnd] !== ':') valEnd++;
      value = line.slice(i, valEnd);
      i = valEnd;
    }
    params[key] = value;
  }

  // i now points at the unquoted ':' separating params from value (or at end).
  const value = i < len && line[i] === ':' ? line.slice(i + 1) : '';

  return { name, params, value };
}

// unescapeText: reverse RFC 5545 §3.3.11 TEXT escaping.
//   \\  -> \
//   \;  -> ;
//   \,  -> ,
//   \n / \N -> newline
export function unescapeText(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) {
      const next = v[i + 1];
      if (next === '\\') { out += '\\'; i++; continue; }
      if (next === ';') { out += ';'; i++; continue; }
      if (next === ',') { out += ','; i++; continue; }
      if (next === 'n' || next === 'N') { out += '\n'; i++; continue; }
    }
    out += v[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timezone conversion.
//
// Intl.DateTimeFormat only gives us one direction: instant -> wall clock in a
// zone. zonedWallClockToInstant needs the inverse (wall clock in a zone ->
// instant), which Intl does not provide. The naive approach — Date.UTC(the
// wall-clock fields) formatted straight back into the zone — is not an
// inverse at all; it just re-lands you on a *different* wall clock unless the
// zone happens to be UTC. The correct technique is offset probing: treat the
// wall-clock fields as a *candidate* instant, measure what offset the zone
// has there, subtract that offset to get a corrected candidate instant, and
// verify by formatting the corrected candidate back into the zone.
//
// That single-seed convergence is enough for ordinary wall times, but it is
// NOT enough to reliably detect the two DST edge cases (a wall time that
// occurs twice at a fall-back, or a wall time that never occurs at all in a
// spring-forward gap) — depending on which side of the transition the first
// seed happens to land, single-seed convergence can silently settle on one
// self-consistent answer for an ambiguous wall clock without ever probing
// the other one. So instead we always explicitly sample the offset a safe
// distance (2 days — far larger than any real UTC offset magnitude, far
// smaller than the multi-month gap between DST transitions) before and after
// the candidate, collect the distinct offsets that could plausibly apply,
// and test each one for self-consistency. That yields 0, 1, or 2 passing
// candidates, which is exactly the gap / normal / ambiguous split.
// ---------------------------------------------------------------------------

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

// UnknownTz: thrown by resolveTzid when a TZID cannot be resolved to a valid
// IANA zone (neither Intl nor the CLDR Windows-zone map recognize it). Zero
// fallback: callers must catch this and skip the event with reason
// 'unknown_tz' rather than guessing a zone.
export class UnknownTz extends Error {
  constructor(raw) {
    super(`Unknown timezone identifier: ${raw}`);
    this.name = 'UnknownTz';
    this.raw = raw;
  }
}

// Zone-name validity is checked once per distinct name: Intl.DateTimeFormat
// construction is the expensive part (see the formatter cache below) and Task
// 4's parse layer calls resolveTzid once per VEVENT — a several-hundred-event
// feed would otherwise pay hundreds of constructions per parse. A zone name's
// validity cannot change at runtime, so memoizing it is sound.
const tzValidityCache = new Map();
function isValidIanaTz(name) {
  if (!name) return false;
  const cached = tzValidityCache.get(name);
  if (cached !== undefined) return cached;
  let valid;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    valid = true;
  } catch {
    valid = false;
  }
  tzValidityCache.set(name, valid);
  return valid;
}

// resolveTzid: resolve a raw ICS TZID string to a valid IANA zone name.
// 1. Passthrough if Intl already accepts it (covers the common case: ICS
//    producers that write IANA names directly, e.g. "America/New_York").
// 2. Else look it up in the CLDR Windows-zone map (js/tzmap.js), covering
//    Outlook/Exchange-style TZIDs, e.g. "W. Europe Standard Time".
// 3. Else throw UnknownTz — no guessing, no default zone.
export function resolveTzid(raw) {
  if (isValidIanaTz(raw)) return raw;
  const mapped = windowsToIana[raw];
  if (mapped && isValidIanaTz(mapped)) return mapped;
  throw new UnknownTz(raw);
}

// Intl.DateTimeFormat construction is expensive (~11x the cost of reusing an
// instance, measured) and zonedWallClockToInstant's offset probing calls
// formatZonedParts several times per lookup — multiplied per RRULE
// occurrence in Task 4, this shows up on mobile Safari. Cache one formatter
// per tzid; formatToParts is pure given an instant, so reuse across
// different instants is safe.
const zonedFormatterCache = new Map();
function getZonedFormatter(tzid) {
  let dtf = zonedFormatterCache.get(tzid);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zonedFormatterCache.set(tzid, dtf);
  }
  return dtf;
}

// formatZonedParts: instant (epoch ms) -> wall-clock fields in tzid. This is
// the *easy* direction (the one Intl.DateTimeFormat gives directly).
function formatZonedParts(instantMs, tzid) {
  const dtf = getZonedFormatter(tzid);
  const map = {};
  for (const p of dtf.formatToParts(instantMs)) map[p.type] = p.value;
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // defensive: some engines report midnight as '24' even with hourCycle h23.
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour,
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
  };
}

// wallClockAsUTCms: treat wall-clock fields as if they were UTC — a pure
// arithmetic device used only to measure offsets and residuals, never
// returned as a real instant on its own.
function wallClockAsUTCms(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
}

// zoneOffsetMsAt: the zone's UTC offset (in ms, local-minus-UTC) at the given
// real instant. Positive east of UTC (e.g. Australia/Sydney in summer is
// +11h -> 39600000).
function zoneOffsetMsAt(instantMs, tzid) {
  return wallClockAsUTCms(formatZonedParts(instantMs, tzid)) - instantMs;
}

// zonedWallClockToInstant: the inverse of Intl.DateTimeFormat. Given wall-
// clock fields { year, month (1-12), day, hour, minute, second } meant as a
// local time in tzid, return the epoch ms instant that produces exactly that
// wall clock when formatted back into tzid.
//
// DST edge policies (both required, both tested):
//   - Ambiguous wall time (fall-back hour, occurs twice): resolve to the
//     FIRST occurrence — i.e. the earlier real instant, which is always the
//     one under the larger (DST) offset, since a fall-back is by definition
//     a decrease in offset over time.
//   - Nonexistent wall time (spring-forward gap, never occurs): shift the
//     wall clock forward by the width of the gap and resolve that (into the
//     post-gap, larger-offset regime). The gap width is measured from the
//     zone's actual offsets, not assumed to be a fixed 1 hour, so it holds
//     for zones with non-hour DST shifts too (e.g. Lord Howe Island's 30
//     minutes).
export function zonedWallClockToInstant(parts, tzid) {
  const year = parts.year, month = parts.month, day = parts.day;
  const hour = parts.hour || 0, minute = parts.minute || 0, second = parts.second || 0;
  const wantedUTCms = Date.UTC(year, month - 1, day, hour, minute, second);

  const offsetHere = zoneOffsetMsAt(wantedUTCms, tzid);
  const offsetBefore = zoneOffsetMsAt(wantedUTCms - TWO_DAYS_MS, tzid);
  const offsetAfter = zoneOffsetMsAt(wantedUTCms + TWO_DAYS_MS, tzid);
  const candidateOffsets = Array.from(new Set([offsetHere, offsetBefore, offsetAfter]));

  const passing = [];
  for (const off of candidateOffsets) {
    const instant = wantedUTCms - off;
    if (zoneOffsetMsAt(instant, tzid) === off) {
      passing.push({ instant, offset: off });
    }
  }

  if (passing.length === 1) {
    return passing[0].instant;
  }

  if (passing.length >= 2) {
    // Ambiguous: two distinct real instants both format back to the wanted
    // wall clock. First occurrence = larger (DST) offset = earlier instant.
    passing.sort((a, b) => b.offset - a.offset);
    return passing[0].instant;
  }

  // Nonexistent: no candidate offset reproduces the wanted wall clock.
  // Shift forward by the measured gap width and resolve into the
  // post-transition (larger-offset) regime.
  const maxOffset = Math.max(...candidateOffsets);
  const minOffset = Math.min(...candidateOffsets);
  const gapWidthMs = maxOffset - minOffset;
  const shiftedUTCms = wantedUTCms + gapWidthMs;
  return shiftedUTCms - maxOffset;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function pad4(n) { return String(n).padStart(4, '0'); }

// assertInRange: reject an out-of-range date/time component instead of
// letting it silently roll over (Date.UTC(2026, 12, 1) doesn't throw for
// month 13 — it normalizes to 2027-01-01). A malformed ICS value must fail
// loudly, not enter the data model as a different, wrong-but-valid date.
function assertInRange(n, min, max, label, raw) {
  if (n < min || n > max) {
    throw new Error(`Invalid ${label} in ICS date value "${raw}": ${n} (expected ${min}-${max})`);
  }
}

// parseIcsDateValue: the single validating reader of a raw DTSTART/DTEND/
// EXDATE/RECURRENCE-ID/UNTIL value (already split into value + params by
// parseProperty). Returns the wall-clock fields as written plus which of the
// four RFC 5545 forms they are in, and — for the TZID form — the *resolved*
// IANA zone:
//   - 'DATE'     VALUE=DATE (all-day):      '20250101'
//   - 'UTC'      'Z' suffix:                '20260901T090000Z'
//   - 'TZID'     TZID param:                '20260901T090000' + TZID
//   - 'FLOATING' no Z, no TZID:             '20260901T090000'
//
// Throws on a malformed or out-of-range value, and UnknownTz on an
// unresolvable TZID. Both parseICS (which turns the throw into a `skipped`
// entry) and icsDateToLocal are built on this — the validating regexes live
// here once.
export function parseIcsDateValue(value, params) {
  const isDateOnly = (params && params.VALUE === 'DATE') || !value.includes('T');
  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) throw new Error(`Invalid DATE value: ${value}`);
    const [, y, mo, d] = m;
    assertInRange(Number(mo), 1, 12, 'month', value);
    assertInRange(Number(d), 1, 31, 'day', value);
    return {
      form: 'DATE', tzid: null,
      year: Number(y), month: Number(mo), day: Number(d),
      hour: 0, minute: 0, second: 0,
    };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) throw new Error(`Invalid DATE-TIME value: ${value}`);
  const [, y, mo, d, h, mi, s, zFlag] = m;
  assertInRange(Number(mo), 1, 12, 'month', value);
  assertInRange(Number(d), 1, 31, 'day', value);
  assertInRange(Number(h), 0, 23, 'hour', value);
  assertInRange(Number(mi), 0, 59, 'minute', value);
  assertInRange(Number(s), 0, 59, 'second', value);

  const fields = {
    year: Number(y), month: Number(mo), day: Number(d),
    hour: Number(h), minute: Number(mi), second: Number(s),
  };
  if (zFlag === 'Z') return { form: 'UTC', tzid: null, ...fields };
  if (params && params.TZID) return { form: 'TZID', tzid: resolveTzid(params.TZID), ...fields };
  return { form: 'FLOATING', tzid: null, ...fields };
}

// wallToDateTime: zone wall-clock parts -> the { date, time } shape
// js/items.js uses.
function wallToDateTime(wall) {
  return {
    date: `${pad4(wall.year)}-${pad2(wall.month)}-${pad2(wall.day)}`,
    time: `${pad2(wall.hour)}:${pad2(wall.minute)}`,
  };
}

// icsDateToLocal: parse a raw DTSTART/DTEND value into
// { date: 'YYYY-MM-DD', time: 'HH:MM' | null } wall-clock fields in targetTz.
// All four forms (see parseIcsDateValue); DATE is untimed, FLOATING is already
// targetTz wall time so it is not converted.
export function icsDateToLocal(value, params, targetTz) {
  const parsed = parseIcsDateValue(value, params);
  if (parsed.form === 'DATE') {
    return {
      date: `${pad4(parsed.year)}-${pad2(parsed.month)}-${pad2(parsed.day)}`,
      time: null,
    };
  }
  if (parsed.form === 'FLOATING') {
    // Floating time: the wall-clock fields ARE the local time already.
    return wallToDateTime(parsed);
  }
  return wallToDateTime(formatZonedParts(instantOfWallClock(parsed, zoneOfForm(parsed, targetTz)), targetTz));
}

// ---------------------------------------------------------------------------
// Instant / civil-date arithmetic shared by parsing and expansion.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// utcMs: Date.UTC with the two-digit-year trap closed. Date.UTC(76, …) means
// 1976, but an ICS value of '00760401' means year 76 — setUTCFullYear is the
// only way to say what we mean.
function utcMs(year, month, day, hour = 0, minute = 0, second = 0) {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (year >= 0 && year < 100) {
    const dt = new Date(ms);
    dt.setUTCFullYear(year);
    return dt.getTime();
  }
  return ms;
}

// Civil dates are handled as *day numbers* — whole days since 1970-01-01 —
// which makes "add 21 days", "which weekday is this" and "is this within the
// window" plain integer arithmetic, with no timezone anywhere near it.
function dayNumOf(year, month, day) { return Math.floor(utcMs(year, month, day) / MS_PER_DAY); }
function civilOfDayNum(n) {
  const dt = new Date(n * MS_PER_DAY);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}
function isoOfDayNum(n) {
  const c = civilOfDayNum(n);
  return `${pad4(c.year)}-${pad2(c.month)}-${pad2(c.day)}`;
}
function dayNumOfISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${iso}`);
  const [, y, mo, d] = m;
  assertInRange(Number(mo), 1, 12, 'month', iso);
  assertInRange(Number(d), 1, 31, 'day', iso);
  return dayNumOf(Number(y), Number(mo), Number(d));
}
// dowOfDayNum: 0 = Sunday … 6 = Saturday (day 0, 1970-01-01, was a Thursday).
function dowOfDayNum(n) { return ((n % 7) + 11) % 7; }
function daysInMonth(year, month) {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return dayNumOf(nextYear, nextMonth, 1) - dayNumOf(year, month, 1);
}
// Weeks start Monday (RFC 5545's default WKST); see parseRRule for why a
// non-MO WKST is either irrelevant or a skip.
function weekStartOfDayNum(n) { return n - ((dowOfDayNum(n) + 6) % 7); }

const DOW_TOKENS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// zoneOfForm: which zone a value's wall clock is expressed in. UTC form is
// UTC; TZID form is its resolved zone; a FLOATING value means "device local",
// which at expansion time is targetTz. DATE values have no zone at all — they
// are pure civil dates and never reach this function.
function zoneOfForm(parsed, targetTz) {
  if (parsed.form === 'UTC') return 'UTC';
  if (parsed.form === 'TZID') return parsed.tzid;
  return targetTz;
}

// instantOfWallClock: wall-clock fields in a zone -> epoch ms. UTC skips the
// offset probing entirely (it is its own inverse).
function instantOfWallClock(fields, zone) {
  if (zone === 'UTC') {
    return utcMs(fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second || 0);
  }
  return zonedWallClockToInstant(fields, zone);
}

// ---------------------------------------------------------------------------
// DURATION
// ---------------------------------------------------------------------------

// parseDuration: RFC 5545 §3.3.6 dur-value -> milliseconds.
//   PT1H  PT30M  PT1H30M  P1D  P1DT2H30M  PT45S  P1W
// Negative durations are rejected: a negative DTSTART-relative duration is
// only meaningful on a VALARM TRIGGER, never as a VEVENT length, and silently
// treating one as positive would invent an event shape.
export function parseDuration(text) {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text || '');
  if (!m) throw new Error(`Invalid DURATION value: ${text}`);
  const [, w, d, h, mi, s] = m;
  if (w === undefined && d === undefined && h === undefined && mi === undefined && s === undefined) {
    throw new Error(`Invalid DURATION value (no components): ${text}`);
  }
  return (
    Number(w || 0) * 7 * MS_PER_DAY
    + Number(d || 0) * MS_PER_DAY
    + Number(h || 0) * 3600000
    + Number(mi || 0) * 60000
    + Number(s || 0) * 1000
  );
}

// ---------------------------------------------------------------------------
// RRULE — the three-list policy (spec: supported / ignorable / skip-triggering)
// ---------------------------------------------------------------------------

// UnsupportedRRule: thrown by parseRRule for any rule this app does not
// expand exactly. `.reason` is the token that lands in the feed's
// `skipped: [{uid, summary, reason}]` list, so every skip says *why* — there
// is no permissive catch-all that quietly expands a rule wrongly.
export class UnsupportedRRule extends Error {
  constructor(reason, detail) {
    super(`Unsupported RRULE (${reason})${detail ? `: ${detail}` : ''}`);
    this.name = 'UnsupportedRRule';
    this.reason = reason;
  }
}

const SUPPORTED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const SUBDAILY_FREQ = new Set(['SECONDLY', 'MINUTELY', 'HOURLY']);
// Parts this app reads. Anything else is either explicitly ignorable (WKST
// when harmless, X-*) or a skip — see below.
const SUPPORTED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH']);
const NAMED_SKIP_PARTS = {
  BYSETPOS: 'unsupported_bysetpos',
  BYWEEKNO: 'unsupported_byweekno',
  BYYEARDAY: 'unsupported_byyearday',
  BYHOUR: 'unsupported_byhour',
  BYMINUTE: 'unsupported_byminute',
  BYSECOND: 'unsupported_bysecond',
};

function positiveInt(raw, label) {
  if (!/^\d+$/.test(raw)) throw new UnsupportedRRule('bad_rrule', `${label}=${raw}`);
  const n = Number(raw);
  if (n < 1) throw new UnsupportedRRule('bad_rrule', `${label}=${raw}`);
  return n;
}

// parseRRule: raw RRULE value -> a normalized rule object, or throw
// UnsupportedRRule. Total by construction: every part is matched against the
// supported list, the ignorable list, or a skip reason.
export function parseRRule(text) {
  const parts = {};
  for (const segment of String(text).split(';')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    if (eq <= 0) throw new UnsupportedRRule('bad_rrule', segment);
    const key = segment.slice(0, eq).toUpperCase();
    if (key in parts) throw new UnsupportedRRule('bad_rrule', `duplicate ${key}`);
    parts[key] = segment.slice(eq + 1);
  }

  const freq = (parts.FREQ || '').toUpperCase();
  if (!freq) throw new UnsupportedRRule('bad_rrule', 'missing FREQ');
  if (SUBDAILY_FREQ.has(freq)) throw new UnsupportedRRule('unsupported_freq_subdaily', freq);
  if (!SUPPORTED_FREQ.has(freq)) throw new UnsupportedRRule('unsupported_freq', freq);

  for (const key of Object.keys(parts)) {
    if (SUPPORTED_PARTS.has(key)) continue;
    if (key === 'WKST') continue;      // ignorable-when-harmless; checked below
    if (key.startsWith('X-')) continue; // ignorable
    if (NAMED_SKIP_PARTS[key]) throw new UnsupportedRRule(NAMED_SKIP_PARTS[key], key);
    throw new UnsupportedRRule(`unsupported_rrule_part_${key.toLowerCase()}`, key);
  }

  const interval = parts.INTERVAL === undefined ? 1 : positiveInt(parts.INTERVAL, 'INTERVAL');
  const count = parts.COUNT === undefined ? null : positiveInt(parts.COUNT, 'COUNT');

  let until = null;
  if (parts.UNTIL !== undefined) {
    let fields;
    try {
      fields = parseIcsDateValue(parts.UNTIL, {});
    } catch {
      throw new UnsupportedRRule('bad_date', `UNTIL=${parts.UNTIL}`);
    }
    until = { value: parts.UNTIL, ...fields };
  }

  let bymonth = null;
  if (parts.BYMONTH !== undefined) {
    bymonth = parts.BYMONTH.split(',').map((v) => {
      const n = positiveInt(v, 'BYMONTH');
      if (n > 12) throw new UnsupportedRRule('bad_rrule', `BYMONTH=${v}`);
      return n;
    });
  }

  let bymonthday = null;
  if (parts.BYMONTHDAY !== undefined) {
    if (parts.BYMONTHDAY.includes(',')) {
      throw new UnsupportedRRule('unsupported_bymonthday_multi', parts.BYMONTHDAY);
    }
    if (parts.BYMONTHDAY.startsWith('-')) {
      throw new UnsupportedRRule('unsupported_bymonthday_negative', parts.BYMONTHDAY);
    }
    bymonthday = positiveInt(parts.BYMONTHDAY, 'BYMONTHDAY');
    if (bymonthday > 31) throw new UnsupportedRRule('bad_rrule', `BYMONTHDAY=${parts.BYMONTHDAY}`);
  }

  let byday = null;
  if (parts.BYDAY !== undefined) {
    byday = parts.BYDAY.split(',').map((token) => {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token.toUpperCase());
      if (!m) throw new UnsupportedRRule('bad_rrule', `BYDAY=${token}`);
      const ordinal = m[1] === undefined ? null : Number(m[1]);
      if (ordinal === 0) throw new UnsupportedRRule('bad_rrule', `BYDAY=${token}`);
      return { ordinal, dow: m[2] };
    });
    if (byday.length === 0) throw new UnsupportedRRule('bad_rrule', 'empty BYDAY');
  }

  // WKST is ignorable *except* in the one combination where the week-start
  // choice actually moves instances: a WEEKLY rule with INTERVAL>1 (so week
  // boundaries decide which weeks are on-cycle) whose BYDAY list spans more
  // than one day (so the list can straddle the boundary). MO is the RFC
  // default and always ignorable.
  let wkst = null;
  if (parts.WKST !== undefined) {
    wkst = parts.WKST.toUpperCase();
    if (!(wkst in DOW_TOKENS)) throw new UnsupportedRRule('bad_rrule', `WKST=${parts.WKST}`);
    if (wkst !== 'MO' && freq === 'WEEKLY' && interval > 1 && byday && byday.length > 1) {
      throw new UnsupportedRRule('unsupported_wkst', `WKST=${wkst}`);
    }
  }

  if (byday) {
    if (freq === 'DAILY') throw new UnsupportedRRule('unsupported_byday_daily', parts.BYDAY);
    if (freq === 'WEEKLY' && byday.some((t) => t.ordinal !== null)) {
      throw new UnsupportedRRule('unsupported_byday_ordinal_weekly', parts.BYDAY);
    }
    if ((freq === 'MONTHLY' || freq === 'YEARLY') && byday.some((t) => t.ordinal === null)) {
      throw new UnsupportedRRule('unsupported_byday_nonordinal', parts.BYDAY);
    }
    if (bymonthday !== null) {
      throw new UnsupportedRRule('unsupported_byday_with_bymonthday', `${parts.BYDAY}+${parts.BYMONTHDAY}`);
    }
  }

  return { freq, interval, count, until, bymonth, bymonthday, byday, wkst };
}

// ---------------------------------------------------------------------------
// Occurrence generation
// ---------------------------------------------------------------------------

// nthWeekdayOfMonth: day-of-month of the ordinal-th `dow` in the month, or
// null when that ordinal does not exist there (the "5th Monday" case — no
// instance, and explicitly not an error). Negative ordinals count back from
// the end (-1 = last).
export function nthWeekdayOfMonth(year, month, ordinal, dow) {
  const target = DOW_TOKENS[dow];
  if (target === undefined) throw new Error(`Invalid weekday token: ${dow}`);
  if (!Number.isInteger(ordinal) || ordinal === 0) throw new Error(`Invalid ordinal: ${ordinal}`);
  const first = dayNumOf(year, month, 1);
  const length = daysInMonth(year, month);
  if (ordinal > 0) {
    const offset = (target - dowOfDayNum(first) + 7) % 7;
    const day = 1 + offset + (ordinal - 1) * 7;
    return day <= length ? day : null;
  }
  const last = first + length - 1;
  const offset = (dowOfDayNum(last) - target + 7) % 7;
  const day = length - offset + (ordinal + 1) * 7;
  return day >= 1 ? day : null;
}

// Deliberately NOT a fixed iteration cap: a cap large enough to be safe for a
// daily rule over a multi-year range is indistinguishable from silently
// dropping instances when it is hit. The windowed path instead terminates on
// its own (cycle start days strictly increase, so they eventually pass the
// window end), and the COUNT path terminates when COUNT is reached, when UNTIL
// is passed, when the window is passed, or — this constant — when a rule has
// gone this many consecutive cycles without producing any date at all. That
// last case only happens for a rule whose date cannot exist
// (FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30 — there is no February 30), which would
// otherwise spin forever. 400 empty cycles is far beyond any real gap: a
// Feb-29 yearly rule produces one every 4, a 31st-of-the-month rule at least
// one every 2.
const MAX_EMPTY_CYCLES = 400;

// Day selection inside one month, shared by MONTHLY and YEARLY: ordinal BYDAY,
// else a single BYMONTHDAY, else DTSTART's own day-of-month. A day that does
// not exist that month (the 31st of April, Feb 29 in a common year) yields
// nothing — never a clamped substitute date.
function monthDays(year, month, rule, baseDay) {
  const days = [];
  if (rule.byday) {
    for (const token of rule.byday) {
      const day = nthWeekdayOfMonth(year, month, token.ordinal, token.dow);
      if (day !== null) days.push(dayNumOf(year, month, day));
    }
  } else {
    const wanted = rule.bymonthday !== null ? rule.bymonthday : baseDay;
    if (wanted <= daysInMonth(year, month)) days.push(dayNumOf(year, month, wanted));
  }
  return days;
}

// cycleFunctionsFor: per-FREQ view of the rule as a sequence of *cycles*
// numbered from DTSTART's own cycle (k=0). This is where INTERVAL's phase
// comes from: cycle k is always counted off DTSTART, never off the requested
// range, so a biweekly rule viewed months later still lands on the
// DTSTART-aligned weeks.
function cycleFunctionsFor(rule, startDay, startCivil) {
  const monthOk = (month) => rule.bymonth === null || rule.bymonth.includes(month);

  if (rule.freq === 'DAILY') {
    return {
      cycleStartDay: (k) => startDay + k * rule.interval,
      cycleDates: (k) => {
        const day = startDay + k * rule.interval;
        const civil = civilOfDayNum(day);
        if (!monthOk(civil.month)) return [];
        if (rule.bymonthday !== null && civil.day !== rule.bymonthday) return [];
        return [day];
      },
      phaseIndexFor: (day) => Math.floor((day - startDay) / rule.interval),
    };
  }

  if (rule.freq === 'WEEKLY') {
    const weekStart0 = weekStartOfDayNum(startDay);
    const dows = rule.byday
      ? rule.byday.map((t) => DOW_TOKENS[t.dow])
      : [dowOfDayNum(startDay)];
    const step = rule.interval * 7;
    return {
      cycleStartDay: (k) => weekStart0 + k * step,
      cycleDates: (k) => {
        const weekStart = weekStart0 + k * step;
        const days = [];
        for (const dow of dows) {
          const day = weekStart + ((dow + 6) % 7); // Monday-based offset
          const civil = civilOfDayNum(day);
          if (!monthOk(civil.month)) continue;
          if (rule.bymonthday !== null && civil.day !== rule.bymonthday) continue;
          days.push(day);
        }
        return days.sort((a, b) => a - b);
      },
      phaseIndexFor: (day) => Math.floor((weekStartOfDayNum(day) - weekStart0) / step),
    };
  }

  if (rule.freq === 'MONTHLY') {
    const baseIndex = startCivil.year * 12 + (startCivil.month - 1);
    const monthOfCycle = (k) => {
      const index = baseIndex + k * rule.interval;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    };
    return {
      cycleStartDay: (k) => {
        const { year, month } = monthOfCycle(k);
        return dayNumOf(year, month, 1);
      },
      cycleDates: (k) => {
        const { year, month } = monthOfCycle(k);
        if (!monthOk(month)) return [];
        return monthDays(year, month, rule, startCivil.day).sort((a, b) => a - b);
      },
      phaseIndexFor: (day) => {
        const civil = civilOfDayNum(day);
        return Math.floor((civil.year * 12 + (civil.month - 1) - baseIndex) / rule.interval);
      },
    };
  }

  // YEARLY
  const months = rule.bymonth === null ? [startCivil.month] : [...rule.bymonth].sort((a, b) => a - b);
  return {
    cycleStartDay: (k) => dayNumOf(startCivil.year + k * rule.interval, 1, 1),
    cycleDates: (k) => {
      const year = startCivil.year + k * rule.interval;
      const days = [];
      for (const month of months) days.push(...monthDays(year, month, rule, startCivil.day));
      return days.sort((a, b) => a - b);
    },
    phaseIndexFor: (day) => Math.floor((civilOfDayNum(day).year - startCivil.year) / rule.interval),
  };
}

// generateOccurrenceDays: the day numbers (civil days in the event's own zone)
// on which the rule fires, ascending.
//
// Two iteration strategies, per spec:
//   - COUNT rules iterate from DTSTART bounded by COUNT, then filter to the
//     window — COUNT is a property of the rule, not of the view.
//   - UNTIL / unbounded rules jump straight to the cycle containing the
//     window start (phase-aligned to DTSTART) and stop at the window end, so
//     expansion cost is the size of the requested range, not the age of the
//     rule.
// DTSTART itself is always the first instance (RFC 5545 §3.8.5.3), so it is
// added to cycle 0 even if an unsynchronized rule would not generate it.
function generateOccurrenceDays(startDay, startCivil, rule, genStartDay, genEndDay, untilOk) {
  const fns = cycleFunctionsFor(rule, startDay, startCivil);
  const datesOfCycle = (k) => {
    const days = fns.cycleDates(k);
    if (k === 0 && !days.includes(startDay)) return [startDay, ...days].sort((a, b) => a - b);
    return days;
  };
  const out = [];

  if (rule.count !== null) {
    let collected = 0;
    let emptyCycles = 0;
    let done = false;
    for (let k = 0; !done && collected < rule.count && emptyCycles < MAX_EMPTY_CYCLES; k++) {
      let produced = 0;
      for (const day of datesOfCycle(k)) {
        if (day < startDay) continue;
        if (collected >= rule.count) break;
        if (!untilOk(day)) { done = true; break; }
        produced++;
        collected++;
        // Occurrences ascend, so once one passes the window end no later one
        // can be inside it — COUNT is already accounted for by the ones we
        // walked past.
        if (day > genEndDay) { done = true; break; }
        if (day >= genStartDay) out.push(day);
      }
      emptyCycles = produced === 0 ? emptyCycles + 1 : 0;
    }
    return out;
  }

  // Cycle start days strictly increase (INTERVAL >= 1), so this terminates at
  // the window end without needing an iteration cap.
  const firstCycle = Math.max(0, fns.phaseIndexFor(genStartDay));
  for (let k = firstCycle; fns.cycleStartDay(k) <= genEndDay; k++) {
    for (const day of datesOfCycle(k)) {
      if (day < startDay || day < genStartDay || day > genEndDay) continue;
      if (!untilOk(day)) continue;
      out.push(day);
    }
  }
  return out;
}

// nextWeeklyInstances: the WEEKLY generator on its own, in ISO dates — the
// smallest unit that shows INTERVAL's DTSTART-anchored phase.
//   nextWeeklyInstances('2026-01-05', ['MO'], 3, '2026-03-16', '2026-04-26')
//     -> ['2026-03-30', '2026-04-20']   (cycle weeks 12 and 15, not 10 and 13)
// An empty `bydays` means "the start date's own weekday". Window bounds are
// inclusive; no instance before startISO is ever returned.
export function nextWeeklyInstances(startISO, bydays, interval, fromISO, toISO) {
  if (!Number.isInteger(interval) || interval < 1) throw new Error(`Invalid interval: ${interval}`);
  const startDay = dayNumOfISO(startISO);
  const rule = {
    freq: 'WEEKLY',
    interval,
    count: null,
    until: null,
    bymonth: null,
    bymonthday: null,
    byday: bydays && bydays.length ? bydays.map((dow) => {
      if (!(dow in DOW_TOKENS)) throw new Error(`Invalid weekday token: ${dow}`);
      return { ordinal: null, dow };
    }) : null,
    wkst: null,
  };
  const days = generateOccurrenceDays(
    startDay, civilOfDayNum(startDay), rule,
    dayNumOfISO(fromISO), dayNumOfISO(toISO), () => true,
  );
  return days.map(isoOfDayNum);
}

// applyExdates: remove excluded instances from an occurrence list.
// Occurrences are `{ dateStr, instantMs }` (instantMs null for all-day). A
// DATE-form EXDATE matches on the event-zone date; a DATE-TIME EXDATE matches
// on the absolute instant, so an EXDATE written in a different zone than
// DTSTART still cancels the right instance. `zone` is the event's zone, used
// only to resolve floating EXDATE values.
export function applyExdates(occurrences, exdates, zone) {
  if (!exdates || exdates.length === 0) return occurrences;
  const excludedDates = new Set();
  const excludedInstants = new Set();
  const excludedDateTimeDates = new Set();
  const dateStrOf = (f) => `${pad4(f.year)}-${pad2(f.month)}-${pad2(f.day)}`;
  for (const ex of exdates) {
    const fields = parseIcsDateValue(ex.value, ex.tzid ? { TZID: ex.tzid } : {});
    if (fields.form === 'DATE') {
      excludedDates.add(dateStrOf(fields));
    } else {
      excludedInstants.add(instantOfWallClock(fields, zoneOfForm(fields, zone)));
      // RFC 5545 requires EXDATE's value type to match DTSTART's, but real
      // producers write a midnight DATE-TIME EXDATE against an all-day series.
      // An all-day occurrence has no instant to match, so such an EXDATE would
      // otherwise be a silent no-op — the one failure mode that is worse than
      // either alternative. Chosen reading: for all-day occurrences only, a
      // DATE-TIME EXDATE cancels the day it names, taken from the value as
      // written (an all-day series has no zone to convert into). Timed series
      // keep exact instant matching below, so an EXDATE naming a different time
      // on a timed series still cancels nothing.
      excludedDateTimeDates.add(dateStrOf(fields));
    }
  }
  return occurrences.filter((occ) => {
    if (excludedDates.has(occ.dateStr)) return false;
    if (occ.instantMs === null || occ.instantMs === undefined) {
      return !excludedDateTimeDates.has(occ.dateStr);
    }
    return !excludedInstants.has(occ.instantMs);
  });
}

// ---------------------------------------------------------------------------
// parseICS — VEVENTs in, ParsedEvents + skipped accounting out
// ---------------------------------------------------------------------------

// SkipEvent: internal signal that one VEVENT cannot be represented exactly.
// parseICS turns it into a `skipped: [{uid, summary, reason}]` entry — the
// event is counted with its title, never silently dropped, and one bad event
// never kills the rest of the feed.
class SkipEvent extends Error {
  constructor(reason, detail) {
    super(`Skipped event (${reason})${detail ? `: ${detail}` : ''}`);
    this.name = 'SkipEvent';
    this.reason = reason;
  }
}

// must: run a throwing primitive (Task 2/3 parsers all throw on malformed
// input) and convert the throw into a skip reason. UnknownTz keeps its own
// reason so the settings row can say "unknown timezone" rather than "bad date".
function must(fn, reason) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof UnknownTz) throw new SkipEvent('unknown_tz', err.raw);
    throw new SkipEvent(reason, err.message);
  }
}

function emptyRawEvent() {
  return {
    uid: null, summary: null, dtstart: null, dtend: null, duration: null,
    rrule: null, exdateLines: [], recurrenceId: null, hasRdate: false,
  };
}

function collectProperty(raw, prop, params, value) {
  switch (prop) {
    case 'UID': raw.uid = value; break;
    case 'SUMMARY': raw.summary = unescapeText(value); break;
    case 'DTSTART': raw.dtstart = { value, params }; break;
    case 'DTEND': raw.dtend = { value, params }; break;
    case 'DURATION': raw.duration = value; break;
    case 'RRULE': raw.rrule = value; break;
    case 'EXDATE': raw.exdateLines.push({ values: value.split(','), params }); break;
    case 'RDATE': raw.hasRdate = true; break;
    case 'RECURRENCE-ID': raw.recurrenceId = { value, params }; break;
    default: break; // unknown properties are decoration, not event data
  }
}

// comparableMs: a number that orders two date values against each other.
// Absolute forms (UTC/TZID) become real instants; DATE and FLOATING values are
// compared as written, which is exact as long as both sides are the same form
// (they are, in every real feed: producers write DTSTART and DTEND in one
// form). A mixed floating/absolute pair is left uncompared rather than judged
// against a guessed zone — see checkOrder.
function comparableMs(fields) {
  if (fields.form === 'DATE') return utcMs(fields.year, fields.month, fields.day);
  if (fields.form === 'FLOATING') {
    return utcMs(fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second);
  }
  return instantOfWallClock(fields, fields.form === 'UTC' ? 'UTC' : fields.tzid);
}

function comparableClass(fields) {
  if (fields.form === 'DATE') return 'date';
  if (fields.form === 'FLOATING') return 'floating';
  return 'absolute';
}

function buildParsedEvent(raw) {
  if (!raw.uid) throw new SkipEvent('missing_uid');
  if (!raw.dtstart) throw new SkipEvent('missing_dtstart');

  const start = must(() => parseIcsDateValue(raw.dtstart.value, raw.dtstart.params), 'bad_date');
  const allDay = start.form === 'DATE';

  let dtend = null;
  if (raw.dtend) {
    const end = must(() => parseIcsDateValue(raw.dtend.value, raw.dtend.params), 'bad_date');
    // A DATE DTSTART with a DATE-TIME DTEND (or vice versa) is malformed; it
    // has no single truthful shape, so it is skipped rather than coerced.
    if ((end.form === 'DATE') !== allDay) throw new SkipEvent('bad_date', 'mixed DATE/DATE-TIME');
    if (comparableClass(end) === comparableClass(start) && comparableMs(end) < comparableMs(start)) {
      throw new SkipEvent('bad_date', 'DTEND before DTSTART');
    }
    dtend = { value: raw.dtend.value, tzid: end.tzid };
  }

  // DTEND wins over DURATION (spec's end-resolution order); DURATION is only
  // read when DTEND is absent.
  let duration = null;
  if (!raw.dtend && raw.duration !== null) {
    must(() => parseDuration(raw.duration), 'bad_duration');
    duration = raw.duration;
  }

  // RDATE would *add* instances. Ignoring it would silently lose them, so the
  // event is skipped with a reason instead.
  if (raw.hasRdate) throw new SkipEvent('unsupported_rdate');

  // A RECURRENCE-ID event replaces exactly one instance of its master, so it
  // has no recurrence of its own. An RRULE on one is only meaningful together
  // with RANGE=THISANDFUTURE (already skipped below) — expanding it at the
  // matched slot would fabricate instances the calendar does not contain, so
  // it is skipped with its own reason instead.
  if (raw.recurrenceId && raw.rrule !== null) {
    throw new SkipEvent('unsupported_recurrence_id_rrule');
  }

  let rrule = null;
  if (raw.rrule !== null) {
    parseRRule(raw.rrule); // throws UnsupportedRRule with its own reason
    rrule = raw.rrule;
  }

  const exdates = [];
  for (const line of raw.exdateLines) {
    for (const value of line.values) {
      const fields = must(() => parseIcsDateValue(value, line.params), 'bad_date');
      exdates.push({ value, tzid: fields.tzid });
    }
  }

  let recurrenceId = null;
  if (raw.recurrenceId) {
    // RANGE=THISANDFUTURE rewrites the rest of the series, not one instance.
    if (raw.recurrenceId.params.RANGE) throw new SkipEvent('unsupported_recurrence_id_range');
    const fields = must(() => parseIcsDateValue(raw.recurrenceId.value, raw.recurrenceId.params), 'bad_date');
    recurrenceId = { value: raw.recurrenceId.value, tzid: fields.tzid };
  }

  return {
    uid: raw.uid,
    title: raw.summary === null ? '' : raw.summary,
    form: start.form,
    dtstart: { value: raw.dtstart.value, tzid: start.tzid },
    dtend,
    duration,
    rrule,
    exdates,
    recurrenceId,
  };
}

// parseICS: ICS text -> { events: [ParsedEvent], skipped: [{uid, summary, reason}] }.
// ParsedEvents are recurrence *rules*, not instances (expansion is lazy, per
// viewed range) and are compact and JSON-serializable so the feed cache can
// hold them.
//
// Component nesting is tracked, not assumed: a VALARM's DURATION and a
// VTIMEZONE's DTSTART/RRULE must never be read as event data.
export function parseICS(text) {
  const events = [];
  const skipped = [];
  let raw = null;
  let nested = 0;

  for (const line of unfoldLines(text)) {
    if (line === '') continue;
    const { name, params, value } = parseProperty(line);
    const prop = name.toUpperCase();

    if (prop === 'BEGIN') {
      if (raw) nested++;
      else if (value.toUpperCase() === 'VEVENT') { raw = emptyRawEvent(); nested = 0; }
      continue;
    }
    if (prop === 'END') {
      if (raw && nested > 0) { nested--; continue; }
      if (raw && value.toUpperCase() === 'VEVENT') {
        const uid = raw.uid || null;
        const summary = raw.summary === null ? '' : raw.summary;
        try {
          events.push(buildParsedEvent(raw));
        } catch (err) {
          if (err instanceof SkipEvent || err instanceof UnsupportedRRule) {
            skipped.push({ uid, summary, reason: err.reason });
          } else {
            throw err; // an unclassified failure is a bug here, not feed data
          }
        }
        raw = null;
      }
      continue;
    }
    if (!raw || nested > 0) continue;
    collectProperty(raw, prop, params, value);
  }

  // A VEVENT still open at end of input was never terminated — a body cut
  // mid-feed, or one closed only by END:VCALENDAR. Its remaining properties are
  // unknown, so it cannot be trusted as an event; it is counted as skipped
  // rather than vanishing from both lists.
  if (raw) {
    skipped.push({
      uid: raw.uid || null,
      summary: raw.summary === null ? '' : raw.summary,
      reason: 'unterminated_vevent',
    });
  }

  return { events, skipped };
}

// ---------------------------------------------------------------------------
// expandEvents — rules -> per-day EventInstances for one requested range
// ---------------------------------------------------------------------------

// refFields: re-read a stored { value, tzid } reference. The value's own shape
// says which form it is ('20260901' -> DATE, '…Z' -> UTC, plus tzid -> TZID,
// otherwise floating), so no VALUE param needs to be carried in the cache.
function refFields(ref) {
  return parseIcsDateValue(ref.value, ref.tzid ? { TZID: ref.tzid } : {});
}

// endSpecOf: the spec's end-resolution order, once per event.
//   DTEND > DURATION > neither
// All-day ends are nominal whole days (DTEND exclusive per RFC); timed ends
// are an exact duration taken from the first instance and re-added to every
// later instance, so a TZID series keeps its length across a DST transition.
// DTEND == DTSTART (Canvas's timed-assignment shape) means "no end".
function endSpecOf(ev, start, allDay, zone, targetTz) {
  if (ev.dtend) {
    const end = refFields(ev.dtend);
    if (allDay) {
      const span = dayNumOf(end.year, end.month, end.day) - dayNumOf(start.year, start.month, start.day);
      return { kind: 'days', spanDays: span >= 1 ? span : 1 };
    }
    const ms = instantOfWallClock(end, zoneOfForm(end, targetTz)) - instantOfWallClock(start, zone);
    return ms > 0 ? { kind: 'ms', durationMs: ms } : { kind: 'none' };
  }
  if (ev.duration) {
    const ms = parseDuration(ev.duration);
    if (allDay) return { kind: 'days', spanDays: Math.max(1, Math.round(ms / MS_PER_DAY)) };
    return ms > 0 ? { kind: 'ms', durationMs: ms } : { kind: 'none' };
  }
  return allDay ? { kind: 'days', spanDays: 1 } : { kind: 'none' };
}

// emitOccurrence: one occurrence -> the EventInstances a day-based UI can
// render truthfully.
//   all-day / multi-day all-day : one untimed instance per covered day
//   timed, no end               : one instance, endTime null
//   timed within one day        : one instance with both times, or endTime
//                                 null when the local end does not advance
//                                 (zero length, or a DST fall-back hour)
//   timed across two days       : two segments (start-23:59, 00:00-end)
//   timed across >2 days        : one untimed instance per covered day, so a
//                                 week-long block cannot shred Day view's
//                                 overlap layout into slivers
// Each produced instance is filtered against the requested range on its own
// date, so range edges cut segments, not whole events.
function emitOccurrence(uid, title, occ, ctx, out) {
  const { allDay, endSpec, targetTz, rangeStartDay, rangeEndDay } = ctx;
  const push = (day, time, endTime) => {
    if (day < rangeStartDay || day > rangeEndDay) return;
    out.push({ uid, title, date: isoOfDayNum(day), time, endTime });
  };

  if (allDay) {
    const span = endSpec.kind === 'days' ? endSpec.spanDays : 1;
    for (let i = 0; i < span; i++) push(occ.day + i, null, null);
    return;
  }

  const startWall = formatZonedParts(occ.instantMs, targetTz);
  const startLocal = wallToDateTime(startWall);
  const startDay = dayNumOf(startWall.year, startWall.month, startWall.day);

  if (endSpec.kind === 'none') {
    push(startDay, startLocal.time, null);
    return;
  }

  const endWall = formatZonedParts(occ.instantMs + endSpec.durationMs, targetTz);
  const endLocal = wallToDateTime(endWall);
  let endDay = dayNumOf(endWall.year, endWall.month, endWall.day);
  let endTime = endLocal.time;
  // An end of exactly 00:00 belongs to the previous day's display: a
  // 22:00-00:00 event occupies one day, not two.
  if (endDay > startDay && endTime === '00:00') { endDay -= 1; endTime = '23:59'; }

  const dayCount = endDay - startDay + 1;
  if (dayCount <= 1) {
    // A non-increasing local end means "no renderable end": either a
    // zero-length event, or one inside a DST fall-back hour, where the repeated
    // wall clock puts the local end at or before the local start (NY
    // 2026-11-01 01:30 + PT30M reads as 01:00). Emitting that range would give
    // Day view a negative block height and break the endTime > time invariant
    // items.js enforces, so the instance renders as a pinned chip instead.
    push(startDay, startLocal.time, endTime <= startLocal.time ? null : endTime);
    return;
  }
  if (dayCount === 2) {
    push(startDay, startLocal.time, '23:59');
    push(endDay, '00:00', endTime);
    return;
  }
  for (let day = startDay; day <= endDay; day++) push(day, null, null);
}

function expandOne(ev, overrides, ctxBase, out) {
  const start = refFields(ev.dtstart);
  const allDay = start.form === 'DATE';
  const zone = allDay ? null : zoneOfForm(start, ctxBase.targetTz);
  const startDay = dayNumOf(start.year, start.month, start.day);
  const endSpec = endSpecOf(ev, start, allDay, zone, ctxBase.targetTz);
  const ctx = { ...ctxBase, allDay, endSpec };

  // instantForDay: the occurrence on `day` keeps DTSTART's wall-clock time of
  // day in the event's own zone — which is what makes a TZID series stay at
  // 09:00 across a DST change while a UTC series shifts.
  const instantForDay = allDay ? () => null : (day) => {
    const civil = civilOfDayNum(day);
    return instantOfWallClock(
      { ...civil, hour: start.hour, minute: start.minute, second: start.second },
      zone,
    );
  };

  let days;
  if (!ev.rrule) {
    days = [startDay];
  } else {
    const rule = parseRRule(ev.rrule); // already validated by parseICS
    // Widen the generation window by the event's own span so an occurrence
    // that starts before the range but reaches into it is still generated.
    const spanDays = endSpec.kind === 'days'
      ? endSpec.spanDays
      : endSpec.kind === 'ms' ? Math.ceil(endSpec.durationMs / MS_PER_DAY) + 1 : 1;
    const genStartDay = ctx.rangeStartDay - spanDays - 1;
    const genEndDay = ctx.rangeEndDay + 1;
    days = generateOccurrenceDays(
      startDay, start, rule, genStartDay, genEndDay,
      untilPredicate(rule, allDay, zone, instantForDay),
    );
  }

  let occurrences = days.map((day) => ({
    day, dateStr: isoOfDayNum(day), instantMs: instantForDay(day),
  }));
  occurrences = applyExdates(occurrences, ev.exdates, allDay ? ctx.targetTz : zone);

  for (const occ of occurrences) {
    // An overridden occurrence is only *suppressed* here. The override itself
    // is expanded independently by expandEvents from its own DTSTART, because
    // a reschedule can land outside the window this master is generated over
    // (see the comment on the override pass there).
    if (overrides && findOverride(overrides, occ)) continue;
    emitOccurrence(ev.uid, ev.title, occ, ctx, out);
  }
}

function findOverride(overrides, occ) {
  if (occ.instantMs !== null && overrides.byInstant.has(occ.instantMs)) {
    return overrides.byInstant.get(occ.instantMs);
  }
  if (overrides.byDate.has(occ.dateStr)) return overrides.byDate.get(occ.dateStr);
  return null;
}

// untilPredicate: UNTIL is compared on absolute instants and is inclusive
// (RFC 5545). A UTC 'Z' UNTIL is used as written — which is why a Z-form UNTIL
// landing mid-local-day excludes that day's later instance instead of
// admitting it. A DATE-form UNTIL means the end of that day in the event's
// zone; a naive (no Z) UNTIL is read in the event's own zone. All-day series
// compare civil dates, which have no zone at all.
function untilPredicate(rule, allDay, zone, instantForDay) {
  if (!rule.until) return () => true;
  const until = rule.until;
  if (allDay) {
    const untilDay = dayNumOf(until.year, until.month, until.day);
    return (day) => day <= untilDay;
  }
  let untilInstant;
  if (until.form === 'UTC') {
    untilInstant = utcMs(until.year, until.month, until.day, until.hour, until.minute, until.second);
  } else if (until.form === 'DATE') {
    untilInstant = instantOfWallClock({ ...until, hour: 23, minute: 59, second: 59 }, zone);
  } else {
    untilInstant = instantOfWallClock(until, zone);
  }
  return (day) => instantForDay(day) <= untilInstant;
}

// sortInstances: date, then start time with untimed first, then title, then
// uid. Same ordering as js/items.js's sortItemsByDate (minus createdAt, which
// js/feeds.js stamps on), so merged own+external lists do not reshuffle.
function sortInstances(instances) {
  return instances.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.time !== b.time) {
      if (a.time === null) return -1;
      if (b.time === null) return 1;
      return a.time < b.time ? -1 : 1;
    }
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });
}

// expandEvents: ParsedEvents -> [{ uid, title, date, time, endTime }] for the
// inclusive range [rangeStartISO, rangeEndISO] (both 'YYYY-MM-DD') expressed
// in targetTz. js/feeds.js stamps id/createdAt/feedId/feedColor/external onto
// each instance.
//
// `parsed` may be a parseICS result or a bare ParsedEvent array (the feed
// cache stores the former). Expansion is lazy: only the requested window is
// iterated, after phase-aligning each rule's cycle to its DTSTART.
export function expandEvents(parsed, rangeStartISO, rangeEndISO, targetTz) {
  const events = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.events) ? parsed.events : null);
  if (!events) throw new Error('expandEvents: expected a parseICS result or an array of ParsedEvents');
  if (typeof targetTz !== 'string' || targetTz === '') {
    throw new Error('expandEvents: targetTz is required (no implicit device zone)');
  }
  const rangeStartDay = dayNumOfISO(rangeStartISO);
  const rangeEndDay = dayNumOfISO(rangeEndISO);
  if (rangeEndDay < rangeStartDay) {
    throw new Error(`expandEvents: range end ${rangeEndISO} precedes range start ${rangeStartISO}`);
  }

  // A RECURRENCE-ID VEVENT shares its master's UID and replaces one of its
  // instances. Index the overrides first; an override whose master is absent
  // from the feed is expanded on its own rather than silently lost.
  const masterUids = new Set();
  for (const ev of events) if (!ev.recurrenceId) masterUids.add(ev.uid);
  const overridesByUid = new Map();
  for (const ev of events) {
    if (!ev.recurrenceId || !masterUids.has(ev.uid)) continue;
    let entry = overridesByUid.get(ev.uid);
    if (!entry) { entry = { byDate: new Map(), byInstant: new Map() }; overridesByUid.set(ev.uid, entry); }
    const rid = refFields(ev.recurrenceId);
    if (rid.form === 'DATE') {
      entry.byDate.set(`${pad4(rid.year)}-${pad2(rid.month)}-${pad2(rid.day)}`, ev);
    } else {
      entry.byInstant.set(instantOfWallClock(rid, zoneOfForm(rid, targetTz)), ev);
    }
  }

  const ctxBase = { targetTz, rangeStartDay, rangeEndDay };
  const out = [];
  for (const ev of events) {
    if (ev.recurrenceId && masterUids.has(ev.uid)) continue; // expanded in the override pass below
    expandOne(ev, overridesByUid.get(ev.uid) || null, ctxBase, out);
  }

  // Override pass. An override is expanded from its own DTSTART/DTEND, not as
  // a side effect of its master generating the original slot: the master's
  // generation window is only widened by the event's own span, so a reschedule
  // that moves an instance further than that (e.g. a weekly instance pushed
  // +8 days, viewed on its new date) would otherwise emit nothing at all.
  // emitOccurrence range-filters each produced instance, so an override
  // outside [rangeStart, rangeEnd] still contributes nothing.
  for (const entry of overridesByUid.values()) {
    for (const override of entry.byInstant.values()) expandOne(override, null, ctxBase, out);
    for (const override of entry.byDate.values()) expandOne(override, null, ctxBase, out);
  }
  return sortInstances(out);
}
