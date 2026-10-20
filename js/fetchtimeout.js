// fetchtimeout.js — fetch with a deadline, for calendar downloads.
//
// Shared by app.js's background refresh and settings.js's manual Sync and Add
// calendar, so all three give up on a download the same way. Moved here from
// app.js (sweep F, I4; reworked twice after review).
//
//   - HEADERS AND BODY: fetch() resolves when the headers arrive, and syncFeed
//     then awaits res.text()/res.json(). A timer cleared at the headers left a
//     body that stalls mid-download unguarded. The same timer races the body
//     read and is disarmed only when that read settles.
//   - 60 s, END TO END. The Worker buffers the whole upstream feed (up to 1 MB,
//     8 s per hop, up to 3 redirects) before it replies, and the phone then
//     downloads it, so a tighter budget could fail a large calendar on weak
//     cellular on EVERY refresh. The timeout exists only so a hung download
//     cannot hang its caller forever; 60 s still guarantees that.
//
// A timed-out download is aborted and rejects. The race also settles a fetch
// that ignores its signal. `fetch` is read at call time, so a test that swaps
// globalThis.fetch is honoured.
export const FETCH_TIMEOUT_MS = 60000;

export function fetchWithTimeout(url, init = {}) {
  const ac = new AbortController();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new Error('timeout')); }, FETCH_TIMEOUT_MS);
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
