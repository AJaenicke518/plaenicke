# Autonomous brief — 2026-10-20, Alex away ~1.5 h

**Authorization (his words):** "i am about to be gone for the next hour and a half so get as much work as you can."

**What it covers, concretely:** reversible work only. Branches, not main. No release (merge to main = production deploy), no Worker deploy, no metered spend (smart-add calls cost Anthropic credits), no deleting the voice-test page (he may still have its home-screen icon). Nothing was named, so nothing outward-facing is authorized.

## Track A — home-screen design (architectural brainstorm, mid-flight)

The brainstorming gate says a written spec needs his conversational design approval first, and spec approval is his. I cannot approve on his behalf. So: write a **design proposal** doc that carries every decision he has made and presents the remaining sections as recommendations he approves/edits on return. Status line: PROPOSAL, not approved. DA-review it (fresh context, worktree).

Decisions he has made (record verbatim in the doc):
- Layout A: stacked sections (Overdue → To do today → Today's events → Next 7 days).
- Repeating events appear only on their own day; later days list one-off items only.
- Big mic button bottom-right. Tap = start listening, a text box grows out of the button, live words appear; tap again = stop and add. Tap the text box = type instead (listening stops). No double-tap.
- Tabs: Today | Calendar | To-do | Ideas; Settings is a gear on Today. Calendar tab has a Day / 3-day / Week / Month switcher.
- Calm, uncluttered; refine through use (ship small, iterate).
- Earlier: visibility controls (Settings hides a whole calendar; event sheet has per-series "show on calendar" / "show in events list"; per-device). 3-day view; tapping a day opens it.

Voice spike result (home-screen app, iPhone): continuous + live words work (modes 3, 4); Safari tab refuses everything (`service-not-allowed`); mode 4: endedOnItsOwn=false, **textAfterStop=null** → no final result is delivered after tapping stop (onend may not even fire). Committed design consequence: on the stop tap, commit the text currently shown (final + interim) immediately and call stop(); never wait for a final event.

Committed assumptions for the open sections (marked "Claude's call — confirm" in the doc): exact section caps, Next-7-days horizon, tick behaviour, motion vocabulary, press states, render-only-the-visible-view, empty states, build order. These are taste or derivable; I'll pick from the research and he edits.

## Track B — small punchlist technical items (branch `punchlist-fixes-3`, not released)

Only items that are in reach without a decision of his, money, or a device:
1. Smart add has no timeout → fetchWithTimeout, abort → existing 'unreachable' path.
2. applySyncedState sets in-memory items before saveItems → a quota failure leaves memory ahead of storage. Make it match addItems (assign only after the save succeeds). HIGH-risk file: TDD + mutation + fresh reviewer.
3. `npm run smoke:worker` script that checks the deployed Worker with a fixed phrase set and a ~20 s propagation retry. **Write it, do not run it** (each run spends credits — not authorized). Record as [AUTONOMOUS-BLOCKED] to run.

Out of scope for this run: anything needing Alex (iPhone checks, Cloudflare dashboard, password manager, Google), the 3-day view / visibility build (design not approved), any release.

**Process:** plan doc → commit → DA on plan (worktree) → adjudicate → subagent-driven execution, fresh reviewer per task → end-of-branch review-sweep if time allows. Handoff note at the end.
