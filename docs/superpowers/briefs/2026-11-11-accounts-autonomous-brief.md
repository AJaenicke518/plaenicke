# Brief — accounts + logins, autonomous run (2026-11-11)

## Authorization (Alex, verbatim)

> "is it ready to start prototyping and building. if so go on automode and an autonomous session with devils advocate and construcive sparring. if not ready then do that when you are ready"

Restated: design the accounts + logins feature to a written spec, review it adversarially (devil's advocate agent + constructive sparring), plan it, and build it test-first with independent per-task review — autonomously, without stopping to ask.

## Delivery target (committed assumption)

No target was named, so the reversible form applies:

- All work lands on local branch **`accounts`** (worktree `.claude/worktrees/accounts`). **Not merged to `main`** — merging to main IS the production deploy (GitHub Pages).
- **No Worker deploy, no D1 migration against production, no push.** Those are listed as Alex-run release steps in the spec.
- No money spent (no domain purchase, no paid plan).

## Decisions Alex made in conversation (binding)

- Email + password login. Key derived on device; server can never read data.
- Password: ≥ 8 chars, ≥ 1 number, ≥ 1 special character, common passwords blocked.
- Lockout after 50 failed attempts — Claude proposed it be temporary (1 h); Alex said "yeah sure" to the batch.
- Minimal admin view (option A): mint invites, list accounts, disable/delete — Worker endpoints called by Alex, no in-app admin screen.
- Sessions never expire (Claude added: device list + "sign out other devices"; Alex did not object).
- Invite-code-only sign-up. Per-person daily smart-add cap. `/feed` and smart add require an account.
- Existing link-code account must upgrade safely.
- Out of scope here: notifications, desktop layout, themes (own specs later).

## Decisions Claude makes under this authorization (recorded, reversible)

1. **Recovery code is delivered by the device, not the server**: a `mailto:` draft to the user's own address + copy button. Reason: server-sent email needs Workers Paid ($5/mo) or a domain + third-party sender, and the Worker would see the code — contradicting "server can never read data". Alex's accepted trade-off (inbox control = reset ability) is preserved.
2. **Smart-add cap = 50/day per account, UTC day**, plus a per-account usage counter so the cap can be resized from real data.
3. **Local credential format is unchanged** (`base64url(token || dataKey)` in `plaenicke.auth`) so sync, adoption, and their invariants are untouched.
4. Other technical choices are made in the spec with a one-line rationale each.

## Structurally Alex's (not decided here)

- **Custom domain (~$10/yr, real money).** Required before testers sign up (shared `ajaenicke518.github.io` localStorage). Routed to punchlist `[AUTONOMOUS-BLOCKED]`.
- Running the production migration, setting Worker secrets, deploying, merging to main.

## Sequence

brief → spec → DA on spec (worktree) + constructive sparring → adjudicate → plan → DA on plan → adjudicate → subagent-driven TDD build on `accounts` → review sweep → handoff.
