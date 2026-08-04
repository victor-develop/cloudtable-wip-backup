# CLO-2237 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2237
Parent: CLO-2236 CloudTable 15-minute project driver
Prior checkpoint: CLO-2235

## Disposition

No fresh bounded implementation, QA, product, or design child is warranted from
CLO-2237.

The current source of truth remains the workflow recipe authoring/create/publish
lane for direct_sync and grouped_rollup:

- src/core/workflows/authoring.ts
- src/core/workflows/types.ts
- src/runtime/worker.ts
- testing/cloudtable/suites/workflows/authoring.spec.ts
- testing/cloudtable/suites/runtime/ingress.spec.ts

The current tracked delta still maps to canonical recipe metadata, workspace
recipe catalog read ingress, table-scoped recipe preview/create ingress,
optional publish-on-create, aggregate operation metadata, and explicit
sync/aggregate maintenance route metadata for backfill/recompute.

Creating another child now would duplicate the already-covered workflow recipe
authoring/create/publish lane rather than identify a distinct identity/reactive
capability gap.

## Evidence

- Active goal d6d73d1d-9a36-4411-a8b3-508859276d79 remains Identity and
  reactive data workflows.
- Current parent CLO-2236 is blocked by this reconciliation child.
- CLO-2235 reported the same tracked source/test delta and the same
  direct_sync/grouped_rollup authoring lane as the active implementation source
  of truth.
- Current git diff is still limited to:
  - src/core/workflows/authoring.ts
  - src/core/workflows/types.ts
  - src/runtime/worker.ts
  - testing/cloudtable/suites/workflows/authoring.spec.ts
  - testing/cloudtable/suites/runtime/ingress.spec.ts
- Repository search still shows existing code/test coverage for Google callback
  invitation acceptance, invited workspace prioritization, multi-membership
  session switching, sync maintenance, aggregate maintenance, and recipe ingress.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching"
```

Results:

- git diff --check passed.
- Focused Vitest passed: 2 files, 8 tests passed and 166 skipped.

## Recommendation

Close CLO-2237 as done when focused verification passes. Do not create a
duplicate child unless a future wake names a concrete failed verification target,
product requirement, or non-duplicative implementation gap outside the current
workflow recipe authoring/create/publish lane.
