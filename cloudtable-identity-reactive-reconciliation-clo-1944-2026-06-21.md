# CloudTable Identity/Reactive Reconciliation - CLO-1944

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-1944
Parent: CLO-1943 CloudTable 15-minute project driver

## CTO Assessment

Create one backend follow-up to land or review the existing workflow recipe
authoring vertical slice. The slice is already present in the current worktree,
is bounded, and directly maps to the active identity/reactive workflow goal.

This is not a request for a new architecture lane. The missing action is to turn
the current unlanded source/test delta into a reviewed implementation issue with
clear closure criteria.

## Current Code State

The tracked source/test delta is still limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`

`git diff --stat` reports:

```text
src/core/workflows/authoring.ts                    | 110 ++++++++++++++++-
src/core/workflows/types.ts                        |  35 ++++++
src/runtime/worker.ts                              | 130 +++++++++++++++++++++
testing/cloudtable/suites/runtime/ingress.spec.ts  | 111 ++++++++++++++----
.../cloudtable/suites/workflows/authoring.spec.ts  |  90 +++++++++++++-
5 files changed, 450 insertions(+), 26 deletions(-)
```

The current delta exposes:

- `WorkflowRecipeAuthoringCatalog` for `direct_sync` and `grouped_rollup`
- fixed `field_changed` triggers for both recipe types
- `single_relation` and `value_match` matching strategies
- authoring metadata for `backfill` and `recompute` maintenance
- `/v1/workspaces/{workspaceId}/workflow-recipes` catalog ingress
- `/v1/tables/{tableId}/workflow-recipes/preview` preview ingress
- direct sync preview via `sync_related_field`
- grouped rollup preview via `set_cell` and registry-backed aggregate operations

## Goal Coverage

- Google login, auth session, and workspace selection are already represented in
  runtime identity ingress.
- Organization/workspace invitations and membership readback are already
  represented in runtime identity and workspace-control ingress.
- Declarative cross-table sync is represented by `direct_sync`, the
  `sync_related_field` workflow action, and sync maintenance metadata.
- Rolling computed columns are represented by `grouped_rollup`, computed
  rollup field config, aggregate maintenance metadata, and the aggregate
  operation registry.
- Extensible rolling operations are represented by the aggregate registry:
  `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- Batch initialize/backfill is explicit in recipe maintenance metadata and the
  existing aggregate/sync maintenance routes.

## Risk

The main risk is process, not design: the capability exists as a coherent
unlanded delta but has no active backend implementation issue under the current
CLO-1943/CLO-1944 branch. Leaving only another recommendation would keep the
goal in a reconciliation loop.

The implementation risk is moderate and bounded. The touched surface is a
metadata/catalog and preview-ingress addition, and the focused verification
passes today.

## Verification

Passed:

```bash
npm run typecheck
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts -t "canonical .* recipe authoring contract"
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|reactive rollup workflow proposals|direct sync workflow proposals"
```

Results:

- TypeScript: `tsc --noEmit` passed.
- Workflow authoring: 2 passed, 18 skipped.
- Runtime ingress: 2 passed, 152 skipped.

## Route

Create a Backend Architect follow-up linked to CLO-1943 and this goal:

`Land CloudTable workflow recipe authoring catalog and preview ingress`

Scope:

- review and land the current five-file source/test delta
- preserve prior row-owner and extensible-condition groundwork
- avoid field-type proposal-hint parity unless it directly blocks the slice
- verify with `npm run typecheck`, targeted authoring/runtime tests, and
  `npm run test:smoke` before closing

CLO-1944 can close after creating that child issue and attaching this
reconciliation artifact.
