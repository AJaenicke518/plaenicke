// items.js — the shape of a saved item and how to order items.

export function makeItem(title, date, meta) {
  const clean = (title || '').trim();
  if (!clean) throw new Error('Title is required');
  return { id: meta.id, title: clean, date, createdAt: meta.createdAt };
}

export function sortItemsByDate(items) {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
