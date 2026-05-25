// @vitest-environment jsdom
//
// src/components/diagrams/__tests__/DiagramBlock.test.tsx
//
// Tests for the DiagramBlock router + the 2 F.1 primitives (ComparisonTable,
// DefinitionList) + the parse-failure fallback. Uses @testing-library/react
// for the actual render assertions.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { DiagramBlock } from '../DiagramBlock';

// vitest doesn't auto-register testing-library cleanup the way @testing-
// library/react/vitest does. Register explicitly so each test's render
// doesn't leak into the next (which would produce
// "Found multiple elements with the text" matcher failures).
afterEach(() => {
  cleanup();
});

function renderJSON(payload: unknown) {
  return render(<DiagramBlock rawJSON={JSON.stringify(payload)} />);
}

// ---------------------------------------------------------------------------
// ComparisonTable
// ---------------------------------------------------------------------------

describe('DiagramBlock — ComparisonTable', () => {
  it('renders a semantic <table> with caption, thead, tbody', () => {
    renderJSON({
      kind: 'ComparisonTable',
      title: 'Replication topologies',
      columns: ['Topology', 'Write availability'],
      rows: [
        { Topology: 'Single-leader', 'Write availability': 'Single SPOF' },
        { Topology: 'Multi-leader', 'Write availability': 'High' },
      ],
    });
    const table = screen.getByRole('table');
    expect(table).toBeTruthy();
    expect(screen.getByText('Replication topologies')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Topology' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Write availability' })).toBeTruthy();
    expect(within(table).getByText('Single-leader')).toBeTruthy();
    expect(within(table).getByText('Multi-leader')).toBeTruthy();
  });

  it('uses scope="col" on every <th>', () => {
    renderJSON({
      kind: 'ComparisonTable',
      columns: ['A', 'B'],
      rows: [{ A: '1', B: '2' }],
    });
    const headers = screen.getAllByRole('columnheader');
    for (const th of headers) {
      expect(th.getAttribute('scope')).toBe('col');
    }
  });

  it('renders missing cells as non-breaking space (not undefined)', () => {
    renderJSON({
      kind: 'ComparisonTable',
      columns: ['A', 'B'],
      rows: [{ A: '1' }], // B missing → fallback nbsp
    });
    const cells = screen.getAllByRole('cell');
    // 1 row × 2 columns → 2 cells; the second should not contain "undefined"
    expect(cells.some((c) => /undefined/.test(c.textContent ?? ''))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DefinitionList
// ---------------------------------------------------------------------------

describe('DiagramBlock — DefinitionList', () => {
  it('renders a semantic <dl> with <dt>/<dd> pairs', () => {
    const { container } = renderJSON({
      kind: 'DefinitionList',
      title: 'Concurrency control',
      items: [
        { term: 'Lock', definition: 'A mechanism for mutual exclusion.' },
        { term: 'MVCC', definition: 'Multi-version concurrency control.' },
      ],
    });
    const dl = container.querySelector('dl');
    expect(dl).toBeTruthy();
    const dts = container.querySelectorAll('dt');
    const dds = container.querySelectorAll('dd');
    expect(dts.length).toBe(2);
    expect(dds.length).toBe(2);
    expect(dts[0].textContent).toBe('Lock');
    expect(dds[0].textContent).toBe('A mechanism for mutual exclusion.');
    expect(dts[1].textContent).toBe('MVCC');
  });

  it('renders the title as a <figcaption> when provided', () => {
    renderJSON({
      kind: 'DefinitionList',
      title: 'Concurrency control',
      items: [
        { term: 'Lock', definition: 'lock' },
        { term: 'MVCC', definition: 'mvcc' },
      ],
    });
    expect(screen.getByText('Concurrency control')).toBeTruthy();
  });

  it('omits the figcaption when title is absent', () => {
    const { container } = renderJSON({
      kind: 'DefinitionList',
      items: [
        { term: 'A', definition: 'a' },
        { term: 'B', definition: 'b' },
      ],
    });
    expect(container.querySelector('figcaption')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Fallback paths (parse failure + Sprint F.2 pending)
// ---------------------------------------------------------------------------

describe('DiagramBlock — parse-failure fallback', () => {
  it('renders the source + warn caption on malformed JSON', () => {
    render(<DiagramBlock rawJSON="{ malformed: json, " />);
    // The raw source is visible (so the reader sees the LLM's intent)
    expect(screen.getByText(/malformed: json/)).toBeTruthy();
    // The caption surfaces the failure with the operator-readable hint
    const caption = screen.getByText(/could not parse/i);
    expect(caption.textContent).toMatch(/invalid JSON/i);
  });

  it('renders fallback on unknown kind', () => {
    const raw = JSON.stringify({ kind: 'NotARealKind', stuff: 'whatever' });
    render(<DiagramBlock rawJSON={raw} />);
    expect(screen.getByText(/could not parse/i)).toBeTruthy();
  });

  it('renders fallback on empty input', () => {
    render(<DiagramBlock rawJSON="" />);
    expect(screen.getByText(/could not parse/i)).toBeTruthy();
  });

  it('has role="img" + aria-label on the fallback (a11y)', () => {
    render(<DiagramBlock rawJSON="{ bad" />);
    const fig = screen.getByRole('img');
    expect(fig.getAttribute('aria-label')).toMatch(/could not parse/i);
  });
});

describe('DiagramBlock — Sprint F.2 pending (SVG primitives not yet shipped)', () => {
  it('shows a "renderer pending" placeholder for DiagramFlow', () => {
    renderJSON({
      kind: 'DiagramFlow',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(screen.getByText(/DiagramFlow renderer ships in Sprint F\.2/)).toBeTruthy();
  });

  it('shows a "renderer pending" placeholder for SequenceDiagram', () => {
    renderJSON({
      kind: 'SequenceDiagram',
      actors: ['Client', 'Server'],
      messages: [{ from: 'Client', to: 'Server', label: 'GET /' }],
    });
    expect(screen.getByText(/SequenceDiagram renderer ships in Sprint F\.2/)).toBeTruthy();
  });
});
