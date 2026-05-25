// src/lib/diagrams/schema.ts — Sprint F.1 structured-figures schema.
//
// What this module is:
// --------------------
// The contract boundary between the LLM's narrative emission and the
// React render path for in-narrative diagrams. The LLM emits a fenced
// ```diagram block whose body MUST parse as JSON matching this schema;
// the renderer dispatches on `kind` to one of the six primitive React
// components in src/components/diagrams/.
//
// Why Zod (not bare TypeScript types):
// ------------------------------------
// The LLM is untrusted input at this boundary — even structured-output
// JSON-schema response_format doesn't validate content INSIDE a fenced
// block embedded inside the narrative string. So the JSON arrives as a
// raw string, and we MUST validate at parse-time. This matches the
// `kb:architecture/discipline/error-handling-discipline §"Pattern 3"`
// pattern used widely in this codebase (src/lib/ingest/classifier.ts:22,
// src/lib/openai/_retry.ts:27, src/lib/types.ts:13, etc.): classify at
// the boundary, errors-defined-out via discriminated unions, the interior
// never re-checks.
//
// Why six primitives (not fewer, not more):
// -----------------------------------------
// Sprint F architect RFC §3.1: empirical signal that the LLM is reliable
// at structured JSON when the shape is constrained, AND that ~85% of
// textbook diagrams fall into one of six clusters (comparison tables,
// definition lists, pipelines, state machines, sequence diagrams, decision
// trees). Fewer primitives leaves gaps; more primitives violates YAGNI
// (`kb:architecture/crosscut/single-responsibility` — each primitive has
// one reason to change). The remaining ~15% routes to the Mermaid escape-
// hatch via the existing language-mermaid slot in ChapterRenderer.
//
// Field-naming convention:
// ------------------------
// Match the FIDELITY rule 9 prompt text byte-for-byte. The LLM is trained
// to emit the names it sees in the prompt; any drift here vs. the prompt
// breaks emission silently. Test fixture rule: every example JSON in
// rule 9 must round-trip through one of these schemas without warning.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared constraints — applied across multiple primitive shapes.
// ---------------------------------------------------------------------------
//
// Label length cap: ≤3 words enforced as ≤32 chars (rough proxy that's
// easier to validate than tokenizing words). Matches the FIDELITY rule 9
// guidance ("Node/state/actor labels must be SHORT").
//
// Title / caption: optional everywhere; capped at 120 chars so a verbose
// LLM caption can't blow up the rendered figure's chrome. Trimmed of
// surrounding whitespace at parse-time.

const ShortLabel = z
  .string()
  .min(1, { message: 'label must be non-empty' })
  .max(32, { message: 'label must be ≤32 chars (~3 words; renderer truncates beyond)' })
  .transform((s) => s.trim());

const TitleString = z
  .string()
  .max(120, { message: 'title must be ≤120 chars' })
  .transform((s) => s.trim())
  .optional();

const NodeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: 'node id must be alphanumeric + underscore/hyphen',
  });

// ---------------------------------------------------------------------------
// Primitive 1 — ComparisonTable
// ---------------------------------------------------------------------------
//
// Two-N column comparison with row data. Renders to semantic <table> with
// <caption>, <thead>, <tbody> for screen-reader navigability. Pure HTML;
// no SVG geometry.
//
// rows is an array of objects keyed by column name (NOT positional
// arrays). Rationale: the LLM emits objects naturally and the renderer
// can defensively skip a missing cell rather than mis-align by index if
// the LLM drops a column.

const ComparisonTableSchema = z.object({
  kind: z.literal('ComparisonTable'),
  title: TitleString,
  columns: z
    .array(ShortLabel)
    .min(2, { message: 'ComparisonTable needs ≥2 columns' })
    .max(6, { message: 'ComparisonTable supports ≤6 columns; consider splitting' }),
  rows: z
    .array(z.record(z.string()))
    .min(1, { message: 'ComparisonTable needs ≥1 row' })
    .max(20, { message: 'ComparisonTable supports ≤20 rows; consider splitting' }),
});

// ---------------------------------------------------------------------------
// Primitive 2 — DefinitionList
// ---------------------------------------------------------------------------
//
// Term/definition pairs. Renders to semantic <dl><dt><dd>. Common in
// CLRS glossary sections, DDIA "key concepts" lists.

const DefinitionListSchema = z.object({
  kind: z.literal('DefinitionList'),
  title: TitleString,
  items: z
    .array(
      z.object({
        term: z.string().min(1).max(80).transform((s) => s.trim()),
        definition: z.string().min(1).max(400).transform((s) => s.trim()),
      }),
    )
    .min(2, { message: 'DefinitionList needs ≥2 items' })
    .max(15, { message: 'DefinitionList supports ≤15 items; consider splitting' }),
});

// ---------------------------------------------------------------------------
// Primitive 3 — DiagramFlow
// ---------------------------------------------------------------------------
//
// Left-to-right or top-to-bottom pipeline of nodes with directed edges.
// Capped at 7 nodes / 12 edges to keep layout tractable (RFC §7 R3).

const DiagramFlowNodeKind = z.enum(['start', 'process', 'decision', 'end']);

const DiagramFlowSchema = z.object({
  kind: z.literal('DiagramFlow'),
  title: TitleString,
  direction: z.enum(['LR', 'TB']).default('LR'),
  nodes: z
    .array(
      z.object({
        id: NodeId,
        label: ShortLabel,
        kind: DiagramFlowNodeKind.optional(),
      }),
    )
    .min(2, { message: 'DiagramFlow needs ≥2 nodes' })
    .max(7, { message: 'DiagramFlow supports ≤7 nodes; consider splitting or using Mermaid' }),
  edges: z
    .array(
      z.object({
        from: NodeId,
        to: NodeId,
        label: z.string().min(1).max(24).optional(),
      }),
    )
    .min(1)
    .max(12),
});

// ---------------------------------------------------------------------------
// Primitive 4 — StateTransitionDiagram
// ---------------------------------------------------------------------------

const StateTransitionDiagramSchema = z.object({
  kind: z.literal('StateTransitionDiagram'),
  title: TitleString,
  states: z
    .array(
      z.object({
        id: NodeId,
        label: ShortLabel,
        initial: z.boolean().optional(),
        terminal: z.boolean().optional(),
      }),
    )
    .min(2, { message: 'StateTransitionDiagram needs ≥2 states' })
    .max(8, { message: 'StateTransitionDiagram supports ≤8 states' }),
  transitions: z
    .array(
      z.object({
        from: NodeId,
        to: NodeId,
        trigger: z.string().min(1).max(32).optional(),
      }),
    )
    .min(1)
    .max(16),
});

// ---------------------------------------------------------------------------
// Primitive 5 — SequenceDiagram
// ---------------------------------------------------------------------------

const SequenceMessageKind = z.enum(['call', 'return', 'async']);

const SequenceDiagramSchema = z.object({
  kind: z.literal('SequenceDiagram'),
  title: TitleString,
  actors: z
    .array(ShortLabel)
    .min(2, { message: 'SequenceDiagram needs ≥2 actors' })
    .max(6, { message: 'SequenceDiagram supports ≤6 actors' }),
  messages: z
    .array(
      z.object({
        from: ShortLabel,
        to: ShortLabel,
        label: z.string().min(1).max(40),
        kind: SequenceMessageKind.optional(),
      }),
    )
    .min(1)
    .max(20),
});

// ---------------------------------------------------------------------------
// Primitive 6 — DecisionTree
// ---------------------------------------------------------------------------
//
// Recursive structure: each internal node has a `question` and `yes`/`no`
// branches; each leaf has a single `leaf` field. We use a recursive Zod
// schema (`z.lazy`) so depth is unbounded in the type but bounded in
// practice by a max-depth check at parse-time (see parse.ts).

type DecisionTreeNode =
  | { leaf: string }
  | {
      question: string;
      yes: DecisionTreeNode;
      no: DecisionTreeNode;
    };

const DecisionTreeNodeSchema: z.ZodType<DecisionTreeNode> = z.lazy(() =>
  z.union([
    z.object({
      leaf: z.string().min(1).max(80).transform((s) => s.trim()),
    }),
    z.object({
      question: z.string().min(1).max(120).transform((s) => s.trim()),
      yes: DecisionTreeNodeSchema,
      no: DecisionTreeNodeSchema,
    }),
  ]),
);

const DecisionTreeSchema = z.object({
  kind: z.literal('DecisionTree'),
  title: TitleString,
  root: DecisionTreeNodeSchema,
});

// ---------------------------------------------------------------------------
// Discriminated union — the public schema parse.ts validates against.
// ---------------------------------------------------------------------------

export const DiagramPayloadSchema = z.discriminatedUnion('kind', [
  ComparisonTableSchema,
  DefinitionListSchema,
  DiagramFlowSchema,
  StateTransitionDiagramSchema,
  SequenceDiagramSchema,
  DecisionTreeSchema,
]);

export type DiagramPayload = z.infer<typeof DiagramPayloadSchema>;
export type ComparisonTablePayload = z.infer<typeof ComparisonTableSchema>;
export type DefinitionListPayload = z.infer<typeof DefinitionListSchema>;
export type DiagramFlowPayload = z.infer<typeof DiagramFlowSchema>;
export type StateTransitionDiagramPayload = z.infer<typeof StateTransitionDiagramSchema>;
export type SequenceDiagramPayload = z.infer<typeof SequenceDiagramSchema>;
export type DecisionTreePayload = z.infer<typeof DecisionTreeSchema>;
export type { DecisionTreeNode };

// ---------------------------------------------------------------------------
// Exported sub-schemas (for tests + type-narrowing in primitives).
// ---------------------------------------------------------------------------

export {
  ComparisonTableSchema,
  DefinitionListSchema,
  DiagramFlowSchema,
  StateTransitionDiagramSchema,
  SequenceDiagramSchema,
  DecisionTreeSchema,
  DecisionTreeNodeSchema,
};
