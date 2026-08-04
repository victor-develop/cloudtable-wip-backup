# CloudTable Identity/Reactive Reconciliation - CLO-2002

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2002
Parent: CLO-2001 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted.

CLO-2002 reconciled the repo and active goal state after CLO-2000. The current
source/test delta remains the same workflow recipe authoring/create/publish lane
already documented by CLO-2000. It strengthens the identity/reactive workflow
goal, but does not expose a new missing vertical slice that should be delegated
from this checkpoint.

## Current Code State

Tracked source/test diff is still limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`

The current delta covers:

- `WorkflowRecipeAuthoringCatalog` for `direct_sync` and `grouped_rollup`
- fixed `field_changed` recipe triggers
- `single_relation` and `value_match` match strategy metadata
- recipe catalog ingress at `/v1/workspaces/{workspaceId}/workflow-recipes`
- recipe preview ingress at `/v1/tables/{tableId}/workflow-recipes/preview`
- recipe create ingress at `/v1/tables/{tableId}/workflow-recipes`
- grouped rollup create/publish coverage with aggregate operation metadata
- direct sync create/readback coverage through workflow recipe ingress
- backfill/recompute maintenance metadata for sync and aggregate routes
- command/idempotency propagation for recipe create/publish execution

## Goal State

The active goal issue query showed CLO-2002 plus older blocked driver/checkpoint
residue. It did not show a new live post-CLO-2000 identity/reactive
implementation lane that needs CTO routing.

Goal coverage remains:

- Google login, auth session, workspace selection, and identity linkage are
  represented in runtime identity ingress.
- Organization/workspace invitation and membership readback are represented in
  runtime identity and workspace-control ingress.
- Declarative cross-table sync is represented by `direct_sync`,
  `sync_related_field`, preview/create ingress, and direct sync readback
  coverage.
- Rolling computed columns are represented by `grouped_rollup`, computed rollup
  field config, aggregate operation metadata, and registry-backed
  preview/create/publish coverage.
- Extensible rolling operations remain represented by the aggregate registry:
  `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- Batch initialize/backfill remains explicit in recipe maintenance metadata and
  existing aggregate/sync maintenance routes.

## Verification

Passed:

```bash
npm run typecheck
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|reactive rollup workflow proposals|direct sync workflow proposals"
```

Results:

- TypeScript: `tsc --noEmit` passed.
- Focused workflow authoring/runtime ingress tests: 2 files passed, 4 tests
  passed, 170 skipped.

## Route

Close CLO-2002 as done. Do not create another identity/reactive implementation
continuation for the already covered workflow recipe authoring/create/publish
scope. The next useful work should be outside this reconciliation loop, such as
product/UI integration, remote deployment validation, or a broader platform
driver if separately prioritized.
