# CLO-2217 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2217
Parent: CLO-2216 CloudTable 15-minute project driver
Prior checkpoint: CLO-2215

## Disposition

No fresh bounded implementation or QA slice is warranted from `CLO-2217`.

The current repository and goal-tree state after `CLO-2215` still point to the
same workflow recipe authoring/create/publish lane for `direct_sync` and
`grouped_rollup`. I found no material change that creates a non-duplicative gap
for multi-tenant identity, cross-table direct sync, grouped rolling computed
columns, or batch initialize/backfill.

## Evidence

- `CLO-2215` closed as done with no new implementation child warranted.
- Active goal remains `Identity and reactive data workflows`.
- Current live parent `CLO-2216` is blocked by this reconciliation child.
- The relevant tracked source/test delta remains limited to:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- That delta maps to canonical workflow recipe metadata for `direct_sync` and
  `grouped_rollup`, workspace recipe catalog read ingress, table-scoped recipe
  preview/create ingress, optional publish-on-create, aggregate operation
  metadata, and explicit backfill/recompute maintenance route metadata.
- Identity/session/invitation/workspace switching coverage remains represented
  by existing runtime ingress tests.
- The active issue state did not reveal a newer clear implementation owner path
  or failed verification target under the current driver beyond this checkpoint.

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

Close `CLO-2217` as done and unblock parent `CLO-2216`. Do not create a
duplicate identity/reactive implementation child unless a future wake names a
concrete failed verification target, product requirement, or non-duplicative
implementation gap outside the current workflow recipe authoring/create/publish
lane.
