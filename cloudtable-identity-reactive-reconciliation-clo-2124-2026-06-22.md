# CLO-2124 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2124
Parent: CLO-2123 CloudTable 15-minute project driver

## Disposition

No new bounded successor implementation issue is warranted from `CLO-2124`.

This checkpoint reconciled the current CloudTable repo, active goal tree, and
parent driver state after the previous CTO reconciliation lineage. The parent
`CLO-2123` is blocked only by this reconciliation child. The material source
delta remains the same workflow recipe authoring/create/publish lane already
documented by prior checkpoints:

- canonical recipe catalog metadata for `direct_sync` and `grouped_rollup`
- direct-sync and grouped-rollup recipe preview/create ingress
- optional publish on create
- aggregate operation catalog exposure
- backfill/recompute maintenance routes

Creating another implementation issue from this checkpoint would duplicate the
covered workflow recipe lane rather than address fresh repo, goal-tree, or issue
evidence.

## Repo State

The tracked source/test delta remains limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`

`git diff --stat` reports:

```text
src/core/workflows/authoring.ts                    | 110 ++++++-
src/core/workflows/types.ts                        |  35 +++
src/runtime/worker.ts                              | 335 +++++++++++++++++++++
testing/cloudtable/suites/runtime/ingress.spec.ts  | 225 ++++++++------
.../cloudtable/suites/workflows/authoring.spec.ts  |  90 +++++-
5 files changed, 701 insertions(+), 94 deletions(-)
```

## Capability Evidence

- Google login/session remains represented by runtime auth ingress, Google
  identity linkage, session establishment, and workspace hydration coverage.
- Invited users across organizations/workspaces remain represented by
  invitation, membership, session-selection, and invited-member reactive
  readback coverage.
- Row-owner and extensible-condition groundwork remain completed groundwork; no
  current issue-tree or repo evidence reopens those lanes.
- Declarative direct sync remains represented by the canonical `direct_sync`
  recipe contract, `sync_related_field`, recipe preview/create ingress, and
  direct-sync workflow readback coverage.
- Grouped rollup workflows remain represented by the canonical `grouped_rollup`
  recipe contract, rollup field metadata, registry-backed aggregate operations,
  preview/create/publish ingress, and reactive readback coverage.
- Extensible aggregate operations remain exposed through the aggregate operation
  catalog, including `count_records`, `sum_numbers`, `max_number`, and
  `average_numbers`.
- Batch initialize/backfill/recompute remains explicit in recipe maintenance
  metadata plus the sync and aggregate maintenance runtime paths.

## Verification

Run on 2026-06-22 against the current workspace state:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress|fails closed for selected-record workflow previews when service identity metadata is missing|drafts, executes, and reads back direct sync workflow proposals through ingress|Google OAuth|invited users|multi-membership"
npm run typecheck
```

Results:

- `git diff --check` passed.
- `testing/cloudtable/suites/workflows/authoring.spec.ts` passed: 1 file, 20
  tests.
- Focused runtime ingress identity/reactive workflow tests passed: 1 file, 5
  tests, 149 skipped.
- `npm run typecheck` passed.

## Recommendation

Close `CLO-2124` as done. Let parent `CLO-2123` close this driver cycle unless a
future wake names a new failing verification target, fresh product requirement,
or concrete unblock owner/action not already covered by the workflow recipe
authoring/create/publish lane.
