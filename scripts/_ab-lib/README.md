# `scripts/_ab-lib/`

The design (`docs/eval/HARNESS-DESIGN.md` §"File layout") specifies that
the harness's pure library code lives under this directory. In practice
we put the canonical implementations under `src/lib/eval/*` so they
satisfy the project's `src/**/*.test.ts` glob in `vitest.config.ts` and
participate in the same TypeScript path-alias rules as the rest of the
app.

The four files here are **re-export shims** that preserve the
design-doc-published import paths. Treat `src/lib/eval/*` as the source
of truth; touch shims only when adding a new module to the surface.

| Shim | Re-exports | Source of truth |
|---|---|---|
| `rubric.ts` | rubric schema + parser | `src/lib/eval/rubric.ts` |
| `variant.ts` | manifest schema + apply/revert | `src/lib/eval/variant.ts` |
| `persona.ts` | persona load + LLM rater | `src/lib/eval/persona.ts` |
| `report.ts` | report renderer | `src/lib/eval/report.ts` |
