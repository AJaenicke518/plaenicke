// input.js — request-body helpers shared by accounts.js and admin.js, so the
// email rule and the JSON reader exist once.
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const normEmail = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
export const validEmail = (email) => EMAIL_RE.test(email) && email.length <= 254;

// null for a missing or non-JSON body; callers turn that into their 400.
export async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}
