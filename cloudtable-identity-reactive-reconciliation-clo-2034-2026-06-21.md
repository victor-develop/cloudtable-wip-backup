# CloudTable Identity/Reactive Reconciliation - CLO-2034

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2034
Parent: CLO-2033 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted.

CLO-2034 reconciled the current repo and active Paperclip goal tree after the
latest completed CLO-2030/CLO-2032 checkpoints. The material source/test state
is still the known five-file workflow recipe authoring/create/publish lane.
Creating another implementation child now would duplicate completed
identity/reactive workflow coverage rather than advance a new bounded gap.

## Current Code State

Tracked source/test diff remains limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`

The current delta still covers:

- workflow recipe authoring metadata for `direct_sync` and `grouped_rollup`
- fixed `field_changed` recipe triggers
- `single_relation` and `value_match` match strategy metadata
- registry-backed aggregate operation metadata for grouped rollups
- recipe catalog ingress at `/v1/workspaces/{workspaceId}/workflow-recipes`
- recipe preview ingress at `/v1/tables/{tableId}/workflow-recipes/preview`
- recipe create ingress at `/v1/tables/{tableId}/workflow-recipes`
- direct sync and grouped rollup create/publish/readback coverage
- backfill/recompute maintenance metadata and maintenance ingress for sync and aggregate routes
- command/idempotency propagation for recipe create/publish execution

## Live Issue State

The active goal tree for `Identity and reactive data workflows` shows the
current routine lane as:

- CLO-2033: blocked parent driver, blocker coverage points at CLO-2034
- CLO-2034: current in-progress reconciliation child under CLO-2033

Recent CTO reconciliation checkpoints CLO-2030 and CLO-2032 are done and both
closed with no successor implementation child. No separate active bounded
implementation issue appears in the goal state after CLO-2030 that should
replace this disposition.

## Required Use Cases

- Google login: represented by `/v1/auth/google/login` and
  `/v1/auth/google/callback` ingress in `src/runtime/worker.ts`.
- Invited users across organizations/workspaces: represented by workspace
  invitation and membership ingress plus membership readback/session-switch
  coverage in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
- Declarative cross-table sync on field change: represented by `direct_sync`,
  `sync_related_field`, fixed `field_changed` recipes, recipe preview/create
  ingress, and direct sync proposal/readback coverage.
- Grouped rolling computed columns with extensible operations: represented by
  `grouped_rollup`, computed rollup field configuration, registry-backed
  aggregate operation metadata, and grouped rollup proposal/create/publish
  coverage.
- Batch initialize/backfill support for reactive computations: represented by
  recipe maintenance metadata for `backfill` and `recompute`, plus sync and
  aggregate maintenance ingress routes.

## Verification

Passed:

```bash
npm run typecheck
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|reactive rollup workflow proposals|direct sync workflow proposals|multi-membership|Google OAuth|invited users"
```

Results:

- TypeScript: `tsc --noEmit` passed.
- Focused workflow authoring/runtime ingress tests: 2 files passed, 5 tests
  passed, 169 skipped.

## Route

Close CLO-2034 as done. Do not create a new identity/reactive implementation
child from this checkpoint. There is no named blocker from this reconciliation.
