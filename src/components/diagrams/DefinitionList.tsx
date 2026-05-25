// src/components/diagrams/DefinitionList.tsx — Sprint F.1 primitive.
//
// Renders a list of term/definition pairs as a semantic <dl> with
// alternating <dt>/<dd>. Pure HTML; server-component safe.
//
// Why <dl>:
// ---------
// HTML5 definition lists are the correct semantic for term-definition
// pairs. Screen readers announce them with "list of N items" and
// "definition for term X is Y" cues that custom structures lose. See
// `kb:web-dev/react-essentials §"Anti-patterns"` — favor semantic HTML
// over div-soup with ARIA when a native element exists.
//
// Brand styling:
// --------------
// Reuses @layer utilities. The `term` is rendered in display font for
// visual prominence; the `definition` in serif body. `text-citation` is
// reserved for source provenance (per Sprint C Phase 1 design); we use
// `text-ink` here.

import React from 'react';
import type { DefinitionListPayload } from '@/lib/diagrams/schema';

export function DefinitionList({ payload }: { payload: DefinitionListPayload }) {
  const { title, items } = payload;
  return (
    <figure className="my-stanza">
      {title ? (
        <figcaption className="mb-2 font-display text-caption text-ink-muted">
          {title}
        </figcaption>
      ) : null}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 font-serif text-body text-ink">
        {items.map((item, idx) => (
          // We render each pair as a fragment so the underlying <dl>
          // contains the flat <dt>/<dd> sequence semantic.
          <DefinitionListItem key={`${item.term}-${idx}`} term={item.term} definition={item.definition} />
        ))}
      </dl>
    </figure>
  );
}

function DefinitionListItem({ term, definition }: { term: string; definition: string }) {
  return (
    <>
      <dt className="font-display font-semibold text-ink">{term}</dt>
      <dd className="text-ink">{definition}</dd>
    </>
  );
}
