# CloudTable Identity/Reactive Reconciliation - CLO-2022

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2022
Parent: CLO-2021 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted.

CLO-2022 reconciled the repo and active goal state after CLO-2020. The current
source/test delta remains the same workflow recipe authoring/create/publish lane
already documented by CLO-2002 and earlier post-CLO-2020 checkpoints. Opening a
new implementation issue from this checkpoint would duplicate the existing
workflow recipe lane instead of advancing a newly discovered gap.

## Current Code State

Tracked source/test diff is still limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`

`git diff --stat` reports:

```text
src/core/workflows/authoring.ts                    | 110 ++++++-
src/core/workflows/types.ts                        |  35 +++
src/runtime/worker.ts                              | 335 +++++++++++++++++++++
testing/cloudtable/suites/runtime/ingress.spec.ts  | 226 ++++++++------
.../cloudtable/suites/workflows/authoring.spec.ts  |  90 +++++-
5 files changed, 702 insertions(+), 94 deletions(-)
```

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

## Goal And Issue State

The active goal query shows CLO-2022 as the current checkpoint, with CLO-2020 and
later reconciliation checkpoints completed. It did not show a new live
post-CLO-2020 identity/reactive implementation lane that needs CTO routing.

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

Close CLO-2022 as done. Do not create another identity/reactive implementation
continuation for the already covered workflow recipe authoring/create/publish
scope. The next useful work should be outside this reconciliation loop, such as
product/UI integration, remote deployment validation, or a broader platform
driver if separately prioritized.
