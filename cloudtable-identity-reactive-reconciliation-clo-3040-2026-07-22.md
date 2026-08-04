# CLO-3040 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-22 HKT / 2026-07-21 UTC
Goal: Identity and reactive data workflows
Issue: [CLO-3040](/CLO/issues/CLO-3040)
Parent: [CLO-3039](/CLO/issues/CLO-3039) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative identity/reactive backend implementation slice
is warranted after [CLO-3039](/CLO/issues/CLO-3039).

[CLO-3039](/CLO/issues/CLO-3039) delegated this reconciliation and is blocked
only by [CLO-3040](/CLO/issues/CLO-3040). This pass found no new issue-thread,
goal-tree, repo, typecheck, or focused Vitest evidence that changes the latest
no-new-slice conclusion from [CLO-3038](/CLO/issues/CLO-3038) and
[CLO-3034](/CLO/issues/CLO-3034).

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- The active goal issue set still contains historical blocked driver/recovery
  issues plus the current [CLO-3039](/CLO/issues/CLO-3039) ->
  [CLO-3040](/CLO/issues/CLO-3040) blocker pair. No newer concrete backend
  implementation child appeared after this handoff.
- Current code still represents the required capability surface:
  - Google OAuth login/callback, invitation token handling, active workspace
    selection, session cookies, tenant bootstrap, and membership ingress in
    `src/runtime/worker.ts`.
  - Tenant, invitation, membership, session, workflow, dependency, and
    maintenance persistence in `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring metadata in
    `src/core/workflows/authoring.ts` and `src/core/workflows/types.ts`.
  - Workflow dependency indexing in `src/runtime/workflow-dependency-index.ts`
    and workflow operation/disposition helpers in
    `src/runtime/workflow-operations.ts`.
  - Manual and queued aggregate, lookup, and sync maintenance in
    `src/runtime/workflow-runtime.ts`, `src/runtime/aggregate-maintenance.ts`,
    and `src/runtime/worker.ts`.
  - Registry-backed aggregate operations, including count, sum, min, max, and
    average, in `src/core/aggregates/registry.ts`.
  - Regression coverage for invited-member sync/rollups, Google callback invite
    acceptance, workspace switching, service-identity maintenance writes, batch
    backfill, average/max rollups, and value-match rollups in
    `testing/cloudtable/suites/runtime/ingress.spec.ts` and
    `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.
- [CLO-2648](/CLO/issues/CLO-2648) remains the standing live continuation:
  production hostname / Google OAuth callback readiness is still blocked on
  operator-provided hostname, DNS/route, and OAuth client/callback
  configuration, not on a missing backend identity/reactive implementation
  slice.
- Row-owner and extensible-condition groundwork remains completed. Field-type
  proposal-hint parity was not reopened because no evidence shows it directly
  blocks the identity/reactive workflow goal.

## Verification

```bash
npm run --silent typecheck
```

Result: passed.

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|cross_org_invited_member_workspace_selection_reactive_contract|invited_member_reactive_read_parity_contract|invited_session_recipe_authoring_reactive_journey|reactive_rollup_batch_backfill|workflow_service_identity_reactive_maintenance_writes preserve workflow principal metadata|reactive_max_rollup_publish_and_recompute|reactive_average_rollup_publish_and_recompute|reactive_value_match_max_rollup_publish_and_recompute|workflow_service_identity_reactive_maintenance_requires_explicit_metadata"
```

Result: passed. Three test files passed, with 16 selected tests passing and
186 skipped by the focused filter.

## Recommendation

Close [CLO-3040](/CLO/issues/CLO-3040) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3039](/CLO/issues/CLO-3039) resume through its first-class blocker link
with this no-new-slice disposition, while [CLO-2648](/CLO/issues/CLO-2648)
continues to carry the real production hostname / Google OAuth callback unblock
path.
