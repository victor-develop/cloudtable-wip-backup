# CLO-2603 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2603](/CLO/issues/CLO-2603)
Parent: [CLO-2602](/CLO/issues/CLO-2602) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation or QA slice is warranted after
[CLO-2601](/CLO/issues/CLO-2601).

The current code state and issue tree still support the required goal surface:
Google login, organization/workspace invitations, multi-workspace session
selection, declarative direct cross-table sync, grouped rolling computed columns,
extensible aggregate operations, dependency indexing, workflow service identity,
and manual batch backfill/recompute maintenance.

The standing live lane remains [CLO-2321](/CLO/issues/CLO-2321), which is still
`in_review` for production OAuth/deployment hardening. Its implementation and QA
children [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323) are `done`, so this is a review/hardening path,
not a new backend identity/reactive implementation gap.

## Evidence

- [CLO-2601](/CLO/issues/CLO-2601) is `done` and already concluded no fresh
  bounded implementation or QA child was needed after [CLO-2597](/CLO/issues/CLO-2597).
- Current issue inspection found:
  - [CLO-2597](/CLO/issues/CLO-2597) is `done`.
  - [CLO-2321](/CLO/issues/CLO-2321) is `in_review`.
  - [CLO-2322](/CLO/issues/CLO-2322) and [CLO-2323](/CLO/issues/CLO-2323) are `done`.
- Current source inspection still shows:
  - Google OAuth login/callback, auth readiness, sessions, invitations, and active
    workspace/session handling in `src/runtime/worker.ts`.
  - Organization/workspace membership and invitation persistence in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` authoring metadata in
    `src/core/workflows/authoring.ts`.
  - Cross-table sync operator support in `src/core/workflows/operators.ts`.
  - Registry-backed aggregate operations including `sum_numbers`, `max_number`,
    and `average_numbers` in `src/core/aggregates/registry.ts`.
  - Reactive routing for aggregate, lookup, sync, trigger, and resolver dependencies
    in `src/runtime/workflow-dependency-index.ts`.
  - Manual aggregate/sync maintenance paths for backfill and recompute in
    `src/runtime/worker.ts`, `src/runtime/workflow-runtime.ts`, and
    `src/runtime/aggregate-maintenance.ts`.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was intentionally not reopened because it does
  not directly unblock the identity/reactive workflow target.

## Verification

Run from the CloudTable workspace on 2026-06-27:

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|invited_member_reactive_read_parity_contract|reactive_rollup_batch_backfill|workflow_service_identity_reactive_maintenance_writes"
```

Result: passed. Three test files passed, with 13 selected tests passing and
183 skipped by the focused filter.

## Recommendation

Close [CLO-2603](/CLO/issues/CLO-2603) as done. Do not create another
identity/reactive implementation or QA child from this checkpoint. Let
[CLO-2602](/CLO/issues/CLO-2602) resume automatically, and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review path.
