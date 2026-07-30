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

// monthCellSummary: own-chip guarantee — a day mixing own planner items with
// external-feed instances must always surface at least one own-item chip
// when any own item exists that day. External feeds can otherwise flood the
// top maxChips slots (e.g. several timed instances chronologically ahead of
// an untimed own task) and fully evict the user's own items from view. The
// "+N more" count is untouched: it's always dayItems.length - chips.length,
// so truncation accounting stays correct regardless of which items are
// chosen for the visible chips.
export function monthCellSummary(dayItems, maxChips = 2) {
  if (dayItems.length <= maxChips) return { chips: dayItems, more: 0 };
  const chips = dayItems.slice(0, maxChips);
  if (!chips.some((it) => !it.external)) {
    const ownItem = dayItems.find((it) => !it.external);
    if (ownItem) chips[maxChips - 1] = ownItem;
  }
  return { chips, more: dayItems.length - maxChips };
}

// itemTypeClass: the single 'type-' + ... class-name rule shared by every
// render site that colors an item block (list rows, month chips, week
// blocks, day blocks/pins, day's "Other tasks" rows). Own items key off their
// planner type (falling back to 'general'); external instances always map to
// 'type-external' regardless of any type-shaped field, because their color
// comes from the owning feed (via a --feed-color custom property set inline
// at the render site), not the fixed type palette in styles.css.
export function itemTypeClass(item) {
  return `type-${item.external ? 'external' : (item.type || 'general')}`;
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
