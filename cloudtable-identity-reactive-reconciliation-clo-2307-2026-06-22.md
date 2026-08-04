# CLO-2307 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: [CLO-2307](/CLO/issues/CLO-2307)
Parent: [CLO-2306](/CLO/issues/CLO-2306) CloudTable 15-minute project driver
Prior checkpoint: [CLO-2305](/CLO/issues/CLO-2305)

## Disposition

No fresh bounded, non-duplicative implementation, QA, product, or design child
is warranted from this checkpoint.

The current source-of-truth lane remains workflow recipe authoring/create/publish
for `direct_sync` and `grouped_rollup`, plus the existing Google login/session,
invitation, organization/workspace membership, and workspace-switching coverage.
There is no material delta since [CLO-2305](/CLO/issues/CLO-2305) that changes
the next issue path.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and reactive data workflows`.
- Current active/open goal state shows [CLO-2306](/CLO/issues/CLO-2306) blocked by this checkpoint and [CLO-2307](/CLO/issues/CLO-2307) in progress; prior checkpoint [CLO-2305](/CLO/issues/CLO-2305) is done.
- The tracked source/test delta remains scoped to the same five-file recipe lane:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- Recipe metadata and ingress still cover canonical `direct_sync` and `grouped_rollup` authoring, table-scoped preview/create, optional publish-on-create, and maintenance metadata/routes for `backfill` and `recompute`.
- Identity coverage remains present for Google callback invitation acceptance, invited workspace prioritization, multi-membership workspace selection, and session switching.
- Prior row-owner and extensible-condition work remains completed groundwork and does not create a new child issue in this checkpoint.

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

Close [CLO-2307](/CLO/issues/CLO-2307) as done and unblock parent
[CLO-2306](/CLO/issues/CLO-2306). Do not create another identity/reactive child
unless a future wake identifies a concrete failed verification target, changed
product requirement, or non-duplicative implementation gap outside the current
workflow recipe authoring/create/publish lane.
