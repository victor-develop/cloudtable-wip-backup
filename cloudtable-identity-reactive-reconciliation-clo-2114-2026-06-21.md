# CLO-2114 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2114
Parent: CLO-2113 CloudTable 15-minute project driver

## Disposition

No new bounded successor implementation issue is warranted from `CLO-2114`.

This checkpoint reconciled the current CloudTable repo, goal tree, and recent
issue state after `CLO-2111`. `CLO-2111` and `CLO-2112` are closed, and
`CLO-2113` is blocked only by this reconciliation child. The current material
source delta remains the same workflow recipe authoring/create/publish lane:
canonical recipe catalog metadata, direct-sync and grouped-rollup recipe
preview/create ingress, optional publish on create, aggregate operation catalog
exposure, and backfill/recompute maintenance routes.

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

- Google login/session and invited-user organization/workspace membership remain
  represented by existing runtime auth, identity linkage, invitation,
  membership, and workspace hydration coverage preserved from prior checkpoints.
- Row-owner and extensible-condition groundwork remain completed groundwork; no
  new issue-tree or repo evidence reopens those lanes.
- Declarative direct sync remains represented by the canonical `direct_sync`
  recipe contract, `sync_related_field`, recipe preview/create ingress, and
  direct-sync workflow readback coverage.
- Grouped rollup workflows remain represented by the canonical
  `grouped_rollup` recipe contract, rollup field metadata, registry-backed
  aggregate operations, preview/create/publish ingress, and reactive readback
  coverage.
- Extensible aggregate operations remain exposed through the aggregate operation
  catalog: `count_records`, `sum_numbers`, `max_number`, and
  `average_numbers`.
- Batch initialize/backfill/recompute remains explicit in recipe maintenance
  metadata plus the sync and aggregate maintenance runtime paths.

## Verification

Run on 2026-06-21 against the current workspace state:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress|fails closed for selected-record workflow previews when service identity metadata is missing|drafts, executes, and reads back direct sync workflow proposals through ingress"
npm run typecheck
```

Results:

- `git diff --check` passed.
- `testing/cloudtable/suites/workflows/authoring.spec.ts` passed: 1 file, 20
  tests.
- Focused runtime ingress recipe tests passed: 1 file, 4 tests, 150 skipped.
- `npm run typecheck` passed.

## Recommendation

Close `CLO-2114` as done. Do not create a successor implementation issue unless
a future driver names a new failing verification target, fresh product
requirement, or concrete unblock owner/action that is not already covered by the
current workflow recipe authoring/create/publish lane.
