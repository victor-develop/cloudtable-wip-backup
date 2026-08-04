# CLO-2181 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2181
Parent: CLO-2180 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2181`.

This checkpoint reconciled the current CloudTable repo state and active
identity/reactive workflow goal after `CLO-2177`. I found no material change
that supersedes the prior no-new-slice conclusion. The current source/test
delta remains the same workflow recipe authoring/read/preview/create/publish
lane for `direct_sync` and `grouped_rollup`, with aggregate catalog exposure,
explicit backfill/recompute maintenance metadata, and existing
identity/invitation/session ingress coverage.

Creating another implementation child now would duplicate the active workflow
recipe lane rather than address a fresh uncovered identity/reactive capability
gap.

## Evidence

- Active goal remains `Identity and reactive data workflows`.
- Parent `CLO-2180` is blocked by this reconciliation child, `CLO-2181`.
- `CLO-2177` is done and recorded the same no-new-slice conclusion.
- Current tracked source delta is still limited to:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- The delta exposes recipe catalog metadata for `direct_sync` and
  `grouped_rollup`, workspace recipe catalog read ingress, recipe preview
  ingress, recipe create ingress, optional publish-on-create support, and
  aggregate operation catalog exposure.
- Declarative cross-table sync remains represented by the `direct_sync` recipe
  and `sync_related_field` action path.
- Grouped rolling computed columns remain represented by the `grouped_rollup`
  recipe, aggregate operation registry exposure, computed rollup field
  contracts, and aggregate maintenance route metadata.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  plus existing sync and aggregate maintenance routes.
- Google login/session, organization/workspace invitation acceptance,
  invite-backed workspace selection, and multi-membership session switching
  remain covered by focused runtime ingress tests.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress|fails closed for selected-record workflow previews when service identity metadata is missing|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching"
```

Results:

- `git diff --check` passed.
- `testing/cloudtable/suites/workflows/authoring.spec.ts` passed: 20 tests.
- Focused runtime ingress identity/reactive filter passed: 8 tests, 146 skipped.

## Recommendation

Close `CLO-2181` as done and unblock parent `CLO-2180`. No duplicate
identity/reactive implementation child should be created unless a future wake
names a fresh failed verification target, product requirement, or
non-duplicative implementation gap.
