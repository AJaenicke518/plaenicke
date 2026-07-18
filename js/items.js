// items.js — the shape of a saved item and how to order items.

export function makeItem(fields, meta) {
  const title = (fields.title || '').trim();
  if (!title) throw new Error('Title is required');
  if (!fields.date) throw new Error('Date is required');
  return {
    id: meta.id,
    title,
    date: fields.date,
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
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
