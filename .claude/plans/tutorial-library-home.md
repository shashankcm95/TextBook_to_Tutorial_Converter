# Plan — tutorial library home page

**Branch**: `feat/tutorial-library-home`
**Drives**: replace the current `/` (generation-focused hero) with a library of the user's existing tutorials, with a button that opens a modal to add a new tutorial from an S3 URL.
**Authored**: 2026-05-27
**Discovery credit**: spawned-agent dossier (sandbox-blocked from writing; produced the design read).

## Problem

Today the home page (`src/app/page.tsx`) is single-purpose: paste S3 URL → generate. To open an existing tutorial the user must remember the URL `/tutorials/{uuid}`. For a single-user app with a growing personal bookshelf, that's friction. The user explicitly asked: "I'd like to flag I need some sort of status bar showing all available books instead of having to generate again and again using home page link."

## Approach

Replace the hero on `/` with a library page that lists every tutorial owned by the current session. "Add tutorial from S3 URL" moves behind a single button that opens a native `<dialog>` modal containing the existing ingest form. No new dependencies; no parallel API.

### Data shape

Existing tables suffice (no migration):
- `tutorials` — has `book_title`, `book_author`, `metadata_source`, `status`, `max_unlocked_chapter_idx`, `created_at`, `total_chapters`, `error_message`, `source_s3_url`.
- `chapters` — has `viewed_at` (riley HIGH-2 absorb) → derive `lastViewedAt = MAX(chapters.viewed_at)` per tutorial. Same for `completeChapters = COUNT(*) FILTER (status='complete')`.

One query, one round trip — Drizzle's `sql` template for the aggregates.

### Sheet/modal mechanism

Native `<dialog>` element via `dialogRef.current?.showModal()`. Browser handles: focus trap, ESC dismissal, `inert` rest-of-page, `::backdrop` styling. Avoids a 5KB Radix Dialog dep when this is the app's only modal. If a second modal ever lands, promote to `@radix-ui/react-dialog` then.

### Refactor strategy for the existing form

`HomeIngestForm` is a Client island doing CSRF + POST + push. The sheet should not re-implement it. Add a single optional prop `onSuccess?: () => void` that fires just before `router.push`. The sheet passes `() => setOpen(false)` so the modal closes during the navigation. Zero re-architecture.

## Files touched

| Status | Path | Purpose |
|---|---|---|
| NEW | `.claude/plans/tutorial-library-home.md` | this file |
| NEW | `src/lib/library.ts` | `loadLibrary(userId)`, `computeAggregateStatus()`, `validateS3UrlShape()`, types |
| NEW | `src/lib/__tests__/library.test.ts` | unit tests for the 3 pure helpers + sort + S3 URL shape |
| NEW | `src/components/TutorialCard.tsx` | Server Component for one library row, link-wrapped |
| NEW | `src/components/library/AddTutorialSheet.tsx` | Client island: button + `<dialog>` wrapping `<HomeIngestForm>` |
| NEW | `src/components/__tests__/TutorialCard.render.test.tsx` | jsdom render-without-crash + status badge per state |
| MODIFIED | `src/app/page.tsx` | Server Component: session → loadLibrary → grid OR empty-state |
| MODIFIED | `src/app/HomeIngestForm.tsx` | add `onSuccess?: () => void` prop; fire before push |

LOC estimate: ~400 across 8 files. (Plan file is ~150 lines on its own; impl ~250.)

## Hard constraints honored

- `drizzle/migrations/`, `src/lib/generation/`, `src/lib/ingest/`, `src/lib/citations/`, `src/lib/scoring/` — untouched.
- `src/app/api/ingest/route.ts` — untouched. Reused as-is.
- `src/app/tutorials/[id]/page.tsx` + `StreamingClient.tsx` — untouched. Library links INTO them.
- `src/middleware.ts` — untouched.
- No new UI library; design tokens from `tailwind.config.ts` + `globals.css`.

## Verification

1. **TDD**: `library.test.ts` first, covering computeAggregateStatus (5 status mappings including the partial-completion branch) + validateS3UrlShape (8 cases: too short / too long / wrong scheme / missing key / valid / trailing slash / empty / whitespace) + sort comparator (most-recently-viewed-first with createdAt tiebreak).
2. **Unit**: `pnpm test` — adds ~12 tests; expect 651+.
3. **Type**: this branch must not introduce new `tsc --noEmit` errors beyond the 10 pre-existing ones on main (parse.kind.test.ts, parse.ts, s3.ts, srs/leitner.ts).
4. **Manual** (deferred — requires dev server + `.env`): fresh-session `/` → empty state → click "Add tutorial" → sheet opens → paste URL → 202 → sheet closes → redirect to `/tutorials/{id}` → back to `/` → row visible.

## Drift notes

- Almost tempted to add a `tutorials.last_viewed_at` column at the table level rather than deriving from chapters. Resisted because it'd require a migration on a personal-use app + a write path that doesn't exist today. The MAX-aggregate is one SQL line; the migration would be five.
- Almost added Radix Dialog. Resisted because `<dialog>` is good enough for one modal and dep-thinness has been the project's discipline (see Sprint-Bv2 colophon — "no Radix Dialog in deps" is intentional).
- The agent's plan suggested DIY focus-trap. The native `<dialog>.showModal()` API does this for free — using it instead.

## Risks

- **`<dialog>` cross-browser**: Chrome/Edge/Safari/Firefox all support `showModal()` since 2022. No fallback path needed for a personal-use app on modern browsers.
- **CSRF cookie present at first paint**: `HomeIngestForm` reads `document.cookie` on submit. The middleware sets `__csrf` on every GET. If the user opens the sheet within the same session, the cookie is already there. Edge case — first-ever visit's submit may race the cookie-set if React 18 SSR is unusually fast; the existing form already handles `null` cookie with a clear error message. Inherited.
- **Race on aggregate query**: `MAX(viewed_at)` reads from `chapters` table while writes can be concurrent. SQLite serializes; worst case is a stale value by one tick. Acceptable for "sort by last viewed."

## What's deferred (in plan, NOT this PR)

- **Per-tutorial quality chip** (fidelity score average) — requires joining `chapter_fidelity_scores`; out of scope for the library access pattern. The `/admin/runs` page (separate followup) will own gate diagnostics.
- **Delete tutorial** — cascade-delete UX decision (cost telemetry preservation?).
- **Search / filter** — first iteration is straight chronological list; revisit if N > 30 tutorials.
- **"Continue reading" deep-link to `/tutorials/{id}#chapter-N`** — current tutorial page already restores scroll. Light version: card subtext says "Chapter N+ unlocked" when `maxUnlockedChapterIdx > 0`.
