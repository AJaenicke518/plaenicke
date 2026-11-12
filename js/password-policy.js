// Password policy (spec D10). A letter is \p{L}, a digit is \p{N}; a symbol is
// anything that is neither, so a space counts.
import { COMMON } from './common-passwords.js';
import { COMMON_BASES } from './common-bases.js';

// The shortest base js/common-bases.js lists from the source list (its
// supplementary 'lmu' is the one shorter entry, by ruling R19).
export const MIN_BASE_LETTERS = 4;

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', '@': 'a', $: 's' };

// A password's BASE WORD (sweep W3, ruling R19 / SEC #3): what is left once
// the usual dressing is taken off. NFKC and lowercase; the leading and
// trailing runs of non-letters go whole ('Summer2024!' -> 'summer'); inside
// what is left, simple leetspeak is undone ('m0nk3y' -> 'monkey') and every
// other non-letter is dropped ('correct horse' -> 'correcthorse').
// scripts/gen-common-bases.mjs builds js/common-bases.js with THIS function,
// so the list and the check cannot disagree.
export function baseWord(raw) {
  const s = String(raw).normalize('NFKC').toLowerCase();
  const core = s.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
  let out = '';
  for (const ch of core) {
    if (/\p{L}/u.test(ch)) out += ch;
    else if (Object.prototype.hasOwnProperty.call(LEET, ch)) out += LEET[ch];
  }
  return out;
}

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
  // One "common" line, never two: an exact hit already says it.
  if (COMMON.has(lower)) problems.push('Too common — pick something less guessable');
  else if (COMMON_BASES.has(baseWord(password))) problems.push('Too close to a common password — add something unusual');
  const local = typeof email === 'string' ? email.split('@')[0].toLowerCase() : '';
  if (local.length >= 3 && lower.includes(local)) problems.push("Don't use your email name in it");
  return { ok: problems.length === 0, problems };
}
