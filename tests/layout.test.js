// js/layout.js: the pure rule that decides which views are visible together on
// a computer, plus the index.html structure the rules rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DESKTOP_QUERY, WIDE_QUERY, CALENDAR_VIEWS, defaultMain, paneViews, onMediaChange,
} from '../js/layout.js';

test('the gate and wide queries are the documented strings', () => {
  assert.equal(DESKTOP_QUERY, '(min-width: 46rem) and (hover: hover) and (pointer: fine)');
  assert.equal(WIDE_QUERY, `${DESKTOP_QUERY} and (min-width: 80rem)`);
  assert.deepEqual(CALENDAR_VIEWS, ['day', '3day', 'week', 'month']);
});

test('defaultMain: month gives month, planner and all give week', () => {
  assert.equal(defaultMain('month'), 'month');
  assert.equal(defaultMain('planner'), 'week');
  assert.equal(defaultMain('all'), 'week');
});

const LAYOUTS = ['planner', 'month', 'all'];
const MAINS = ['today', 'day', '3day', 'week', 'month', 'todo', 'ideas'];
const LASTS = ['day', '3day', 'week', 'month', undefined];

// Hand-written expected rows: [layout, isDesktop, isWide, main, visible, calendar],
// lastCalendar '3day' throughout (distinct from every layout's default, so a
// row cannot pass by reading the default). Every layout x isDesktop x isWide
// combination, five mains each.
const ROWS = [
  ['planner', false, false, 'today', ['today'], null],
  ['planner', false, false, 'week', ['week'], 'week'],
  ['planner', false, false, 'month', ['month'], 'month'],
  ['planner', false, false, 'todo', ['todo'], null],
  ['planner', false, false, 'ideas', ['ideas'], null],
  ['planner', false, true, 'today', ['today'], null],
  ['planner', false, true, 'week', ['week'], 'week'],
  ['planner', false, true, 'month', ['month'], 'month'],
  ['planner', false, true, 'todo', ['todo'], null],
  ['planner', false, true, 'ideas', ['ideas'], null],
  ['planner', true, false, 'today', ['today', '3day'], '3day'],
  ['planner', true, false, 'week', ['today', 'week'], 'week'],
  ['planner', true, false, 'month', ['today', 'month'], 'month'],
  ['planner', true, false, 'todo', ['today', 'todo'], null],
  ['planner', true, false, 'ideas', ['today', 'ideas'], null],
  ['planner', true, true, 'today', ['today', '3day'], '3day'],
  ['planner', true, true, 'week', ['today', 'week'], 'week'],
  ['planner', true, true, 'month', ['today', 'month'], 'month'],
  ['planner', true, true, 'todo', ['today', 'todo'], null],
  ['planner', true, true, 'ideas', ['today', 'ideas'], null],
  ['month', false, false, 'today', ['today'], null],
  ['month', false, false, 'week', ['week'], 'week'],
  ['month', false, false, 'month', ['month'], 'month'],
  ['month', false, false, 'todo', ['todo'], null],
  ['month', false, false, 'ideas', ['ideas'], null],
  ['month', false, true, 'today', ['today'], null],
  ['month', false, true, 'week', ['week'], 'week'],
  ['month', false, true, 'month', ['month'], 'month'],
  ['month', false, true, 'todo', ['todo'], null],
  ['month', false, true, 'ideas', ['ideas'], null],
  ['month', true, false, 'today', ['today', '3day'], '3day'],
  ['month', true, false, 'week', ['today', 'week'], 'week'],
  ['month', true, false, 'month', ['today', 'month'], 'month'],
  ['month', true, false, 'todo', ['today', 'todo'], null],
  ['month', true, false, 'ideas', ['today', 'ideas'], null],
  ['month', true, true, 'today', ['today', '3day'], '3day'],
  ['month', true, true, 'week', ['today', 'week'], 'week'],
  ['month', true, true, 'month', ['today', 'month'], 'month'],
  ['month', true, true, 'todo', ['today', 'todo'], null],
  ['month', true, true, 'ideas', ['today', 'ideas'], null],
  ['all', false, false, 'today', ['today'], null],
  ['all', false, false, 'week', ['week'], 'week'],
  ['all', false, false, 'month', ['month'], 'month'],
  ['all', false, false, 'todo', ['todo'], null],
  ['all', false, false, 'ideas', ['ideas'], null],
  ['all', false, true, 'today', ['today'], null],
  ['all', false, true, 'week', ['week'], 'week'],
  ['all', false, true, 'month', ['month'], 'month'],
  ['all', false, true, 'todo', ['todo'], null],
  ['all', false, true, 'ideas', ['ideas'], null],
  ['all', true, false, 'today', ['today', '3day'], '3day'],
  ['all', true, false, 'week', ['today', 'week'], 'week'],
  ['all', true, false, 'month', ['today', 'month'], 'month'],
  ['all', true, false, 'todo', ['today', 'todo'], null],
  ['all', true, false, 'ideas', ['today', 'ideas'], null],
  ['all', true, true, 'today', ['today', '3day', 'todo', 'ideas'], '3day'],
  ['all', true, true, 'week', ['today', 'week', 'todo', 'ideas'], 'week'],
  ['all', true, true, 'month', ['today', 'month', 'todo', 'ideas'], 'month'],
  ['all', true, true, 'todo', ['today', '3day', 'todo', 'ideas'], '3day'],
  ['all', true, true, 'ideas', ['today', '3day', 'todo', 'ideas'], '3day'],
];

test('paneViews: literal expected rows for every layout x desktop x wide combination', () => {
  assert.equal(ROWS.length, 3 * 2 * 2 * 5);
  for (const [layout, isDesktop, isWide, main, visible, calendar] of ROWS) {
    assert.deepEqual(
      paneViews({ layout, main, lastCalendar: '3day', isDesktop, isWide }),
      { visible, calendar },
      JSON.stringify({ layout, isDesktop, isWide, main }),
    );
  }
});

test('paneViews: invariants over the full cross product', () => {
  let n = 0;
  for (const layout of LAYOUTS) for (const isDesktop of [false, true]) for (const isWide of [false, true]) {
    for (const main of MAINS) for (const lastCalendar of LASTS) {
      const input = { layout, main, lastCalendar, isDesktop, isWide };
      const { visible, calendar } = paneViews(input);
      const tag = JSON.stringify(input);
      n += 1;
      assert.ok(visible.every((v) => typeof v === 'string'), `${tag}: no undefined view`);
      if (!isDesktop) {
        assert.deepEqual(visible, [main], tag);
      } else {
        assert.equal(visible[0], 'today', tag);
        assert.notEqual(visible[1], 'today', `${tag}: the big pane is never today`);
        assert.equal(new Set(visible).size, visible.length, `${tag}: no view twice`);
      }
      assert.equal(visible.includes('ideas'),
        (isDesktop && layout === 'all' && isWide) || main === 'ideas', `${tag}: ideas`);
      const shownCalendars = visible.filter((v) => CALENDAR_VIEWS.includes(v));
      assert.equal(calendar === null, shownCalendars.length === 0, `${tag}: calendar null iff none visible`);
      if (calendar !== null) assert.deepEqual(shownCalendars, [calendar], tag);
    }
  }
  assert.equal(n, 3 * 2 * 2 * 7 * 5);
});

test('paneViews: with no lastCalendar, Today beside a calendar gets the layout\'s default', () => {
  const base = { main: 'today', lastCalendar: undefined, isDesktop: true, isWide: false };
  assert.deepEqual(paneViews({ ...base, layout: 'planner' }), { visible: ['today', 'week'], calendar: 'week' });
  assert.deepEqual(paneViews({ ...base, layout: 'month' }), { visible: ['today', 'month'], calendar: 'month' });
  assert.deepEqual(paneViews({ ...base, layout: 'all', isWide: true }),
    { visible: ['today', 'week', 'todo', 'ideas'], calendar: 'week' });
  assert.deepEqual(paneViews({ ...base, layout: 'all', main: 'todo', isWide: true }),
    { visible: ['today', 'week', 'todo', 'ideas'], calendar: 'week' });
});

test('paneViews: lastCalendar is used when given, for each calendar view', () => {
  for (const last of CALENDAR_VIEWS) {
    assert.deepEqual(paneViews({ layout: 'planner', main: 'today', lastCalendar: last, isDesktop: true, isWide: false }),
      { visible: ['today', last], calendar: last });
  }
});

// --- index.html structure ------------------------------------------------------

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr']);
// A tiny tag-stack reader: every element with its tag, id, classes and parent.
function parse(src) {
  const els = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(src))) {
    const [, close, tag, attrs] = m;
    if (close) { stack.pop(); continue; }
    const id = (attrs.match(/\bid="([^"]*)"/) || [])[1] || null;
    const cls = ((attrs.match(/\bclass="([^"]*)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    const el = { tag: tag.toLowerCase(), id, cls, parent: stack[stack.length - 1] || null, attrs };
    els.push(el);
    if (!VOID.has(el.tag) && !/\/\s*$/.test(attrs)) stack.push(el);
  }
  return els;
}
const els = parse(html.slice(html.indexOf('<body')));
const byId = (id) => els.find((e) => e.id === id);
const childIds = (parent) => els.filter((e) => e.parent === parent && e.id).map((e) => e.id);

test('index.html: three pane wrappers with ids sit inside .panes', () => {
  const panes = els.find((e) => e.cls.includes('panes'));
  assert.ok(panes, '.panes exists');
  assert.equal(panes.tag, 'div');
  assert.deepEqual(els.filter((e) => e.parent === panes).map((e) => e.id), ['pane-left', 'pane-main', 'pane-right']);
  for (const [id, cls] of [['pane-left', 'pane-left'], ['pane-main', 'pane-main'], ['pane-right', 'pane-right']]) {
    assert.ok(byId(id).cls.includes(cls), `${id} carries .${cls}`);
  }
});

test('index.html: each wrapper holds exactly its panes, in order', () => {
  assert.deepEqual(childIds(byId('pane-left')), ['capture-dock', 'today-view']);
  assert.deepEqual(childIds(byId('pane-main')),
    ['cal-switch', 'calendar-view', 'week-view', 'three-day-view', 'day-view']);
  assert.deepEqual(childIds(byId('pane-right')), ['todo-view', 'ideas-view']);
});

test('index.html: the capture dock is a row with a typing button and a mic button', () => {
  const dock = byId('capture-dock');
  assert.ok(dock.cls.includes('capture-dock'));
  assert.equal(dock.tag, 'div');
  const buttons = els.filter((e) => e.parent === dock && e.tag === 'button');
  assert.equal(buttons.length, 2);
  const mic = byId('capture-dock-mic');
  assert.ok(mic && mic.parent === dock);
  assert.match(mic.attrs, /aria-controls="capture-box"/);
  const typing = buttons.find((b) => b !== mic);
  assert.match(typing.attrs, /aria-controls="capture-box"/);
  assert.match(typing.attrs, /type="button"/);
  assert.match(mic.attrs, /type="button"/);
});

test('index.html: the hosts, capture box and capture button stay body-level, after .panes', () => {
  const panes = els.find((e) => e.cls.includes('panes'));
  const order = els.indexOf(panes);
  for (const id of ['settings-host', 'sheet-host', 'capture-box', 'capture-btn']) {
    const el = byId(id);
    assert.equal(el.parent.tag, 'body', `${id} is a child of body`);
    assert.ok(els.indexOf(el) > order, `${id} comes after .panes`);
  }
  assert.equal(panes.parent.tag, 'body');
});

test('index.html: the tab bar is outside .panes', () => {
  const nav = els.find((e) => e.cls.includes('tab-bar'));
  assert.equal(nav.parent.tag, 'body');
});

test('onMediaChange listens with addEventListener when it is a function, else addListener', () => {
  const calls = [];
  const modern = { addEventListener(type, fn) { calls.push(['addEventListener', type, fn]); }, addListener() { calls.push(['addListener']); } };
  const old = { addListener(fn) { calls.push(['addListener', fn]); } };
  const fn = () => {};
  onMediaChange(modern, fn);
  onMediaChange(old, fn);
  assert.deepEqual(calls, [['addEventListener', 'change', fn], ['addListener', fn]]);
});
