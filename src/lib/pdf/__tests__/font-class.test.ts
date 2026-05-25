// src/lib/pdf/__tests__/font-class.test.ts — PR-B font classifier tests.
//
// Coverage:
//   - isMonospaceFontFamily — substring matching across known + unknown
//     family names + null/undefined safety
//   - getMonospaceThreshold — env override + clamping
//   - computeMonospaceRatio — char-weighted ratio + whitespace skipping
//   - classifyParagraphKind — threshold gate end-to-end

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isMonospaceFontFamily,
  getMonospaceThreshold,
  computeMonospaceRatio,
  classifyParagraphKind,
  DEFAULT_MONOSPACE_THRESHOLD,
  KNOWN_MONOSPACE_SUBSTRINGS,
} from '../font-class';

// ---------------------------------------------------------------------------
// isMonospaceFontFamily
// ---------------------------------------------------------------------------

describe('isMonospaceFontFamily', () => {
  it('matches the canonical Courier family', () => {
    expect(isMonospaceFontFamily('Courier')).toBe(true);
    expect(isMonospaceFontFamily('CourierNew')).toBe(true);
    expect(isMonospaceFontFamily('Courier-Bold')).toBe(true);
    expect(isMonospaceFontFamily('CourierNewPSMT')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isMonospaceFontFamily('COURIER')).toBe(true);
    expect(isMonospaceFontFamily('courier')).toBe(true);
    expect(isMonospaceFontFamily('Courier')).toBe(true);
  });

  it('matches JetBrains Mono with and without space', () => {
    expect(isMonospaceFontFamily('JetBrainsMono-Regular')).toBe(true);
    expect(isMonospaceFontFamily('JetBrains Mono Bold')).toBe(true);
  });

  it('matches popular code fonts', () => {
    const families = [
      'Consolas',
      'Monaco',
      'Menlo',
      'Source Code Pro',
      'SourceCodePro-Regular',
      'Fira Code',
      'FiraCode-Medium',
      'Inconsolata',
      'DejaVu Sans Mono',
      'Liberation Mono',
      'Ubuntu Mono',
      'Roboto Mono',
      'Iosevka',
      'Lucida Console',
      'Hack-Regular',
    ];
    for (const f of families) {
      expect(isMonospaceFontFamily(f), `expected ${f} to classify as monospace`).toBe(true);
    }
  });

  it('matches the LaTeX typewriter family (cmtt) but NOT the serif family (cmr)', () => {
    // cmtt10 is the standard LaTeX monospace at 10pt.
    expect(isMonospaceFontFamily('cmtt10')).toBe(true);
    expect(isMonospaceFontFamily('CMTT12')).toBe(true);
    // cmr10 is the Computer Modern Roman SERIF font — must NOT classify.
    // Caveat: the KNOWN_MONOSPACE_SUBSTRINGS list includes 'cmr10' itself
    // as a defensive listing — this test guards against future regressions
    // where someone might add a too-broad 'cmr' substring.
    expect(isMonospaceFontFamily('CMR9')).toBe(false);
    expect(isMonospaceFontFamily('cmr12')).toBe(false);
  });

  it('returns false for typical prose fonts', () => {
    const fonts = [
      'Times New Roman',
      'TimesNewRomanPSMT',
      'Newsreader',
      'Source Serif 4',
      'Helvetica',
      'Arial',
      'Georgia',
      'Garamond',
      'Calibri',
      'Verdana',
    ];
    for (const f of fonts) {
      expect(isMonospaceFontFamily(f), `expected ${f} to classify as prose`).toBe(false);
    }
  });

  it('handles null / undefined / empty input safely', () => {
    expect(isMonospaceFontFamily(null)).toBe(false);
    expect(isMonospaceFontFamily(undefined)).toBe(false);
    expect(isMonospaceFontFamily('')).toBe(false);
  });

  it('matches the generic "monospace" CSS keyword (defensive)', () => {
    expect(isMonospaceFontFamily('monospace')).toBe(true);
    expect(isMonospaceFontFamily('MONOSPACE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getMonospaceThreshold — env override
// ---------------------------------------------------------------------------

describe('getMonospaceThreshold', () => {
  const original = process.env.FONT_CLASS_THRESHOLD;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.FONT_CLASS_THRESHOLD;
    } else {
      process.env.FONT_CLASS_THRESHOLD = original;
    }
  });

  it('defaults to 0.6 with no env override', () => {
    delete process.env.FONT_CLASS_THRESHOLD;
    expect(getMonospaceThreshold()).toBe(DEFAULT_MONOSPACE_THRESHOLD);
    expect(getMonospaceThreshold()).toBe(0.6);
  });

  it('honors a valid env override in [0, 1]', () => {
    process.env.FONT_CLASS_THRESHOLD = '0.75';
    expect(getMonospaceThreshold()).toBe(0.75);
    process.env.FONT_CLASS_THRESHOLD = '0';
    expect(getMonospaceThreshold()).toBe(0);
    process.env.FONT_CLASS_THRESHOLD = '1';
    expect(getMonospaceThreshold()).toBe(1);
  });

  it('clamps values below 0 / above 1', () => {
    process.env.FONT_CLASS_THRESHOLD = '-0.5';
    expect(getMonospaceThreshold()).toBe(0);
    process.env.FONT_CLASS_THRESHOLD = '2';
    expect(getMonospaceThreshold()).toBe(1);
  });

  it('falls back to default on non-finite input', () => {
    process.env.FONT_CLASS_THRESHOLD = 'banana';
    expect(getMonospaceThreshold()).toBe(DEFAULT_MONOSPACE_THRESHOLD);
    process.env.FONT_CLASS_THRESHOLD = 'NaN';
    expect(getMonospaceThreshold()).toBe(DEFAULT_MONOSPACE_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// computeMonospaceRatio
// ---------------------------------------------------------------------------

describe('computeMonospaceRatio', () => {
  it('returns 1.0 for all-monospace items', () => {
    const items = [
      { str: 'class Foo {', isMonospace: true },
      { str: '  return 42;', isMonospace: true },
      { str: '}', isMonospace: true },
    ];
    expect(computeMonospaceRatio(items)).toBe(1);
  });

  it('returns 0.0 for all-prose items', () => {
    const items = [
      { str: 'Hello world', isMonospace: false },
      { str: 'This is prose', isMonospace: false },
    ];
    expect(computeMonospaceRatio(items)).toBe(0);
  });

  it('weights by character count, not item count', () => {
    // One short mono item (3 chars) vs one long prose item (30 chars).
    // Item-count ratio would be 0.5; char-count ratio is 3/33 ≈ 0.09.
    const items = [
      { str: 'foo', isMonospace: true },
      { str: 'this is a much longer prose item', isMonospace: false },
    ];
    const ratio = computeMonospaceRatio(items);
    expect(ratio).toBeGreaterThan(0.08);
    expect(ratio).toBeLessThan(0.10);
  });

  it('skips whitespace-only items in both numerator and denominator', () => {
    const items = [
      { str: 'class Foo {', isMonospace: true }, // 11 chars
      { str: '   ', isMonospace: false },        // skipped
      { str: '\n\n', isMonospace: false },       // skipped
      { str: '}', isMonospace: true },           // 1 char
    ];
    // 12 / 12 = 1.0 (all non-whitespace was monospace)
    expect(computeMonospaceRatio(items)).toBe(1);
  });

  it('returns 0 for empty or whitespace-only input', () => {
    expect(computeMonospaceRatio([])).toBe(0);
    expect(computeMonospaceRatio([{ str: '   ', isMonospace: true }])).toBe(0);
    expect(computeMonospaceRatio([{ str: '\n\t ', isMonospace: false }])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyParagraphKind — threshold gate
// ---------------------------------------------------------------------------

describe('classifyParagraphKind', () => {
  beforeEach(() => {
    delete process.env.FONT_CLASS_THRESHOLD;
  });

  it("classifies pure monospace listing as 'code'", () => {
    const items = [
      { str: 'def fibonacci(n):', isMonospace: true },
      { str: '    if n < 2:', isMonospace: true },
      { str: '        return n', isMonospace: true },
      { str: '    return fibonacci(n-1) + fibonacci(n-2)', isMonospace: true },
    ];
    expect(classifyParagraphKind(items)).toBe('code');
  });

  it("classifies pure prose as 'prose'", () => {
    const items = [
      { str: 'The fibonacci sequence is defined recursively.', isMonospace: false },
      { str: 'Each number is the sum of the two preceding ones.', isMonospace: false },
    ];
    expect(classifyParagraphKind(items)).toBe('prose');
  });

  it("classifies prose with inline monospace identifiers as 'prose'", () => {
    // Realistic case: a prose paragraph mentioning `someVar` and
    // `Object.method()`. The mono chars should be << 60% of the total.
    const items = [
      { str: 'Iterating over the array involves calling ', isMonospace: false }, // 44
      { str: 'forEach', isMonospace: true },                                       // 7
      { str: ' on the ', isMonospace: false },                                     // 8
      { str: 'arr', isMonospace: true },                                           // 3
      { str: ' variable.', isMonospace: false },                                   // 10
    ];
    // mono = 10 / total = 72 → 0.14, well below 0.6
    expect(classifyParagraphKind(items)).toBe('prose');
  });

  it("classifies code with a small comment in prose font as 'code'", () => {
    // Realistic case: code listing where pdfjs labeled the comment with
    // a different font. mono should still dominate.
    const items = [
      { str: 'function foo() {', isMonospace: true },        // 16
      { str: '// inline note', isMonospace: false },         // 14
      { str: '  return bar();', isMonospace: true },         // 15
      { str: '}', isMonospace: true },                       // 1
    ];
    // mono = 32 / total = 46 → 0.70, above 0.6
    expect(classifyParagraphKind(items)).toBe('code');
  });

  it('respects explicit threshold parameter', () => {
    const items = [
      { str: 'half mono', isMonospace: true },   // 9 chars
      { str: 'half prose', isMonospace: false }, // 10 chars
    ];
    // ratio = 9 / 19 ≈ 0.47
    expect(classifyParagraphKind(items, 0.4)).toBe('code');
    expect(classifyParagraphKind(items, 0.6)).toBe('prose');
  });

  it('honors threshold-boundary equality as code', () => {
    // ratio exactly 0.5 with threshold 0.5 should be 'code' (>= comparison)
    const items = [
      { str: '12345', isMonospace: true },
      { str: '12345', isMonospace: false },
    ];
    expect(classifyParagraphKind(items, 0.5)).toBe('code');
  });

  it("returns 'prose' on degenerate input (fail-open)", () => {
    expect(classifyParagraphKind([])).toBe('prose');
    expect(classifyParagraphKind([{ str: '   ', isMonospace: true }])).toBe('prose');
  });
});

// ---------------------------------------------------------------------------
// Sanity guard on the substrings list itself
// ---------------------------------------------------------------------------

describe('KNOWN_MONOSPACE_SUBSTRINGS', () => {
  it('contains lowercase-only entries', () => {
    for (const entry of KNOWN_MONOSPACE_SUBSTRINGS) {
      expect(entry, `entry "${entry}" must be lowercase`).toBe(entry.toLowerCase());
    }
  });

  it('has no empty / whitespace-only entries', () => {
    for (const entry of KNOWN_MONOSPACE_SUBSTRINGS) {
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });
});
