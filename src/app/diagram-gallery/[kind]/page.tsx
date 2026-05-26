// src/app/diagram-gallery/[kind]/page.tsx — dev-only Playwright host route.
//
// Sole purpose:
// -------------
// Render a single F.2 SVG primitive at `/diagram-gallery/<kind>?fixture=<name>`
// so the Playwright snapshot suite (`tests/playwright/diagrams.spec.ts`)
// can `page.goto(...)` and screenshot it.
//
// Hard gate:
// ----------
// `process.env.NODE_ENV === 'development'` only. Production builds hit
// `notFound()` immediately. The route does NOT use Next.js's underscore-
// prefixed "private folder" convention (`_diagram-gallery`) because that
// convention OPTS OUT of routing entirely — the route would 404 in dev
// too. Instead the folder is named normally and the production gate is
// the explicit `NODE_ENV !== 'development'` check inside this file.
//
// Why a real Next.js route (vs. @playwright/experimental-ct-react):
// ----------------------------------------------------------------
// Per RFC §"How the test renders the component": Component-test mode
// pulls in `vite` as a side-effect, clashing with our `vitest.config.ts`
// + `tailwind.config.ts` locks. A real page rendered by `next dev` runs
// the actual production styling pipeline (Tailwind purge, globals.css
// brand tokens) so snapshots represent what production users would see.
//
// Why no <main> wrapper / no surrounding chrome:
// ----------------------------------------------
// The snapshot must capture ONLY the primitive's <svg>, not the page
// chrome — otherwise screenshots would drift when site nav changes. We
// render the primitive bare inside a fixed-width container so layout
// math (which scales fluidly to container width via width="100%") gets
// a deterministic input.

import { notFound } from 'next/navigation';
import {
  galleryFixtures,
  type GalleryKind,
  type GalleryFixtureName,
} from '@/lib/diagrams/__fixtures__/gallery';
import DiagramFlow from '@/components/diagrams/DiagramFlow';
import StateTransitionDiagram from '@/components/diagrams/StateTransitionDiagram';
import SequenceDiagram from '@/components/diagrams/SequenceDiagram';
import DecisionTree from '@/components/diagrams/DecisionTree';

// The valid kinds the route accepts. Mismatch → notFound().
const VALID_KINDS: readonly GalleryKind[] = [
  'DiagramFlow',
  'StateTransitionDiagram',
  'SequenceDiagram',
  'DecisionTree',
] as const;

// Valid fixture names per primitive (same triple per RFC §"Where snapshots live").
const VALID_FIXTURES: readonly GalleryFixtureName[] = [
  'minimal',
  'max-size',
  'edge-case',
] as const;

function isValidKind(k: string): k is GalleryKind {
  return (VALID_KINDS as readonly string[]).includes(k);
}

function isValidFixtureName(n: string): n is GalleryFixtureName {
  return (VALID_FIXTURES as readonly string[]).includes(n);
}

export default function DiagramGalleryPage({
  params,
  searchParams,
}: {
  params: { kind: string };
  searchParams: { fixture?: string };
}) {
  // 1. Hard production gate — the route does not exist outside development.
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  // 2. Validate URL params.
  const { kind } = params;
  if (!isValidKind(kind)) {
    notFound();
  }
  const fixtureName = searchParams.fixture ?? 'minimal';
  if (!isValidFixtureName(fixtureName)) {
    notFound();
  }

  // 3. Pluck the payload + render via the matching primitive.
  //    `payload.kind` is the discriminant; we use a switch on the URL `kind`
  //    so TypeScript narrows each branch to the correct payload type.
  const fixtureGroup = galleryFixtures[kind];
  const payload = fixtureGroup[fixtureName];
  if (!payload) {
    notFound();
  }

  // Fixed container width gives the SVG's fluid width="100%" a deterministic
  // basis for layout math; snapshots stay stable across viewports.
  return (
    <div
      data-testid="diagram-gallery-container"
      style={{
        width: 960,
        padding: 24,
        background: 'white',
      }}
    >
      {payload.kind === 'DiagramFlow' ? <DiagramFlow payload={payload} /> : null}
      {payload.kind === 'StateTransitionDiagram' ? (
        <StateTransitionDiagram payload={payload} />
      ) : null}
      {payload.kind === 'SequenceDiagram' ? (
        <SequenceDiagram payload={payload} />
      ) : null}
      {payload.kind === 'DecisionTree' ? <DecisionTree payload={payload} /> : null}
    </div>
  );
}
