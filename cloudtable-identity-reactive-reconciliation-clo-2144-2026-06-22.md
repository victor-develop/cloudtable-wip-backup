# CLO-2144 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2144
Parent: CLO-2143 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2144`.

This checkpoint reconciled the current CloudTable worktree and active goal-tree
state after `CLO-2142`. The only active current driver child is this issue, and
the repository still points to the same completed workflow recipe
authoring/create/publish lane rather than a fresh implementation gap:

- canonical workflow recipe catalog metadata for `direct_sync` and
  `grouped_rollup`
- runtime workflow recipe catalog read ingress
- direct-sync and grouped-rollup recipe preview/create ingress
- optional publish on recipe create
- aggregate operation catalog exposure for grouped rollups
- explicit sync and aggregate maintenance route metadata for backfill/recompute

Creating another implementation child now would duplicate existing
identity/reactive workflow coverage instead of advancing a newly identified
slice.

## Capability Evidence

- Google login/session remains represented by runtime auth ingress, Google
  identity linkage, session establishment, and workspace selection coverage.
- Organization/workspace invitations and multi-membership remain represented by
  invitation/member provisioning and persisted active-workspace session
  switching.
- Declarative cross-table sync remains represented by the `direct_sync` recipe,
  `sync_related_field`, workflow recipe preview/create ingress, and direct
  cross-table sync workflow readback coverage.
- Grouped rolling computed columns remain represented by the `grouped_rollup`
  recipe, rollup field metadata, registry-backed aggregate definitions,
  preview/create/publish ingress, selected-record preview diagnostics, and
  reactive readback coverage.
- Extensible rolling operations remain exposed through aggregate operation
  catalog metadata for `count_records`, `sum_numbers`, `max_number`, and
  `average_numbers`.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  plus the existing `/sync-maintenance` and `/aggregate-maintenance` runtime
  paths.
- Workflow service identity remains fail-closed for selected-record workflow
  previews when explicit service identity metadata is missing.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress|fails closed for selected-record workflow previews when service identity metadata is missing|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|persists active workspace selection for multi-membership users"
```

Results:

- `git diff --check` passed.
- `testing/cloudtable/suites/workflows/authoring.spec.ts` passed: 1 file, 20
  tests.
- Focused runtime ingress identity/reactive tests passed: 1 file, 6 passed and
  148 skipped by the test filter.

## Recommendation

Close `CLO-2144` as done. This unblocks parent `CLO-2143`; no duplicate
identity/reactive implementation child should be created unless a future wake
names a fresh failed verification target, product requirement, or
non-duplicative implementation gap.
