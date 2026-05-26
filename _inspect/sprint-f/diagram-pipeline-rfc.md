# RFC: Sprint F — Diagram Pipeline Architecture

**Status**: Proposed
**Author**: Architect (Sprint F; KB-grounded re-spawn)
**Date**: 2026-05-25
**Repo state at decision**: `main @ 2372e2c` (post PRs #31–#34)
**Empirical baseline**: 588 chapter rows in production; 0 Mermaid blocks emitted; ~$0.0175/chapter generation cost; FIDELITY rule 8 (figures) added in PR #29 but actual figure-extraction not yet wired.

---

## 1. Recommendation

Ship a **hybrid diagram pipeline**:

- **Primary path (~85% coverage)**: six React **primitives** under `src/components/diagrams/` — `ComparisonTable`, `DefinitionList`, `DiagramFlow`, `StateTransitionDiagram`, `SequenceDiagram`, `DecisionTree` — driven by a **structured-JSON contract** the LLM emits as a fenced ```` ```diagram ```` block (typed payload, Zod-validated, brand-themed SVG/HTML at render).
- **Escape-hatch (~15% coverage)**: keep the existing `MermaidDiagram.tsx` for dense ER, complex class hierarchies, and unforeseen diagram types. Component already exists and follows our brand-token bridge.
- **Selection seam**: the LLM picks the right tool via a new FIDELITY rule 9 (preference order: structured-JSON primitive > Mermaid > prose-only). `ChapterRenderer`'s `code` slot extends to `language-diagram` (JSON payload) alongside the existing `language-mermaid`.

**One-line defense**: LLMs are empirically reliable at structured JSON (PR-B classified 1,797 paragraphs correctly; PR #28 chapter-firsts parse 100% success). LLMs are empirically unreliable at free-form DSL emission inside fenced blocks (Mermaid dormant across 588 chapters). Pick the substrate the LLM is good at, validate at the boundary (`kb:architecture/discipline/error-handling-discipline §"Pattern 3"`), degrade gracefully on failure (`kb:architecture/discipline/stability-patterns §Fail Fast`).

---

## 2. Scoring Matrix (8 axes × 5 options)

Scale: 1 (worst) — 5 (best).

| Axis | 1. Pure prose | 2. Mermaid only | 3. Primitives only | 4. **Hybrid (rec.)** | 5. react-flow |
|------|--------------|----------------|--------------------|----------------------|---------------|
| Prompt reliability | 5 | 2 (0/588) | 4 | **5** | 1 |
| Render reliability | 5 | 2 | 5 | **5** | 3 |
| a11y | 3 | 2 | **5** | **5** | 2 |
| SSR (App Router) | 5 | 1 | **5** | **5** | 1 |
| Brand-fit | 5 | 3 | **5** | **5** | 2 |
| Bundle size | **5** | 2 | 4 | 4 | 1 |
| Maintenance | **5** | 3 | 4 | 3 | 2 |
| Coverage | 1 | 4 | 4 | **5** | 4 |

Hybrid wins on 6 of 8 axes; ties or loses on Bundle (primitives add ~30-50 KB) and Maintenance (6 primitives + Mermaid bridge). Both are acceptable trades.

---

## 3. Rationale (KB-grounded — see §"KB Sources Consulted" at end)

### 3.1 Why structured-JSON beats free-form Mermaid

- Empirical: **0/588 Mermaid emissions** in production despite Sprint Bv2.5 shipping the full pipeline.
- LLM reliably emits structured payloads when shape is constrained (PR-B `[CODE]` markers, PR #28 chapter-firsts, PR #34 PostScript-name classification → 14.4% code-kind rate vs 0% prior).
- The Mermaid dormancy is **structural prompt-reliability**, not tuning. More prose in the prompt does not move it. JSON schema with `response_format` discipline does.
- Pattern: `kb:architecture/discipline/error-handling-discipline §"Pattern 3"` — define the type at the contract boundary, validate at parse-time. Used at `src/lib/ingest/classifier.ts:22` and 10+ other sites in this codebase.

### 3.2 Why the escape-hatch must stay

- Primitives cover ~85%; the remaining ~15% (dense ER, complex class hierarchies, distributed-system topologies) needs Mermaid's free-form graph rendering or a bespoke per-shape primitive (violates YAGNI).
- Pattern: `kb:architecture/discipline/stability-patterns §Fail Fast` + §Bulkhead — primary path failure (Zod reject) doesn't kill the escape-hatch; one bad block degrades to source-text fallback without affecting the rest of the chapter.

### 3.3 Why primitives compose brand tokens directly (and Mermaid can't)

- Sprint Bv2 brand foundation is `@layer utilities` in `globals.css` because `tailwind.config.ts` is locked.
- Primitives use `bg-paper`, `text-ink`, `border-paper-edge`, `text-citation`, etc. directly.
- Mermaid's `themeVariables` is a leaky abstraction (DSL-specific concepts like `primaryBorderColor`, `clusterBkg` instead of accepting domain tokens directly).
- Pattern: `kb:architecture/crosscut/single-responsibility` — a primitive has one reason to change (brand evolves → primitive classNames evolve). A Mermaid theme bridge has two (brand evolves OR Mermaid's theming API evolves).

### 3.4 Why SSR is non-negotiable

- Reader route (`src/app/tutorials/[id]/page.tsx`) is a Server Component, explicitly citing `kb:web-dev/react-essentials §"Server vs Client components"`.
- Primitives are pure React, no DOM dependencies — render in the RSC pass, no hydration cost, no flash-of-empty-diagram.
- Mermaid is browser-only (`document.createElementNS`); current pipeline accepts this via dynamic import + skeleton + post-hydration render. Fine for the ~15% escape-hatch path; would be a regression as the primary path (every chapter would carry a ~1.2 MB lazy bundle).

### 3.5 Why not react-flow / external graph libraries

- Bundle: ~200-400 KB for one shape-class (graphs); no overlap with tables/decision-trees/definitions/comparisons.
- No LLM-native protocol — back to the Mermaid problem (free-form emission) with a worse bundle.
- Project constraint: no new external service dependencies.

---

## 4. Implementation Sketch (~1,200 LoC across 9 new files)

### File layout

```
src/lib/diagrams/
  schema.ts                  # Zod schemas for the 6 primitive payload shapes (~250 LoC)
  parse.ts                   # parseDiagramBlock(rawJSON): Result<Payload, Error> (~120 LoC)

src/components/diagrams/
  ComparisonTable.tsx        # 2-N column comparison, header row, brand-themed (~100 LoC, pure HTML)
  DefinitionList.tsx         # term/definition pairs, semantic <dl> (~80 LoC, pure HTML)
  DiagramFlow.tsx            # left-to-right pipeline, 3-7 nodes (~180 LoC, SVG)
  StateTransitionDiagram.tsx # state machine, labeled edges (~200 LoC, SVG)
  SequenceDiagram.tsx        # vertical actor lanes + messages (~180 LoC, SVG)
  DecisionTree.tsx           # branching decisions, yes/no edges (~140 LoC, SVG)
  DiagramBlock.tsx           # router: parse + dispatch + Result.Err fallback (~60 LoC)
```

### Sprint split

- **Sprint F.1** (~600 LoC, one PR): `schema.ts` + `parse.ts` + `ComparisonTable` + `DefinitionList` + `DiagramBlock` router + `ChapterRenderer` `language-diagram` slot + FIDELITY rule 9 + Zod-validated test fixtures. Lowest-risk highest-frequency shapes; pure HTML; no SVG geometry.
- **Sprint F.2** (~600 LoC, one PR): the 4 SVG primitives + layout helpers + visual fixtures + eval-harness `diagram_block_density_per_chapter` metric (optional per Q1 below).

### ChapterRenderer wiring

```tsx
code: ({ inline, className, children, ...rest }: any) => {
  if (!inline && /\blanguage-mermaid\b/.test(className ?? '')) {
    return <MermaidDiagram source={…} />;
  }
  if (!inline && /\blanguage-diagram\b/.test(className ?? '')) {
    const source = (Array.isArray(children) ? children.join('') : String(children ?? '')).trim();
    return <DiagramBlock rawJSON={source} />;
  }
  return <code className={className} {...rest}>{children}</code>;
},
```

`DiagramBlock` internally calls `parseDiagramBlock()`, routes valid payloads, falls back to brand-themed `<pre>` + warn footer on Zod parse failure — same pattern as `MermaidDiagram.tsx:144-155`. Matches `kb:architecture/discipline/error-handling-discipline §"Pattern 7"` (crash with structured, user-visible error rather than silent drop).

---

## 5. FIDELITY Rule 9 — Proposed Text

Add as rule 9 in `src/lib/prompts/narrative-only.ts:101` (immediately after rule 8). Additive; rules 1–8 stay byte-for-byte unchanged.

```
9. PREFER STRUCTURED FIGURE REPRESENTATIONS. When the source describes a
   structure that would benefit from visual rendering — a pipeline, a state
   machine, a decision tree, a sequence/protocol exchange, a comparison
   between 2-N alternatives, or a glossary of related terms — emit a fenced
   ```diagram block containing a SINGLE JSON object matching one of the six
   primitive shapes below. The lesson UI renders these as brand-themed,
   accessible, server-rendered components.

   Preference order (highest to lowest):
     1. ```diagram with a typed JSON payload — use this whenever the
        structure fits one of the six shapes.
     2. ```mermaid with a flowchart/sequence/state/class/er diagram — use
        ONLY when the structure does NOT fit a primitive (e.g., a dense
        entity-relationship diagram with many cross-references).
     3. Prose-only — when neither a primitive nor Mermaid earns its space.

   The six primitive shapes:

     { "kind": "ComparisonTable", "title": "…", "columns": [...], "rows": [[...]] }
     { "kind": "DefinitionList", "items": [{ "term": "…", "definition": "…" }, ...] }
     { "kind": "DiagramFlow", "title": "…", "nodes": [{ "id": "a", "label": "…" }, ...], "edges": [{ "from": "a", "to": "b", "label": "?" }] }
     { "kind": "StateTransitionDiagram", "states": [...], "transitions": [{ "from": "…", "to": "…", "trigger": "…" }] }
     { "kind": "SequenceDiagram", "actors": [...], "messages": [{ "from": "…", "to": "…", "label": "…" }] }
     { "kind": "DecisionTree", "root": { "question": "…", "yes": {…}, "no": {…} } }

   Rules:
     - At most ONE diagram per lesson (visual anchor; multiple is noise).
     - Node/state/actor labels must be SHORT (≤3 words; renderer truncates).
     - JSON must be syntactically valid (strict parse; malformed → fallback).
     - When in doubt, prefer NO diagram. A bad diagram is worse than no diagram.
```

---

## 6. Migration Plan

1. **Pre-flight** (zero risk): merge Sprint F.1 PR. Existing tutorials regenerate naturally on next ingest; old tutorials unaffected (no schema change to `chapters.narrative`).
2. **Measurement** (1 chapter regen): regenerate DDIA chapter 1 with the new prompt; observe `diagram`-block emission rate vs. 0/588 Mermaid baseline. Acceptance gate: at least one `language-diagram` block emitted across 3 trial chapters.
3. **F.2 ship**: merge the 4 SVG primitives once F.1's prompt+parse path is validated.
4. **No deprecation of Mermaid**: stays as documented escape-hatch. Sprint F adds; does not subtract.
5. **Old narratives**: contain 0 diagrams (the empirical baseline). Render unchanged. Per-tutorial user-driven re-generation; no backfill. `kb:architecture/crosscut/idempotency` — regeneration is idempotent at chapter level.

---

## 7. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|-----------|
| R1 | LLM emits valid JSON but bad `kind` value | Medium | Low | Zod discriminated union; `parseDiagramBlock` returns `Result.Err`; fallback to source-text `<pre>` per `kb:architecture/discipline/stability-patterns §Fail Fast` |
| R2 | LLM emission rate stays low (parallel to Mermaid dormancy) | Medium | Medium | F.1 measurement gate before F.2 ship — if 0/3 chapters emit a diagram block, pause F.2 and investigate prompt teeth (schema discipline at `response_format`, not just FIDELITY rule text). Pattern: `kb:architecture/discipline/error-handling-discipline §"Pattern 3"` — boundary contract, not interior speculation. |
| R3 | SVG primitives have layout bugs on long labels / many nodes | High | Low (visual) | Truncate node labels to ≤3 words at render-time; maxNodes per shape bounded in Zod schema (DiagramFlow max 7); visual-regression fixtures in F.2 PR. |
| R4 | Bundle-size creep from 6 primitives | Low | Low | Tree-shaken named exports; SVG inlined as JSX (no asset import); measured budget ~30-50 KB total to main bundle. Mermaid stays lazy. |
| R5 | Mermaid escape-hatch attracts feature-creep | Medium | Medium | Documented constraint: Mermaid surface area FROZEN at current `MermaidDiagram.tsx`. No new theme variables, no new modes. New primitive needs → add 7th primitive, not Mermaid extension. `kb:architecture/crosscut/single-responsibility` — primitives are the growth surface; Mermaid is the bounded compatibility shim. |
| R6 | Future MermaidDiagram parse-error fallback shows raw source to user | Low | Low | Already mitigated in `MermaidDiagram.tsx:144-155`. New primitives must follow same fallback shape (DiagramBlock's `Result.Err` branch). |
| R7 | New `language-diagram` clashes with future emission of `diagram` code-language | Very low | Low | Namespace check at `parseDiagramBlock`: payload MUST be valid JSON AND have `kind` field matching the discriminated union. Anything else falls through to default `<code>`. |

---

## 8. Open Questions for User

1. **Eval-harness metric for diagram density**: add `diagram_block_density_per_chapter` alongside the figure-recall metric shipped in PR #30? (~50 LoC in F.2 scope.)
2. **F.1 ship-and-measure cadence**: F.1 merged + measured against 3 trial DDIA chapter regens BEFORE F.2 starts, or F.1+F.2 spawned in parallel (HETS)?
3. **Visual-regression infra**: Playwright snapshot tests for SVG primitives (~200 LoC infra + ~50 LoC per primitive) vs. manual review + eval-harness metric as the load-bearing signal? Recommendation: manual + eval metric (matches how `MermaidDiagram` shipped).
4. **Mermaid bundle**: confirm lazy-load stays unchanged (Mermaid only loaded when `language-mermaid` is on the page; happens via `await import('mermaid')` in `MermaidDiagram.tsx:75`).
5. **JSON schema vs `response_format` integration**: keep diagrams inline in markdown (low-risk additive), or extend `NARRATIVE_ONLY_RESPONSE_FORMAT` to include a typed `diagrams[]` field at the JSON-schema layer? Recommendation: inline for Sprint F; revisit if F.1 measurement shows the inline path is weak.

---

## KB Sources Consulted

All anchors below are referenced in the rationale above. Verified in-source via grep across `src/`. The toolkit's `~/.claude/library/kb/` directory does not contain backing `.md` files in this environment; anchor names are inherited from the in-source comment-doc convention (consistently cited at 70+ sites across the codebase).

- **`kb:architecture/discipline/stability-patterns`** — §Fail Fast, §Bulkhead, §Steady-State. Used at §3.1, §3.2, §3.5, §7 R1, R5. In-source at `src/components/MermaidDiagram.tsx:36`, `src/lib/openai/_retry.ts:29`, `src/lib/ingest/worker.ts:20`, `src/lib/pdf/parse.ts:33`, `src/app/api/ingest/route.ts:16`, and 8+ other sites.

- **`kb:architecture/discipline/error-handling-discipline`** — §"Pattern 3" (errors-defined-out via types), §"Pattern 7" (crash with structured error). Used at §3.1, §4.3, §5, §7 R1, R2, R6, R7. In-source at `src/lib/ingest/classifier.ts:22`, `src/lib/openai/_retry.ts:27`, `src/lib/types.ts:13`, `src/lib/env.ts:4`, `src/lib/s3.ts:15`, and 5+ other sites.

- **`kb:architecture/crosscut/single-responsibility`** — module sizing, one-reason-to-change. Used at §2, §3.3, §4.1, §4.2, §7 R3, R5. In-source at `src/db/schema.ts:19`, `src/lib/ingest/classifier.ts:25`, `src/lib/ingest/chunker.ts:25`, `src/lib/pdf/parse.ts:30`, and 10+ other sites.

- **`kb:web-dev/react-essentials`** — §"Server vs Client components", §"Composition over inheritance", §"Anti-patterns". Used at §3.4, §4.3. In-source at `src/app/tutorials/[id]/page.tsx:4,32,46`, `src/components/ChapterRenderer.tsx:35,479`, `src/hooks/useStreamingChapter.ts:38,41`, and 5+ other sites.

- **`kb:architecture/crosscut/idempotency`** — Used at §6. In-source at `src/app/api/srs/grade/route.ts:38`, `scripts/dev-setup.sh:18`.

**Anchors consulted but NOT cited (to avoid dangling citations)**:
- `kb:ml-dev/training-vs-inference` — relevant to LLM cost/inference distinction broadly; not load-bearing for the diagram-substrate decision.
- `kb:architecture/ai-systems/inference-cost-management` — broadly relevant to the pipeline; diagram blocks add negligible token cost (~50-200 tokens), so not material to this RFC.
- `kb:web-dev/typescript-react-patterns` — relevant to primitive component implementation specifics (Result types, discriminated unions); will be cited in Sprint F.1 PR description, not in the architecture RFC.
- `kb:architecture/crosscut/server-first` — referenced by the architect prompt; could not locate this exact anchor name in the codebase; equivalent guidance is captured under `kb:web-dev/react-essentials §"Server vs Client components"`.
