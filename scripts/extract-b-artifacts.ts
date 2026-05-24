// scripts/extract-b-artifacts.ts
//
// One-shot Feature B' artifact extractor. For a tutorial that was ingested
// BEFORE Feature B' shipped, this script reads the existing chunks from S3
// + the existing glossary, runs the voice + anchor extractors, and writes
// voice_profile.json + anchor_whitelist.json to S3.
//
// Use case: smoke-testing Wave 3 against the v3-baseline tutorial without
// paying the ~25MB PDF re-ingest cost.
//
// Usage:
//   set -a && source .env && set +a
//   pnpm tsx scripts/extract-b-artifacts.ts <tutorial-id>
//
// The script is idempotent — it skips extractors whose artifacts already
// exist in S3 (use `--force` to overwrite).

import { db } from '@/db/client';
import { tutorials, chapters } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import {
  resolveChunksBucket,
  readGlossary,
  readVoiceProfile,
  readAnchorWhitelist,
  writeVoiceProfile,
  writeAnchorWhitelist,
} from '@/lib/s3-chunks';
import { extractVoiceProfile } from '@/lib/ingest/voice-extract';
import { extractAnchorCandidates } from '@/lib/ingest/anchor-prefilter';
import { scoreAnchorCandidates } from '@/lib/ingest/anchor-scorer';
import type { SourceParagraph } from '@/lib/types';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const tutorialId = args.find((a) => !a.startsWith('--'));

  if (!tutorialId) {
    console.error('usage: pnpm tsx scripts/extract-b-artifacts.ts <tutorial-id> [--force]');
    process.exit(1);
  }

  const [tutorial] = await db
    .select()
    .from(tutorials)
    .where(eq(tutorials.id, tutorialId))
    .limit(1);
  if (!tutorial) {
    console.error(`tutorial ${tutorialId} not found`);
    process.exit(1);
  }
  if (!tutorial.sourcePdfSha256) {
    console.error(`tutorial ${tutorialId} has no sourcePdfSha256 (ingest incomplete)`);
    process.exit(1);
  }

  const bucket = resolveChunksBucket(tutorial.sourceS3Url);
  const sha256 = tutorial.sourcePdfSha256;
  console.log(`tutorial=${tutorialId}`);
  console.log(`sha256=${sha256}`);
  console.log(`bucket=${bucket}`);

  // Idempotency check
  if (!force) {
    const [vp, aw] = await Promise.all([
      readVoiceProfile({ bucket, pdfSha256: sha256 }).catch(() => null),
      readAnchorWhitelist({ bucket, pdfSha256: sha256 }).catch(() => null),
    ]);
    if (vp && aw) {
      console.log('both artifacts already present; skipping (use --force to re-extract)');
      return;
    }
  }

  // Collect body paragraphs from existing chapter rows. We bypass the
  // chunker entirely — the chapters table already has source_paragraphs_json
  // populated from the prior ingest. This is the cheap path: no PDF parse,
  // no chunker re-run.
  const rows = await db
    .select()
    .from(chapters)
    .where(and(eq(chapters.tutorialId, tutorialId), eq(chapters.classification, 'body')));
  console.log(`body chapters: ${rows.length}`);

  const bodyParagraphs: SourceParagraph[] = [];
  for (const row of rows) {
    if (!row.sourceParagraphsJson || row.sourceParagraphsJson === '[]') continue;
    try {
      const parsed = JSON.parse(row.sourceParagraphsJson) as SourceParagraph[];
      if (Array.isArray(parsed)) {
        bodyParagraphs.push(...parsed);
      }
    } catch {
      // skip
    }
  }
  console.log(`body paragraphs collected: ${bodyParagraphs.length}`);
  if (bodyParagraphs.length === 0) {
    console.error('no body paragraphs found — cannot extract');
    process.exit(1);
  }

  // Cap input size for the smoke run: a 613-page book like DDIA has ~5000
  // body paragraphs which (a) overshoots the voice extractor's 10-sample
  // window pointlessly and (b) blows the anchor scorer's 128K context
  // window on candidate count. For the smoke we sample evenly across the
  // body so voice + anchors remain representative.
  const MAX_BODY_PARAGRAPHS_FOR_EXTRACTION = 300;
  let sampledParagraphs = bodyParagraphs;
  if (bodyParagraphs.length > MAX_BODY_PARAGRAPHS_FOR_EXTRACTION) {
    const stride = Math.floor(bodyParagraphs.length / MAX_BODY_PARAGRAPHS_FOR_EXTRACTION);
    sampledParagraphs = [];
    for (let i = 0; i < bodyParagraphs.length && sampledParagraphs.length < MAX_BODY_PARAGRAPHS_FOR_EXTRACTION; i += stride) {
      const p = bodyParagraphs[i];
      if (p) sampledParagraphs.push(p);
    }
    console.log(`sampled to ${sampledParagraphs.length} paragraphs (stride=${stride})`);
  }

  // Pull glossary for anchor pre-filter input (optional — anchor-prefilter
  // works without it; glossary just adds priority candidates).
  const glossary = await readGlossary(bucket, sha256).catch(() => null);
  const glossaryTermStrings = glossary?.terms.map((t) => t.term) ?? [];
  console.log(`glossary terms: ${glossaryTermStrings.length}`);

  // Run both extractors in parallel.
  console.log('extracting voice profile + anchor whitelist (parallel)...');
  const [voiceProfile, anchorResult] = await Promise.all([
    extractVoiceProfile({ pdfSha256: sha256, bodyParagraphs: sampledParagraphs }),
    (async () => {
      const candidates = extractAnchorCandidates({
        bodyParagraphs: sampledParagraphs,
        glossaryTerms: glossaryTermStrings,
      });
      console.log(`anchor candidates: ${candidates.length}`);
      // Cap candidates handed to the LLM scorer; the scorer itself reads up
      // to MAX (its internal default) but DDIA can produce 500+ candidates.
      // Top-100 by frequency (the candidates are already sorted desc) keeps
      // the scorer prompt under ~30K tokens.
      const MAX_CANDIDATES_FOR_LLM = 100;
      const cappedCandidates = candidates.slice(0, MAX_CANDIDATES_FOR_LLM);
      if (cappedCandidates.length < candidates.length) {
        console.log(`capped to ${cappedCandidates.length} (top by frequency) for LLM scoring`);
      }
      return scoreAnchorCandidates({ pdfSha256: sha256, candidates: cappedCandidates });
    })(),
  ]);

  console.log(`voice profile: ${voiceProfile.signature_moves.length} moves, ${voiceProfile.example_phrases.length} phrases`);
  console.log(`anchor whitelist: ${anchorResult.whitelist.length} entries (from ${anchorResult.candidateCount} candidates)`);
  console.log(`voice cost: $${voiceProfile.extraction_cost_usd.toFixed(5)}`);
  console.log(`anchor cost: $${anchorResult.extractionCostUsd.toFixed(5)}`);

  // Write to S3 in parallel.
  console.log('writing artifacts to S3...');
  await Promise.all([
    writeVoiceProfile({ bucket, pdfSha256: sha256, profile: voiceProfile }),
    writeAnchorWhitelist({
      bucket,
      pdfSha256: sha256,
      whitelist: {
        schema_version: 1,
        extracted_at: new Date().toISOString(),
        model: anchorResult.model,
        extraction_cost_usd: anchorResult.extractionCostUsd,
        candidate_count: anchorResult.candidateCount,
        accepted_count: anchorResult.acceptedCount,
        anchors: anchorResult.whitelist,
      },
    }),
  ]);

  console.log('✓ done');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
