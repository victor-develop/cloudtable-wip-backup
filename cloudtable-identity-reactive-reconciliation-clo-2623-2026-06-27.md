# CLO-2623 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2623](/CLO/issues/CLO-2623)
Parent: [CLO-2622](/CLO/issues/CLO-2622) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation or QA slice is warranted after
[CLO-2619](/CLO/issues/CLO-2619).

The active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
reactive data workflows`. The current code and focused tests still cover the
required capability surface: Google login/session readiness, invitations across
organizations and workspaces, active workspace selection, declarative direct
cross-table sync, grouped rolling computed columns, extensible aggregate
operations, workflow dependency routing, workflow service identity, and manual
batch backfill/recompute maintenance.

The only live lane found after [CLO-2619](/CLO/issues/CLO-2619) remains the
standing production OAuth/deployment hardening review path:
[CLO-2321](/CLO/issues/CLO-2321). Its implementation and validation children,
[CLO-2322](/CLO/issues/CLO-2322) and [CLO-2323](/CLO/issues/CLO-2323), were
already done in the prior reconciliation baseline. [CLO-2620](/CLO/issues/CLO-2620)
and [CLO-2621](/CLO/issues/CLO-2621) are blocked by that existing review lane,
not by a newly discovered backend identity/reactive gap.

## Evidence

- [CLO-2622](/CLO/issues/CLO-2622) is blocked only by this reconciliation child,
  [CLO-2623](/CLO/issues/CLO-2623), and is attached to the active goal
  `d6d73d1d-9a36-4411-a8b3-508859276d79`.
- Active issue inspection for the goal found [CLO-2620](/CLO/issues/CLO-2620)
  and [CLO-2621](/CLO/issues/CLO-2621) blocked on
  [CLO-2321](/CLO/issues/CLO-2321), while [CLO-2618](/CLO/issues/CLO-2618) and
  [CLO-2619](/CLO/issues/CLO-2619) are done.
- [CLO-2619](/CLO/issues/CLO-2619) already concluded there was no fresh bounded,
  non-duplicative identity/reactive implementation or QA slice after
  [CLO-2617](/CLO/issues/CLO-2617), with typecheck and focused test evidence.
- Source inspection still shows:
  - Google OAuth login/callback, auth readiness, signed sessions, invitations,
    and active workspace/session handling in `src/runtime/worker.ts`.
  - Organization/workspace invitation persistence and acceptance in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring metadata in
    `src/core/workflows/authoring.ts` and `src/core/workflows/types.ts`.
  - Reactive dependency indexing and routing in
    `src/runtime/workflow-dependency-index.ts` and
    `src/runtime/workflow-runtime.ts`.
  - Registry-backed aggregate operations, including `count_records`,
    `sum_numbers`, `max_number`, and `average_numbers`, in
    `src/core/aggregates/registry.ts`.
  - Manual aggregate/sync backfill and recompute maintenance in
    `src/runtime/workflow-runtime.ts` and related runtime ingress coverage.
  - Workflow service identity fail-closed behavior in
    `src/core/workflows/service-identity.ts` and runtime tests.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  block this identity/reactive workflow goal.

## Verification

Run from the CloudTable workspace on 2026-06-27:

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|invited_member_reactive_read_parity_contract|reactive_rollup_batch_backfill|workflow_service_identity_reactive_maintenance_writes"
```

Result: passed. Three test files passed, with 13 selected tests passing and
183 skipped by the focused filter.

## Recommendation

Close [CLO-2623](/CLO/issues/CLO-2623) as `done`. Do not create another
identity/reactive implementation or QA child from this checkpoint. Let
[CLO-2622](/CLO/issues/CLO-2622) resume through its blocker link and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review lane.
