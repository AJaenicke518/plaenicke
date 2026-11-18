// layout.js — which views are visible together on a computer. Pure: no DOM and
// no storage. app.js's showView applies the result; styles.css' desktop gate
// (DESKTOP_QUERY, tied to the CSS prelude by tests/styles.test.js) lays the
// panes out. Below the gate nothing here changes the phone: paneViews gives
// exactly [main].

export const DESKTOP_QUERY = '(min-width: 46rem) and (hover: hover) and (pointer: fine)';
export const WIDE_QUERY = `${DESKTOP_QUERY} and (min-width: 80rem)`;
export const CALENDAR_VIEWS = ['day', '3day', 'week', 'month'];

// The calendar view a layout starts on. `all` shows a week beside the lists.
export function defaultMain(layout) {
  return layout === 'month' ? 'month' : 'week';
}

// { visible, calendar }. `visible` is in document order (today, the calendar
// view, todo, ideas); `calendar` is the calendar view shown, or null.
//   - not a desktop: [main].
//   - planner and month: today plus one big-pane view. The big pane is `main`
//     unless main is today, then `lastCalendar`.
//   - all, wide: today, a calendar view (main if it is one, else lastCalendar),
//     todo and ideas. All, narrower than wide: as planner.
//   - `lastCalendar` undefined (no calendar has been shown yet): the layout's
//     defaultMain.
export function paneViews({ layout, main, lastCalendar = defaultMain(layout), isDesktop, isWide }) {
  if (!isDesktop) {
    return { visible: [main], calendar: CALENDAR_VIEWS.includes(main) ? main : null };
  }
  if (layout === 'all' && isWide) {
    const calendar = CALENDAR_VIEWS.includes(main) ? main : lastCalendar;
    return { visible: ['today', calendar, 'todo', 'ideas'], calendar };
  }
  const big = main !== 'today' ? main : lastCalendar;
  return { visible: ['today', big], calendar: CALENDAR_VIEWS.includes(big) ? big : null };
}

// A `change` listener on a MediaQueryList. Older Safari has only the
// deprecated addListener, so addEventListener is used when it is a function.
export function onMediaChange(mql, fn) {
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', fn);
  else mql.addListener(fn);
}
