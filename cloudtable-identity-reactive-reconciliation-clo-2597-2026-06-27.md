# CLO-2597 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2597](/CLO/issues/CLO-2597)
Parent: [CLO-2596](/CLO/issues/CLO-2596) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation or QA slice exists after
[CLO-2595](/CLO/issues/CLO-2595).

The active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
reactive data workflows`. Current code and focused tests continue to cover the
required identity/reactive capability surface: Google login, organization and
workspace invitations, multi-organization/workspace membership with active
workspace selection, declarative cross-table direct sync, grouped rolling
compute operations, extensible operator/aggregate registries, dependency
indexing, and batch initialize/backfill or recompute maintenance.

The only live non-duplicative lane remains [CLO-2321](/CLO/issues/CLO-2321),
which is `in_review` for production OAuth/deployment hardening. Current active
goal inspection also shows [CLO-2596](/CLO/issues/CLO-2596) is blocked only on
this reconciliation child, [CLO-2597](/CLO/issues/CLO-2597), so closing this
checkpoint should let the parent driver resume.

## Evidence

- [CLO-2595](/CLO/issues/CLO-2595) is `done` and reached the same no-new-slice
  conclusion earlier on 2026-06-27.
- Active goal inspection found [CLO-2321](/CLO/issues/CLO-2321) still
  `in_review`; this remains the existing production OAuth/deployment hardening
  review path rather than a new backend identity/reactive implementation gap.
- Current source inspection still shows:
  - Google OAuth login/callback, auth readiness, signed sessions, invitation
    issuance/acceptance, active workspace switching, and membership ingress in
    `src/runtime/worker.ts`.
  - Invitation and workspace/organization membership persistence in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring metadata in
    `src/core/workflows/authoring.ts`.
  - Cross-table `sync_related_field` operator metadata in
    `src/core/workflows/operators.ts`.
  - Registry-backed aggregate operations including `sum_numbers` in
    `src/core/aggregates/registry.ts`.
  - Reactive dependency indexing for sync and aggregate routing in
    `src/runtime/workflow-dependency-index.ts`.
  - Manual aggregate/sync backfill and recompute ingress in
    `src/runtime/worker.ts`, `src/runtime/workflow-runtime.ts`, and
    `src/runtime/aggregate-maintenance.ts`.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  block the identity/reactive workflow target.

## Verification

Run from the CloudTable workspace on 2026-06-27:

```bash
npm run typecheck
```

Result: passed.

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|invited_member_reactive_read_parity_contract|reactive_rollup_batch_backfill|workflow_service_identity_reactive_maintenance_writes"
```

Result: passed. Three test files passed, with 13 selected tests passing and
183 tests skipped by the focused filter.

## Recommendation

Close [CLO-2597](/CLO/issues/CLO-2597) as done. Do not create another
identity/reactive implementation or QA child from this checkpoint. Let
[CLO-2596](/CLO/issues/CLO-2596) resume automatically, and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review path.
