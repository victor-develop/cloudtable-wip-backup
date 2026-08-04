# CLO-2249 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2249
Parent: CLO-2248 CloudTable 15-minute project driver
Prior checkpoint: CLO-2245

## Disposition

No fresh bounded implementation, QA, product, or design child is warranted from
CLO-2249.

The material CloudTable delta after the prior checkpoint is still the workflow
recipe authoring/create/publish lane for `direct_sync` and `grouped_rollup`.
The tracked workspace diff is limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`

That delta already maps to the active identity/reactive capability goal: it
publishes canonical recipe metadata, exposes the workspace workflow recipe
catalog, provides table-scoped recipe preview/create ingress, supports optional
publish-on-create, carries aggregate operation metadata, and names sync and
aggregate maintenance routes for `backfill` and `recompute`.

Opening another child now would duplicate the same workflow recipe lane instead
of addressing a distinct uncovered identity/reactive capability gap.

## Evidence

- Active goal `d6d73d1d-9a36-4411-a8b3-508859276d79` remains Identity and
  reactive data workflows.
- Current parent `CLO-2248` is blocked only by this reconciliation child.
- Open issue scan for the active goal shows the current driver/reconciliation
  pair as the latest active pair; older open records are blocked driver or
  recovery artifacts, not a newer bounded implementation lane.
- Source inspection shows the current change set implements the same canonical
  workflow recipe contract already named by the prior checkpoint, not a separate
  identity, invitation, session, sync, rollup, or backfill gap.
- Existing runtime and regression suites still contain targeted identity and
  reactive coverage for Google callback linkage, invitation acceptance, invited
  workspace prioritization, multi-membership session switching, direct sync,
  reactive rollups, aggregate maintenance, and workflow service identity.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching"
```

Results:

- `git diff --check` passed.
- Focused Vitest passed: 2 files, 8 tests passed and 166 skipped.

## Recommendation

Close `CLO-2249` as done. Do not create another identity/reactive child from
this checkpoint unless a future wake names a concrete failed verification target,
product requirement, or non-duplicative implementation gap outside the current
workflow recipe authoring/create/publish lane.
