# CLO-3018 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-22 HKT / 2026-07-21 UTC
Goal: Identity and reactive data workflows
Issue: [CLO-3018](/CLO/issues/CLO-3018)
Parent: [CLO-3017](/CLO/issues/CLO-3017) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative identity/reactive implementation slice is
warranted after [CLO-3017](/CLO/issues/CLO-3017).

[CLO-3017](/CLO/issues/CLO-3017) is blocked only by this reconciliation child,
[CLO-3018](/CLO/issues/CLO-3018), and did not introduce new code or goal-tree
evidence beyond the immediately preceding completed reconciliation
[CLO-3016](/CLO/issues/CLO-3016). Current movement should remain on the existing
production hostname / Google OAuth callback readiness lane rather than another
backend identity/reactive child.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- Recent completed reconciliations [CLO-3008](/CLO/issues/CLO-3008),
  [CLO-3010](/CLO/issues/CLO-3010), [CLO-3012](/CLO/issues/CLO-3012),
  [CLO-3014](/CLO/issues/CLO-3014), and [CLO-3016](/CLO/issues/CLO-3016) all
  reached the same no-new-backend-slice disposition after focused verification.
- Source inspection still shows the represented capability surface:
  - Google OAuth login/callback, identity linking, signed sessions, invitation
    acceptance, active workspace selection, and membership hydration in
    `src/runtime/worker.ts`.
  - Tenant, invitation, membership, workspace principal, and session persistence
    in `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` authoring metadata in
    `src/core/workflows/authoring.ts` and `src/core/workflows/types.ts`.
  - Workflow dependency routing for aggregate, lookup, sync, trigger, resolver,
    and `value_match` field dependencies in
    `src/runtime/workflow-dependency-index.ts`.
  - Manual and queued aggregate/lookup/sync maintenance, including backfill and
    recompute endpoints, in `src/runtime/worker.ts`,
    `src/runtime/workflow-runtime.ts`, and
    `src/runtime/aggregate-maintenance.ts`.
  - Registry-backed aggregate operations, including `count_records`,
    `sum_numbers`, `min_number`, `max_number`, and `average_numbers`, in
    `src/core/aggregates/registry.ts`.
  - Regression contracts for invitation-backed sync/rollups, invited-member
    read parity, invited authoring/readback journey, workflow service identity,
    batch backfill, average/max rollups, and value-match max rollups in
    `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.
- Active operational continuation remains the existing production hostname /
  Google OAuth callback lane:
  - [CLO-2646](/CLO/issues/CLO-2646) is blocked by
    [CLO-2647](/CLO/issues/CLO-2647).
  - [CLO-2647](/CLO/issues/CLO-2647) is in review for production domain and
    Google OAuth callback readiness.
  - [CLO-2648](/CLO/issues/CLO-2648) remains blocked on operator action to
    confirm/provision the production hostname and Google OAuth callback origin.
- The workspace has pre-existing dirty files and numerous untracked historical
  reconciliation artifacts. This pass did not revert or modify unrelated
  product code.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  block this identity/reactive workflow goal.

## Verification

Focused verification run from the CloudTable workspace:

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

Close [CLO-3018](/CLO/issues/CLO-3018) as `done`. Do not create a new
identity/reactive implementation child from this checkpoint. Let
[CLO-3017](/CLO/issues/CLO-3017) resume through its first-class blocker link
with the recommendation that the goal has no fresh backend slice at this time
and the existing production hostname / Google OAuth callback lane owns next
movement.
