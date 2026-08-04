# CLO-3026 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-22 HKT / 2026-07-21 UTC
Goal: Identity and reactive data workflows
Issue: [CLO-3026](/CLO/issues/CLO-3026)
Parent: [CLO-3025](/CLO/issues/CLO-3025) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative identity/reactive implementation issue should
be created from this checkpoint.

The active goal tree and current code still show the multi-tenant identity and
declarative reactive workflow backend surface as represented and covered. The
live remaining continuation is the existing production hostname / Google OAuth
callback readiness lane, not a new backend slice.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- Relevant active issues under the goal include:
  - [CLO-2646](/CLO/issues/CLO-2646), blocked on [CLO-2647](/CLO/issues/CLO-2647).
  - [CLO-2647](/CLO/issues/CLO-2647), in review and blocked by
    [CLO-2648](/CLO/issues/CLO-2648).
  - [CLO-2648](/CLO/issues/CLO-2648), blocked on CEO/operator confirmation and
    provisioning of the real CloudTable production hostname plus Google OAuth
    client/callback registration.
  - [CLO-2930](/CLO/issues/CLO-2930), an older routed aggregate
    permission-restore remediation slice, already represented separately.
- Current code represents the requested capability surface:
  - Google OAuth login/callback, identity linking, signed sessions, invitation
    acceptance, active workspace selection, and membership ingress in
    `src/runtime/worker.ts`.
  - Tenant, invitation, membership, workspace principal, and session persistence
    in `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` authoring metadata in
    `src/core/workflows/authoring.ts` and `src/core/workflows/types.ts`.
  - Workflow dependency routing for aggregate, lookup, sync, trigger, resolver,
    and `value_match` dependencies in `src/runtime/workflow-dependency-index.ts`.
  - Manual and queued aggregate/lookup/sync maintenance, including backfill and
    recompute paths, in `src/runtime/worker.ts`,
    `src/runtime/workflow-runtime.ts`, and `src/runtime/aggregate-maintenance.ts`.
  - Registry-backed aggregate operations, including `count_records`,
    `sum_numbers`, `min_number`, `max_number`, and `average_numbers`, in
    `src/core/aggregates/registry.ts`.
  - Regression coverage for invited-member sync/rollups, Google callback
    invitation acceptance, active workspace switching, invited authoring/readback,
    service-identity writes, batch backfill, average/max rollups, and
    value-match rollups.
- `wrangler.jsonc` still has the placeholder production OAuth redirect host
  `https://cloudtable.example.com/v1/auth/google/callback`, matching the
  existing [CLO-2648](/CLO/issues/CLO-2648) blocker rather than a missing code
  slice.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  block this identity/reactive workflow goal.

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

Close [CLO-3026](/CLO/issues/CLO-3026) as `done`. Do not create another
identity/reactive implementation child from this checkpoint. Let
[CLO-3025](/CLO/issues/CLO-3025) resume through this reconciliation child, while
the real live continuation remains [CLO-2648](/CLO/issues/CLO-2648) for the
production hostname and Google OAuth callback configuration.
