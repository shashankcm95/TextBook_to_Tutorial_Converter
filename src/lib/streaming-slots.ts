// src/lib/streaming-slots.ts — shared concurrent-SSE-stream slot tracker.
//
// Closes DRIFT-test3-033. Background:
//
//   The legacy /api/tutorials/:id/stream route enforces "max 2 concurrent
//   open SSE connections per user" via an in-memory Map<userId, count>
//   (originally added as the mio HIGH-2 fold during test3 Phase 3). Without
//   it, an authenticated user can open N EventSource tabs in rapid
//   succession; each triggers parallel generation, multiplying OpenAI
//   spend AND server CPU + DB write contention by N.
//
//   After DRIFT-019 (per-chapter SSE rewire), the production UI path
//   moved to /api/tutorials/:id/chapters/:idx/stream. The new route was
//   created without the slot cap — only the legacy tutorial-level route
//   had it. So in production, a user with N tabs could:
//     - Open chapter 0 stream in tab 1 (generation starts)
//     - Open chapter 0 stream in tab 2 (parallel generation; both bill)
//     - Open chapter 0 stream in tab N (N parallel generations)
//   Only the tutorial-level cost-cap is the financial backstop, and that's
//   per-tutorial, not per-user — N tabs against the SAME tutorial would
//   bypass the legacy stream-slot mechanism entirely.
//
// This module extracts the slot tracker into a shared in-memory store used
// by BOTH routes. Each user has a single bucket counted across both
// endpoints — opening 1 legacy stream + 1 per-chapter stream consumes 2 of
// the 2-slot quota. Conservative; protects the OpenAI budget at the cost of
// rejecting some legitimate concurrent reads (acceptable for an MVP).
//
// Process-local caveat (R3 from the retry/rate-limit audit): the Map lives
// in a single Node process. Multi-instance deploys must swap for Redis or
// a DB-row counter; documented in docs/eval/HARNESS-DESIGN.md §Risks.

// ───────────────────────────────────────────────────────────────────────────
// Configuration
// ───────────────────────────────────────────────────────────────────────────

/** Maximum concurrent open SSE streams per user, across all stream routes. */
export const MAX_CONCURRENT_STREAMS_PER_USER = 2;

// ───────────────────────────────────────────────────────────────────────────
// In-memory state
// ───────────────────────────────────────────────────────────────────────────
//
// HMR-safe singleton: Next.js dev mode hot-reloads modules; a fresh Map per
// reload would let users bypass the cap by triggering an edit. The
// globalThis cache mirrors the pattern in src/db/client.ts.

const globalForSlots = globalThis as unknown as {
  __ttt_streaming_slots__?: Map<string, number>;
};

const concurrentStreams: Map<string, number> =
  globalForSlots.__ttt_streaming_slots__ ?? new Map();

if (process.env.NODE_ENV !== 'production') {
  globalForSlots.__ttt_streaming_slots__ = concurrentStreams;
}

// ───────────────────────────────────────────────────────────────────────────
// Public surface
// ───────────────────────────────────────────────────────────────────────────

/**
 * Atomically check + increment the slot count for this user. Returns true
 * iff a slot was acquired. Caller MUST pair with a `releaseSlot(userId)` in
 * a finally block — otherwise the count leaks on error paths.
 *
 * The check + increment is sequential within a single Node process so this
 * is race-free for single-process deploys. Multi-instance deploys would
 * need an atomic operation against shared state (Redis INCR + check).
 */
export function tryAcquireSlot(userId: string): boolean {
  const current = concurrentStreams.get(userId) ?? 0;
  if (current >= MAX_CONCURRENT_STREAMS_PER_USER) {
    return false;
  }
  concurrentStreams.set(userId, current + 1);
  return true;
}

/**
 * Release one slot. Idempotent: safe to call even if no slot was held
 * (count clamps at 0). The slot Map entry is deleted when the count hits
 * 0 to keep memory bounded.
 *
 * IMPORTANT: callers MUST call this in a `finally` block, NOT only on
 * success paths. The stream lifecycle: acquire on route entry → release
 * in the ReadableStream's `cancel`/`close`/error handlers + a try/finally
 * around the body. Forgetting to release will leak the slot until the
 * process restarts.
 */
export function releaseSlot(userId: string): void {
  const current = concurrentStreams.get(userId) ?? 0;
  if (current <= 1) {
    concurrentStreams.delete(userId);
  } else {
    concurrentStreams.set(userId, current - 1);
  }
}

/**
 * Test-only: clear the slot store. Used by integration tests that need a
 * known starting state. NOT exported by name from any non-test path; the
 * function is intentionally undocumented in the public TypeScript types
 * for callers outside __tests__.
 */
export function _resetSlotsForTesting(): void {
  concurrentStreams.clear();
}

/**
 * Read-only inspection of the current slot count. Used by tests and by
 * future observability (e.g., a `/api/admin/streams` endpoint exposing
 * live concurrency). Does NOT modify state.
 */
export function getSlotCount(userId: string): number {
  return concurrentStreams.get(userId) ?? 0;
}
