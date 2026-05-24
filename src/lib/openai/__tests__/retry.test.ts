// src/lib/openai/__tests__/retry.test.ts
//
// Tests for the shared OpenAI retry module (DRIFT-test3-032).
//
// The retry module is load-bearing: it's wrapped around every OpenAI call
// in the lazy-hybrid path + ingest classifier + glossary-extract + legacy
// streaming. A regression here silently degrades production reliability.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withRetry,
  computeRetryDelay,
  maxAttempts,
  RetriableParseError,
  RETRY_BACKOFF_MS,
} from '../_retry';

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** Build a fake openai-sdk-shaped error with a numeric .status. */
function httpError(status: number, message = `http ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function abortErr(): Error {
  const e = new Error('canceled');
  e.name = 'AbortError';
  return e;
}

// ───────────────────────────────────────────────────────────────────────────
// computeRetryDelay — the pure classifier
// ───────────────────────────────────────────────────────────────────────────

describe('computeRetryDelay — error classification', () => {
  it('returns rateLimit delay (jittered) for 429', () => {
    const delay = computeRetryDelay(httpError(429), 0, false);
    expect(delay).not.toBeNull();
    // base 1000, ±25% jitter → [750, 1250]
    expect(delay!).toBeGreaterThanOrEqual(750);
    expect(delay!).toBeLessThanOrEqual(1250);
  });

  it('returns serverError delay (no jitter) for 5xx', () => {
    const delay = computeRetryDelay(httpError(503), 0, false);
    expect(delay).toBe(10_000);
  });

  it('returns parseError delay for RetriableParseError', () => {
    // Note: computeRetryDelay takes the isParseError flag computed by the
    // caller; we exercise both paths via withRetry below.
    const delay = computeRetryDelay(new RetriableParseError('bad json'), 0, true);
    expect(delay).toBe(0);
  });

  it('returns null for 4xx other than 429 (non-retryable client error)', () => {
    expect(computeRetryDelay(httpError(400), 0, false)).toBeNull();
    expect(computeRetryDelay(httpError(401), 0, false)).toBeNull();
    expect(computeRetryDelay(httpError(403), 0, false)).toBeNull();
    expect(computeRetryDelay(httpError(404), 0, false)).toBeNull();
  });

  it('returns null for network errors (no .status field)', () => {
    expect(computeRetryDelay(new Error('ECONNRESET'), 0, false)).toBeNull();
  });

  it('exhausts 429 budget after rateLimit.length retries', () => {
    // attempt 0 → first slot; attempt rateLimit.length → past the end
    const last = computeRetryDelay(httpError(429), RETRY_BACKOFF_MS.rateLimit.length - 1, false);
    expect(last).not.toBeNull();
    // Math.min caps the index, so attempt = length returns the LAST slot
    // (jittered). The classifier intentionally doesn't return null here —
    // budget exhaustion is enforced by maxAttempts() at the loop level.
    const capped = computeRetryDelay(httpError(429), RETRY_BACKOFF_MS.rateLimit.length, false);
    expect(capped).not.toBeNull();
  });
});

describe('maxAttempts', () => {
  it('equals 1 initial + sum of all retry-budget slots', () => {
    const expected =
      1 +
      RETRY_BACKOFF_MS.rateLimit.length +
      RETRY_BACKOFF_MS.serverError.length +
      RETRY_BACKOFF_MS.parseError.length;
    expect(maxAttempts()).toBe(expected);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// withRetry — the loop
// ───────────────────────────────────────────────────────────────────────────

describe('withRetry — success path', () => {
  beforeEach(() => {
    // Speed up sleeps in tests — vi.useFakeTimers + advance manually OR
    // patch the module-internal sleep. For simplicity, we test with REAL
    // timers but use small backoffs (the rateLimit[0]=1s would slow this
    // suite). Instead, we ensure success paths never sleep.
  });

  it('returns the result on first attempt when fn resolves', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry({ fn });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(0); // attempt index 0
  });
});

describe('withRetry — retry classification', () => {
  it('retries a 429 then succeeds on the second attempt', async () => {
    // Override the rateLimit backoff to 0ms via fn that throws once.
    // Easier: just accept the ~1s sleep — vitest default timeout is 5s.
    const fn = vi
      .fn<[number], Promise<string>>()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce('ok');

    const result = await withRetry({ fn });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    // Second call should receive attempt=1
    expect(fn).toHaveBeenLastCalledWith(1);
  }, 10_000); // wider timeout: this test waits ~1s on the rateLimit[0] backoff

  it('throws 4xx-other immediately without retrying', async () => {
    const fn = vi.fn<[number], Promise<string>>().mockRejectedValue(httpError(400));
    await expect(withRetry({ fn })).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1); // NO retry
  });

  it('treats RetriableParseError as parse-retryable (1 retry)', async () => {
    const fn = vi
      .fn<[number], Promise<string>>()
      .mockRejectedValueOnce(new RetriableParseError('bad json'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry({ fn });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(1); // caller can read attempt to vary prompt
  });

  it('honors custom isParseError predicate', async () => {
    class MyParseError extends Error {
      constructor() {
        super('custom');
        this.name = 'MyParseError';
      }
    }
    const fn = vi
      .fn<[number], Promise<string>>()
      .mockRejectedValueOnce(new MyParseError())
      .mockResolvedValueOnce('ok');

    const result = await withRetry({ fn, isParseError: (err) => err instanceof MyParseError });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry — abort handling', () => {
  it('throws AbortError immediately when fn raises it (no retry)', async () => {
    const fn = vi.fn<[number], Promise<string>>().mockRejectedValue(abortErr());
    await expect(withRetry({ fn })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws AbortError immediately when abortSignal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn<[number], Promise<string>>().mockResolvedValue('ok');
    await expect(withRetry({ fn, abortSignal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    // fn was never called — pre-attempt abort check fires first
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not retry after the signal aborts mid-flight', async () => {
    const ac = new AbortController();
    const fn = vi
      .fn<[number], Promise<string>>()
      .mockImplementationOnce(async () => {
        // First attempt fails with 429 — would normally retry
        throw httpError(429);
      })
      .mockResolvedValueOnce('ok');

    const promise = withRetry({ fn, abortSignal: ac.signal });
    // Abort before the retry sleep completes
    setTimeout(() => ac.abort(), 50);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // fn called once (the initial 429); the retry sleep was aborted
    expect(fn).toHaveBeenCalledTimes(1);
  }, 5_000);
});
