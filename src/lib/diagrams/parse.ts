// src/lib/diagrams/parse.ts — Sprint F.1 structured-figure parser.
//
// Contract:
//   parseDiagramBlock(rawJSON: string) → ParseResult
//   ParseResult = { ok: true, payload: DiagramPayload }
//               | { ok: false, error: { code, message, raw } }
//
// Never throws. Errors are values (kb:architecture/discipline/error-handling
// -discipline §"Pattern 7"). The caller (DiagramBlock.tsx) routes ok=true
// payloads to the right primitive component and renders ok=false errors as
// a brand-themed source-text fallback with a warn-styled caption (same
// shape MermaidDiagram.tsx:144-155 uses).
//
// Why a custom Result type vs throwing:
// -------------------------------------
// DiagramBlock is a React component rendered server-side. A thrown error
// in the render pass aborts the entire chapter render and surfaces as
// either a hard SSR failure or a hydration mismatch. Returning a Result
// keeps the failure local to the one block and lets the chapter render
// continue. Matches the pattern at src/lib/openai/_retry.ts:27 (errors as
// typed values, never as control flow).

import { DiagramPayloadSchema, type DiagramPayload } from './schema';

/**
 * Result of parsing a ```diagram block body.
 *
 * Use the discriminator `ok` to narrow:
 *   if (result.ok) { result.payload }     // typed as DiagramPayload
 *   else            { result.error.message }
 */
export type ParseResult =
  | { ok: true; payload: DiagramPayload }
  | { ok: false; error: ParseError };

export type ParseError = {
  /** Stable machine-readable error code (for log/metric grouping). */
  code: 'invalid_json' | 'invalid_shape' | 'invalid_recursive_depth' | 'empty_input';
  /** Operator-facing message; safe to surface in the source-text fallback. */
  message: string;
  /** First 200 chars of the input the LLM emitted (truncated, for debug). */
  raw: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum recursive depth allowed for DecisionTree.root. 8 levels of
 * branching is enough for any pedagogical decision tree; beyond that the
 * diagram is unreadable. Caps the worst-case render cost + protects
 * against runaway recursion from a misbehaving LLM emission.
 */
const MAX_DECISION_TREE_DEPTH = 8;

/**
 * Truncation cap on the raw input echoed back in error.raw. Long enough
 * to be diagnostic (a typo, an unclosed brace), short enough to fit
 * comfortably in a warn-bordered caption.
 */
const RAW_TRUNCATE_CHARS = 200;

// ---------------------------------------------------------------------------
// parseDiagramBlock
// ---------------------------------------------------------------------------

export function parseDiagramBlock(rawJSON: string): ParseResult {
  const input = String(rawJSON ?? '').trim();
  const rawTruncated = truncate(input, RAW_TRUNCATE_CHARS);

  if (input.length === 0) {
    return {
      ok: false,
      error: {
        code: 'empty_input',
        message: 'diagram block body is empty',
        raw: rawTruncated,
      },
    };
  }

  // Step 1: parse JSON. JSON.parse throws on syntax errors; we catch and
  // convert to a Result. The thrown SyntaxError's `message` is usually
  // operator-readable ("Unexpected token } in JSON at position 47"); we
  // preserve it. We deliberately do NOT attempt to repair malformed JSON
  // (e.g., trailing-comma tolerance) — that would mask LLM emission bugs
  // we want to see and tighten the prompt for, per RFC §7 R2.
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'invalid_json',
        message:
          err instanceof Error
            ? `invalid JSON: ${err.message}`
            : 'invalid JSON (unknown parse error)',
        raw: rawTruncated,
      },
    };
  }

  // Step 2: shape validation via Zod discriminated union. The schema
  // enforces the per-primitive constraints (column count, node count,
  // label length, etc.). Zod's safeParse returns a typed result with
  // structured error issues; we flatten to a single user-facing message.
  const result = DiagramPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues;
    const summary =
      issues.length === 0
        ? 'invalid diagram shape (no specific issue)'
        : issues
            .slice(0, 3) // cap; deeper issues are usually follow-on from the first
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; ');
    return {
      ok: false,
      error: {
        code: 'invalid_shape',
        message: `invalid diagram shape: ${summary}`,
        raw: rawTruncated,
      },
    };
  }

  // Step 3: extra runtime check for DecisionTree depth (Zod's recursive
  // schema can't express depth limits declaratively).
  if (result.data.kind === 'DecisionTree') {
    const depth = decisionTreeDepth(result.data.root, 0);
    if (depth > MAX_DECISION_TREE_DEPTH) {
      return {
        ok: false,
        error: {
          code: 'invalid_recursive_depth',
          message: `DecisionTree depth ${depth} exceeds max ${MAX_DECISION_TREE_DEPTH}`,
          raw: rawTruncated,
        },
      };
    }
  }

  return { ok: true, payload: result.data };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Walk a DecisionTreeNode and return its max depth. A leaf has depth 0;
 * an internal node's depth is 1 + max(yes.depth, no.depth). Iterative
 * traversal would be slightly more robust but recursive is clearer at
 * this size (≤8 nodes per the schema cap).
 */
function decisionTreeDepth(node: unknown, soFar: number): number {
  if (!node || typeof node !== 'object') return soFar;
  if ('leaf' in node) return soFar;
  if ('question' in node) {
    const yesDepth = decisionTreeDepth((node as { yes: unknown }).yes, soFar + 1);
    const noDepth = decisionTreeDepth((node as { no: unknown }).no, soFar + 1);
    return Math.max(yesDepth, noDepth);
  }
  return soFar;
}
