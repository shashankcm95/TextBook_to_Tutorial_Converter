// src/lib/citations/__tests__/adjacent-pair-gate.test.ts — Q3 v3 contract tests.
//
// Coverage:
//   - Boundary behaviors (empty, single ref, non-adjacent).
//   - Same-page gap thresholds (1, 2 = OK; 3, 15 = violation).
//   - Cross-page detection (with high and low paragraph deltas).
//   - Reverse-order pair uses Math.abs.
//   - Realistic ch40-style spray fragment.
//   - PenaltyScore boundary math.
//   - Defensive parsing: malformed refs are ignored.
//   - Inter-ref content sentinel: alphanumerics break adjacency.

import { describe, it, expect } from 'vitest';
import { detectAdjacentPairViolations } from '../adjacent-pair-gate';

describe('detectAdjacentPairViolations', () => {
  it('handles empty narrative', () => {
    const result = detectAdjacentPairViolations('');
    expect(result.totalRefs).toBe(0);
    expect(result.adjacentPairs).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.penaltyScore).toBe(0);
  });

  it('handles a narrative with no refs', () => {
    const result = detectAdjacentPairViolations(
      'This is plain prose with no citations at all. Several sentences. Even more.',
    );
    expect(result.totalRefs).toBe(0);
    expect(result.adjacentPairs).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.penaltyScore).toBe(0);
  });

  it('handles a single ref (no pairs possible)', () => {
    const result = detectAdjacentPairViolations(
      'A single citation [ref:page42:paragraph3] alone.',
    );
    expect(result.totalRefs).toBe(1);
    expect(result.adjacentPairs).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.penaltyScore).toBe(0);
  });

  it('does not count two refs separated by a sentence as adjacent', () => {
    const result = detectAdjacentPairViolations(
      'First claim [ref:page42:paragraph3] occupies the lead. Then a separate idea [ref:page42:paragraph4] follows.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(0);
    expect(result.violations).toEqual([]);
    expect(result.penaltyScore).toBe(0);
  });

  it('counts adjacent pair with same-page gap=1 as a pair but NOT a violation', () => {
    const result = detectAdjacentPairViolations(
      'Foo [ref:page42:paragraph3][ref:page42:paragraph4] bar.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(1);
    expect(result.violations).toEqual([]);
    expect(result.penaltyScore).toBe(0);
  });

  it('counts adjacent pair with same-page gap=2 as a pair but NOT a violation (boundary)', () => {
    const result = detectAdjacentPairViolations(
      'Foo [ref:page42:paragraph3][ref:page42:paragraph5] bar.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(1);
    expect(result.violations).toEqual([]);
    expect(result.penaltyScore).toBe(0);
  });

  it('flags adjacent pair with same-page gap=3 as a violation (just over boundary)', () => {
    const result = detectAdjacentPairViolations(
      'Foo [ref:page42:paragraph3][ref:page42:paragraph6] bar.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(1);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v?.kind).toBe('same-page-gap-gt-2');
    expect(v?.gap).toBe(3);
    expect(v?.refA).toEqual({ page: 42, paragraph: 3 });
    expect(v?.refB).toEqual({ page: 42, paragraph: 6 });
    expect(v?.text).toBe('[ref:page42:paragraph3][ref:page42:paragraph6]');
  });

  it('flags adjacent pair with same-page gap=15 (ch36 wild case)', () => {
    const result = detectAdjacentPairViolations(
      'Foo [ref:page42:paragraph6][ref:page42:paragraph21] bar.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(1);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v?.kind).toBe('same-page-gap-gt-2');
    expect(v?.gap).toBe(15);
  });

  it('flags a cross-page pair (ch56 cross-page case)', () => {
    const result = detectAdjacentPairViolations(
      'Foo [ref:page42:paragraph3][ref:page43:paragraph1] bar.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(1);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v?.kind).toBe('cross-page');
    expect(Number.isNaN(v?.gap)).toBe(true);
    expect(v?.refA).toEqual({ page: 42, paragraph: 3 });
    expect(v?.refB).toEqual({ page: 43, paragraph: 1 });
  });

  it('flags cross-page even with high paragraph difference (cross-page takes precedence)', () => {
    // From ch56 evidence: page260:paragraph19 + page261:paragraph4
    const result = detectAdjacentPairViolations(
      'Edge case [ref:page260:paragraph19][ref:page261:paragraph4] hallucinated.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(1);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v?.kind).toBe('cross-page');
    expect(Number.isNaN(v?.gap)).toBe(true);
  });

  it('flags reverse-order pair using Math.abs', () => {
    const result = detectAdjacentPairViolations(
      'Foo [ref:page42:paragraph8][ref:page42:paragraph3] bar.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(1);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v?.kind).toBe('same-page-gap-gt-2');
    expect(v?.gap).toBe(5);
  });

  it('handles realistic ch40-style spray fragment (multiple violations + clean pairs)', () => {
    // Six adjacent ref-pairs in close prose. Mix of OK (gap=1, gap=2),
    // violating (gap=3, gap=13), and a cross-page pair.
    const fragment =
      'Replication latencies vary by topology [ref:page200:paragraph1][ref:page200:paragraph2]. ' +
      'Leader-follower setups [ref:page200:paragraph4][ref:page200:paragraph17] often degrade. ' +
      'Conflict resolution [ref:page201:paragraph3][ref:page201:paragraph4] is bespoke. ' +
      'Quorum reads [ref:page202:paragraph1][ref:page202:paragraph14] can stale. ' +
      'CRDTs [ref:page203:paragraph1][ref:page204:paragraph1] sidestep this.';
    const result = detectAdjacentPairViolations(fragment);
    expect(result.totalRefs).toBe(10);
    expect(result.adjacentPairs).toBe(5);
    // OK: (200:1,200:2) gap=1; (201:3,201:4) gap=1
    // Violations: (200:4,200:17) gap=13; (202:1,202:14) gap=13; (203:1,204:1) cross-page
    expect(result.violations).toHaveLength(3);
    const kinds = result.violations.map((v) => v.kind).sort();
    expect(kinds).toEqual(['cross-page', 'same-page-gap-gt-2', 'same-page-gap-gt-2']);
    // PenaltyScore: 3 violations / (10 / 2) = 0.6
    expect(result.penaltyScore).toBeCloseTo(0.6, 5);
  });

  it('penaltyScore = 0 when no violations exist', () => {
    const result = detectAdjacentPairViolations(
      'All clean pairs [ref:page1:paragraph1][ref:page1:paragraph2] here.',
    );
    expect(result.violations).toEqual([]);
    expect(result.penaltyScore).toBe(0);
  });

  it('penaltyScore = 1.0 in a fully-spray narrative (all refs in violating pairs)', () => {
    // 4 refs, all in violating cross-page pairs: 2 violations, totalRefs=4
    // 2 / (4 / 2) = 1.0
    const result = detectAdjacentPairViolations(
      'Spray [ref:page1:paragraph1][ref:page2:paragraph1] and [ref:page3:paragraph1][ref:page4:paragraph1] more.',
    );
    expect(result.totalRefs).toBe(4);
    expect(result.adjacentPairs).toBe(2);
    expect(result.violations).toHaveLength(2);
    expect(result.penaltyScore).toBe(1);
  });

  it('penaltyScore caps at 1.0 even when overlapping spray runs push raw beyond 1', () => {
    // [a][b][c][d] with all cross-page: 3 pairs (a,b), (b,c), (c,d), all violations.
    // totalRefs=4, violations=3, raw = 3 / (4/2) = 1.5, capped to 1.
    const result = detectAdjacentPairViolations(
      '[ref:page1:paragraph1][ref:page2:paragraph1][ref:page3:paragraph1][ref:page4:paragraph1]',
    );
    expect(result.totalRefs).toBe(4);
    expect(result.adjacentPairs).toBe(3);
    expect(result.violations).toHaveLength(3);
    expect(result.penaltyScore).toBe(1);
  });

  it('penaltyScore is partial when SOME refs are clean', () => {
    // 4 refs: one violating pair + two isolated refs
    const result = detectAdjacentPairViolations(
      'Lead [ref:page1:paragraph1] then [ref:page2:paragraph3][ref:page2:paragraph15] then tail [ref:page3:paragraph1].',
    );
    expect(result.totalRefs).toBe(4);
    expect(result.violations).toHaveLength(1);
    // 1 / (4/2) = 0.5
    expect(result.penaltyScore).toBe(0.5);
  });

  it('does NOT count refs separated by alphanumeric content as adjacent', () => {
    // Space-then-word between is a sentence break, not a pair.
    const result = detectAdjacentPairViolations(
      'Foo [ref:page42:paragraph3] and [ref:page42:paragraph15] bar.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it('counts refs separated by allowed punctuation (period, comma, semicolon) as adjacent', () => {
    // Tolerance: inline punctuation is OK
    const result = detectAdjacentPairViolations(
      'Foo [ref:page42:paragraph3], [ref:page42:paragraph15] bar.',
    );
    expect(result.totalRefs).toBe(2);
    expect(result.adjacentPairs).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('same-page-gap-gt-2');
  });

  it('ignores malformed refs (defensive — bad refs are a different gate)', () => {
    // `[ref:page42:paragraphX]` does not match the canonical regex
    const result = detectAdjacentPairViolations(
      'Bad [ref:page42:paragraphX][ref:page42:paragraph3] mixed with [ref:page42:paragraph4] real.',
    );
    // Only the two real refs are counted
    expect(result.totalRefs).toBe(2);
    // They're NOT adjacent because the malformed ref-text and surrounding
    // alphanumerics sit between them.
    expect(result.adjacentPairs).toBe(0);
  });

  it('preserves source-order offsets in violations', () => {
    const narrative = 'Lead text [ref:page42:paragraph3][ref:page42:paragraph9] trailing.';
    const result = detectAdjacentPairViolations(narrative);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v).toBeDefined();
    if (!v) return;
    // Verify the slice matches
    expect(narrative.slice(v.startOffset, v.endOffset)).toBe(v.text);
    expect(v.text).toBe('[ref:page42:paragraph3][ref:page42:paragraph9]');
  });
});
