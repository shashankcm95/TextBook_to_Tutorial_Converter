/**
 * src/lib/eval/rubric.ts — single source of truth for the persona rating rubric.
 *
 * Mirrored in `docs/eval/RUBRIC.md` (human-readable). If the two disagree,
 * THIS FILE wins — the JSON schema is what gets passed to the OpenAI
 * structured-output API as `response_format`, and `parseRubricResponse()`
 * here is what actually gates whether a persona response is admitted to
 * the report.
 *
 * Design contract: docs/eval/HARNESS-DESIGN.md §Rubric +
 * §"Cross-phase rubric reference".
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** The six rating dimensions, in the canonical order they appear in the report. */
export const RUBRIC_DIMENSIONS = [
  'content_fidelity',
  'ux_clarity',
  'navigation_friction',
  'voice_match',
  'learning_value',
  'would_recommend',
] as const;

export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

/**
 * Dimensions that Phase 1 (text-only) can rate. The other two
 * (`ux_clarity`, `navigation_friction`) are Phase 2 only and stay
 * null in Phase 1 output.
 */
export const PHASE_1_DIMENSIONS = [
  'content_fidelity',
  'voice_match',
  'learning_value',
  'would_recommend',
] as const satisfies readonly RubricDimension[];

export type Phase1Dimension = (typeof PHASE_1_DIMENSIONS)[number];

/** Max words allowed in `free_form_notes`. Enforced server-side at parse time. */
export const FREE_FORM_NOTES_MAX_WORDS = 300;

/** Max entries each in the `named_anchors_present` / `named_anchors_missing` arrays. */
export const MAX_ANCHOR_LIST_ENTRIES = 12;

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema — passed verbatim to OpenAI structured outputs (strict mode).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON schema for a single persona × variant × chapter × run-idx rating.
 *
 * Strict mode requires `additionalProperties: false` AND every property
 * named in `properties` listed in `required` (OpenAI's structured-output
 * contract). To allow nullable values (Phase 2-only dims in Phase 1
 * output), we use `{ type: ['integer', 'null'] }` for the optional dims.
 */
export const RUBRIC_JSON_SCHEMA = {
  name: 'persona_rating',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ratings', 'evidence', 'free_form_notes'],
    properties: {
      ratings: {
        type: 'object',
        additionalProperties: false,
        required: [...RUBRIC_DIMENSIONS],
        properties: {
          content_fidelity: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
          ux_clarity: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
          navigation_friction: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
          voice_match: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
          learning_value: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
          would_recommend: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
        },
      },
      evidence: {
        type: 'object',
        additionalProperties: false,
        required: [
          'phrase_that_landed',
          'phrase_that_failed',
          'named_anchors_present',
          'named_anchors_missing',
        ],
        properties: {
          phrase_that_landed: { type: 'string', maxLength: 400 },
          phrase_that_failed: { type: 'string', maxLength: 400 },
          named_anchors_present: {
            type: 'array',
            items: { type: 'string', maxLength: 120 },
            maxItems: MAX_ANCHOR_LIST_ENTRIES,
          },
          named_anchors_missing: {
            type: 'array',
            items: { type: 'string', maxLength: 120 },
            maxItems: MAX_ANCHOR_LIST_ENTRIES,
          },
        },
      },
      free_form_notes: { type: 'string', maxLength: 2400 },
    },
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Zod validator — second-layer defense (in case the API returns nominally
// strict-mode-valid JSON that still violates a constraint, e.g., the word
// cap on `free_form_notes` which the schema only approximates with
// `maxLength`).
// ─────────────────────────────────────────────────────────────────────────────

const ratingZ = z.number().int().min(1).max(10).nullable();

export const RubricResponseSchema = z.object({
  ratings: z.object({
    content_fidelity: ratingZ,
    ux_clarity: ratingZ,
    navigation_friction: ratingZ,
    voice_match: ratingZ,
    learning_value: ratingZ,
    would_recommend: ratingZ,
  }),
  evidence: z.object({
    phrase_that_landed: z.string().max(400),
    phrase_that_failed: z.string().max(400),
    named_anchors_present: z.array(z.string().max(120)).max(MAX_ANCHOR_LIST_ENTRIES),
    named_anchors_missing: z.array(z.string().max(120)).max(MAX_ANCHOR_LIST_ENTRIES),
  }),
  free_form_notes: z
    .string()
    .max(2400)
    .refine(
      (s) => countWords(s) <= FREE_FORM_NOTES_MAX_WORDS,
      `free_form_notes must be ≤ ${FREE_FORM_NOTES_MAX_WORDS} words`,
    ),
});

export type RubricResponse = z.infer<typeof RubricResponseSchema>;

/**
 * Parse + validate a raw string (typically `response.choices[0].message.content`)
 * into a structured RubricResponse. Throws on any failure — strict-mode JSON
 * schema usually prevents structural errors, but the word-cap on
 * `free_form_notes` is enforced here.
 */
export function parseRubricResponse(rawJson: string): RubricResponse {
  const parsed = JSON.parse(rawJson) as unknown;
  return RubricResponseSchema.parse(parsed);
}

/**
 * Token-light word counter for the notes cap. Splits on whitespace, filters
 * empty strings. Matches the "I'd type this into a textbox" notion of "word"
 * rather than a linguistically pure one.
 */
export function countWords(s: string): number {
  return s
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}
