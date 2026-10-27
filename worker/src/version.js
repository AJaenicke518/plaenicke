// version.js — the deploy marker served by GET /version.
//
// A build-time constant, bumped BY HAND in the same commit as any Worker
// change that will be deployed. scripts/smoke-worker.mjs imports this file and
// compares it to what the deployed Worker answers, so a smoke run can tell the
// new deploy from the old one still on the edge. It is not a secret and carries
// no build metadata: a plain string, nothing derived from env or the clock.
export const VERSION = 'worker-2026-10-27.1';
