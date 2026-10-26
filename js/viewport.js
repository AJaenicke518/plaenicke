// viewport.js — keeps a fixed element inside the VISUAL viewport (the part
// of the page the user can actually see). Shared by the item sheet
// (js/itemsheet.js) and the capture box (js/capture.js); moved here from
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
