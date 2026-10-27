// press.js — touch-down feedback for every tap (home-screen spec § 5).
//
// One delegated listener set on `root` (app.js passes `document`) adds
// `.pressed` to the nearest `button` or `[data-press]` element on pointerdown,
// and removes it on pointerup, pointercancel, pointerleave of that element, or
// a pointermove more than PRESS_MOVE_PX from where the press started (the
// finger is scrolling, not tapping). A class rather than `:active`, which can
// stick during an iOS scroll (WebKit 255277, 221366); styles.css styles it.
//
// Capture phase, so a handler that stops propagation cannot strand a press,
// and so pointerleave (which does not bubble) still reaches the root.
// Passive: never calls preventDefault (scrolling is governed by touch-action, not by pointer listeners).
// Only the pointer that started the press can end it.

export const PRESS_SELECTOR = 'button, [data-press]';
export const PRESS_MOVE_PX = 10;
export const PRESS_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave'];

// installPress(root) -> uninstall(): wires the listeners; the returned
// function removes them and clears any press in progress.
export function installPress(root) {
  let pressed = null;
  let pointerId = null;
  let startX = 0;
  let startY = 0;

  function clear() {
    if (pressed) pressed.classList.remove('pressed');
    pressed = null;
    pointerId = null;
  }

  const handlers = {
    pointerdown(e) {
      // A second finger, or a mouse button other than the main one, is not a tap.
      if (e.isPrimary === false || (typeof e.button === 'number' && e.button !== 0)) return;
      clear();
      const t = e.target && typeof e.target.closest === 'function' ? e.target.closest(PRESS_SELECTOR) : null;
      if (!t || t.disabled) return;
      pressed = t;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      t.classList.add('pressed');
    },
    pointermove(e) {
      if (!pressed || e.pointerId !== pointerId) return;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > PRESS_MOVE_PX) clear();
    },
    pointerup(e) { if (pressed && e.pointerId === pointerId) clear(); },
    pointercancel(e) { if (pressed && e.pointerId === pointerId) clear(); },
    // Leaving a child of the pressed element is not leaving it, and another
    // pointer leaving the pressed element is not this press ending.
    pointerleave(e) { if (pressed && e.pointerId === pointerId && e.target === pressed) clear(); },
  };

  const opts = { capture: true, passive: true };
  for (const type of PRESS_EVENTS) root.addEventListener(type, handlers[type], opts);
  return function uninstall() {
    for (const type of PRESS_EVENTS) root.removeEventListener(type, handlers[type], opts);
    clear();
  };
}
