// @vitest-environment jsdom
//
// src/components/diagrams/__tests__/SequenceDiagram.test.tsx
//
// Unit tests for the Sprint F.2 SequenceDiagram primitive. jsdom does
// not implement SVG layout, so these tests assert structural / a11y /
// data contracts only: counts and roles of <text>/<line>/<path>,
// stroke-dasharray for return-kind messages, the right-loop path emitted
// for self-messages, defensive drop of messages referencing unknown
// actors, and figure/figcaption a11y. Visual-layout correctness is
// covered by Playwright snapshot specs (Builder F).

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import SequenceDiagram from '../SequenceDiagram';
import type { SequenceDiagramPayload } from '@/lib/diagrams/schema';

afterEach(() => {
  cleanup();
});

describe('SequenceDiagram', () => {
  it('renders 3 actors as labeled boxes at the top', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      actors: ['Client', 'Server', 'DB'],
      messages: [{ from: 'Client', to: 'Server', label: 'GET /' }],
    };
    render(<SequenceDiagram payload={payload} />);
    // Each actor name should appear in a <text> element.
    expect(screen.getByText('Client')).toBeTruthy();
    expect(screen.getByText('Server')).toBeTruthy();
    expect(screen.getByText('DB')).toBeTruthy();
    // Three actor boxes — one rect per actor.
    expect(document.querySelectorAll('svg rect').length).toBeGreaterThanOrEqual(3);
  });

  it('renders 4 messages with call/return/async kinds in order', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      actors: ['Client', 'Server'],
      messages: [
        { from: 'Client', to: 'Server', label: 'request', kind: 'call' },
        { from: 'Server', to: 'Client', label: 'response', kind: 'return' },
        { from: 'Client', to: 'Server', label: 'notify', kind: 'async' },
        { from: 'Client', to: 'Server', label: 'follow-up' }, // default = call
      ],
    };
    render(<SequenceDiagram payload={payload} />);
    expect(screen.getByText('request')).toBeTruthy();
    expect(screen.getByText('response')).toBeTruthy();
    expect(screen.getByText('notify')).toBeTruthy();
    expect(screen.getByText('follow-up')).toBeTruthy();
    // 4 cross-lifeline messages → 4 <line> elements for arrows. Plus the
    // 2 lifelines for actors. Total svg <line> ≥ 6.
    const lines = document.querySelectorAll('svg line');
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  it('uses solid stroke for calls and dashed stroke for returns', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      actors: ['A', 'B'],
      messages: [
        { from: 'A', to: 'B', label: 'go', kind: 'call' },
        { from: 'B', to: 'A', label: 'back', kind: 'return' },
      ],
    };
    render(<SequenceDiagram payload={payload} />);
    // Find the message lines (not the lifelines). Lifelines have a
    // stroke-dasharray of "4 4"; the return message line has "6 4"; the
    // call message line has no dasharray. We assert at least one line
    // exists matching each pattern.
    const allLines = Array.from(document.querySelectorAll('svg line'));
    const dashPatterns = allLines.map((el) => el.getAttribute('stroke-dasharray'));
    // The call message line has no dasharray attribute (undefined → null).
    expect(dashPatterns.some((d) => d === null)).toBe(true);
    // The return message line has "6 4".
    expect(dashPatterns.some((d) => d === '6 4')).toBe(true);
  });

  it('renders a self-message as a right-loop on the same lifeline', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      actors: ['Service', 'Worker'],
      messages: [
        { from: 'Service', to: 'Service', label: 'tick', kind: 'call' },
      ],
    };
    render(<SequenceDiagram payload={payload} />);
    // Self-message renders as <path>, NOT <line> — that's how we
    // distinguish the right-loop geometry from the straight-arrow case.
    const paths = document.querySelectorAll('svg path');
    // Path 'd' attribute should contain a cubic Bézier ("C ").
    const selfLoopPaths = Array.from(paths).filter((p) => {
      const d = p.getAttribute('d') ?? '';
      return d.startsWith('M ') && d.includes(' C ');
    });
    expect(selfLoopPaths.length).toBeGreaterThanOrEqual(1);
    // The label is still rendered.
    expect(screen.getByText('tick')).toBeTruthy();
  });

  it('drops messages referencing missing actor names', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      actors: ['Client', 'Server'],
      messages: [
        { from: 'Client', to: 'Server', label: 'valid' },
        { from: 'Client', to: 'Ghost', label: 'orphan-to' },
        { from: 'Phantom', to: 'Server', label: 'orphan-from' },
      ],
    };
    render(<SequenceDiagram payload={payload} />);
    // The surviving message's label is present...
    expect(screen.getByText('valid')).toBeTruthy();
    // ...and the dropped ones are not in the rendered output.
    expect(screen.queryByText('orphan-to')).toBe(null);
    expect(screen.queryByText('orphan-from')).toBe(null);
  });

  it('renders <figcaption> when payload.title is set', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      title: 'HTTP request lifecycle',
      actors: ['Client', 'Server'],
      messages: [{ from: 'Client', to: 'Server', label: 'GET' }],
    };
    const { container } = render(<SequenceDiagram payload={payload} />);
    expect(screen.getByText('HTTP request lifecycle')).toBeTruthy();
    expect(container.querySelector('figcaption')).toBeTruthy();
  });

  it('omits the figcaption when title is absent', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      actors: ['Client', 'Server'],
      messages: [{ from: 'Client', to: 'Server', label: 'GET' }],
    };
    const { container } = render(<SequenceDiagram payload={payload} />);
    expect(container.querySelector('figcaption')).toBe(null);
  });

  it('has role="img" with a descriptive aria-label', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      title: 'Auth flow',
      actors: ['Browser', 'API', 'DB'],
      messages: [{ from: 'Browser', to: 'API', label: 'login' }],
    };
    render(<SequenceDiagram payload={payload} />);
    const fig = screen.getByRole('img');
    const aria = fig.getAttribute('aria-label') ?? '';
    expect(aria).toMatch(/Auth flow/);
    expect(aria).toMatch(/Browser/);
    expect(aria).toMatch(/API/);
    expect(aria).toMatch(/DB/);
  });

  // Sprint F.2 Wave-2 reviewer fix-up: ensure async messages route to
  // cb-arrow-seq-async (open-triangle marker) and call/return messages
  // route to cb-arrow-seq-call (filled marker). Without this assertion
  // a future edit that always emits cb-arrow-seq-call would silently
  // pass every existing test.
  it('uses cb-arrow-seq-async for async messages and cb-arrow-seq-call otherwise', () => {
    const payload: SequenceDiagramPayload = {
      kind: 'SequenceDiagram',
      actors: ['Client', 'Server'],
      messages: [
        { from: 'Client', to: 'Server', label: 'sync-call', kind: 'call' },
        { from: 'Client', to: 'Server', label: 'fire-async', kind: 'async' },
        { from: 'Server', to: 'Client', label: 'result', kind: 'return' },
      ],
    };
    render(<SequenceDiagram payload={payload} />);
    const lines = Array.from(document.querySelectorAll('svg line'));
    const markerEnds = lines.map((el) => el.getAttribute('marker-end') ?? '');
    expect(markerEnds.some((m) => m === 'url(#cb-arrow-seq-async)')).toBe(true);
    expect(markerEnds.some((m) => m === 'url(#cb-arrow-seq-call)')).toBe(true);
  });
});
