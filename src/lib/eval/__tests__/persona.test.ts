// src/lib/eval/__tests__/persona.test.ts
//
// Tests for the persona loader + rater. The LLM client is always mocked —
// per the task brief: "DO NOT mint OpenAI API calls in tests."

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parsePersonaFile,
  loadPersona,
  buildRatingMessages,
  rateChapter,
  type RatingChatClient,
  type Persona,
} from '../persona';

const VALID_FILE = `---
slug: professor
display_name: The Professor
model: gpt-4o-mini
description: |
  Tenured CS professor who reads tutorials with a pedagogical lens.
---

# The Professor

## Who you are

I am a tenured CS professor.

## Honesty constraint

If I cannot honestly judge a dimension, I say so.
`;

describe('parsePersonaFile', () => {
  it('parses front-matter + body from a well-formed file', () => {
    const { frontMatter, body } = parsePersonaFile(VALID_FILE, '<test>');
    expect(frontMatter.slug).toBe('professor');
    expect(frontMatter.display_name).toBe('The Professor');
    expect(frontMatter.model).toBe('gpt-4o-mini');
    expect(frontMatter.description).toContain('Tenured CS professor');
    expect(body).toContain('# The Professor');
    expect(body).toContain('Honesty constraint');
  });

  it('throws on missing front-matter', () => {
    expect(() => parsePersonaFile('no front-matter here', '<test>')).toThrow(/front-matter/);
  });

  it('throws on missing required key', () => {
    const bad = `---
slug: x
display_name: Y
model: m
---

body
`;
    expect(() => parsePersonaFile(bad, '<test>')).toThrow(/description/);
  });
});

describe('loadPersona', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ttt-eval-persona-'));
    fs.mkdirSync(path.join(sandbox, 'docs/eval/personas'), { recursive: true });
    fs.writeFileSync(
      path.join(sandbox, 'docs/eval/personas/professor.md'),
      VALID_FILE,
    );
  });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('loads a persona by slug from the default dir', () => {
    const p = loadPersona('professor', sandbox);
    expect(p.slug).toBe('professor');
    expect(p.displayName).toBe('The Professor');
    expect(p.body).toContain('# The Professor');
  });

  it('refuses unsafe slugs', () => {
    expect(() => loadPersona('../etc/passwd', sandbox)).toThrow(/safe/);
  });

  it('throws when the file is missing', () => {
    expect(() => loadPersona('does-not-exist', sandbox)).toThrow(/not found/);
  });

  it('throws when filename slug ≠ front-matter slug', () => {
    fs.writeFileSync(
      path.join(sandbox, 'docs/eval/personas/student.md'),
      VALID_FILE, // front-matter still says "professor"
    );
    expect(() => loadPersona('student', sandbox)).toThrow(/does not match/);
  });
});

describe('buildRatingMessages', () => {
  const persona: Persona = {
    slug: 'professor',
    displayName: 'The Professor',
    model: 'gpt-4o-mini',
    description: 'd',
    body: 'PERSONA BODY HERE',
    sourcePath: '<test>',
  };

  it('inlines the persona body verbatim in the system prompt', () => {
    const msgs = buildRatingMessages({
      persona,
      variantName: 'v3',
      chapterOrdinal: 2,
      chapterTitle: 'Latency',
      narrativeMarkdown: 'narrative text',
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content.startsWith('PERSONA BODY HERE')).toBe(true);
    expect(msgs[0].content).toContain('ux_clarity` and');
    expect(msgs[0].content).toContain('navigation_friction` MUST be `null`');
  });

  it('mentions peer variants in the user prompt when provided', () => {
    const msgs = buildRatingMessages({
      persona,
      variantName: 'v4',
      chapterOrdinal: 0,
      chapterTitle: 'Intro',
      narrativeMarkdown: 'x',
      peerVariantNames: ['v3', 'v5'],
    });
    expect(msgs[1].content).toContain('v3, v5');
    expect(msgs[1].content).toContain('variant "v4"');
  });
});

describe('rateChapter (mocked LLM)', () => {
  const persona: Persona = {
    slug: 'professor',
    displayName: 'The Professor',
    model: 'gpt-4o-mini',
    description: 'd',
    body: 'BODY',
    sourcePath: '<test>',
  };

  function mockClient(responseJson: string): { client: RatingChatClient; create: ReturnType<typeof vi.fn> } {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: responseJson } }],
    });
    const client: RatingChatClient = {
      chat: { completions: { create: create as unknown as RatingChatClient['chat']['completions']['create'] } },
    };
    return { client, create };
  }

  it('returns a parsed RubricResponse and threads variant / chapter / persona / runIdx into the result', async () => {
    const responseJson = JSON.stringify({
      ratings: {
        content_fidelity: 8,
        ux_clarity: null,
        navigation_friction: null,
        voice_match: 6,
        learning_value: 7,
        would_recommend: 7,
      },
      evidence: {
        phrase_that_landed: 'shared-nothing',
        phrase_that_failed: '',
        named_anchors_present: ['Chaos Monkey'],
        named_anchors_missing: ['t-digest'],
      },
      free_form_notes: 'fine',
    });
    const { client, create } = mockClient(responseJson);
    const result = await rateChapter(
      {
        persona,
        variantName: 'v4',
        chapterOrdinal: 2,
        chapterTitle: 'Latency',
        narrativeMarkdown: 'n',
      },
      client,
      0,
    );
    expect(result.personaSlug).toBe('professor');
    expect(result.variantName).toBe('v4');
    expect(result.chapterOrdinal).toBe(2);
    expect(result.runIdx).toBe(0);
    expect(result.response.ratings.content_fidelity).toBe(8);

    // Confirm the call used structured-output mode + the persona's model.
    expect(create).toHaveBeenCalledTimes(1);
    const callArgs = create.mock.calls[0][0] as {
      model: string;
      response_format: { type: string; json_schema: { strict: boolean; name: string } };
    };
    expect(callArgs.model).toBe('gpt-4o-mini');
    expect(callArgs.response_format.type).toBe('json_schema');
    expect(callArgs.response_format.json_schema.strict).toBe(true);
    expect(callArgs.response_format.json_schema.name).toBe('persona_rating');
  });

  it('throws when the LLM returns empty content', async () => {
    const { client } = mockClient('');
    // Override to return null content
    client.chat.completions.create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null } }],
    }) as unknown as RatingChatClient['chat']['completions']['create'];
    await expect(
      rateChapter(
        {
          persona,
          variantName: 'v3',
          chapterOrdinal: 0,
          chapterTitle: 't',
          narrativeMarkdown: 'n',
        },
        client,
      ),
    ).rejects.toThrow(/empty response/);
  });

  it('throws when the LLM returns invalid JSON', async () => {
    const { client } = mockClient('not-json');
    await expect(
      rateChapter(
        {
          persona,
          variantName: 'v3',
          chapterOrdinal: 0,
          chapterTitle: 't',
          narrativeMarkdown: 'n',
        },
        client,
      ),
    ).rejects.toThrow();
  });
});
