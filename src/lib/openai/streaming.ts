/**
 * src/lib/openai/streaming.ts — chapter-generation streaming inference.
 *
 * The core inference function for Phase 2 Wave 2. Responsibilities:
 *   1. Pre-call cost-cap assertion (per ari CRIT-1; cost-cap.ts gate).
 *   2. Stream the OpenAI chat completion with structured-output JSON Schema.
 *   3. Forward token deltas to caller via onToken callback (for SSE bridge).
 *   4. Accumulate the full JSON payload, parse, validate source_paragraph_ref
 *      against the chapter's known paragraph index (per ari HIGH-3 + riley
 *      CRIT), drop invalid refs, return validationDropCount for telemetry.
 *   5. Retry per a tiered policy (429 / 5xx / json-parse failure).
 *   6. Propagate AbortSignal through to the underlying fetch (riley CRIT-1).
 *
 * Design anchors:
 *   - kb:architecture/ai-systems/inference-cost-management §"Lever 5:
 *     Output control" — max_tokens cap + structured output + the pre-call
 *     budget assertion are layered defenses against output sprawl.
 *   - kb:architecture/ai-systems/inference-cost-management §"Hidden cost:
 *     agent loop amortization" — we DO NOT loop; each chapter is a single
 *     call. Single-call cost arithmetic is straight tokens × rate.
 *   - kb:architecture/discipline/error-handling-discipline §"Pattern 2:
 *     Translate to a normal value" — invalid sourceParagraphRef does NOT
 *     fail the whole generation; we drop the bad item, count it, return
 *     a partial result with chapter.status='partial' (per schema enum).
 *
 * What this file DOES NOT do (kept thin on purpose):
 *   - Does NOT write to the database — caller (the per-chapter worker, not
 *     yet implemented in this wave) inserts to parses_cost, questions,
 *     flashcards, chapters. We return the parts; persistence is theirs.
 *   - Does NOT manage the SSE protocol — caller bridges onToken into an
 *     SSE event stream. We're a pure async function with a callback.
 *   - Does NOT batch across chapters — chapter-gen is per-chapter; batching
 *     would require switching to the OpenAI batch API (deferred).
 */

import type {
  ChapterGenerationResult,
  LLMFlashcard,
  QuizQuestion,
  SourceParagraph,
} from '@/lib/types';
import { openai, getModel } from './client';
import {
  actualCost,
  estimateCost,
  isSupportedModel,
  UnknownModelError,
} from './cost';
import { assertCostBudget } from './cost-cap';
import { withRetry, abortError } from './_retry';
import {
  CHAPTER_GEN_RESPONSE_FORMAT,
  buildChapterGenSystemPrompt,
  buildChapterGenUserPrompt,
} from '@/lib/prompts/chapter-gen';

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

export interface GenerateChapterStreamingArgs {
  /** Tutorial ID; used by cost-cap to query prior spend. */
  tutorialId: string;
  /** Chapter title — appears in the user prompt. */
  chapterTitle: string;
  /** The chapter's source paragraphs (from chapters.source_paragraphs_json). */
  sourceParagraphs: SourceParagraph[];
  /** Cancels the underlying fetch when fired (e.g., client disconnect). */
  abortSignal?: AbortSignal;
  /**
   * Called for each streaming token delta. Caller forwards as an SSE event.
   * Receives the raw text chunk (concatenation = the full JSON payload).
   */
  onToken: (delta: string) => void;
}

export interface GenerateChapterStreamingResult {
  /** The validated chapter generation result (invalid refs dropped). */
  result: ChapterGenerationResult;
  /** Actual prompt tokens billed by OpenAI. */
  promptTokens: number;
  /** Actual completion tokens billed by OpenAI. */
  completionTokens: number;
  /** Actual USD cost (for parses_cost.cost_usd). */
  costUsd: number;
  /** Count of questions+flashcards dropped due to invalid source_paragraph_ref. */
  validationDropCount: number;
  /** The model actually used (for parses_cost.model). */
  model: string;
}

/**
 * Custom error class for "model produced JSON we couldn't structurally
 * recover even after retry". Caller (worker) marks chapter.status='failed'.
 */
export class ChapterGenParseError extends Error {
  readonly rawText: string;
  constructor(message: string, rawText: string) {
    super(message);
    this.name = 'ChapterGenParseError';
    this.rawText = rawText;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Constants (retry policy + output cap)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Upper bound for completion tokens. Sized for ~1500-word narrative +
 * 10 questions × ~80 tokens each + 25 flashcards × ~40 tokens each + JSON
 * overhead ≈ 1500 + 800 + 1000 + 700 ≈ 4000 tokens, padded to 4096.
 * Used both by the OpenAI call (max_tokens) AND by estimateCost as the
 * upper-bound completion estimate (per ari CRIT-1: pre-call cap must be
 * an upper bound). See finding HIGH-2 for the strict-mode interaction.
 */
const MAX_COMPLETION_TOKENS = 4096;

// Retry policy moved to src/lib/openai/_retry.ts as part of DRIFT-test3-032.
// The shared module unifies retry behavior across:
//   - streaming.ts (this file)
//   - narrative-only.ts + quiz-from-narrative.ts + fidelity-check.ts
//   - ingest/classifier.ts + ingest/glossary-extract.ts
// See withRetry() call in generateChapterStreaming below.

// ───────────────────────────────────────────────────────────────────────────
// Implementation
// ───────────────────────────────────────────────────────────────────────────

export async function generateChapterStreaming(
  args: GenerateChapterStreamingArgs,
): Promise<GenerateChapterStreamingResult> {
  const { tutorialId, chapterTitle, sourceParagraphs, abortSignal, onToken } = args;
  const model = getModel();

  if (!isSupportedModel(model)) {
    // Fail-closed: if the configured model has no pricing entry, we cannot
    // enforce the cost cap. Per cost-cap.ts contract, that is unsafe; throw
    // explicitly with a clear remediation path.
    throw new UnknownModelError(model);
  }

  // ── Pre-call cost-cap gate (ari CRIT-1) ──
  const systemPrompt = buildChapterGenSystemPrompt();
  const userPrompt = buildChapterGenUserPrompt({ chapterTitle, sourceParagraphs });
  const estimate = estimateCost({
    model,
    promptText: systemPrompt + userPrompt,
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
  });
  await assertCostBudget(tutorialId, estimate.estimatedCostUsd);

  // ── Build the index of valid sourceParagraphRefs for post-call validation ──
  // O(N) Set lookup beats O(N) array scan per question/flashcard.
  const validRefs = new Set(
    sourceParagraphs.map((p) => `page${p.page}:paragraph${p.paragraphIdx}`),
  );

  // ── The actual streaming call, with retry on 429/5xx/parse ──
  //
  // Refactored DRIFT-test3-032: retry plumbing now lives in
  // src/lib/openai/_retry.ts and is shared with narrative-only,
  // quiz-from-narrative, fidelity-check, classifier, glossary-extract.
  // Semantics preserved: 429 → rateLimit backoff with jitter, 5xx →
  // serverError backoff, ChapterGenParseError → parseError backoff (one
  // immediate retry with stricter prompt). 4xx-other / network / abort →
  // surface immediately.
  return withRetry({
    operationName: 'chapter-streaming',
    abortSignal,
    isParseError: (err) => err instanceof ChapterGenParseError,
    fn: async (attempt) => {
      // nova CRITICAL-2 (test3 Phase 3) refactor preserved: destructure both
      // rawText and usage directly from streamOnce. The previous design
      // smuggled usage via a module-global Map keyed on accumulated content.
      const { rawText, usage } = await streamOnce({
        model,
        systemPrompt,
        userPrompt,
        abortSignal,
        onToken,
        attempt,
      });
      // Parse + validate. On JSON-parse failure we throw a recoverable
      // ChapterGenParseError that withRetry's isParseError predicate
      // classifies as parse-retryable.
      const parsed = parseAndValidate(rawText, validRefs);
      // ── Post-call: account actual usage from the (final) stream chunk ──
      const { promptTokens, completionTokens } = usage;
      const costUsd = actualCost({ model, promptTokens, completionTokens });
      return {
        result: parsed.result,
        promptTokens,
        completionTokens,
        costUsd,
        validationDropCount: parsed.validationDropCount,
        model,
      };
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Internal: single stream attempt
// ───────────────────────────────────────────────────────────────────────────

interface StreamOnceArgs {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  abortSignal: AbortSignal | undefined;
  onToken: (delta: string) => void;
  attempt: number;
}

/**
 * Result of a single streaming attempt.
 *
 * REFACTORED per nova CRITICAL-2 (test3 Phase 3): previously this function
 * returned just `string` and smuggled usage via a module-global Map keyed by
 * the accumulated content. That Map leaked on AbortError paths AND was
 * vulnerable to string-key collision when concurrent chapters from different
 * tutorials produced identical output. The Map is gone; we now return both
 * via this tuple. Caller destructures both.
 */
interface StreamOnceResult {
  rawText: string;
  usage: { promptTokens: number; completionTokens: number };
}

async function streamOnce(args: StreamOnceArgs): Promise<StreamOnceResult> {
  const { model, systemPrompt, userPrompt, abortSignal, onToken, attempt } = args;

  // On a parse-retry, append a stricter reminder to the user prompt. This is
  // the only attempt-aware variant; 429/5xx retries reuse the original prompt.
  const effectiveUserPrompt =
    attempt > 0
      ? `${userPrompt}\n\n[RETRY NOTE: the previous attempt produced invalid JSON. Emit STRICTLY valid JSON matching the response schema; no prose outside the JSON.]`
      : userPrompt;

  const stream = await openai.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: effectiveUserPrompt },
      ],
      response_format: CHAPTER_GEN_RESPONSE_FORMAT,
      stream: true,
      // Include usage in the final stream chunk so we can record exact cost
      // without making a second API call. Requires the openai SDK to be at
      // a version that supports stream_options; openai@4.55.0 does.
      stream_options: { include_usage: true },
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.3,
    },
    {
      // CRITICAL: forward AbortSignal to the underlying fetch so client
      // disconnect cancels the OpenAI request (riley CRIT-1).
      signal: abortSignal,
    },
  );

  let accumulated = '';
  // Capture usage from the final chunk; mutable so we can read after the loop.
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of stream) {
    // Re-check abort on each chunk so a mid-stream disconnect cancels
    // promptly even if OpenAI's stream is still emitting.
    if (abortSignal?.aborted) {
      throw abortError(abortSignal);
    }
    const delta = chunk.choices[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      accumulated += delta;
      onToken(delta);
    }
    // Usage block only present in the FINAL chunk (per stream_options docs).
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens;
      completionTokens = chunk.usage.completion_tokens;
    }
  }

  // nova CRITICAL-2 (test3 Phase 3) fix: return tuple directly. No sidecar
  // Map, no string-key collision, no leak on AbortError (the throw above at
  // the abort-check skips this return path naturally — usage data dies with
  // the function frame). Caller in generateChapterStreaming destructures.
  return { rawText: accumulated, usage: { promptTokens, completionTokens } };
}

// ───────────────────────────────────────────────────────────────────────────
// Internal: parse + semantic validation of source_paragraph_ref
// ───────────────────────────────────────────────────────────────────────────

interface ParseAndValidateResult {
  result: ChapterGenerationResult;
  validationDropCount: number;
  // usage REMOVED per nova CRITICAL-2 refactor — caller passes usage in
  // directly from streamOnce's tuple return. parseAndValidate is now a pure
  // function (no module-global Map lookup).
}

function parseAndValidate(
  rawText: string,
  validRefs: Set<string>,
): ParseAndValidateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new ChapterGenParseError(
      `Failed to JSON.parse OpenAI response: ${(err as Error).message}`,
      rawText,
    );
  }

  // Defensive: even with strict structured output, validate the top-level
  // shape. Strict mode CAN fail mid-stream (e.g., the model exceeds
  // max_tokens before closing the JSON), in which case rawText is
  // incomplete and JSON.parse already threw above. This is the post-parse
  // shape check.
  if (
    !isObject(parsed) ||
    typeof parsed.narrative !== 'string' ||
    !Array.isArray(parsed.questions) ||
    !Array.isArray(parsed.flashcards)
  ) {
    throw new ChapterGenParseError(
      'OpenAI response did not match top-level chapter schema shape',
      rawText,
    );
  }

  // Validate each question / flashcard ref against the chapter's known
  // paragraph index. Drop invalids; count for telemetry.
  let droppedCount = 0;
  const validQuestions: QuizQuestion[] = [];
  for (const q of parsed.questions as QuizQuestion[]) {
    if (validRefs.has(q.sourceParagraphRef)) {
      validQuestions.push(q);
    } else {
      droppedCount++;
    }
  }
  const validFlashcards: LLMFlashcard[] = [];
  for (const f of parsed.flashcards as LLMFlashcard[]) {
    if (validRefs.has(f.sourceParagraphRef)) {
      validFlashcards.push(f);
    } else {
      droppedCount++;
    }
  }

  // vlad CRITICAL-1 (test3 Phase 4) fix: `usage` was previously read from
  // the now-removed USAGE_FROM_STREAM module-global Map. The nova CRITICAL-2
  // refactor (Phase 3) dropped the local lookup AND the field from the
  // interface but left this orphan reference here, which would crash the
  // function on every call (ReferenceError in strict mode; silent undefined
  // in non-strict). Now that usage is part of streamOnce's tuple return,
  // it does NOT belong in parseAndValidate's output — caller composes both.
  return {
    result: {
      narrative: parsed.narrative,
      questions: validQuestions,
      flashcards: validFlashcards,
    },
    validationDropCount: droppedCount,
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// Retry classifier + backoff math + abort plumbing moved to ./_retry.ts
// as part of DRIFT-test3-032. The shared module is the single source of
// truth across all OpenAI call sites in this codebase.
