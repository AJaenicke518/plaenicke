// clock.js — the one clock boundary. Tests inject env.NOW (a function returning an ISO string).
export function nowISO(env) {
  return env && typeof env.NOW === 'function' ? env.NOW() : new Date().toISOString();
}

export function addMinutes(iso, n) {
  return new Date(Date.parse(iso) + n * 60000).toISOString();
}
