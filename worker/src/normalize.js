// normalize.js — turn Claude's raw JSON into a safe { items, needsReview }.
// Defensive on purpose: never trust the model's output shape blindly.

const TYPES = ['due', 'start', 'milestone', 'event'];
const CATEGORIES = ['School', 'Work', 'Personal'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function cleanStrOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function normalizeClaudeJson(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
    return { items: [], needsReview: true };
  }
  const items = [];
  let dropped = false;
  for (const it of raw.items) {
    const title = it && typeof it.title === 'string' ? it.title.trim() : '';
    const date = it && typeof it.date === 'string' ? it.date.trim() : '';
    if (!title || !ISO.test(date)) { dropped = true; continue; }
    items.push({
      title,
      date,
      type: TYPES.includes(it.type) ? it.type : 'event',
      project: cleanStrOrNull(it.project),
      subject: cleanStrOrNull(it.subject),
      category: CATEGORIES.includes(it.category) ? it.category : null,
    });
  }
  const needsReview = raw.needsReview === true || dropped;
  return { items, needsReview };
}
