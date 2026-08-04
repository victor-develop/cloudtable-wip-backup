# CLO-2507 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2507](/CLO/issues/CLO-2507)
Parent: [CLO-2506](/CLO/issues/CLO-2506) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-2505](/CLO/issues/CLO-2505).

[CLO-2505](/CLO/issues/CLO-2505) closed with the same active-goal conclusion:
the required identity/reactive backend surface is already represented, and the
remaining active path is [CLO-2321](/CLO/issues/CLO-2321) for production OAuth
and deployment hardening review. [CLO-2321](/CLO/issues/CLO-2321) is still
`in_review` with its plan confirmation/review path; opening another
identity/reactive implementation child here would duplicate that milestone.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- [CLO-2507](/CLO/issues/CLO-2507) blocks the current driver
  [CLO-2506](/CLO/issues/CLO-2506); no new child issue is needed for the goal
  tree after this reconciliation.
- Google login, session establishment, invitations, organization/workspace
  membership, invited-workspace prioritization, and active workspace switching
  remain covered by `src/runtime/worker.ts` and
  `src/core/persistence/cloudtable-d1-repository.ts`, with focused ingress and
  repository tests.
- Declarative cross-table sync and grouped rollup authoring remain covered by
  `src/core/workflows/authoring.ts`, `src/core/agent-tools/registry.ts`, and
  `src/core/workflows/operators.ts` through the `direct_sync`,
  `grouped_rollup`, and `sync_related_field` surfaces.
- Runtime propagation remains covered by `src/runtime/workflow-dependency-index.ts`,
  `src/runtime/workflow-runtime.ts`, `src/runtime/workflow-operations.ts`, and
  `src/runtime/aggregate-maintenance.ts`, including changed-field routing,
  sync recompute, aggregate recompute, and manual `backfill` initialization.
- Extensible rolling operations remain represented by
  `src/core/aggregates/registry.ts` and the aggregate operation metadata used by
  computed rollup field config and workflow aggregate definitions.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity is still out of scope for this checkpoint
  because it does not directly block this identity/reactive workflow goal.

## Verification

Run from the CloudTable workspace on 2026-06-27:

```bash
npm run typecheck
```

Result: passed.

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|reactive_rollup_batch_backfill"
```

Result: passed. Three test files passed, with 11 selected tests passing and 185
tests skipped by the focused filter.

## Recommendation

Close [CLO-2507](/CLO/issues/CLO-2507) as done. Do not create another
identity/reactive implementation issue from this checkpoint. Keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing active OAuth/deployment
hardening review path unless a future driver finds a concrete failing
verification target or non-duplicative product gap.
