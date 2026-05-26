// tests/playwright/diagrams.spec.ts — Sprint F.2 SVG primitive snapshot tests.
//
// What this spec asserts:
// -----------------------
// For each (primitive × fixture-name) pair declared in
// `src/lib/diagrams/__fixtures__/gallery.ts`:
//   1. The dev-only route `/diagram-gallery/<kind>?fixture=<name>` renders.
//   2. An <svg> element becomes visible.
//   3. A screenshot of the gallery container matches the checked-in
//      baseline `<kind>-<fixture>.png` within `maxDiffPixels: 100`.
//
// Why container-screenshot (not page-screenshot):
// -----------------------------------------------
// Page-screenshots include browser chrome differences (scrollbar widths,
// font fallbacks for nav elements that don't render here, etc.). Capturing
// only the `[data-testid="diagram-gallery-container"]` element pins the
// snapshot to the primitive itself. Per RFC §"Where snapshots live":
// one rendering substrate, one variable under test.
//
// First-run note:
// ---------------
// `playwright test` fails on the first run when no baseline exists,
// emitting `<name>-actual.png` next to the missing baseline. The intended
// first invocation is:
//
//   pnpm test:playwright --update-snapshots
//
// which writes the initial baseline. Subsequent runs compare against it.

import { test, expect } from '@playwright/test';
import {
  galleryFixtures,
  type GalleryKind,
  type GalleryFixtureName,
} from '../../src/lib/diagrams/__fixtures__/gallery';

const KINDS: readonly GalleryKind[] = [
  'DiagramFlow',
  'StateTransitionDiagram',
  'SequenceDiagram',
  'DecisionTree',
];

const FIXTURE_NAMES: readonly GalleryFixtureName[] = [
  'minimal',
  'max-size',
  'edge-case',
];

for (const kind of KINDS) {
  test.describe(kind, () => {
    for (const fixture of FIXTURE_NAMES) {
      test(`renders ${fixture} fixture and matches snapshot`, async ({ page }) => {
        // Confirm the fixture catalog actually has the entry — guards
        // against accidental fixture removal that would otherwise yield
        // a less actionable Playwright failure ("page didn't render").
        expect(galleryFixtures[kind][fixture]).toBeDefined();

        await page.goto(`/diagram-gallery/${kind}?fixture=${fixture}`);

        // Wait for the gallery container + its inner SVG before screenshotting.
        const container = page.locator('[data-testid="diagram-gallery-container"]');
        await expect(container).toBeVisible();
        const svg = container.locator('svg').first();
        await expect(svg).toBeVisible();

        // Snapshot the container (not the page) so we don't capture page
        // chrome / nav / viewport differences.
        await expect(container).toHaveScreenshot(`${kind}-${fixture}.png`);
      });
    }
  });
}
