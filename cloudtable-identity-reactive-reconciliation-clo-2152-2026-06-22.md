# CLO-2152 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2152
Parent: CLO-2151 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2152`.

This checkpoint reconciled the current CloudTable codebase, active goal state,
and the parent driver blocker after `CLO-2150`. The only material local code
delta remains the same workflow recipe authoring/create/publish lane already
identified by the previous completed checkpoint:

- canonical recipe catalog metadata for `direct_sync` and `grouped_rollup`
- runtime workflow recipe catalog read ingress
- direct-sync and grouped-rollup recipe preview/create ingress
- optional publish on recipe create
- aggregate operation catalog exposure for grouped rollups
- explicit sync and aggregate maintenance route metadata for backfill/recompute

The active parent `[CLO-2151](/CLO/issues/CLO-2151)` is blocked only by this
child. Creating another implementation child now would duplicate the same
identity/reactive workflow lane rather than address a fresh uncovered gap.

## Capability Evidence

- Google login/session remains represented by runtime auth ingress, Google
  identity linkage, session establishment, active workspace selection, and
  multi-membership switching coverage.
- Organization/workspace invitations remain represented by invitation issue and
  Google callback acceptance coverage, plus repository-level canonical user,
  organization membership, workspace membership, and principal projection tests.
- Declarative cross-table sync remains represented by the `direct_sync` recipe,
  `sync_related_field`, workflow recipe preview/create ingress, and direct
  cross-table sync workflow readback coverage.
- Rolling computed columns remain represented by the `grouped_rollup` recipe,
  rollup field contracts, registry-backed aggregate definitions,
  preview/create/publish ingress, selected-record preview diagnostics, and
  reactive readback coverage.
- Extensible aggregate operations remain exposed through catalog metadata for
  `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  plus `/sync-maintenance` and `/aggregate-maintenance` runtime paths.
- Workflow service identity continues to fail closed for reactive maintenance
  and selected-record workflow preview paths when explicit service identity
  metadata is missing.

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
- `testing/cloudtable/suites/workflows/authoring.spec.ts` passed: 1 file, 20
  tests.
- Focused runtime ingress identity/reactive tests passed: 1 file, 8 passed and
  146 skipped by the test filter.

## Recommendation

Close `CLO-2152` as done. This unblocks parent
`[CLO-2151](/CLO/issues/CLO-2151)`; no duplicate identity/reactive
implementation child should be created unless a future wake names a fresh
failed verification target, product requirement, or non-duplicative
implementation gap.
