// src/lib/ingest/__tests__/anchor-scorer.test.ts
//
// Unit tests for the LLM anchor scorer (Feature B', Wave 2).
//
// Coverage:
//   - Happy path: 50 candidates → LLM scores → top-30 returned, categorized
//   - Empty candidates → empty whitelist, no LLM call
//   - LLM hallucination guard: term not in input → dropped
//   - LLM invalid-category guard: category not in enum → dropped
//   - Glossary priority: glossary candidate survives top-30 cut even when
//     non-glossary candidates would otherwise displace it
//   - Cap enforcement: 100 candidates returning 100 → top-30 only
//   - Category-priority tie-break: contrast-pair beats search-term at same freq
//   - Parse-retry recovery: first call malformed → second call succeeds
//   - Cost arithmetic correctness
//   - Prompt + model invariants asserted via __TEST_ONLY

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnchorCandidate } from '../anchor-prefilter';

// ───────────────────────────────────────────────────────────────────────────
// Mock the OpenAI singleton BEFORE importing the module under test.
// vitest hoists vi.mock to the top of the file, so this runs first.
// ───────────────────────────────────────────────────────────────────────────

const createMock = vi.fn();
vi.mock('@/lib/openai/client', () => ({
  openai: {
    chat: {
      completions: {
        create: (...args: unknown[]) => createMock(...args),
      },
    },
  },
}));

// Imports must come AFTER vi.mock for the mock to take effect.
import {
  scoreAnchorCandidates,
  AnchorScorerParseError,
  buildScorerUserPrompt,
  compareForTopN,
  selectTopNWithGlossaryBoost,
  __TEST_ONLY,
} from '../anchor-scorer';
import type { AnchorWhitelistEntry } from '@/lib/openai/anchor-validator';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

interface MakeCandidateOpts {
  term: string;
  frequency: number;
  source?: AnchorCandidate['source'];
  firstSeen?: string;
  glossary?: boolean;
}

function makeCandidate(opts: MakeCandidateOpts): AnchorCandidate {
  const c: AnchorCandidate = {
    term: opts.term,
    category: 'unknown',
    frequency: opts.frequency,
    first_seen_at: opts.firstSeen ?? 'page1:paragraph0',
    source: opts.source ?? 'capitalized-multiword',
  };
  if (opts.glossary) c.glossary_priority = true;
  return c;
}

/**
 * Build N candidates with descending frequencies starting at maxFreq.
 * Default source is `capitalized-multiword`. Term names are `term-N`.
 */
function makeNCandidates(n: number, maxFreq = 100): AnchorCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    makeCandidate({
      term: `term-${i}`,
      frequency: Math.max(1, maxFreq - i),
      firstSeen: `page${i + 1}:paragraph0`,
    }),
  );
}

function buildLLMContentFromCandidates(
  candidates: AnchorCandidate[],
  category: AnchorWhitelistEntry['category'] = 'search-term',
): string {
  return JSON.stringify({
    anchors: candidates.map((c) => ({
      term: c.term,
      category,
      keep: true,
    })),
  });
}

function buildOpenAIResponse(
  content: string,
  promptTokens = 1500,
  completionTokens = 600,
): {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
} {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// buildScorerUserPrompt — prompt formatting
// ───────────────────────────────────────────────────────────────────────────

describe('buildScorerUserPrompt', () => {
  it('renders each candidate on its own [N] line with all fields', () => {
    const cs = [
      makeCandidate({
        term: 'head-of-line blocking',
        frequency: 4,
        source: 'capitalized-multiword',
        firstSeen: 'page36:paragraph2',
      }),
      makeCandidate({
        term: 'ACID',
        frequency: 12,
        source: 'glossary',
        firstSeen: 'page2:paragraph1',
        glossary: true,
      }),
    ];
    const prompt = buildScorerUserPrompt(cs);
    expect(prompt).toContain(
      '[1] term: "head-of-line blocking", source: capitalized-multiword, frequency: 4, first_seen: page36:paragraph2, glossary: false',
    );
    expect(prompt).toContain(
      '[2] term: "ACID", source: glossary, frequency: 12, first_seen: page2:paragraph1, glossary: true',
    );
    expect(prompt.trim().endsWith('Output the filtered whitelist as strict JSON now.')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// compareForTopN + selectTopNWithGlossaryBoost — pure selection helpers
// ───────────────────────────────────────────────────────────────────────────

describe('compareForTopN', () => {
  it('sorts higher frequency first', () => {
    const a: AnchorWhitelistEntry = {
      term: 'a',
      category: 'search-term',
      frequency_in_source: 10,
      first_seen_at: 'page1:paragraph0',
    };
    const b: AnchorWhitelistEntry = {
      term: 'b',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    expect(compareForTopN(a, b)).toBeLessThan(0);
    expect(compareForTopN(b, a)).toBeGreaterThan(0);
  });

  it('breaks ties by category priority (contrast-pair beats search-term)', () => {
    const contrast: AnchorWhitelistEntry = {
      term: 'fault vs failure',
      category: 'contrast-pair',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    const search: AnchorWhitelistEntry = {
      term: 'eventual consistency',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    expect(compareForTopN(contrast, search)).toBeLessThan(0);
  });

  it('breaks further ties by lowercase term alpha order', () => {
    const a: AnchorWhitelistEntry = {
      term: 'Banana',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    const b: AnchorWhitelistEntry = {
      term: 'apple',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    };
    // apple < banana (case-insensitive)
    expect(compareForTopN(b, a)).toBeLessThan(0);
  });
});

describe('selectTopNWithGlossaryBoost', () => {
  it('returns all entries unchanged when count <= 30', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      term: `t${i}`,
      category: 'search-term' as const,
      frequency_in_source: 100 - i,
      first_seen_at: 'page1:paragraph0',
      isGlossary: false,
    }));
    const out = selectTopNWithGlossaryBoost(entries);
    expect(out.length).toBe(20);
  });

  it('caps to exactly 30 entries when more are provided', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      term: `t${i}`,
      category: 'search-term' as const,
      frequency_in_source: 1000 - i,
      first_seen_at: 'page1:paragraph0',
      isGlossary: false,
    }));
    const out = selectTopNWithGlossaryBoost(entries);
    expect(out.length).toBe(30);
    // First by frequency desc → t0 wins (freq 1000)
    expect(out[0]?.term).toBe('t0');
  });

  it('boosts a glossary entry that would otherwise be displaced', () => {
    // 30 non-glossary entries with frequencies 30..1, plus one glossary
    // entry with frequency 0 (below the cut). The glossary entry should
    // displace the lowest-freq non-glossary entry (freq 1).
    const entries: Array<
      AnchorWhitelistEntry & { isGlossary: boolean }
    > = Array.from({ length: 30 }, (_, i) => ({
      term: `t${i}`,
      category: 'search-term' as const,
      frequency_in_source: 30 - i,
      first_seen_at: 'page1:paragraph0',
      isGlossary: false,
    }));
    entries.push({
      term: 'GLOSSARY-TERM',
      category: 'search-term',
      frequency_in_source: 0,
      first_seen_at: 'page1:paragraph0',
      isGlossary: true,
    });
    const out = selectTopNWithGlossaryBoost(entries);
    expect(out.length).toBe(30);
    // Glossary entry should be present.
    expect(out.find((e) => e.term === 'GLOSSARY-TERM')).toBeDefined();
    // The lowest-freq non-glossary (t29, freq 1) should have been displaced.
    expect(out.find((e) => e.term === 't29')).toBeUndefined();
  });

  it('strips the isGlossary internal flag from returned entries', () => {
    const entries = [
      {
        term: 'a',
        category: 'search-term' as const,
        frequency_in_source: 5,
        first_seen_at: 'page1:paragraph0',
        isGlossary: true,
      },
    ];
    const out = selectTopNWithGlossaryBoost(entries);
    expect(out[0]).toEqual({
      term: 'a',
      category: 'search-term',
      frequency_in_source: 5,
      first_seen_at: 'page1:paragraph0',
    });
    // No leaked isGlossary field.
    expect('isGlossary' in (out[0] as object)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// scoreAnchorCandidates — integration with mocked OpenAI
// ───────────────────────────────────────────────────────────────────────────

describe('scoreAnchorCandidates', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('returns an empty result without calling the LLM when candidates is empty', async () => {
    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-empty',
      candidates: [],
    });
    expect(result.whitelist).toEqual([]);
    expect(result.candidateCount).toBe(0);
    expect(result.acceptedCount).toBe(0);
    expect(result.extractionCostUsd).toBe(0);
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
    expect(result.model).toBe('gpt-4o-mini');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('happy path: 50 candidates → top-30 returned, categorized', async () => {
    const candidates = makeNCandidates(50, 100);
    // LLM keeps all 50 with default search-term category.
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates)),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-happy',
      candidates,
    });

    expect(result.candidateCount).toBe(50);
    expect(result.whitelist.length).toBe(30);
    expect(result.acceptedCount).toBe(30);
    expect(result.model).toBe('gpt-4o-mini');
    // Top-30 by frequency desc → first should be term-0 (freq 100).
    expect(result.whitelist[0]?.term).toBe('term-0');
    expect(result.whitelist[0]?.frequency_in_source).toBe(100);
    // All entries have a valid category.
    for (const e of result.whitelist) {
      expect(e.category).toBe('search-term');
    }
  });

  it('drops LLM-hallucinated terms not in input candidates', async () => {
    const candidates = [
      makeCandidate({ term: 'real-term', frequency: 5 }),
    ];
    const hallucinatedContent = JSON.stringify({
      anchors: [
        { term: 'real-term', category: 'search-term', keep: true },
        { term: 'made-up-term', category: 'search-term', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(hallucinatedContent));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-hallucinated',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    expect(result.whitelist[0]?.term).toBe('real-term');
    expect(result.whitelist.find((e) => e.term === 'made-up-term')).toBeUndefined();
  });

  it('drops LLM entries with an invalid category', async () => {
    const candidates = [
      makeCandidate({ term: 'good-term', frequency: 5 }),
      makeCandidate({ term: 'bad-cat-term', frequency: 4 }),
    ];
    const invalidCategoryContent = JSON.stringify({
      anchors: [
        { term: 'good-term', category: 'search-term', keep: true },
        { term: 'bad-cat-term', category: 'invalid', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(invalidCategoryContent));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-bad-cat',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    expect(result.whitelist[0]?.term).toBe('good-term');
  });

  it('honors glossary priority: glossary candidate survives top-30 cut', async () => {
    // 30 non-glossary candidates (freq 100..71) + 1 glossary (freq 1).
    // The LLM rejects the glossary candidate but keeps the 30 non-glossary
    // ones. After glossary-priority boost, the glossary candidate is
    // promoted into the top-30, displacing term-29 (freq 71).
    const nonGlossary = Array.from({ length: 30 }, (_, i) =>
      makeCandidate({
        term: `ng-${i}`,
        frequency: 100 - i,
        firstSeen: `page${i + 1}:paragraph0`,
      }),
    );
    const glossary = makeCandidate({
      term: 'CRDT',
      frequency: 1,
      source: 'glossary',
      firstSeen: 'page2:paragraph1',
      glossary: true,
    });
    const candidates = [...nonGlossary, glossary];

    // LLM keeps only the 30 non-glossary (rejects glossary CRDT).
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(nonGlossary)),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-glossary',
      candidates,
    });

    expect(result.whitelist.length).toBe(30);
    // CRDT should be present (auto-survives via glossary boost).
    expect(result.whitelist.find((e) => e.term === 'CRDT')).toBeDefined();
    // ng-29 (lowest freq) should have been displaced.
    expect(result.whitelist.find((e) => e.term === 'ng-29')).toBeUndefined();
  });

  it('Wave-2 review HIGH 2A-H1: zero-frequency glossary candidate is NOT force-added', async () => {
    // A glossary term the author defined but NEVER USED in body has
    // frequency=0. The anchor-validator can never find it in any
    // source paragraph, so adding it to the whitelist is dead weight
    // (and may displace a real anchor). The force-add path now guards
    // with c.frequency > 0.
    const candidates = [
      // 5 non-glossary candidates that the LLM will accept
      makeCandidate({ term: 'real-anchor-1', frequency: 10 }),
      makeCandidate({ term: 'real-anchor-2', frequency: 9 }),
      makeCandidate({ term: 'real-anchor-3', frequency: 8 }),
      // Glossary candidate with freq=0 — author defined but never used
      makeCandidate({
        term: 'GHOST_GLOSSARY_TERM',
        frequency: 0,
        glossary_priority: true,
      }),
    ];
    // LLM accepts the 3 real anchors, rejects the ghost glossary term.
    const content = JSON.stringify({
      anchors: [
        { term: 'real-anchor-1', category: 'search-term', keep: true },
        { term: 'real-anchor-2', category: 'search-term', keep: true },
        { term: 'real-anchor-3', category: 'search-term', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(content));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-zero-freq-glossary',
      candidates,
    });

    // The ghost glossary term must NOT be in the whitelist despite its
    // glossary_priority flag, because freq=0 makes it unverifiable.
    expect(result.whitelist.find((e) => e.term === 'GHOST_GLOSSARY_TERM')).toBeUndefined();
    // The 3 real anchors must all survive.
    expect(result.whitelist.length).toBe(3);
  });

  it('Wave-2 review HIGH 2A-H2: parse-retry attempt index propagates to fn closure', async () => {
    // The retry pattern is: first attempt returns bad-shape JSON, second
    // attempt receives the same user prompt PLUS a stricter [RETRY NOTE]
    // suffix (which the fn closure appends when attempt > 0). We assert
    // the second call's user-message content differs from the first.
    const candidates = [makeCandidate({ term: 'x', frequency: 1 })];
    createMock
      .mockResolvedValueOnce(
        buildOpenAIResponse(JSON.stringify({ unrelated: 'object' })),
      ) // attempt 0: bad shape -> parse-retry
      .mockResolvedValueOnce(buildOpenAIResponse(buildLLMContentFromCandidates(candidates))); // attempt 1: succeeds

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-retry-attempt',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    expect(createMock.mock.calls.length).toBe(2);

    // Pull the user-message text from each call. The first must NOT contain
    // the retry note; the second MUST contain it.
    const firstCall = createMock.mock.calls[0]?.[0] as
      | { messages: Array<{ role: string; content: string }> }
      | undefined;
    const secondCall = createMock.mock.calls[1]?.[0] as
      | { messages: Array<{ role: string; content: string }> }
      | undefined;
    const firstUser = firstCall?.messages.find((m) => m.role === 'user')?.content ?? '';
    const secondUser = secondCall?.messages.find((m) => m.role === 'user')?.content ?? '';

    expect(firstUser).not.toContain('[RETRY NOTE');
    expect(secondUser).toContain('[RETRY NOTE');
    expect(secondUser).toContain('did not conform to the response schema');
  });

  it('enforces 30-entry cap when LLM returns 100 candidates', async () => {
    const candidates = makeNCandidates(100, 200);
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates)),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-cap',
      candidates,
    });

    expect(result.candidateCount).toBe(100);
    expect(result.whitelist.length).toBe(30);
  });

  it('breaks frequency ties by category priority (contrast-pair > search-term)', async () => {
    // Two candidates at the same frequency. LLM assigns different categories.
    const candidates = [
      makeCandidate({ term: 'fault vs failure', frequency: 5 }),
      makeCandidate({ term: 'eventual consistency', frequency: 5 }),
    ];
    const content = JSON.stringify({
      anchors: [
        { term: 'fault vs failure', category: 'contrast-pair', keep: true },
        { term: 'eventual consistency', category: 'search-term', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(content));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-tiebreak',
      candidates,
    });

    expect(result.whitelist.length).toBe(2);
    // contrast-pair wins the priority tie-break.
    expect(result.whitelist[0]?.term).toBe('fault vs failure');
    expect(result.whitelist[0]?.category).toBe('contrast-pair');
    expect(result.whitelist[1]?.category).toBe('search-term');
  });

  it('recovers on parse-retry when first call returns malformed JSON and second succeeds', async () => {
    const candidates = [makeCandidate({ term: 'good-term', frequency: 5 })];
    const validContent = buildLLMContentFromCandidates(candidates);

    createMock.mockResolvedValueOnce(buildOpenAIResponse('not JSON {'));
    createMock.mockResolvedValueOnce(buildOpenAIResponse(validContent));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-retry',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.whitelist.length).toBe(1);
    expect(result.whitelist[0]?.term).toBe('good-term');
  });

  it('throws AnchorScorerParseError when JSON is valid but shape is wrong', async () => {
    // Wave-2 review HIGH 2A-H3 fix: pin the assertion to the actual
    // upper bound (maxAttempts() = 7 in withRetry's shared-attempt-
    // counter model). The original assertion just `rejects.toBeInstanceOf`
    // — which passed regardless of how many retry attempts fired. With
    // `mockResolvedValue` (not Once), every attempt re-encounters the
    // bad shape; parseError walks the [0]ms slot from `Math.min(attempt,
    // 0) === 0` on every iteration, so all 7 attempts get a retry slot.
    // Pinning the call count catches regressions in either direction.
    const candidates = [makeCandidate({ term: 'x', frequency: 1 })];
    createMock.mockResolvedValue(
      buildOpenAIResponse(JSON.stringify({ unrelated: 'object' })),
    );

    await expect(
      scoreAnchorCandidates({
        pdfSha256: 'sha-wrong-shape',
        candidates,
      }),
    ).rejects.toBeInstanceOf(AnchorScorerParseError);

    // maxAttempts() = 1 initial + 3 rateLimit + 2 serverError + 1 parseError = 7
    expect(createMock.mock.calls.length).toBe(7);
  });

  it('computes cost correctly from usage tokens', async () => {
    const candidates = [makeCandidate({ term: 'x', frequency: 1 })];
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates), 1500, 600),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-cost',
      candidates,
    });

    // gpt-4o-mini pricing: input 0.15/1M, output 0.60/1M
    //   1500 prompt × 0.15/1M + 600 completion × 0.60/1M
    //     = 0.000225 + 0.00036 = 0.000585
    expect(result.extractionCostUsd).toBeCloseTo(0.000585, 6);
    expect(result.promptTokens).toBe(1500);
    expect(result.completionTokens).toBe(600);
  });

  it('passes the verbatim system prompt + correct model + temperature=0', async () => {
    const candidates = [makeCandidate({ term: 'x', frequency: 1 })];
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates)),
    );

    await scoreAnchorCandidates({
      pdfSha256: 'sha-prompt-check',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const firstCall = createMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArgs = firstCall![0] as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
    };
    expect(callArgs.model).toBe('gpt-4o-mini');
    expect(callArgs.temperature).toBe(0);
    expect(callArgs.max_tokens).toBe(__TEST_ONLY.MAX_COMPLETION_TOKENS);
    expect(callArgs.messages[0]?.role).toBe('system');
    // Verbatim match — drift in the constant is a test failure.
    expect(callArgs.messages[0]?.content).toBe(__TEST_ONLY.SYSTEM_PROMPT);
    expect(callArgs.messages[1]?.role).toBe('user');
    expect(callArgs.messages[1]?.content).toContain('Candidates (filter to keep load-bearing technical anchors only):');
    expect(callArgs.messages[1]?.content.trim().endsWith('Output the filtered whitelist as strict JSON now.')).toBe(true);
    // Strict-mode JSON schema is wired up.
    expect(callArgs.response_format.type).toBe('json_schema');
  });

  it('preserves verbatim candidate casing even if LLM echoes lowercase', async () => {
    const candidates = [
      makeCandidate({ term: 'Chaos Monkey', frequency: 5 }),
    ];
    // LLM echoes back lowercase — we should still use the candidate's casing.
    const content = JSON.stringify({
      anchors: [{ term: 'chaos monkey', category: 'named-system', keep: true }],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(content));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-casing',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    // Authoritative casing from candidate, not LLM echo.
    expect(result.whitelist[0]?.term).toBe('Chaos Monkey');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Wave 4 — Candidate batching
  // ─────────────────────────────────────────────────────────────────────

  it('Wave 4: splits >BATCH_SIZE candidates into batches (250 → 3 calls)', async () => {
    // BATCH_SIZE = 100; 250 candidates → 3 batches (100 + 100 + 50).
    const candidates = makeNCandidates(250, 250);
    const batchAccepted = [
      candidates.slice(0, 100),
      candidates.slice(100, 200),
      candidates.slice(200, 250),
    ];
    // Each batch echoes back its slice as accepted. Tokens vary per batch
    // so we can assert summing later.
    createMock
      .mockResolvedValueOnce(
        buildOpenAIResponse(buildLLMContentFromCandidates(batchAccepted[0]!), 1500, 600),
      )
      .mockResolvedValueOnce(
        buildOpenAIResponse(buildLLMContentFromCandidates(batchAccepted[1]!), 1500, 600),
      )
      .mockResolvedValueOnce(
        buildOpenAIResponse(buildLLMContentFromCandidates(batchAccepted[2]!), 800, 300),
      );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-batch-250',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(result.candidateCount).toBe(250);
    // Top-30 cap still applies over the union of all batches.
    expect(result.whitelist.length).toBe(30);
    // Tokens summed across batches: 1500+1500+800 prompt, 600+600+300 completion.
    expect(result.promptTokens).toBe(3800);
    expect(result.completionTokens).toBe(1500);
    // Cost summed too: 3800 × 0.15/1M + 1500 × 0.60/1M = 0.00057 + 0.0009 = 0.00147
    expect(result.extractionCostUsd).toBeCloseTo(0.00147, 6);
    // Top-30 should be the highest-frequency candidates regardless of batch
    // boundaries: term-0..term-29 (frequencies 250..221).
    expect(result.whitelist[0]?.term).toBe('term-0');
    expect(result.whitelist[0]?.frequency_in_source).toBe(250);
  });

  it('Wave 4: ≤BATCH_SIZE candidates uses single batch (no behavior change)', async () => {
    // 100 candidates → exactly 1 batch. Asserts the existing single-call
    // contract is preserved for small inputs.
    const candidates = makeNCandidates(100, 200);
    createMock.mockResolvedValueOnce(
      buildOpenAIResponse(buildLLMContentFromCandidates(candidates)),
    );

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-batch-100',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.whitelist.length).toBe(30);
  });

  it('Wave 4: cross-batch de-dup (term appearing in two batches counted once)', async () => {
    // 150 candidates split across 2 batches. We arrange the LLM to echo
    // "term-0" (a real candidate) back in BOTH batches' accepted lists.
    // This shouldn't normally happen — each batch only sees its slice —
    // but the de-dup guard is contract; we exercise it explicitly.
    const candidates = makeNCandidates(150, 150);
    // Batch 0 echoes back its slice (incl. term-0).
    const batch0Response = buildLLMContentFromCandidates(candidates.slice(0, 100));
    // Batch 1: doctored to ALSO echo term-0 (simulating an LLM hallucination
    // outside its slice — the hallucination guard would normally drop it,
    // BUT term-0 is a real candidate so it survives the guard).
    const batch1WithDup = JSON.stringify({
      anchors: [
        ...candidates.slice(100).map((c) => ({
          term: c.term,
          category: 'search-term' as const,
          keep: true,
        })),
        { term: 'term-0', category: 'named-system' as const, keep: true }, // dup!
      ],
    });
    createMock
      .mockResolvedValueOnce(buildOpenAIResponse(batch0Response))
      .mockResolvedValueOnce(buildOpenAIResponse(batch1WithDup));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-cross-batch-dup',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    // term-0 appears exactly once.
    const termZeroOccurrences = result.whitelist.filter((e) => e.term === 'term-0');
    expect(termZeroOccurrences.length).toBe(1);
    // First-batch-wins: term-0 keeps its 'search-term' category, not 'named-system'.
    expect(termZeroOccurrences[0]?.category).toBe('search-term');
  });

  it('Wave 4: glossary boost applies after merging batches (not per-batch)', async () => {
    // 150 candidates: 149 non-glossary + 1 glossary in the LAST position.
    // With BATCH_SIZE=100, the glossary candidate lands in batch-1 (the
    // second batch). The LLM rejects it in batch-1. The post-aggregation
    // glossary-boost step should still promote it into the top-30.
    const nonGlossary = Array.from({ length: 149 }, (_, i) =>
      makeCandidate({
        term: `ng-${i}`,
        frequency: 200 - i, // 200..52
        firstSeen: `page${i + 1}:paragraph0`,
      }),
    );
    const glossary = makeCandidate({
      term: 'BOOSTED_GLOSSARY',
      frequency: 1,
      source: 'glossary',
      firstSeen: 'page150:paragraph0',
      glossary: true,
    });
    const candidates = [...nonGlossary, glossary];

    // Batch 0 accepts its 100 non-glossary terms; batch 1 accepts ONLY
    // its 49 non-glossary terms (rejects the glossary candidate).
    const batch0 = buildLLMContentFromCandidates(candidates.slice(0, 100));
    const batch1 = buildLLMContentFromCandidates(candidates.slice(100, 149));
    createMock
      .mockResolvedValueOnce(buildOpenAIResponse(batch0))
      .mockResolvedValueOnce(buildOpenAIResponse(batch1));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-batch-glossary',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    // Glossary entry survives the top-30 cap.
    expect(result.whitelist.find((e) => e.term === 'BOOSTED_GLOSSARY')).toBeDefined();
    expect(result.whitelist.length).toBe(30);
  });

  it('Wave 4: bounded concurrency caps in-flight batches at MAX_CONCURRENT_BATCHES', async () => {
    // 600 candidates → 6 batches. MAX_CONCURRENT_BATCHES = 4, so the
    // runner must process them in chunks: 4-then-2 (or 4-then-4 etc.,
    // depending on implementation). We assert by counting how many
    // requests are "in-flight" at peak via a shared counter.
    const candidates = makeNCandidates(600, 600);
    let inFlight = 0;
    let peakInFlight = 0;

    createMock.mockImplementation(async () => {
      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      // Give the scheduler enough microtasks to actually overlap.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return buildOpenAIResponse(JSON.stringify({ anchors: [] }));
    });

    await scoreAnchorCandidates({
      pdfSha256: 'sha-concurrency',
      candidates,
    });

    expect(createMock).toHaveBeenCalledTimes(6);
    expect(peakInFlight).toBeLessThanOrEqual(__TEST_ONLY.MAX_CONCURRENT_BATCHES);
    // Sanity: we should actually be using concurrency, not running serial.
    expect(peakInFlight).toBeGreaterThan(1);
  });

  it('Wave 4: batch failure propagates (fail-fast over fail-open)', async () => {
    // First batch fails its full retry budget (7 calls of bad shape);
    // remaining batches should not need to succeed — the failure should
    // surface to the caller. (worker.ts wraps the whole call in its own
    // try/catch for fail-open.)
    const candidates = makeNCandidates(150, 150);
    createMock.mockResolvedValue(
      buildOpenAIResponse(JSON.stringify({ unrelated: 'object' })),
    );

    await expect(
      scoreAnchorCandidates({
        pdfSha256: 'sha-batch-fail',
        candidates,
      }),
    ).rejects.toBeInstanceOf(AnchorScorerParseError);
  });

  it('de-duplicates if LLM returns the same term twice', async () => {
    const candidates = [makeCandidate({ term: 'unique', frequency: 5 })];
    const content = JSON.stringify({
      anchors: [
        { term: 'unique', category: 'search-term', keep: true },
        { term: 'unique', category: 'named-system', keep: true },
      ],
    });
    createMock.mockResolvedValueOnce(buildOpenAIResponse(content));

    const result = await scoreAnchorCandidates({
      pdfSha256: 'sha-dup',
      candidates,
    });

    expect(result.whitelist.length).toBe(1);
    // First-wins de-dup → search-term.
    expect(result.whitelist[0]?.category).toBe('search-term');
  });
});
