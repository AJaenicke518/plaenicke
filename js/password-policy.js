// Password policy (spec D10). A letter is \p{L}, a digit is \p{N}; a symbol is
// anything that is neither, so a space counts.
import { COMMON } from './common-passwords.js';

//
// Judged on the NFKC form (sweep W2), because that is what js/keys.js derives
// from: a fullwidth 'Ｐassword1！' is 'Password1!' to the KDF, so it is to the
// blocklist and the email check too. Length counts code points.
export function checkPassword(rawPassword, rawEmail) {
  const password = String(rawPassword).normalize('NFKC');
  const email = typeof rawEmail === 'string' ? rawEmail.normalize('NFKC') : rawEmail;
  const problems = [];
  if ([...password].length < 8) problems.push('At least 8 characters');
  if (!/\p{N}/u.test(password)) problems.push('At least one number');
  if (!/[^\p{L}\p{N}]/u.test(password)) problems.push('At least one symbol (like ! ? # or a space)');
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) problems.push('Too common — pick something less guessable');
  const local = typeof email === 'string' ? email.split('@')[0].toLowerCase() : '';
  if (local.length >= 3 && lower.includes(local)) problems.push("Don't use your email name in it");
  return { ok: problems.length === 0, problems };
}
