# CLO-2168 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2168
Parent: CLO-2167 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2168`.

This checkpoint reconciled the current CloudTable code, tests, and goal-tree
state after `CLO-2166`. The material implementation lane remains the workflow
recipe authoring/create/publish surface already represented by completed
implementation and QA issues, including `CLO-1945`, `CLO-1959`, `CLO-1814`,
and the follow-on reconciliation checkpoints through `CLO-2166`.

Creating another implementation child now would duplicate completed or already
reconciled workflow recipe authoring work rather than address a fresh
identity/reactive workflow gap.

## Current Evidence

- The live goal remains `Identity and reactive data workflows`.
- `CLO-2164` and `CLO-2166` are both done and both record the same no-new-slice
  conclusion.
- Issue search for workflow recipe authoring shows the canonical implementation
  and QA lanes are done: `CLO-1945`, `CLO-1959`, `CLO-1814`, `CLO-1815`, and
  the earlier canonical workflow-authoring issue `CLO-1509`.
- The current source delta remains the same workflow recipe authoring/create
  lane: recipe metadata, catalog read ingress, recipe preview/create ingress,
  optional publish-on-create, aggregate operation catalog exposure, and focused
  ingress/authoring tests.
- Declarative cross-table sync is represented by the `direct_sync` recipe and
  `sync_related_field` action path.
- Rolling grouped computed columns are represented by the `grouped_rollup`
  recipe, aggregate operation registry exposure, computed rollup field
  contracts, and aggregate maintenance route metadata.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  plus the existing sync and aggregate maintenance routes.
- Identity/session invite coverage remains in the focused runtime ingress
  verification filter.

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

Close `CLO-2168` as done and unblock parent `CLO-2167`. No duplicate
identity/reactive implementation child should be created unless a future wake
names a fresh failed verification target, product requirement, or
non-duplicative implementation gap.
