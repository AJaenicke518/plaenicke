// storage.js — the ONLY file that touches localStorage.

const STORAGE_KEY = 'plaenicke.items';

export function serializeItems(items) {
  return JSON.stringify(items);
}

export function deserializeItems(json) {
  if (!json) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(it =>
    it &&
    typeof it.id === 'string' &&
    typeof it.title === 'string' &&
    typeof it.date === 'string');
}

export function loadItems() {
  return deserializeItems(localStorage.getItem(STORAGE_KEY));
}

export function saveItems(items) {
  localStorage.setItem(STORAGE_KEY, serializeItems(items));
}
