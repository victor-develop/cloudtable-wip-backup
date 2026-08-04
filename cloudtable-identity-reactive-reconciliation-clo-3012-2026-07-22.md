# CLO-3012 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-22 HKT / 2026-07-21 UTC
Goal: Identity and reactive data workflows
Issue: [CLO-3012](/CLO/issues/CLO-3012)
Parent: [CLO-3011](/CLO/issues/CLO-3011) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative identity/reactive implementation slice is
warranted for [CLO-3011](/CLO/issues/CLO-3011).

The current repository and active issue tree still show the required capability
surface as represented: Google login and callback handling, invited users across
organizations/workspaces, session workspace selection, declarative direct
cross-table sync, grouped rolling computed columns, value-match resolver support,
extensible aggregate operations, explicit workflow service identity, and batch
initialize/backfill/recompute maintenance.

Current movement should remain on the production hostname / Google OAuth
callback readiness lane rather than another backend identity/reactive child.
Opening a new child from this checkpoint would duplicate existing runtime,
authoring, maintenance, and OAuth/deployment work.

## Evidence

- [CLO-3011](/CLO/issues/CLO-3011) is blocked by this reconciliation child,
  [CLO-3012](/CLO/issues/CLO-3012).
- The active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- Active nonterminal issue inspection still identifies the operational rollout
  lane as the live continuation:
  - [CLO-2646](/CLO/issues/CLO-2646) is blocked by
    [CLO-2647](/CLO/issues/CLO-2647) for credentialed production rollout
    readiness.
  - [CLO-2647](/CLO/issues/CLO-2647) is in review and blocked by
    [CLO-2648](/CLO/issues/CLO-2648) for production domain / Google OAuth
    callback origin readiness.
  - [CLO-2648](/CLO/issues/CLO-2648) remains blocked on the concrete operator
    action: provide or confirm the real CloudTable production hostname under a
    Cloudflare-managed zone, provide or authorize the real Google OAuth client,
    and register the exact callback URL.
- The immediately preceding CTO reconciliation,
  [CLO-3010](/CLO/issues/CLO-3010), reached the same no-new-backend-slice
  disposition and passed focused verification. This heartbeat found no new code
  or goal-tree evidence that changes that conclusion.
- Current source inspection shows:
  - Google OAuth login/callback, identity linking, signed sessions, invitation
    acceptance, active workspace selection, and membership hydration in
    `src/runtime/worker.ts`.
  - Tenant, invitation, membership, and session persistence in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` authoring metadata in
    `src/core/workflows/authoring.ts` and `src/core/workflows/types.ts`.
  - Workflow dependency routing for aggregate, lookup, sync, trigger, resolver,
    and `value_match` field dependencies in
    `src/runtime/workflow-dependency-index.ts`.
  - Manual and queued aggregate/lookup/sync maintenance, with service identity
    fail-closed handling, in `src/runtime/worker.ts`,
    `src/runtime/workflow-runtime.ts`, and
    `src/runtime/aggregate-maintenance.ts`.
  - Registry-backed aggregate operators in `src/core/aggregates/registry.ts`,
    including `count_records`, `sum_numbers`, `min_number`, `max_number`, and
    `average_numbers`.
  - Regression contracts for invitation-backed sync, invited-member read parity,
    workflow service identity, batch backfill, average/max rollups, and
    value-match max rollups in
    `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  block this identity/reactive workflow goal.

## Verification

Focused verification run from the CloudTable workspace:

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|cross_org_invited_member_workspace_selection_reactive_contract|invited_member_reactive_read_parity_contract|reactive_rollup_batch_backfill|workflow_service_identity_reactive_maintenance_writes preserve workflow principal metadata|reactive_max_rollup_publish_and_recompute|reactive_average_rollup_publish_and_recompute|reactive_value_match_max_rollup_publish_and_recompute|workflow_service_identity_reactive_maintenance_requires_explicit_metadata"
```

Result: passed. Three test files passed, with 15 selected tests passing and
187 skipped by the focused filter.

## Recommendation

Close [CLO-3012](/CLO/issues/CLO-3012) as `done`. Do not create a new
identity/reactive implementation child from this checkpoint. Let
[CLO-3011](/CLO/issues/CLO-3011) resume through its first-class blocker link
with the recommendation that the goal has no fresh backend slice at this time
and the existing production hostname / Google OAuth callback lane owns next
movement.
