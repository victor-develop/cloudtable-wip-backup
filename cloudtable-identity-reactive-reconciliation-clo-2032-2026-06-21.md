# CloudTable Identity/Reactive Reconciliation - CLO-2032

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2032
Parent: CLO-2031 CloudTable 15-minute project driver

## CTO Assessment

No fresh bounded implementation child is warranted.

CLO-2032 rechecked the current repo, active goal issue state, and the latest
CLO-2030 checkpoint. There is no material technical delta after CLO-2030. The
tracked source/test diff remains the same five-file workflow recipe
authoring/create/publish lane, and the active goal tree still shows CLO-2032 as
the only live child under the current CLO-2031 driver.

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

The current repo state still covers:

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

Querying the active `Identity and reactive data workflows` goal for open states
shows the current driver and this reconciliation as the current live lane:

- CLO-2031: blocked parent driver, blocker coverage points at CLO-2032
- CLO-2032: in progress reconciliation child under CLO-2031

Older blocked routine/checkpoint issues remain in the goal history, but no fresh
open bounded implementation child appears after CLO-2030 that should become the
canonical next lane.

## Required Use Cases

- Google login: represented by `/v1/auth/google/login` and
  `/v1/auth/google/callback` ingress in `src/runtime/worker.ts`.
- Users invited into different organizations and organization workspaces:
  represented by workspace invitation and membership ingress plus membership
  readback/session-switch coverage in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
- Declarative cross-table sync on field change: represented by `direct_sync`,
  `sync_related_field`, fixed `field_changed` recipes, preview/create ingress,
  and direct sync proposal/readback coverage.
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

Close CLO-2032 as done. Do not create a new identity/reactive implementation
child from this checkpoint. There is no named blocker from this reconciliation.
