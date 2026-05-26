/**
 * src/lib/eval/diagram-density.ts — Sprint F.2 emission-density metric.
 *
 * What this module is:
 * --------------------
 * A pure function that walks a chapter narrative (markdown string) and
 * counts structured-diagram emissions, partitioned by `payload.kind`.
 * Parse failures are tracked separately (negative signal). Mermaid blocks
 * are counted as a sibling field — NOT collapsed into the per-kind sum —
 * so we can see whether the LLM is reaching for the structured-primitive
 * path or falling back to the Mermaid escape-hatch.
 *
 * Why per-kind (not a weighted scalar):
 * -------------------------------------
 * Per RFC §"diagram_block_density_per_chapter metric": a scalar collapses
 * the signal across kinds, but the question we actually want answered is
 * "which primitives is the prompt exercising?". Per-kind answers that
 * directly. Citing `kb:architecture/ai-systems/evaluation-under-non
 * determinism` — measure emission rate by kind, not aggregate.
 *
 * Why a sibling Mermaid count (not collapsed):
 * --------------------------------------------
 * Per F.1 RFC, Mermaid is the explicit escape-hatch (bulkhead, per
 * `kb:architecture/discipline/stability-patterns`). Collapsing Mermaid
 * into `totalValid` would hide the very signal we want to track — is
 * the LLM defaulting to Mermaid for shapes that should be structured?
 *
 * Why reuse parseDiagramBlock (not duplicate):
 * --------------------------------------------
 * `parseDiagramBlock` is the single source of truth for the F.1 contract.
 * Duplicating the JSON.parse + Zod safeParse logic here would let the two
 * diverge silently (a prompt-driven schema relax in one wouldn't propagate
 * to the other). Citing `kb:architecture/crosscut/single-responsibility` —
 * one parser, one home.
 */

import { parseDiagramBlock } from '@/lib/diagrams/parse';

// ─────────────────────────────────────────────────────────────────────────────
// Public shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-chapter emission density. Frozen on return (defense-in-depth against
 * accidental mutation by downstream report renderers).
 */
export interface DiagramDensity {
  byKind: {
    ComparisonTable: number;
    DefinitionList: number;
    DiagramFlow: number;
    StateTransitionDiagram: number;
    SequenceDiagram: number;
    DecisionTree: number;
  };
  /** Sum of byKind values. Never includes parseFailures or mermaidBlocks. */
  totalValid: number;
  /** Count of ```diagram blocks that parseDiagramBlock rejected. */
  parseFailures: number;
  /** Count of ```mermaid blocks. Sibling — NOT collapsed into byKind. */
  mermaidBlocks: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match a fenced code block tagged `diagram` or `mermaid`.
 *
 * Anchors:
 *   - `^```(diagram|mermaid)\s*\n` — opening fence at start-of-line, lang tag,
 *     optional trailing whitespace, newline.
 *   - `([\s\S]*?)`                  — non-greedy body capture.
 *   - `\n```\s*(?=\n|$)`            — closing fence at start-of-line preceded
 *     by newline, with optional trailing whitespace, followed by EOL or EOF.
 *
 * The `m` flag is required so `^` anchors to line boundaries (not just the
 * string start). The lookahead `(?=\n|$)` handles both "block in the middle
 * of a doc" and "block at end-of-file without trailing newline".
 *
 * Note: this regex does NOT support indented fenced blocks (CommonMark
 * allows up to 3 leading spaces). The LLM is prompted to emit at column 0,
 * and `react-markdown` requires column-0 fences anyway — anything indented
 * silently wouldn't render as a code block downstream either.
 */
const BLOCK_RE = /^```(diagram|mermaid)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/gm;

// ─────────────────────────────────────────────────────────────────────────────
// computeDiagramDensity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count structured-diagram emissions per chapter narrative.
 *
 * - Extracts ```diagram and ```mermaid fenced code blocks from markdown.
 * - Routes ```diagram bodies through parseDiagramBlock (reuses F.1 parser).
 * - Counts by payload.kind on successful parses.
 * - Counts parse failures separately (does NOT inflate or deflate emission
 *   rates).
 * - Counts ```mermaid blocks as a sibling field (NOT collapsed into byKind).
 *
 * Returns a frozen DiagramDensity object. Pure function — no side effects.
 */
export function computeDiagramDensity(narrative: string): DiagramDensity {
  const byKind = {
    ComparisonTable: 0,
    DefinitionList: 0,
    DiagramFlow: 0,
    StateTransitionDiagram: 0,
    SequenceDiagram: 0,
    DecisionTree: 0,
  };
  let parseFailures = 0;
  let mermaidBlocks = 0;

  // Reset regex state defensively — global regexes are stateful across
  // calls if the same instance is reused (it is, since BLOCK_RE is
  // module-scoped).
  BLOCK_RE.lastIndex = 0;

  const source = String(narrative ?? '');
  let match: RegExpExecArray | null;
  while ((match = BLOCK_RE.exec(source)) !== null) {
    const lang = match[1];
    // BLOCK_RE always captures both groups when it matches; the strict
    // index-access check requires an explicit fallback for the type system.
    const body = match[2] ?? '';

    if (lang === 'mermaid') {
      mermaidBlocks += 1;
      continue;
    }

    // lang === 'diagram'
    const result = parseDiagramBlock(body);
    if (!result.ok) {
      parseFailures += 1;
      continue;
    }
    byKind[result.payload.kind] += 1;
  }

  const totalValid =
    byKind.ComparisonTable +
    byKind.DefinitionList +
    byKind.DiagramFlow +
    byKind.StateTransitionDiagram +
    byKind.SequenceDiagram +
    byKind.DecisionTree;

  return Object.freeze({
    byKind: Object.freeze(byKind),
    totalValid,
    parseFailures,
    mermaidBlocks,
  }) as DiagramDensity;
}
