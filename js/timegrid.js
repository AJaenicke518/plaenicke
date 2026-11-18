// timegrid.js — pure time & day-grid math. No DOM.

export function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function formatTime(hhmm, fmt = '12h') {
  const [h, m] = hhmm.split(':').map(Number);
  const mm = String(m).padStart(2, '0');
  if (fmt === '24h') return `${String(h).padStart(2, '0')}:${mm}`;
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${mm} ${period}`;
}

export function formatTimeRange(start, end, fmt = '12h') {
  if (fmt === '24h') return `${formatTime(start, '24h')}–${formatTime(end, '24h')}`;
  const a = formatTime(start), b = formatTime(end);
  const [aTime, aPeriod] = a.split(' ');
  const [bTime, bPeriod] = b.split(' ');
  if (aPeriod === bPeriod) return `${aTime}–${bTime} ${bPeriod}`;
  return `${a}–${b}`;
}

// The hour gutter label: "7 AM" / "1 PM", or "07" / "13" in 24-hour.
export function hourLabel(h, fmt = '12h') {
  if (fmt === '24h') return String(h).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
}

export function addDays(iso, n) {
  const [y, mo, d] = iso.split('-').map(Number);
  const next = new Date(y, mo - 1, d + n);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

export function startOfWeek(iso, weekStart = 'sun') {
  const [y, mo, d] = iso.split('-').map(Number);
  const dow = new Date(y, mo - 1, d).getDay();
  return addDays(iso, -(weekStart === 'mon' ? (dow + 6) % 7 : dow));
}

export function weekdayNames(weekStart = 'sun') {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return weekStart === 'mon' ? [...names.slice(1), names[0]] : names;
}

// The Week header: "MM/DD – MM/DD", with each year added only when the two
// differ, so a week across New Year's does not read as running backwards.
export function weekLabel(startISO, endISO) {
  const md = (iso) => iso.slice(5).replace('-', '/');
  if (startISO.slice(0, 4) === endISO.slice(0, 4)) return `${md(startISO)} – ${md(endISO)}`;
  return `${md(startISO)}/${startISO.slice(0, 4)} – ${md(endISO)}/${endISO.slice(0, 4)}`;
}

export function bucketDayItems(items) {
  const untimed = [], timed = [];
  for (const it of items) (it.time ? timed : untimed).push(it);
  timed.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return { untimed, timed };
}

export function layoutDayBlocks(timedItems, defaultDurationMin = 30) {
  const rows = timedItems
    .map((item) => {
      const startMin = minutesOf(item.time);
      const pinned = !item.endTime;
      const endMin = Math.min(pinned ? startMin + defaultDurationMin : minutesOf(item.endTime), 1440);
      return { item, startMin, endMin, pinned, col: 0, cols: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  // Cluster transitively-overlapping rows, then assign each row the first free column.
  let cluster = [], clusterEnd = -1;
  const closeCluster = () => {
    const colEnds = [];
    for (const r of cluster) {
      let c = colEnds.findIndex((end) => end <= r.startMin);
      if (c === -1) { c = colEnds.length; colEnds.push(0); }
      r.col = c;
      colEnds[c] = r.endMin;
    }
    for (const r of cluster) r.cols = colEnds.length;
  };
  for (const r of rows) {
    if (cluster.length && r.startMin >= clusterEnd) { closeCluster(); cluster = []; clusterEnd = -1; }
    cluster.push(r);
    clusterEnd = Math.max(clusterEnd, r.endMin);
  }
  if (cluster.length) closeCluster();
  return rows;
}
