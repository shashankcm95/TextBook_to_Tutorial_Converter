# Example A/B run config

A reference variant manifest you can copy to start a real run. See
`docs/eval/HARNESS-DESIGN.md` §"Phase 1 — Text-only A/B harness" for the
full schema.

Sample invocation:

```bash
pnpm eval:run \
  --run-id my-first-eval \
  --variants docs/eval/runs/example/variants/main.json \
  --personas professor,student,domain-expert,author-kleppmann \
  --chapters 0-5
```

For a dry-run that exercises the I/O layer without burning tokens:

```bash
EVAL_DRY_RUN=1 pnpm eval:run \
  --run-id dry-run \
  --variants docs/eval/runs/example/variants/main.json \
  --personas professor \
  --narratives-from fs \
  --narratives-dir _ab-runs/<prior-run>/narratives
```
