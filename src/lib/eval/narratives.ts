/**
 * src/lib/eval/narratives.ts — read narratives + fidelity scores for a variant.
 *
 * Phase 1 is read-only against the DB (and the on-disk filesystem when a
 * narratives directory is provided). It does NOT call `generateChapter()`;
 * regeneration is delegated to `scripts/regenerate-chapters.ts` per the
 * task brief constraint "DO NOT regenerate tutorials" from the harness.
 *
 * Two read paths supported:
 *
 *   1. DB path (production): query the `chapters` table by tutorialId +
 *      ordinal, pluck `narrative` and `title`. Also query the most-recent
 *      row from `chapter_fidelity_scores` per D6 (Scorer-vs-humans).
 *
 *   2. Fixture path (test + replay): read `<dir>/ch{ordinal}.md` from a
 *      directory the caller specifies. Useful for evaluating narratives
 *      a prior harness run already dumped (or hand-curated fixtures the
 *      maintainer wants to A/B against without re-running generation).
 *
 * Design contract: HARNESS-DESIGN.md §"Phase 1" + §D6.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ChapterNarrative {
  chapterOrdinal: number;
  title: string;
  narrativeMarkdown: string;
  /** Most-recent overall_score from chapter_fidelity_scores (0–100). null if no row. */
  fidelityScore: number | null;
}

export interface NarrativeSourceFilesystem {
  type: 'filesystem';
  /**
   * Directory containing `ch{ordinal}.md` files. Optional `titles.json`
   * maps ordinal → title; absent titles fall back to `"Chapter N"`.
   */
  dir: string;
}

export interface NarrativeSourceDatabase {
  type: 'database';
  tutorialId: string;
  /** Minimum DB shape required — kept narrow so tests can mock easily. */
  db: NarrativeDbClient;
}

export type NarrativeSource = NarrativeSourceFilesystem | NarrativeSourceDatabase;

/**
 * Narrow DB contract — just the two reads the harness needs.
 * Production callers pass a real Drizzle handle wrapped to satisfy this;
 * tests pass an inline mock.
 */
export interface NarrativeDbClient {
  selectChapter: (tutorialId: string, ordinal: number) => {
    title: string;
    narrative: string | null;
  } | null;
  selectLatestFidelityScore: (chapterIdByOrdinal: {
    tutorialId: string;
    ordinal: number;
  }) => { overallScore: number } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────

export async function loadChapterNarratives(
  source: NarrativeSource,
  chapterRange: readonly [number, number],
): Promise<ChapterNarrative[]> {
  const [start, end] = chapterRange;
  if (start > end) {
    throw new Error(`chapter range invalid: [${start}, ${end}]`);
  }

  const results: ChapterNarrative[] = [];
  for (let ord = start; ord <= end; ord++) {
    if (source.type === 'filesystem') {
      results.push(loadFromFilesystem(source.dir, ord));
    } else {
      results.push(loadFromDatabase(source, ord));
    }
  }
  return results;
}

function loadFromFilesystem(dir: string, ord: number): ChapterNarrative {
  const file = path.resolve(dir, `ch${ord}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`narrative fixture not found: ${file}`);
  }
  const raw = fs.readFileSync(file, 'utf8');

  // Title can be supplied via a sibling `titles.json` mapping `{ "0": "..." }`.
  let title = `Chapter ${ord}`;
  const titlesPath = path.resolve(dir, 'titles.json');
  if (fs.existsSync(titlesPath)) {
    try {
      const titles = JSON.parse(fs.readFileSync(titlesPath, 'utf8')) as Record<
        string,
        string
      >;
      if (typeof titles[String(ord)] === 'string') {
        title = titles[String(ord)];
      }
    } catch {
      // Malformed titles.json shouldn't kill the run; fall back to default.
    }
  }

  // Optional sibling `fidelity.json` maps ordinal → overall_score (0-100).
  // Mirrors the D6 path so filesystem fixtures can carry scorer signal.
  let fidelityScore: number | null = null;
  const fidPath = path.resolve(dir, 'fidelity.json');
  if (fs.existsSync(fidPath)) {
    try {
      const scores = JSON.parse(fs.readFileSync(fidPath, 'utf8')) as Record<
        string,
        number
      >;
      const v = scores[String(ord)];
      if (typeof v === 'number' && v >= 0 && v <= 100) {
        fidelityScore = v;
      }
    } catch {
      // ignore
    }
  }

  return {
    chapterOrdinal: ord,
    title,
    narrativeMarkdown: raw,
    fidelityScore,
  };
}

function loadFromDatabase(
  source: NarrativeSourceDatabase,
  ord: number,
): ChapterNarrative {
  const chRow = source.db.selectChapter(source.tutorialId, ord);
  if (!chRow) {
    throw new Error(
      `chapter not found in DB: tutorialId=${source.tutorialId} ordinal=${ord}`,
    );
  }
  if (!chRow.narrative) {
    throw new Error(
      `chapter ${ord} of tutorial ${source.tutorialId} has no narrative yet; ` +
        `regenerate first via scripts/regenerate-chapters.ts before running the harness`,
    );
  }
  const fidRow = source.db.selectLatestFidelityScore({
    tutorialId: source.tutorialId,
    ordinal: ord,
  });
  return {
    chapterOrdinal: ord,
    title: chRow.title,
    narrativeMarkdown: chRow.narrative,
    fidelityScore: fidRow ? fidRow.overallScore : null,
  };
}

/**
 * Dump narratives to disk for archival under the run directory. Produces
 * `<outDir>/ch{ordinal}.md` + `titles.json` + `fidelity.json`. Mirrors the
 * design's file-layout block in HARNESS-DESIGN.md §"File layout".
 */
export function dumpNarrativesToDisk(
  narratives: ChapterNarrative[],
  outDir: string,
): void {
  fs.mkdirSync(outDir, { recursive: true });
  const titles: Record<string, string> = {};
  const fids: Record<string, number> = {};
  for (const n of narratives) {
    fs.writeFileSync(
      path.resolve(outDir, `ch${n.chapterOrdinal}.md`),
      n.narrativeMarkdown,
      'utf8',
    );
    titles[String(n.chapterOrdinal)] = n.title;
    if (n.fidelityScore !== null) {
      fids[String(n.chapterOrdinal)] = n.fidelityScore;
    }
  }
  fs.writeFileSync(
    path.resolve(outDir, 'titles.json'),
    JSON.stringify(titles, null, 2),
    'utf8',
  );
  if (Object.keys(fids).length > 0) {
    fs.writeFileSync(
      path.resolve(outDir, 'fidelity.json'),
      JSON.stringify(fids, null, 2),
      'utf8',
    );
  }
}
