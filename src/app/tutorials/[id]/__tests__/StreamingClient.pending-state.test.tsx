// @vitest-environment jsdom
//
// src/app/tutorials/[id]/__tests__/StreamingClient.pending-state.test.tsx
//
// BUG-1 (5-persona walkthrough — universally flagged). Pre-fix, every chapter
// that wasn't yet `complete` in the DB rendered the StreamingProgressIndicator,
// which displays "Generating chapter… 0 chars received". Five personas
// independently read that copy as a lying progress indicator on queued
// chapters — no LLM activity was actually happening, the chapters were just
// pending in the lazy-hybrid-chunking ratchet.
//
// These tests assert the post-fix contract:
//
//   (a) Pending chapters render the calm `PendingChapterPlaceholder` ("Not
//       yet generated") and DO NOT mention "Generating chapter" or "chars
//       received" anywhere in the placeholder copy.
//
//   (b) Streaming chapters with tokens flowing keep the honest
//       `StreamingProgressIndicator` — "Generating chapter…" + N chars
//       received. This is the only state where that copy is truthful.
//
//   (c) Streaming chapters that haven't received any tokens yet
//       (post-chapter-start, pre-first-token) show "Generating chapter…"
//       but suppress the "0 chars received" counter — we don't lie about
//       a number we don't have yet.
//
// The tests render only the leaf presentational components (PendingChapter-
// Placeholder, StreamingProgressIndicator) — they're pure UI islands with
// no SSE/router/csrf coupling, so testing them in isolation is both faster
// and more focused than spinning up the full StreamingClient with the
// hook-mocking surface that would require.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  PendingChapterPlaceholder,
  StreamingProgressIndicator,
} from '../StreamingClient';

afterEach(() => {
  cleanup();
});

describe('PendingChapterPlaceholder — BUG-1 fix: queued chapters do NOT claim LLM activity', () => {
  it('renders the calm "Not yet generated" headline for a non-active queued chapter', () => {
    render(
      <PendingChapterPlaceholder
        ordinal={2}
        title="Replication"
        isActive={false}
      />,
    );
    // The honest copy.
    expect(screen.getByText('Not yet generated')).toBeTruthy();
    expect(
      screen.getByText('This chapter will be generated when you reach it.'),
    ).toBeTruthy();
  });

  it('renders "Queued — starting shortly" when the chapter is the active SSE target', () => {
    render(
      <PendingChapterPlaceholder
        ordinal={3}
        title="Partitioning"
        isActive={true}
      />,
    );
    expect(screen.getByText('Queued — starting shortly')).toBeTruthy();
    expect(
      screen.getByText('The first tokens will arrive in a moment.'),
    ).toBeTruthy();
  });

  it('does NOT emit the lying "Generating chapter…" or "chars received" copy (the BUG-1 regression guard)', () => {
    const { container } = render(
      <PendingChapterPlaceholder ordinal={1} title="Storage" isActive={false} />,
    );
    // Universal anti-claim: nothing in this component should ever claim
    // generation is happening or that bytes are arriving over the wire.
    expect(container.textContent ?? '').not.toMatch(/Generating chapter/i);
    expect(container.textContent ?? '').not.toMatch(/chars received/i);
    expect(container.textContent ?? '').not.toMatch(/\b0 chars\b/);
  });

  it('uses aria-live=polite so screen readers announce the state without interrupting', () => {
    const { container } = render(
      <PendingChapterPlaceholder ordinal={0} title="Foundations" isActive={false} />,
    );
    const statusEl = container.querySelector('[role="status"]');
    expect(statusEl).not.toBeNull();
    expect(statusEl?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('StreamingProgressIndicator — BUG-1 fix: keep streaming copy honest', () => {
  it('shows "Generating chapter…" + char counter when tokens are actually arriving', () => {
    render(<StreamingProgressIndicator receivedChars={1234} />);
    // Both halves of the honest streaming UI.
    expect(screen.getByText('Generating chapter…')).toBeTruthy();
    expect(screen.getByText('1,234 chars received')).toBeTruthy();
  });

  it('suppresses the char counter at receivedChars=0 — no "0 chars received" lie', () => {
    const { container } = render(<StreamingProgressIndicator receivedChars={0} />);
    // We DO keep the "Generating chapter…" line (it's honest: chapter-start
    // has fired, the LLM has been pinged, the stream is open).
    expect(screen.getByText('Generating chapter…')).toBeTruthy();
    // We DON'T claim 0 chars received — that's the exact phrasing the
    // 5-persona walkthrough flagged.
    expect(container.textContent ?? '').not.toMatch(/chars received/i);
    expect(container.textContent ?? '').not.toMatch(/\b0\b/);
  });
});
