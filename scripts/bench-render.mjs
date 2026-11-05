// bench-render.mjs — repeatable Node benchmark of the feed half of one
// render(): the six instancesForRange calls app.js makes (Today, Today's
// look-ahead, Month, Week, 3-day, Day), over two feeds shaped like the
// 2026-10-27 render-perf seed (docs/superpowers/reports/2026-10-27-render-perf-report.md).
//
// NOT a test: the name is outside every node --test pattern on purpose, so
// `npm test` never runs it. It makes no network calls and touches no storage.
//
// Usage:
//   node scripts/bench-render.mjs                 time renders (default)
//   node scripts/bench-render.mjs --runs 300      measured renders (default 200)
//   node scripts/bench-render.mjs --form tzid     large feed in TZID form (default utc)
//   node scripts/bench-render.mjs --tz America/Los_Angeles   device zone (default Europe/Berlin)
//   node scripts/bench-render.mjs --dump out.json writes every output of a
//        fixed matrix (zones x "today" dates x both forms) for diffing two
//        builds; prints nothing else.
//   node scripts/bench-render.mjs --cold          one render per fresh data
//        load (new arrays every render: the cost after a refetch; module-level
//        caches inside js/ stay warm, as they do in a live page)
//   node scripts/bench-render.mjs --shape         time feedShape over both
//        feeds (Settings' per-feed line; js/settings.js calls it uncached)
//   node scripts/bench-render.mjs --first         time only the first render
//        of this process (empty module caches, cold JIT: a page load). Run it
//        in a loop of processes for a distribution.
//
// The data is generated deterministically (seeded PRNG) through the app's own
// parseICS, so every build parses the same text.

import { parseICS } from '../js/ics.js';
import { instancesForRange, feedShape } from '../js/feeds.js';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

// ---------------------------------------------------------------------------
// Deterministic data
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const p2 = (n) => String(n).padStart(2, '0');
const dayMs = 86400000;
const BASE = Date.UTC(2026, 10, 4); // 2026-11-04, the bench's "today"
function ymd(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`; }
function stamp(ms, z) {
  const d = new Date(ms);
  return `${ymd(ms)}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}00${z ? 'Z' : ''}`;
}

function vevent(lines) { return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n'); }
function calendar(events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//bench//EN', ...events, 'END:VCALENDAR'].join('\r\n');
}

// LMU-Classes-shaped: 8 weekly RRULE series in Europe/Berlin (BYDAY, UNTIL in
// December), each with 2 EXDATEs and 2 RECURRENCE-ID overrides, plus 8
// one-off finals. 8 + 16 + 8 = 32 ParsedEvents.
function lmuFeed() {
  const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'MO', 'TU', 'WE'];
  const firstMon = Date.UTC(2026, 9, 12); // Mon 2026-10-12
  const ev = [];
  for (let i = 0; i < 8; i++) {
    const offset = ['MO', 'TU', 'WE', 'TH', 'FR'].indexOf(days[i]);
    const hour = 8 + 2 * (i % 5);
    const start = firstMon + offset * dayMs + hour * 3600000;
    const local = (ms) => `${ymd(ms)}T${p2(new Date(ms).getUTCHours())}${p2(new Date(ms).getUTCMinutes())}00`;
    const uid = `lmu-${i}@bench`;
    ev.push(vevent([
      `UID:${uid}`, `SUMMARY:Lecture ${i}`,
      `DTSTART;TZID=Europe/Berlin:${local(start)}`,
      `DTEND;TZID=Europe/Berlin:${local(start + 2 * 3600000)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${days[i]};UNTIL=20261218T225959Z`,
      `EXDATE;TZID=Europe/Berlin:${local(start + 3 * 7 * dayMs)},${local(start + 6 * 7 * dayMs)}`,
    ]));
    for (const w of [2, 5]) {
      const orig = start + w * 7 * dayMs;
      ev.push(vevent([
        `UID:${uid}`, `SUMMARY:Lecture ${i} (moved)`,
        `RECURRENCE-ID;TZID=Europe/Berlin:${local(orig)}`,
        `DTSTART;TZID=Europe/Berlin:${local(orig + dayMs + 3600000)}`,
        `DTEND;TZID=Europe/Berlin:${local(orig + dayMs + 3 * 3600000)}`,
      ]));
    }
    const fin = Date.UTC(2027, 1, 1 + i) + 10 * 3600000;
    ev.push(vevent([
      `UID:final-${i}@bench`, `SUMMARY:Final ${i}`,
      `DTSTART;TZID=Europe/Berlin:${local(fin)}`,
      `DTEND;TZID=Europe/Berlin:${local(fin + 2 * 3600000)}`,
    ]));
  }
  return calendar(ev);
}

// Large no-RRULE feed (Canvas-shaped), 1,500 ParsedEvents:
//   900 timed events in 30 weekly patterns, 300 point-in-time deadlines
//   (DTSTART == DTEND), 150 all-day events, 150 one-off timed events.
// form 'utc' writes every timed value as UTC 'Z' (what Canvas emits);
// form 'tzid' writes them with TZID=America/New_York (worst case for
// expandEvents: every value goes through zonedWallClockToInstant).
function largeFeed(form) {
  const rnd = mulberry32(42);
  const val = (ms) => (form === 'utc' ? `:${stamp(ms, true)}` : `;TZID=America/New_York:${stamp(ms, false)}`);
  const ev = [];
  let n = 0;
  for (let p = 0; p < 30; p++) {
    const first = BASE - 105 * dayMs + (p % 7) * dayMs + (8 + (p % 9)) * 3600000;
    for (let w = 0; w < 30; w++) {
      const s = first + w * 7 * dayMs;
      ev.push(vevent([`UID:class-${p}-${w}@bench`, `SUMMARY:Class ${p}`,
        `DTSTART${val(s)}`, `DTEND${val(s + 75 * 60000)}`]));
      n++;
    }
  }
  for (let i = 0; i < 300; i++) {
    const s = BASE + Math.floor((rnd() - 0.5) * 120) * dayMs + 23 * 3600000 + 59 * 60000;
    ev.push(vevent([`UID:due-${i}@bench`, `SUMMARY:Assignment ${i}`, `DTSTART${val(s)}`, `DTEND${val(s)}`]));
  }
  for (let i = 0; i < 150; i++) {
    const s = BASE + Math.floor((rnd() - 0.5) * 120) * dayMs;
    const len = 1 + Math.floor(rnd() * 3);
    ev.push(vevent([`UID:allday-${i}@bench`, `SUMMARY:All day ${i}`,
      `DTSTART;VALUE=DATE:${ymd(s)}`, `DTEND;VALUE=DATE:${ymd(s + len * dayMs)}`]));
  }
  for (let i = 0; i < 150; i++) {
    const s = BASE + Math.floor((rnd() - 0.5) * 120) * dayMs + (7 + Math.floor(rnd() * 12)) * 3600000;
    ev.push(vevent([`UID:oneoff-${i}@bench`, `SUMMARY:One-off ${i}`,
      `DTSTART${val(s)}`, `DTEND${val(s + (30 + Math.floor(rnd() * 120)) * 60000)}`]));
  }
  return calendar(ev);
}

const ICS = { lmu: lmuFeed(), utc: largeFeed('utc'), tzid: largeFeed('tzid') };

// Each "load" JSON round-trips like loadFeedCache does: fresh arrays.
function loadCache(form) {
  const lmu = parseICS(ICS.lmu);
  const big = parseICS(ICS[form]);
  if (lmu.skipped.length || big.skipped.length) {
    throw new Error(`bench seed skipped events: ${JSON.stringify([...lmu.skipped, ...big.skipped])}`);
  }
  if (lmu.events.length !== 32 || big.events.length !== 1500) {
    throw new Error(`bench seed sizes ${lmu.events.length}/${big.events.length}, want 32/1500`);
  }
  const fetchedAt = '2026-11-04T08:00:00.000Z';
  return JSON.parse(JSON.stringify({
    lmu: { fetchedAt, events: lmu.events },
    big: { fetchedAt, events: big.events },
  }));
}
const FEEDS = [
  { id: 'lmu', name: 'LMU', color: '#123456', hidden: false },
  { id: 'big', name: 'Canvas', color: '#654321', hidden: false },
];

// ---------------------------------------------------------------------------
// One render's worth of ranges (app.js: renderToday, renderCalendar,
// renderWeek, renderThreeDay, renderDay), for a given "today".
// ---------------------------------------------------------------------------

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function rangesFor(todayISO) {
  const d = new Date(`${todayISO}T00:00:00Z`);
  const y = d.getUTCFullYear(); const m = d.getUTCMonth();
  const monthStart = `${y}-${p2(m + 1)}-01`;
  const monthEnd = `${y}-${p2(m + 1)}-${p2(new Date(Date.UTC(y, m + 1, 0)).getUTCDate())}`;
  const weekStart = addDaysISO(todayISO, -((d.getUTCDay() + 6) % 7));
  return [
    [todayISO, addDaysISO(todayISO, 7)],              // Today (NEXT_DAYS = 7)
    [addDaysISO(todayISO, 1), addDaysISO(todayISO, 30)], // look-ahead (LOOKAHEAD_DAYS = 30)
    [monthStart, monthEnd],                           // Month
    [weekStart, addDaysISO(weekStart, 6)],            // Week
    [todayISO, addDaysISO(todayISO, 2)],              // 3-day
    [todayISO, todayISO],                             // Day
  ];
}

function renderOnce(cache, ranges, tz) {
  let n = 0;
  for (const [s, e] of ranges) n += instancesForRange(FEEDS, cache, s, e, tz).length;
  return n;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: q(0.5), p95: q(0.95), min: s[0], max: s[s.length - 1] };
}
const f = (x) => x.toFixed(2);

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

if (flag('dump')) {
  const out = {};
  for (const form of ['utc', 'tzid']) {
    for (const tz of ['Europe/Berlin', 'America/Los_Angeles', 'UTC', 'Australia/Lord_Howe', 'Asia/Kolkata']) {
      // Each zone gets one cache, rendered for several "today" dates, the
      // first twice: the second pass reads whatever a build cached. Right
      // after the first pass, the same arrays are read in another zone and
      // then in this one again (app.js's deviceTz can change without the
      // cache reloading), before any cache a build keeps could evict them.
      const cache = loadCache(form);
      const other = tz === 'UTC' ? 'Europe/Berlin' : 'UTC';
      const pass = (today, zone, label) => {
        for (const [s, e] of rangesFor(today)) {
          const key = `${form}|${label}|${today}|${s}|${e}`;
          const got = JSON.stringify(instancesForRange(FEEDS, cache, s, e, zone));
          if (out[key] !== undefined && out[key] !== got) throw new Error(`second pass differs: ${key}`);
          out[key] = got;
        }
      };
      pass('2026-11-04', tz, tz);
      pass('2026-11-04', other, `${tz}->${other}`);
      for (const today of ['2026-11-04', '2026-10-24', '2026-10-31', '2026-12-17', '2027-03-27']) pass(today, tz, tz);
    }
  }
  writeFileSync(opt('dump'), JSON.stringify(out));
  process.exit(0);
}

const runs = Number(opt('runs', 200));
const form = opt('form', 'utc');
const tz = opt('tz', 'Europe/Berlin');
const ranges = rangesFor('2026-11-04');
const cold = flag('cold');

let cache = loadCache(form);
if (flag('shape')) {
  // feedShape on fresh arrays each run: Settings recomputes it per open.
  const samples = [];
  for (let i = 0; i < 10 + runs; i++) {
    const c = loadCache(form);
    const t0 = performance.now();
    feedShape(c.lmu.events, tz); feedShape(c.big.events, tz);
    if (i >= 10) samples.push(performance.now() - t0);
  }
  const st = stats(samples);
  console.log(JSON.stringify({ form, tz, shape: true, ...st }));
  console.error(`form=${form} tz=${tz} feedShape x2 n=${st.n} median=${f(st.median)}ms p95=${f(st.p95)}ms`);
  process.exit(0);
}
if (flag('first')) {
  // The very first render in this process: no warm-up, empty module caches
  // (what a page load pays). Run it in several processes for a distribution.
  const t0 = performance.now();
  const n = renderOnce(cache, ranges, tz);
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ form, tz, first: true, instancesPerRender: n, ms }));
  console.error(`form=${form} tz=${tz} first render=${f(ms)}ms`);
  process.exit(0);
}
const instancesPerRender = renderOnce(cache, ranges, tz);
for (let i = 0; i < 20; i++) renderOnce(cold ? loadCache(form) : cache, ranges, tz); // warm-up

const samples = [];
for (let i = 0; i < runs; i++) {
  if (cold) cache = loadCache(form);
  const t0 = performance.now();
  renderOnce(cache, ranges, tz);
  samples.push(performance.now() - t0);
}
const st = stats(samples);
console.log(JSON.stringify({ form, tz, cold, instancesPerRender, ...st }));
console.error(`form=${form} tz=${tz} cold=${cold} instances/render=${instancesPerRender} `
  + `n=${st.n} median=${f(st.median)}ms p95=${f(st.p95)}ms min=${f(st.min)} max=${f(st.max)}`);
