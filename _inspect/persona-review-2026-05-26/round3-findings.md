# Round-3 Eval-Harness Findings — 2026-05-27

**Repo HEAD**: `main @ 71f333f` (post PR-#46 Sprint J merge)
**Tutorial**: DDIA (`048a2797-81f6-4d05-b05a-53665b77ffa9`)
**Chapters re-regenerated**: ord 20 / 34 / 36 / 40 / 56
**Cost**: $0.156 OpenAI (5 chapters × ~$0.03 each — half the $0.30 budgeted)
**Personas this round**: Sandra (CS prof) + Anya (Distributed-Systems SME) + Theo (LLM-eval skeptic) — the three whose first-walkthrough findings had the most actionable Tier 1 prompt-edits to validate.

---

## Headline

**3 of 4 Tier 1 fixes empirically validated; 1 mixed; 2 deployment gaps blocking full validation.** Verdicts shifted UP for Sandra + Anya (Anya: CRITICAL × 3 → all FIXED/PARTIAL); Theo held INTERNAL W/ GUARDRAILS with stronger evidence + a concrete promotion path. Diagram emission rate **doubled** (2/5 → 5/5); but signal-to-noise gained ~40% (Sandra's quality-weighted estimate is 2.5/5 → 3.5/5 — gates can REMOVE bad emissions but not yet ADD the right replacement).

### Verdict shifts (3 personas)

| Persona | Re-walk → Round-3 |
|---|---|
| Sandra (CS prof) | CONDITIONAL → **CONDITIONAL** (closer to ASSIGN-WITH-ERRATA; would assign ch20+34+40+36 with short erratum, hold ch56) |
| Anya (Distributed-Systems SME) | CRITICAL × 3 → **MOSTLY ACCURATE WITH ISSUES** (3 prior CRITICALs all closed; 5 new HIGHs) |
| Theo (LLM-eval skeptic) | INTERNAL W/ GUARDRAILS → **INTERNAL W/ GUARDRAILS** (held; Q3 v3 prediction held empirically) |

---

## Tier 1 fix scorecard — empirical outcomes

| Fix | PR | Empirical outcome | Evidence |
|---|---|---|---|
| **#1 — CT axis-aware gate** | #42 | ✅ **SUCCESS on ch20**; ⚠️ **gate violation on ch56** | ch20 emits B-Trees-vs-LSM-Trees 2×4 (the first-walkthrough's 5/6-personas-loved exemplar restored). ch56 emits a 2×2 that should have been rejected — 2 options × 2 columns where one column is the row identifier. Gate needs an additional "description-column heuristic." |
| **#2 — DefinitionList re-quotability** | #42 | ✅ **CLEAR SUCCESS** | ch40 DefinitionList went from CRDT/OT lumped + "convergent" conflated with LWW → 4 specific techniques (LWW, Replica Priority, Value Merging, Custom Logic), each with clear definitions + data-loss tradeoffs called out. Anya's CRITICAL × 2 closed. |
| **#3 — sync-replication BUT-CLAUSE strengthening** | #42 | ✅ **SUCCESS** (different placement than baseline) | ch34 Lesson 4 ("Balancing Synchronous and Asynchronous Replication") preserves the "one follower sync + rest async" hybrid caveat correctly. The bundle's pre-persona "MIXED" was over-cautious — Sandra + Anya both confirm Lesson 4 contains the right framing. Sandra suggests one transitional sentence at the end of Lesson 2 to bridge skimmers. |
| **#4 — Q3 v3 adj-pair gate** | #43 | ✅ **gate works**; 🔴 **production data is alarming**; ⚠️ **persistence broken** | Theo's CRITICAL re-walk prediction held empirically: 51 adjacent pairs across 5 chapters, **30 violations (59%)**, ch56 at **0.880 penalty (every pair violates)**. Migration 0007 not applied locally — metrics compute but don't persist. |

### New domain-SME findings (Anya HIGH)

1. **ch34 DecisionTree "Use Hybrid Approach" leaf is editorial** — "Hybrid Approach" is not a named DDIA term (it's "semi-synchronous"). Also: 2 internal nodes < 3-node Q2 DT gate threshold; the gate either isn't firing or counts root in the threshold. **Logic also wrong on the right branch**: "Can temporary inconsistencies be tolerated? → no → Use Hybrid Approach" — if you can't tolerate inconsistencies, fully sync (or consensus), not hybrid.
2. **ch36 lost the failover diagram + didn't gain SequenceDiagram** — prose is competent (timeout detection, election, redirection, async write-loss, GitHub MySQL incident, consensus deferral all correct). But Marcus's first-walkthrough prediction (the chapter wants a SequenceDiagram with split-brain visible) is still unfulfilled. Gates suppress bad emissions; they don't nudge toward the right primitive.
3. **ch56 ComparisonTable omits Repeatable Read + misframes Read Committed** — title "Transaction Isolation Levels" overclaims (only 2 levels shown), Read Committed cell omits dirty-write prevention (which DDIA p.234-236 explicitly splits), Repeatable Read entirely absent (a major chapter-level omission given DDIA's "ambiguous as mud" point).
4. **ch20 CT cells paraphrase named DDIA terminology away** — should use "write amplification" (the named term DDIA teaches) instead of "Requires multiple writes." Same for "read amplification" vs "Less efficient due to compaction." Prompt should constrain cells to use the chapter's vocabulary.
5. **ch34 ComparisonTable (Replication Modes) reinforces a binary the same chapter dismantles** — treats sync/async as the only modes; doesn't include "Semi-synchronous (one sync follower + rest async)" as a 3rd row, even though Lesson 4 spends a paragraph on it.

### New eval-skeptic findings (Theo)

1. **ch56 100% adjacent-pair violation rate is REAL signal, not noise** — Theo audited all 11 pairs manually. **0 legitimate "2 paragraphs really support this"** cases. 9/11 are laundered ranges (e.g., `[page260:paragraph19][page263:paragraph0]` spans 20+ paragraphs across 3 pages; 4/11 are cross-page hallucinated spans.
2. **Threshold recommendation: hard-reject at `penaltyScore ≥ 0.50`** — distribution from the 5-chapter sample (0.250 / 0.421 / 0.435 / **0.533** / 0.880) shows a natural break at 0.50. ch40 + ch56 would retry; ch20/34/36 would warn-but-pass. Single retry at ~$0.03/chapter is cheap relative to a wrong-anchor lie shipping.
3. **Adjacent-pair gate is one shape**; **6 other measurable failure modes** the eval harness should add: (1) single-ref over-reach; (2) spaced-out spray (every 30 words instead of adjacent); (3) search-term anchor drop; (4) editorial-freelance leaf-text in diagrams; (5) cross-page pair-of-pairs; (6) quote-laundering. Items 1, 3, 4 are highest-priority adds.

### Deployment gaps (BOTH discovered during regen)

1. **Migration 0007 not applied locally** — PR #43 shipped the migration but no `pnpm db:migrate` ran. All 5 regens logged `table chapter_fidelity_scores has no column named adjacent_pair_count`. Gate runs + computes; persistence fails open. Sandra-MED, Theo-MED (trending HIGH if persists).
2. **Sprint J glossary load IAM-blocked** — `s3:ListBucket` permission missing on `tb_to_tutorial_test` IAM user. All 5 regens logged `not authorized to perform: s3:ListBucket on resource: arn:aws:s3:::textbooks-...`. PR #46's value-add (definition injection into narrative prompts) was **silently bypassed for this entire run**. The fail-open path worked correctly (regen continued without glossary), but Sprint J's empirical signal is **incomplete**.

Both gaps are the same pattern: feature shipped, ops step missed, system fails open and looks fine. Recommended response per Theo: **startup health-check that fails-loud on migration/permission mismatch**, AND a "PR shipped → migration ran? → empirical run recorded?" checklist in the PR template.

---

## Emission rate deep-dive

| Chapter | Baseline | Post-PR-46 | Diff |
|---|---|---|---|
| ch20 | 0 | 1 (ComparisonTable 2×4) | **+1 — gain** |
| ch34 | 0 | 2 (DecisionTree + ComparisonTable) | **+2 — but DT has issues** |
| ch36 | 1 (DiagramFlow) | 0 | **−1 — REGRESSION** |
| ch40 | 1 (DefinitionList) | 1 (DefinitionList — content fixed) | **0 net, quality up** |
| ch56 | 0 | 1 (ComparisonTable 2×2 — gate violation) | **+1 — but filler** |

Raw: 2/5 → 5/5 (100% emission rate).
Quality-weighted (Sandra's read): ~2.5/5 → ~3.5/5 (40% improvement).

**Pattern Sandra named**: "First-walkthrough complaint was *too few diagrams on chapters that need them*. Round-3 complaint is *diagrams emitting on chapters that don't need them, while chapters that need richer primitives (SequenceDiagram, state tables) get the wrong primitive or filler*. That's a different failure mode — better, but still a failure mode."

---

## Cross-persona consensus

### What everyone agrees works
1. **ch20 ComparisonTable axis-aware restoration** — the headline Tier-1 win. The chapter literally titled "Comparing X and Y" now has its comparison artifact.
2. **ch40 DefinitionList re-quotability** — Anya's CRITICAL × 2 cleanly closed. Pedagogically clean for an undergrad reading the chapter.
3. **Q3 v3 detection works** — gate fires correctly, computes meaningful penalty scores, identifies the laundering pattern Theo predicted.
4. **BUG-1 + ch34 freelance DT suppression + cost-chip thresholds** (from PR #39/40/41) all confirmed stable in this run.

### What everyone agrees is still broken
1. **ch34 DecisionTree** — editorial "Hybrid Approach" leaf (Anya), 2 internal nodes (Sandra notes below Q2 threshold), wrong logic on the right branch (Anya), prescriptive "Use X" leaves violating Q2 rule (Sandra).
2. **ch36 needs the right diagram** (SequenceDiagram with split-brain visible, per Marcus's first-walkthrough prediction) — gate removed the wrong one; nothing nudges toward the right one.
3. **ch56 over-emission + 0.880 citation penalty** — worst chapter on two axes; gate violation AND citation-spray ceiling.
4. **Migration 0007 not applied + Sprint J IAM blocked** — two of four Tier 1 fixes weren't end-to-end validated this run. Re-run required after deployment-gap closure.

---

## Recommended next-step priority queue (post-Round-3)

### 🔴 Tier 1 — must fix before any further empirical runs

1. **Apply migration 0007**: `pnpm db:migrate` (or equivalent — verify path). Prereq for Q3 v3 telemetry.
2. **Grant `s3:ListBucket` to `tb_to_tutorial_test` IAM user**. Prereq for Sprint J empirical signal.
3. **Re-run Round-3 regen** ($0.15) after #1 + #2 to capture clean data for both pending features.

### 🟠 Tier 2 — would meaningfully improve next regen

4. **Promote Q3 v3 from soft to hard at `penaltyScore ≥ 0.50`** (per Theo). Single-retry at ~$0.03/chapter with a stronger prompt addendum: *"Each ref must be within gap=2 of its neighbor — no exceptions."*
5. **CT density gate add column-count heuristic** — reject 2×2 where one column is the row identifier (ch56 case).
6. **Q2 DT gate fix** — verify the ≥3-internal-node threshold is actually firing (ch34 emitted with 2 internal nodes). Also add leaf-text re-quotability: leaves must not introduce non-source terms ("Hybrid Approach" not in DDIA prose).
7. **Add positive prompt rule for SequenceDiagram on multi-actor protocols** — ch36 lost a diagram because gates ruled out the wrong shape but nothing pulled toward the right one. *"If the source paragraphs describe multi-actor message-passing protocol, prefer SequenceDiagram over DiagramFlow."*
8. **DDIA-terminology constraint on cell content** (Anya HIGH-4) — cells must use the chapter's named terms (write amplification, read amplification, dirty write, repeatable read) where applicable.

### 🟡 Tier 3 — structural / longer-term

9. **Single-ref over-reach detector** (Theo's highest-priority new measurable failure mode).
10. **Editorial-freelance leaf-text validator** for DT/StateTransition primitives — verify leaf labels appear in cited source paragraphs verbatim or by lemma.
11. **Anchor-coverage failure investigation** — `Isolation`, `Failure`, `Snapshot Isolation`, `BASE` × 2, `Response` all dropped during regen. Likely Sprint J side-effect (S3 IAM blocked the glossary load entirely); re-run after IAM fix to disambiguate.
12. **Quote-laundering detector** — high-cosine sliding-window between narrative sentences and cited paragraphs (>0.85 cos → flag as un-quoted lift).
13. **N ≥ 20 chapter × 3 textbook validation pass** (per Theo's external-OK requirements). DDIA + CTCI + 1 third book.

---

## SI candidates surfaced this round

- **SI-deployment-gap-checklist-001** — *Schema-additive migrations + IAM-permission updates shipped in PRs need a post-merge ops checklist. Round-3 caught 2 simultaneous instances (Migration 0007 from PR #43; S3 `s3:ListBucket` for Sprint J PR #46) where the system failed open and looked fine, but the metric the PR was supposed to enable was silently bypassed.* Pattern: "PR shipped → migration ran? → IAM updated? → empirical run logged?" template line.
- **SI-soft-metric-promotion-cadence-001** — *Q3 v3 was shipped as soft-metric "observability first" with the plan to promote to hard after data. The promotion criteria need to be concrete (Theo's 0.50 threshold derived from a 5-chapter natural-break analysis) and committed at PR time, not deferred indefinitely. Otherwise the gate becomes permanent observability and the actual quality issue ships indefinitely.*
- **SI-emission-vs-quality-decoupling-001** — *Emission rate is a coarse metric; gate work can double the count while signal-to-noise improves only ~40% (Sandra's read). Personas catch the quality side; automated metrics catch the quantity side. Both need to be tracked separately — declaring "100% emission" as a win is the wrong frame.*

---

## Files referenced

- `/tmp/round3-2026-05-27/round3-artifact-bundle.md` — the bundle the personas read
- `/tmp/round3-2026-05-27/ch{20,34,36,40,56}-baseline.md` + `-postpr46.md` — pre/post narrative pairs
- `_inspect/persona-review-2026-05-26/rewalk-findings.md` — prior re-walk verdicts (the baseline for the verdict shifts)
- `src/lib/citations/adjacent-pair-gate.ts` — the Theo-recommended validator now in production
- `src/lib/prompts/extract-diagrams.ts` lines 79-107 — axis-aware CT gate + DefinitionList re-quotability rule
- `src/lib/prompts/narrative-only.ts:95` — strengthened BUT-CLAUSE rule + practical-deployment-caveat note

---

## Honesty notes

- **Sample = 5 DDIA chapters out of ~60.** Selected because they had pre-PR-42 baselines from the re-walk, NOT random. Biased toward "chapters most likely to show the fixes working" — assignment-grade quality on the full fleet is not guaranteed.
- **Migration 0007 + S3 IAM not applied** means two of four Tier 1 fixes weren't end-to-end validated. The verdicts above ASSUME those fixes would have worked as designed when deployed — that's an assumption, not an observation.
- **Single-sample regen** for ch36 DiagramFlow loss — could be LLM variance, not a deterministic gate effect. Worth one re-roll to confirm.
- **Persona output is qualitative** — Sandra/Anya/Theo voices are simulated via spawned Claude sub-agents reading the same artifact bundle. They don't have independent OpenAI personas + the harness's structured persona scoring was bypassed (would have added ~$1-3 to the cost; the savings went to a deeper qualitative read).
- **Cost transparency**: $0.156 OpenAI for 5 chapter regens + ~3 agent spawns (no incremental OpenAI). Under the $0.30 budget; well under the $3-8 original budget for Item 4.
- **Round-3 deferred** until deployment gaps close: a re-run with PR #43 migration applied + PR #46 glossary path live would meaningfully sharpen the verdict on the two features whose empirical signal is currently incomplete.

---

## Deployment-gap closure addendum — 2026-05-27 (post-Round-3)

**Branch**: `fix/sprint-j-glossary-key-shape` (open) — one bug-fix + one regression test + two one-off ops scripts.
**Cost**: ~$0.157 OpenAI (5 chapter re-regens + 1 glossary backfill call).
**Trigger**: re-walk of the two deployment gaps surfaced above, plus a third gap discovered mid-closure.

### What changed since the original Round-3 entry

| Gap | Original state | Closure action | Verified outcome |
|---|---|---|---|
| **#1 Migration 0007** | Pending locally; `[per-chapter] fidelity scoring failed … no column named adjacent_pair_count` on every regen | `pnpm db:migrate` applied 0007; `PRAGMA table_info` confirms cols 17/18 present | 5/5 latest `chapter_fidelity_scores` rows have non-NULL `adjacent_pair_count` + `adjacent_pair_penalty` (see table below). Zero `fidelity scoring failed` log lines across the 5-chapter regen wave. |
| **#2 S3 IAM (`s3:ListBucket`)** | All regens logged `not authorized to perform: s3:ListBucket` against `tb_to_tutorial_test` | Inline policy `textbooks-bucket-read` attached in AWS Console: `s3:ListBucket` on the bucket + `s3:GetObject` + `s3:PutObject` on `…/parsed/*`. (`s3:HeadObject` is not a real IAM action — covered by `s3:GetObject`; the comment in `.env.example:72` was loose shorthand.) | `aws s3 ls` succeeds; `aws s3 cp` of the glossary key initially returned 404 (different failure → Gap #3 discovered). Zero `s3:ListBucket` denials in the 5-chapter regen wave. |
| **#3 (new) Sprint J parser bug** | Discovered post-IAM-fix. `REFINE_SYSTEM_PROMPT` instructs the LLM to emit `source_paragraph_ref` (snake_case); parser at `glossary-np-fallback.ts:376` checked `t.sourceParagraphRef` (camelCase). 100% drop rate. Every post-PR-46 ingest writes an empty glossary (or, after the `terms.length > 0` worker gate, no glossary at all). Pre-existing tests passed because the mocked LLM responses used camelCase, matching the parser instead of the prompt. | One-line fix in `glossary-np-fallback.ts:369-391`: read `raw.source_paragraph_ref` with `raw.sourceParagraphRef` as alias. Regression test added in `__tests__/glossary-np-fallback.test.ts` feeding the parser the same snake_case shape the real gpt-4o-mini returns (verified via `_diag-glossary-llm.ts` against DDIA — full LLM response captured 10 valid terms). | 28/28 fallback tests pass (was 27). Backfill against DDIA produced 10 glossary terms persisted to `s3://textbooks-…/parsed/<sha>/glossary.json`. Zero `readGlossary failed` log lines across the 5-chapter regen wave. |

### Per-chapter regen outcomes (closure run)

| Ord | Chapter id (prefix) | `adjacent_pair_count` | `adjacent_pair_penalty` | `overall_score` | Notes |
|---|---|---|---|---|---|
| 20 | 1430f233 | 7 | 0.476 | 100 | anchor coverage 1/4 (Isolation/Failure/Snapshot Isolation missing — same as Round-3 baseline) |
| 34 | 87e94fdf | 2 | 0.182 | 80 | anchor coverage 4/5 (Response missing) |
| 36 | a42e2a8f | 9 | 0.333 | 56 | clean |
| 40 | add7c6f2 | 4 | 0.348 | 80 | anchor coverage 1/2 (BASE missing) |
| 56 | e9c7d1a2 | 7 | 0.400 | 60 | anchor coverage 5/6 (BASE missing) |

Adjacent-pair distribution this closure run (0.182 / 0.333 / 0.348 / 0.400 / 0.476) is materially **less alarming** than the Round-3 baseline (0.250 / 0.421 / 0.435 / 0.533 / 0.880). All five chapters would now **warn-but-pass** under Theo's proposed `penaltyScore ≥ 0.50` hard-reject threshold; the ch56 catastrophic 0.880 case did not reproduce. Two interpretations: (a) LLM variance — single-roll, not a deterministic gate effect; (b) glossary injection nudged the model toward better anchoring discipline. Disambiguating would require a 3-roll wave; deferred. (Round-3 honesty note about single-sample variance applies.)

### Glossary injection — verification

`readGlossary` now succeeds for DDIA (S3 key exists, IAM permits, parser accepts the LLM's snake_case). Direct grep of the post-closure narratives for the 10 backfilled DDIA terms:

| Ord | Matched terms (out of 10) |
|---|---|
| 20 | 0 — chapter is B-Trees / LSM-Trees; intersects 0 of the 10 backfilled terms |
| 34 | 0 — chapter is replication-mode; intersects 0 |
| 36 | 2 — Distributed Systems, Consensus |
| 40 | 1 — Distributed Systems |
| 56 | 0 — chapter is isolation levels; intersects 0 |

Caveat: the glossary is **passed to the prompt**, not necessarily echoed in the narrative. The prompt instructs "use the glossary as a floor, not a ceiling" ([narrative-only.ts:392](src/lib/prompts/narrative-only.ts:392)), so absence of exact term-string matches is not absence of glossary effect. The load-bearing verification is the **absence of `readGlossary failed` log lines** + the **non-empty S3 artifact** + the **per-chapter loader's non-null `glossary` value** ([per-chapter.ts:664](src/lib/generation/per-chapter.ts:664)). All three confirmed.

### Files added this closure (branch `fix/sprint-j-glossary-key-shape`)

- `src/lib/ingest/glossary-np-fallback.ts` — parser fix (lines 369-398).
- `src/lib/ingest/__tests__/glossary-np-fallback.test.ts` — regression test (new `it(...)` block; 28/28 pass).
- `scripts/backfill-glossary-oneoff.ts` — single-use backfill for pre-Sprint-J tutorials. Calls `runGlossaryNPBootstrap` over existing S3 chunks → `writeGlossary`. **Do not commit long-term**; delete after PR merges or generalize into a CLI under a feature flag.
- `scripts/_diag-glossary-llm.ts` — diagnostic that captures raw LLM response to disambiguate parser vs LLM issues. Same throwaway-script discipline.

### Status of the original Round-3 caveat

The original §"Honesty notes" line read: *"Migration 0007 + S3 IAM not applied means two of four Tier 1 fixes weren't end-to-end validated. The verdicts above ASSUME those fixes would have worked as designed when deployed — that's an assumption, not an observation."*

**Closure**: that assumption now has direct empirical support for Gap #1 (adjacent-pair persistence confirmed) and Gap #2 (no more 403 denials). The Sprint J glossary path **also** now persists + injects end-to-end, but the original Round-3 verdict assumption was that PR-46 worked as designed when IAM was fixed — that assumption was **false**. PR-46 had a parser bug that would have surfaced no matter how the IAM was configured. The verdict-shift sentence should read instead: "Sprint J was inert end-to-end until 2026-05-27 closure — both because of IAM AND a snake_case parser bug. The 5-chapter Round-3 sample was the first to hit the real path."

### Followups (not done this closure)

- **3-roll variance study** on the adjacent-pair score distribution post-glossary-injection — does the lower distribution (no ch56 0.880) replicate, or was it LLM variance?
- **Generalize the backfill**: a `scripts/backfill-glossary.ts <tutorialId | --all>` that the team can run for any pre-Sprint-J ingest. The one-off script is a starting point.
- **Test-discipline note for SI**: the existing PR-46 tests used camelCase mocked LLM responses, satisfying the parser without exercising the prompt's actual contract. **Add a discipline**: when a parser reads JSON shaped by a prompt, the test that drives the parser should mock the JSON shape **the prompt asks for**, not the shape the parser handles. SI-glossary-prompt-parser-contract-001.
- **`.env.example:72` cleanup**: the existing comment lists `s3:HeadObject` as a required action; AWS rejects it. Either drop it (HEAD is `s3:GetObject`) or document the rejection in-place. Cheap follow-up PR.

---

## Status: Item 4 of the post-compact 4-item plan **COMPLETE**.

All 4 items shipped:
- **Item 1**: persona re-walk + Tier 1 PR #42 + #43 (merged)
- **Item 2**: Sprint G PR #44 (merged)
- **Item 3**: Sprint J PR #46 (merged) + hygiene PR #45 (merged)
- **Item 4**: Round-3 empirical validation (this doc)

Total post-compact session cost: ~$0.156 OpenAI + 9 agent spawns. 5 PRs merged (#42-#46) + this Round-3 findings doc.
