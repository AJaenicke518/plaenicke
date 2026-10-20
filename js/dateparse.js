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
