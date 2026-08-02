// fake-localstorage.js — Node 22 has no localStorage, so every test that
// exercises storage.js installs this. Kept deliberately faithful: setItem
// coerces to string, getItem returns null (not undefined) for a miss.

export class FakeLocalStorage {
  constructor() { this.store = new Map(); }
  get length() { return this.store.size; }
  key(i) { return [...this.store.keys()][i] ?? null; }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

export function installFakeLocalStorage() {
  const ls = new FakeLocalStorage();
  globalThis.localStorage = ls;
  return ls;
}
