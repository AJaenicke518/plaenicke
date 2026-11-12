// fragment.js — boot-time URL fragment intents (spec D24, § 6.1 step 1, § 6.3 step 1).
// A fragment never reaches a server, but it does reach browser history and
// referrers' neighbours, so once read it is stripped at once.

const INTENT = /^#(invite|recover)=(.*)$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// Returns {kind:'invite'|'recover', code}, {kind, code: null, malformed:
// true} for an empty or damaged code (sweep W3-I6: the form opens and says
// so, instead of a tapped link doing nothing), or null for any other hash.
// Whenever the hash has the invite/recover form it is stripped via
// history.replaceState before returning; any other hash is left alone.
export function readBootIntent({ location, history }) {
  const m = INTENT.exec(location.hash || '');
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return BASE64URL.test(m[2]) ? { kind: m[1], code: m[2] } : { kind: m[1], code: null, malformed: true };
}
