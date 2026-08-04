# CLO-2164 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2164
Parent: CLO-2163 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2164`.

This checkpoint reconciled the current CloudTable codebase and active goal-tree
state after `CLO-2162`. The material source delta remains the same workflow
recipe authoring/create/publish lane recorded by `CLO-2162`, `CLO-2160`, and
`CLO-2158`.

Creating another implementation child now would duplicate the active lane instead
of addressing a fresh identity/reactive workflow gap.

## Current Evidence

- The live goal remains `Identity and reactive data workflows`.
- `CLO-2162` is done and recorded the same no-new-slice conclusion.
- Source delta remains limited to workflow recipe metadata, recipe catalog read
  ingress, recipe preview/create ingress, optional publish-on-create, aggregate
  operation catalog exposure, and focused ingress/authoring tests.
- Declarative cross-table sync is represented by the `direct_sync` recipe and
  `sync_related_field` action path.
- Rolling grouped computed columns are represented by the `grouped_rollup` recipe,
  aggregate operation registry exposure, computed rollup field contracts, and
  aggregate maintenance route metadata.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  plus the existing sync and aggregate maintenance routes.
- Identity/session invite coverage remains in the focused runtime ingress filter.
- Completed row-owner and extensible-condition groundwork does not need reopening
  for this checkpoint.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npm run typecheck -- --pretty false
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress|fails closed for selected-record workflow previews when service identity metadata is missing|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching"
```

Results:

- `git diff --check` passed.
- `npm run typecheck -- --pretty false` passed.
- `testing/cloudtable/suites/workflows/authoring.spec.ts` passed: 20 tests.
- Focused runtime ingress identity/reactive filter passed: 8 tests, 146 skipped.

## Recommendation

Close `CLO-2164` as done and unblock parent `[CLO-2163](/CLO/issues/CLO-2163)`.
No duplicate identity/reactive implementation child should be created unless a
future wake names a fresh failed verification target, product requirement, or
non-duplicative implementation gap.
