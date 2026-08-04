# CLO-3058 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-22 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3058](/CLO/issues/CLO-3058)
Parent: [CLO-3057](/CLO/issues/CLO-3057) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative identity/reactive backend implementation
slice is warranted after [CLO-3056](/CLO/issues/CLO-3056).

[CLO-3056](/CLO/issues/CLO-3056) already reconciled the same capability goal
after [CLO-3054](/CLO/issues/CLO-3054). This pass re-checked the current issue
tree, the local CloudTable code surface, and focused verification. I found no
material change that creates a new technical implementation child.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`,
  `Identity and reactive data workflows`.
- Current active/blocking goal state includes the current
  [CLO-3057](/CLO/issues/CLO-3057) -> [CLO-3058](/CLO/issues/CLO-3058)
  blocker pair. [CLO-3054](/CLO/issues/CLO-3054) and
  [CLO-3056](/CLO/issues/CLO-3056) are complete reconciliation checkpoints,
  not open implementation slices.
- [CLO-2930](/CLO/issues/CLO-2930), `Add routed aggregate permission-restore
  remediation coverage`, remains a pre-existing blocked routed aggregate
  coverage lane. It should not be duplicated from this reconciliation.
- The standing production rollout lane remains the known unblock path from the
  parent scope: [CLO-2648](/CLO/issues/CLO-2648),
  [CLO-2647](/CLO/issues/CLO-2647), and [CLO-2646](/CLO/issues/CLO-2646)
  carry production hostname / Google OAuth callback rollout readiness.
- Current code still represents the required capability surface:
  - Google OAuth callback handling, invitation acceptance, tenant bootstrap,
    active workspace selection, workspace switching, and membership ingress in
    `src/runtime/worker.ts`.
  - Invitation, membership, active session workspace, workflow, dependency, and
    maintenance persistence in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring metadata in
    `src/core/workflows/authoring.ts` and `src/core/workflows/types.ts`.
  - Workflow dependency indexing in `src/runtime/workflow-dependency-index.ts`
    and its runtime/bootstrap hooks in `src/runtime/bootstrap.ts`,
    `src/runtime/worker.ts`, and `src/runtime/workflow-runtime.ts`.
  - Manual and queued aggregate, lookup, and sync maintenance in
    `src/runtime/workflow-runtime.ts`, `src/runtime/aggregate-maintenance.ts`,
    `src/runtime/workflow-operations.ts`, and `src/runtime/bootstrap.ts`.
  - Registry-backed aggregate operations in `src/core/aggregates/registry.ts`
    and agent-visible workflow maintenance tools in
    `src/core/agent-tools/registry.ts`.
- Focused tests cover recipe metadata, Google invitation callback flows,
  active workspace switching, invited-member reactive sync/rollups, service
  identity maintenance writes, batch backfill, average/max/value-match rollups,
  and dependency indexing.
- The workspace remains dirty with broad pre-existing CloudTable implementation
  changes and historical reconciliation artifacts. This reconciliation added
  only this report and did not revert or modify unrelated product code.
- Row-owner and extensible-condition groundwork remains completed. Field-type
  proposal-hint parity was not reopened because no current evidence shows it
  directly blocks the identity/reactive workflow goal.

## Verification

```bash
npm run --silent typecheck
```

Result: passed.

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts testing/cloudtable/suites/runtime/workflow-dependency-index.spec.ts -t "canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|cross_org_invited_member_workspace_selection_reactive_contract|invited_member_reactive_read_parity_contract|invited_session_recipe_authoring_reactive_journey|reactive_rollup_batch_backfill|workflow_service_identity_reactive_maintenance_writes preserve workflow principal metadata|reactive_max_rollup_publish_and_recompute|reactive_average_rollup_publish_and_recompute|reactive_value_match_max_rollup_publish_and_recompute|workflow_service_identity_reactive_maintenance_requires_explicit_metadata|workflow dependency index"
```

Result: passed. Four test files passed, with 18 selected tests passing and
186 skipped by the focused filter.

## Recommendation

Close [CLO-3058](/CLO/issues/CLO-3058) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3057](/CLO/issues/CLO-3057) resume through its first-class blocker link
with this no-new-slice disposition, while the production hostname / Google
OAuth callback rollout lane continues to carry the real external unblock path.
