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
  const prev = current.get(host);
  if (prev) prev.dismiss();

  let settled = false;
  let timer = null;

  // Every exit path funnels through here, so the at-most-once guard lives in
  // exactly one place. That guard is also what keeps a stale handle from
  // wiping a newer toast: a toast is always settled BEFORE it is replaced
  // (above), so by the time another toast owns the host, this one's dismiss()
  // returns at the guard and never reaches the innerHTML line.
  const settle = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    current.delete(host);
    host.innerHTML = '';
    if (fn) fn();
  };

  const handle = { dismiss: () => settle(onExpire) };

  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
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
  return handle;
}
