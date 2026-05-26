// @vitest-environment jsdom
//
// src/components/diagrams/__tests__/StateTransitionDiagram.test.tsx
//
// Tests for the StateTransitionDiagram SVG primitive (Sprint F.2).
// Asserts the structural / a11y / routing contract documented in the
// Sprint F.2 RFC §"Primitive 2" — layout details are visually verified
// via the Playwright snapshot job (Builder F).

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StateTransitionDiagram from '../StateTransitionDiagram';
import type { StateTransitionDiagramPayload } from '@/lib/diagrams/schema';

// vitest does not auto-register testing-library cleanup the way
// @testing-library/react/vitest would; without this, sibling tests leak
// DOM into one another and getAllBy queries return duplicates.
afterEach(() => {
  cleanup();
});

describe('StateTransitionDiagram', () => {
  it('renders a 2-state diagram with initial + terminal markers', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      states: [
        { id: 'idle', label: 'Idle', initial: true },
        { id: 'done', label: 'Done', terminal: true },
      ],
      transitions: [{ from: 'idle', to: 'done', trigger: 'start' }],
    };
    const { container } = render(<StateTransitionDiagram payload={payload} />);

    // Both state-label texts are visible.
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();

    // Terminal double-ring: total circle count = 2 state circles
    // + 1 inner-ring (terminal) + 1 initial-marker dot = 4.
    const circles = container.querySelectorAll('svg circle');
    expect(circles.length).toBe(4);
  });

  it('renders a 5-state cycle (transitions: a→b→c→d→e→a)', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      states: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
        { id: 'e', label: 'E' },
      ],
      transitions: [
        { from: 'a', to: 'b', trigger: 't1' },
        { from: 'b', to: 'c', trigger: 't2' },
        { from: 'c', to: 'd', trigger: 't3' },
        { from: 'd', to: 'e', trigger: 't4' },
        { from: 'e', to: 'a', trigger: 't5' },
      ],
    };
    const { container } = render(<StateTransitionDiagram payload={payload} />);

    // 5 state labels + 5 trigger labels = 10 <text> elements.
    const texts = container.querySelectorAll('svg text');
    expect(texts.length).toBe(10);

    // 5 transition <line> arrows (no self-loop, no bidir).
    const lines = container.querySelectorAll('svg line');
    expect(lines.length).toBe(5);

    // 5 state circles (no terminal, no initial).
    const circles = container.querySelectorAll('svg circle');
    expect(circles.length).toBe(5);

    // Each trigger label is visible.
    for (const t of ['t1', 't2', 't3', 't4', 't5']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
  });

  it('renders a self-loop with its trigger label visible', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      states: [
        { id: 'a', label: 'Listening' },
        { id: 'b', label: 'Talking' },
      ],
      transitions: [
        { from: 'a', to: 'a', trigger: 'noise' },
        { from: 'a', to: 'b', trigger: 'speak' },
      ],
    };
    const { container } = render(<StateTransitionDiagram payload={payload} />);

    // Self-loop renders as <path>, not <line>.
    const paths = container.querySelectorAll('svg path');
    // 1 self-loop path + 1 arrowhead marker path = 2.
    expect(paths.length).toBeGreaterThanOrEqual(1);

    // Trigger label "noise" must be visible.
    expect(screen.getByText('noise')).toBeTruthy();
    expect(screen.getByText('speak')).toBeTruthy();
  });

  it('renders both labels for a bidirectional pair (A↔B)', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      states: [
        { id: 'a', label: 'Open' },
        { id: 'b', label: 'Closed' },
      ],
      transitions: [
        { from: 'a', to: 'b', trigger: 'shut' },
        { from: 'b', to: 'a', trigger: 'open' },
      ],
    };
    const { container } = render(<StateTransitionDiagram payload={payload} />);

    // Two transition lines (one per direction).
    const lines = container.querySelectorAll('svg line');
    expect(lines.length).toBe(2);

    // Both trigger labels visible and distinct.
    expect(screen.getByText('shut')).toBeTruthy();
    expect(screen.getByText('open')).toBeTruthy();
  });

  it('concatenates triggers with " | " for same-direction same-pair transitions', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      states: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      transitions: [
        { from: 'a', to: 'b', trigger: 'timeout' },
        { from: 'a', to: 'b', trigger: 'error' },
      ],
    };
    const { container } = render(<StateTransitionDiagram payload={payload} />);

    // The two transitions collapse into ONE line.
    const lines = container.querySelectorAll('svg line');
    expect(lines.length).toBe(1);

    // The merged label is rendered as one text node "timeout | error".
    expect(screen.getByText('timeout | error')).toBeTruthy();
  });

  it('drops transitions referencing missing state ids', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      states: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      transitions: [
        { from: 'a', to: 'b', trigger: 'real' },
        { from: 'a', to: 'ghost', trigger: 'phantom' }, // 'ghost' does not exist
        { from: 'missing', to: 'b', trigger: 'also-phantom' },
      ],
    };
    const { container } = render(<StateTransitionDiagram payload={payload} />);

    // Only the real transition draws a line.
    const lines = container.querySelectorAll('svg line');
    expect(lines.length).toBe(1);
    expect(screen.getByText('real')).toBeTruthy();
    expect(screen.queryByText('phantom')).toBe(null);
    expect(screen.queryByText('also-phantom')).toBe(null);
  });

  it('renders <figcaption> when payload.title is set', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      title: 'TCP connection lifecycle',
      states: [
        { id: 'a', label: 'CLOSED' },
        { id: 'b', label: 'LISTEN' },
      ],
      transitions: [{ from: 'a', to: 'b', trigger: 'passive open' }],
    };
    const { container } = render(<StateTransitionDiagram payload={payload} />);
    const caption = container.querySelector('figcaption');
    expect(caption).toBeTruthy();
    expect(caption?.textContent).toBe('TCP connection lifecycle');
  });

  it('omits <figcaption> when payload.title is absent', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      states: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      transitions: [{ from: 'a', to: 'b' }],
    };
    const { container } = render(<StateTransitionDiagram payload={payload} />);
    expect(container.querySelector('figcaption')).toBe(null);
  });

  it('has role="img" with a descriptive aria-label', () => {
    const payload: StateTransitionDiagramPayload = {
      kind: 'StateTransitionDiagram',
      title: 'TCP',
      states: [
        { id: 'a', label: 'CLOSED' },
        { id: 'b', label: 'LISTEN' },
      ],
      transitions: [{ from: 'a', to: 'b', trigger: 'passive open' }],
    };
    render(<StateTransitionDiagram payload={payload} />);
    const fig = screen.getByRole('img');
    const aria = fig.getAttribute('aria-label') ?? '';
    expect(aria).toMatch(/TCP/);
    expect(aria).toMatch(/CLOSED/);
    expect(aria).toMatch(/LISTEN/);
  });
});
