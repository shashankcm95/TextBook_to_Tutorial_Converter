-- 0007_adjacent_pair_metric.sql — Q3 v3 adjacent-pair citation gate (soft metric).
--
-- Persona re-walk on 2026-05-26 (Theo CRITICAL finding) discovered that
-- PR #40's Q3 v2 range-ban (which eliminated `[ref:pageN:paragraphM-K]`
-- syntax: 13% → 0%) canonicalized the same pedagogical lie into adjacent-pair
-- citation spray (e.g. `[ref:page42:paragraph6][ref:page42:paragraph21]` with
-- 14 uncited paragraphs between). ch56 even emits cross-page pairs that are
-- almost certainly hallucinated spans.
--
-- This migration adds two NULLABLE columns to chapter_fidelity_scores:
--   - adjacent_pair_count: integer count of adjacent ref-pairs in the woven narrative
--   - adjacent_pair_penalty: real [0, 1] soft penalty score
--
-- Nullable for backward compatibility with rows scored before Q3 v3 landed.
-- The detector is OBSERVABILITY-only in v1 — a later PR (Q3 v4) will use the
-- accumulated data to set thresholds for a hard rejection/retry gate.
--
-- See src/lib/citations/adjacent-pair-gate.ts for the pure-function detector.
-- See SI-citation-pair-laundering-001 for the discipline note.
--
-- Schema-additive (per project migration discipline). SQLite ALTER TABLE ADD
-- COLUMN is a metadata-only op on SQLite ≥3.35.

ALTER TABLE `chapter_fidelity_scores`
  ADD COLUMN `adjacent_pair_count` integer;
--> statement-breakpoint
ALTER TABLE `chapter_fidelity_scores`
  ADD COLUMN `adjacent_pair_penalty` real;
