// items.js — the shape of a saved item and how to order items.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function makeItem(fields, meta) {
  const title = (fields.title || '').trim();
  if (!title) throw new Error('Title is required');
  if (!fields.date) throw new Error('Date is required');

  const time = fields.time || null;
  const endTime = fields.endTime || null;
  if (time && !HHMM.test(time)) throw new Error('Time must be HH:MM');
  if (endTime && !HHMM.test(endTime)) throw new Error('End time must be HH:MM');
  if (endTime && !time) throw new Error('End time requires a start time');
  if (time && endTime && endTime <= time) throw new Error('End time must be after start time');

  return {
    id: meta.id,
    title,
    date: fields.date,
    time,
    endTime,
    createdAt: meta.createdAt,
    type: fields.type || 'general',
    project: fields.project || null,
    subject: fields.subject || null,
    category: fields.category || null,
  };
}

export function sortItemsByDate(items) {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const at = a.time || null, bt = b.time || null;
    if (at !== bt) {
      if (at === null) return -1;
      if (bt === null) return 1;
      return at < bt ? -1 : 1;
    }
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
