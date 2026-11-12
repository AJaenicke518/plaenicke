// fragment.js — boot-time URL fragment intents (spec D24, § 6.1 step 1, § 6.3 step 1).
// A fragment never reaches a server, but it does reach browser history and
// referrers' neighbours, so once read it is stripped at once.

const INTENT = /^#(invite|recover)=(.*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// Returns {kind:'invite'|'recover', code} or null. Whenever the hash has the
// invite/recover form (even with an empty or malformed code) it is stripped
// via history.replaceState before returning; any other hash is left alone.
export function readBootIntent({ location, history }) {
  const m = INTENT.exec(location.hash || '');
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return BASE64URL.test(m[2]) ? { kind: m[1], code: m[2] } : null;
}
