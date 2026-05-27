// src/lib/citations/adjacent-pair-gate.ts — Q3 v3 adjacent-pair citation gate (soft metric).
//
// SI-citation-pair-laundering-001 — Negative-framing prompts can canonicalize
// the equivalent pedagogical lie in an adjacent shape. PR #40's Q3 v2 banned
// `[ref:pageN:paragraphM-K]` range syntax (13% emission → 0%). The persona
// re-walk on 2026-05-26 (Theo CRITICAL finding) discovered the model "listened"
// — and the same multi-paragraph anchoring is now expressed as adjacent ref
// tokens like `[ref:page42:paragraph6][ref:page42:paragraph21]` (14 uncited
// paragraphs between, same pedagogical lie at the chip-UI level). ch56 even
// produces cross-page pairs like `[ref:page261:paragraph22][ref:page263:paragraph2]`.
//
// This module is OBSERVABILITY-only in v1. It detects two violation kinds:
//   - 'cross-page'         — adjacent refs on different pages (likely span hallucination)
//   - 'same-page-gap-gt-2' — adjacent refs on the same page with |Δparagraph| > 2
//
// The penaltyScore in [0, 1] is persisted as a soft fidelity signal alongside
// chapter_fidelity_scores. A later PR (Q3 v4) will promote this to a hard
// rejection/retry gate once we have enough production-traffic data to set
// thresholds with confidence.
//
// Pure function. No I/O. The wiring code in per-chapter.ts is the only place
// that touches DB/log.

/** Canonical ref token shape: `[ref:pageN:paragraphM]` with positive integers. */
const REF_TOKEN_REGEX = /\[ref:page(\d+):paragraph(\d+)\]/g;

/**
 * Maximum number of characters allowed between the `]` of refA and the `[` of
 * refB for them to count as an "adjacent pair". Per spec: the prompt instructs
 * the model to emit `[refA][refB]` with NO separator, so the strictest check
 * is "zero chars between." The 5-char tolerance is defensive: allows trivial
 * inline punctuation/whitespace (`. `, `, `, `; `, single space) without
 * crossing a sentence boundary.
 */
const ADJACENT_MAX_GAP_CHARS = 5;

/**
 * Same-page paragraph gap that's allowed without flagging a violation. Two refs
 * to consecutive paragraphs (gap=1) or paragraphs one apart (gap=2) is a
 * legitimate "this sentence draws from these two adjacent paragraphs" pattern.
 * gap > 2 = the model is laundering a wider span into a pair.
 */
const SAME_PAGE_MAX_GAP = 2;

/**
 * Characters allowed between adjacent refs (besides whitespace). Anything else
 * means a sentence-like break (alphanumerics, em-dash, etc.) so the pair is
 * not actually "adjacent" from a reader's perspective.
 */
const ALLOWED_INTER_REF_CHARS = new Set([' ', '\t', '\n', '\r', '.', ',', ';']);

export interface AdjacentPairViolation {
  /** 0-indexed position in the narrative where the FIRST ref of the pair starts. */
  startOffset: number;
  /** 0-indexed position immediately AFTER the second ref. */
  endOffset: number;
  /** The two refs as parsed. */
  refA: { page: number; paragraph: number };
  refB: { page: number; paragraph: number };
  /** Kind of violation. Cross-page takes precedence over same-page gap. */
  kind: 'cross-page' | 'same-page-gap-gt-2';
  /** Numeric absolute gap: |paragraphB - paragraphA| on same page; NaN cross-page. */
  gap: number;
  /** The verbatim text of the pair (e.g. `[ref:page42:paragraph3][ref:page42:paragraph8]`). */
  text: string;
}

export interface AdjacentPairGateResult {
  totalRefs: number;
  adjacentPairs: number;
  violations: AdjacentPairViolation[];
  /**
   * Fidelity penalty score in [0, 1] where 0 = clean, 1 = catastrophic spray.
   *
   * Computation: violations / max(totalRefs / 2, 1) capped at 1.0.
   *
   * Rationale: in a totally-adjacent-pair narrative, every other ref is part
   * of a violation, so the denominator is totalRefs / 2. Capped at 1.0 to keep
   * the score interpretable as a [0, 1] penalty. When totalRefs is 0 we
   * return 0 (no signal, no penalty).
   */
  penaltyScore: number;
}

interface ParsedRef {
  page: number;
  paragraph: number;
  /** Inclusive start offset of the `[`. */
  start: number;
  /** Exclusive end offset (one past the `]`). */
  end: number;
  /** Verbatim token text. */
  text: string;
}

/**
 * Parse every canonical ref token from the narrative in source order.
 * Tokens that don't match the canonical regex are ignored (defensive — bad
 * refs are a different gate's responsibility).
 */
function parseRefs(narrative: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  // Reset the global regex's lastIndex by constructing a fresh one — using the
  // module-level REF_TOKEN_REGEX directly would leak state between calls.
  const re = new RegExp(REF_TOKEN_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(narrative)) !== null) {
    const pageStr = match[1];
    const paragraphStr = match[2];
    if (pageStr === undefined || paragraphStr === undefined) continue;
    const page = Number.parseInt(pageStr, 10);
    const paragraph = Number.parseInt(paragraphStr, 10);
    if (!Number.isFinite(page) || !Number.isFinite(paragraph)) continue;
    refs.push({
      page,
      paragraph,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }
  return refs;
}

/**
 * True iff the substring between refA's `]` and refB's `[` consists ONLY of
 * whitespace and minimal punctuation, AND is no longer than ADJACENT_MAX_GAP_CHARS.
 * Alphanumeric content between the refs indicates a sentence break — not a pair.
 */
function isAdjacent(narrative: string, refAEnd: number, refBStart: number): boolean {
  const gap = refBStart - refAEnd;
  if (gap < 0) return false; // refs overlap — shouldn't happen with canonical tokens
  if (gap > ADJACENT_MAX_GAP_CHARS) return false;
  for (let i = refAEnd; i < refBStart; i++) {
    const ch = narrative.charAt(i);
    if (!ALLOWED_INTER_REF_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * Q3 v3 detector — pure function. Returns counts + violations + soft penalty.
 *
 * @example
 *   detectAdjacentPairViolations(
 *     'Foo [ref:page42:paragraph3][ref:page42:paragraph15] bar.'
 *   )
 *   // → { totalRefs: 2, adjacentPairs: 1, violations: [{ kind: 'same-page-gap-gt-2', gap: 12, ... }], penaltyScore: 1.0 }
 */
export function detectAdjacentPairViolations(narrative: string): AdjacentPairGateResult {
  const refs = parseRefs(narrative);
  const totalRefs = refs.length;

  if (totalRefs < 2) {
    return { totalRefs, adjacentPairs: 0, violations: [], penaltyScore: 0 };
  }

  const violations: AdjacentPairViolation[] = [];
  let adjacentPairs = 0;

  // Walk pairs in source order. A ref can participate in at most ONE pair
  // (with its successor) — we count each pair once even in spray-runs like
  // [a][b][c] (counted as one pair (a,b) AND one pair (b,c)). This matches
  // the spray-cost intuition: a 3-ref spray is "worse" than a 2-ref pair.
  for (let i = 0; i < refs.length - 1; i++) {
    const refA = refs[i];
    const refB = refs[i + 1];
    if (!refA || !refB) continue; // satisfies noUncheckedIndexedAccess
    if (!isAdjacent(narrative, refA.end, refB.start)) continue;

    adjacentPairs += 1;

    const crossPage = refA.page !== refB.page;
    const gap = crossPage ? Number.NaN : Math.abs(refB.paragraph - refA.paragraph);

    if (crossPage) {
      violations.push({
        startOffset: refA.start,
        endOffset: refB.end,
        refA: { page: refA.page, paragraph: refA.paragraph },
        refB: { page: refB.page, paragraph: refB.paragraph },
        kind: 'cross-page',
        gap,
        text: narrative.slice(refA.start, refB.end),
      });
    } else if (gap > SAME_PAGE_MAX_GAP) {
      violations.push({
        startOffset: refA.start,
        endOffset: refB.end,
        refA: { page: refA.page, paragraph: refA.paragraph },
        refB: { page: refB.page, paragraph: refB.paragraph },
        kind: 'same-page-gap-gt-2',
        gap,
        text: narrative.slice(refA.start, refB.end),
      });
    }
  }

  // Penalty: violations / max(totalRefs / 2, 1), capped at 1.0. The /2 reflects
  // that a fully-spray narrative has every-other ref starting a violating pair.
  const denominator = Math.max(totalRefs / 2, 1);
  const rawPenalty = violations.length / denominator;
  const penaltyScore = Math.min(rawPenalty, 1);

  return { totalRefs, adjacentPairs, violations, penaltyScore };
}
