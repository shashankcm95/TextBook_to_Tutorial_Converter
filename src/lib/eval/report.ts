/**
 * src/lib/eval/report.ts — render the A/B comparison report.
 *
 * Pure function: takes a flat array of rating rows + an optional fidelity
 * map, returns a markdown string. No I/O. The runner is responsible for
 * writing the string to `_ab-runs/<run-id>/report.md`.
 *
 * Aggregation rules (locked by docs/eval/RUBRIC.md §"Aggregation contract"):
 *   - Summary table: mean across chapters × runs, per persona × variant.
 *   - Per-chapter table: mean across runs only.
 *   - Convergent findings: anchors listed under `named_anchors_missing`
 *     by ≥ 3 of N personas, across all chapters, deduped.
 *   - Divergent findings: rating dimensions where the max-min spread
 *     across personas for the same chapter × variant exceeds 4 points.
 *   - Scorer-vs-humans (D6): chapter × variant rows where the automated
 *     fidelity scorer ≥ 80 but ≥ 2 personas rated `content_fidelity ≤ 5`.
 *
 * Design contract: HARNESS-DESIGN.md §"Output report" + §D6 + RUBRIC.md
 * §"Aggregation contract".
 */

import type { RatingResult } from './persona';
import { PHASE_1_DIMENSIONS, type RubricDimension } from './rubric';
import type { DiagramDensity } from './diagram-density';

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportInput {
  runId: string;
  /** Variant names in display order (left-to-right in tables). */
  variantNames: string[];
  personaSlugs: string[];
  /** Inclusive chapter range that was evaluated. */
  chapterRange: readonly [number, number];
  ratings: RatingResult[];
  /**
   * Optional: variant -> ordinal -> fidelityScore (0–100). Drives the
   * D6 "Scorer vs humans" section. Variants without scores are silently
   * skipped from that section.
   */
  fidelityByVariant?: Record<string, Record<number, number>>;
  /**
   * Optional advisory paragraph from the maintainer / a downstream LLM
   * call. Rendered under "Recommended next move" verbatim. If absent,
   * the section is omitted (NOT auto-generated — that's an explicit
   * non-goal per HARNESS-DESIGN.md Phase 1 §non-goals).
   */
  recommendedNextMove?: string;
  /**
   * Optional: variant -> chapterOrdinal -> DiagramDensity. Drives the
   * Sprint F.2 "Diagram emission density" section. Per RFC §"diagram
   * _block_density_per_chapter metric": rendered as a per-kind table so
   * readers can see which primitives the prompt is exercising vs the
   * Mermaid escape-hatch. Variants without densities are silently
   * skipped from that section; the section itself is omitted entirely
   * when the field is absent or empty (strictly additive).
   */
  diagramDensityByVariant?: Record<string, Record<number, DiagramDensity>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render entry
// ─────────────────────────────────────────────────────────────────────────────

export function renderReport(input: ReportInput): string {
  const sections: string[] = [];
  sections.push(renderHeader(input));
  sections.push(renderSummaryTable(input));
  sections.push(renderPerChapterBreakdown(input));
  sections.push(renderConvergentFindings(input));
  sections.push(renderDivergentFindings(input));
  if (input.fidelityByVariant) {
    sections.push(renderScorerVsHumans(input));
  }
  const diagramSection = renderDiagramDensity(input);
  if (diagramSection !== null) {
    sections.push(diagramSection);
  }
  if (input.recommendedNextMove) {
    sections.push(renderRecommendedNextMove(input));
  }
  return sections.join('\n\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

function renderHeader(input: ReportInput): string {
  const variantList = input.variantNames.join(' vs ');
  const [s, e] = input.chapterRange;
  return [
    `# A/B Comparison Report — ${variantList}`,
    '',
    `**Run ID:** \`${input.runId}\``,
    `**Variants:** ${input.variantNames.map((v) => `\`${v}\``).join(', ')}`,
    `**Personas:** ${input.personaSlugs.map((p) => `\`${p}\``).join(', ')}`,
    `**Chapters:** ${s}–${e}`,
    `**Total ratings:** ${input.ratings.length}`,
  ].join('\n');
}

function renderSummaryTable(input: ReportInput): string {
  const lines: string[] = ['## Summary table', '', `Mean across chapters × runs per persona × variant.`, ''];
  // Header
  const dimsForHeader = PHASE_1_DIMENSIONS;
  lines.push(
    `| Persona × Variant | ${dimsForHeader.join(' | ')} |`,
  );
  lines.push(`|${'---|'.repeat(1 + dimsForHeader.length)}`);

  for (const persona of input.personaSlugs) {
    for (const variant of input.variantNames) {
      const rows = input.ratings.filter(
        (r) => r.personaSlug === persona && r.variantName === variant,
      );
      const cells = dimsForHeader.map((dim) => formatMean(rows, dim));
      lines.push(`| ${persona} × ${variant} | ${cells.join(' | ')} |`);
    }
  }
  return lines.join('\n');
}

function renderPerChapterBreakdown(input: ReportInput): string {
  const lines: string[] = [
    '## Per-chapter breakdowns',
    '',
    'Mean across runs (or single rating when `--rate-runs=1`).',
    '',
  ];

  const [s, e] = input.chapterRange;
  const dim: RubricDimension = 'content_fidelity'; // the headline pedagogical signal
  lines.push(`### \`content_fidelity\` by chapter`);
  lines.push('');
  lines.push(
    `| Persona | Variant | ${range(s, e).map((o) => `ch${o}`).join(' | ')} |`,
  );
  lines.push(`|${'---|'.repeat(2 + (e - s + 1))}`);
  for (const persona of input.personaSlugs) {
    for (const variant of input.variantNames) {
      const cells = range(s, e).map((ord) => {
        const rows = input.ratings.filter(
          (r) =>
            r.personaSlug === persona &&
            r.variantName === variant &&
            r.chapterOrdinal === ord,
        );
        return formatMean(rows, dim);
      });
      lines.push(`| ${persona} | ${variant} | ${cells.join(' | ')} |`);
    }
  }
  return lines.join('\n');
}

function renderConvergentFindings(input: ReportInput): string {
  const lines: string[] = [
    '## Convergent findings',
    '',
    `Anchors listed under \`named_anchors_missing\` by ≥ ${convergentThreshold(input.personaSlugs.length)} of ${input.personaSlugs.length} personas, deduped across chapters.`,
    '',
  ];

  for (const variant of input.variantNames) {
    const anchorCounts = new Map<string, Set<string>>(); // anchor -> personas
    for (const rating of input.ratings) {
      if (rating.variantName !== variant) continue;
      for (const missing of rating.response.evidence.named_anchors_missing) {
        const key = missing.trim().toLowerCase();
        if (!key) continue;
        if (!anchorCounts.has(key)) anchorCounts.set(key, new Set());
        anchorCounts.get(key)!.add(rating.personaSlug);
      }
    }
    const threshold = convergentThreshold(input.personaSlugs.length);
    const convergent = [...anchorCounts.entries()]
      .filter(([, personas]) => personas.size >= threshold)
      .sort((a, b) => b[1].size - a[1].size);

    lines.push(`### Variant \`${variant}\``);
    lines.push('');
    if (convergent.length === 0) {
      lines.push('_No convergent missing anchors at this threshold._');
    } else {
      for (const [anchor, personas] of convergent) {
        lines.push(`- **${anchor}** — flagged missing by ${personas.size}/${input.personaSlugs.length} personas (${[...personas].sort().join(', ')})`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderDivergentFindings(input: ReportInput): string {
  const lines: string[] = [
    '## Divergent findings',
    '',
    'Rating dimensions where the max-min spread across personas for the same chapter × variant exceeds 4 points. Signal: failure is segment-specific.',
    '',
  ];

  const [s, e] = input.chapterRange;
  let any = false;
  for (const variant of input.variantNames) {
    for (let ord = s; ord <= e; ord++) {
      for (const dim of PHASE_1_DIMENSIONS) {
        const perPersonaMeans: { persona: string; mean: number }[] = [];
        for (const persona of input.personaSlugs) {
          const rows = input.ratings.filter(
            (r) =>
              r.variantName === variant &&
              r.chapterOrdinal === ord &&
              r.personaSlug === persona,
          );
          const vals = rows
            .map((r) => r.response.ratings[dim])
            .filter((v): v is number => typeof v === 'number');
          if (vals.length === 0) continue;
          perPersonaMeans.push({
            persona,
            mean: vals.reduce((a, b) => a + b, 0) / vals.length,
          });
        }
        if (perPersonaMeans.length < 2) continue;
        const max = Math.max(...perPersonaMeans.map((m) => m.mean));
        const min = Math.min(...perPersonaMeans.map((m) => m.mean));
        if (max - min > 4) {
          any = true;
          const ordered = perPersonaMeans.slice().sort((a, b) => b.mean - a.mean);
          const desc = ordered.map((m) => `${m.persona}=${m.mean.toFixed(1)}`).join(', ');
          lines.push(
            `- \`${variant}\` ch${ord} \`${dim}\` — spread ${(max - min).toFixed(1)} (${desc})`,
          );
        }
      }
    }
  }
  if (!any) {
    lines.push('_No divergent findings above the 4-point threshold._');
  }
  return lines.join('\n');
}

function renderScorerVsHumans(input: ReportInput): string {
  const lines: string[] = [
    '## Scorer vs humans (D6 — DRIFT-029 signal)',
    '',
    'Chapters where the automated fidelity scorer rated ≥ 80 (out of 100) but ≥ 2 personas rated `content_fidelity ≤ 5`. Signal: lexical match without semantic preservation.',
    '',
  ];

  const fidMap = input.fidelityByVariant ?? {};
  let any = false;
  const [s, e] = input.chapterRange;
  for (const variant of input.variantNames) {
    const fids = fidMap[variant] ?? {};
    for (let ord = s; ord <= e; ord++) {
      const scorer = fids[ord];
      if (typeof scorer !== 'number') continue;
      if (scorer < 80) continue;
      const lowPersonas = input.personaSlugs.filter((persona) => {
        const rows = input.ratings.filter(
          (r) =>
            r.variantName === variant &&
            r.chapterOrdinal === ord &&
            r.personaSlug === persona,
        );
        const vals = rows
          .map((r) => r.response.ratings.content_fidelity)
          .filter((v): v is number => typeof v === 'number');
        if (vals.length === 0) return false;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        return mean <= 5;
      });
      if (lowPersonas.length >= 2) {
        any = true;
        lines.push(
          `- \`${variant}\` ch${ord} — scorer=${scorer}/100 but ${lowPersonas.join(', ')} all rated content_fidelity ≤ 5`,
        );
      }
    }
  }
  if (!any) {
    lines.push('_No chapters trip the D6 signal in this run._');
  }
  return lines.join('\n');
}

/**
 * Sprint F.2 §"diagram_block_density_per_chapter metric": render a per-kind
 * emission table. Strictly additive — returns null (and thus omits the
 * section entirely) when `diagramDensityByVariant` is absent or contains
 * no rows. Existing report-rendering tests stay green.
 */
function renderDiagramDensity(input: ReportInput): string | null {
  const byVariant = input.diagramDensityByVariant;
  if (!byVariant) return null;

  // Flatten into a row list so we can decide "empty?" honestly — a present
  // but empty map still produces no section.
  const rows: { variant: string; ordinal: number; density: DiagramDensity }[] = [];
  for (const variant of input.variantNames) {
    const perChapter = byVariant[variant];
    if (!perChapter) continue;
    const ordinals = Object.keys(perChapter)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    for (const ord of ordinals) {
      const density = perChapter[ord];
      // Defensive: ordinal came from Object.keys(perChapter), so the lookup
      // is by construction defined. The fallthrough satisfies strict
      // noUncheckedIndexedAccess without adding runtime cost in the happy
      // path.
      if (!density) continue;
      rows.push({ variant, ordinal: ord, density });
    }
  }
  if (rows.length === 0) return null;

  const lines: string[] = [
    '## Diagram emission density',
    '',
    'Count of structured-diagram emissions per chapter, partitioned by `payload.kind`. Mermaid blocks tracked as a sibling column (escape-hatch signal, NOT collapsed into the per-kind sum). Parse failures tracked separately so they don\'t inflate or deflate emission rates.',
    '',
    '| Variant | Chapter | ComparisonTable | DefinitionList | DiagramFlow | StateTransition | Sequence | DecisionTree | Mermaid | Parse failures |',
    '|---------|---------|-----------------|----------------|-------------|-----------------|----------|--------------|---------|----------------|',
  ];
  for (const { variant, ordinal, density } of rows) {
    lines.push(
      `| ${variant} | ${ordinal} | ${density.byKind.ComparisonTable} | ${density.byKind.DefinitionList} | ${density.byKind.DiagramFlow} | ${density.byKind.StateTransitionDiagram} | ${density.byKind.SequenceDiagram} | ${density.byKind.DecisionTree} | ${density.mermaidBlocks} | ${density.parseFailures} |`,
    );
  }
  return lines.join('\n');
}

function renderRecommendedNextMove(input: ReportInput): string {
  return ['## Recommended next move', '', input.recommendedNextMove!.trim()].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatMean(rows: RatingResult[], dim: RubricDimension): string {
  const vals = rows
    .map((r) => r.response.ratings[dim])
    .filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return '—';
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return mean.toFixed(1);
}

function range(start: number, endInclusive: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= endInclusive; i++) out.push(i);
  return out;
}

/** Threshold for "convergent": ≥ 3 of 4, or ≥ ceil(N*0.75) for other N. */
function convergentThreshold(n: number): number {
  if (n <= 0) return 1;
  return Math.max(2, Math.ceil(n * 0.75));
}
