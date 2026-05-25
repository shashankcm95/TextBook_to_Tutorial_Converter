// src/lib/eval/__tests__/report.test.ts
//
// Tests for the markdown renderer. Pure-function input/output; no I/O.

import { describe, it, expect } from 'vitest';

import { renderReport } from '../report';
import type { RatingResult } from '../persona';
import type { RubricResponse } from '../rubric';

function mkRating(
  overrides: Partial<RatingResult> & { ratings?: Partial<RubricResponse['ratings']> } = {},
): RatingResult {
  const base: RatingResult = {
    variantName: 'v3',
    chapterOrdinal: 0,
    personaSlug: 'professor',
    runIdx: 0,
    response: {
      ratings: {
        content_fidelity: 7,
        ux_clarity: null,
        navigation_friction: null,
        voice_match: 5,
        learning_value: 6,
        would_recommend: 6,
      },
      evidence: {
        phrase_that_landed: 'shared-nothing',
        phrase_that_failed: '',
        named_anchors_present: ['Chaos Monkey'],
        named_anchors_missing: [],
      },
      free_form_notes: 'note',
    },
  };
  return {
    ...base,
    ...overrides,
    response: {
      ...base.response,
      ...overrides.response,
      ratings: { ...base.response.ratings, ...(overrides.ratings ?? {}) },
    },
  };
}

describe('renderReport — structure', () => {
  it('produces the expected top-level sections', () => {
    const md = renderReport({
      runId: 'run-1',
      variantNames: ['v3', 'v4'],
      personaSlugs: ['professor', 'student'],
      chapterRange: [0, 1],
      ratings: [
        mkRating({ variantName: 'v3', chapterOrdinal: 0, personaSlug: 'professor' }),
        mkRating({ variantName: 'v4', chapterOrdinal: 0, personaSlug: 'professor' }),
        mkRating({ variantName: 'v3', chapterOrdinal: 1, personaSlug: 'student' }),
        mkRating({ variantName: 'v4', chapterOrdinal: 1, personaSlug: 'student' }),
      ],
    });
    expect(md).toContain('# A/B Comparison Report');
    expect(md).toContain('## Summary table');
    expect(md).toContain('## Per-chapter breakdowns');
    expect(md).toContain('## Convergent findings');
    expect(md).toContain('## Divergent findings');
    // Default (no fidelityByVariant) → no scorer section.
    expect(md).not.toContain('## Scorer vs humans');
  });

  it('lists each persona × variant row in the summary table', () => {
    const md = renderReport({
      runId: 'run-1',
      variantNames: ['v3', 'v4'],
      personaSlugs: ['professor', 'student'],
      chapterRange: [0, 0],
      ratings: [
        mkRating({ variantName: 'v3', personaSlug: 'professor' }),
        mkRating({ variantName: 'v4', personaSlug: 'professor' }),
        mkRating({ variantName: 'v3', personaSlug: 'student' }),
        mkRating({ variantName: 'v4', personaSlug: 'student' }),
      ],
    });
    expect(md).toContain('| professor × v3 |');
    expect(md).toContain('| professor × v4 |');
    expect(md).toContain('| student × v3 |');
    expect(md).toContain('| student × v4 |');
  });
});

describe('renderReport — convergent findings', () => {
  it('surfaces an anchor missing across ≥ 3 of 4 personas', () => {
    const personas = ['professor', 'student', 'domain-expert', 'author-kleppmann'];
    const ratings = personas.map((p) =>
      mkRating({
        variantName: 'v3',
        personaSlug: p,
        response: {
          evidence: {
            phrase_that_landed: 'x',
            phrase_that_failed: '',
            named_anchors_present: [],
            named_anchors_missing:
              p === 'author-kleppmann' ? [] : ['head-of-line blocking'],
          },
        } as Partial<RubricResponse> as RubricResponse,
      }),
    );
    const md = renderReport({
      runId: 'r',
      variantNames: ['v3'],
      personaSlugs: personas,
      chapterRange: [0, 0],
      ratings,
    });
    expect(md).toMatch(/head-of-line blocking.*flagged missing by 3\/4/);
  });

  it('does NOT surface an anchor flagged by < 3 of 4 personas', () => {
    const personas = ['professor', 'student', 'domain-expert', 'author-kleppmann'];
    const ratings = personas.map((p, i) =>
      mkRating({
        variantName: 'v3',
        personaSlug: p,
        response: {
          evidence: {
            phrase_that_landed: 'x',
            phrase_that_failed: '',
            named_anchors_present: [],
            named_anchors_missing: i < 2 ? ['t-digest'] : [],
          },
        } as Partial<RubricResponse> as RubricResponse,
      }),
    );
    const md = renderReport({
      runId: 'r',
      variantNames: ['v3'],
      personaSlugs: personas,
      chapterRange: [0, 0],
      ratings,
    });
    expect(md).not.toContain('t-digest');
  });
});

describe('renderReport — divergent findings', () => {
  it('flags a dimension where persona spread exceeds 4 points', () => {
    const ratings: RatingResult[] = [
      mkRating({
        variantName: 'v3',
        chapterOrdinal: 0,
        personaSlug: 'professor',
        ratings: { content_fidelity: 9 },
      }),
      mkRating({
        variantName: 'v3',
        chapterOrdinal: 0,
        personaSlug: 'student',
        ratings: { content_fidelity: 3 },
      }),
    ];
    const md = renderReport({
      runId: 'r',
      variantNames: ['v3'],
      personaSlugs: ['professor', 'student'],
      chapterRange: [0, 0],
      ratings,
    });
    expect(md).toMatch(/v3.*ch0.*content_fidelity.*spread 6/);
  });
});

describe('renderReport — D6 Scorer vs humans', () => {
  it('surfaces a chapter where scorer ≥ 80 but ≥ 2 personas rated content_fidelity ≤ 5', () => {
    const ratings: RatingResult[] = [
      mkRating({
        variantName: 'v3',
        chapterOrdinal: 0,
        personaSlug: 'professor',
        ratings: { content_fidelity: 4 },
      }),
      mkRating({
        variantName: 'v3',
        chapterOrdinal: 0,
        personaSlug: 'student',
        ratings: { content_fidelity: 5 },
      }),
    ];
    const md = renderReport({
      runId: 'r',
      variantNames: ['v3'],
      personaSlugs: ['professor', 'student'],
      chapterRange: [0, 0],
      ratings,
      fidelityByVariant: { v3: { 0: 90 } },
    });
    expect(md).toContain('## Scorer vs humans');
    expect(md).toMatch(/v3.*ch0.*scorer=90\/100/);
  });

  it('does NOT surface when scorer < 80', () => {
    const ratings: RatingResult[] = [
      mkRating({
        variantName: 'v3',
        chapterOrdinal: 0,
        personaSlug: 'professor',
        ratings: { content_fidelity: 4 },
      }),
      mkRating({
        variantName: 'v3',
        chapterOrdinal: 0,
        personaSlug: 'student',
        ratings: { content_fidelity: 5 },
      }),
    ];
    const md = renderReport({
      runId: 'r',
      variantNames: ['v3'],
      personaSlugs: ['professor', 'student'],
      chapterRange: [0, 0],
      ratings,
      fidelityByVariant: { v3: { 0: 70 } },
    });
    expect(md).toContain('No chapters trip the D6 signal');
  });
});

describe('renderReport — recommended next move', () => {
  it('renders the optional section when supplied', () => {
    const md = renderReport({
      runId: 'r',
      variantNames: ['v3'],
      personaSlugs: ['professor'],
      chapterRange: [0, 0],
      ratings: [mkRating()],
      recommendedNextMove: 'pivot to source-grounding',
    });
    expect(md).toContain('## Recommended next move');
    expect(md).toContain('pivot to source-grounding');
  });

  it('omits the section when absent (no auto-generation per Phase 1 non-goals)', () => {
    const md = renderReport({
      runId: 'r',
      variantNames: ['v3'],
      personaSlugs: ['professor'],
      chapterRange: [0, 0],
      ratings: [mkRating()],
    });
    expect(md).not.toContain('## Recommended next move');
  });
});
