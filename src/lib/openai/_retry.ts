// src/lib/openai/_retry.ts — shared retry policy for OpenAI calls.
//
// Closes DRIFT-test3-032. Background:
//
//   The legacy tutorial-level streaming.ts has had a tiered retry policy
//   (429 / 5xx / parse-error) with bounded backoff + ±25% jitter since
//   test3 Phase 3. Robust + production-tested.
//
//   The lazy-hybrid-chunking rewrite (PR #2 → DRIFT-019 per-chapter SSE)
//   split chapter generation into narrative-only.ts + quiz-from-narrative.ts
//   + fidelity-check.ts. Those new modules called openai.chat.completions
//   .create directly with NO retry wrapper. After DRIFT-019 the per-chapter
//   route became the production UI path, so any 429 / transient 5xx now
//   immediately marks the chapter `failed` — the user sees a dead card and
//   the prompt tokens are thrown away.
//
//   Same issue at the ingest side: classifier + glossary-extract 4o-mini
//   calls were "fail-open" by intent (catch error, use default value), so
//   a 429 silently degrades quality (classifier returns 'unknown' on every
//   page → tutorial outline broken).
//
// This module extracts the legacy classifier into a shared `withRetry()`
// wrapper. Lazy-hybrid calls + ingest 4o-mini calls + the existing
// streaming.ts all converge on this one implementation.
//
// Design anchors:
//   - kb:architecture/discipline/error-handling-discipline §retry-tiering —
//     classify by error type, bounded budget per class, cooperative abort.
//   - kb:architecture/discipline/stability-patterns §retry-with-jitter —
//     ±25% jitter prevents synchronized retry-storms across N clients
//     hitting a shared OpenAI rate-limit token bucket.
//   - kb:architecture/crosscut/single-responsibility — retry classification
//     is its own module. Callers express the operation; retry semantics live
//     here.

// ───────────────────────────────────────────────────────────────────────────
// Backoff schedules (per error class)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Backoff schedule per error class. Times are in milliseconds.
 *
 *   429 budget: 1s, 2s, 4s with ±25% jitter — worst-case ≈ 7s wait.
 *   5xx budget: 10s, 30s — worst-case ≈ 40s wait.
 *   parse:      single immediate retry. Callers that want a stricter prompt
 *               on parse-retry use the `attempt` index passed to fn().
 *
 * NOTE: the `attempt` counter is SHARED across error classes. A sequence
 * 429,5xx,429 walks rateLimit[0] → serverError[0] → rateLimit[2] (because
 * attempt is 0, then 1, then 2). Each class's array is capped by length,
 * so a class that runs out of slots returns null (non-retryable). This is
 * intentional: the total retry budget per call is bounded by maxAttempts()
 * regardless of class mix. See finding MEDIUM-2 from the legacy streaming.ts
 * audit — we accept this simplification rather than per-class counters.
 */
export const RETRY_BACKOFF_MS = {
  rateLimit: [1_000, 2_000, 4_000],
  serverError: [10_000, 30_000],
  parseError: [0],
} as const;

/** Total attempts = 1 initial + sum of all retry-budget slots. */
export function maxAttempts(): number {
  return (
    1 +
    RETRY_BACKOFF_MS.rateLimit.length +
    RETRY_BACKOFF_MS.serverError.length +
    RETRY_BACKOFF_MS.parseError.length
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Public surface
// ───────────────────────────────────────────────────────────────────────────

export interface WithRetryArgs<T> {
  /**
   * The operation to retry. Receives the current attempt number (0-indexed)
   * so callers can adjust per-attempt behavior — e.g., streaming.ts appends
   * a stricter JSON-only reminder to the prompt on parse-retry.
   */
  fn: (attempt: number) => Promise<T>;

  /** Cooperative abort. Re-checked between attempts AND honored if the
   *  caller's fn() throws an AbortError, which is then surfaced immediately
   *  (no retry). */
  abortSignal?: AbortSignal;

  /**
   * Optional caller-side classifier for "parse-like" recoverable errors.
   * The default treats only `RetriableParseError` instances as parse-retryable.
   * Callers like streaming.ts that have their own parse-error type
   * (ChapterGenParseError) pass a predicate so their error is recognized.
   */
  isParseError?: (err: unknown) => boolean;

  /** Operation name for log context. Optional. */
  operationName?: string;
}

/**
 * Caller-friendly parse-error class. Throw this from your fn() body when
 * JSON-parse or schema-validation fails AND you want a single retry with
 * a stricter prompt addendum (attempt index becomes 1 on the retry).
 */
export class RetriableParseError extends Error {
  public readonly rawText: string | undefined;
  constructor(message: string, rawText?: string) {
    super(message);
    this.name = 'RetriableParseError';
    this.rawText = rawText;
  }
}

/**
 * Run fn() under the standard OpenAI retry policy.
 *
 *   - HTTP 429   → consume from RETRY_BACKOFF_MS.rateLimit (jittered)
 *   - HTTP 5xx   → consume from RETRY_BACKOFF_MS.serverError
 *   - Parse err  → consume from RETRY_BACKOFF_MS.parseError
 *   - 4xx other  → throw immediately (non-retryable)
 *   - Network    → throw immediately (the underlying SDK already retried
 *                  inside its connect timeout; further retries here would
 *                  just compound the wait)
 *   - Abort      → throw immediately
 *
 * Returns whatever fn() returned on the first successful attempt.
 * Throws the LAST error class if all retries exhaust.
 */
export async function withRetry<T>(args: WithRetryArgs<T>): Promise<T> {
  const { fn, abortSignal, isParseError, operationName } = args;
  let lastError: unknown = null;
  const max = maxAttempts();
  for (let attempt = 0; attempt < max; attempt++) {
    // Pre-attempt abort check: a disconnect during sleep should NOT spend
    // a retry slot on the next attempt.
    if (abortSignal?.aborted) {
      throw abortError(abortSignal);
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      // Abort propagated from caller (e.g., the SDK's fetch was canceled).
      // Surface immediately; do NOT retry — retrying a user-canceled
      // request just delays the abort feedback.
      if (isAbortError(err) || abortSignal?.aborted) {
        throw err;
      }
      const isParse = err instanceof RetriableParseError || (isParseError?.(err) ?? false);
      const delay = computeRetryDelay(err, attempt, isParse);
      if (delay === null) {
        // Either non-retryable (4xx other than 429, network, etc.) or out
        // of retries for this class — surface the underlying error.
        throw err;
      }
      // eslint-disable-next-line no-console
      if (operationName) {
        console.warn(
          `[openai-retry] ${operationName} attempt ${attempt + 1} failed; retrying in ${Math.round(delay)}ms`,
        );
      }
      await sleep(delay, abortSignal);
    }
  }
  // Loop fell through. computeRetryDelay caps the budget so this branch
  // should be unreachable, but TypeScript wants the unreachable arm.
  throw lastError ?? new Error(`${operationName ?? 'operation'}: exhausted retries`);
}

// ───────────────────────────────────────────────────────────────────────────
// Internal classifier
// ───────────────────────────────────────────────────────────────────────────

/**
 * Returns the backoff delay (ms) to wait before the next attempt, or null
 * if the error is non-retryable / retries for that class are exhausted.
 *
 * The `attempt` index is SHARED across classes — see RETRY_BACKOFF_MS docstring.
 */
export function computeRetryDelay(err: unknown, attempt: number, isParseError: boolean): number | null {
  if (isParseError) {
    const slot = RETRY_BACKOFF_MS.parseError[Math.min(attempt, RETRY_BACKOFF_MS.parseError.length - 1)];
    return slot ?? null;
  }
  const status = extractStatus(err);
  if (status === 429) {
    const base = RETRY_BACKOFF_MS.rateLimit[Math.min(attempt, RETRY_BACKOFF_MS.rateLimit.length - 1)];
    return base === undefined ? null : jitter(base);
  }
  if (status !== null && status >= 500 && status < 600) {
    const base = RETRY_BACKOFF_MS.serverError[Math.min(attempt, RETRY_BACKOFF_MS.serverError.length - 1)];
    return base ?? null;
  }
  return null;
}

/** Best-effort HTTP-status extraction. The OpenAI SDK throws errors with a
 *  numeric `.status`; underlying fetch failures don't. We treat absent status
 *  as non-retryable (returns null). */
function extractStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return null;
}

/** ±25% jitter. Math.random is fine here — not security-sensitive, and
 *  the goal is decorrelation across concurrent clients. */
function jitter(baseMs: number): number {
  const variance = baseMs * 0.25;
  return Math.max(0, baseMs + (Math.random() * 2 - 1) * variance);
}

// ───────────────────────────────────────────────────────────────────────────
// Abort plumbing — shared so callers don't reimplement
// ───────────────────────────────────────────────────────────────────────────

export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ERR_ABORTED';
}

export function abortError(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const err = new Error('operation aborted by caller');
  err.name = 'AbortError';
  return err;
}

/** Sleep that respects AbortSignal. Resolves on timeout or rejects on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
