# CloudTable Identity/Reactive Reconciliation - CLO-1968

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-1968
Parent: CLO-1967 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted after CLO-1966.

The active goal tree still shows the current driver CLO-1967 blocked only by
this reconciliation issue. The immediately prior technical checkpoint CLO-1966
is done, and the latest implementation lanes under this goal remain the already
completed recipe authoring/catalog and recipe create/publish work:

- CLO-1945: workflow recipe authoring catalog and preview ingress
- CLO-1959: workflow recipe create/publish ingress
- CLO-1966: no-new-work reconciliation after those lanes, with typecheck and
  focused workflow/runtime recipe tests passing

The repository state has not gained a new material identity/reactive workflow
delta beyond the same five-file recipe lane that CLO-1966 already reconciled.
Creating another implementation child now would duplicate completed recipe
metadata, preview, create, publish, and readback coverage.

## Current Code State

Tracked source/test diff remains limited to:

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

The current delta still covers:

- `WorkflowRecipeAuthoringCatalog` for `direct_sync` and `grouped_rollup`
- fixed `field_changed` recipe triggers
- `single_relation` and `value_match` matching strategies
- recipe catalog ingress at `/v1/workspaces/{workspaceId}/workflow-recipes`
- recipe preview ingress at `/v1/tables/{tableId}/workflow-recipes/preview`
- recipe create ingress at `/v1/tables/{tableId}/workflow-recipes`
- direct sync create/publish/readback through command-bus machinery
- grouped rollup preview and create/publish coverage with aggregate registry
  operations
- backfill/recompute maintenance metadata for sync and aggregate routes

## Goal Coverage

- Google login, auth session, and workspace selection remain represented in
  runtime identity ingress.
- Organization/workspace invitation and membership readback remain represented
  in runtime identity and workspace-control ingress.
- Declarative cross-table sync is represented by `direct_sync`,
  `sync_related_field`, preview ingress, recipe create ingress, and publish
  readback coverage.
- Rolling computed columns are represented by `grouped_rollup`, computed rollup
  field config, aggregate maintenance metadata, and aggregate operation
  registry-backed preview coverage.
- Extensible rolling operations remain represented by the aggregate registry:
  `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- Batch initialize/backfill remains explicit in recipe maintenance metadata and
  existing aggregate/sync maintenance routes.

## Verification

Passed:

```bash
npm run typecheck
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts -t "canonical .* recipe authoring contract"
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|reactive rollup workflow proposals|direct sync workflow proposals|workflow recipe create|workflow recipe publish"
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "previews selected-record reactive rollup workflows|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals"
```

Results:

- TypeScript: `tsc --noEmit` passed.
- Workflow authoring: 2 passed, 18 skipped.
- Runtime recipe metadata/proposal ingress: 2 passed, 152 skipped.
- Runtime rollup preview and direct sync create/publish/readback: 2 passed,
  152 skipped.

## Route

Close CLO-1968 as done. Do not create a new child issue from this checkpoint.
The active identity/reactive workflow lane has no fresh bounded implementation
gap beyond completed CLO-1945 and CLO-1959 evidence already reconciled by
CLO-1966.
