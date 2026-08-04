# CLO-2150 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2150
Parent: CLO-2149 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2150`.

The active goal tree is still centered on `Identity and reactive data
workflows`, with active subgoals for Google identity/workspace invitations,
cross-table reactive sync workflow actions, rolling computed columns and the
aggregate operation registry, batch initialize/backfill, and end-to-end API plus
deterministic coverage.

Current open CloudTable project work is only the current driver/reconciliation
path plus older stranded driver recovery items. There is no newer open
non-duplicative implementation lane to route around. The meaningful current
workspace delta remains the workflow recipe authoring/create/publish capability
already identified by recent completed checkpoints and implementation issues:

- canonical recipe catalog metadata for `direct_sync` and `grouped_rollup`
- runtime workflow recipe catalog read ingress
- direct-sync and grouped-rollup recipe preview/create ingress
- optional publish on recipe create
- aggregate operation catalog exposure for grouped rollups
- explicit sync and aggregate maintenance route metadata for backfill/recompute

Creating another child implementation issue now would duplicate that completed
lane instead of addressing a fresh identity/reactive workflow gap.

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
  rollup field contracts, registry-backed aggregate definitions, preview/create
  ingress, selected-record preview diagnostics, and reactive readback coverage.
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

Close `CLO-2150` as done. This unblocks parent `CLO-2149`; no duplicate
identity/reactive implementation child should be created unless a future wake
names a fresh failed verification target, product requirement, or
non-duplicative implementation gap.
