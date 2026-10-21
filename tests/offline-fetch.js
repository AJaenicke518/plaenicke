// offline-fetch.js — a side-effect module: importing it replaces
// globalThis.fetch with one that counts each call and rejects the way an
// offline device does.
//
// It must be the FIRST static import of a test file that can reach the
// network. ES module imports are evaluated in order, depth-first, before any
// of the importing file's own code runs, so an inline `globalThis.fetch = …`
// in the file's body runs only AFTER every module it imports — a fetch made at
// module scope by one of those (js/fetchtimeout.js, say) would already have
// gone out to the real network. Imported first, this one runs before them.
//
// A test that stubs fetch saves whatever is there and restores it, so the
// offline one is back in place afterwards.
let calls = 0;

export const OFFLINE_MESSAGE = 'network blocked in tests';

export function offlineFetch() {
  calls += 1;
  return Promise.reject(new TypeError(OFFLINE_MESSAGE));
}

// How many times the offline fetch has been called, ever, in this process.
export const offlineFetchCalls = () => calls;

globalThis.fetch = offlineFetch;
