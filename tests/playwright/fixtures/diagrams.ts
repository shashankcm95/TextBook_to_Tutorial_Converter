// tests/playwright/fixtures/diagrams.ts — RFC-mandated location for the
// Sprint F.2 snapshot fixtures.
//
// The actual catalog lives under `src/lib/diagrams/__fixtures__/gallery.ts`
// because the dev-only gallery page (a Next.js route) must import the
// fixtures via the `@/` alias, and `tests/` is outside `tsconfig.include`.
// This file re-exports from there so future readers who follow the RFC
// breadcrumb (§"Where snapshots live") still find the fixtures.

export {
  galleryFixtures as fixtures,
  type GalleryKind,
  type GalleryFixtureName,
} from '../../../src/lib/diagrams/__fixtures__/gallery';
