// src/lib/eval/__tests__/diagram-density.test.ts
//
// Unit tests for computeDiagramDensity. Pure-function in/out; no I/O.
// Block-extraction edge cases (EOF without trailing newline, non-diagram
// fences) are exercised explicitly.

import { describe, it, expect } from 'vitest';

import { computeDiagramDensity } from '../diagram-density';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

const VALID_COMPARISON_TABLE = JSON.stringify({
  kind: 'ComparisonTable',
  columns: ['Approach', 'Latency', 'Cost'],
  rows: [
    { Approach: 'Single-leader', Latency: 'low', Cost: 'low' },
    { Approach: 'Multi-leader', Latency: 'medium', Cost: 'medium' },
  ],
});

const VALID_DEFINITION_LIST = JSON.stringify({
  kind: 'DefinitionList',
  items: [
    { term: 'Leader', definition: 'A node that accepts writes.' },
    { term: 'Follower', definition: 'A node that replicates from the leader.' },
  ],
});

const VALID_DIAGRAM_FLOW = JSON.stringify({
  kind: 'DiagramFlow',
  nodes: [
    { id: 'a', label: 'Start' },
    { id: 'b', label: 'End' },
  ],
  edges: [{ from: 'a', to: 'b' }],
});

const MALFORMED_DIAGRAM = '{ this is not valid json';

function diagramBlock(body: string): string {
  return '```diagram\n' + body + '\n```';
}

function mermaidBlock(body: string): string {
  return '```mermaid\n' + body + '\n```';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('computeDiagramDensity', () => {
  it('returns all zeros for an empty narrative', () => {
    const d = computeDiagramDensity('');
    expect(d.totalValid).toBe(0);
    expect(d.parseFailures).toBe(0);
    expect(d.mermaidBlocks).toBe(0);
    expect(d.byKind).toEqual({
      ComparisonTable: 0,
      DefinitionList: 0,
      DiagramFlow: 0,
      StateTransitionDiagram: 0,
      SequenceDiagram: 0,
      DecisionTree: 0,
    });
  });

  it('counts a valid ComparisonTable block under byKind.ComparisonTable', () => {
    const md = `Some prose.\n\n${diagramBlock(VALID_COMPARISON_TABLE)}\n\nMore prose.`;
    const d = computeDiagramDensity(md);
    expect(d.byKind.ComparisonTable).toBe(1);
    expect(d.totalValid).toBe(1);
    expect(d.parseFailures).toBe(0);
    expect(d.mermaidBlocks).toBe(0);
  });

  it('counts a malformed ```diagram block as a parseFailure, not as byKind', () => {
    const md = `Intro.\n\n${diagramBlock(MALFORMED_DIAGRAM)}\n`;
    const d = computeDiagramDensity(md);
    expect(d.parseFailures).toBe(1);
    expect(d.totalValid).toBe(0);
    expect(d.byKind.ComparisonTable).toBe(0);
  });

  it('counts a ```mermaid block under mermaidBlocks (not byKind)', () => {
    const md = `Intro.\n\n${mermaidBlock('graph TD\n  A --> B')}\n`;
    const d = computeDiagramDensity(md);
    expect(d.mermaidBlocks).toBe(1);
    expect(d.totalValid).toBe(0);
    expect(d.parseFailures).toBe(0);
  });

  it('counts multiple blocks of mixed kinds correctly', () => {
    const md = [
      'Opening.',
      '',
      diagramBlock(VALID_COMPARISON_TABLE),
      '',
      'Middle.',
      '',
      diagramBlock(VALID_DEFINITION_LIST),
      '',
      diagramBlock(VALID_DIAGRAM_FLOW),
      '',
      mermaidBlock('graph TD\n  A --> B'),
      '',
      diagramBlock(MALFORMED_DIAGRAM),
      '',
      'Closing.',
    ].join('\n');
    const d = computeDiagramDensity(md);
    expect(d.byKind.ComparisonTable).toBe(1);
    expect(d.byKind.DefinitionList).toBe(1);
    expect(d.byKind.DiagramFlow).toBe(1);
    expect(d.totalValid).toBe(3);
    expect(d.mermaidBlocks).toBe(1);
    expect(d.parseFailures).toBe(1);
  });

  it('handles a ```diagram block at end-of-string without trailing newline', () => {
    // No trailing newline after the closing fence; matches when LLM emission
    // is the last token in the narrative.
    const md = `Final paragraph.\n\n${diagramBlock(VALID_COMPARISON_TABLE)}`;
    const d = computeDiagramDensity(md);
    expect(d.byKind.ComparisonTable).toBe(1);
    expect(d.totalValid).toBe(1);
  });

  it('ignores non-diagram non-mermaid fenced code blocks (e.g., ```js)', () => {
    const md = [
      'See this snippet:',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'And a real diagram:',
      '',
      diagramBlock(VALID_COMPARISON_TABLE),
    ].join('\n');
    const d = computeDiagramDensity(md);
    expect(d.byKind.ComparisonTable).toBe(1);
    expect(d.totalValid).toBe(1);
    expect(d.parseFailures).toBe(0);
    expect(d.mermaidBlocks).toBe(0);
  });

  it('returns totalValid = sum of byKind counts', () => {
    const md = [
      diagramBlock(VALID_COMPARISON_TABLE),
      '',
      diagramBlock(VALID_DEFINITION_LIST),
      '',
      diagramBlock(VALID_DIAGRAM_FLOW),
    ].join('\n');
    const d = computeDiagramDensity(md);
    const sum =
      d.byKind.ComparisonTable +
      d.byKind.DefinitionList +
      d.byKind.DiagramFlow +
      d.byKind.StateTransitionDiagram +
      d.byKind.SequenceDiagram +
      d.byKind.DecisionTree;
    expect(d.totalValid).toBe(sum);
    expect(d.totalValid).toBe(3);
  });
});
