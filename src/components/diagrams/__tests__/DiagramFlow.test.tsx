// @vitest-environment jsdom
//
// src/components/diagrams/__tests__/DiagramFlow.test.tsx
//
// Unit tests for the Sprint F.2 DiagramFlow primitive. jsdom does not
// implement SVG layout, so these tests assert structural / a11y / data
// contracts only (counts of <line>, <text>, <polygon>; role + aria-label;
// figcaption present/absent). Visual-layout correctness is covered by the
// Playwright snapshot specs Builder F ships in this Wave.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import DiagramFlow from '../DiagramFlow';
import type { DiagramFlowPayload } from '@/lib/diagrams/schema';

afterEach(() => {
  cleanup();
});

describe('DiagramFlow', () => {
  it('renders a 2-node LR diagram with both labels', () => {
    const payload: DiagramFlowPayload = {
      kind: 'DiagramFlow',
      direction: 'LR',
      nodes: [
        { id: 'a', label: 'Ingest' },
        { id: 'b', label: 'Persist' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    render(<DiagramFlow payload={payload} />);
    expect(screen.getByText('Ingest')).toBeTruthy();
    expect(screen.getByText('Persist')).toBeTruthy();
    // One line for the single edge.
    expect(document.querySelectorAll('svg line').length).toBe(1);
  });

  it('renders a 4-node TB diagram with a decision node', () => {
    const payload: DiagramFlowPayload = {
      kind: 'DiagramFlow',
      direction: 'TB',
      nodes: [
        { id: 's', label: 'Start', kind: 'start' },
        { id: 'p', label: 'Process', kind: 'process' },
        { id: 'd', label: 'Valid?', kind: 'decision' },
        { id: 'e', label: 'End', kind: 'end' },
      ],
      edges: [
        { from: 's', to: 'p' },
        { from: 'p', to: 'd' },
        { from: 'd', to: 'e' },
      ],
    };
    render(<DiagramFlow payload={payload} />);
    expect(screen.getByText('Start')).toBeTruthy();
    expect(screen.getByText('Valid?')).toBeTruthy();
    expect(screen.getByText('End')).toBeTruthy();
    // Exactly one decision diamond → one <polygon>.
    expect(document.querySelectorAll('svg polygon').length).toBe(1);
    // Three edges → three <line> elements.
    expect(document.querySelectorAll('svg line').length).toBe(3);
  });

  it('renders edge labels when provided', () => {
    const payload: DiagramFlowPayload = {
      kind: 'DiagramFlow',
      direction: 'LR',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b', label: 'sync' }],
    };
    render(<DiagramFlow payload={payload} />);
    expect(screen.getByText('sync')).toBeTruthy();
  });

  it('drops edges referencing missing node ids', () => {
    const payload: DiagramFlowPayload = {
      kind: 'DiagramFlow',
      direction: 'LR',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [
        { from: 'a', to: 'b' }, // valid
        { from: 'a', to: 'ghost' }, // dropped — 'ghost' isn't a node
        { from: 'missing', to: 'b' }, // dropped — 'missing' isn't a node
      ],
    };
    render(<DiagramFlow payload={payload} />);
    // Only the valid edge survives → exactly one <line>.
    expect(document.querySelectorAll('svg line').length).toBe(1);
  });

  it('renders <figcaption> when payload.title is set', () => {
    const payload: DiagramFlowPayload = {
      kind: 'DiagramFlow',
      direction: 'LR',
      title: 'Request lifecycle',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const { container } = render(<DiagramFlow payload={payload} />);
    const cap = container.querySelector('figcaption');
    expect(cap).toBeTruthy();
    expect(cap?.textContent).toBe('Request lifecycle');
  });

  it('omits <figcaption> when payload.title is absent', () => {
    const payload: DiagramFlowPayload = {
      kind: 'DiagramFlow',
      direction: 'LR',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const { container } = render(<DiagramFlow payload={payload} />);
    expect(container.querySelector('figcaption')).toBe(null);
  });

  it('has role="img" with a descriptive aria-label', () => {
    const payload: DiagramFlowPayload = {
      kind: 'DiagramFlow',
      direction: 'LR',
      nodes: [
        { id: 'a', label: 'Ingest' },
        { id: 'b', label: 'Persist' },
        { id: 'c', label: 'Notify' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    render(<DiagramFlow payload={payload} />);
    const fig = screen.getByRole('img');
    const label = fig.getAttribute('aria-label') ?? '';
    // The aria-label should include every node label.
    expect(label).toMatch(/Ingest/);
    expect(label).toMatch(/Persist/);
    expect(label).toMatch(/Notify/);
  });
});
