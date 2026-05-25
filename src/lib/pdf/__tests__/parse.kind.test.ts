// src/lib/pdf/__tests__/parse.kind.test.ts — PR-B parse.ts integration tests.
//
// extractPageFromContent is the pure variant of extractPage that accepts the
// pdfjs items+styles shape directly (no pdfDoc.getPage() side effect). We
// use it here to feed synthetic pdfjs-shaped fixtures into the parser and
// assert that paragraph.kind is populated correctly end-to-end.
//
// Why a separate file: src/lib/pdf/__tests__/font-class.test.ts covers the
// classifier in isolation; this file proves the *plumbing* — that
// styles[fontName].fontFamily is correctly resolved per item and that
// kind flows through all three paragraph-extraction strategies.

import { describe, it, expect } from 'vitest';
import { extractPageFromContent } from '../parse';

// pdfjs-dist's TextItem shape (subset relevant to PR-B):
//   { str: string, hasEOL: boolean, fontName: string, ... }
// and styles is { [fontName]: { fontFamily: string, ... } }

describe('extractPageFromContent — PR-B paragraph kind', () => {
  it('emits kind="code" for every line of a monospace code listing', () => {
    // groupParagraphsByEOL behavior: each `hasEOL: true` with non-empty
    // content following a previous EOL becomes its own paragraph. For a
    // multi-line code block, pdfjs emits one item per line with hasEOL=true,
    // so each code line becomes one paragraph. The kind classifier marks
    // each as 'code' based on its own font ratio.
    const items = [
      { str: 'class Node {', fontName: 'F_mono', hasEOL: true },
      { str: '    int data;', fontName: 'F_mono', hasEOL: true },
      { str: '    Node next;', fontName: 'F_mono', hasEOL: true },
      { str: '}', fontName: 'F_mono', hasEOL: true },
      { str: 'Some prose follows.', fontName: 'F_serif', hasEOL: true },
      { str: 'This is the second sentence.', fontName: 'F_serif', hasEOL: true },
    ];
    const styles = {
      F_mono: { fontFamily: 'CourierNewPSMT' },
      F_serif: { fontFamily: 'TimesNewRomanPSMT' },
    };
    const result = extractPageFromContent(42, items, styles);
    expect(result.pageNumber).toBe(42);
    // 4 mono lines + 2 prose lines = 6 paragraphs by the existing grouping
    expect(result.paragraphs.length).toBe(6);
    // First four are code (all-monospace lines)
    expect(result.paragraphs.slice(0, 4).every((p) => p.kind === 'code')).toBe(true);
    // Last two are prose (all-serif lines)
    expect(result.paragraphs.slice(4).every((p) => p.kind === 'prose')).toBe(true);
    expect(result.paragraphs[0].text).toContain('class Node');
    expect(result.paragraphs[4].text).toContain('prose follows');
  });

  it("emits kind='prose' for a paragraph with inline monospace identifiers", () => {
    // Prose mentioning `arr.forEach` — the mono chars should be << 60%.
    const items = [
      { str: 'Iterating over the array involves calling ', fontName: 'F_serif', hasEOL: false },
      { str: 'forEach', fontName: 'F_mono', hasEOL: false },
      { str: ' on the ', fontName: 'F_serif', hasEOL: false },
      { str: 'arr', fontName: 'F_mono', hasEOL: false },
      { str: ' variable.', fontName: 'F_serif', hasEOL: true },
    ];
    const styles = {
      F_mono: { fontFamily: 'Consolas' },
      F_serif: { fontFamily: 'Garamond' },
    };
    const result = extractPageFromContent(1, items, styles);
    // Only one paragraph (single EOL at the end; no double-EOL break).
    // Strategy 1 needs >=2 paragraphs to fire, so we fall into Strategy 2
    // (rawText split on blank-line runs) → no blank lines → Strategy 3
    // (single paragraph for the page). Strategy 3 emits 'prose' fail-open,
    // which is the correct answer for inline-mono prose anyway.
    expect(result.paragraphs.length).toBe(1);
    expect(result.paragraphs[0].kind).toBe('prose');
  });

  it('handles missing styles entry by defaulting to non-monospace (fail-open)', () => {
    const items = [
      { str: 'Just some text.', fontName: 'F_ghost', hasEOL: true },
      { str: 'More text on a new line.', fontName: 'F_ghost', hasEOL: true },
      { str: 'Third line of text.', fontName: 'F_ghost', hasEOL: true },
    ];
    // styles map has no entry for F_ghost.
    const styles = {};
    const result = extractPageFromContent(7, items, styles);
    // Each hasEOL-true line becomes its own paragraph.
    expect(result.paragraphs.length).toBeGreaterThanOrEqual(2);
    for (const p of result.paragraphs) {
      expect(p.kind).toBe('prose');
    }
  });

  it('handles missing fontName on items by defaulting to non-monospace', () => {
    const items = [
      { str: 'Text without fontName', hasEOL: true },
      { str: 'Another line.', hasEOL: true },
      { str: 'Third line.', hasEOL: true },
    ];
    const result = extractPageFromContent(3, items, {});
    expect(result.paragraphs.length).toBeGreaterThanOrEqual(2);
    for (const p of result.paragraphs) {
      expect(p.kind).toBe('prose');
    }
  });

  it('Strategy 2 fallback (no EOL grouping) emits kind="prose"', () => {
    // No double-EOLs — Strategy 1 produces 0 paragraphs → fallback fires.
    // rawText has \n\n boundaries that Strategy 2 splits on.
    const items = [
      { str: 'First paragraph chunk.', fontName: 'F_mono', hasEOL: false },
      { str: '\n\n', fontName: 'F_mono', hasEOL: false },
      { str: 'Second paragraph chunk.', fontName: 'F_mono', hasEOL: false },
    ];
    const styles = { F_mono: { fontFamily: 'Courier' } };
    const result = extractPageFromContent(5, items, styles);
    expect(result.paragraphs.length).toBe(2);
    // Strategy 2 has no per-item font info → fail-open prose.
    for (const p of result.paragraphs) {
      expect(p.kind).toBe('prose');
    }
  });

  it('Strategy 3 last-resort emits kind="prose"', () => {
    // Single chunk, no EOLs at all — Strategy 3 wraps the whole page in
    // one paragraph. Fail-open prose.
    const items = [
      { str: 'Single line of degenerate text.', fontName: 'F_mono', hasEOL: false },
    ];
    const styles = { F_mono: { fontFamily: 'Monaco' } };
    const result = extractPageFromContent(9, items, styles);
    expect(result.paragraphs.length).toBe(1);
    expect(result.paragraphs[0].kind).toBe('prose');
    expect(result.paragraphs[0].text).toBe('Single line of degenerate text.');
  });

  it('empty page returns zero paragraphs', () => {
    const result = extractPageFromContent(99, [], {});
    expect(result.paragraphs).toEqual([]);
    expect(result.rawText).toBe('');
  });

  it('whitespace-only page returns zero paragraphs', () => {
    const items = [
      { str: '   ', fontName: 'F_serif', hasEOL: true },
      { str: '\t', fontName: 'F_serif', hasEOL: true },
    ];
    const result = extractPageFromContent(99, items, { F_serif: { fontFamily: 'Times' } });
    expect(result.paragraphs).toEqual([]);
  });

  it('mixed page: code lines + prose lines + code lines keep their own kinds', () => {
    // Real PDFs render each line with hasEOL=true, so the grouper emits one
    // paragraph per line. PR-B classifies each line on its own font ratio,
    // so code-font lines stay 'code' and prose-font lines stay 'prose'
    // even when interleaved.
    const items = [
      { str: 'function double(x) {', fontName: 'F_mono', hasEOL: true },
      { str: '  return x * 2;', fontName: 'F_mono', hasEOL: true },
      { str: '}', fontName: 'F_mono', hasEOL: true },
      { str: 'The function above demonstrates a pure', fontName: 'F_serif', hasEOL: true },
      { str: 'transformation with no side effects.', fontName: 'F_serif', hasEOL: true },
      { str: 'const result = double(21);', fontName: 'F_mono', hasEOL: true },
      { str: 'console.log(result);', fontName: 'F_mono', hasEOL: true },
    ];
    const styles = {
      F_mono: { fontFamily: 'FiraCode-Regular' },
      F_serif: { fontFamily: 'Newsreader' },
    };
    const result = extractPageFromContent(11, items, styles);
    // 7 paragraphs, one per line, kinds matching font.
    expect(result.paragraphs.length).toBe(7);
    const kinds = result.paragraphs.map((p) => p.kind);
    expect(kinds).toEqual(['code', 'code', 'code', 'prose', 'prose', 'code', 'code']);
  });

  it('paragraphIdx is 0-based and sequential', () => {
    const items = [
      { str: 'p0', fontName: 'F', hasEOL: true },
      { str: 'p1', fontName: 'F', hasEOL: true },
      { str: 'p2', fontName: 'F', hasEOL: true },
    ];
    const result = extractPageFromContent(2, items, { F: { fontFamily: 'Times' } });
    expect(result.paragraphs.map((p) => p.paragraphIdx)).toEqual([0, 1, 2]);
    // Text contains the source string (possibly with trailing space from EOL handling).
    expect(result.paragraphs[0].text.trim()).toBe('p0');
    expect(result.paragraphs[1].text.trim()).toBe('p1');
    expect(result.paragraphs[2].text.trim()).toBe('p2');
  });
});
