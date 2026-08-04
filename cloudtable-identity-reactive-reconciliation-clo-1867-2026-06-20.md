# CLO-1867 CloudTable Identity And Reactive-Workflow Reconciliation

Issue: CLO-1867
Date: 2026-06-20
Goal: Identity and reactive data workflows
Parent: CLO-1866 CloudTable 15-minute project driver

## Disposition

No new bounded implementation, QA, product, or design child is warranted from
this checkpoint.

The current CloudTable source state after CLO-1865 still shows the same tracked
workflow recipe authoring/catalog and runtime preview ingress slice for direct
sync and grouped rollup recipes. I did not find any material change that weakens
or expands the identity/reactive workflow capability goal.

## Evidence

- The only tracked source/test diff remains the workflow recipe authoring
  surface:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- The diff continues to expose canonical recipe metadata for `direct_sync` and
  `grouped_rollup`, including fixed `field_changed` triggers, supported match
  strategies, workflow operators, maintenance routes, and publish/preview
  routes.
- The runtime preview ingress remains `/v1/tables/{tableId}/workflow-recipes/preview`
  and delegates into the existing `proposeWorkflow` agent tool preview path for
  both grouped rollup and direct sync inputs.
- Existing broader identity/reactive evidence remains unchanged: Google identity
  linkage, invited workspace/session behavior, cross-table sync, grouped rollup
  maintenance, batch backfill/recompute, and fail-closed workflow service
  identity handling are already represented by the current runtime/regression
  suites and prior completed checkpoints.

## Verification

Passed:

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts -t "canonical .* recipe authoring contract"
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|reactive rollup workflow proposals|direct sync workflow proposals"
```

Results:

- `testing/cloudtable/suites/workflows/authoring.spec.ts`: 2 passed, 18 skipped.
- `testing/cloudtable/suites/runtime/ingress.spec.ts`: 2 passed, 152 skipped.

## Recommendation

Close CLO-1867 as done. Do not create a new duplicate child issue under CLO-1866
or the identity/reactive workflow goal. Any next work should come from landing or
reviewing the existing workflow recipe authoring diff, or from a broader
CloudTable product/platform priority outside this reconciliation loop.
