// src/lib/__tests__/streaming-slots.test.ts
//
// Tests for the shared stream-slot tracker (DRIFT-test3-033). The slot
// mechanism is the only per-user concurrency bound on the streaming
// endpoints — a regression here is a real DoS / cost-overrun hazard.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  tryAcquireSlot,
  releaseSlot,
  getSlotCount,
  _resetSlotsForTesting,
  MAX_CONCURRENT_STREAMS_PER_USER,
} from '../streaming-slots';

beforeEach(() => {
  _resetSlotsForTesting();
});

describe('tryAcquireSlot', () => {
  it('grants the first slot to a fresh user', () => {
    expect(tryAcquireSlot('user-a')).toBe(true);
    expect(getSlotCount('user-a')).toBe(1);
  });

  it('grants up to MAX_CONCURRENT_STREAMS_PER_USER slots', () => {
    for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_USER; i++) {
      expect(tryAcquireSlot('user-a')).toBe(true);
    }
    expect(getSlotCount('user-a')).toBe(MAX_CONCURRENT_STREAMS_PER_USER);
  });

  it('rejects the (MAX+1)th acquire', () => {
    for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_USER; i++) {
      tryAcquireSlot('user-a');
    }
    expect(tryAcquireSlot('user-a')).toBe(false);
    // Count must NOT have incremented past the cap on rejection
    expect(getSlotCount('user-a')).toBe(MAX_CONCURRENT_STREAMS_PER_USER);
  });

  it('isolates users — one user maxing out does not block another', () => {
    for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_USER; i++) {
      tryAcquireSlot('user-a');
    }
    expect(tryAcquireSlot('user-a')).toBe(false);
    // Fresh user starts at 0 and gets their full quota
    expect(tryAcquireSlot('user-b')).toBe(true);
    expect(getSlotCount('user-b')).toBe(1);
  });
});

describe('releaseSlot', () => {
  it('decrements the count by one', () => {
    tryAcquireSlot('user-a');
    tryAcquireSlot('user-a');
    expect(getSlotCount('user-a')).toBe(2);
    releaseSlot('user-a');
    expect(getSlotCount('user-a')).toBe(1);
  });

  it('deletes the map entry when count hits zero (bounded memory)', () => {
    tryAcquireSlot('user-a');
    releaseSlot('user-a');
    // Count read is 0 (default for missing key)
    expect(getSlotCount('user-a')).toBe(0);
    // After release, the next acquire still works (fresh state)
    expect(tryAcquireSlot('user-a')).toBe(true);
  });

  it('is idempotent — releasing an already-zero count does not throw or go negative', () => {
    expect(() => releaseSlot('nobody')).not.toThrow();
    expect(getSlotCount('nobody')).toBe(0);
  });

  it('allows re-acquisition after release', () => {
    // Saturate, release one, re-acquire
    for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_USER; i++) {
      tryAcquireSlot('user-a');
    }
    expect(tryAcquireSlot('user-a')).toBe(false); // saturated
    releaseSlot('user-a');
    expect(tryAcquireSlot('user-a')).toBe(true); // slot freed
  });
});

describe('acquire/release lifecycle pairing', () => {
  it('a complete acquire-release cycle leaves no residual state', () => {
    expect(tryAcquireSlot('user-a')).toBe(true);
    expect(tryAcquireSlot('user-a')).toBe(true);
    releaseSlot('user-a');
    releaseSlot('user-a');
    expect(getSlotCount('user-a')).toBe(0);
    // And the entry is gone (bounded-memory invariant)
    expect(tryAcquireSlot('user-a')).toBe(true); // fresh again
  });
});
