// src/lib/pdf/font-class.ts — PR-B: monospace font classification.
//
// Why this exists:
// ----------------
// CTCI fresh-session validation (2026-05-25) found that chapters with
// abundant code samples in the PDF source (e.g., "Arrays and Strings",
// "Trees and Graphs") sometimes produced narratives with ZERO fenced code
// blocks, even though FIDELITY rule 7 (PR #29) instructs the LLM to
// preserve them. Empirical root cause: the parser extracts code-block text
// as plain paragraphs without any signal that the source typography was
// monospace. The LLM cannot reliably distinguish a Python listing from
// surrounding prose when both arrive as flat utf-8 strings.
//
// Fix scope: classify each paragraph as either 'prose' or 'code' using the
// pdfjs font metadata that's already available on every text item. The
// classification is propagated through the chunker into the narrative
// prompt as a structural hint, letting the LLM preserve code listings
// verbatim instead of paraphrasing them away.
//
// Algorithm (deterministic, no LLM call):
//   1. Build a set of known monospace font *family* names.
//   2. For each pdfjs item, resolve its fontName -> styles[fontName].fontFamily
//      (when available) and check isMonospaceFontFamily().
//   3. For each paragraph, compute the ratio of monospace items by character
//      count (NOT item count — items are arbitrary glyph runs, not "tokens").
//   4. If ratio >= MONOSPACE_THRESHOLD_RATIO (default 0.6), classify as 'code';
//      otherwise 'prose'.
//
// Why ratio (not all-or-nothing):
//   PDFs render inline monospace constructs inside prose (e.g., `someVar`)
//   using the same monospace font as a code listing. A pure-prose paragraph
//   with 5-10% inline-mono chars must classify as 'prose'; a pure code
//   listing typically has >95% monospace chars. 0.6 is the empirical
//   separation point that survives noise (e.g., a code listing with a
//   trailing "// comment" line that pdfjs labels with mixed fonts).
//
// Threshold tuning lives behind FONT_CLASS_THRESHOLD env, defaulting to 0.6.
// CTCI-empirical follow-up may move this; the 0.6 default is honest as
// starting point, not measured-optimum yet.
//
// Contract:
//   - Fail-open: any heuristic miss returns 'prose' (the safer default).
//     A wrong 'code' label causes the LLM to emit fence-wrapped prose,
//     which corrupts the narrative. A wrong 'prose' label is benign:
//     it just continues current behavior (no code preservation guarantee).
//   - No knowledge of LANGUAGE — we tell the LLM 'this paragraph is code',
//     not 'this is Java'. Language detection is downstream (LLM infers).
//   - Pure, side-effect-free, deterministic.

/**
 * Known monospace font *family* substrings (case-insensitive). Match is
 * substring-based to handle pdfjs's verbose family strings like
 * "CourierNewPSMT" or "JetBrainsMono-Regular".
 *
 * Sources: empirical observation of pdfjs font.fontFamily values across
 * DDIA, CTCI, CLRS, and a handful of O'Reilly/Manning code-heavy books,
 * plus the canonical Adobe/Linux/macOS monospace family names.
 */
export const KNOWN_MONOSPACE_SUBSTRINGS: ReadonlyArray<string> = [
  'courier',          // Courier, CourierNew, Courier-Bold, ...
  'consolas',
  'monaco',
  'menlo',            // macOS default mono
  'jetbrainsmono',    // JetBrains Mono (no space; matches "JetBrainsMono-Regular")
  'jetbrains mono',   // with space, defensive
  'sourcecodepro',    // Source Code Pro (no space)
  'source code pro',  // with spaces
  'inconsolata',
  'firacode',         // Fira Code (no space)
  'fira code',        // with space
  'firamono',         // Fira Mono variant
  'dejavusansmono',   // DejaVu Sans Mono (no spaces)
  'dejavu sans mono', // with spaces
  'liberationmono',   // Liberation Mono (no space)
  'liberation mono',  // with space
  'cmu typewriter',   // Computer Modern Typewriter (LaTeX default mono)
  'cmtt',             // pdfTeX abbreviated form, e.g. cmtt10
  'cmr10',            // false-positive risk: cmr* is the serif family; we
                      // exclude bare "cmr" to avoid catching cmr10 (serif).
                      // The cmtt entry above is the actual mono variant.
  'andalemono',       // Andale Mono
  'andale mono',
  'lucida console',
  'lucidaconsole',
  'lucidasanstypewriter',
  'lucida sans typewriter',
  'courierprime',
  'courier prime',
  'inputmono',
  'input mono',
  'hackregular',      // Hack font
  'hack-regular',
  'ubuntumono',
  'ubuntu mono',
  'roboto mono',
  'robotomono',
  'iosevka',
  'pragmatapro',
  'pragmata pro',
  'pt mono',
  'ptmono',
  // Generic CSS family token (rare in PDF metadata but defensive)
  'monospace',
];

/**
 * Substrings that look monospace-ish but are NOT. Used to subtract from
 * the match: a font family matches monospace iff
 *   any(KNOWN_MONOSPACE_SUBSTRINGS) && !any(MONOSPACE_EXCLUDE_SUBSTRINGS).
 *
 * Empty by default — listed here for defensive future use if we discover
 * a regression case (e.g., a serif font that contains "courier" in its
 * marketing name).
 */
export const MONOSPACE_EXCLUDE_SUBSTRINGS: ReadonlyArray<string> = [];

/**
 * Return true iff the given font *family* string looks like a monospace
 * font. Case-insensitive substring match against KNOWN_MONOSPACE_SUBSTRINGS,
 * minus MONOSPACE_EXCLUDE_SUBSTRINGS.
 *
 * Accepts undefined/null/empty for convenience — those return false.
 */
export function isMonospaceFontFamily(fontFamily: string | null | undefined): boolean {
  if (!fontFamily) return false;
  const lower = fontFamily.toLowerCase();
  if (MONOSPACE_EXCLUDE_SUBSTRINGS.some((ex) => lower.includes(ex))) {
    return false;
  }
  return KNOWN_MONOSPACE_SUBSTRINGS.some((sub) => lower.includes(sub));
}

/**
 * Default monospace-ratio threshold above which a paragraph is classified
 * as 'code'. Tunable via FONT_CLASS_THRESHOLD env (0.0–1.0 inclusive).
 *
 * 0.6 = honest starting point. Pure prose paragraphs with inline monospace
 * (`someVar`) typically sit < 0.15. Pure code listings typically sit >
 * 0.9. The gap is wide enough that any threshold in [0.4, 0.8] would work
 * for the obvious cases; 0.6 is the midpoint that's least likely to be
 * gamed by mixed-typography artifacts (e.g., a comment line in a code
 * block that the PDF authored in a different font).
 */
export const DEFAULT_MONOSPACE_THRESHOLD = 0.6;

/**
 * Returns the configured threshold, clamping to [0, 1]. Allows env override
 * for empirical tuning without code changes.
 */
export function getMonospaceThreshold(): number {
  const raw = process.env.FONT_CLASS_THRESHOLD;
  if (!raw) return DEFAULT_MONOSPACE_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MONOSPACE_THRESHOLD;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

/**
 * Compute the monospace ratio of a sequence of (text, isMonospace) pairs
 * weighted by character count. Empty / whitespace-only items contribute
 * neither numerator nor denominator (so a code block punctuated by blank
 * runs isn't diluted by whitespace).
 *
 * Returns a number in [0, 1]; returns 0 when there is no non-whitespace
 * content at all (degenerate input → 'prose' by fail-open).
 */
export function computeMonospaceRatio(
  items: ReadonlyArray<{ str: string; isMonospace: boolean }>,
): number {
  let monoChars = 0;
  let totalChars = 0;
  for (const item of items) {
    const trimmed = item.str.trim();
    if (trimmed.length === 0) continue;
    totalChars += trimmed.length;
    if (item.isMonospace) monoChars += trimmed.length;
  }
  if (totalChars === 0) return 0;
  return monoChars / totalChars;
}

/**
 * Classify a paragraph from its item-level monospace flags + chars.
 * Convenience wrapper around computeMonospaceRatio + threshold gate.
 */
export function classifyParagraphKind(
  items: ReadonlyArray<{ str: string; isMonospace: boolean }>,
  threshold: number = getMonospaceThreshold(),
): 'prose' | 'code' {
  const ratio = computeMonospaceRatio(items);
  return ratio >= threshold ? 'code' : 'prose';
}
