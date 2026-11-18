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
const LASTS = ['day', 'week'];

// An oracle written from the plan's rules, not from the implementation.
function expected({ layout, main, lastCalendar, isDesktop, isWide }) {
  const isCal = CALENDAR_VIEWS.includes(main);
  if (!isDesktop) return { visible: [main], calendar: isCal ? main : null };
  if (layout === 'all' && isWide) {
    const cal = isCal ? main : lastCalendar;
    return { visible: ['today', cal, 'todo', 'ideas'], calendar: cal };
  }
  const big = main !== 'today' ? main : lastCalendar;
  return { visible: ['today', big], calendar: CALENDAR_VIEWS.includes(big) ? big : null };
}

test('paneViews: the full truth table', () => {
  let n = 0;
  for (const layout of LAYOUTS) for (const isDesktop of [false, true]) for (const isWide of [false, true]) {
    for (const main of MAINS) for (const lastCalendar of LASTS) {
      const input = { layout, main, lastCalendar, isDesktop, isWide };
      assert.deepEqual(paneViews(input), expected(input), JSON.stringify(input));
      n += 1;
    }
  }
  assert.equal(n, 3 * 2 * 2 * 7 * 2);
});

test('paneViews: off a desktop it is always exactly [main], whatever the layout and width', () => {
  for (const layout of LAYOUTS) for (const isWide of [false, true]) for (const main of MAINS) {
    const r = paneViews({ layout, main, lastCalendar: 'week', isDesktop: false, isWide });
    assert.deepEqual(r.visible, [main]);
    assert.equal(r.calendar, CALENDAR_VIEWS.includes(main) ? main : null);
  }
});

test('paneViews: spot checks of the named cases', () => {
  assert.deepEqual(paneViews({ layout: 'planner', main: 'today', lastCalendar: 'week', isDesktop: true, isWide: false }),
    { visible: ['today', 'week'], calendar: 'week' });
  assert.deepEqual(paneViews({ layout: 'planner', main: 'todo', lastCalendar: 'week', isDesktop: true, isWide: false }),
    { visible: ['today', 'todo'], calendar: null });
  assert.deepEqual(paneViews({ layout: 'all', main: 'todo', lastCalendar: 'day', isDesktop: true, isWide: false }),
    { visible: ['today', 'todo'], calendar: null }, 'narrow all behaves as planner');
  assert.deepEqual(paneViews({ layout: 'all', main: 'todo', lastCalendar: 'day', isDesktop: true, isWide: true }),
    { visible: ['today', 'day', 'todo', 'ideas'], calendar: 'day' });
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
