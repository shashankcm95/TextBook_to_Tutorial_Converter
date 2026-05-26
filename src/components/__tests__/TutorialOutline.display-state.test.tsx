// @vitest-environment jsdom
//
// src/components/__tests__/TutorialOutline.display-state.test.tsx
//
// BUG-1 (5-persona walkthrough). The outline sidebar must visually
// distinguish:
//
//   - pending  → calm "Not yet generated" pill, no spinner. (BUG-1 regression
//                target: pre-fix this rendered a streaming spinner because
//                upstream coerced pending→streaming.)
//   - streaming → animated Loader2 spinner + "Streaming" pill. The ONLY
//                 state where activity copy is honest.
//   - partial  → "Quiz unavailable" warn pill.
//   - failed   → "Generation failed" destructive pill.
//   - complete → success pill (covered by existing flows, not re-tested here).
//
// We render the actual TutorialOutline and inspect by accessible role +
// text, not by class names — the test should survive Tailwind class churn.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TutorialOutline, type TutorialOutlineChapter } from '../TutorialOutline';

afterEach(() => {
  cleanup();
});

function makeChapter(
  partial: Partial<TutorialOutlineChapter> &
    Pick<TutorialOutlineChapter, 'id' | 'ordinal' | 'title' | 'status'>,
): TutorialOutlineChapter {
  return {
    completionCriteriaMet: false,
    ...partial,
  };
}

describe('TutorialOutline display-state — BUG-1 fix', () => {
  it('renders "Not yet generated" pill for a pending chapter, NOT "Streaming"', () => {
    const chapters: TutorialOutlineChapter[] = [
      makeChapter({ id: 'c1', ordinal: 0, title: 'Intro', status: 'complete' }),
      makeChapter({ id: 'c2', ordinal: 1, title: 'Replication', status: 'pending' }),
    ];
    const { container } = render(
      <TutorialOutline
        chapters={chapters}
        tutorialId="t1"
        maxUnlocked={5}
        currentChapterOrdinal={0}
      />,
    );
    expect(screen.getByText('Not yet generated')).toBeTruthy();
    // Pre-fix regression guard: the pending row must NOT carry the
    // streaming pill label.
    expect(container.textContent ?? '').not.toMatch(/\bStreaming\b/);
  });

  it('renders the "Streaming" pill ONLY when a chapter is actually streaming', () => {
    const chapters: TutorialOutlineChapter[] = [
      makeChapter({ id: 'c1', ordinal: 0, title: 'Intro', status: 'streaming' }),
      makeChapter({ id: 'c2', ordinal: 1, title: 'Encoding', status: 'pending' }),
    ];
    render(
      <TutorialOutline
        chapters={chapters}
        tutorialId="t1"
        maxUnlocked={5}
        currentChapterOrdinal={0}
      />,
    );
    // The streaming pill exists exactly once — the actively-streaming row.
    expect(screen.getAllByText('Streaming').length).toBe(1);
    // And the pending row still gets the honest label.
    expect(screen.getByText('Not yet generated')).toBeTruthy();
  });

  it('renders "Quiz unavailable" pill for a partial chapter', () => {
    const chapters: TutorialOutlineChapter[] = [
      makeChapter({ id: 'c1', ordinal: 0, title: 'Intro', status: 'partial' }),
    ];
    render(
      <TutorialOutline
        chapters={chapters}
        tutorialId="t1"
        maxUnlocked={5}
      />,
    );
    expect(screen.getByText('Quiz unavailable')).toBeTruthy();
  });

  it('renders "Generation failed" pill for a failed chapter', () => {
    const chapters: TutorialOutlineChapter[] = [
      makeChapter({ id: 'c1', ordinal: 0, title: 'Intro', status: 'failed' }),
    ];
    render(
      <TutorialOutline
        chapters={chapters}
        tutorialId="t1"
        maxUnlocked={5}
      />,
    );
    expect(screen.getByText('Generation failed')).toBeTruthy();
  });

  it('renders "Locked" for chapters beyond the ratchet, ignoring their incoming status', () => {
    const chapters: TutorialOutlineChapter[] = [
      makeChapter({ id: 'c1', ordinal: 0, title: 'Intro', status: 'complete' }),
      // Even if upstream sent 'streaming', the ratchet wins.
      makeChapter({ id: 'c2', ordinal: 5, title: 'Way later', status: 'streaming' }),
    ];
    render(
      <TutorialOutline
        chapters={chapters}
        tutorialId="t1"
        maxUnlocked={0}
      />,
    );
    expect(screen.getByText('Locked')).toBeTruthy();
  });
});
