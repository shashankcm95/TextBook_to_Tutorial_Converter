# Documentation index

This directory holds long-form design docs and architectural notes for the
TB → Tutorial Converter. Short, runtime-relevant notes live inline in the
source they describe; this directory is for the meatier "why we built this,
what we considered, what's deferred" material that wouldn't fit a code
comment.

## Feature & architecture designs (`design/`)

Long-form specs for features and architectural decisions. Each is design-only
(no code in the same PR) so the design can be reviewed and pushed back on
before implementation lands.

- [`design/feature-b-voice-and-anchor-profile.md`](design/feature-b-voice-and-anchor-profile.md) — **Feature B'** (Voice + Anchor Fidelity Profile). Source-grounding fix that addresses the v3/v4/v5 prompt-iteration plateau: per-PDF voice fingerprint + anchor whitelist extracted at ingest, injected into the narrative prompt, validated post-generation. Status: awaiting review.

## Evaluation infrastructure (`eval/`)

Specs + reference material for the evaluation harness (the gate that
measures content fidelity and UX quality).

- [`eval/HARNESS-DESIGN.md`](eval/HARNESS-DESIGN.md) — 3-phase eval harness design: text-only A/B comparison (Phase 1), Chrome-MCP UAT walkthrough (Phase 2), UX-engineer surface review (Phase 3). Includes the simulated-author persona (Kleppmann) primed from public corpus. Status: design merged, awaiting implementation.

## Reading guide

If you're new to the codebase:

1. Start with the top-level [`README.md`](../README.md) for the bootstrap +
   architecture overview.
2. Skim the most recently-merged design doc here to see how decisions get
   recorded.
3. Look at the PRs referenced from each design doc to see the code that
   implements (or supersedes) the design.

If you're proposing a new feature:

1. Write the design as `docs/design/<feature-slug>.md` (lowercase, kebab-case).
2. Include: motivation, architecture overview, components, open decisions
   for maintainer review, risks + mitigations, out-of-scope items.
3. Open a docs-only PR. Iterate. Merge.
4. Implement in a follow-up PR that references this design.
