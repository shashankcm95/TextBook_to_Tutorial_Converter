# Evaluation Harness — Design Doc (v0)

**Status:** design only, no code yet. Awaiting review.
**Author:** drafted in conversation with the maintainer 2026-05-24.
**Owner:** TBD.
**Related:** v3/v4/v5 prompt-iteration negative result (see "Motivation" below); Brainstorm 1 (Pagination) + Brainstorm 2 (Voice Profile) future features.

---

## Motivation — why this exists

Three prompt iterations (v3 → v4 → v5) on `src/lib/prompts/narrative-only.ts` failed to dislodge the same set of qualitative failures (closing-paragraph boilerplate, Ch5 self-contradiction, missing canonical anchors, Ch2 latency/response-time definition). Each iteration was driven by an ad-hoc 3-agent paired review whose findings were not directly comparable across iterations:

- The reviewers were spawned fresh each time with hand-crafted prompts.
- Their ratings were free-form prose, not a structured rubric.
- The cost of running them was the maintainer's attention (constructing prompts, synthesizing results, deciding next move).
- The conclusion ("prompt engineering has plateaued; the failure is source-grounding") emerged late, after three full regen+review cycles.

The eval substrate this doc proposes is the harness that would have surfaced that conclusion after the first iteration — a structured rubric, a stable persona registry (including the **author** as a fourth persona), and a repeatable pipeline. It also becomes the load-bearing measurement infrastructure for every future product decision (pagination, voice extraction, anchor-validation, etc.), so we stop relying on the maintainer's gut as the only comparison metric.

The harness has three independent phases, each shippable on its own. Phase 1 is text-only and small. Phases 2 and 3 add browser-driven UX validation and a UX-engineer surface review.

---

## Architecture overview

```
        ┌─────────────────────────────────────────────────────────────┐
        │  scripts/ab-compare.ts        (Phase 1 — text-only A/B)     │
        │   ── regen ch0-5 under each variant                          │
        │   ── dump narratives                                         │
        │   ── 4 personas read each variant, emit rubric ratings       │
        │   ── synth diff report                                       │
        └────────────────────┬────────────────────────────────────────┘
                             │   (Phase 1 output feeds the report)
                             ↓
        ┌─────────────────────────────────────────────────────────────┐
        │  scripts/ab-uat.ts            (Phase 2 — Chrome UAT)        │
        │   ── spin up pnpm dev (variant-aware)                       │
        │   ── for each persona × variant:                            │
        │        Chrome MCP walk: ingest → read → mark complete → next │
        │        screenshot + per-step rating                          │
        │   ── append UX section to the comparison report             │
        └────────────────────┬────────────────────────────────────────┘
                             │
                             ↓
        ┌─────────────────────────────────────────────────────────────┐
        │  scripts/ux-walkthrough.ts    (Phase 3 — UX engineer)       │
        │   ── variant-independent, runs once per merge to main       │
        │   ── single agent surveys entire app surface                │
        │   ── outputs prioritized UX findings                        │
        └─────────────────────────────────────────────────────────────┘
```

All three phases share the same persona registry, rubric schema, and run-directory layout. Phases 2 and 3 use the existing `mcp__Claude_in_Chrome__*` tool family (navigate, read_page, browser_batch, computer, screenshot).

---

## Phase 1 — Text-only A/B harness

### Scope

Given two named variants of the system (a "variant" = git ref + optional prompt-file override + optional feature flags), regenerate a fixture set of chapters under each, run 4 simulated personas against each variant's output, and emit a structured diff report.

### Variant model

A **variant** is a JSON manifest:

```jsonc
// _ab-runs/v3-vs-v4-vs-v5/variants/v3.json
{
  "name": "v3",
  "git_ref": "1e856db",                    // optional; if set, harness checks out a worktree
  "prompt_overrides": {                    // optional; takes precedence over git_ref
    "src/lib/prompts/narrative-only.ts": "_ab-runs/v3-vs-v4-vs-v5/prompts/v3.ts"
  },
  "env": {
    "OPENAI_MODEL": "gpt-4o"
  },
  "tutorial_id": "a4163650-0b44-4fe8-a0dc-952a1b3082dd",
  "chapter_range": [0, 5]
}
```

Three legal forms:
1. **Git-ref variant**: harness uses `git worktree add` to spin up a clean working copy at the ref, runs `scripts/regenerate-chapters.ts` from inside it.
2. **Prompt-override variant**: harness writes the override file(s) into the active checkout, regens, then restores.
3. **Hybrid**: ref + overrides (apply overrides on top of the ref).

The variant manifest is the **only** input the harness reads to describe what to compare. No magic strings, no command-line flag soup.

### Persona registry

Personas live under `docs/eval/personas/*.md` as front-matter + freeform body. Each persona is a self-contained agent prompt template with placeholders for `{narratives}`, `{rubric}`, `{variant_a_name}`, `{variant_b_name}`.

| Persona | File | Role |
|---|---|---|
| Professor | `personas/professor.md` | Pedagogical clarity, conceptual scaffolding, teach-ability |
| Self-taught engineer | `personas/student.md` | Retention, memorability, 6-month-recall test |
| Domain expert | `personas/domain-expert.md` | Technical fidelity, anchor preservation, terminology precision |
| **Author (Kleppmann)** | `personas/author-kleppmann.md` | "Would the reader be able to discuss this topic the way I framed it in my book?" |

The Kleppmann persona is primed with a curated public-corpus brief — see *§Author persona design* below. New books would require new author-persona files (`author-metz.md`, `author-knuth.md`, etc.) generated either manually or by a one-shot prompt against `<author-name> book corpus`.

### Rubric

Each persona produces a structured JSON rating per chapter per variant. The rubric is the same shape for every persona; the persona's lens biases their scoring.

```jsonc
{
  "variant": "v4",
  "chapter": 2,
  "ratings": {
    "content_fidelity": 7,        // 1-10: did concrete anchors / contrasts survive?
    "ux_clarity": null,           // 1-10: only filled in Phase 2 (browser UAT)
    "navigation_friction": null,  // 1-10: only Phase 2
    "voice_match": 4,             // 1-10: does this sound like the author or a Medium post?
    "learning_value": 6,          // 1-10: would I remember this in 6 months?
    "would_recommend": 5          // 1-10: would I send this to someone learning the topic?
  },
  "evidence": {
    "phrase_that_landed":   "the 4.6k tweets/sec × ~75 followers = 345k timeline writes/sec figure",
    "phrase_that_failed":   "'innovative solutions tailored to specific challenges' — corporate filler closer",
    "named_anchors_present": ["Chaos Monkey", "shared-nothing", "Twitter fanout"],
    "named_anchors_missing": ["head-of-line blocking", "t-digest", "HdrHistogram", "coordinated omission"]
  },
  "free_form_notes": "1-3 paragraphs of qualitative read."
}
```

The rubric is enforced as JSON Schema strict-mode against the persona agent's output. Free-form notes are bounded (≤ 300 words) so the diff report stays scannable.

### Output report

`_ab-runs/<run-id>/report.md` is the canonical deliverable. Structure:

```
# A/B Comparison Report — v3 vs v4 vs v5

## Summary table
| Persona × Variant   | Content fidelity | Voice match | Learning value | Would recommend |
|---------------------|------------------|-------------|----------------|-----------------|
| Professor × v3      | 6.2              | 4.0         | 5.8            | 5.5             |
| Professor × v4      | 6.8              | 4.2         | 6.0            | 5.7             |
| Professor × v5      | 6.5              | 4.5         | 6.0            | 5.8             |
| Student × v3        | ...              | ...         | ...            | ...             |
| ... (16 rows)        |                  |             |                |                 |

## Per-chapter breakdowns
[per-chapter table showing each persona's per-chapter ratings across variants]

## Convergent findings
[Anchors that all 4 personas flagged as missing, etc.]

## Divergent findings
[Where personas disagree — signal that the failure is segment-specific]

## Recommended next move
[A short LLM-synthesized 2-paragraph "what should we do next" based on the ratings]
```

The "convergent findings" section is the load-bearing one. When all 4 personas (or 3 of 4) independently flag the same failure mode, that is the signal that the issue is structural, not stylistic.

### File layout

```
docs/eval/
  HARNESS-DESIGN.md                # this file
  RUBRIC.md                        # human-readable rubric reference
  personas/
    professor.md
    student.md
    domain-expert.md
    author-kleppmann.md
    _template.md                   # for forging new author personas

scripts/
  ab-compare.ts                    # Phase 1 entrypoint
  ab-uat.ts                        # Phase 2 entrypoint
  ux-walkthrough.ts                # Phase 3 entrypoint
  _ab-lib/
    variant.ts                     # apply / revert variant manifests
    persona.ts                     # invoke a persona agent + parse rubric output
    report.ts                      # render the markdown comparison report

_ab-runs/<run-id>/                 # git-ignored
  config.json                      # the variants compared + run metadata
  variants/<variant>.json
  prompts/<variant>.ts             # optional prompt-override files
  narratives/<variant>/ch{0..5}.md
  ratings/<variant>/<persona>/ch{0..5}.json
  screenshots/<variant>/<persona>/<step-N>.png   # Phase 2 only
  report.md
```

### Sample run command

```bash
# Iterative-development run (default — cheap, fast)
pnpm tsx scripts/ab-compare.ts \
  --run-id v3-vs-v4-vs-v5 \
  --variants _ab-runs/v3-vs-v4-vs-v5/variants/{v3,v4,v5}.json \
  --personas professor,student,domain-expert,author-kleppmann \
  --tutorial a4163650-0b44-4fe8-a0dc-952a1b3082dd \
  --chapters 0-5

# Publishing run (pre-merge / pre-release — per D2, triplicate ratings)
pnpm tsx scripts/ab-compare.ts \
  --run-id pre-release-v0.2.0 \
  --variants docs/eval/runs/pre-release-v0.2.0/variants/{main,candidate}.json \
  --personas professor,student,domain-expert,author-kleppmann \
  --tutorial a4163650-0b44-4fe8-a0dc-952a1b3082dd \
  --chapters 0-5 \
  --rate-runs 3
```

This:
1. For each variant: applies the manifest, calls `generateChapter()` for ch0-5, dumps narratives.
2. For each persona × variant: spawns the persona agent with that variant's narratives + the rubric schema, parses the structured rating, saves.
3. Synthesizes `report.md` and prints the summary table to stdout.

Wall-clock estimate: ~5 min/variant for regen, ~30s/persona/variant for rating. For 3 variants × 4 personas = 18 minutes total.

Cost estimate: regen is ~$0.018/chapter × 6 × 3 variants ≈ $0.32. Rating calls are 4o-mini × short context ≈ $0.05 total. ~$0.37 per A/B run.

### Phase 1 explicit non-goals

- **No browser interaction.** Phase 1 reads narratives as markdown only; UX cannot be rated here.
- **No regen of fidelity scores** (those run automatically as part of `generateChapter`; the harness reads them from the DB but does not re-run the scorer).
- **No automated decision-making.** The "recommended next move" section is advisory; the maintainer still picks.

---

## Phase 2 — Chrome-MCP UAT walkthrough

### Scope

Each persona drives through the live web app using the `mcp__Claude_in_Chrome__*` tool family, rating UX clarity / navigation friction / voice match in CONTEXT (i.e., as a human would experience it), not just from narrative dumps. Adds the `ux_clarity` and `navigation_friction` rubric dimensions that Phase 1 leaves null.

### Pre-flight

- `pnpm dev` must be running on localhost:3000.
- A test tutorial must exist; the harness uses the same `tutorial_id` from the variant manifest.
- The session cookie is mocked (or a known test user is pre-seeded — see *§Session handling* below).
- `mcp__Claude_in_Chrome__list_connected_browsers` confirms an attached Chrome.

### Walkthrough script (per persona × variant)

Each persona's UAT is a fixed sequence of steps. The PERSONA controls the rating; the SCRIPT controls the navigation. We don't want personas inventing arbitrary clicks — that introduces variance unrelated to the system under test.

```
STEP 1: Land on home page
  - navigate to localhost:3000
  - read_page (filter=interactive)
  - screenshot
  - persona rates: first-impression clarity (1-10), is the value prop obvious (1-10)
  - free-form note: "what would a real user think this does in 5 seconds?"

STEP 2: Navigate to existing tutorial
  - navigate to localhost:3000/tutorials/<tutorial_id>
  - wait for first chapter to appear
  - screenshot
  - persona rates: page hierarchy, cost-chip placement, locked-chapter copy clarity

STEP 3: Read chapter 0 narrative
  - read_page (full text)
  - persona produces a Phase-1-shaped narrative rating (same rubric)

STEP 4: Engage with quiz
  - find quiz <details> element
  - click to expand
  - read questions + correct answers
  - persona rates: quiz quality + relevance to narrative

STEP 5: Mark Complete
  - click Mark Complete button
  - wait for status flip
  - screenshot the "✓ Chapter complete" state
  - persona rates: feedback latency, clarity of unlock signal

STEP 6: Advance to chapter 1 (per-chapter SSE rewire was DRIFT-019)
  - scroll to ch1 (now unlocked, streaming)
  - watch streaming progress indicator
  - wait for chapter-complete event
  - persona rates: streaming UX, perceived progress, did it feel responsive

STEP 7: Open flashcard reviewer
  - if cards due, click to grade one
  - persona rates: SRS flow clarity

STEP 8: Cost chip awareness
  - inspect the cost chip at top of page
  - persona rates: trust signal, would this make me cancel from cost-anxiety
```

Each step emits:
- A screenshot to `_ab-runs/<run-id>/screenshots/<variant>/<persona>/step-N.png`
- A JSON rating fragment appended to `_ab-runs/<run-id>/ratings/<variant>/<persona>/ux.json`

The harness uses `mcp__Claude_in_Chrome__browser_batch` to bundle each step's navigation+screenshot+read calls into one round-trip — cuts wall-clock by ~3×.

### Session handling

**Settled per D3:** `EVAL_HARNESS_BYPASS_AUTH=1` is the legal trigger.

Implementation:
1. `src/lib/session.ts:verifySession` checks `process.env.EVAL_HARNESS_BYPASS_AUTH === '1'` BEFORE the HMAC verification path. When set, returns `{ userId: 'eval-harness-user', expiresAt: Date.now() + 3600_000 }` without further checks.
2. `src/lib/env.ts` adds a boot-time assertion:
   ```ts
   if (process.env.NODE_ENV === 'production' && process.env.EVAL_HARNESS_BYPASS_AUTH === '1') {
     throw new Error(
       'EVAL_HARNESS_BYPASS_AUTH must not be set in production. ' +
       'This flag exists only for the local A/B harness. Refusing to boot.'
     );
   }
   ```
3. CI lint step: a grep against the production Docker image's runtime env layer fails the build if the flag appears.
4. The harness sets the flag in the per-variant `pnpm dev` spawn environment, never in a shell that could leak to other processes.

The session-bypass path also pre-seeds the `users` row for `eval-harness-user` if absent (so FK constraints don't fail). This row is harmless in dev DBs.

### Variant switching

Phase 2 needs to test two or more variants of the live UI, not just the prompt. Variants in Phase 2 can change:
- Code on disk (UI components, API routes, prompt files) — handled by `git worktree` per Phase-1 design + `pnpm dev --port <unique>` per worktree.
- Feature flags read from env — handled by spawning `pnpm dev` with the variant's `env` block.

For UI-only variants (Feature A pagination, Feature B' voice surface), each variant gets its own worktree + its own dev-server on its own port, and the harness sequences personas across them.

### Phase 2 explicit non-goals

- **No real ingest.** Phase 2 always uses a pre-seeded tutorial; we don't re-ingest the 25 MB DDIA PDF every run.
- **No accessibility audit.** That's Phase 3's job.
- **No mobile breakpoints.** Single desktop viewport; mobile is its own future phase.

---

## Phase 3 — UX engineer surface review

### Scope

Variant-independent. One agent, primed as a senior UX engineer, walks through the entire app surface and emits prioritized findings. Re-run after every merge to main (or pre-release) to catch UX regressions.

### Surfaces audited

- Home page + ingest form
- Tutorial page: header, cost chip, stream status badge, error banner
- Chapter rendering: narrative typography, citation marker rendering, locked-chapter card
- Per-chapter components: Mark Complete button, quiz <details>, flashcard <details>
- Completion tracker sidebar
- Flashcard reviewer (separate surface)
- Error states (protocol error, generation failure, locked chapter, expired session)
- Loading states (streaming indicator, ingest progress)

### Output format

```jsonc
{
  "severity": "high" | "medium" | "low",
  "category": "accessibility" | "copy" | "friction" | "hierarchy" | "feedback" | "mobile",
  "surface": "tutorial-page/cost-chip",
  "finding": "Cost chip color contrast is 3.2:1 against white background — fails WCAG AA (4.5:1 required for normal text).",
  "evidence_screenshot": "_ux-walks/<run-id>/cost-chip.png",
  "proposed_fix": "Bump foreground from #6b7280 to #4b5563 (contrast 7.0:1) OR add bg color #e5e7eb behind chip.",
  "estimated_loc": 1
}
```

### Sample run command

```bash
# Default — auto-open issues for high-severity findings only (per D5)
pnpm tsx scripts/ux-walkthrough.ts --run-id pre-v0.2.0

# Open issues for ALL severities
pnpm tsx scripts/ux-walkthrough.ts --run-id pre-v0.2.0 --issues=all

# Markdown-only (skip GitHub entirely)
pnpm tsx scripts/ux-walkthrough.ts --run-id pre-v0.2.0 --issues=none
```

Output: `_ux-walks/<run-id>/findings.md` (always) + JSON (always) + GitHub issues (per `--issues` policy). Before opening any issue, the harness queries existing open issues for the same `surface + category` key and appends a comment instead of duplicating. Issue labels: `ux-finding`, `auto-opened`, `severity-<level>`. Maintainer picks which findings to fix; harness has no auto-fix surface.

### Phase 3 explicit non-goals

- **No automated fixing.** UX-engineer agent suggests; humans decide.
- **No competitive benchmark.** We're not asking "is this better than Coursera?" — that's a different evaluation.

---

## Author persona design — Kleppmann

This is the **net-new persona** the maintainer asked for. The other three (professor, student, domain expert) were already used ad-hoc; the author is new.

### Public corpus the persona should be primed with

- *Designing Data-Intensive Applications* (O'Reilly, 2017) — the book under tutorial.
- "Distributed Systems for fun and profit" — Kleppmann's freely-available distributed-systems lecture series.
- His University of Cambridge / TU Munich research publications: CRDTs, local-first software, decentralized identity, end-to-end-encrypted collaboration.
- His blog at `martin.kleppmann.com` — short-form takes on the same topics; tone-matching reference.
- His Twitter `@martinkl` — strong opinions on cloud-vendor framing, microservices skepticism, eventual-consistency precision.
- Conference talks: Strange Loop "Conflict-Free Replicated Data Types", QCon "Stream Processing", Coda Hale's blog as a stylistic cousin (similar BUT-clause + dry-humor register).

### Signature features the persona should embody

When evaluating a tutorial chapter as Kleppmann, the persona judges:
1. **Tradeoff framing.** Every concept is introduced with the BUT-clause: "X gives you Y, but the price is Z." If the tutorial sells benefits without naming costs, the author would object.
2. **Named-incident anchoring.** Concepts are taught via specific incidents (leap-second bug, Knight Capital, Twitter fanout, GitHub MySQL failover, Cloudflare regex outage). If the tutorial replaces incidents with abstractions, the author would object.
3. **Precise terminology.** fault vs failure, latency vs response time, scaling up vs scaling out, CAP-consistency vs ACID-consistency, p99 vs p99.9. If the tutorial collapses these, the author objects strongly (these are pedagogical hills he's chosen to die on in the book).
4. **Forward-pointing close, no meta-summary.** Kleppmann's chapters end with "In the next chapter we'll examine X" or with a concrete fact, never with "In summary, X is essential."
5. **Cite the canonical paper or talk.** Out of the Tar Pit (Moseley & Marks), Dynamo (DeCandia et al.), Spanner (Corbett et al.), Brooks's No Silver Bullet. Generic descriptions without citations would draw an academic side-eye.

### The persona's judgment criterion

> "If a reader finishes this tutorial chapter and meets me at a conference, would they be able to discuss this topic the way I framed it in my book — *with my tradeoffs, my incidents, my precise terminology, my citations* — or would they have absorbed a generic LLM-blog summary?"

The persona rates each variant against this criterion and produces the standard rubric output.

### Constraint

The persona MUST NOT invent positions Kleppmann has not publicly held. If unsure, the persona explicitly says "I cannot judge this without re-reading my own book" rather than hallucinating an opinion. This is the load-bearing constraint that keeps the author persona honest.

---

## Cross-phase rubric reference

The 6 dimensions, scored 1-10. Used by all personas across all phases:

| Dim | Question the persona is answering | Phase that fills it |
|---|---|---|
| `content_fidelity` | Did the source's concrete anchors, terminology, named incidents survive into the tutorial? | 1, 2 |
| `ux_clarity` | Is the page hierarchy and copy clear at first glance? | 2 only |
| `navigation_friction` | How many clicks / how much cognitive load to get from "I want to learn X" to "I am learning X"? | 2 only |
| `voice_match` | Does this sound like the author or like generic LLM blog filler? | 1, 2 |
| `learning_value` | Would I (in persona) remember the load-bearing facts 6 months from now? | 1, 2 |
| `would_recommend` | Would I tell someone in my persona's segment to use this tool? | 1, 2 |

Plus mandatory `evidence` fields (specific quotes / anchor lists) and bounded `free_form_notes`. The harness validates the JSON schema strictly and fails the run if a persona response can't be parsed.

---

## Variant model — recap

The harness's only canonical input for "what to compare" is a variant manifest. Three legal sources of variation:

1. **Git ref**: `git worktree add` a clean checkout at the ref.
2. **Prompt-file overrides**: write override file(s) into the checkout pre-run, restore post-run.
3. **Env / feature flags**: passed through to `pnpm dev` and `regenerate-chapters.ts`.

Manifests live under `_ab-runs/<run-id>/variants/<variant>.json` and are committed to the repo if the run is referenced from a PR or design doc.

A "variant" is NOT just a prompt change. It can be:
- Different git refs (v3 vs v4)
- Different feature flags (`FEATURE_PAGINATION=on` vs off)
- Different model choices (`OPENAI_MODEL=gpt-4o` vs `gpt-4o-mini`)
- Different prompts (swap narrative-only.ts)
- Different scorer rules (DRIFT-029 — semantic-accuracy check vs lexical-only)

The unified manifest schema lets all these axes share one harness.

---

## Sequencing — what to build first

1. **Phase 1** is the foundation. It validates the rubric, the persona registry, the variant model, and the report renderer with text only. ~2-3 hours.
2. **Phase 2** depends on Phase 1's persona + rubric. ~1 day. Validates against the live web app; requires session-bypass plumbing.
3. **Phase 3** is independent of variant comparison. ~half day. Can be built before or after Phase 2.

Recommended order: **Phase 1 → Phase 3 → Phase 2**, because:
- Phase 1 unblocks all future iteration.
- Phase 3 is independent + valuable (catches UX regressions on every merge).
- Phase 2 is the highest-effort and depends on dev-server session-bypass plumbing.

---

## Risks + open questions

| # | Risk / question | Mitigation / notes |
|---|---|---|
| R1 | Persona agents drift over time (a future Claude model produces different ratings than today's) | Pin the model version in the persona prompt template. Re-baseline annually. |
| R2 | Rubric ratings have high variance from a single LLM run | Per D2: default `--rate-runs=1` for iteration speed; `--rate-runs=3` for publishing runs averages out variance and surfaces per-run spread in the report. |
| R3 | Author persona invents opinions Kleppmann hasn't held | Explicit constraint in persona prompt: "say 'I cannot judge' rather than guess." Audit author-persona output for invented quotes during Phase 1 build. |
| R4 | Phase 2 Chrome flakiness (dev server boot, async streaming, hydration races) | Adopt `mcp__Claude_in_Chrome__browser_batch` with explicit wait-for-selector helpers. Tolerate retries with bounded reconnect. |
| R5 | Session-bypass env flag accidentally enabled in production | Per D3: `EVAL_HARNESS_BYPASS_AUTH=1` is the only legal trigger; `src/lib/env.ts` asserts at boot that `NODE_ENV !== 'production'` when the flag is set and throws if violated. CI lint step greps the prod Docker image's runtime env for the flag as second-layer defense. |
| R6 | Cost overruns if A/B harness is run on full DDIA every iteration | Default `--chapters 0-5` (the established fixture). Run full DDIA only for pre-release validation. |
| R7 | Variant manifest schema drift | Validate the manifest against a JSON schema before the run starts. Fail fast on unknown keys. |

---

## Decisions (settled in review 2026-05-24)

- [x] **D1 — Persona registry: drop-in from day one.**
      Author personas live as standalone files under `docs/eval/personas/author-*.md`. Adding Sandi Metz, Knuth, etc. is a single-file drop. The harness reads `--personas <comma-list>` and resolves each name to its file. No code change to add a persona.
- [x] **D2 — Rating triplication only on publishing runs.**
      Default `--rate-runs=1` for iterative-development cycles (cheap, fast, single rating is enough to direct the next iteration). For pre-merge or pre-release runs, pass `--rate-runs=3` and the harness invokes each persona × variant × chapter three times and averages, exposing per-run variance in the report (so we can SEE if a persona was wildly inconsistent). Maintainer flips this flag explicitly when shipping.
- [x] **D3 — Session-bypass: `EVAL_HARNESS_BYPASS_AUTH=1`, asserted in `src/lib/env.ts`.**
      When set, `src/lib/session.ts:verifySession` returns a stable test-user payload `{ userId: 'eval-harness-user', expiresAt: Date.now() + 3600_000 }` without HMAC verification. Boot-time assertion in `src/lib/env.ts`: if `NODE_ENV === 'production'` AND `EVAL_HARNESS_BYPASS_AUTH === '1'`, throw at startup and refuse to boot. Belt-and-suspenders: a CI lint step greps the production Docker image's runtime env for the flag and fails the build if present. Implementation lands as part of Phase 2 plumbing, NOT Phase 1 (Phase 1 doesn't touch HTTP).
- [x] **D4 — Run artifacts gitignored.**
      Add `_ab-runs/` and `_ux-walks/` to `.gitignore`. `docs/eval/personas/`, `docs/eval/HARNESS-DESIGN.md`, `docs/eval/RUBRIC.md`, and the `scripts/ab-*.ts` entrypoints + `_ab-lib/` are committed. Variant manifests for "canonical" runs (the ones cited from PRs / design docs) can be checked in selectively under `docs/eval/runs/<run-id>/variants/*.json` without the heavy outputs.
- [x] **D5 — GitHub issues for Phase 3 findings, gated by severity.**
      `severity: high` → auto-open issue with labels `ux-finding`, `auto-opened`, `severity-high`. Body includes the finding, the screenshot link, the proposed fix, and the estimated LoC. Before opening, the harness checks for an existing open issue with the same `surface` + `category` key — if found, it appends a comment instead of opening a duplicate. `severity: medium` and `severity: low` go to markdown-only in `findings.md`. CLI override: `--issues=all|high|none` to force the policy.
- [x] **D6 — Include `chapter_fidelity_scores` in the comparison report.**
      Each variant's per-chapter row shows the automated scorer's 0-100 alongside each persona's rating. A separate "Scorer vs humans" subsection flags chapters where scorer ≥ 80 but ≥ 2 personas rate `content_fidelity ≤ 5` — that's the DRIFT-029 signal (lexical match without semantic preservation; the v5 Ch2 latency-inversion case).

---

## Out of scope (deferred)

- Real-user telemetry (PostHog / segment). The harness uses simulated personas; real users come later when the tool is in the hands of paying customers.
- Mobile / tablet breakpoints in Phase 2.
- A/B testing against live traffic (canary deploys, feature flags evaluated at user level). The harness is pre-production; live experimentation is a v2.0 concern.
- Persona registry beyond textbook tutoring (e.g., "marketing manager" persona for a non-technical book). Worth adding when we test on the second book.
- LLM-judge bias studies. We're using LLM agents to evaluate LLM output, which has known biases (e.g., agents prefer their own family). Acknowledge in the report; mitigate by mixing rating runs across model families when the rating cost is low (4o-mini today, maybe Claude-Haiku tomorrow).

---

## Summary in one paragraph

We build a harness that takes any two variants of the system (different prompts, different features, different models) and produces a structured comparison report: 4 simulated personas (including the author) rate each variant across 6 dimensions per chapter, the Chrome MCP drives each persona through the live app for UX ratings, and a separate UX-engineer agent surfaces design issues. The harness replaces the current ad-hoc 3-agent reviews with a repeatable substrate that catches the "prompt iteration has plateaued" signal in one run instead of three.

---

*End of design. Awaiting review.*
