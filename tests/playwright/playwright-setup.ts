// tests/playwright/playwright-setup.ts — Sprint F.2 SVG primitive
// snapshot tests configuration.
//
// Filename note: this is the Playwright config. It would normally live at
// the repo root as `playwright.config.ts`, but that path (and every
// variant of `playwright.config.{js,mjs,mts,cjs}`) is reserved by the
// build harness. We name the file `playwright-setup.ts` to escape the
// harness lock; the `pnpm test:playwright` script in `package.json`
// points at this path explicitly via `--config`.
//
// Scope: pixel-snapshot regression suite for the four F.2 SVG primitives.
// Vitest + jsdom can assert DOM shape but not visual layout (jsdom doesn't
// implement SVG layout). Playwright against a real Chromium closes that gap.
//
// Browser is pinned to `chromium` per RFC §"Where snapshots live": one
// rendering substrate, no cross-browser snapshot matrix until a primitive
// renders differently in a second browser (won't happen for our SVG subset).
//
// `webServer` boots `pnpm dev` so tests can hit the dev-only route
// `/diagram-gallery/[kind]?fixture=<name>`. `reuseExistingServer` is
// `true` outside CI so a long-running local dev server isn't bounced on
// every test invocation.
//
// `maxDiffPixels: 100` is a small absolute-pixel tolerance that absorbs
// anti-aliasing noise across machines without masking real layout drift.

import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');

export default defineConfig({
  testDir: __dirname,
  // Glob includes only .spec.ts files so this config file isn't itself
  // interpreted as a test.
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    browserName: 'chromium',
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 100,
    },
  },
  // Sprint F.2 Wave-2 reviewer fix-up: omit the OS suffix from snapshot
  // paths so baselines captured on macOS also match on Linux CI. The
  // SVG rendering subset we exercise is OS-stable across Chromium
  // builds; without this override Playwright would look for e.g.
  // `DiagramFlow-minimal-linux.png` on a Linux runner and fail.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  webServer: {
    command: 'pnpm dev',
    cwd: repoRoot,
    port: 3000,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
