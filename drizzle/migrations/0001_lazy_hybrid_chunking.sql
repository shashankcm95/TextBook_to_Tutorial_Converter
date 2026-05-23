-- 0001_lazy_hybrid_chunking.sql — additive migration for feat/lazy-hybrid-chunking
--
-- Adds infrastructure for the hybrid-model lazy-chunking architecture:
--   - tutorials gains `parsed_s3_prefix` (S3 key prefix under which chunk
--     artifacts live) + `max_unlocked_chapter_idx` (one-way ratchet for gated
--     chapter release) + `outline_classification_version` (cache-invalidate when
--     the classifier algorithm changes).
--   - chapters gains classification (body vs appendix), chunk_s3_key (the
--     per-chapter chunk file in S3), parent_chapter_id + depth (TOC tree
--     navigation), released_at (null = locked), completion_criteria_met,
--     paragraph_count (used for chunker descent decisions in v2+).
--   - glossary_terms table for the side-asset extracted from `glossary`-
--     classified outline entries.
--   - skipped_sections table for audit-trail of front-matter / bibliography
--     entries that were classified out of the body-chunk set.
--
-- All ALTER TABLE additions are NULLABLE (or have NOT NULL DEFAULT) so existing
-- rows from the 0000_initial migration continue to satisfy the schema. The
-- migration is forward-compatible with backfill scripts in v2.
--
-- Idempotency NOTE: SQLite doesn't natively support `ADD COLUMN IF NOT EXISTS`
-- pre-3.35 — but the migrator (src/db/migrate.ts via better-sqlite3 exec) runs
-- statements once per migration filename, tracked in __drizzle_migrations.

-- ─────────────────────────────────────────────────────────────────────────────
-- tutorials: lazy-chunking state
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `tutorials` ADD COLUMN `parsed_s3_prefix` text;
--> statement-breakpoint
ALTER TABLE `tutorials` ADD COLUMN `max_unlocked_chapter_idx` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `tutorials` ADD COLUMN `outline_classification_version` integer NOT NULL DEFAULT 1;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- chapters: classification + gating + chunk pointers + tree
-- ─────────────────────────────────────────────────────────────────────────────
-- classification: 'body' chapters are generated + gated; 'appendix' are
-- on-demand only (no eager prefetch). Glossary/front-matter/bibliography never
-- land in chapters; they live in glossary_terms or skipped_sections.
ALTER TABLE `chapters` ADD COLUMN `classification` text NOT NULL DEFAULT 'body'
  CHECK (`classification` IN ('body','appendix'));
--> statement-breakpoint
-- chunk_s3_key: S3 key (relative to the source bucket) for this chapter's
-- chunk artifact. Format: `parsed/<pdf_sha256>/chapters/<NN>.json`. NULL only
-- for rows created before this migration (the legacy chapters with inline
-- source_paragraphs_json).
ALTER TABLE `chapters` ADD COLUMN `chunk_s3_key` text;
--> statement-breakpoint
-- TOC-tree navigation: parent_chapter_id links a chunk to its grouping outline
-- entry (e.g., a "Chapter N" chunk under a "Part X" grouping). depth mirrors
-- the outline depth at which this chunk was emitted. v1 leaves these mostly
-- null; v2+ populates for nested navigation.
ALTER TABLE `chapters` ADD COLUMN `parent_chapter_id` text
  REFERENCES `chapters`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `chapters` ADD COLUMN `depth` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- released_at: when the gating ratchet unlocked this chapter for the user.
-- NULL = still locked. Ordinal 0 is released_at=now at ingest time. Other
-- chapters get a value only when the prior chapter's completion criteria are
-- met (max_unlocked_chapter_idx ratchet bump).
ALTER TABLE `chapters` ADD COLUMN `released_at` integer;
--> statement-breakpoint
-- completion_criteria_met: 0/1 flag. Per the v1 policy (gating commit):
--   last_quiz_score >= 0.6  OR  manual override (set via /complete endpoint).
-- This column is set by the release-policy server-side; client cannot write.
ALTER TABLE `chapters` ADD COLUMN `completion_criteria_met` integer NOT NULL DEFAULT 0
  CHECK (`completion_criteria_met` IN (0,1));
--> statement-breakpoint
-- paragraph_count: cached count from chunker; used by descent decisions in
-- the chunker without re-parsing the chunk artifact each pass.
ALTER TABLE `chapters` ADD COLUMN `paragraph_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Index for the new released_at + parent_chapter_id query paths
CREATE INDEX `idx_chapters_released` ON `chapters` (`tutorial_id`, `released_at`);
--> statement-breakpoint
CREATE INDEX `idx_chapters_parent` ON `chapters` (`parent_chapter_id`);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- glossary_terms: extracted from `glossary`-classified outline entries
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE `glossary_terms` (
  `id` text PRIMARY KEY NOT NULL,
  `tutorial_id` text NOT NULL,
  `term` text NOT NULL,
  `definition` text NOT NULL,
  `source_paragraph_ref` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`tutorial_id`) REFERENCES `tutorials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_glossary_tutorial` ON `glossary_terms` (`tutorial_id`);
--> statement-breakpoint
-- (tutorial_id, term) is a natural uniqueness candidate but we omit the
-- constraint to allow same term cited from multiple source paragraphs (e.g.,
-- "consistency" definition in different chapters). Query path collapses
-- duplicates at read time.
CREATE INDEX `idx_glossary_term ` ON `glossary_terms` (`tutorial_id`, `term`);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- skipped_sections: audit trail for front-matter / bibliography / index
-- ─────────────────────────────────────────────────────────────────────────────
-- These outline entries are deliberately NOT generated as tutorials, but we
-- preserve the metadata so the UI can:
--   (a) explain "Foreword skipped" to the user
--   (b) link to the source PDF at the right page range
--   (c) audit chunker classifier decisions across runs
CREATE TABLE `skipped_sections` (
  `tutorial_id` text NOT NULL,
  `outline_title` text NOT NULL,
  `classification` text NOT NULL
    CHECK (`classification` IN ('front-matter','bibliography','glossary','index')),
  `page_start` integer NOT NULL,
  `page_end` integer NOT NULL,
  PRIMARY KEY (`tutorial_id`, `outline_title`),
  FOREIGN KEY (`tutorial_id`) REFERENCES `tutorials`(`id`) ON UPDATE no action ON DELETE cascade
);
