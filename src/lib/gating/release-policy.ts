// src/lib/gating/release-policy.ts — one-way ratchet for chapter release.
//
// The lazy-hybrid-chunking architecture gates chapters behind a per-user
// progress ratchet stored in tutorials.max_unlocked_chapter_idx (monotonic;
// never decrements). Chapter 0 is released at ingest time; subsequent
// chapters unlock when the preceding chapter's completion criteria are met.
//
// Completion criteria (v1):
//   last_quiz_score >= MIN_QUIZ_SCORE  OR  manual override (markComplete)
//
// Why quiz-score-only signal (not scroll-depth + time-spent + score):
//   - Scroll-depth and time-spent are easily faked client-side (user can
//     scroll through without reading; tab-switch and time still ticks).
//   - Quiz score is the only signal that demonstrates actual engagement —
//     random guessing over 4-option MCQ averages 25%; 60% requires the
//     student to have understood most points.
//   - Manual override exists for chapters where the quiz under-generated
//     (rare but possible — partial chapters with < 5 questions).
//
// Why server-side ratchet (not client-derived):
//   - Client-side gating is trivially bypassable via DevTools.
//   - All writes to released_at + max_unlocked_chapter_idx happen server-side
//     in a single transaction per /complete invocation; client cannot mutate.
//
// Design anchors:
//   - kb:architecture/discipline/error-handling-discipline §"Pattern 7" —
//     fail-closed on completion-check ambiguity (default: NOT complete).
//   - kb:architecture/crosscut/single-responsibility — this module owns ONLY
//     the gating policy. Chapter generation is in per-chapter.ts; user
//     interaction tracking is in chapters table columns.

import { eq, and, gt, isNull, asc } from 'drizzle-orm';
import { db, rawDb } from '@/db/client';
import { tutorials, chapters } from '@/db/schema';

/**
 * Minimum quiz score (0..1) to count as "complete" automatically. 0.6 = 60%.
 * Random guessing over 4-option MCQ averages 25%; threshold above that
 * disqualifies pure-guess passes but is generous enough not to block honest
 * readers who miss one or two questions.
 */
export const MIN_QUIZ_SCORE_FOR_COMPLETION = 0.6;

// ───────────────────────────────────────────────────────────────────────────
// Predicates
// ───────────────────────────────────────────────────────────────────────────

/**
 * Does this chapter meet the auto-completion criteria?
 *
 * Pure function — easy to unit test. Takes the relevant chapter columns; the
 * caller (the /complete endpoint) loads the row and passes them in.
 */
export function meetsCompletionCriteria(args: {
  lastQuizScore: number | null;
  manualOverride: boolean;
}): boolean {
  if (args.manualOverride === true) return true;
  if (args.lastQuizScore === null) return false;
  return args.lastQuizScore >= MIN_QUIZ_SCORE_FOR_COMPLETION;
}

// ───────────────────────────────────────────────────────────────────────────
// Mutators — server-only writes
// ───────────────────────────────────────────────────────────────────────────

export interface MarkCompleteArgs {
  tutorialId: string;
  chapterId: string;
  chapterOrdinal: number;
  /** Source signal: quiz-score-passed or user-clicked-mark-complete. */
  signal: 'quiz-score' | 'manual-override';
  /** When signal=quiz-score, the score that triggered it (for audit). */
  quizScore?: number;
}

export interface MarkCompleteResult {
  /** True if this call moved the chapter from incomplete → complete. */
  bumped: boolean;
  /** New value of tutorials.max_unlocked_chapter_idx after this call. */
  newMaxUnlocked: number;
  /** Id of the chapter that was just released (or null if nothing changed). */
  releasedChapterId: string | null;
}

/**
 * Mark a chapter complete and bump the ratchet if applicable.
 *
 * Idempotent: if chapter is already complete OR ratchet is already past it,
 * returns bumped=false. The ratchet NEVER decrements.
 *
 * Transactional: completion-criteria-met flip, ratchet bump, and next
 * chapter's released_at write all happen in one DB transaction. A partial
 * failure leaves the system in a consistent state.
 */
export function markChapterComplete(
  args: MarkCompleteArgs,
): MarkCompleteResult {
  const { tutorialId, chapterId, chapterOrdinal, signal, quizScore } = args;
  const now = Math.floor(Date.now() / 1000);

  let result: MarkCompleteResult = {
    bumped: false,
    newMaxUnlocked: 0,
    releasedChapterId: null,
  };

  db.transaction((tx) => {
    // Load current state inside transaction (so concurrent calls are
    // serialized by SQLite's per-DB write lock).
    const tutRow = tx
      .select({
        maxUnlocked: tutorials.maxUnlockedChapterIdx,
        totalChapters: tutorials.totalChapters,
      })
      .from(tutorials)
      .where(eq(tutorials.id, tutorialId))
      .limit(1)
      .all()[0];
    if (!tutRow) return; // tutorial gone; bail with default result

    const chRow = tx
      .select({
        completionCriteriaMet: chapters.completionCriteriaMet,
        classification: chapters.classification,
      })
      .from(chapters)
      .where(eq(chapters.id, chapterId))
      .limit(1)
      .all()[0];
    if (!chRow) return;

    // Idempotency: already-complete chapters are no-op
    if (chRow.completionCriteriaMet) {
      result = {
        bumped: false,
        newMaxUnlocked: tutRow.maxUnlocked,
        releasedChapterId: null,
      };
      return;
    }

    // Mark this chapter complete.
    const setFields: Record<string, unknown> = { completionCriteriaMet: true };
    if (signal === 'quiz-score' && typeof quizScore === 'number') {
      setFields.lastQuizScore = quizScore;
      setFields.lastQuizAttemptAt = new Date(now * 1000);
    }
    tx.update(chapters).set(setFields).where(eq(chapters.id, chapterId)).run();

    // Bump ratchet only if this chapter is at or above the current
    // max_unlocked threshold. (max_unlocked-1 is the highest released; user
    // completing a still-locked chapter shouldn't be possible UI-wise but
    // we defend in depth.)
    const newMax = Math.max(tutRow.maxUnlocked, chapterOrdinal + 1);
    if (newMax > tutRow.maxUnlocked) {
      tx.update(tutorials)
        .set({ maxUnlockedChapterIdx: newMax })
        .where(eq(tutorials.id, tutorialId))
        .run();

      // Find the next BODY chapter past ordinal and release it. We only
      // release one chapter per bump — the next bump comes when the user
      // completes the just-released chapter.
      const totalBody = (tutRow.totalChapters ?? 0);
      let releasedId: string | null = null;
      // Look at the chapter that should now be released
      const nextChapter = tx
        .select({ id: chapters.id, ordinal: chapters.ordinal })
        .from(chapters)
        .where(
          and(
            eq(chapters.tutorialId, tutorialId),
            gt(chapters.ordinal, chapterOrdinal),
            isNull(chapters.releasedAt),
            eq(chapters.classification, 'body'),
          ),
        )
        .orderBy(asc(chapters.ordinal))
        .limit(1)
        .all()[0];
      if (nextChapter) {
        tx.update(chapters)
          .set({ releasedAt: new Date(now * 1000) })
          .where(eq(chapters.id, nextChapter.id))
          .run();
        releasedId = nextChapter.id;
      }

      result = {
        bumped: true,
        newMaxUnlocked: newMax,
        releasedChapterId: releasedId,
      };
      // Silence the unused-warning lint for totalBody (kept for future
      // "you've completed the whole tutorial" detection in v2).
      void totalBody;
    } else {
      result = {
        bumped: false,
        newMaxUnlocked: tutRow.maxUnlocked,
        releasedChapterId: null,
      };
    }
  });

  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Convenience: compute quiz score from raw answer payload
// ───────────────────────────────────────────────────────────────────────────

export interface QuizAnswerPayload {
  /** Map<questionId, answerIdx (0..3)>. */
  answers: Record<string, number>;
}

export interface ScoredQuizResult {
  score: number;            // 0..1
  correctCount: number;
  totalCount: number;
}

/**
 * Score a quiz attempt against the stored questions. Pure function — caller
 * loads the questions, passes them + the answers payload, gets back a score
 * and persists it.
 *
 * Strict: only counts answered questions whose index matches the stored
 * correctIndex. Unanswered questions count as incorrect (not skipped) — the
 * student must engage with every question.
 */
export function scoreQuiz(
  questions: Array<{ id: string; correctIndex: number }>,
  payload: QuizAnswerPayload,
): ScoredQuizResult {
  if (questions.length === 0) {
    return { score: 0, correctCount: 0, totalCount: 0 };
  }
  let correct = 0;
  for (const q of questions) {
    const userAnswer = payload.answers[q.id];
    if (typeof userAnswer === 'number' && userAnswer === q.correctIndex) {
      correct++;
    }
  }
  return {
    score: correct / questions.length,
    correctCount: correct,
    totalCount: questions.length,
  };
}

// silence unused-imports during the v1 partial implementation
void rawDb;
