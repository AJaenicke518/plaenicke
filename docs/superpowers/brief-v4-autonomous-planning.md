# Brief — plaenicke V4 autonomous planning session (2026-07-28)

## Authorization (restated)

Alex is away ~1 hour and authorized autonomous mode: "fully plan out v4 … spend this
time brainstorming and logic building so when i come back v4 will be mostly ready to
go." Focus: **combining calendars** — "integrating google calender, apple calender,
outlook, and other events like that." Second ask: **brainstorm future additions**,
"quality of life features for an engineering student." Explicit constraint: ask no
questions; anything permission-gated gets noted and surfaced on return.

## Scope (in)

- Brainstorm → design doc → spec-quality design for V4 calendar integration.
- Implementation plan (`docs/superpowers/plans/2026-07-28-plaenicke-v4.md`) at the
  same rigor as V3 (task decomposition, interfaces, TDD steps).
- DA plan review (devil-advocate-reviewer agent) + adjudication + fixes.
- Future-features backlog for engineering-student QoL, ranked, in the design doc.
- Punchlist flags for anything requiring Alex's permission, credentials, or device.

## Scope (out)

- **No implementation.** "Brainstorming and logic building" reads as planning, and the
  brainstorming skill gates implementation on user design approval. V4 execution starts
  after Alex reviews the spec/plan. (Assumption A1 below.)
- No deploys, no push to `main` (pushing `main` publishes the live app via Pages).
- No spending: no new cloud accounts, no API-credit-consuming calls.

## Explicit assumptions (in place of the clarifying questions Alex opted out of)

- **A1 — "mostly ready to go" = planning artifacts complete**, not code written.
  Evidence: "spend this time brainstorming and logic building." If Alex meant "code it,"
  the reviewed plan makes that a fast follow — cheap to be wrong.
- **A2 — Read-only aggregation is the V4 target.** "Combining my calendars" = see
  external events inside plaenicke, not write plaenicke items back into Google/Apple/
  Outlook. Two-way sync goes to the backlog with its cost spelled out.
- **A3 — No new user-managed infrastructure.** Prefer designs that work with the
  existing GitHub Pages + single Worker + localStorage architecture and require no
  Google Cloud / Azure app registrations from Alex. OAuth designs are documented as the
  alternative, not the recommendation.
- **A4 — "other events like that" includes the university side** — Canvas/LMS calendar
  feeds count as a calendar source and fit the engineering-student framing.
- **A5 — iPhone-first**, matching V1–V3 (PWA on an iPhone home screen). This is a
  *technical constraint*, not just layout (DA review): it fixes (1) iOS Safari's
  ~5 MB per-origin localStorage ceiling as the cache budget, (2) no background
  execution — "sync" can only mean fetch-on-open, and (3) Safari's `Intl` as the
  only timezone engine the ICS conversion has to satisfy.

## Risk surface

- Wrong reading of "mostly ready to go" (A1) — mitigated by reversible delivery: docs
  on a branch, nothing deployed.
- Design could over-assume ICS feed availability per provider — mitigated by verifying
  each provider's export path via web research before the spec hardens.
- DA review is same-model review, not independent human review — acknowledged limit of
  autonomous mode.

## Delivery form

All artifacts committed on branch `v4-planning` (not `main`, not pushed). Punchlist
gets `[AUTONOMOUS-BLOCKED]` entries; final response summarizes for Alex's return.

## Self-review verdict

Scope matches the authorization; the one consequential ambiguity (plan vs. build) is
named as A1 with a reversible default. No gate is skipped: DA-on-plan runs; if it
cannot return, artifacts get stamped `DRAFT — UNREVIEWED`. **Proceed.**
