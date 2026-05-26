# RFC: Sprint F.2 — SVG Primitives Build

**Status**: Proposed
**Author**: Architect (Sprint F.2; KB-grounded)
**Date**: 2026-05-26
**Repo state at decision**: `feat/sprint-f2-svg-primitives` off `main @ 621130e` (post-PR #36)
**Predecessor**: `_inspect/sprint-f/diagram-pipeline-rfc.md` (Sprint F architecture); PR #35 + #36 shipped F.1 (schema, parser, 2 pure-HTML primitives, FIDELITY rule 9).
**Empirical baseline carrying into F.2**: F.1 measurement gate passed at 1/4 emission rate (1 valid ComparisonTable on DDIA Ch 2 Scalability). No DiagramFlow / StateTransitionDiagram / SequenceDiagram / DecisionTree emissions observed yet — F.2 ships the renderers so production traffic can supply the empirical signal.

---

## Decision summary

Six load-bearing decisions, locked. Each builder reads only these bullets + their per-primitive section.

1. **Layout algorithms are hand-rolled and deterministic, no external libs.** DiagramFlow uses single-row (LR) or single-column (TB) placement with uniform spacing. StateTransitionDiagram uses circular arrangement on the unit circle (≤8 states fit cleanly). SequenceDiagram uses uniform-pitch vertical lanes + uniform-pitch horizontal message rows. DecisionTree uses a 2-pass tidy-tree (Reingold-Tilford simplified to subtree-width packing) rendered top-to-bottom. The schema caps (2-7 / 2-8 / 2-6 / depth-8) make hand-rolled tractable and bundle-cost zero — citing `kb:architecture/crosscut/deep-modules` (each primitive is a deep module: small public surface `{ payload }`, all geometry hidden) and `kb:architecture/crosscut/single-responsibility` (one reason to change = layout evolves OR brand tokens evolve, not external lib API).

2. **SVG viewBox strategy is per-primitive computed, units are "design pixels" with `preserveAspectRatio="xMidYMid meet"`.** Outer container uses `width="100%"` and `height="auto"`; the viewBox carries the real coordinate space (computed from node count × per-node pitch + padding). Browsers scale the SVG to the containing column width while preserving glyph readability via the viewBox math. No `useEffect`-driven measurement; no `getBBox`. All text dimensions are estimated via `ch`-unit math (`labelLen * 7px` at 12px font for sans/display) — good enough at our schema caps.

3. **Edge routing is straight-line + computed-arrowhead via SVG `<marker>`.** No orthogonal bends, no spline routing. Arrowheads declared once per `<svg>` via `<defs><marker id="cb-arrow" .../></defs>` with brand-indigo fill. Variant markers per kind: `cb-arrow` (solid filled triangle = call/default), `cb-arrow-open` (open triangle = async), dashed line uses same closed marker (return). Self-loops in StateTransitionDiagram use a small cubic Bézier curving outward from a state's perimeter. Citing `kb:architecture/crosscut/information-hiding` — markers are declared module-internal in each primitive's `<defs>`, never exported.

4. **Label-collision handling is rotation-free and bounded.** When two edge labels would overlap (worst case: parallel transitions A→B and B→A), we offset the second label perpendicular to the edge midpoint by ±12px. We do NOT rotate text (screen readers + selection break under SVG `transform: rotate`). Long labels truncate at the 32-char schema cap; we never wrap. If a primitive's computed viewBox would push labels off-canvas, we extend the viewBox padding — never the labels. The 32-char schema cap is already the contract enforcement; the primitive trusts it (`kb:architecture/discipline/error-handling-discipline §"Pattern 3"` — interior trusts boundary-validated data).

5. **Density metric definition: `diagram_block_density_per_chapter` = count of valid `language-diagram` blocks per chapter narrative**, partitioned by `payload.kind` (so we can see "DDIA Ch 2 emitted 1 ComparisonTable + 0 of every other kind"). Mermaid blocks counted separately under a sibling field `mermaid_block_density_per_chapter` — we do NOT collapse them; F.1's whole thesis is that the Mermaid path is the escape hatch and we want the signal split. Parse failures count as negative signal under `diagram_parse_failures_per_chapter`. Lives at `src/lib/eval/diagram-density.ts` (new file, ~90 LoC) and gets summary rows in the existing `report.ts` aggregation pass. Citing `kb:architecture/ai-systems/evaluation-under-nondeterminism` — measure emission rate by kind, not aggregate; aggregate hides which primitives the prompt is actually exercising.

6. **Playwright snapshot strategy: ship as `tests/playwright/diagrams.spec.ts` against a new dev-only route `/_diagram-gallery/[kind]` that renders fixed fixtures.** Playwright pinned to `@playwright/test ^1.49.0` (current stable; 2025-11 line) as a devDependency. Snapshots checked into git at `tests/playwright/__snapshots__/<spec>-<browser>-<platform>/<name>.png`. New `pnpm test:playwright` script. Default invocation compares; `pnpm test:playwright --update-snapshots` regenerates. Citing `kb:architecture/ai-systems/evaluation-under-nondeterminism §"Snapshot tests as regression detectors"` (snapshots catch unintended layout drift across prompt changes, brand-token changes, primitive refactors).

7. **F.1 conventions are mirrored byte-for-byte.** Every F.2 primitive has the same shape as `ComparisonTable.tsx` and `DefinitionList.tsx`: file header JSDoc explaining what + why-this-shape + brand-token reasoning + a11y notes; one default-export function component `function PrimitiveName({ payload }: { payload: PrimitivePayload })`; `import type { ... } from '@/lib/diagrams/schema'`; `<figure className="my-stanza" role="img" aria-label="...">` outermost; optional `<figcaption>` for `payload.title`. The router `DiagramBlock.tsx` swaps the four `case '...'` lines from `<DiagramPending>` to real primitives. `DiagramPending` itself is kept as the fallback for ANY future-added schema variant not yet routed.

---

## Primitive 1 — DiagramFlow

### Geometry

Directed pipeline of 2-7 nodes with ≤12 edges. Two directions:

- **LR** (default): nodes laid out in a single row, left-to-right, in `nodes[]` declaration order. Spacing = `NODE_PITCH_X = 160` design pixels between node centers; `NODE_W = 128`, `NODE_H = 56`. Total viewBox width = `NODE_PITCH_X * (nodes.length - 1) + NODE_W + 2 * PAD_X` where `PAD_X = 32`.
- **TB**: same algorithm rotated; nodes stacked vertically. `NODE_PITCH_Y = 96`. ViewBox height grows with node count.

We deliberately do NOT compute a topological layout from the edges. The schema bounds (≤7 nodes) and the editorial use case (pedagogical "step 1 → step 2 → step 3" pipelines) mean **declaration order is the layout order**. If the LLM emits `nodes: [Start, Validate, Persist, Notify]`, that's the order the reader sees. The edges merely draw arrows on top.

### Node shapes per kind

- `start` / `end`: pill shape (`rx=NODE_H/2`) in `brand-fade` fill, `brand` stroke, `ink` text. Visually marks pipeline boundaries.
- `process` (default if `kind` omitted): rounded rectangle (`rx=8`) in `paper-deep` fill, `paper-edge` stroke, `ink` text.
- `decision`: diamond (rotated square) in `citation-fade` fill, `citation` stroke. Same `NODE_W`/`NODE_H` bounding box; SVG `<polygon points="...">` traces the four corners.

### Edge routing

Straight line from source-node right-edge to target-node left-edge (LR direction; TB analogous). Arrowhead via `marker-end="url(#cb-arrow-flow)"`. Edge label (if `edge.label` present) drawn at midpoint with a tiny `bg-paper` rect underneath so the line doesn't strike through the text — done by emitting `<rect>` then `<text>` (SVG draws in document order; later elements paint on top).

If `from` or `to` references a node not in `nodes[]`, the primitive silently drops that edge (defensive; the schema doesn't enforce referential integrity and a missing-node edge would project to (0,0) and look like a glitch). Per `kb:architecture/discipline/error-handling-discipline §"Pattern 7"` — degrade gracefully, don't throw inside a render pass.

### Pseudocode

```
function DiagramFlow({ payload }):
  const { title, direction = 'LR', nodes, edges } = payload
  const isLR = direction === 'LR'
  const NODE_W = 128, NODE_H = 56
  const PITCH = isLR ? 160 : 96
  const PAD = 32

  // 1. Place nodes on the axis
  const positions = new Map<string, {x, y}>()
  nodes.forEach((node, i) => {
    if (isLR) positions.set(node.id, { x: PAD + i * PITCH, y: PAD })
    else      positions.set(node.id, { x: PAD,             y: PAD + i * PITCH })
  })

  // 2. Compute viewBox
  const lastIdx = nodes.length - 1
  const W = isLR ? (PAD * 2 + lastIdx * PITCH + NODE_W) : (PAD * 2 + NODE_W)
  const H = isLR ? (PAD * 2 + NODE_H)                   : (PAD * 2 + lastIdx * PITCH + NODE_H)

  // 3. Drop unreferencable edges (defensive)
  const validEdges = edges.filter(e => positions.has(e.from) && positions.has(e.to))

  // 4. Emit SVG: <defs><marker/></defs>, then edges, then nodes, then edge labels
  return <figure role="img" aria-label={describe(payload)}>
    {title && <figcaption>{title}</figcaption>}
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="auto" role="presentation">
      <defs><marker id="cb-arrow-flow" .../></defs>
      {validEdges.map(e => <line .../>)}                    // straight lines w/ marker-end
      {nodes.map(n => renderNodeShape(n, positions.get(n.id)))}
      {validEdges.filter(e => e.label).map(e => renderEdgeLabel(e, positions))}
    </svg>
  </figure>
```

The `describe(payload)` helper builds the `aria-label` from title + node labels (e.g., `"Pipeline: Ingest → Validate → Persist"`). Builder writes this helper inline (≤6 lines).

---

## Primitive 2 — StateTransitionDiagram

### Layout: circular

8 states or fewer fit naturally on a circle (the worst case being 8 states is 45° apart, ample room for labels). Circular layout side-steps the "two-states-with-bidirectional-transitions" problem that a row layout would handle awkwardly (parallel arrows would overlap or require routing). The circle's radius is computed from the state count so labels never collide:

```
R = max(120, (states.length * (NODE_W + 24)) / (2 * π))
```

Center at `(W/2, H/2)`; state `i` placed at angle `θ_i = -π/2 + i * (2π / states.length)` so state 0 sits at top (12 o'clock). ViewBox padded enough to fit `NODE_W = 96, NODE_H = 48` rectangles centered on each circle point.

### Visual markers

- **Initial state** (`states[i].initial === true`): a small `<circle r="6">` filled `brand` placed just outside the state's perimeter, with an arrow drawn from it to the state edge. Convention from automata-theory textbooks; immediately readable.
- **Terminal state** (`states[i].terminal === true`): double-ring — render the state rectangle (or circle) twice, the inner one inset by 4px. Standard convention (CLRS, Sipser, et al.).
- **Both** (rare): both markers applied; the entry-circle sits outside the outer ring.

### Transition routing

Three cases:

1. **Self-loop** (`t.from === t.to`): cubic Bézier curving outward from the state's outer edge, ~30° arc subtended. Arrow lands back on the same state, marker at the head. Trigger label placed beyond the loop's apex.
2. **Single transition between a pair** (A→B, no B→A): straight line from A's perimeter to B's perimeter (computed by intersecting the A→B line with each state's bounding box). Trigger at midpoint over a `bg-paper` rect.
3. **Bidirectional pair** (both A→B and B→A exist): two parallel lines offset perpendicular to the A→B axis by ±8px. Each carries its own arrowhead and trigger label, offset by ±12px from the midline to avoid label collision.

Multiple transitions between the SAME pair with different triggers (e.g., two A→B transitions) are rare in pedagogical state machines, but the schema allows ≤16 transitions / 8 states (max 64 ordered pairs). Builder concatenates the trigger labels for same-direction same-pair transitions with " | " (e.g., `"timeout | error"`) and draws ONE line — pedagogically clearer and avoids the routing-soup case.

### Initial/terminal state shape

Circles (not rectangles) — standard FSM convention. `<circle r="NODE_H/2">` centered on the layout point. Text inside via `<text dominant-baseline="central" text-anchor="middle">`.

Citing `kb:architecture/crosscut/information-hiding`: the choice of "circles for states + rectangles for flow-nodes" is an internal rendering decision; the schema doesn't surface it (`StateTransitionDiagram.states[i]` has no `shape` field, and shouldn't — that would push render concerns into the contract).

---

## Primitive 3 — SequenceDiagram

### Geometry

- **Lifelines**: 2-6 vertical lanes at uniform horizontal pitch. `LANE_PITCH_X = 160`, `LIFELINE_X_0 = 80`. Each lifeline = top actor box (rectangle, `ACTOR_W = 120`, `ACTOR_H = 40`) + a long vertical dashed line descending the full message area.
- **Messages**: drawn top-to-bottom in `messages[]` declaration order. `MESSAGE_PITCH_Y = 48`; message `j` is at `y = ACTOR_H + 32 + j * MESSAGE_PITCH_Y`. Each message is a horizontal arrow from `from`-lifeline x-coord to `to`-lifeline x-coord, with label centered above.
- **ViewBox**: `W = LIFELINE_X_0 * 2 + (actors.length - 1) * LANE_PITCH_X`, `H = ACTOR_H + 32 + messages.length * MESSAGE_PITCH_Y + 32`.

### Actor-name → lifeline-index resolution

`actors: ['Client', 'Server', 'DB']` defines indices 0/1/2. `message.from` and `message.to` are `ShortLabel`s that must match actor strings exactly. If a message references a non-existent actor (LLM emission bug), the builder drops that message defensively (same pattern as DiagramFlow's missing-node edge drop).

### Message-kind glyphs

- `'call'` (default): solid line, filled-triangle arrowhead via `<marker id="cb-arrow-seq-call">`. Color `ink`.
- `'return'`: dashed line (`stroke-dasharray="6 4"`), filled-triangle arrowhead (same as call). Color `ink-muted`. Convention: returns are less semantically loaded than calls.
- `'async'`: solid line, OPEN-triangle arrowhead via `<marker id="cb-arrow-seq-async">` (stroke-only, no fill). Color `ink`. Standard UML async convention.

### Self-messages

`message.from === message.to`: small right-loop arrow that exits the lifeline, curves down ~16px, and re-enters the lifeline below. The label sits to the right of the loop. Schema permits this (the labels just need to be ShortLabel-equal); fairly common pedagogically (a service calling its own internal method).

### Vertical advance

Uniform per-message even for self-messages (no auto-expansion to fit). This keeps the diagram visually metronomic — which matches how textbooks draw them — and the schema's ≤20-message cap keeps total height bounded.

Citing `kb:web-dev/react-essentials §"Server vs Client components"`: the entire primitive is a pure function of `payload`, no hooks, no DOM dependencies — renders in the RSC pass alongside the lesson chrome.

---

## Primitive 4 — DecisionTree

### Layout: top-down tidy tree

Vertical orientation (root at top, leaves at bottom). Rationale: matches how readers parse "if X then Y else Z" left-to-right + top-to-bottom, and book pages are taller than wide for code blocks but a horizontal tree feels cramped at depth ≥4. Schema caps depth at 8 — vertical orientation comfortably fits.

Simplified Reingold-Tilford algorithm (post-order subtree-width packing):

1. **First pass (post-order)**: compute each node's subtree width = max(own-label-width, sum of children-subtree-widths + gap-between-children).
2. **Second pass (pre-order)**: assign x-coords. Root at `x = subtreeWidth(root) / 2`. Each child is placed at its parent's x, offset by half its subtree width left (yes-branch) or right (no-branch).
3. **y-coords**: `y = depth * LEVEL_PITCH_Y` where `LEVEL_PITCH_Y = 80`.

This isn't textbook-pure tidy-tree (which would also handle nephew-spacing); at depth ≤ 8 and ≤2 branches per internal node, the simplified pack is empirically tight enough. If a deep tree ends up uneven, we accept the asymmetry — never expand labels beyond the schema cap.

### Node shapes

- **Internal node** (`{ question, yes, no }`): rounded rectangle in `paper-deep` fill, `paper-edge` stroke. Text = `node.question`, wrapped via `<text>` `<tspan>` segments if longer than ~16ch (we honor the 120-char schema cap but auto-wrap at width). Wrapping is greedy on word boundaries, max 2 lines, ellipsis on overflow.
- **Leaf** (`{ leaf }`): pill shape (`rx=H/2`) in `brand-fade` fill, `brand` stroke. Text = `node.leaf`.

### Edges

Two straight lines per internal node: parent center-bottom → yes-child center-top, and parent center-bottom → no-child center-top. Labels on the edge midpoint:

- **Yes-branch**: label `"Yes"` in `success` color with `bg-paper` rect underneath.
- **No-branch**: label `"No"` in `danger` color with `bg-paper` rect underneath.

Pedagogical convention: yes on the left, no on the right. Builder enforces this in the layout pass (yes-subtree's children placed to parent's left).

### Pseudocode

```
function DecisionTree({ payload }):
  const { title, root } = payload

  // 1. Post-order: compute subtree widths
  function computeWidth(node): number {
    if ('leaf' in node) return Math.max(LEAF_MIN_W, estimateTextWidth(node.leaf))
    const yesW = computeWidth(node.yes)
    const noW  = computeWidth(node.no)
    const ownW = Math.max(INTERNAL_MIN_W, estimateTextWidth(node.question))
    return Math.max(ownW, yesW + GAP_X + noW)
  }

  // 2. Pre-order: assign positions
  function place(node, centerX, depth, positions): void {
    positions.push({ node, x: centerX, y: depth * LEVEL_PITCH_Y })
    if ('leaf' in node) return
    const yesW = computeWidth(node.yes)
    const noW  = computeWidth(node.no)
    place(node.yes, centerX - (noW + GAP_X) / 2, depth + 1, positions)
    place(node.no,  centerX + (yesW + GAP_X) / 2, depth + 1, positions)
  }

  // 3. Emit SVG: edges first (so node shapes paint over edge ends), then nodes, then edge labels
  const positions = []
  place(root, computeWidth(root) / 2, 0, positions)
  const W = computeWidth(root) + 2 * PAD
  const H = (maxDepth(root) + 1) * LEVEL_PITCH_Y + 2 * PAD
  ...
```

Citing `kb:architecture/crosscut/single-responsibility` — `computeWidth`, `place`, and the SVG emission are three responsibilities in the same module file but cleanly separable helpers; the public surface stays `function DecisionTree({ payload })`.

---

## Playwright snapshot strategy

### Why net-new test infra

Vitest + jsdom is good for assertion-level tests (counts, roles, text contents) but bad at "did the SVG layout actually look right" — jsdom does not implement SVG layout. The four F.2 primitives all do non-trivial geometry; a small layout regression (e.g., a wrong off-by-one in NODE_PITCH_X) wouldn't fail any DOM-shape assertion but would silently produce ugly diagrams in production. Snapshot tests close that gap.

Citing `kb:architecture/ai-systems/evaluation-under-nondeterminism §"Snapshot tests as regression detectors"`: snapshots are the right tool for "I've changed nothing intentional; did the visual output drift?" precisely because they fail loud on any pixel-level diff and force the engineer to either accept the change (`--update-snapshots`) or revert it.

### Where snapshots live

- **Specs**: `tests/playwright/diagrams.spec.ts` (one file; ~140 LoC; one `test()` per primitive × per fixture-set).
- **Snapshot images**: `tests/playwright/__snapshots__/diagrams.spec.ts-<browser>-<platform>/<name>.png` (Playwright's default location). Checked into git. Browser pinned to `chromium` only (a single rendering substrate; cross-browser snapshots are out-of-scope until a primitive renders differently in Firefox, which won't happen for our SVG subset).
- **Fixtures**: `tests/playwright/fixtures/diagrams.ts` exports a fixed set of payloads per primitive (one minimal example, one max-size example, one edge-case example per kind = ~12 payloads total).

### How the test renders the component

A new dev-only route `/_diagram-gallery/[kind]?fixture=<name>` (lives at `src/app/_diagram-gallery/[kind]/page.tsx`) imports the fixtures and renders the appropriate primitive directly. The route is excluded from production builds via a `process.env.NODE_ENV === 'development'` check or a `notFound()` in production (builder picks the cleaner option). Playwright's `page.goto(...)` hits this route in `dev`-mode Next.js, screenshots the rendered primitive, compares to the snapshot.

We do NOT use `@playwright/experimental-ct-react` ("mount"). Component-test mode is experimental for Next.js App Router and pulls in `vite` as a side-effect (clashes with our `vitest.config.ts` lock + `tailwind.config.ts` lock). A real Next.js page route is the cheapest "render this component in the actual production styling pipeline" path.

### CI integration

- **New `pnpm test:playwright` script** in `package.json`: `playwright test`.
- **Local dev**: `pnpm test:playwright` (compares); `pnpm test:playwright --update-snapshots` (regenerates intentionally).
- **CI**: NOT wired into `pnpm test` (which is `vitest run` and stays unit-test-fast); a separate job in the future. F.2 ships the spec + snapshots + script; CI wiring is a follow-up if regressions actually occur.
- **Playwright install**: builder runs `pnpm add -D @playwright/test@^1.49.0` and `pnpm exec playwright install chromium` (one-time; CI will need to mirror).

### Snapshot diff review process

1. Engineer changes a primitive (or a brand token).
2. `pnpm test:playwright` runs locally; failing snapshots produce `<name>-actual.png` + `<name>-diff.png` alongside the expected `<name>.png`.
3. Engineer reviews diff visually.
4. If intentional → `pnpm test:playwright --update-snapshots` regenerates and commits the new `.png`.
5. If unintentional → fix the regression.

This matches the F.1 RFC's empirical-loop discipline (`kb:architecture/ai-systems/evaluation-under-nondeterminism`): measurement is cheap, regeneration is explicit, accidental drift is loud.

---

## diagram_block_density_per_chapter metric

### Computation

Per-chapter:

```
diagram_block_density_per_chapter[chapterOrdinal] = {
  byKind: {
    ComparisonTable: <count of valid ```diagram blocks where payload.kind === 'ComparisonTable'>,
    DefinitionList: ...,
    DiagramFlow: ...,
    StateTransitionDiagram: ...,
    SequenceDiagram: ...,
    DecisionTree: ...,
  },
  totalValid: <sum of byKind>,
  parseFailures: <count of ```diagram blocks where parseDiagramBlock returned ok: false>,
  mermaidBlocks: <count of ```mermaid blocks — sibling, NOT collapsed into byKind>,
}
```

The metric does NOT use a points-weighted formula (e.g., "each primitive worth 1, parse-failure worth -0.5"). Rationale: a weighted scalar collapses signal across kinds, and the question we actually want answered is "which primitives is the prompt exercising?". A per-kind breakdown answers that directly. Parse failures are reported separately so they don't artificially inflate or deflate emission rates.

We also do NOT count `language-mermaid` blocks into the structured-primitive sum. Per the F.1 RFC §"Why the escape-hatch must stay" (`kb:architecture/discipline/stability-patterns §Bulkhead`), Mermaid is the explicit escape-hatch; collapsing it into the same metric hides the very signal we're tracking (is the LLM defaulting to Mermaid for shapes that should be structured?).

### Implementation location

New file `src/lib/eval/diagram-density.ts`, ~90 LoC, pure function:

```ts
export interface DiagramDensity { ... }   // shape above
export function computeDiagramDensity(narrative: string): DiagramDensity;
```

Parses the narrative markdown via a simple regex finding triple-backtick blocks tagged `diagram` or `mermaid`. Routes `diagram` block bodies through `parseDiagramBlock` (reuses F.1 parser, no duplication). Counts `mermaid` blocks by presence only (no parse).

### Integration into report.ts

`src/lib/eval/report.ts` renders the A/B comparison report. We extend its input shape with an optional `diagramDensityByVariant?: Record<string, Record<number, DiagramDensity>>` and add a new section in the rendered markdown:

```
## Diagram emission density

| Variant | Chapter | ComparisonTable | DefinitionList | DiagramFlow | StateTransition | Sequence | DecisionTree | Mermaid | Parse failures |
|---------|---------|-----------------|----------------|-------------|-----------------|----------|--------------|---------|----------------|
| v3      | 0       | 1               | 0              | 0           | 0               | 0        | 0            | 0       | 0              |
| ...
```

The runner (`src/lib/eval/runner.ts`) computes the density for each chapter narrative it loads and threads it through. Strictly additive — existing report-rendering tests stay green; the new section appears only when `diagramDensityByVariant` is supplied.

Citing `kb:architecture/crosscut/single-responsibility`: the new file owns one concern (count blocks per kind). The existing rubric / persona / report modules are not modified beyond a single optional field on `ReportInput`.

### Should it count language-mermaid? — **separately, yes; collapsed, no.**

Already decided above. The `mermaidBlocks` count goes in the report table as its own column, but is not summed into `totalValid`. This way the per-kind columns answer "which primitive does the LLM reach for?" and the Mermaid column answers "is the escape-hatch firing?".

---

## Builder breakdown for Wave 1

Six parallel builders. Each gets a kickoff prompt with the same skeleton (below) plus their per-builder target/budget/contract.

### Universal kickoff skeleton

Every builder kicks off with this preamble (the parent orchestrator pastes it verbatim, then appends the per-builder section):

```
You are a Wave-1 builder for Sprint F.2 SVG primitives in textbook-to-tutorial.

PRE-FLIGHT (mandatory, before any edit):
  pwd && git branch --show-current
  Expected: cwd = /Users/.../TB_to_Tutorial_converter
  Expected: branch = feat/sprint-f2-svg-primitives

Read first (DO NOT modify):
  - _inspect/sprint-f/f2-svg-primitives-rfc.md  (this RFC — full)
  - src/lib/diagrams/schema.ts                  (your payload type lives here)
  - src/components/diagrams/ComparisonTable.tsx (F.1 convention — header style, props, a11y)
  - src/components/diagrams/DefinitionList.tsx  (F.1 convention — secondary reference)
  - src/app/globals.css                         (brand-token catalog under @layer utilities)

DO NOT TOUCH:
  - src/lib/diagrams/schema.ts
  - src/lib/diagrams/parse.ts
  - src/components/diagrams/ComparisonTable.tsx
  - src/components/diagrams/DefinitionList.tsx
  - src/components/diagrams/DiagramBlock.tsx        (Builder F handles router rewire)
  - tailwind.config.ts                              (locked)
  - vitest.config.ts                                (locked)
  - src/app/globals.css                             (locked — use existing tokens only)

YOUR FILES (see per-builder section below).

YOUR LOC BUDGET (see per-builder section below). Soft ceiling — if you exceed,
explain why in the PR description.

YOUR CONTRACT:
  - default-export function component `function <Name>({ payload }: { payload: <Name>Payload })`
  - `import type { <Name>Payload } from '@/lib/diagrams/schema'`
  - outermost: <figure className="my-stanza" role="img" aria-label="...">
  - optional <figcaption> when payload.title is present
  - server-component safe: no `'use client'`, no hooks, no DOM access, no `useEffect`
  - SVG text via `<text>`, not `<foreignObject>`
  - brand tokens from src/app/globals.css only — do NOT invent new ones
  - SVG viewBox computed; outer SVG width="100%" height="auto"
  - <defs><marker .../></defs> for arrowheads when needed; marker IDs scoped per primitive
    (e.g., `cb-arrow-flow` for DiagramFlow — never just `cb-arrow`)

TEST CONTRACT (you write this — file lives in src/components/diagrams/__tests__/):
  - // @vitest-environment jsdom  (first line)
  - import React from 'react'
  - import { describe, it, expect, afterEach } from 'vitest'
  - import { render, screen, cleanup } from '@testing-library/react'
  - afterEach(() => { cleanup(); })
  - assert: at least N visible <text> elements, role="img" with aria-label,
    figcaption renders/omits based on title, malformed-payload rejection happens
    in DiagramBlock (NOT your primitive's responsibility — trust the boundary)

VERIFICATION:
  pnpm test src/components/diagrams/__tests__/<YourFile>.test.tsx
  Must pass before opening PR.
```

### Builder A — DiagramFlow primitive + tests

- **Target files**:
  - `src/components/diagrams/DiagramFlow.tsx` (new, ~140 LoC)
  - `src/components/diagrams/__tests__/DiagramFlow.test.tsx` (new, ~80 LoC)
- **LoC budget**: 220 total.
- **Imports from F.1**: `import type { DiagramFlowPayload } from '@/lib/diagrams/schema'`.
- **Contract specifics**: support both `direction: 'LR'` and `direction: 'TB'`; node shapes per `kind` (start/end pill, process rect, decision diamond); arrowhead marker scoped `cb-arrow-flow`. Silently drop edges referencing missing node IDs. Tests must cover: 2-node LR, 4-node TB with decision, edge-label rendering, missing-node-edge-drop, optional title rendered as figcaption, role+aria-label present.

### Builder B — StateTransitionDiagram primitive + tests

- **Target files**:
  - `src/components/diagrams/StateTransitionDiagram.tsx` (new, ~160 LoC)
  - `src/components/diagrams/__tests__/StateTransitionDiagram.test.tsx` (new, ~80 LoC)
- **LoC budget**: 240 total.
- **Imports from F.1**: `import type { StateTransitionDiagramPayload } from '@/lib/diagrams/schema'`.
- **Contract specifics**: circular layout per RFC §"Primitive 2"; initial-state entry dot + arrow; terminal-state double-ring; self-loops via cubic Bézier; bidirectional pair gets offset parallel lines; same-pair-same-direction transitions concat triggers with `" | "`. Marker scoped `cb-arrow-state`. Tests: 2-state with initial+terminal, 5-state cycle, self-loop trigger label visible, bidirectional pair both labels visible.

### Builder C — SequenceDiagram primitive + tests

- **Target files**:
  - `src/components/diagrams/SequenceDiagram.tsx` (new, ~140 LoC)
  - `src/components/diagrams/__tests__/SequenceDiagram.test.tsx` (new, ~70 LoC)
- **LoC budget**: 210 total.
- **Imports from F.1**: `import type { SequenceDiagramPayload } from '@/lib/diagrams/schema'`.
- **Contract specifics**: vertical lifelines + horizontal message arrows; message-kind glyphs (call solid+filled, return dashed+filled, async solid+open); self-message right-loop; uniform vertical pitch. Markers scoped `cb-arrow-seq-call` and `cb-arrow-seq-async` (return reuses `cb-arrow-seq-call` since the marker is the same, only the stroke-dasharray differs). Tests: 3-actor 4-message call/return/async mix, self-message, missing-actor message drop.

### Builder D — DecisionTree primitive + tests

- **Target files**:
  - `src/components/diagrams/DecisionTree.tsx` (new, ~160 LoC)
  - `src/components/diagrams/__tests__/DecisionTree.test.tsx` (new, ~80 LoC)
- **LoC budget**: 240 total.
- **Imports from F.1**: `import type { DecisionTreePayload, DecisionTreeNode } from '@/lib/diagrams/schema'`.
- **Contract specifics**: simplified Reingold-Tilford subtree-width pack, top-down, yes-left no-right. Greedy 2-line text wrapping for internal-node questions; ellipsis on overflow. Yes/No edge labels (success/danger colors). Trust the boundary — depth is already validated by `parse.ts`, you never recompute. Tests: leaf-only root rejected at schema (NOT primitive concern), 3-level balanced tree, 5-level lopsided tree, leaf vs internal-node visual distinction (pill vs rect).

### Builder E — Density metric + report integration

- **Target files**:
  - `src/lib/eval/diagram-density.ts` (new, ~90 LoC)
  - `src/lib/eval/__tests__/diagram-density.test.ts` (new, ~60 LoC)
  - `src/lib/eval/report.ts` (modify: extend ReportInput type, add new section renderer, ~40 LoC delta)
  - `src/lib/eval/__tests__/report.test.ts` (extend: add diagram-density section test, ~30 LoC delta)
- **LoC budget**: 220 total.
- **Imports from F.1**: `import { parseDiagramBlock } from '@/lib/diagrams/parse'`.
- **Contract specifics**: `computeDiagramDensity(narrative: string): DiagramDensity` extracts `diagram` + `mermaid` fenced blocks via regex, routes `diagram` bodies through `parseDiagramBlock`, returns shape per RFC §"diagram_block_density_per_chapter metric". `report.ts` gets a new optional field `diagramDensityByVariant`; new `renderDiagramDensity()` helper emits the table. Existing report rendering MUST remain unchanged when the field is absent. Do NOT touch `runner.ts` (Builder F threads it in).

### Builder F — DiagramBlock router rewire + runner threading + Playwright infra

- **Target files**:
  - `src/components/diagrams/DiagramBlock.tsx` (modify: import 4 new primitives, replace `<DiagramPending kind={...}>` cases with real components — keep `DiagramPending` itself as a fallback for any future schema variant; ~10 LoC delta)
  - `src/components/diagrams/__tests__/DiagramBlock.test.tsx` (modify: update the Sprint F.2 pending block to "renders the real component" assertions; ~30 LoC delta — see §"Test-canary update" below)
  - `src/lib/eval/runner.ts` (modify: compute density per chapter, thread into ReportInput; ~25 LoC delta)
  - `src/lib/eval/__tests__/runner.test.ts` (extend: density-threading assertion; ~20 LoC delta)
  - `package.json` (modify: add `@playwright/test` devDep + `test:playwright` script; ~3 LoC delta)
  - `playwright.config.ts` (new, ~30 LoC)
  - `tests/playwright/diagrams.spec.ts` (new, ~140 LoC)
  - `tests/playwright/fixtures/diagrams.ts` (new, ~80 LoC — 12 fixture payloads, 3 per F.2 primitive: minimal, max-size, edge-case)
  - `src/app/_diagram-gallery/[kind]/page.tsx` (new, ~50 LoC — dev-only route rendering fixtures by URL param)
- **LoC budget**: 388 total. Largest builder; coordinates the integration seams. **Must merge LAST** (depends on Builders A-D having landed on the same branch).
- **Sequencing**: Builder F starts after A/B/C/D have at least pushed initial commits to the shared branch. Builder F should NOT block on D's completion to start the Playwright + runner work — only the `DiagramBlock.tsx` rewire requires A/B/C/D files to exist. Builder F's PR description must list all six PRs and the merge order.

### Wave 1 coordination

All six builders work on the same branch `feat/sprint-f2-svg-primitives` (already created). They open six stacked commits (or six separate PRs into the branch, then a single squash-merge to main). The orchestrator must enforce:

- **Branch sanity gate** (per prior session's recurring branch-confusion bug): every builder's first command is `pwd && git branch --show-current`. If output doesn't match, halt and re-orient.
- **No file-overlap conflicts**: A/B/C/D each touch one new primitive file + one test file; E touches one new lib file + one new test file + two existing files in `src/lib/eval/`; F touches the router + tests + runner + Playwright infra. Only F modifies files that A-E created — F runs last.
- **Honesty audit** (per HETS-complete checklist from prior session): after all six builders complete, run code-reviewer + honesty-auditor before declaring Wave 1 complete.

---

## Test-canary update

The current `src/components/diagrams/__tests__/DiagramBlock.test.tsx` has a `describe('DiagramBlock — Sprint F.2 pending ...')` block that asserts `"<Kind> renderer ships in Sprint F.2"` placeholder text appears. Two tests there explicitly assert this for DiagramFlow and SequenceDiagram.

### After F.2 ships

The describe block is renamed to `describe('DiagramBlock — F.2 SVG primitives')` and asserts:

```ts
it('renders DiagramFlow with N nodes', () => {
  renderJSON({ kind: 'DiagramFlow', nodes: [...3 nodes...], edges: [...] });
  // Expect ≥3 <text> elements for the node labels
  const texts = document.querySelectorAll('svg text');
  expect(texts.length).toBeGreaterThanOrEqual(3);
  // Expect role="img" on the outer figure
  expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/DiagramFlow|Pipeline/);
  // Expect NO "renderer ships in Sprint F.2" placeholder
  expect(screen.queryByText(/renderer ships in Sprint F\.2/)).toBe(null);
});
```

Repeat for `StateTransitionDiagram`, `SequenceDiagram`, `DecisionTree`. The "N nodes" assertion uses a per-primitive minimum (DiagramFlow ≥ nodes.length texts; StateTransitionDiagram ≥ states.length; SequenceDiagram ≥ actors.length + messages.length; DecisionTree ≥ node-count which the test computes).

### Keep DiagramPending — yes

`DiagramPending` stays in `DiagramBlock.tsx`. Rationale:

- **Future schema variants**: if Sprint G adds a 7th primitive kind to the schema, the router's `default` exhaustiveness check fires a compile error — but during the build-out, `DiagramPending` is the natural soft-landing.
- **Diagnostic value**: a `kind` that parses-clean-but-isn't-yet-implemented is a different failure mode than a parse failure; `DiagramFallback` is for parse failures and `DiagramPending` is for "I see what you mean, just haven't built it yet". Keeping both preserves the diagnostic surface.

So the router's `switch` becomes:

```ts
case 'ComparisonTable':         return <ComparisonTable payload={payload} />;
case 'DefinitionList':          return <DefinitionList payload={payload} />;
case 'DiagramFlow':             return <DiagramFlow payload={payload} />;
case 'StateTransitionDiagram':  return <StateTransitionDiagram payload={payload} />;
case 'SequenceDiagram':         return <SequenceDiagram payload={payload} />;
case 'DecisionTree':            return <DecisionTree payload={payload} />;
default: {
  const _exhaustive: never = payload;
  return <DiagramFallback rawJSON={rawJSON} errorMessage="unknown diagram kind" />;
}
```

`DiagramPending` is not referenced from the switch but stays exported (or kept private but uncalled) as a one-line addition for the next sprint that adds a new schema variant. Builder F's PR description notes this convention explicitly so future work doesn't delete it.

---

## ADR — Sprint F.2 SVG primitives build

**Status**: Proposed
**Context**: F.1 shipped the contract (Zod schema), parser, two pure-HTML primitives, and the FIDELITY rule 9 prompt. The F.1 measurement gate passed at 1/4 emission rate. F.2 ships the four remaining SVG primitives so production traffic can supply the empirical signal for the kinds we haven't observed yet. Hard constraints: SSR-safe, no new layout libraries, brand tokens via `@layer utilities` only, vitest+jsdom for unit tests, Playwright for snapshot tests.
**Decision**: Six parallel builders. Hand-rolled deterministic layouts per primitive (row/column for DiagramFlow, circular for StateTransitionDiagram, lane-pitch grid for SequenceDiagram, tidy-tree pack for DecisionTree). Per-primitive SVG `<marker>` declarations for arrowheads, scoped IDs. Straight-line edges with perpendicular-offset label-collision avoidance. Density metric is per-kind, NOT a weighted scalar, NOT collapsed with Mermaid. Playwright snapshots via a dev-only `_diagram-gallery` route + checked-in `.png` files. `DiagramPending` stays in the router as a future-proof fallback.
**Consequences**: ~1500 LoC across 9-12 files in one PR (or six stacked sub-PRs). Six concurrent builders need branch-sanity gate enforcement. Playwright introduces a new test substrate distinct from vitest; CI integration deferred. Bundle cost ≈ 30-50 KB (six primitives, each ≤160 LoC of pure functions). Production gains the four currently-pending diagram renderers; empirical signal for emission-rate-by-kind becomes available within the first regen after merge.
**Alternatives Considered**:
- (a) Adopt `dagre` or `elkjs` for layout. Rejected: 200+ KB bundle bloat for ≤8-node graphs; hand-rolled math is ~80 LoC per primitive and bounded by schema caps.
- (b) Use Mermaid for all four pending primitives. Rejected: F.1 RFC §3.1 (Mermaid empirically dormant at 0/588); same prompt-reliability failure mode would just relocate.
- (c) Component-tests via `@playwright/experimental-ct-react`. Rejected: experimental + clashes with our locked vitest/tailwind config; a Next.js dev route is the cheaper bridge.
- (d) Weighted scalar density metric. Rejected: aggregates hide the per-kind signal that's the whole point of the measurement.
**Principle Audit**:
- **SOLID — Single Responsibility**: each primitive owns one kind's rendering; density metric owns one concern (counting); router owns dispatch only.
- **YAGNI**: no layout libs, no force-directed routing, no auto-routing for arbitrary graphs — schema caps make hand-rolled tractable, hand-rolled is what we build.
- **KISS**: straight-line edges; uniform pitch grids; circular layout for the only-cyclic primitive.
- **Modularity**: six independent files, each a deep module (small public surface = `{ payload }`, all geometry hidden); F.1 contract unchanged.
- **Maintainability**: snapshot tests catch unintended layout drift; per-primitive marker IDs prevent cross-primitive bleed.
- **Performance**: SSR pass renders the SVG inline; zero hydration cost; no `useEffect` measurement; ~30-50 KB bundle add.
**Sources**:
- `kb:architecture/crosscut/single-responsibility` — informed per-primitive file split and density-metric isolation.
- `kb:architecture/crosscut/deep-modules` — informed primitive public-surface design (single `{ payload }` prop, all layout math private).
- `kb:architecture/discipline/error-handling-discipline` — informed defensive missing-node-edge drop; trust the boundary, never re-validate.
- `kb:architecture/discipline/stability-patterns` — informed `DiagramPending` retention as a future-proof fallback (graceful degradation).
- `kb:architecture/ai-systems/evaluation-under-nondeterminism` — informed per-kind density metric (vs weighted scalar) + Playwright snapshot strategy.
- `kb:web-dev/react-essentials` — informed Server Component compatibility (no hooks, no DOM); semantic HTML at the figure level.

---

## KB Sources Consulted

- `kb:architecture/crosscut/single-responsibility` — drove the per-primitive file boundary, the density metric's standalone module location, and the decision to keep router dispatch separate from primitive rendering.
- `kb:architecture/crosscut/deep-modules` — drove the primitives' small public surface (`{ payload }`) and the choice to hide layout math entirely inside each primitive file.
- `kb:architecture/crosscut/information-hiding` — drove the per-primitive `<marker>` ID scoping (`cb-arrow-flow`, `cb-arrow-state`, `cb-arrow-seq-call`, etc.) so marker definitions are internal and can't leak across primitives.
- `kb:architecture/discipline/error-handling-discipline` — drove the "trust the boundary" pattern: primitives never re-validate the schema-checked payload; they defensively drop only data whose referential integrity the schema doesn't enforce (missing-node edges, missing-actor messages).
- `kb:architecture/discipline/stability-patterns` — drove the decision to keep `DiagramPending` in the router (graceful degradation for future schema variants) and to keep the Mermaid escape-hatch distinct from primitive emissions (bulkhead — one path's failure mode doesn't cascade).
- `kb:architecture/ai-systems/evaluation-under-nondeterminism` — drove the per-kind density metric (vs weighted scalar that would hide which primitives the prompt exercises) and the Playwright snapshot strategy (snapshots as regression detectors for visual drift across prompt/brand-token/refactor changes).
- `kb:web-dev/react-essentials` — drove the Server Component compatibility constraint (no hooks, no DOM access, no `'use client'`), the semantic HTML at the `<figure>` level, and the SSR-friendly SVG-inline rendering (no `useEffect`-driven layout measurement).
