// usage.js — per-account smart-add accounting (spec D19, § 6.8).
//
// The cap is enforced by ONE atomic upsert whose WHERE refuses the increment at
// the cap: no read-then-write, so parallel requests cannot overshoot. The slot
// is taken BEFORE the Claude call, so a failed call still consumes it
// (documented in D19).

export const SMART_ADD_DAILY_CAP = 50;

export function utcDay(iso) {
  return iso.slice(0, 10);
}

// 00:00Z of the day after `day` ('YYYY-MM-DD').
export function nextUtcMidnight(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString();
}

export async function takeSmartAddSlot(env, accountId, day) {
  const row = await env.DB.prepare(
    `INSERT INTO usage (account_id, day, calls) VALUES (?, ?, 1)
     ON CONFLICT (account_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?
     RETURNING calls`,
  ).bind(accountId, day, SMART_ADD_DAILY_CAP).first();
  return row ? { ok: true, calls: row.calls } : { ok: false };
}

export async function recordTokens(env, accountId, day, inTok, outTok) {
  await env.DB.prepare(
    'UPDATE usage SET in_tok = in_tok + ?, out_tok = out_tok + ? WHERE account_id = ? AND day = ?',
  ).bind(inTok, outTok, accountId, day).run();
}
