# CloudTable Platform Scaffold

This workspace now contains the first implementation foundation for the frozen CloudTable MVP v1 backend baseline.

The scaffold is intentionally narrow:

- Cloudflare-native Worker, Durable Object, Queue, D1, and R2 wiring exists.
- Core runtime boundaries are laid out for commands, event ledger, field types, permissions, workflows, views, and agent tools.
- The first D1 migration reserves the canonical and rebuildable table families from the approved skeleton spec.
- Deterministic testing directories and a runnable runtime smoke suite exist from the first commit.

## Baseline Sources

- `cloudtable-mvp-v1-contract-baseline.md`
- `cloudtable-mvp-adr-baseline.md`
- `cloudtable-data-plane-skeleton-spec.md`
- `cloudtable-workflow-runtime-and-permission-spec.md`
- `cloudtable-deterministic-regression-harness-rollout-plan.md`
- `cloudtable-product-contract.md`

## Project Layout

```text
src/
  core/
    agent-tools/
    commands/
    events/
    field-types/
    permissions/
    views/
    workflows/
  durable-objects/
  queues/
  runtime/
testing/cloudtable/
  docs/
  fixtures/
  harness/
  suites/
migrations/
```

## Local Commands

Install dependencies first:

```bash
npm install
```

Run local development:

```bash
npm run dev
```

Apply D1 migrations locally:

```bash
npm run d1:migrate:local
```

Run tests:

```bash
npm test
```

Run deterministic semantic suites explicitly:

```bash
npm run test:semantic
```

Run the named MVP regression matrix only:

```bash
npm run test:regression
```

Run the narrow Cloudflare adapter smoke path:

```bash
npm run test:nightly-cloudflare
```

For the real-account Cloudflare validation pass, use `testing/cloudtable/docs/cloudflare-remote-validation-runbook.md`.

Typecheck:

```bash
npm run typecheck
```

## Next Implementation Slices

- Replace placeholder handlers with real command ingress and read paths.
- Implement the D1 repository layer and transaction boundaries for event-first commits.
- Add text-first replay, workflow, and view fixture corpora as product semantics get implemented.
- Replace placeholder permission and workflow execution logic with real policy evaluation and transcript stages.

The current deterministic semantic matrix is tracked in `testing/cloudtable/docs/mvp-regression-matrix.md`.
