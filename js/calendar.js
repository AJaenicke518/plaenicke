// calendar.js — pure month-grid math and item bucketing.

export function buildMonthGrid(year, month) {
  const startDow = new Date(year, month, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, date });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function groupItemsByDate(items) {
  const map = {};
  for (const it of items) {
    (map[it.date] = map[it.date] || []).push(it);
  }
  return map;
}

export function monthCellSummary(dayItems, maxChips = 2) {
  if (dayItems.length <= maxChips) return { chips: dayItems, more: 0 };
  return { chips: dayItems.slice(0, maxChips), more: dayItems.length - maxChips };
}

// chronoFirst — for truncated views (month chips, week's 8-block cap): timed items
// first, earliest time first, then untimed items in their existing relative order.
// The LIST view keeps sortItemsByDate's untimed-first order; this does NOT touch that.
export function chronoFirst(dayItems) {
  const timed = dayItems.filter((it) => it.time);
  const untimed = dayItems.filter((it) => !it.time);
  timed.sort((a, b) => a.time.localeCompare(b.time));
  return [...timed, ...untimed];
}
