# CLO-2095 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2095
Parent: CLO-2094 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2095`.

This checkpoint reconciled the current repo and active goal state after
`CLO-2093`. The active goal still names the same identity/reactive workflow
capability set: Google login, invited users across organizations/workspaces,
declarative cross-table sync, grouped rollup/aggregate workflows, extensible
aggregate operations, and batch initialize/backfill.

`CLO-2094` is blocked only by this reconciliation child. `CLO-2093` is done,
and the current source/test delta is unchanged from the prior checkpoint
evidence. Creating another implementation issue would duplicate the already
covered workflow recipe authoring/create/publish lane.

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

- Google login remains represented by runtime auth ingress, Google identity
  linkage, session establishment, and workspace hydration coverage.
- Invited users across organizations/workspaces remain represented by
  invitation, membership, session-selection, and invited-member reactive
  readback coverage.
- Declarative direct sync remains represented by the canonical `direct_sync`
  recipe contract, `sync_related_field`, preview/create ingress, and direct-sync
  readback coverage.
- Grouped rollup workflows remain represented by the canonical
  `grouped_rollup` recipe contract, rollup field metadata, registry-backed
  aggregate operations, preview/create/publish ingress, and readback coverage.
- Extensible aggregate operations remain exposed through the aggregate operation
  catalog: `count_records`, `sum_numbers`, `max_number`, and
  `average_numbers`.
- Batch initialize/backfill/recompute remains explicit in recipe maintenance
  metadata plus the sync and aggregate maintenance runtime paths.

## Verification

Passed on 2026-06-21 against the current workspace state:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress with workflow-step diagnostics|fails closed for selected-record workflow previews when service identity metadata is missing|Google OAuth|invited users|multi-membership"
```

Results:

- `git diff --check` passed.
- Focused workflow authoring/runtime ingress tests passed: 2 files, 7 tests,
  167 skipped.

## Recommendation

Close `CLO-2095` as done. Do not create a successor implementation issue from
this checkpoint unless a future driver names a new failing verification target,
fresh product requirement, or concrete unblock owner/action that is not already
covered by the current workflow recipe authoring/create/publish lane.
