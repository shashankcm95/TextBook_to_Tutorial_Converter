// scripts/rescore-fidelity.ts
//
// Wave 4 evaluation helper. Re-scores fidelity on EXISTING narratives
// using a freshly-extracted anchor whitelist. Purely additive: writes
// new chapter_fidelity_scores rows; does NOT modify narratives or
// chapters table.
//
// Use case: measure whether the new (post-Wave-4 batching) whitelist
// produces different fidelity scores on already-generated chapters
// without paying the regeneration cost ($0.10+ per smoke).
//
// Usage:
//   set -a && source .env && set +a
//   pnpm tsx scripts/rescore-fidelity.ts <tutorial-id> <start-ordinal> <end-ordinal>

import { db, rawDb } from '@/db/client';
import { tutorials, chapters, chapterFidelityScores } from '@/db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import { resolveChunksBucket, readAnchorWhitelist } from '@/lib/s3-chunks';
import { scoreFidelity } from '@/lib/openai/fidelity-check';
import type { SourceParagraph } from '@/lib/types';
import crypto from 'crypto';

async function main() {
  const [tutorialId, startStr, endStr] = process.argv.slice(2);
  if (!tutorialId || !startStr || !endStr) {
    console.error('Usage: pnpm tsx scripts/rescore-fidelity.ts <tutorial-id> <start> <end>');
    process.exit(1);
  }
  const startOrd = Number.parseInt(startStr, 10);
  const endOrd = Number.parseInt(endStr, 10);

  const [tutorial] = await db.select().from(tutorials).where(eq(tutorials.id, tutorialId)).limit(1);
  if (!tutorial || !tutorial.sourcePdfSha256) {
    console.error('tutorial not found or missing sha256');
    process.exit(1);
  }
  const bucket = resolveChunksBucket(tutorial.sourceS3Url);
  const whitelist = await readAnchorWhitelist({
    bucket,
    pdfSha256: tutorial.sourcePdfSha256,
  });
  if (!whitelist || whitelist.length === 0) {
    console.error('no anchor_whitelist.json in S3 — run extract-b-artifacts.ts first');
    process.exit(1);
  }
  console.log(`whitelist: ${whitelist.length} anchors`);

  const rows = await db
    .select()
    .from(chapters)
    .where(
      and(
        eq(chapters.tutorialId, tutorialId),
        eq(chapters.classification, 'body'),
        gte(chapters.ordinal, startOrd),
        lte(chapters.ordinal, endOrd),
      ),
    );
  rows.sort((a, b) => a.ordinal - b.ordinal);
  console.log(`chapters in range: ${rows.length}`);

  const results: Array<{
    ordinal: number;
    score: number;
    preservedAnchors: number | null;
    missingAnchors: number | null;
  }> = [];

  for (const row of rows) {
    if (!row.narrative) {
      console.log(`ch${row.ordinal}: SKIP (no narrative)`);
      continue;
    }
    const sourceParagraphs: SourceParagraph[] = row.sourceParagraphsJson
      ? (JSON.parse(row.sourceParagraphsJson) as SourceParagraph[])
      : [];
    if (sourceParagraphs.length === 0) {
      console.log(`ch${row.ordinal}: SKIP (no source paragraphs)`);
      continue;
    }
    const t0 = Date.now();
    const result = await scoreFidelity({
      chapterTitle: row.title,
      narrative: row.narrative,
      sourceParagraphs,
      anchorWhitelist: whitelist,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    // Write a fresh row (additive; preserves history).
    rawDb
      .prepare(
        `INSERT INTO chapter_fidelity_scores (
           id, chapter_id, specific_numbers_preserved, named_examples_preserved,
           terminological_contrasts_preserved, specific_numbers_missing,
           named_examples_missing, terminological_contrasts_missing,
           overall_score, notes_json, model, prompt_tokens, completion_tokens,
           cost_usd, whitelist_anchors_preserved, whitelist_anchors_missing
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        row.id,
        result.specificNumbersPreserved,
        result.namedExamplesPreserved,
        result.terminologicalContrastsPreserved,
        result.specificNumbersMissing,
        result.namedExamplesMissing,
        result.terminologicalContrastsMissing,
        result.overallScore,
        JSON.stringify(result.notes),
        result.model,
        result.promptTokens,
        result.completionTokens,
        result.costUsd,
        result.whitelistAnchorsPreserved,
        result.whitelistAnchorsMissing,
      );
    console.log(
      `ch${row.ordinal}: score=${result.overallScore} whitelist=${result.whitelistAnchorsPreserved}/${
        (result.whitelistAnchorsPreserved ?? 0) + (result.whitelistAnchorsMissing ?? 0)
      } cost=$${result.costUsd.toFixed(5)} elapsed=${elapsed}s`,
    );
    results.push({
      ordinal: row.ordinal,
      score: result.overallScore,
      preservedAnchors: result.whitelistAnchorsPreserved,
      missingAnchors: result.whitelistAnchorsMissing,
    });
  }

  console.log('---');
  console.log('SUMMARY (Wave 4 re-score):');
  for (const r of results) {
    console.log(`  ch${r.ordinal}: ${r.score} (whitelist ${r.preservedAnchors}/${(r.preservedAnchors ?? 0) + (r.missingAnchors ?? 0)})`);
  }
  const avg = results.reduce((s, r) => s + r.score, 0) / Math.max(1, results.length);
  console.log(`  avg: ${avg.toFixed(1)}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
