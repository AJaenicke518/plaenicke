// palette.js — the fixed 6-colour cycle calendars are auto-assigned from.
//
// Shared by settings.js (a calendar added here, and tap-to-cycle) and feeds.js
// (a calendar first seen through sync, in applyRemoteFeeds). It used to be
// copied into both, because settings.js imports from feeds.js and the reverse
// import would be a cycle; a module of its own has no cycle.
//
// Each entry is a CSS custom-property *reference* (not a raw hex) — stored
// verbatim in feed.color and set as the inline `--feed-color` custom property
// at every render site (app.js), so the displayed colour resolves through the
// token cascade and stays theme-correct without any module special-casing
// light/dark. The swatch values live in styles.css as --feed-palette-1..6.
export const FEED_PALETTE = [
  'var(--feed-palette-1)', 'var(--feed-palette-2)', 'var(--feed-palette-3)',
  'var(--feed-palette-4)', 'var(--feed-palette-5)', 'var(--feed-palette-6)',
];
