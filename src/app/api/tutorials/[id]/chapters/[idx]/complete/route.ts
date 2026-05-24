// src/app/api/tutorials/[id]/chapters/[idx]/complete/route.ts
//
// POST endpoint to mark a chapter complete + bump the gating ratchet.
//
// Two signal modes:
//   1. Quiz score: body = { signal: 'quiz-score', answers: { [questionId]: number } }
//      Server scores against stored questions; only marks complete if score
//      >= MIN_QUIZ_SCORE_FOR_COMPLETION (0.6).
//   2. Manual override: body = { signal: 'manual-override' }
//      Used when the auto-generated quiz under-generated (rare) or the
//      student wants to mark complete without taking the quiz.
//
// All writes (chapter.completionCriteriaMet, last_quiz_score, ratchet bump,
// next chapter's released_at) happen server-side in a single transaction.
//
// CSRF: required (POST). Auth: session cookie.

import { NextResponse, type NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { tutorials, chapters, questions as questionsTable } from '@/db/schema';
import { verifySession, SESSION_COOKIE_NAME } from '@/lib/session';
import {
  markChapterComplete,
  meetsCompletionCriteria,
  scoreQuiz,
  MIN_QUIZ_SCORE_FOR_COMPLETION,
} from '@/lib/gating/release-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// CSRF mirror — POST endpoints validate the cookie-mirrored token; matches
// the existing pattern in src/middleware.ts.
const CSRF_HEADER = 'x-csrf-token';
const CSRF_COOKIE = '__csrf';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; idx: string } },
): Promise<NextResponse> {
  // ── Session ─────────────────────────────────────────────────────────
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret) {
    return NextResponse.json(
      { error: 'server misconfigured: SESSION_SECRET missing' },
      { status: 500 },
    );
  }
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
  const payload = await verifySession(sessionCookie, secret);
  if (!payload) {
    return NextResponse.json({ error: 'session required' }, { status: 401 });
  }
  const userId = payload.userId;

  // ── CSRF ────────────────────────────────────────────────────────────
  const headerToken = req.headers.get(CSRF_HEADER);
  const cookieToken = req.cookies.get(CSRF_COOKIE)?.value;
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return NextResponse.json({ error: 'csrf mismatch' }, { status: 403 });
  }

  // ── Params ──────────────────────────────────────────────────────────
  const { id: tutorialId, idx: idxStr } = params;
  if (!/^[0-9a-f-]{36}$/i.test(tutorialId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const chapterIdx = Number.parseInt(idxStr, 10);
  if (!Number.isFinite(chapterIdx) || chapterIdx < 0) {
    return NextResponse.json({ error: 'invalid idx' }, { status: 400 });
  }

  // ── Body ────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be valid JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
  }
  const b = body as { signal?: unknown; answers?: unknown };
  if (b.signal !== 'quiz-score' && b.signal !== 'manual-override') {
    return NextResponse.json(
      { error: 'signal must be "quiz-score" or "manual-override"' },
      { status: 400 },
    );
  }

  // ── Ownership ────────────────────────────────────────────────────────
  const tutRows = await db
    .select()
    .from(tutorials)
    .where(and(eq(tutorials.id, tutorialId), eq(tutorials.userId, userId)))
    .limit(1);
  if (tutRows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const chRows = await db
    .select()
    .from(chapters)
    .where(and(eq(chapters.tutorialId, tutorialId), eq(chapters.ordinal, chapterIdx)))
    .limit(1);
  const chapter = chRows[0];
  if (!chapter) {
    return NextResponse.json({ error: 'chapter not found' }, { status: 404 });
  }
  // Cannot complete a chapter that hasn't been generated yet.
  if (chapter.status !== 'complete' && chapter.status !== 'partial') {
    return NextResponse.json(
      { error: 'chapter not yet generated', status: chapter.status },
      { status: 409 },
    );
  }

  // ── Score (if quiz-score signal) ─────────────────────────────────────
  let quizScore: number | undefined;
  if (b.signal === 'quiz-score') {
    if (typeof b.answers !== 'object' || b.answers === null) {
      return NextResponse.json(
        { error: 'answers must be an object of { [questionId]: 0..3 }' },
        { status: 400 },
      );
    }
    const qRows = await db
      .select({ id: questionsTable.id, correctIndex: questionsTable.correctIndex })
      .from(questionsTable)
      .where(eq(questionsTable.chapterId, chapter.id));
    const scored = scoreQuiz(qRows, { answers: b.answers as Record<string, number> });
    quizScore = scored.score;

    const passed = meetsCompletionCriteria({
      lastQuizScore: quizScore,
      manualOverride: false,
    });
    if (!passed) {
      // Persist the score but DON'T bump the ratchet.
      await db
        .update(chapters)
        .set({
          lastQuizScore: quizScore,
          lastQuizAttemptAt: new Date(),
        })
        .where(eq(chapters.id, chapter.id));
      return NextResponse.json(
        {
          completed: false,
          quizScore,
          threshold: MIN_QUIZ_SCORE_FOR_COMPLETION,
          message: `Quiz score ${(quizScore * 100).toFixed(0)}% below threshold ${(MIN_QUIZ_SCORE_FOR_COMPLETION * 100).toFixed(0)}%`,
        },
        { status: 200 },
      );
    }
  }

  // ── Mark complete + bump ratchet ─────────────────────────────────────
  const result = markChapterComplete({
    tutorialId,
    chapterId: chapter.id,
    chapterOrdinal: chapter.ordinal,
    signal: b.signal,
    quizScore,
  });

  return NextResponse.json(
    {
      completed: true,
      quizScore,
      bumped: result.bumped,
      newMaxUnlocked: result.newMaxUnlocked,
      releasedChapterId: result.releasedChapterId,
    },
    { status: 200 },
  );
}
