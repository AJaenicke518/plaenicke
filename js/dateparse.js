// dateparse.js — the app's two date-string helpers: toISO (which day) and
// nowISO (which instant). Text-to-item parsing is NOT here: js/smartadd.js is
// the single spot that turns text into items (via the Worker).

// toISO: local calendar date only ('YYYY-MM-DD') — day resolution, no time
// or zone. Use for anything keyed to "which day", e.g. calendar navigation.
export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// nowISO: full-precision UTC instant (e.g. '2026-08-01T22:05:00.000Z'). Use
// for anything that needs to compare "when" across records/devices, e.g.
// updatedAt/deletedAt timestamps feeding sync's last-write-wins.
export function nowISO() { return new Date().toISOString(); }

// localStamp: LOCAL date and wall-clock time to the millisecond, with no zone
// ('YYYY-MM-DDTHH:MM:SS.sss'). A new record's createdAt (daily fixes
// 2026-10-27): its first ten characters are toISO's local date, so records
// written before it (date-only createdAt) still compare correctly as strings,
// and two ideas captured the same day order by time instead of by random id.
// NOT an instant: it carries no offset, so never compare it with updatedAt or
// deletedAt. Two known misorders, accepted: inside the repeated hour of a DST
// fall-back, and between devices in different time zones.
export function localStamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${toISO(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
