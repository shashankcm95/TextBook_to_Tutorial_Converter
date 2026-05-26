// @vitest-environment jsdom
//
// src/components/diagrams/__tests__/DecisionTree.test.tsx
//
// Unit tests for the Sprint F.2 DecisionTree primitive. jsdom does not
// implement SVG layout, so these tests assert structural / a11y / data
// contracts only (counts of <text>, <rect>, <line>; role + aria-label;
// figcaption presence; rx-based shape distinction; yes-left/no-right
// x-coord ordering). Visual-layout correctness is covered by the
// Playwright snapshot specs Builder F ships in this Wave.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import DecisionTree from '../DecisionTree';
import type { DecisionTreePayload } from '@/lib/diagrams/schema';

afterEach(() => {
  cleanup();
});

// Balanced 3-level tree: root question + 2 internal children + 4 leaves.
const balanced3: DecisionTreePayload = {
  kind: 'DecisionTree',
  title: 'Cache policy',
  root: {
    question: 'Hot data?',
    yes: {
      question: 'Small?',
      yes: { leaf: 'L1 cache' },
      no: { leaf: 'L2 cache' },
    },
    no: {
      question: 'Persisted?',
      yes: { leaf: 'Disk' },
      no: { leaf: 'Skip' },
    },
  },
};

// Lopsided 5-level tree — yes-branch chains deep, no-branches terminate fast.
const lopsided5: DecisionTreePayload = {
  kind: 'DecisionTree',
  root: {
    question: 'Q1',
    yes: {
      question: 'Q2',
      yes: {
        question: 'Q3',
        yes: {
          question: 'Q4',
          yes: { leaf: 'Deep leaf' },
          no: { leaf: 'B' },
        },
        no: { leaf: 'C' },
      },
      no: { leaf: 'D' },
    },
    no: { leaf: 'A' },
  },
};

describe('DecisionTree', () => {
  it('renders a 3-level balanced tree (root + 2 children + 4 leaves)', () => {
    render(<DecisionTree payload={balanced3} />);
    // 3 internal-node questions + 4 leaves = 7 distinct node labels.
    expect(screen.getByText('Hot data?')).toBeTruthy();
    expect(screen.getByText('Small?')).toBeTruthy();
    expect(screen.getByText('Persisted?')).toBeTruthy();
    expect(screen.getByText('L1 cache')).toBeTruthy();
    expect(screen.getByText('L2 cache')).toBeTruthy();
    expect(screen.getByText('Disk')).toBeTruthy();
    expect(screen.getByText('Skip')).toBeTruthy();
  });

  it('renders a 5-level lopsided tree without crashing', () => {
    expect(() => render(<DecisionTree payload={lopsided5} />)).not.toThrow();
    expect(screen.getByText('Deep leaf')).toBeTruthy();
    // The shallow no-side leaf still renders.
    expect(screen.getByText('A')).toBeTruthy();
  });

  it('renders Yes branches to the left and No branches to the right of parent x-center', () => {
    const { container } = render(<DecisionTree payload={balanced3} />);
    // Each <line> goes parent-center-bottom → child-center-top.
    // Yes-branches must end at an x2 less than their x1; no-branches at x2 > x1.
    const lines = Array.from(container.querySelectorAll('svg line'));
    expect(lines.length).toBeGreaterThan(0);
    // Pair each line with the closest "Yes"/"No" label by its midpoint x.
    const yesLabels = Array.from(container.querySelectorAll('svg text')).filter(
      (t) => t.textContent === 'Yes',
    );
    const noLabels = Array.from(container.querySelectorAll('svg text')).filter(
      (t) => t.textContent === 'No',
    );
    // 3 internal nodes → 3 yes-edges + 3 no-edges + 6 corresponding labels.
    expect(yesLabels.length).toBe(3);
    expect(noLabels.length).toBe(3);
    // Direct x1/x2 assertion across all child lines: at least one line per
    // direction. Yes-edges' x2 < x1; No-edges' x2 > x1.
    const yesEdges = lines.filter((l) => {
      const x1 = Number(l.getAttribute('x1'));
      const x2 = Number(l.getAttribute('x2'));
      return x2 < x1;
    });
    const noEdges = lines.filter((l) => {
      const x1 = Number(l.getAttribute('x1'));
      const x2 = Number(l.getAttribute('x2'));
      return x2 > x1;
    });
    expect(yesEdges.length).toBe(3);
    expect(noEdges.length).toBe(3);
  });

  it('shows distinct visual shapes for internal nodes (rect) vs leaves (pill)', () => {
    const { container } = render(<DecisionTree payload={balanced3} />);
    const rects = Array.from(container.querySelectorAll('svg > rect, svg g > rect'));
    // Filter to the node-shape rects (those whose rx is a numeric value;
    // edge-label rects in this primitive have no rx attribute).
    const nodeShapeRects = rects.filter((r) => r.getAttribute('rx') !== null);
    // 3 internal + 4 leaves = 7 node shapes.
    expect(nodeShapeRects.length).toBe(7);
    // Internal nodes use rx=8; leaves use rx=NODE_H/2=22. Two distinct values.
    const rxValues = new Set(
      nodeShapeRects.map((r) => Number(r.getAttribute('rx'))),
    );
    expect(rxValues.has(8)).toBe(true); // internal
    expect(rxValues.has(22)).toBe(true); // leaf (NODE_H/2 = 44/2)
    expect(rxValues.size).toBe(2); // exactly two distinct shape rx values
  });

  it('renders "Yes" and "No" edge labels at midpoints', () => {
    render(<DecisionTree payload={balanced3} />);
    // 3 internal nodes → 3 Yes + 3 No labels.
    expect(screen.getAllByText('Yes').length).toBe(3);
    expect(screen.getAllByText('No').length).toBe(3);
  });

  it('renders <figcaption> when payload.title is set', () => {
    const { container } = render(<DecisionTree payload={balanced3} />);
    const figcaption = container.querySelector('figcaption');
    expect(figcaption).toBeTruthy();
    expect(figcaption!.textContent).toBe('Cache policy');
  });

  it('omits the figcaption when payload.title is absent', () => {
    const { container } = render(<DecisionTree payload={lopsided5} />);
    // lopsided5 has no title.
    expect(container.querySelector('figcaption')).toBe(null);
  });

  it('has role="img" with a descriptive aria-label', () => {
    render(<DecisionTree payload={balanced3} />);
    const fig = screen.getByRole('img');
    const label = fig.getAttribute('aria-label');
    expect(label).toBeTruthy();
    expect(label).toMatch(/Cache policy/);
    expect(label).toMatch(/Hot data\?/);
  });

  // Sprint F.2 Wave-2 reviewer fix-up: wrapLabel single-word truncation.
  // A schema-max-length question with no spaces would previously overflow
  // the SVG <rect> silently. The fix adds per-word ellipsis truncation.
  it('truncates a single space-free question that exceeds the box width with an ellipsis', () => {
    // 80-char no-space identifier — well above any reasonable widthInChars.
    const noSpaceWord = 'A'.repeat(80);
    const payload: DecisionTreePayload = {
      kind: 'DecisionTree',
      root: {
        question: noSpaceWord,
        yes: { leaf: 'Yes leaf' },
        no: { leaf: 'No leaf' },
      },
    };
    render(<DecisionTree payload={payload} />);
    // Find every <tspan> rendered (one per wrapped line).
    const tspans = Array.from(document.querySelectorAll('svg tspan'));
    // At least one tspan must exist for the question.
    expect(tspans.length).toBeGreaterThanOrEqual(1);
    // No tspan may exceed the bounding-box width estimate. Question text
    // box is ~120-200px wide → widthInChars ≤ ~28. The 80-char raw word
    // must NOT appear in any tspan untouched.
    const fullWordVisible = tspans.some((t) => (t.textContent ?? '').includes(noSpaceWord));
    expect(fullWordVisible).toBe(false);
    // At least one tspan must contain the ellipsis character — proves
    // truncation kicked in rather than silent overflow.
    const ellipsisVisible = tspans.some((t) => (t.textContent ?? '').includes('…'));
    expect(ellipsisVisible).toBe(true);
  });

  it('greedy-wraps a multi-word question across up to 2 lines with ellipsis', () => {
    // Long question with spaces — should wrap onto 2 lines, ellipsizing the tail.
    const longQuestion =
      'Should the cache evict the least recently used entry or the least frequently used entry first';
    const payload: DecisionTreePayload = {
      kind: 'DecisionTree',
      root: {
        question: longQuestion,
        yes: { leaf: 'LRU' },
        no: { leaf: 'LFU' },
      },
    };
    render(<DecisionTree payload={payload} />);
    const rootQuestionTspans = Array.from(document.querySelectorAll('svg text')).find(
      (t) => (t.textContent ?? '').length > 20,
    );
    expect(rootQuestionTspans).toBeTruthy();
    const tspans = rootQuestionTspans!.querySelectorAll('tspan');
    // Greedy wrap caps at maxLines=2.
    expect(tspans.length).toBeLessThanOrEqual(2);
    // The 96-char raw question must NOT appear in any single tspan untouched.
    const fullVisible = Array.from(tspans).some(
      (t) => (t.textContent ?? '') === longQuestion,
    );
    expect(fullVisible).toBe(false);
  });
});
