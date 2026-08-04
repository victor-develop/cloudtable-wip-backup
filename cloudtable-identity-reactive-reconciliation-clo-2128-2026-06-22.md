# CLO-2128 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2128
Parent: CLO-2127 CloudTable 15-minute project driver

## Disposition

No new implementation issue is warranted from `CLO-2128`.

This checkpoint reconciled the active goal tree, parent driver state, prior
`CLO-2124` artifact, and current repository state. The only active blocker for
the parent driver is this reconciliation child. The code delta still matches the
already-bounded workflow recipe authoring/create/publish lane:

- canonical recipe catalog metadata for `direct_sync` and `grouped_rollup`
- runtime recipe catalog read ingress
- direct-sync and grouped-rollup recipe preview/create ingress
- optional publish on recipe create
- aggregate operation catalog exposure for grouped rollups
- manual sync and aggregate maintenance routes for backfill/recompute

Creating another child implementation issue from this checkpoint would duplicate
that lane rather than address a new goal or code gap.

## Capability Evidence

- Google login/session is represented by the runtime auth ingress, callback,
  session selection, Google identity linkage, and focused runtime coverage.
- Invited users across organizations/workspaces are represented by invitation,
  membership provisioning, multi-membership session switching, and reactive
  readback coverage.
- Row ownership and extensible workflow condition groundwork remain completed
  support work and are not reopened by current goal-tree evidence.
- Declarative cross-table sync is represented by the `direct_sync` recipe,
  `sync_related_field`, preview/create ingress, and direct-sync readback tests.
- Grouped rolling computed columns are represented by `grouped_rollup`,
  rollup field metadata, aggregate definitions, `set_cell` execution, and
  readback tests.
- Extensible rolling operations are represented by the aggregate operation
  registry and catalog exposure: `count_records`, `sum_numbers`, `max_number`,
  and `average_numbers`.
- Batch initialize/backfill is represented by recipe maintenance metadata and
  explicit `/sync-maintenance` and `/aggregate-maintenance` runtime paths.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress|fails closed for selected-record workflow previews when service identity metadata is missing|drafts, executes, and reads back direct sync workflow proposals through ingress|Google OAuth|invited users|multi-membership"
npm run typecheck
```

Results:

- `git diff --check` passed.
- `testing/cloudtable/suites/workflows/authoring.spec.ts` passed: 1 file, 20
  tests.
- Focused runtime ingress identity/reactive tests passed: 1 file, 5 passed and
  149 skipped by the test filter.
- `npm run typecheck` passed.

## Recommendation

Close `CLO-2128` as done. Unblock parent `CLO-2127` so the driver can close or
create a future planning child only if a fresh requirement, failed verification
target, or concrete implementation gap appears.
