// viewport.js — keeps a fixed element inside the VISUAL viewport (the part
// of the page the user can actually see). Shared by the item sheet
// (js/itemsheet.js) and the capture box (js/capture.js); the Settings
// backdrop uses fillVisualViewport, below, instead. Moved here from
// itemsheet.js in home-screen stage 4 (spec § 3, § 8), unchanged in
// behaviour for the sheet.
//
// Why: on iOS Safari the keyboard does not resize the layout viewport, which
// is what `position: fixed`, `bottom: 0` and `dvh` measure against. It shrinks
// the visual viewport and scrolls it within the layout viewport instead. An
// element pinned to the layout viewport's bottom then sits behind the
// keyboard, and its top (the sheet's bar with Save and Cancel) is above the
// visible area, where no scroll inside it can bring it.
//
// The element is placed by its bottom edge: `top` is set to the visible
// area's bottom edge in layout-viewport px (offsetTop + height; offsetTop is
// the visual viewport's offset within the layout viewport, which is the fixed
// element's containing block) and the transform lifts it by its own height —
// 'translateY(-100%)' by default; the capture box passes one that also lifts
// it by a CSS variable. That needs neither the layout viewport's height nor a
// measurement of the element. max-height keeps its top edge inside the
// visible area too: `maxShare` of the visible height.
//
// No visualViewport: nothing is set and nothing listens; the stylesheet's own
// rules apply exactly as they did before this module existed.

// The inline properties placement writes, and stop() removes.
export const PLACED_PROPS = ['bottom', 'top', 'transform', 'max-height'];

// followVisualViewport(el, { maxShare, transform }) -> stop()
export function followVisualViewport(el, { maxShare, transform = 'translateY(-100%)' } = {}) {
  if (typeof maxShare !== 'number' || !(maxShare > 0 && maxShare <= 1)) {
    throw new Error(`followVisualViewport: maxShare must be a number in (0, 1], got ${maxShare}`);
  }
  const vv = globalThis.visualViewport;
  if (!vv) return () => {};
  const place = () => {
    el.style.setProperty('bottom', 'auto');
    el.style.setProperty('top', `${vv.offsetTop + vv.height}px`);
    el.style.setProperty('transform', transform);
    el.style.setProperty('max-height', `${Math.floor(vv.height * maxShare)}px`);
  };
  vv.addEventListener('resize', place);
  vv.addEventListener('scroll', place);
  place();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    vv.removeEventListener('resize', place);
    vv.removeEventListener('scroll', place);
    for (const prop of PLACED_PROPS) el.style.removeProperty(prop);
  };
}

// fillVisualViewport(el) -> stop()
//
// For a full-screen overlay that is its own scroll container (the Settings
// backdrop, js/settings.js), where followVisualViewport's bottom-anchored,
// content-sized placement does not fit: the overlay must keep covering the
// whole visible area however short its content is.
//
// Why: fixed at inset: 0 the overlay is the LAYOUT viewport's height. With the
// iOS keyboard up, its lower part — the end of its scroll range — sits behind
// the keyboard, so scrolling it to its end still leaves its last content out
// of sight (punchlist L139). While this runs, its box is the visible area:
// `top` is the visual viewport's offset within the layout viewport (the fixed
// element's containing block), `height` the visible height, and `bottom` is
// released so the stylesheet's inset does not stretch it back. The height
// includes the overlay's padding (styles.css sets border-box on everything).
//
// Same lifecycle as followVisualViewport: re-fitted on visualViewport resize
// and scroll; stop() removes both listeners and every inline property it
// set, at most once. No visualViewport: nothing is set and nothing listens.

// The inline properties fitting writes, and stop() removes.
export const FILLED_PROPS = ['bottom', 'top', 'height'];

export function fillVisualViewport(el) {
  const vv = globalThis.visualViewport;
  if (!vv) return () => {};
  const fit = () => {
    el.style.setProperty('bottom', 'auto');
    el.style.setProperty('top', `${vv.offsetTop}px`);
    el.style.setProperty('height', `${vv.height}px`);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    vv.removeEventListener('resize', fit);
    vv.removeEventListener('scroll', fit);
    for (const prop of FILLED_PROPS) el.style.removeProperty(prop);
  };
}
