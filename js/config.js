// config.js — deploy-time constants and the passphrase (kept on the phone).
// Set WORKER_URL to your deployed Worker URL in Task 7.
export const WORKER_URL = 'https://plaenicke-worker.lucky-star-0281.workers.dev';

const PASS_KEY = 'plaenicke.passphrase';
export function getPassphrase() { return localStorage.getItem(PASS_KEY) || ''; }
export function setPassphrase(p) { localStorage.setItem(PASS_KEY, p); }
