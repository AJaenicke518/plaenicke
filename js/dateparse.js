// dateparse.js
// Turns a sentence like "physics assignment due July second" into { title, date }.
// THIS IS THE SINGLE SPOT that Claude-powered parsing will replace later.
// V1 handles: ISO dates, "today", "tomorrow", "in N days", and "<month> <day>"
// where the day is a number (2, 2nd) or an ordinal word (second, twenty-first).

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const SIMPLE_ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };

export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function monthIndex(name) {
  const n = name.toLowerCase().replace(/\.$/, '');
  const i = MONTHS.indexOf(n);
  return i !== -1 ? i : MONTH_ABBR.indexOf(n);
}

// Convert an ordinal word/phrase ("second", "twenty-first", "thirty first") to 1-31, or null.
function ordinalToNumber(phrase) {
  const w = phrase.toLowerCase().replace(/\s+/g, '-');
  if (SIMPLE_ORD[w] != null) return SIMPLE_ORD[w];
  const m = w.match(/^(twenty|thirty)-(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/);
  if (m) return ({ twenty: 20, thirty: 30 })[m[1]] + SIMPLE_ORD[m[2]];
  return null;
}

function isValidMonthDay(mi, day) {
  return mi !== -1 && day >= 1 && day <= 31;
}

function resolveMonthDay(mIndex, day, today) {
  let candidate = new Date(today.getFullYear(), mIndex, day);
  if (toISO(candidate) < toISO(today)) {
    candidate = new Date(today.getFullYear() + 1, mIndex, day);
  }
  return toISO(candidate);
}

// Find a date expression in text. Returns { iso, index, length } or null.
function findDate(text, today) {
  let m;

  // ISO YYYY-MM-DD, with a light validity check so junk like 2026-13-45 is ignored.
  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const mo = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      return { iso: `${m[1]}-${m[2]}-${m[3]}`, index: m.index, length: m[0].length };
    }
  }

  m = text.match(/\b(today|tomorrow)\b/i);
  if (m) {
    const d = addDays(today, m[1].toLowerCase() === 'tomorrow' ? 1 : 0);
    return { iso: toISO(d), index: m.index, length: m[0].length };
  }

  m = text.match(/\bin (\d+) days?\b/i);
  if (m) return { iso: toISO(addDays(today, parseInt(m[1], 10))), index: m.index, length: m[0].length };

  const monthPat = MONTHS.concat(MONTH_ABBR).join('|');

  // <month> <number>, with an optional ordinal suffix: "July 2", "July 2nd", "Jul 21st"
  m = text.match(new RegExp(`\\b(${monthPat})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'));
  if (m) {
    const mi = monthIndex(m[1]);
    const day = parseInt(m[2], 10);
    if (isValidMonthDay(mi, day)) {
      return { iso: resolveMonthDay(mi, day, today), index: m.index, length: m[0].length };
    }
  }

  // <month> <ordinal word>: "July second", "July twenty-first"
  const ordCore = Object.keys(SIMPLE_ORD).join('|');
  m = text.match(new RegExp(`\\b(${monthPat})\\.?\\s+((?:twenty|thirty)[- ])?(${ordCore})\\b`, 'i'));
  if (m) {
    const mi = monthIndex(m[1]);
    const day = ordinalToNumber((m[2] || '') + m[3]);
    if (day != null && isValidMonthDay(mi, day)) {
      return { iso: resolveMonthDay(mi, day, today), index: m.index, length: m[0].length };
    }
  }

  return null;
}

function cleanTitle(s) {
  let out = s.replace(/\s+/g, ' ').trim();
  out = out.replace(/[\s,]*\b(due on|due by|due|on|by|at)\b[\s,]*$/i, '').trim();
  out = out.replace(/^[\s,]*\b(due|on|by|at)\b[\s,]*/i, '').trim();
  return out;
}

export function parseSmartAdd(text, today) {
  const found = findDate(text, today);
  if (!found) return { title: cleanTitle(text), date: null };
  const remainder = text.slice(0, found.index) + ' ' + text.slice(found.index + found.length);
  return { title: cleanTitle(remainder), date: found.iso };
}
