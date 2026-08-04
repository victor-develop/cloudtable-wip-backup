# CLO-2287 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2287
Parent: CLO-2286 CloudTable 15-minute project driver
Prior checkpoint: CLO-2285

## Disposition

No fresh bounded implementation, QA, product, or design child is warranted from
`CLO-2287`.

The current code, focused tests, and active goal issue state still point to the
same source of truth: the workflow recipe authoring/create/publish lane for
`direct_sync` and `grouped_rollup`, plus existing identity/session and
organization/workspace invitation coverage. Creating another implementation
child would duplicate the covered recipe lane rather than address a distinct
identity/reactive capability gap.

## Evidence

- Active goal `d6d73d1d-9a36-4411-a8b3-508859276d79` remains
  `Identity and reactive data workflows`.
- Current parent `CLO-2286` is blocked by this reconciliation issue only.
- Tracked source/test delta remains the same recipe lane:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- The recipe lane exposes canonical metadata, workspace recipe catalog read
  ingress, table-scoped recipe preview/create ingress, optional
  publish-on-create, and maintenance metadata/routes for backfill and recompute.
- Repository search confirmed existing focused coverage for Google callback
  invitation acceptance, invited workspace prioritization, multi-membership
  session switching, workflow recipe catalog read ingress, direct sync, grouped
  rollup, sync maintenance, and aggregate maintenance.

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
- An accidental broad `npm test -- --runInBand` invocation was interrupted after
  command-golden, replay, permissions, and field-types suites passed; it is not
  the primary verification evidence for this checkpoint.

## Recommendation

Close `CLO-2287` as done and unblock parent `CLO-2286`. Do not create a
duplicate child unless a future wake names a concrete failed verification target,
product requirement, or non-duplicative implementation gap outside the current
workflow recipe authoring/create/publish lane.
