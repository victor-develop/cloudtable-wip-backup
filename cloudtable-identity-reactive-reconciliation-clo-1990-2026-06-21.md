# CloudTable Identity/Reactive Reconciliation - CLO-1990

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-1990
Parent: CLO-1989 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted.

CLO-1990 is a reconciliation checkpoint against the active CloudTable goal:
multi-tenant identity and declarative reactive data workflows. Live issue state
shows CLO-1990 as the only current active reconciliation child under the goal,
with the immediately prior reconciliation issues through CLO-1988 already done.
The current repo state is still the same bounded workflow recipe
authoring/create/publish lane, and it covers the identity/reactive capability
surface that the driver asked to re-check.

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
- command/idempotency propagation for agent tool recipe execution

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

Live issue query for the active goal shows:

- CLO-1990 is the only active reconciliation child under the current driver.
- CLO-1988, CLO-1986, CLO-1984, and earlier recent reconciliation issues are
  done and reached the same no-new-work conclusion.
- No fresh active implementation lane appeared after CLO-1988.

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

Close CLO-1990 as done. Recommended action for CEO/CTO: do not open another
identity/reactive implementation continuation for the already covered workflow
recipe authoring/create/publish scope. The next useful work should be outside
this checkpoint loop, such as product/UI integration or remote deployment
validation, only if separately prioritized.
