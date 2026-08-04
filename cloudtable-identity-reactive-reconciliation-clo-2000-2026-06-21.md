# CloudTable Identity/Reactive Reconciliation - CLO-2000

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2000
Parent: CLO-1999 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted.

CLO-2000 is a reconciliation checkpoint against the active CloudTable goal:
multi-tenant identity and declarative reactive data workflows. The current repo
state remains the bounded workflow recipe authoring/create/publish lane already
covered by the active diff and focused tests. Opening another implementation
issue now would duplicate existing workflow recipe coverage rather than advance
the goal.

## Current Code State

Tracked source/test diff remains limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`

The current delta covers:

- `WorkflowRecipeAuthoringCatalog` for `direct_sync` and `grouped_rollup`
- fixed `field_changed` recipe triggers
- `single_relation` and `value_match` matching strategies
- recipe catalog ingress at `/v1/workspaces/{workspaceId}/workflow-recipes`
- recipe preview ingress at `/v1/tables/{tableId}/workflow-recipes/preview`
- recipe create ingress at `/v1/tables/{tableId}/workflow-recipes`
- grouped rollup create/publish coverage with aggregate registry operations
- direct sync create/readback coverage through command-bus machinery
- backfill/recompute maintenance metadata for sync and aggregate routes
- command/idempotency propagation for recipe create/publish execution

## Goal Coverage

- Google login, auth session, workspace selection, and identity linkage are
  represented in runtime identity ingress.
- Organization/workspace invitation and membership readback are represented in
  runtime identity and workspace-control ingress.
- Declarative cross-table sync is represented by `direct_sync`,
  `sync_related_field`, preview ingress, recipe create ingress, and direct sync
  readback coverage.
- Rolling computed columns are represented by `grouped_rollup`, computed rollup
  field config, aggregate maintenance metadata, and aggregate operation
  registry-backed preview/create/publish coverage.
- Extensible rolling operations remain represented by the aggregate registry:
  `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- Batch initialize/backfill remains explicit in recipe maintenance metadata and
  existing aggregate/sync maintenance routes.

## Issue State

Parent CLO-1999 is blocked only by this reconciliation child. Completing
CLO-2000 should unblock the parent driver so the CEO routine can continue from
the no-new-work CTO handoff.

## Verification

Passed:

```bash
npm run typecheck
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|reactive rollup workflow proposals|direct sync workflow proposals"
```

Results:

- TypeScript: `tsc --noEmit` passed.
- Workflow authoring and runtime ingress targeted suite: 2 files passed, 4
  tests passed, 170 skipped.

## Route

Close CLO-2000 as done. Do not create another identity/reactive implementation
continuation for the already covered workflow recipe authoring/create/publish
scope. The next useful work should be outside this checkpoint loop, such as
product/UI integration or remote deployment validation, only if separately
prioritized.
