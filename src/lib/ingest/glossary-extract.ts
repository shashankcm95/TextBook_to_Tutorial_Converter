// src/lib/ingest/glossary-extract.ts — 4o-mini side-asset extractor.
//
// Phase 3 of the lazy-hybrid-chunking ingest pipeline. Reads the paragraphs
// from a `glossary`-classified outline section and asks 4o-mini to extract
// {term, definition, source_paragraph_ref} tuples.
//
// Why 4o-mini (not 4o):
//   - The work is shallow: pattern-match "term — definition" or "TERM. Def."
//     paragraphs. No deep reasoning required.
//   - Cost: a typical glossary is 20-50 terms × ~50 tokens = 1-2.5K input
//     tokens. 4o-mini handles it for under $0.001.
//
// Why this is a separate pass (not folded into the narrative gen):
//   - Glossary lookups are CROSS-chapter — chapter 7's chunk benefits from
//     having "ACID" or "CAP" definitions available even though they may have
//     been introduced in chapter 2's glossary.
//   - The side-asset architecture lets the citation modal (in ChapterRenderer)
//     surface a term tooltip without re-fetching chapter 2's content.
//
// Design anchors:
//   - kb:architecture/crosscut/single-responsibility — this module's ONE
//     change-pressure is the glossary extraction prompt + parsing. Chunker
//     decides WHICH paragraphs go in; this decides WHAT to pull out.
//   - kb:architecture/ai-systems/inference-cost-management §"Lever 1: Model
//     selection" — pick the cheapest model that solves the problem.

import { openai } from '@/lib/openai/client';
import { withRetry } from '@/lib/openai/_retry';
import type { SourceParagraph } from '@/lib/types';
import { formatRef } from '@/lib/pdf/paragraph-anchors';
import type { GlossarySection } from './chunker';
import type { GlossaryArtifact } from '@/lib/s3-chunks';

const EXTRACT_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `You extract glossary entries from textbook text. The input is a list of paragraphs from a glossary section (each tagged with a paragraph_ref like "page12:paragraph3"). For each paragraph that defines a single term, emit one JSON object with:
- term: the term being defined (short noun phrase, lowercased unless proper noun)
- definition: the definition (one-sentence summary, max 200 chars)
- source_paragraph_ref: the paragraph_ref where the term is defined

Skip paragraphs that:
- are headings ("Glossary", "List of Symbols")
- list cross-references without a definition
- define multiple unrelated terms (ambiguous attribution)

Output STRICT JSON of shape {"terms": [{term, definition, source_paragraph_ref}]}.`;

interface ExtractedTerm {
  term: string;
  definition: string;
  sourceParagraphRef: string;
}

/**
 * Run the LLM extraction over one or more glossary sections.
 *
 * Failure semantics: if the LLM call throws or returns unparseable JSON, we
 * return an empty terms array AND log to stderr. This is fail-open per the
 * v1 policy — glossary is a nice-to-have side-asset; missing it shouldn't
 * fail the whole ingest.
 *
 * @returns A GlossaryArtifact ready to be written to S3 + glossary_terms rows
 *          inserted into the DB by the caller.
 */
export async function extractGlossaryFromSections(
  sections: GlossarySection[],
): Promise<GlossaryArtifact> {
  if (sections.length === 0) {
    return { schemaVersion: 1, terms: [] };
  }

  // Flatten all paragraphs across sections, preserve the ref shape.
  const rows: string[] = [];
  for (const section of sections) {
    for (const p of section.paragraphs) {
      const ref = formatRef(p.page, p.paragraphIdx);
      // Truncate ridiculously long paragraphs (rare in glossaries) to keep
      // the input bounded; 500 chars is enough for any single-term entry.
      const text = p.text.length > 500 ? p.text.slice(0, 500) + '…' : p.text;
      rows.push(`${ref}: ${text}`);
    }
  }

  if (rows.length === 0) {
    return { schemaVersion: 1, terms: [] };
  }

  // Cap the input — extremely long glossaries can exceed token budgets.
  // 400 paragraphs is well above any realistic glossary; truncate beyond.
  const CAP = 400;
  const capped = rows.length > CAP ? rows.slice(0, CAP) : rows;
  const userPrompt = `Paragraphs:\n${capped.join('\n')}\n\nExtract terms.`;

  let raw = '';
  try {
    // DRIFT-test3-032: wrap in shared retry. Fail-open semantics preserved
    // (the catch still returns empty terms) but transient 429s get 3
    // attempts before the empty-glossary fallback fires.
    const response = await withRetry({
      operationName: 'glossary-extract',
      fn: async () =>
        openai.chat.completions.create({
          model: EXTRACT_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 4096,
          temperature: 0,
        }),
    });
    raw = response.choices[0]?.message?.content ?? '';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[glossary-extract] LLM call failed:', (err as Error).message);
    return { schemaVersion: 1, terms: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[glossary-extract] JSON parse failed:', (err as Error).message);
    return { schemaVersion: 1, terms: [] };
  }

  const terms: ExtractedTerm[] = [];
  const o = parsed as { terms?: unknown };
  if (Array.isArray(o.terms)) {
    for (const t of o.terms as Array<Partial<ExtractedTerm>>) {
      if (
        typeof t?.term === 'string' &&
        typeof t?.definition === 'string' &&
        typeof t?.sourceParagraphRef === 'string' &&
        t.term.length > 0 &&
        t.definition.length > 0 &&
        // Sanity-check the ref shape; reject anything that doesn't match.
        /^page\d+:paragraph\d+$/.test(t.sourceParagraphRef)
      ) {
        terms.push({
          term: t.term.slice(0, 200),
          definition: t.definition.slice(0, 500),
          sourceParagraphRef: t.sourceParagraphRef,
        });
      }
    }
  }

  return { schemaVersion: 1, terms };
}

/**
 * Convenience: an "is there anything to extract?" predicate. The worker can
 * skip the extractor entirely when this returns false, saving the round-trip.
 */
export function hasGlossarySections(sections: GlossarySection[]): boolean {
  if (sections.length === 0) return false;
  for (const s of sections) {
    if (s.paragraphs.length > 0) return true;
  }
  return false;
}

// Re-export the shape used in tests / consumers without forcing them to
// import from s3-chunks.ts directly.
export type { GlossaryArtifact, ExtractedTerm };

// Convenience used in unit tests (Commit 3 scope) — avoids reaching into the
// implementation to test the format-ref shape. NOT a public API beyond tests.
export const __TEST_ONLY = {
  EXTRACT_MODEL,
  SYSTEM_PROMPT,
};
