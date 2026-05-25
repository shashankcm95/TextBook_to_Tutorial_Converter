// src/lib/diagrams/__tests__/parse.test.ts — Sprint F.1 contract tests.
//
// Coverage:
//   - Each of the 6 primitive shapes round-trips successfully through
//     parseDiagramBlock when given a valid JSON payload.
//   - Each primitive's specific guard fires (column count, label length,
//     node count, etc.) when intentionally violated.
//   - parseDiagramBlock returns ok=false with the right `code` on
//     empty input, malformed JSON, wrong shape, and DecisionTree depth
//     exceeding the max.
//   - The error.raw field is truncated to ≤200 chars + ellipsis.

import { describe, it, expect } from 'vitest';
import { parseDiagramBlock } from '../parse';

// ---------------------------------------------------------------------------
// Fixtures — minimal valid JSON for each primitive kind.
// ---------------------------------------------------------------------------

const validComparisonTable = JSON.stringify({
  kind: 'ComparisonTable',
  title: 'Replication topologies',
  columns: ['Topology', 'Write availability'],
  rows: [
    { Topology: 'Single-leader', 'Write availability': 'Single SPOF' },
    { Topology: 'Multi-leader', 'Write availability': 'High' },
  ],
});

const validDefinitionList = JSON.stringify({
  kind: 'DefinitionList',
  title: 'Concurrency control',
  items: [
    { term: 'Lock', definition: 'A mechanism for mutual exclusion.' },
    { term: 'MVCC', definition: 'Multi-version concurrency control.' },
  ],
});

const validDiagramFlow = JSON.stringify({
  kind: 'DiagramFlow',
  title: 'Request lifecycle',
  direction: 'LR',
  nodes: [
    { id: 'client', label: 'Client', kind: 'start' },
    { id: 'lb', label: 'Load balancer', kind: 'process' },
    { id: 'app', label: 'App server', kind: 'end' },
  ],
  edges: [
    { from: 'client', to: 'lb' },
    { from: 'lb', to: 'app', label: 'forward' },
  ],
});

const validStateTransition = JSON.stringify({
  kind: 'StateTransitionDiagram',
  states: [
    { id: 'open', label: 'OPEN', initial: true },
    { id: 'halfopen', label: 'HALF OPEN' },
    { id: 'closed', label: 'CLOSED', terminal: true },
  ],
  transitions: [
    { from: 'open', to: 'halfopen', trigger: 'timer' },
    { from: 'halfopen', to: 'closed', trigger: 'success' },
  ],
});

const validSequenceDiagram = JSON.stringify({
  kind: 'SequenceDiagram',
  actors: ['Client', 'Server'],
  messages: [
    { from: 'Client', to: 'Server', label: 'GET /', kind: 'call' },
    { from: 'Server', to: 'Client', label: '200 OK', kind: 'return' },
  ],
});

const validDecisionTree = JSON.stringify({
  kind: 'DecisionTree',
  title: 'Pick a sort',
  root: {
    question: 'Is the data nearly sorted?',
    yes: { leaf: 'insertion sort' },
    no: {
      question: 'Memory-constrained?',
      yes: { leaf: 'heapsort' },
      no: { leaf: 'quicksort' },
    },
  },
});

// ---------------------------------------------------------------------------
// Success path — each shape parses cleanly
// ---------------------------------------------------------------------------

describe('parseDiagramBlock — success', () => {
  it('parses a valid ComparisonTable', () => {
    const result = parseDiagramBlock(validComparisonTable);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('ComparisonTable');
    }
  });

  it('parses a valid DefinitionList', () => {
    const result = parseDiagramBlock(validDefinitionList);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('DefinitionList');
    }
  });

  it('parses a valid DiagramFlow', () => {
    const result = parseDiagramBlock(validDiagramFlow);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('DiagramFlow');
    }
  });

  it('parses a valid StateTransitionDiagram', () => {
    const result = parseDiagramBlock(validStateTransition);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('StateTransitionDiagram');
    }
  });

  it('parses a valid SequenceDiagram', () => {
    const result = parseDiagramBlock(validSequenceDiagram);
    expect(result.ok).toBe(true);
  });

  it('parses a valid DecisionTree', () => {
    const result = parseDiagramBlock(validDecisionTree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('DecisionTree');
    }
  });
});

// ---------------------------------------------------------------------------
// Failure paths — each error code
// ---------------------------------------------------------------------------

describe('parseDiagramBlock — error.code === "empty_input"', () => {
  it('returns empty_input on empty string', () => {
    const r = parseDiagramBlock('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('empty_input');
  });

  it('returns empty_input on whitespace-only string', () => {
    const r = parseDiagramBlock('   \n\t  ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('empty_input');
  });
});

describe('parseDiagramBlock — error.code === "invalid_json"', () => {
  it('returns invalid_json on unterminated object', () => {
    const r = parseDiagramBlock('{ "kind": "ComparisonTable", ');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_json');
      expect(r.error.message).toMatch(/invalid JSON/i);
    }
  });

  it('returns invalid_json on trailing comma (strict mode)', () => {
    // JSON.parse rejects trailing commas; ensures we do NOT silently repair.
    const r = parseDiagramBlock('{ "kind": "ComparisonTable", }');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_json');
  });

  it('returns invalid_json on bare identifier (JS-style)', () => {
    const r = parseDiagramBlock('{ kind: "ComparisonTable" }');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_json');
  });
});

describe('parseDiagramBlock — error.code === "invalid_shape"', () => {
  it('rejects ComparisonTable with <2 columns', () => {
    const bad = JSON.stringify({
      kind: 'ComparisonTable',
      columns: ['only one'],
      rows: [{ 'only one': 'value' }],
    });
    const r = parseDiagramBlock(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_shape');
      expect(r.error.message).toMatch(/≥2 columns/);
    }
  });

  it('rejects ComparisonTable with 0 rows', () => {
    const bad = JSON.stringify({
      kind: 'ComparisonTable',
      columns: ['A', 'B'],
      rows: [],
    });
    const r = parseDiagramBlock(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_shape');
  });

  it('rejects DefinitionList with 1 item (needs ≥2)', () => {
    const bad = JSON.stringify({
      kind: 'DefinitionList',
      items: [{ term: 'one', definition: 'only' }],
    });
    const r = parseDiagramBlock(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_shape');
  });

  it('rejects DiagramFlow with 8 nodes (cap is 7)', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      label: `Node ${i}`,
    }));
    const bad = JSON.stringify({
      kind: 'DiagramFlow',
      nodes,
      edges: [{ from: 'n0', to: 'n1' }],
    });
    const r = parseDiagramBlock(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_shape');
  });

  it('rejects unknown kind via discriminated-union miss', () => {
    const bad = JSON.stringify({
      kind: 'NotARealKind',
      stuff: 'whatever',
    });
    const r = parseDiagramBlock(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_shape');
  });

  it('rejects label exceeding 32 chars', () => {
    const longLabel = 'this label has way more than three short words in it bigly';
    expect(longLabel.length).toBeGreaterThan(32);
    const bad = JSON.stringify({
      kind: 'DiagramFlow',
      nodes: [
        { id: 'a', label: longLabel },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const r = parseDiagramBlock(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_shape');
  });

  it('rejects node id with disallowed chars (space)', () => {
    const bad = JSON.stringify({
      kind: 'DiagramFlow',
      nodes: [
        { id: 'has space', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'has space', to: 'b' }],
    });
    const r = parseDiagramBlock(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_shape');
  });
});

describe('parseDiagramBlock — error.code === "invalid_recursive_depth"', () => {
  it('rejects DecisionTree with depth > 8', () => {
    // Build a 10-level-deep tree (well over the cap of 8).
    function buildDeep(depth: number): unknown {
      if (depth === 0) return { leaf: 'bottom' };
      return {
        question: `Q at depth ${depth}`,
        yes: buildDeep(depth - 1),
        no: { leaf: `short ${depth}` },
      };
    }
    const bad = JSON.stringify({
      kind: 'DecisionTree',
      root: buildDeep(10),
    });
    const r = parseDiagramBlock(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_recursive_depth');
      expect(r.error.message).toMatch(/depth \d+ exceeds max 8/);
    }
  });

  it('accepts DecisionTree at exactly depth 8', () => {
    function buildExact(depth: number): unknown {
      if (depth === 0) return { leaf: 'bottom' };
      return {
        question: `Q at depth ${depth}`,
        yes: buildExact(depth - 1),
        no: { leaf: `short ${depth}` },
      };
    }
    const ok = JSON.stringify({
      kind: 'DecisionTree',
      root: buildExact(8),
    });
    const r = parseDiagramBlock(ok);
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// error.raw truncation
// ---------------------------------------------------------------------------

describe('parseDiagramBlock — error.raw truncation', () => {
  it('truncates raw to ≤200 chars + ellipsis', () => {
    // 500 chars of malformed JSON.
    const long = '{ "kind": "ComparisonTable", "columns": [' + 'x'.repeat(500);
    const r = parseDiagramBlock(long);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.raw.length).toBeLessThanOrEqual(201); // 200 + 1 for ellipsis
      expect(r.error.raw.endsWith('…')).toBe(true);
    }
  });

  it('does NOT truncate raw shorter than 200 chars', () => {
    const short = '{ bad json }';
    const r = parseDiagramBlock(short);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.raw.endsWith('…')).toBe(false);
      expect(r.error.raw).toBe(short);
    }
  });
});

// ---------------------------------------------------------------------------
// Whitespace tolerance + value trimming
// ---------------------------------------------------------------------------

describe('parseDiagramBlock — whitespace tolerance', () => {
  it('trims whitespace from input before JSON parse', () => {
    const r = parseDiagramBlock(`\n\n  ${validComparisonTable}  \n`);
    expect(r.ok).toBe(true);
  });

  it('trims whitespace from string fields (title, label, term)', () => {
    const padded = JSON.stringify({
      kind: 'DefinitionList',
      title: '   With surrounding space   ',
      items: [
        { term: '  Lock  ', definition: '  A mechanism  ' },
        { term: 'MVCC', definition: 'Multi-version' },
      ],
    });
    const r = parseDiagramBlock(padded);
    expect(r.ok).toBe(true);
    if (r.ok && r.payload.kind === 'DefinitionList') {
      expect(r.payload.title).toBe('With surrounding space');
      expect(r.payload.items[0].term).toBe('Lock');
      expect(r.payload.items[0].definition).toBe('A mechanism');
    }
  });
});
