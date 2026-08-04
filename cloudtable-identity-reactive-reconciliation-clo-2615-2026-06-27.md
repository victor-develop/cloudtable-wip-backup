# CLO-2615 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2615](/CLO/issues/CLO-2615)
Parent: [CLO-2614](/CLO/issues/CLO-2614) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation or QA slice is warranted after
[CLO-2611](/CLO/issues/CLO-2611).

The active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
reactive data workflows`. The current code and focused tests still cover the
required capability surface: Google login/session readiness, invited users
across organizations and workspaces, active workspace selection, declarative
cross-table direct sync, grouped rolling computed columns, extensible aggregate
operations, workflow dependency routing, workflow service identity, and manual
batch backfill/recompute maintenance.

The standing live lane remains [CLO-2321](/CLO/issues/CLO-2321), which is still
`in_review` for production OAuth/deployment hardening. That is an existing
review/hardening path, not a fresh backend identity/reactive implementation gap.

## Evidence

- [CLO-2611](/CLO/issues/CLO-2611) is `done` and recorded no fresh bounded,
  non-duplicative identity/reactive implementation or QA slice after
  [CLO-2609](/CLO/issues/CLO-2609).
- [CLO-2613](/CLO/issues/CLO-2613) is also `done` after the CLO-2611 checkpoint
  and recorded the same no-new-slice conclusion with focused verification.
- Active goal inspection found [CLO-2614](/CLO/issues/CLO-2614) blocked only on
  this reconciliation child, [CLO-2615](/CLO/issues/CLO-2615).
- Current source inspection still shows:
  - Auth readiness, Google OAuth login/callback, signed session, invitation, and
    active workspace/session handling in `src/runtime/worker.ts`.
  - Workflow recipe catalog/read/preview/create ingress for `direct_sync` and
    `grouped_rollup` in `src/runtime/worker.ts` and
    `src/core/workflows/authoring.ts`.
  - Cross-table sync operator support in `src/core/workflows/operators.ts`.
  - Reactive dependency routing for aggregate, lookup, sync, trigger, and
    resolver dependencies in `src/runtime/workflow-dependency-index.ts`.
  - Registry-backed aggregate operations, including `sum_numbers`,
    `max_number`, and `average_numbers`, in `src/core/aggregates/registry.ts`.
  - Coordinator-owned aggregate/sync/lookup backfill and recompute maintenance
    in `src/runtime/workflow-runtime.ts` and
    `src/runtime/aggregate-maintenance.ts`.
  - Workflow service identity fail-closed behavior for maintenance writes in
    `src/runtime/workflow-runtime.ts`.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  block identity/reactive workflow progress.

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
183 skipped by the focused filter.

## Recommendation

Close [CLO-2615](/CLO/issues/CLO-2615) as `done`. Do not create another
identity/reactive implementation or QA child from this checkpoint. Let
[CLO-2614](/CLO/issues/CLO-2614) resume through its blocker link and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review lane.
