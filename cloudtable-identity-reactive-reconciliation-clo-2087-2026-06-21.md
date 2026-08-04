# CLO-2087 CloudTable identity/reactive reconciliation

Date: 2026-06-21
Goal: Identity and reactive data workflows
Issue: CLO-2087
Parent: CLO-2086 CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from `CLO-2087`.

This checkpoint reconciled the current repo and active goal state after
`CLO-2085`. The goal tree still points at the same identity/reactive workflow
capability: Google login, invited users across organizations/workspaces,
declarative cross-table sync, grouped rolling computed columns with extensible
aggregate operations, and batch initialize/backfill for reactive computations.

The only active blocker on the current project driver is this reconciliation
child. The repo delta remains the same five-file workflow recipe
authoring/create/publish lane recorded by `CLO-2085`, so creating another
successor implementation issue would duplicate existing workflow recipe work
rather than define a fresh bounded slice.

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

- Google identity remains covered by runtime login/callback, canonical identity
  linkage, sessions, workspace hydration, and focused Google OAuth ingress
  tests.
- Invited users and multi-membership remain covered by invitation, workspace
  membership, and session switching ingress coverage.
- Declarative cross-table sync remains represented by the canonical
  `direct_sync` recipe contract, `sync_related_field`, preview/create ingress,
  and direct-sync readback coverage.
- Grouped rolling computed columns remain represented by the canonical
  `grouped_rollup` recipe contract, rollup field metadata, registry-backed
  aggregate operations, preview/create/publish ingress, and readback coverage.
- Extensible aggregate/compute architecture remains represented by the
  aggregate operation registry: `count_records`, `sum_numbers`, `max_number`,
  and `average_numbers`.
- Batch initialize/backfill/recompute remains explicit in recipe maintenance
  metadata plus the sync and aggregate maintenance runtime paths.

## Verification

Passed on 2026-06-21 against the current workspace state:

```bash
git diff --check
npm run typecheck
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress with workflow-step diagnostics|fails closed for selected-record workflow previews when service identity metadata is missing|Google OAuth|invited users|multi-membership"
```

Results:

- `git diff --check` passed.
- TypeScript: `tsc --noEmit` passed.
- Focused workflow authoring/runtime ingress tests: 2 files passed, 7 tests
  passed, 167 skipped.

## Recommendation

Close `CLO-2087` as done. Do not create a successor implementation issue from
this checkpoint unless a future driver names a new failing verification target,
product requirement, or concrete unblock owner/action that is not already
covered by the current workflow recipe authoring/create/publish lane.
