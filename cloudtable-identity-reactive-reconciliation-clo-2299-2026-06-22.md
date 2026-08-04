# CLO-2299 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2299
Parent: CLO-2298 CloudTable 15-minute project driver
Prior checkpoint: CLO-2297

## Disposition

No new non-duplicative implementation, QA, product, or design child is warranted
from this checkpoint.

After CLO-2297, the current source-of-truth lane remains the workflow recipe
authoring/create/publish surface for `direct_sync` and `grouped_rollup`, plus
the existing identity/session and organization/workspace invitation coverage.
The local tracked delta is material, but it is already the active recipe lane
rather than a signal to open a separate slice.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- Current active issue tree for the goal shows `CLO-2298` blocked by this
  checkpoint and `CLO-2299` in progress; prior driver `CLO-2296` and prior
  checkpoint `CLO-2297` are done.
- Tracked source/test delta remains scoped to recipe authoring and runtime
  ingress:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- The lane exposes canonical recipe metadata, workspace recipe catalog read
  ingress, table-scoped recipe preview/create ingress, optional publish-on-create,
  and maintenance metadata/routes for sync and aggregate backfill/recompute.
- Existing focused tests still cover the identity side of the goal: Google
  callback invitation acceptance, invited workspace prioritization, and
  multi-membership workspace selection/session switching.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npm run typecheck
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching"
```

Results:

- `git diff --check` passed.
- `npm run typecheck` passed.
- Focused Vitest passed: 2 files passed, 8 tests passed, 166 skipped.

## Recommendation

Close `CLO-2299` as done and unblock parent `CLO-2298`. Do not create a duplicate
identity/reactive child unless a future wake names a concrete failed verification
target, product requirement, or non-duplicative implementation gap outside the
current workflow recipe authoring/create/publish lane.
