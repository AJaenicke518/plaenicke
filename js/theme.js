// theme.js — pure theme resolution. Applying it to the DOM happens in app.js/settings.js.

export const THEME_KEY = 'plaenicke.theme';

export function resolveTheme(setting, systemPrefersDark) {
  if (setting === 'light') return 'light';
  if (setting === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}
