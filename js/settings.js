// settings.js — the settings overlay: appearance now, linked calendars later.
import { resolveTheme, THEME_KEY } from './theme.js';

const CHOICES = ['light', 'dark', 'auto'];

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(setting) {
  const resolved = resolveTheme(setting, systemPrefersDark());
  if (resolved === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

function getSetting() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch { /* private mode */ }
  return CHOICES.includes(t) ? t : 'auto';
}

export function initSettings({ button, host }) {
  // Follow the phone while in auto.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => applyTheme(getSetting()));

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    host.innerHTML = '';
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
  }

  function open() {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', 'Settings');
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    const h = document.createElement('h2');
    h.textContent = 'Settings';
    panel.appendChild(h);

    const appearance = document.createElement('div');
    appearance.className = 'settings-section';
    const ah = document.createElement('h3');
    ah.textContent = 'Appearance';
    const seg = document.createElement('div');
    seg.className = 'seg';
    const current = getSetting();
    for (const choice of CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = choice[0].toUpperCase() + choice.slice(1);
      if (choice === current) b.classList.add('active');
      b.addEventListener('click', () => {
        try { localStorage.setItem(THEME_KEY, choice); } catch { /* private mode */ }
        applyTheme(choice);
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      });
      seg.appendChild(b);
    }
    appearance.append(ah, seg);

    const calendars = document.createElement('div');
    calendars.className = 'settings-section disabled';
    const ch = document.createElement('h3');
    ch.textContent = 'Linked calendars';
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = 'Coming in a future version';
    calendars.append(ch, note);

    panel.append(appearance, calendars);
    backdrop.appendChild(panel);
    host.appendChild(backdrop);
    document.body.style.overflow = 'hidden'; // no scrolling behind the modal (iOS)
    document.addEventListener('keydown', onKey);
  }

  button.addEventListener('click', () => { host.childElementCount ? close() : open(); });

  // The inline pre-paint script already applied a theme from its own copy of this
  // logic; re-apply through resolveTheme() so js/theme.js is the source of truth.
  applyTheme(getSetting());
}
