// src/lib/ingest/classifier.ts — TOC outline-entry classifier.
//
// Phase 1 of the lazy-hybrid-chunking ingest pipeline. Takes the flat outline
// from pdfjs and labels each entry as one of:
//   - 'body'         → real chapter content; generates a tutorial
//   - 'front-matter' → cover / preface / foreword / ack / TOC / copyright
//   - 'appendix'     → "Appendix A", "Appendix B", … (on-demand only)
//   - 'glossary'     → glossary / symbols / notation
//   - 'bibliography' → references / index / bibliography
//
// Two-tier classification:
//   Tier 1: regex pass — case-insensitive title matching. Free, deterministic.
//           Catches ~90% of entries in typical commercial textbooks.
//   Tier 2: 4o-mini LLM batch — for any entry the regex couldn't classify,
//           batch all of them into ONE call (so cost stays trivial). Returns
//           one label per ambiguous title.
//
// Default for un-classifiable entries: 'body' (fail-open — we'd rather generate
// an unnecessary tutorial than skip real content).
//
// Design anchors:
//   - kb:architecture/discipline/error-handling-discipline §"Pattern 3" —
//     classify-at-the-boundary, errors-defined-out via the exhaustive label
//     union. Downstream chunker matches on the label union, never re-checks.
//   - kb:architecture/crosscut/single-responsibility — this module ONLY
//     decides the label. Building chunks, walking the tree, slicing
//     paragraphs — all live in chunker.ts.

import { openai } from '@/lib/openai/client';
import { withRetry } from '@/lib/openai/_retry';
import type { PdfOutlineEntry } from '@/lib/pdf/parse';

// ───────────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────────

export type OutlineClassification =
  | 'body'
  | 'front-matter'
  | 'appendix'
  | 'glossary'
  | 'bibliography';

export interface ClassifiedOutlineEntry extends PdfOutlineEntry {
  classification: OutlineClassification;
  /** True if the LLM (not regex) decided the label. Used by audit logs. */
  classifiedByLLM: boolean;
}

export interface ClassifyResult {
  entries: ClassifiedOutlineEntry[];
  /** Total ambiguous entries that needed LLM resolution. ≤ entries.length. */
  llmResolvedCount: number;
  /** Schema version of THIS classifier; bump when regex set or LLM prompt changes. */
  classificationVersion: number;
}

export const CLASSIFICATION_VERSION = 1;

// ───────────────────────────────────────────────────────────────────────────
// Tier 1: regex pass
// ───────────────────────────────────────────────────────────────────────────

/**
 * Regex patterns, applied in order. First match wins. Anchored ^...$ on a
 * lowercased + trimmed title. Patterns are intentionally conservative — broad
 * patterns would over-classify and skip real chapters.
 *
 * Adding patterns is safe; removing them needs care (existing rows could
 * be reclassified next time `outline_classification_version` is bumped).
 */
const REGEX_PATTERNS: Array<{ re: RegExp; label: OutlineClassification }> = [
  // ── front-matter ──────────────────────────────────────────────────────
  { re: /^(?:title\s*page|half[-\s]?title|frontispiece)$/i, label: 'front-matter' },
  { re: /^(?:cover|cover\s+page)$/i, label: 'front-matter' },
  { re: /^(?:copyright|colophon|imprint|legal\s*notice)$/i, label: 'front-matter' },
  { re: /^(?:dedication|epigraph)$/i, label: 'front-matter' },
  { re: /^(?:foreword|preface|introduction\s+(?:to|by)\s+)/i, label: 'front-matter' },
  { re: /^acknowled[gm]ements?$/i, label: 'front-matter' },
  { re: /^(?:about\s+the\s+(?:author|book|cover)|author['']s\s+note)/i, label: 'front-matter' },
  { re: /^(?:table\s+of\s+contents|contents|toc)$/i, label: 'front-matter' },
  { re: /^(?:list\s+of\s+(?:figures|tables|illustrations))$/i, label: 'front-matter' },
  { re: /^(?:how\s+to\s+(?:use|read)\s+this\s+book)/i, label: 'front-matter' },
  // ── appendix ──────────────────────────────────────────────────────────
  // Match "Appendix", "Appendix A", "Appendix A: ...", "Appendix 1", "Appendices"
  { re: /^appendi(?:x|ces)(?:\s+(?:[a-z]|\d+))?(?:[:\.\s]|$)/i, label: 'appendix' },
  // ── glossary ──────────────────────────────────────────────────────────
  { re: /^(?:glossary|symbols?|notation|nomenclature|definitions?)$/i, label: 'glossary' },
  { re: /^(?:list\s+of\s+(?:symbols?|abbreviations|acronyms))/i, label: 'glossary' },
  // ── bibliography / index ──────────────────────────────────────────────
  { re: /^(?:bibliography|references|further\s+reading|works\s+cited)$/i, label: 'bibliography' },
  { re: /^(?:index|subject\s+index|author\s+index)$/i, label: 'bibliography' },
  { re: /^(?:end\s*notes?|footnotes?|sources)$/i, label: 'bibliography' },
];

/**
 * Apply the regex tier. Returns the label, or null if nothing matched
 * (caller's signal to escalate to LLM).
 *
 * Pure function — easy to unit test (Commit 3 test scope).
 */
export function classifyByRegex(title: string): OutlineClassification | null {
  if (typeof title !== 'string') return null;
  const t = title.trim();
  if (t.length === 0) return null;
  for (const { re, label } of REGEX_PATTERNS) {
    if (re.test(t)) return label;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Tier 2: LLM batch fallback (4o-mini)
// ───────────────────────────────────────────────────────────────────────────

/** Hardcoded model for this support call — NOT the env-configured one. */
const CLASSIFIER_MODEL = 'gpt-4o-mini';

const CLASSIFIER_SYSTEM_PROMPT = `You classify textbook table-of-contents entries into one of five labels:
- "body": real chapter content (e.g., "Chapter 5", "Part II", "5.1 Foo Bar")
- "front-matter": cover / preface / foreword / acknowledgements / table of contents / dedication / "about the author"
- "appendix": an appendix entry that supplements the main content
- "glossary": glossary, list of symbols, notation key
- "bibliography": references, index, end-notes, "further reading"

When uncertain between body and front/back matter, default to "body". Output STRICT JSON only.`;

interface LLMClassifyInput {
  /** Index into the original ambiguous list — preserves the join key on the output. */
  idx: number;
  title: string;
}

interface LLMClassifyOutput {
  idx: number;
  label: OutlineClassification;
}

/**
 * Send a batch of ambiguous titles to 4o-mini in ONE call. Returns one label
 * per input idx. The structured output schema enforces the union type.
 *
 * Cost projection: ~50 tokens per entry × 10 ambiguous entries = ~500 tokens
 * input + ~200 tokens output ≈ $0.001 per book. Well under any budget.
 */
async function classifyBatchViaLLM(
  ambiguous: LLMClassifyInput[],
): Promise<Map<number, OutlineClassification>> {
  if (ambiguous.length === 0) return new Map();

  const userPrompt =
    `Classify each entry below. Output a JSON object {"results": [{"idx": <int>, "label": <one of body|front-matter|appendix|glossary|bibliography>}]}.\n\n` +
    `Entries:\n` +
    ambiguous.map((a) => `  ${a.idx}. ${a.title}`).join('\n');

  // DRIFT-test3-032: wrap in shared retry. A 429 here previously threw to
  // the orchestrator's catch-block and defaulted the WHOLE batch to 'body'
  // (which over-emits chunks for front-matter / appendices / glossary).
  // With retry, transient 429s get 3 attempts before the fail-open kicks in.
  const response = await withRetry({
    operationName: 'classifier',
    fn: async () =>
      openai.chat.completions.create({
        model: CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 2000,
        temperature: 0,
      }),
  });

  const text = response.choices[0]?.message?.content ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Fail-open: log + default everything to 'body'. This is the safest
    // failure mode — we'd rather generate too much than skip real chapters.
    // eslint-disable-next-line no-console
    console.error('[classifier] LLM JSON.parse failed:', (err as Error).message);
    const fallback = new Map<number, OutlineClassification>();
    for (const a of ambiguous) fallback.set(a.idx, 'body');
    return fallback;
  }

  const out = new Map<number, OutlineClassification>();
  const o = parsed as { results?: unknown };
  if (Array.isArray(o.results)) {
    for (const r of o.results as LLMClassifyOutput[]) {
      if (typeof r?.idx === 'number' && isValidLabel(r.label)) {
        out.set(r.idx, r.label);
      }
    }
  }
  // Anything the LLM forgot to label, default to 'body'.
  for (const a of ambiguous) {
    if (!out.has(a.idx)) out.set(a.idx, 'body');
  }
  return out;
}

function isValidLabel(x: unknown): x is OutlineClassification {
  return (
    x === 'body' ||
    x === 'front-matter' ||
    x === 'appendix' ||
    x === 'glossary' ||
    x === 'bibliography'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestrator
// ───────────────────────────────────────────────────────────────────────────

/**
 * Classify every outline entry. Two-pass: regex first, LLM batch for the
 * residual.
 *
 * Determinism note: the regex pass is fully deterministic; the LLM pass uses
 * temperature=0 so it's near-deterministic per (input, model, model-snapshot).
 * For absolute determinism (replayable across model snapshots), cache by
 * (pdf_sha256, classifier_version) — see worker.ts integration.
 *
 * Failure semantics: if the LLM call throws (network, rate limit, etc.),
 * we fail-open and label the residual as 'body'. Never throws.
 */
export async function classifyOutline(
  outline: PdfOutlineEntry[],
): Promise<ClassifyResult> {
  // Tier 1: regex
  const partial: Array<ClassifiedOutlineEntry | { idx: number; title: string }> = [];
  const ambiguous: LLMClassifyInput[] = [];

  for (let i = 0; i < outline.length; i++) {
    const entry = outline[i];
    if (!entry) continue;
    const label = classifyByRegex(entry.title);
    if (label !== null) {
      partial.push({ ...entry, classification: label, classifiedByLLM: false });
    } else {
      // Defer to LLM; preserve order via the idx key.
      ambiguous.push({ idx: i, title: entry.title });
      partial.push({ idx: i, title: entry.title });
    }
  }

  // Tier 2: LLM batch (only if anything is ambiguous)
  let llmLabels = new Map<number, OutlineClassification>();
  if (ambiguous.length > 0) {
    try {
      llmLabels = await classifyBatchViaLLM(ambiguous);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[classifier] LLM batch failed; falling back to body:', err);
      for (const a of ambiguous) llmLabels.set(a.idx, 'body');
    }
  }

  // Stitch labeled entries back together preserving order.
  const out: ClassifiedOutlineEntry[] = [];
  for (let i = 0; i < outline.length; i++) {
    const entry = outline[i];
    if (!entry) continue;
    const regexLabel = classifyByRegex(entry.title);
    if (regexLabel !== null) {
      out.push({ ...entry, classification: regexLabel, classifiedByLLM: false });
    } else {
      const llmLabel = llmLabels.get(i) ?? 'body';
      out.push({ ...entry, classification: llmLabel, classifiedByLLM: true });
    }
  }

  return {
    entries: out,
    llmResolvedCount: ambiguous.length,
    classificationVersion: CLASSIFICATION_VERSION,
  };
}
