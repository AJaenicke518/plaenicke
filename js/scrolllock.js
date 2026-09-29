// scrolllock.js — the page's one scroll lock (sweep F, UI O2).
//
// The item sheet and the Settings panel both stop the page behind them from
// scrolling (iOS scrolls the page under a fixed overlay otherwise). Each used
// to set document.body.style.overflow itself and put back what it found, so
// with both open, closing them in one order left the page scrollable under the
// sheet, and in the other order put 'hidden' back over nothing.
//
// lock() returns this holder's release. The page is locked while ANY holder
// has not released, and the value found before the first lock is put back
// after the last release. A release runs at most once, so a close path that
// fires twice cannot release a lock another holder still has.

let holders = 0;
let saved = '';

export function lock() {
  if (holders === 0) {
    saved = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  holders += 1;
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) document.body.style.overflow = saved;
  };
}
