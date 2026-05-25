/**
 * src/lib/eval/runner.ts — Phase 1 A/B orchestrator.
 *
 * Glues the four pure modules together:
 *
 *   1. variant.ts      — manifest schema, apply/revert
 *   2. narratives.ts   — read narratives (DB or filesystem fixture)
 *   3. persona.ts      — load persona file, build prompt, call LLM
 *   4. report.ts       — render the markdown report
 *
 * The runner ONLY orchestrates — it owns no rubric logic, no prompt text,
 * no aggregation rules. Each of those lives in the module above. The runner
 * is the one place where I/O is allowed and where the file-layout per
 * HARNESS-DESIGN.md §"File layout" is materialized.
 *
 * Phase 1 explicit non-goals respected here:
 *   - No browser interaction (Phase 2's job).
 *   - No regen of fidelity scores (read-only from DB/fixture).
 *   - No automated decision-making (the report's "Recommended next move"
 *     is optional and supplied by the caller, not auto-generated).
 *
 * Design contract: HARNESS-DESIGN.md §"Phase 1 — Text-only A/B harness".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  applyVariant,
  revertVariant,
  readVariantManifest,
  type AppliedVariant,
  type VariantManifest,
} from './variant';
import {
  loadChapterNarratives,
  dumpNarrativesToDisk,
  type ChapterNarrative,
  type NarrativeSource,
} from './narratives';
import {
  loadPersona,
  rateChapter,
  type Persona,
  type RatingChatClient,
  type RatingResult,
} from './persona';
import { renderReport } from './report';

// ─────────────────────────────────────────────────────────────────────────────
// Public shape
// ─────────────────────────────────────────────────────────────────────────────

export interface RunnerConfig {
  runId: string;
  repoRoot: string;
  variantPaths: string[];
  personaSlugs: string[];
  /**
   * How many independent rating calls per persona × variant × chapter.
   * Default 1 (iteration). Pass 3 for publishing runs per D2.
   */
  rateRuns: number;
  /**
   * Where to read narratives from for each variant. Production wiring
   * passes a `database` source per variant (or one shared if all variants
   * point at the same tutorial_id). Test wiring passes filesystem dirs.
   */
  narrativeSourceForVariant: (variant: VariantManifest) => NarrativeSource;
  /**
   * LLM client used for rating calls. In tests this is a hand-rolled
   * mock; in production this is `openai` from `@/lib/openai/client`.
   */
  chatClient: RatingChatClient;
  /**
   * Output root. Defaults to `<repoRoot>/_ab-runs/<runId>` per design.
   */
  outDir?: string;
  /**
   * Optional advisory string for the report's "Recommended next move"
   * section. The runner does NOT generate it — that's an explicit Phase 1
   * non-goal. Pass null/undefined to omit the section.
   */
  recommendedNextMove?: string;
  /** Optional logger (defaults to console.log). Used for progress lines. */
  logger?: (msg: string) => void;
}

export interface RunnerResult {
  runId: string;
  outDir: string;
  reportPath: string;
  ratings: RatingResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

export async function runEvalHarness(cfg: RunnerConfig): Promise<RunnerResult> {
  const log = cfg.logger ?? ((m: string) => console.log(m));
  const outDir = cfg.outDir ?? path.resolve(cfg.repoRoot, '_ab-runs', cfg.runId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.resolve(outDir, 'narratives'), { recursive: true });
  fs.mkdirSync(path.resolve(outDir, 'ratings'), { recursive: true });

  // 1) Load manifests + personas up-front. Failing fast here means we don't
  //    apply a variant only to discover a typo'd persona slug 5 minutes in.
  const variants: VariantManifest[] = cfg.variantPaths.map((p) =>
    readVariantManifest(path.resolve(cfg.repoRoot, p)),
  );
  const personas: Persona[] = cfg.personaSlugs.map((slug) =>
    loadPersona(slug, cfg.repoRoot),
  );

  if (cfg.rateRuns < 1) {
    throw new Error(`rateRuns must be ≥ 1; got ${cfg.rateRuns}`);
  }

  // 2) Per-variant: apply, load narratives, dump, revert, then rate.
  //    We dump+revert BEFORE rating so the working tree is clean during the
  //    long-tail rating phase. (Important: the apply/revert is for the
  //    NARRATIVE read step — if narratives are coming from DB, the variant
  //    apply is what determines which prompt was active at regen time.
  //    Phase 1's read-only mode means the variant matters only for what
  //    narratives the runner FETCHES, not what it generates.)
  const allRatings: RatingResult[] = [];
  const narrativesByVariant = new Map<string, ChapterNarrative[]>();
  const fidelityByVariant: Record<string, Record<number, number>> = {};

  for (const variant of variants) {
    log(`[eval] variant=${variant.name}: applying`);
    const applied: AppliedVariant = applyVariant(variant, cfg.repoRoot);
    try {
      const source = cfg.narrativeSourceForVariant(variant);
      const narratives = await loadChapterNarratives(source, variant.chapter_range);
      narrativesByVariant.set(variant.name, narratives);

      // Dump for archival.
      const narrDir = path.resolve(outDir, 'narratives', variant.name);
      dumpNarrativesToDisk(narratives, narrDir);

      // Capture fidelity scores for the D6 section.
      const fidMap: Record<number, number> = {};
      for (const n of narratives) {
        if (n.fidelityScore !== null) fidMap[n.chapterOrdinal] = n.fidelityScore;
      }
      if (Object.keys(fidMap).length > 0) {
        fidelityByVariant[variant.name] = fidMap;
      }
    } finally {
      revertVariant(applied);
      log(`[eval] variant=${variant.name}: reverted`);
    }
  }

  // 3) Rating loop: persona × variant × chapter × run-idx. Sequential by
  //    design — concurrency requires per-key rate limiting we can build
  //    later; for now the wall-clock estimate (HARNESS-DESIGN.md ~18 min
  //    for 3 variants × 4 personas) is acceptable serial.
  const peerNames = variants.map((v) => v.name);
  for (const variant of variants) {
    const narratives = narrativesByVariant.get(variant.name)!;
    for (const persona of personas) {
      const ratingDir = path.resolve(outDir, 'ratings', variant.name, persona.slug);
      fs.mkdirSync(ratingDir, { recursive: true });
      for (const narr of narratives) {
        for (let runIdx = 0; runIdx < cfg.rateRuns; runIdx++) {
          log(
            `[eval] rate variant=${variant.name} persona=${persona.slug} ch=${narr.chapterOrdinal} run=${runIdx}`,
          );
          const result = await rateChapter(
            {
              persona,
              variantName: variant.name,
              chapterOrdinal: narr.chapterOrdinal,
              chapterTitle: narr.title,
              narrativeMarkdown: narr.narrativeMarkdown,
              peerVariantNames: peerNames.filter((n) => n !== variant.name),
            },
            cfg.chatClient,
            runIdx,
          );
          allRatings.push(result);

          // Persist per-rating JSON. Filename layout per design §"File layout".
          const fname =
            cfg.rateRuns === 1
              ? `ch${narr.chapterOrdinal}.json`
              : `ch${narr.chapterOrdinal}-run${runIdx}.json`;
          fs.writeFileSync(
            path.resolve(ratingDir, fname),
            JSON.stringify(result, null, 2),
            'utf8',
          );
        }
      }
    }
  }

  // 4) Render report.
  const reportMd = renderReport({
    runId: cfg.runId,
    variantNames: variants.map((v) => v.name),
    personaSlugs: personas.map((p) => p.slug),
    chapterRange: variants[0].chapter_range, // assume same range across variants for Phase 1
    ratings: allRatings,
    fidelityByVariant:
      Object.keys(fidelityByVariant).length > 0 ? fidelityByVariant : undefined,
    recommendedNextMove: cfg.recommendedNextMove,
  });

  const reportPath = path.resolve(outDir, 'report.md');
  fs.writeFileSync(reportPath, reportMd, 'utf8');

  // 5) config.json — the run's "what was compared" record (design §"File layout").
  fs.writeFileSync(
    path.resolve(outDir, 'config.json'),
    JSON.stringify(
      {
        runId: cfg.runId,
        variants: variants.map((v) => ({ name: v.name, manifest: v })),
        personas: personas.map((p) => p.slug),
        rateRuns: cfg.rateRuns,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  log(`[eval] wrote ${reportPath}`);
  return {
    runId: cfg.runId,
    outDir,
    reportPath,
    ratings: allRatings,
  };
}
