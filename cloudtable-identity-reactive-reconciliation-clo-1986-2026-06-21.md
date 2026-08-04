# CloudTable Identity/Reactive Reconciliation - CLO-1986

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-1986
Parent: CLO-1985 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted after CLO-1984.

CLO-1986 is a checkpoint, not an implementation task. The active Paperclip
goal tree still shows this issue as the current in-progress child under the
latest driver for the `Identity and reactive data workflows` goal. The recent
CLO-1976/CLO-1970/CLO-1968 reconciliation memos already reached the same
conclusion after inspecting the workflow recipe authoring/create/publish lane:
the live repo evidence supports closing the checkpoint rather than opening a
duplicate identity/reactive implementation child.

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
- grouped rollup create/publish coverage with aggregate registry operations
- direct sync create/readback coverage through command-bus machinery
- backfill/recompute maintenance metadata for sync and aggregate routes

## Goal Coverage

- Google login, auth session, and workspace selection remain represented in
  runtime identity ingress.
- Organization/workspace invitation and membership readback remain represented
  in runtime identity and workspace-control ingress.
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

Close CLO-1986 as done. Canonical disposition: explicit no-new-work evidence
and verification. Do not create another identity/reactive implementation
continuation for already reconciled workflow recipe authoring/create/publish
scope.
