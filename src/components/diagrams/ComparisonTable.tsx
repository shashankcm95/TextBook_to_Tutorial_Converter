// src/components/diagrams/ComparisonTable.tsx — Sprint F.1 primitive.
//
// Renders a 2-N column comparison as a semantic <table> with <caption>,
// <thead>, and <tbody>. Pure HTML; no SVG geometry. Server-component
// safe (no DOM access, no hooks).
//
// Why semantic HTML (not a flexbox grid):
// ---------------------------------------
// Screen readers announce table structure (column headers, row positions)
// when the markup is a real <table>. A flexbox + ARIA imitation is
// strictly worse: more code, weaker semantics, hostile to keyboard
// table-navigation modes some AT supports.
//
// Per `kb:web-dev/react-essentials §"Server vs Client components"`
// (cited at src/app/tutorials/[id]/page.tsx:4): this component renders
// on the server in the RSC pass; no `'use client'` directive needed.
//
// Brand styling:
// --------------
// Uses the @layer utilities tokens from src/app/globals.css directly:
// bg-paper-deep, text-ink, text-ink-muted, border-paper-edge, font-serif,
// font-display. `my-stanza` is the existing utility ChapterRenderer uses
// for block-level spacing.

import React from 'react';
import type { ComparisonTablePayload } from '@/lib/diagrams/schema';

export function ComparisonTable({ payload }: { payload: ComparisonTablePayload }) {
  const { title, columns, rows } = payload;
  return (
    <figure className="my-stanza">
      {title ? (
        <figcaption className="mb-2 font-display text-caption text-ink-muted">
          {title}
        </figcaption>
      ) : null}
      <table
        className="w-full border-collapse border border-paper-edge font-serif text-body text-ink"
        role="table"
      >
        <thead>
          <tr className="bg-paper-deep">
            {columns.map((col) => (
              <th
                key={col}
                scope="col"
                className="border border-paper-edge px-3 py-2 text-left font-display text-caption text-ink"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr
              key={rowIdx}
              className={rowIdx % 2 === 0 ? 'bg-paper' : 'bg-paper-deep'}
            >
              {columns.map((col) => (
                <td
                  key={col}
                  className="border border-paper-edge px-3 py-2 align-top"
                >
                  {/* row is Record<string, string>; missing cells render as nbsp so
                      the table doesn't collapse a row visually. */}
                  {row[col] ?? ' '}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
