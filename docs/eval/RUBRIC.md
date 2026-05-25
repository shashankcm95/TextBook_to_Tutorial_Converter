# Eval Harness — Rubric Reference

**Status:** authoritative reference for `scripts/ab-compare.ts` and the
persona prompts under `docs/eval/personas/*.md`.
**Source of truth:** the JSON schema in `scripts/_ab-lib/rubric.ts`. This
markdown is the human-readable mirror. If the two disagree, the schema wins
and this file is the bug.

This rubric is the shared scoring contract that every persona, in every
phase (1 = text-only, 2 = browser-driven UAT, 3 = UX engineer), uses to
emit ratings the harness can aggregate into the report.

---

## The six dimensions

Each scored on a 1–10 integer scale. `null` is legal only when the dimension
is out of scope for the current phase (see "phase ownership" column).

| Dim | Question the persona is answering | Phase that fills it |
|---|---|---|
| `content_fidelity` | Did the source's concrete anchors, terminology, named incidents survive into the tutorial? | 1, 2 |
| `ux_clarity` | Is the page hierarchy and copy clear at first glance? | 2 only |
| `navigation_friction` | How many clicks / how much cognitive load to get from "I want to learn X" to "I am learning X"? | 2 only |
| `voice_match` | Does this sound like the author or like generic LLM blog filler? | 1, 2 |
| `learning_value` | Would I (in persona) remember the load-bearing facts 6 months from now? | 1, 2 |
| `would_recommend` | Would I tell someone in my persona's segment to use this tool? | 1, 2 |

### Scale anchors (apply to every dimension)

- **1–3**: actively bad. The tutorial fails on this axis in a way a
  reader would notice and complain about.
- **4–6**: passable. The tutorial neither helps nor hurts on this axis.
- **7–8**: good. Comparable to a competent human-authored equivalent.
- **9–10**: exceptional. Better than the source on this axis (rare —
  reserve for cases where the tutorial genuinely improves on the book).

A persona using `7+` for everything is a red flag the rating was lazy.
A persona using `≤3` for everything is a red flag the persona's prompt
biased it toward negativity. The harness surfaces both patterns in the
"Persona calibration" section of the report.

---

## Mandatory evidence fields

Personas cannot emit just numbers; the harness rejects ratings without
the `evidence` block. This is the load-bearing constraint that keeps
ratings auditable.

```jsonc
{
  "evidence": {
    "phrase_that_landed":   "...verbatim quote from the narrative...",
    "phrase_that_failed":   "...verbatim quote, or '' if nothing failed...",
    "named_anchors_present": ["Chaos Monkey", "shared-nothing", "Twitter fanout"],
    "named_anchors_missing": ["head-of-line blocking", "t-digest", "HdrHistogram"]
  }
}
```

- `phrase_that_landed`: 1 quote (max ~30 words) of something that worked.
- `phrase_that_failed`: 1 quote of something that didn't (or empty string).
- `named_anchors_present` / `named_anchors_missing`: arrays of strings
  drawn from the chapter's anchor whitelist (or domain-canonical terms
  the persona expected to see). Max 12 entries each.

When all 4 personas independently list the same string under
`named_anchors_missing`, the report's "Convergent findings" section
surfaces it as a structural failure (not a stylistic one).

---

## Bounded free-form notes

`free_form_notes` is a single string, ≤ 300 words, holding the persona's
qualitative read. This is for the maintainer to skim; the harness does
NOT parse it. Personas should NOT use this field to smuggle additional
ratings — those go in the `ratings` block.

---

## Per-rating provenance

Every rating row carries:

- `variant`: the variant name from the manifest (e.g. `"v4"`).
- `chapter`: 0-based ordinal.
- `persona`: the persona file slug (e.g. `"professor"`).
- `run_idx`: which rating-run produced this row (0..rateRuns-1). When
  `--rate-runs=1` (default), this is always 0. When `--rate-runs=3`
  (publishing-run mode per D2), three rows exist per
  persona × variant × chapter and the report aggregates mean +
  std-dev.

---

## Aggregation contract

The report renderer (`scripts/_ab-lib/report.ts`) aggregates ratings
deterministically:

- **Summary table**: mean across chapters × runs, per persona × variant.
- **Per-chapter table**: mean across runs only, per chapter × persona × variant.
- **Convergent findings**: anchors in `named_anchors_missing` listed by
  ≥ 3 of 4 personas (across all chapters, deduped).
- **Divergent findings**: rating dimensions where the max-min spread
  across personas for the same chapter × variant exceeds 4 points.
- **Scorer-vs-humans flag** (D6): chapters where the automated scorer
  (`chapter_fidelity_scores.overall_score / 10`, rescaled 0–10) ≥ 8
  but ≥ 2 personas rated `content_fidelity ≤ 5`. This is the DRIFT-029
  signal — lexical match without semantic preservation.

---

## JSON schema location

The strict JSON schema enforced against persona responses lives at:

- `scripts/_ab-lib/rubric.ts` → exported as `RUBRIC_JSON_SCHEMA`.

The schema is passed verbatim to the OpenAI structured-output API as
`response_format: { type: 'json_schema', json_schema: { strict: true, ... } }`
so the model's output is mechanically valid OR the call fails. No
markdown-parsing, no regex extraction.
