// fetchtimeout.js — fetch with a deadline.
//
// Shared by four callers, so each gives up on a request the same way:
// app.js's background feed refresh, settings.js's manual Sync and Add
// calendar, sync's reads (GET /data, passed in as readFetchImpl by app.js and
// linkui.js), and smart add (js/smartadd.js parseViaWorker). Moved here from
// app.js (sweep F, I4; reworked twice after review).
//
//   - HEADERS AND BODY: fetch() resolves when the headers arrive, and syncFeed
//     then awaits res.text()/res.json(). A timer cleared at the headers left a
//     body that stalls mid-download unguarded. The same timer races the body
//     read and is disarmed only when that read settles — so a caller that
//     never reads the body leaves the timer armed until it fires and aborts
//     an already-finished request. Read the body, even on an error status.
//   - 60 s, END TO END, by default. The Worker buffers the whole upstream feed
//     (up to 1 MB, 8 s per hop, up to 3 redirects) before it replies, and the
//     phone then downloads it, so a tighter budget could fail a large calendar
//     on weak cellular on EVERY refresh. The timeout exists only so a hung
//     download cannot hang its caller forever; 60 s still guarantees that.
//     A caller with a different need passes its own budget as the third
//     argument (smart add: SMART_ADD_TIMEOUT_MS, see js/smartadd.js).
//
// A timed-out download is aborted and rejects. The race also settles a fetch
// that ignores its signal. `fetch` is read at call time, so a test that swaps
// globalThis.fetch is honoured.
export const FETCH_TIMEOUT_MS = 60000;

//
// A budget that is not a positive finite number throws a TypeError at once:
// setTimeout reads one as 0–1 ms (or never, for Infinity), so a typo would
// abort every request instantly or never. Only an omitted budget defaults.
export function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`fetchWithTimeout: timeoutMs must be a positive finite number, got ${String(timeoutMs)}`);
  }
  const ac = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new Error('timeout')); }, timeoutMs);
  });
  const disarm = () => clearTimeout(timer);
  const guarded = (p) => Promise.race([p, timedOut]);
  let started;
  try {
    started = fetch(url, { ...init, signal: ac.signal });
  } catch (err) {
    disarm(); // a fetch that throws at once must not leave the timer armed
    return Promise.reject(err);
  }
  return guarded(started).then((res) => ({
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: () => guarded(Promise.resolve().then(() => res.text())).finally(disarm),
    json: () => guarded(Promise.resolve().then(() => res.json())).finally(disarm),
  }), (err) => { disarm(); throw err; });
}
