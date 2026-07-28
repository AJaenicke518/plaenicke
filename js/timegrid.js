// timegrid.js — pure time & day-grid math. No DOM.

export function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

export function formatTimeRange(start, end) {
  const a = formatTime(start), b = formatTime(end);
  const [aTime, aPeriod] = a.split(' ');
  const [bTime, bPeriod] = b.split(' ');
  if (aPeriod === bPeriod) return `${aTime}–${bTime} ${bPeriod}`;
  return `${a}–${b}`;
}

export function addDays(iso, n) {
  const [y, mo, d] = iso.split('-').map(Number);
  const next = new Date(y, mo - 1, d + n);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

export function startOfWeek(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  return addDays(iso, -new Date(y, mo - 1, d).getDay());
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
