# CLO-2305 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2305
Parent: CLO-2304 CloudTable 15-minute project driver
Prior checkpoint: CLO-2303

## Disposition

No fresh non-duplicative implementation, QA, product, or design child is warranted
from this checkpoint.

The current source/test/open-issue state still points at the same active lane:
workflow recipe authoring/create/publish for `direct_sync` and `grouped_rollup`,
plus the already-covered Google login, invitation, organization/workspace
membership, and workspace-switching ingress paths. I did not find a new bounded
gap outside that lane, and creating another child would duplicate the work
already represented in the current repository delta and prior checkpoints.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- Current active issue tree for this goal shows `CLO-2304` blocked by this
  checkpoint and `CLO-2305` in progress. The only current actionable child is
  this reconciliation checkpoint.
- Tracked source/test delta remains scoped to recipe authoring and runtime
  ingress:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- Identity coverage remains present for Google callback invitation acceptance,
  invited cross-organization workspace prioritization, and active workspace
  switching for multi-membership sessions.
- Reactive workflow coverage remains present for:
  - canonical `direct_sync` recipe metadata and create/publish ingress
  - canonical `grouped_rollup` recipe metadata and create/publish ingress
  - `sum_numbers` as part of the extensible aggregate operation catalog
  - maintenance metadata/routes for backfill and recompute after publish
- Prior row-owner and extensible-condition progress remains completed
  groundwork; no field-type proposal-hint parity work was needed to evaluate
  this goal checkpoint.

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

Close `CLO-2305` as done and unblock parent `CLO-2304`. Do not create a duplicate
identity/reactive child unless a future wake identifies a concrete failed
verification target, changed product requirement, or non-duplicative
implementation gap outside the current workflow recipe authoring/create/publish
lane.
