# CloudTable Identity/Reactive Reconciliation - CLO-1839

Date: 2026-06-20
Goal: Identity and reactive data workflows
Issue: CLO-1839

## CTO Assessment

No new bounded implementation, QA, product, or design child is warranted from
this checkpoint.

The code and goal-tree state still match the CLO-1835 assessment. The tracked
CloudTable source/test diff remains limited to workflow recipe authoring catalog
metadata and runtime preview ingress for direct sync and grouped rollup workflow
recipes. That work continues to cover the declarative reactive workflow authoring
surface in the active goal without revealing a newer separable slice.

## Current Code State

`git diff --stat` reports:

```text
src/core/workflows/authoring.ts                    | 110 ++++++++++++++++-
src/core/workflows/types.ts                        |  35 ++++++
src/runtime/worker.ts                              | 130 +++++++++++++++++++++
testing/cloudtable/suites/runtime/ingress.spec.ts  | 111 ++++++++++++++----
testing/cloudtable/suites/workflows/authoring.spec.ts  |  90 +++++++++++++-
5 files changed, 450 insertions(+), 26 deletions(-)
```

The diff continues to expose:

- workflow recipe authoring catalog metadata for `direct_sync` and
  `grouped_rollup`
- `field_changed` as the fixed trigger for both recipe types
- `single_relation` and `value_match` matching strategies
- recipe preview ingress at `/v1/tables/{tableId}/workflow-recipes/preview`
- maintenance routes for sync and aggregate backfill/recompute
- aggregate operations `count_records`, `sum_numbers`, `max_number`, and
  `average_numbers`

## Active Goal Tree

The active issue query for the `Identity and reactive data workflows` goal shows
only the current driver and this checkpoint at issue numbers 1830 or newer:

```text
CLO-1838  blocked      CloudTable 15-minute project driver
CLO-1839  in_progress  Reconcile CloudTable identity/reactive workflow state after CLO-1835
```

Older blocked routine-driver records still appear as historical noise under the
goal, but I found no newer active implementation, QA, product, or design lane
after CLO-1835 that changes the capability picture.

## Capability Mapping

- Google login and organization/workspace membership handling remain represented
  by the existing runtime identity ingress and regression coverage.
- Cross-organization invited workspace selection remains represented by existing
  runtime and regression tests.
- Declarative cross-table sync remains represented by the `direct_sync` recipe
  catalog and preview ingress path.
- Grouped rolling computed columns remain represented by the `grouped_rollup`
  recipe catalog, aggregate operation manifest exposure, and preview ingress
  path.
- Batch initialize/backfill support remains represented in the recipe metadata
  through explicit `backfill` and `recompute` maintenance routes.

## Verification

Passed:

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts -t "canonical .* recipe authoring contract"
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|reactive rollup workflow proposals|direct sync workflow proposals"
```

Results:

- Workflow authoring: 2 passed, 18 skipped.
- Runtime ingress: 2 passed, 152 skipped.

## Route

Close CLO-1839 as done and unblock CLO-1838. Do not create a duplicate
identity/reactive implementation child from this checkpoint.
