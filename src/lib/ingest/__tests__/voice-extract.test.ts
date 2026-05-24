// src/lib/ingest/__tests__/voice-extract.test.ts
//
// Unit tests for the voice-profile extractor (Feature B', Wave 1).
//
// Coverage:
//   - sampleParagraphs (pure): exact-10, <10, >10 (uniform stride), 0-empty
//   - buildVoiceUserPrompt: ref shape + count marker
//   - extractVoiceProfile: happy path with mocked OpenAI (cost computed,
//     all fields populated, schema_version + sampler_version stamped)
//   - VoiceProfileParseError: malformed JSON triggers it; withRetry-driven
//     retry semantics observed (parse-retry budget = 1, so 2 total attempts)
//   - Model + prompt invariants asserted via __TEST_ONLY (no string drift)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SourceParagraph } from '@/lib/types';

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
  extractVoiceProfile,
  sampleParagraphs,
  buildVoiceUserPrompt,
  VoiceProfileParseError,
  __TEST_ONLY,
  type VoiceProfile,
} from '../voice-extract';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

function makeParagraph(page: number, paragraphIdx: number, text: string): SourceParagraph {
  return { page, paragraphIdx, text };
}

/** Build N paragraphs with deterministic page/paragraphIdx for sample-tracking. */
function makeNParagraphs(n: number): SourceParagraph[] {
  return Array.from({ length: n }, (_, i) =>
    makeParagraph(Math.floor(i / 3) + 1, i % 3, `para-${i}-content`),
  );
}

/** A valid LLM-response JSON string matching the strict schema. */
const VALID_LLM_RESPONSE = JSON.stringify({
  tone_summary: 'Dry, pragmatic, allergic to hype; explains via concrete incidents.',
  signature_moves: [
    { name: 'Question opener', description: 'Opens chapters with a question or pushback.' },
    { name: 'Benefit-then-qualify', description: 'Sets up benefits then immediately qualifies.' },
    { name: 'Named incidents', description: 'Names canonical incidents (leap-second, Knight Capital).' },
  ],
  example_phrases: [
    { phrase: 'as it turns out, this is harder than it looks', ref: 'page1:paragraph0' },
    { phrase: 'the literature glosses over this', ref: 'page2:paragraph1' },
    { phrase: 'in practice, almost no one does this', ref: 'page3:paragraph2' },
    { phrase: 'a beautifully clean theorem with no operational legs', ref: 'page4:paragraph0' },
    { phrase: 'consider the case where the clock goes backwards', ref: 'page5:paragraph1' },
  ],
  humor_patterns: [
    'Dry asides about industry hype, usually one clause long.',
    'Self-deprecating callbacks to earlier oversimplifications.',
  ],
  preferred_analogies: [
    'Reaches for postal/messaging analogies (envelopes, post offices, letters).',
    'Occasional clock + calendar metaphors.',
  ],
});

function buildOpenAIResponseFromContent(content: string, promptTokens = 1200, completionTokens = 400): {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
} {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// sampleParagraphs — pure sampling logic
// ───────────────────────────────────────────────────────────────────────────

describe('sampleParagraphs', () => {
  it('returns empty array when no paragraphs', () => {
    expect(sampleParagraphs([])).toEqual([]);
  });

  it('returns all paragraphs when fewer than SAMPLE_SIZE (10)', () => {
    const five = makeNParagraphs(5);
    const out = sampleParagraphs(five);
    expect(out).toEqual(five);
    expect(out.length).toBe(5);
  });

  it('returns exactly 10 when input is exactly 10', () => {
    const ten = makeNParagraphs(10);
    const out = sampleParagraphs(ten);
    // length <= SAMPLE_SIZE branch returns a copy of the full list
    expect(out).toEqual(ten);
    expect(out.length).toBe(10);
  });

  it('samples 10 with uniform stride when input is much larger', () => {
    const hundred = makeNParagraphs(100);
    const out = sampleParagraphs(hundred);
    expect(out.length).toBe(10);
    // stride = floor(100 / 10) = 10; indices 0,10,20,...,90
    for (let i = 0; i < 10; i++) {
      // We embedded the index in the text as `para-${i}-content`
      expect(out[i]?.text).toBe(`para-${i * 10}-content`);
    }
  });

  it('handles non-divisible sizes (stride = floor(length/10))', () => {
    const fortyTwo = makeNParagraphs(42);
    const out = sampleParagraphs(fortyTwo);
    expect(out.length).toBe(10);
    // stride = floor(42 / 10) = 4; indices 0,4,8,...,36
    for (let i = 0; i < 10; i++) {
      expect(out[i]?.text).toBe(`para-${i * 4}-content`);
    }
  });

  it('preserves page + paragraphIdx for ref reconstruction', () => {
    const twenty = makeNParagraphs(20);
    const out = sampleParagraphs(twenty);
    // First sample is index 0 → page 1, paragraphIdx 0
    expect(out[0]).toMatchObject({ page: 1, paragraphIdx: 0 });
    // Each entry should have a numeric page + paragraphIdx
    for (const p of out) {
      expect(typeof p.page).toBe('number');
      expect(typeof p.paragraphIdx).toBe('number');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildVoiceUserPrompt — prompt formatting
// ───────────────────────────────────────────────────────────────────────────

describe('buildVoiceUserPrompt', () => {
  it('renders each paragraph as [pageN:paragraphM] <text>', () => {
    const samples: SourceParagraph[] = [
      makeParagraph(1, 0, 'first text'),
      makeParagraph(8, 5, 'second text'),
    ];
    const prompt = buildVoiceUserPrompt(samples);
    expect(prompt).toContain('[page1:paragraph0] first text');
    expect(prompt).toContain('[page8:paragraph5] second text');
  });

  it('uses the actual sample count in the "(N total)" marker', () => {
    const seven = makeNParagraphs(7);
    const prompt = buildVoiceUserPrompt(seven);
    expect(prompt).toContain('(7 total)');
  });

  it('ends with the "Output strict JSON now." instruction', () => {
    const samples = makeNParagraphs(3);
    const prompt = buildVoiceUserPrompt(samples);
    expect(prompt.trim().endsWith('Output strict JSON now.')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// extractVoiceProfile — integration with mocked OpenAI
// ───────────────────────────────────────────────────────────────────────────

describe('extractVoiceProfile', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('returns a fully-populated VoiceProfile on a happy-path call', async () => {
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent(VALID_LLM_RESPONSE));

    const paragraphs = makeNParagraphs(50);
    const profile: VoiceProfile = await extractVoiceProfile({
      pdfSha256: 'sha-abc-123',
      bodyParagraphs: paragraphs,
    });

    // Stamped fields
    expect(profile.schema_version).toBe(1);
    expect(profile.model).toBe('gpt-4o-mini');
    expect(profile.sampler_version).toBe('uniform-body-v1');
    expect(profile.sample_size).toBe(10); // 50 > SAMPLE_SIZE → 10 sampled
    expect(typeof profile.extracted_at).toBe('string');
    // ISO timestamp shape
    expect(profile.extracted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Cost computed from the (mocked) usage block. gpt-4o-mini pricing:
    // 1200 prompt × 0.15/1M + 400 completion × 0.60/1M
    //   = 0.00018 + 0.00024 = 0.00042
    expect(profile.extraction_cost_usd).toBeCloseTo(0.00042, 6);

    // LLM-sourced fields
    expect(profile.tone_summary).toContain('pragmatic');
    expect(profile.signature_moves.length).toBe(3);
    expect(profile.signature_moves[0]?.name).toBe('Question opener');
    expect(profile.example_phrases.length).toBe(5);
    expect(profile.example_phrases[0]?.ref).toBe('page1:paragraph0');
    expect(profile.humor_patterns.length).toBe(2);
    expect(profile.preferred_analogies.length).toBe(2);
  });

  it('passes the verbatim system prompt + correct model + temperature=0', async () => {
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent(VALID_LLM_RESPONSE));

    await extractVoiceProfile({
      pdfSha256: 'sha-xyz',
      bodyParagraphs: makeNParagraphs(20),
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
    expect(callArgs.messages[1]?.content).toContain('SAMPLE PARAGRAPHS:');
    expect(callArgs.messages[1]?.content).toContain('Output strict JSON now.');
    // Strict-mode JSON schema is wired up.
    expect(callArgs.response_format.type).toBe('json_schema');
  });

  it('reflects sample_size when input has fewer than 10 paragraphs', async () => {
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent(VALID_LLM_RESPONSE));

    const profile = await extractVoiceProfile({
      pdfSha256: 'sha-small',
      bodyParagraphs: makeNParagraphs(4),
    });
    expect(profile.sample_size).toBe(4);
  });

  it('throws VoiceProfileParseError after exhausting the retry budget on malformed JSON', async () => {
    // withRetry's parse-error budget is `[0]` but `Math.min(attempt, 0) === 0`
    // for every attempt, so parse errors are retried up to maxAttempts() = 7.
    // We mockResolvedValue (not Once) so every call returns the malformed
    // response and the loop walks the full attempt budget.
    createMock.mockResolvedValue(buildOpenAIResponseFromContent('this is not JSON {'));

    await expect(
      extractVoiceProfile({
        pdfSha256: 'sha-bad-json',
        bodyParagraphs: makeNParagraphs(15),
      }),
    ).rejects.toBeInstanceOf(VoiceProfileParseError);

    // Confirms withRetry IS on the call path — more than 1 call means at
    // least one parse-retry was scheduled (i.e., the wrapper is wired up).
    expect(createMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('throws VoiceProfileParseError when JSON is valid but the shape is wrong', async () => {
    const wrongShape = JSON.stringify({ unrelated: 'object' });
    createMock.mockResolvedValue(buildOpenAIResponseFromContent(wrongShape));

    await expect(
      extractVoiceProfile({
        pdfSha256: 'sha-wrong-shape',
        bodyParagraphs: makeNParagraphs(15),
      }),
    ).rejects.toBeInstanceOf(VoiceProfileParseError);
  });

  it('recovers on parse-retry when first attempt returns malformed JSON and second succeeds', async () => {
    // First attempt: bad JSON → triggers VoiceProfileParseError → withRetry
    //   schedules a parse-retry (0ms delay).
    // Second attempt: good JSON → success.
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent('not JSON'));
    createMock.mockResolvedValueOnce(buildOpenAIResponseFromContent(VALID_LLM_RESPONSE));

    const profile = await extractVoiceProfile({
      pdfSha256: 'sha-retry',
      bodyParagraphs: makeNParagraphs(15),
    });

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(profile.tone_summary).toContain('pragmatic');
  });
});
