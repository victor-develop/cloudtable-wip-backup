# CloudTable Identity/Reactive Reconciliation - CLO-1921

Date: 2026-06-20
Goal: Identity and reactive data workflows
Issue: CLO-1921
Parent: CLO-1920 CloudTable 15-minute project driver

## CTO Assessment

No new bounded implementation, QA, product, or design child is warranted from
this checkpoint.

The current CloudTable code/workspace state remains materially unchanged from
the CLO-1919 checkpoint. The tracked source/test diff is still the workflow
recipe authoring/catalog plus runtime recipe preview ingress slice for direct
sync and grouped rollup recipes.

## Current Code State

Tracked source/test diff remains limited to:

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

The diff continues to expose:

- workflow recipe authoring catalog metadata for `direct_sync` and
  `grouped_rollup`
- `field_changed` as the fixed trigger for both recipe types
- `single_relation` and `value_match` matching strategies
- recipe preview ingress at `/v1/tables/{tableId}/workflow-recipes/preview`
- maintenance routes for sync and aggregate backfill/recompute
- aggregate operations `count_records`, `sum_numbers`, `max_number`, and
  `average_numbers`

## Goal Coverage

- Google identity linkage, sessions, and workspace hydration remain represented
  by the existing runtime identity ingress coverage.
- Organization/workspace invitation and membership selection remain represented
  by the existing invited-member and workspace readback coverage.
- Declarative cross-table sync remains represented by the `direct_sync` recipe,
  `sync_related_field`, and sync maintenance route metadata.
- Grouped rolling computed columns remain represented by the `grouped_rollup`
  recipe, aggregate operation manifests, and aggregate maintenance route
  metadata.
- Extensible operations remain represented by the aggregate operation registry.
- Batch initialize/backfill remains explicit through `backfill` and `recompute`
  maintenance kinds in recipe metadata.

## Active Goal Tree

The current parent driver is CLO-1920 and is blocked only by this checkpoint,
CLO-1921. I found no new active implementation, QA, product, or design lane
after CLO-1919 that changes the identity/reactive workflow capability picture.

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

Close CLO-1921 as done and unblock CLO-1920. Do not create a duplicate
identity/reactive implementation child from this checkpoint. The next useful
work remains landing or reviewing the existing workflow recipe authoring diff,
or selecting a broader CloudTable product/platform priority outside this
reconciliation loop.
