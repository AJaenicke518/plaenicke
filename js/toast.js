// toast.js — a transient "Deleted. Undo" style notice.
//
// Presentation only: no storage, no app state. The caller decides what Undo
// and expiry MEAN (for a delete, onExpire is where the deletion is committed
// and undo is where it is abandoned), which is why the one guarantee this
// module owns is that the two are mutually exclusive: onExpire and undo
// together run AT MOST ONCE. Running both would commit a deletion and then
// resurrect it; running onExpire twice would commit it twice.

// The current toast per host. A second toast in the same host must settle the
// first one BEFORE replacing it — otherwise the first toast's onExpire would
// either never run (its pending commit silently lost) or run later against a
// host that now shows something else. WeakMap so a host that leaves the DOM
// takes its entry with it.
const current = new WeakMap();

export function showToast(host, text, { undo = null, ms = 5000, onExpire = null } = {}) {
  // Settle whatever owns the host, AND anything a settling callback itself
  // showed (a callback that calls showToast re-populates `current` mid-settle).
  // Left alone, that toast would be orphaned with a live timer and an Undo the
  // user can no longer see. A throw from a callback must not stop THIS toast
  // from rendering — a caller that already hid an item is relying on it — so
  // it is held and rethrown once the new toast is in place: loud, not lost.
  let pendingError = null;
  try {
    let owner = current.get(host);
    while (owner) {
      owner.dismiss();
      // A settle must leave the host unowned or owned by something NEW. If the
      // same handle is still registered, stop rather than spin forever.
      if (current.get(host) === owner) current.delete(host);
      owner = current.get(host);
    }
  } catch (err) {
    pendingError = err;
    current.delete(host);
  }

  let settled = false;
  let timer = null;

  // Every exit path funnels through here, so the at-most-once guard lives in
  // exactly one place. The host is cleared ONLY if this toast still owns it:
  // a toast orphaned by a throw above, or displaced mid-settle, must never
  // wipe the toast that replaced it. Cleanup runs BEFORE the callback so a
  // callback may show a new toast (e.g. Undo re-running an edit).
  const settle = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (current.get(host) === handle) {
      current.delete(host);
      host.innerHTML = '';
    }
    if (fn) fn();
  };

  const handle = { dismiss: () => settle(onExpire) };

  const el = document.createElement('div');
  el.className = 'toast';
  // No role here: #toast-host in index.html is the persistent live region.
  // A live region inserted already filled is often not announced.
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);

  if (undo) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo';
    btn.textContent = 'Undo';
    btn.addEventListener('click', () => settle(undo));
    el.appendChild(btn);
  }

  host.innerHTML = '';
  host.appendChild(el);
  current.set(host, handle);
  timer = setTimeout(handle.dismiss, ms);
  if (pendingError) throw pendingError;
  return handle;
}
