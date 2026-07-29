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
    const key = line.slice(i, keyEnd);
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

function isValidIanaTz(name) {
  if (!name) return false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
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

// formatZonedParts: instant (epoch ms) -> wall-clock fields in tzid. This is
// the *easy* direction (the one Intl.DateTimeFormat gives directly).
function formatZonedParts(instantMs, tzid) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
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

// icsDateToLocal: parse a raw DTSTART/DTEND value (already split into value
// + params by parseProperty) into { date: 'YYYY-MM-DD', time: 'HH:MM' | null }
// wall-clock fields in targetTz — the shape js/items.js already uses.
//
// Handles all four RFC 5545 forms:
//   - VALUE=DATE (all-day):        '20250101'                -> time: null
//   - UTC ('Z' suffix):            '20260901T090000Z'        -> convert instant to targetTz
//   - TZID param:                  '20260901T090000' + TZID  -> convert zoned wall clock to targetTz
//   - Floating (no Z, no TZID):    '20260901T090000'          -> treated as targetTz wall time already (no conversion)
export function icsDateToLocal(value, params, targetTz) {
  const isDateOnly = (params && params.VALUE === 'DATE') || !value.includes('T');
  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
    if (!m) throw new Error(`Invalid DATE value: ${value}`);
    const [, y, mo, d] = m;
    return { date: `${y}-${mo}-${d}`, time: null };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) throw new Error(`Invalid DATE-TIME value: ${value}`);
  const [, y, mo, d, h, mi, s, zFlag] = m;
  const parts = {
    year: Number(y), month: Number(mo), day: Number(d),
    hour: Number(h), minute: Number(mi), second: Number(s),
  };

  if (!zFlag && !(params && params.TZID)) {
    // Floating time: the wall-clock fields ARE the local time already.
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  }

  const instantMs = zFlag === 'Z'
    ? Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    : zonedWallClockToInstant(parts, resolveTzid(params.TZID));

  const wall = formatZonedParts(instantMs, targetTz);
  return {
    date: `${pad4(wall.year)}-${pad2(wall.month)}-${pad2(wall.day)}`,
    time: `${pad2(wall.hour)}:${pad2(wall.minute)}`,
  };
}
