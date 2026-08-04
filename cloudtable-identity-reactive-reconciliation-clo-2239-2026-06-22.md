# CLO-2239 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2239
Parent: CLO-2238 CloudTable 15-minute project driver
Prior checkpoint: CLO-2237

## Disposition

No fresh bounded implementation, QA, product, or design child is warranted from
CLO-2239.

Nothing materially changed since CLO-2237. The current source of truth remains
the workflow recipe authoring/create/publish lane for direct_sync and
grouped_rollup:

- src/core/workflows/authoring.ts
- src/core/workflows/types.ts
- src/runtime/worker.ts
- testing/cloudtable/suites/workflows/authoring.spec.ts
- testing/cloudtable/suites/runtime/ingress.spec.ts

The tracked delta still maps to canonical recipe metadata, workspace recipe
catalog read ingress, table-scoped recipe preview/create ingress, optional
publish-on-create, aggregate operation metadata, and explicit sync/aggregate
maintenance route metadata for backfill/recompute.

Creating another child now would duplicate the already-covered workflow recipe
authoring/create/publish lane rather than identify a distinct identity/reactive
capability gap.

## Evidence

- Active goal d6d73d1d-9a36-4411-a8b3-508859276d79 remains Identity and
  reactive data workflows.
- Current parent CLO-2238 is blocked only by this reconciliation child.
- Active issue scan for the goal shows CLO-2239 as the only current in-progress
  child of the latest driver; the other open records are older blocked driver or
  recovery records, not a new bounded implementation lane after CLO-2237.
- Current git diff is still limited to:
  - src/core/workflows/authoring.ts
  - src/core/workflows/types.ts
  - src/runtime/worker.ts
  - testing/cloudtable/suites/workflows/authoring.spec.ts
  - testing/cloudtable/suites/runtime/ingress.spec.ts
- Repository search still shows existing code/test coverage for Google callback
  invitation acceptance, invited workspace prioritization, multi-membership
  session switching, sync maintenance, aggregate maintenance, workflow recipe
  catalog ingress, direct_sync, and grouped_rollup.

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

Close CLO-2239 as done. Do not create a duplicate child unless a future wake
names a concrete failed verification target, product requirement, or
non-duplicative implementation gap outside the current workflow recipe
authoring/create/publish lane.
