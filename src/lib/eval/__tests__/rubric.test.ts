// src/lib/eval/__tests__/rubric.test.ts
//
// Unit tests for the rubric schema + parser. The parser is the only thing
// standing between a wonky LLM response and the report aggregator, so the
// schema-violation paths matter more than the happy path.

import { describe, it, expect } from 'vitest';

import {
  RUBRIC_JSON_SCHEMA,
  RUBRIC_DIMENSIONS,
  PHASE_1_DIMENSIONS,
  FREE_FORM_NOTES_MAX_WORDS,
  parseRubricResponse,
  countWords,
} from '../rubric';

function validBody(overrides: Partial<Record<string, unknown>> = {}): string {
  const base = {
    ratings: {
      content_fidelity: 7,
      ux_clarity: null,
      navigation_friction: null,
      voice_match: 5,
      learning_value: 6,
      would_recommend: 7,
    },
    evidence: {
      phrase_that_landed: 'shared-nothing architecture',
      phrase_that_failed: 'innovative solutions',
      named_anchors_present: ['Chaos Monkey'],
      named_anchors_missing: ['head-of-line blocking', 't-digest'],
    },
    free_form_notes: 'A short note.',
  };
  return JSON.stringify({ ...base, ...overrides });
}

describe('rubric constants', () => {
  it('PHASE_1_DIMENSIONS is the strict subset that has non-null Phase 1 values', () => {
    expect(PHASE_1_DIMENSIONS).toEqual([
      'content_fidelity',
      'voice_match',
      'learning_value',
      'would_recommend',
    ]);
    // Every PHASE_1_DIMENSION must appear in RUBRIC_DIMENSIONS.
    for (const dim of PHASE_1_DIMENSIONS) {
      expect(RUBRIC_DIMENSIONS).toContain(dim);
    }
  });

  it('RUBRIC_JSON_SCHEMA declares strict mode and the six dims as required', () => {
    expect(RUBRIC_JSON_SCHEMA.strict).toBe(true);
    expect(RUBRIC_JSON_SCHEMA.schema.additionalProperties).toBe(false);
    const ratingProps = Object.keys(
      RUBRIC_JSON_SCHEMA.schema.properties.ratings.properties,
    );
    expect(ratingProps.sort()).toEqual([...RUBRIC_DIMENSIONS].sort());
    expect(
      RUBRIC_JSON_SCHEMA.schema.properties.ratings.required.sort(),
    ).toEqual([...RUBRIC_DIMENSIONS].sort());
  });
});

describe('parseRubricResponse — happy path', () => {
  it('accepts a well-formed body with one phase-2 dim left null', () => {
    const out = parseRubricResponse(validBody());
    expect(out.ratings.content_fidelity).toBe(7);
    expect(out.ratings.ux_clarity).toBeNull();
    expect(out.evidence.named_anchors_missing).toContain('t-digest');
  });
});

describe('parseRubricResponse — schema violations', () => {
  it('rejects ratings outside 1-10', () => {
    expect(() =>
      parseRubricResponse(
        validBody({
          ratings: {
            content_fidelity: 11,
            ux_clarity: null,
            navigation_friction: null,
            voice_match: 5,
            learning_value: 6,
            would_recommend: 7,
          },
        }),
      ),
    ).toThrow();
  });

  it('rejects non-integer ratings', () => {
    expect(() =>
      parseRubricResponse(
        validBody({
          ratings: {
            content_fidelity: 7.5,
            ux_clarity: null,
            navigation_friction: null,
            voice_match: 5,
            learning_value: 6,
            would_recommend: 7,
          },
        }),
      ),
    ).toThrow();
  });

  it('rejects missing evidence block', () => {
    const bad = JSON.stringify({
      ratings: {
        content_fidelity: 7,
        ux_clarity: null,
        navigation_friction: null,
        voice_match: 5,
        learning_value: 6,
        would_recommend: 7,
      },
      free_form_notes: 'hi',
    });
    expect(() => parseRubricResponse(bad)).toThrow();
  });

  it('rejects more than MAX_ANCHOR_LIST_ENTRIES items', () => {
    const tooMany = Array.from({ length: 20 }, (_, i) => `anchor-${i}`);
    expect(() =>
      parseRubricResponse(
        validBody({
          evidence: {
            phrase_that_landed: 'x',
            phrase_that_failed: '',
            named_anchors_present: tooMany,
            named_anchors_missing: [],
          },
        }),
      ),
    ).toThrow();
  });

  it(`rejects free_form_notes over ${FREE_FORM_NOTES_MAX_WORDS} words`, () => {
    const tooLong = Array.from({ length: FREE_FORM_NOTES_MAX_WORDS + 5 }, () => 'w').join(' ');
    expect(() =>
      parseRubricResponse(validBody({ free_form_notes: tooLong })),
    ).toThrow();
  });
});

describe('countWords', () => {
  it('handles trivial cases', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('one')).toBe(1);
    expect(countWords('one two  three')).toBe(3);
    expect(countWords('\n\n a b\nc ')).toBe(3);
  });
});
