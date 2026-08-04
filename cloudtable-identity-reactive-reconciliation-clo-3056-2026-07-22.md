# CLO-3056 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-22 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3056](/CLO/issues/CLO-3056)
Parent: [CLO-3055](/CLO/issues/CLO-3055) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative identity/reactive backend implementation
slice is warranted after [CLO-3054](/CLO/issues/CLO-3054).

[CLO-3054](/CLO/issues/CLO-3054) already reconciled the same capability goal
after [CLO-3052](/CLO/issues/CLO-3052). This pass re-checked the current issue
tree, the local CloudTable code surface, and focused verification. Nothing
material changed that creates a new technical slice.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`,
  `Identity and reactive data workflows`.
- Current active/blocking goal state includes the current
  [CLO-3055](/CLO/issues/CLO-3055) -> [CLO-3056](/CLO/issues/CLO-3056)
  blocker pair. No newer concrete backend identity/reactive implementation
  child appeared after the [CLO-3054](/CLO/issues/CLO-3054) handoff.
- [CLO-2930](/CLO/issues/CLO-2930), `Add routed aggregate permission-restore
  remediation coverage`, remains a pre-existing routed aggregate coverage lane,
  not a new identity/reactive implementation slice to duplicate here.
- The live rollout continuation lane remains unchanged:
  - [CLO-2648](/CLO/issues/CLO-2648) is still `blocked`: `Configure CloudTable
    production hostname and Google OAuth callback`.
  - [CLO-2647](/CLO/issues/CLO-2647) is still `in_review`: `Configure
    CloudTable production domain and Google OAuth callback origin`, blocked by
    [CLO-2648](/CLO/issues/CLO-2648).
  - [CLO-2646](/CLO/issues/CLO-2646) is still `blocked`: `Coordinate
    CloudTable credentialed production rollout readiness`, blocked by
    [CLO-2647](/CLO/issues/CLO-2647).
- Current code still represents the required capability surface:
  - Google OAuth/login, invitation handling, session cookies, active workspace
    selection, tenant bootstrap, and membership ingress in `src/runtime/worker.ts`
    and `src/durable-objects/workspace-control.ts`.
  - Tenant, invitation, membership, session, workflow, dependency, and
    maintenance persistence in `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring metadata in
    `src/core/workflows/authoring.ts` and `src/core/workflows/types.ts`.
  - Workflow dependency indexing in `src/runtime/workflow-dependency-index.ts`
    and workflow operation/disposition helpers in
    `src/runtime/workflow-operations.ts`.
  - Manual and queued aggregate, lookup, and sync maintenance in
    `src/runtime/workflow-runtime.ts`, `src/runtime/aggregate-maintenance.ts`,
    `src/runtime/bootstrap.ts`, and `src/runtime/worker.ts`.
  - Registry-backed aggregate operations in `src/core/aggregates/registry.ts`.
  - Focused regression coverage for invited-member sync/rollups, Google
    callback invite acceptance, workspace switching, service-identity
    maintenance writes, batch backfill, average/max/value-match rollups, and
    dependency indexing.
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

Close [CLO-3056](/CLO/issues/CLO-3056) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3055](/CLO/issues/CLO-3055) resume through its first-class blocker link
with this no-new-slice disposition, while [CLO-2648](/CLO/issues/CLO-2648),
[CLO-2647](/CLO/issues/CLO-2647), and [CLO-2646](/CLO/issues/CLO-2646)
continue to carry the real production hostname / Google OAuth callback unblock
path.
