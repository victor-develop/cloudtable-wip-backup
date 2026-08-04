# CloudTable Identity/Reactive Reconciliation - CLO-2030

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2030
Parent: CLO-2029 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted.

CLO-2030 reconciled the current repo and live Paperclip state after CLO-2028.
No material source/test delta appeared after the CLO-2028 checkpoint. The only
tracked code change remains the workflow recipe authoring/create/publish lane
already documented by CLO-2028.

## Current Code State

Tracked source/test diff remains limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`

`git diff --stat` for those files reports:

```text
src/core/workflows/authoring.ts                    | 110 ++++++-
src/core/workflows/types.ts                        |  35 +++
src/runtime/worker.ts                              | 335 +++++++++++++++++++++
testing/cloudtable/suites/runtime/ingress.spec.ts  | 226 ++++++++------
.../cloudtable/suites/workflows/authoring.spec.ts  |  90 +++++-
5 files changed, 702 insertions(+), 94 deletions(-)
```

The current delta still covers:

- workflow recipe authoring metadata for `direct_sync` and `grouped_rollup`
- fixed `field_changed` recipe triggers
- `single_relation` and `value_match` match strategy metadata
- recipe catalog ingress at `/v1/workspaces/{workspaceId}/workflow-recipes`
- recipe preview ingress at `/v1/tables/{tableId}/workflow-recipes/preview`
- recipe create ingress at `/v1/tables/{tableId}/workflow-recipes`
- grouped rollup create/publish coverage with aggregate operation metadata
- direct sync create/readback coverage through workflow recipe ingress
- backfill/recompute maintenance metadata for sync and aggregate routes
- command/idempotency propagation for recipe create/publish execution

## Live Issue State

The current Paperclip state shows:

- CLO-2030 has no child issues.
- CLO-2030 currently blocks CLO-2029, the active parent driver.
- Querying active issues for the `Identity and reactive data workflows` goal
  shows CLO-2030 as the current active reconciliation under CLO-2029; there is
  no separate active child under CLO-2029 that should be treated as the next
  canonical implementation slice.

## Required Use Cases

- Google login: represented by `/v1/auth/google/login` and callback ingress in
  `src/runtime/worker.ts`, preserving the prior identity groundwork.
- Invited users across multiple organizations and organization workspaces:
  represented by workspace invitation and membership ingress in
  `src/runtime/worker.ts`, plus workspace-control membership readback.
- Declarative cross-table sync on field change: represented by `direct_sync`,
  `sync_related_field`, fixed `field_changed` recipes, and direct sync
  preview/create/readback coverage.
- Grouped rolling computed columns with extensible operations: represented by
  `grouped_rollup`, computed rollup field configuration, registry-backed
  aggregate operation metadata, and preview/create/publish coverage.
- Batch initialize/backfill support for reactive computations: represented by
  recipe maintenance metadata for `backfill` and `recompute`, and existing
  sync/aggregate maintenance routes.

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

Close CLO-2030 as done. Do not create a new identity/reactive implementation
child from this checkpoint. There is no named blocker from this reconciliation.
