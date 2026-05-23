// src/lib/ingest/chunker.ts — outline-tree descent + size-bounded chunking.
//
// Phase 2 of the lazy-hybrid-chunking ingest pipeline. Takes a ParsedPdf +
// the ClassifiedOutlineEntry[] from classifier.ts and produces a ChunkManifest:
// every body/appendix chunk fits comfortably inside the LLM's per-request
// token budget; oversized outline sections are descended (children become the
// units) or hard-split (when no further outline detail exists).
//
// Why descend before hard-split:
//   - Outline-aligned chunks have natural semantic boundaries; the author
//     intended them. Hard-splits arbitrarily slice mid-discourse — a worse
//     last resort.
//   - Hard-splits never re-cohere on read (chunk N+1 has no preamble from
//     chunk N's tail); the LLM produces less coherent narrative.
//
// Why MAX_PARAGRAPHS_PER_CHUNK = 100:
//   - Typical textbook prose: ~60-100 tokens per paragraph.
//   - 100 paragraphs ≈ 6-10K input tokens + ~2K system prompt + ~4K max_tokens
//     completion ≈ 14K total per call. Comfortable margin under gpt-4o's 30K
//     TPM-per-request ceiling (Tier 1).
//   - Empirically validated against DDIA's chapter-1.1 / 1.2 sub-sections in
//     the May 2026 UAT — those are 30-70 paragraphs each.
//
// Design anchors:
//   - kb:architecture/crosscut/single-responsibility — this module ONLY does
//     the structural decomposition. Glossary extraction (LLM call) lives in
//     glossary-extract.ts. S3 writes live in s3-chunks.ts.
//   - kb:architecture/discipline/stability-patterns §"Tier the stability
//     response" — fail-fast on malformed outline (null pageNumbers filtered);
//     graceful degradation via hard-split when outline is too shallow.

import type { ParsedPdf } from '@/lib/pdf/parse';
import type { SourceParagraph } from '@/lib/types';
import { paragraphsForRange } from '@/lib/pdf/paragraph-anchors';
import type { ClassifiedOutlineEntry, OutlineClassification } from './classifier';

// ───────────────────────────────────────────────────────────────────────────
// Tuning knobs
// ───────────────────────────────────────────────────────────────────────────

/** Max paragraphs per chunk before descent / hard-split kicks in. */
export const MAX_PARAGRAPHS_PER_CHUNK = 100;

/** Target paragraphs per hard-split sub-chunk (when outline can't help). */
export const HARD_SPLIT_TARGET_PARAGRAPHS = 70;

/** Schema version of THIS chunker; bump on any boundary-algorithm change. */
export const CHUNKER_VERSION = 1;

// ───────────────────────────────────────────────────────────────────────────
// Public output types
// ───────────────────────────────────────────────────────────────────────────

/**
 * A single emitted chunk — destined for an S3 chapters/NN.json artifact + a
 * `chapters` row. v1 emits only leaves of the descent walk (no parent rows).
 */
export interface Chunk {
  idx: number;
  title: string;
  classification: Extract<OutlineClassification, 'body' | 'appendix'>;
  pageStart: number;
  pageEnd: number;
  depth: number;
  parentIdx: number | null;
  paragraphs: SourceParagraph[];
  /** Cached length — saves a re-scan downstream. */
  paragraphCount: number;
}

/**
 * Sections we deliberately skipped (front-matter, bibliography, index).
 * Glossary entries are NOT included here — they're handled by glossary-extract
 * and the side-asset is referenced separately.
 */
export interface SkippedSection {
  title: string;
  classification: Extract<
    OutlineClassification,
    'front-matter' | 'bibliography'
  >;
  pageStart: number;
  pageEnd: number;
}

/**
 * The "glossary" sections deferred to the side-asset extractor. The chunker
 * just identifies + locates them; glossary-extract.ts does the LLM term pull.
 */
export interface GlossarySection {
  title: string;
  pageStart: number;
  pageEnd: number;
  paragraphs: SourceParagraph[];
}

export interface ChunkManifest {
  chunks: Chunk[];
  skipped: SkippedSection[];
  glossarySections: GlossarySection[];
  /** True if the outline carried any classifications (vs all-empty pass). */
  outlinePresent: boolean;
  chunkerVersion: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Tree reconstruction (flat DFS-ordered → nested)
// ───────────────────────────────────────────────────────────────────────────

interface OutlineNodeWithRange extends ClassifiedOutlineEntry {
  /** Resolved pageEnd (inclusive). Always populated by computeRanges below. */
  pageEnd: number;
  /** Tree children (DFS-built). */
  children: OutlineNodeWithRange[];
  /** Resolved pageNumber, narrowed from `number | null` — see filterValid. */
  pageNumber: number;
}

/**
 * Filter out outline entries with null pageNumber (broken bookmarks). Drop
 * silently; classifier already labeled them but they can't drive chunk
 * boundaries.
 */
function filterValid(
  entries: ClassifiedOutlineEntry[],
): Array<ClassifiedOutlineEntry & { pageNumber: number }> {
  return entries.filter(
    (e): e is ClassifiedOutlineEntry & { pageNumber: number } =>
      typeof e.pageNumber === 'number' && e.pageNumber >= 1,
  );
}

/**
 * Compute pageEnd for each entry as `next entry's pageNumber - 1` in flat
 * document order. The last entry's pageEnd is the PDF's total pageCount.
 */
function computeRanges(
  entries: Array<ClassifiedOutlineEntry & { pageNumber: number }>,
  pageCount: number,
): Array<ClassifiedOutlineEntry & { pageNumber: number; pageEnd: number }> {
  const out: Array<ClassifiedOutlineEntry & { pageNumber: number; pageEnd: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const next = entries[i + 1];
    const rawEnd = next ? next.pageNumber - 1 : pageCount;
    const pageEnd = Math.max(entry.pageNumber, rawEnd);
    out.push({ ...entry, pageEnd });
  }
  return out;
}

/**
 * Build the nested tree from DFS-flat outline entries using a depth stack.
 */
function buildTree(
  entries: Array<ClassifiedOutlineEntry & { pageNumber: number; pageEnd: number }>,
): OutlineNodeWithRange[] {
  const roots: OutlineNodeWithRange[] = [];
  const stack: Array<{ node: OutlineNodeWithRange; depth: number }> = [];
  for (const entry of entries) {
    const node: OutlineNodeWithRange = { ...entry, children: [] };
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top || top.depth < entry.depth) break;
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      const parent = stack[stack.length - 1];
      if (parent) parent.node.children.push(node);
    }
    stack.push({ node, depth: entry.depth });
  }
  return roots;
}

// ───────────────────────────────────────────────────────────────────────────
// Chunker walk
// ───────────────────────────────────────────────────────────────────────────

interface WalkState {
  chunks: Chunk[];
  skipped: SkippedSection[];
  glossarySections: GlossarySection[];
  nextChunkIdx: number;
  pages: ParsedPdf['pages'];
}

/**
 * Hard-split a too-big leaf node into N sub-chunks targeting
 * HARD_SPLIT_TARGET_PARAGRAPHS each. Paragraph order is preserved; titles
 * suffixed with " (Part N/M)".
 */
function emitHardSplit(
  node: OutlineNodeWithRange,
  paragraphs: SourceParagraph[],
  parentIdx: number | null,
  state: WalkState,
): void {
  const count = paragraphs.length;
  const partsCount = Math.max(1, Math.ceil(count / HARD_SPLIT_TARGET_PARAGRAPHS));
  const sliceSize = Math.ceil(count / partsCount);

  // Page-range subdivision: derive sub-chunk pageStart/pageEnd from the
  // paragraphs they actually hold. For paragraphs spanning multiple pages,
  // the sub-chunk's pageStart is its first paragraph's page; pageEnd is its
  // last paragraph's page. Guaranteed monotonic since paragraphs are in
  // document order.
  for (let part = 0; part < partsCount; part++) {
    const sliceStart = part * sliceSize;
    const sliceEnd = Math.min(sliceStart + sliceSize, count);
    const slice = paragraphs.slice(sliceStart, sliceEnd);
    if (slice.length === 0) continue;
    const firstPage = slice[0]?.page ?? node.pageNumber;
    const lastPage = slice[slice.length - 1]?.page ?? node.pageEnd;
    const idx = state.nextChunkIdx++;
    state.chunks.push({
      idx,
      title:
        partsCount > 1
          ? `${node.title} (Part ${part + 1}/${partsCount})`
          : node.title,
      classification: node.classification as Extract<
        OutlineClassification,
        'body' | 'appendix'
      >,
      pageStart: firstPage,
      pageEnd: lastPage,
      depth: node.depth,
      parentIdx,
      paragraphs: slice,
      paragraphCount: slice.length,
    });
  }
}

function walk(
  node: OutlineNodeWithRange,
  parentChunkIdx: number | null,
  state: WalkState,
): void {
  // Skipped categories — never become chunks; logged for audit.
  if (node.classification === 'front-matter' || node.classification === 'bibliography') {
    state.skipped.push({
      title: node.title,
      classification: node.classification,
      pageStart: node.pageNumber,
      pageEnd: node.pageEnd,
    });
    // Don't descend into front/back matter — children are also out of scope.
    return;
  }

  // Glossary — deferred to side-asset extractor; never a chunk.
  if (node.classification === 'glossary') {
    const paragraphs = paragraphsForRange(state.pages, node.pageNumber, node.pageEnd);
    state.glossarySections.push({
      title: node.title,
      pageStart: node.pageNumber,
      pageEnd: node.pageEnd,
      paragraphs,
    });
    return;
  }

  // body or appendix — descend / emit / hard-split.
  const paragraphs = paragraphsForRange(state.pages, node.pageNumber, node.pageEnd);
  if (paragraphs.length === 0) {
    // No content — possibly a structural marker (e.g., "Part I" with no
    // direct text on its title page). Descend if it has children; otherwise
    // skip emission entirely.
    if (node.children.length > 0) {
      for (const child of node.children) walk(child, parentChunkIdx, state);
    }
    return;
  }

  if (paragraphs.length <= MAX_PARAGRAPHS_PER_CHUNK) {
    const idx = state.nextChunkIdx++;
    state.chunks.push({
      idx,
      title: node.title.length > 0 ? node.title : `Chapter ${idx + 1}`,
      classification: node.classification as Extract<
        OutlineClassification,
        'body' | 'appendix'
      >,
      pageStart: node.pageNumber,
      pageEnd: node.pageEnd,
      depth: node.depth,
      parentIdx: parentChunkIdx,
      paragraphs,
      paragraphCount: paragraphs.length,
    });
    return;
  }

  // Too big. Prefer descending into children with non-zero outline detail.
  if (node.children.length > 0) {
    // The current node becomes a navigation grouping (no chunk emitted for
    // it). Children are responsible for the actual content. parentChunkIdx
    // stays null at this level — v1 keeps the tree flat in the DB.
    for (const child of node.children) walk(child, null, state);
    return;
  }

  // Leaf node, too big, no outline detail to descend. Hard-split.
  emitHardSplit(node, paragraphs, parentChunkIdx, state);
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestrator
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the ChunkManifest from a parsed PDF + classified outline.
 *
 * Pure function — no I/O. The caller (worker.ts) handles persistence + LLM
 * glossary extraction in subsequent stages.
 */
export function buildChunkManifest(
  parsedPdf: ParsedPdf,
  classifiedEntries: ClassifiedOutlineEntry[],
): ChunkManifest {
  const outlinePresent = classifiedEntries.length > 0;
  const valid = filterValid(classifiedEntries);
  const ranged = computeRanges(valid, parsedPdf.pageCount);
  const tree = buildTree(ranged);

  const state: WalkState = {
    chunks: [],
    skipped: [],
    glossarySections: [],
    nextChunkIdx: 0,
    pages: parsedPdf.pages,
  };

  if (tree.length === 0) {
    // No usable outline. Hard-split the whole document as one giant leaf with
    // no descent option. This handles outline-less PDFs the same way Tier 3
    // of the legacy chapter-detect did, but with the right size bounds.
    const allParas = paragraphsForRange(parsedPdf.pages, 1, parsedPdf.pageCount);
    const syntheticNode: OutlineNodeWithRange = {
      title: 'Full Document',
      pageNumber: 1,
      pageEnd: parsedPdf.pageCount,
      depth: 0,
      classification: 'body',
      classifiedByLLM: false,
      children: [],
    };
    if (allParas.length <= MAX_PARAGRAPHS_PER_CHUNK) {
      // Small PDF — single chunk is fine.
      state.chunks.push({
        idx: state.nextChunkIdx++,
        title: 'Full Document',
        classification: 'body',
        pageStart: 1,
        pageEnd: parsedPdf.pageCount,
        depth: 0,
        parentIdx: null,
        paragraphs: allParas,
        paragraphCount: allParas.length,
      });
    } else {
      emitHardSplit(syntheticNode, allParas, null, state);
    }
  } else {
    for (const root of tree) walk(root, null, state);
  }

  return {
    chunks: state.chunks,
    skipped: state.skipped,
    glossarySections: state.glossarySections,
    outlinePresent,
    chunkerVersion: CHUNKER_VERSION,
  };
}
