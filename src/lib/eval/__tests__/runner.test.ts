// src/lib/eval/__tests__/runner.test.ts
//
// End-to-end smoke test for the runner with a mocked LLM client + filesystem
// narrative source. No network calls, no DB calls. Exercises the full I/O
// layout per HARNESS-DESIGN.md §"File layout".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runEvalHarness } from '../runner';
import type { RatingChatClient } from '../persona';
import type { NarrativeSource } from '../narratives';

const VALID_PERSONA = `---
slug: tester
display_name: Tester
model: gpt-4o-mini
description: |
  Test persona.
---

# Tester

I am a test persona.
`;

function mockClient(): RatingChatClient {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ratings: {
                    content_fidelity: 7,
                    ux_clarity: null,
                    navigation_friction: null,
                    voice_match: 6,
                    learning_value: 7,
                    would_recommend: 7,
                  },
                  evidence: {
                    phrase_that_landed: 'x',
                    phrase_that_failed: '',
                    named_anchors_present: ['anchor-a'],
                    named_anchors_missing: ['anchor-b'],
                  },
                  free_form_notes: 'fine',
                }),
              },
            },
          ],
        }),
      },
    },
  };
}

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt-eval-runner-'));
  // Persona file
  fs.mkdirSync(path.join(sandbox, 'docs/eval/personas'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'docs/eval/personas/tester.md'), VALID_PERSONA);

  // Variant manifest
  fs.mkdirSync(path.join(sandbox, 'variants'), { recursive: true });
  fs.writeFileSync(
    path.join(sandbox, 'variants/v3.json'),
    JSON.stringify({
      name: 'v3',
      tutorial_id: 'fixture-tutorial',
      chapter_range: [0, 1],
    }),
  );

  // Narrative fixtures
  fs.mkdirSync(path.join(sandbox, 'fx/v3'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'fx/v3/ch0.md'), '# narrative 0\n\ncontent');
  fs.writeFileSync(path.join(sandbox, 'fx/v3/ch1.md'), '# narrative 1\n\ncontent');
  fs.writeFileSync(
    path.join(sandbox, 'fx/v3/titles.json'),
    JSON.stringify({ '0': 'Reliable Systems', '1': 'Data Models' }),
  );
  fs.writeFileSync(
    path.join(sandbox, 'fx/v3/fidelity.json'),
    JSON.stringify({ '0': 85, '1': 60 }),
  );
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('runEvalHarness — end-to-end with mocked LLM + filesystem fixtures', () => {
  it('writes the expected file layout and returns ratings', async () => {
    const client = mockClient();
    const result = await runEvalHarness({
      runId: 'smoke-1',
      repoRoot: sandbox,
      variantPaths: ['variants/v3.json'],
      personaSlugs: ['tester'],
      rateRuns: 1,
      narrativeSourceForVariant: (variant): NarrativeSource => ({
        type: 'filesystem',
        dir: path.resolve(sandbox, 'fx', variant.name),
      }),
      chatClient: client,
      logger: () => {
        /* silent */
      },
    });

    expect(result.ratings).toHaveLength(2); // 1 variant × 1 persona × 2 chapters
    expect(result.ratings[0].response.ratings.content_fidelity).toBe(7);

    // File layout (per HARNESS-DESIGN.md §"File layout")
    const outDir = result.outDir;
    expect(fs.existsSync(path.join(outDir, 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'narratives/v3/ch0.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'narratives/v3/ch1.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'ratings/v3/tester/ch0.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'ratings/v3/tester/ch1.json'))).toBe(true);

    // Per-rating JSON is the result object verbatim.
    const ch0Raw = fs.readFileSync(
      path.join(outDir, 'ratings/v3/tester/ch0.json'),
      'utf8',
    );
    const ch0 = JSON.parse(ch0Raw);
    expect(ch0.personaSlug).toBe('tester');
    expect(ch0.variantName).toBe('v3');
    expect(ch0.chapterOrdinal).toBe(0);
    expect(ch0.runIdx).toBe(0);

    // The report should pick up the fidelity scores via the D6 section.
    const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
    expect(report).toContain('A/B Comparison Report');
    expect(report).toContain('## Scorer vs humans');
    // ch0 has scorer=85 but personas gave content_fidelity=7 (not ≤ 5),
    // so D6 should NOT flag it. The section renders but the row is empty.
    expect(report).toContain('No chapters trip the D6 signal');
  });

  it('emits run-indexed filenames when rateRuns > 1', async () => {
    const client = mockClient();
    const result = await runEvalHarness({
      runId: 'smoke-rate-runs',
      repoRoot: sandbox,
      variantPaths: ['variants/v3.json'],
      personaSlugs: ['tester'],
      rateRuns: 3,
      narrativeSourceForVariant: (variant) => ({
        type: 'filesystem',
        dir: path.resolve(sandbox, 'fx', variant.name),
      }),
      chatClient: client,
      logger: () => undefined,
    });

    expect(result.ratings).toHaveLength(2 * 3);
    expect(
      fs.existsSync(
        path.join(result.outDir, 'ratings/v3/tester/ch0-run0.json'),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(result.outDir, 'ratings/v3/tester/ch0-run2.json'),
      ),
    ).toBe(true);
  });

  it('rejects rateRuns < 1', async () => {
    await expect(
      runEvalHarness({
        runId: 'bad',
        repoRoot: sandbox,
        variantPaths: ['variants/v3.json'],
        personaSlugs: ['tester'],
        rateRuns: 0,
        narrativeSourceForVariant: (variant) => ({
          type: 'filesystem',
          dir: path.resolve(sandbox, 'fx', variant.name),
        }),
        chatClient: mockClient(),
        logger: () => undefined,
      }),
    ).rejects.toThrow(/rateRuns/);
  });
});
