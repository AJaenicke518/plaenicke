// uid.js — the single ID generator for records that sync.
//
// Uses crypto.randomUUID() rather than timestamp+random: two devices creating
// a record offline in the same millisecond could otherwise collide, and a
// collision means one device's record silently overwrites the other's.
// Requires a secure context in browsers (HTTPS) — GitHub Pages qualifies.

export function uid(prefix) {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}
