# CLO-2158 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2158
Parent: CLO-2157 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2158`.

This checkpoint reconciled the current CloudTable codebase and active goal-tree
state against the identity/reactive-workflow goal after `CLO-2156`. The live
parent `[CLO-2157](/CLO/issues/CLO-2157)` is blocked only by this checkpoint, and
the current repo delta is still the same workflow recipe authoring/create/publish
lane recorded by `CLO-2156`.

Creating another implementation child now would duplicate the active lane instead
of addressing a fresh uncovered identity/reactive workflow gap.

## Current Evidence

- Source delta remains limited to `src/core/workflows/authoring.ts`,
  `src/core/workflows/types.ts`, `src/runtime/worker.ts`,
  `testing/cloudtable/suites/workflows/authoring.spec.ts`, and
  `testing/cloudtable/suites/runtime/ingress.spec.ts`.
- The delta still represents canonical workflow recipe metadata for
  `direct_sync` and `grouped_rollup`, workflow recipe catalog read ingress,
  recipe preview/create ingress, optional publish-on-create, aggregate operation
  catalog exposure, and explicit backfill/recompute maintenance metadata.
- Google login/session, invitation acceptance, cross-organization invited
  workspace selection, and multi-membership session switching remain covered by
  focused runtime ingress tests.
- Declarative cross-table sync remains represented by the `direct_sync` recipe
  and `sync_related_field` workflow operator path.
- Rolling computed columns remain represented by the `grouped_rollup` recipe,
  computed rollup field contracts, and the aggregate operation registry.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  plus the existing sync and aggregate maintenance routes.
- Row-owner and extensible-condition work remain completed groundwork and do not
  need to be reopened for this goal.

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
- Focused runtime ingress identity/reactive filter passed: 8 tests, 146 skipped
  by the filter.

## Recommendation

Close `CLO-2158` as done and unblock parent
`[CLO-2157](/CLO/issues/CLO-2157)` for CEO closure or advancement. No duplicate
identity/reactive implementation child should be created unless a future wake
names a fresh failed verification target, product requirement, or
non-duplicative implementation gap.
