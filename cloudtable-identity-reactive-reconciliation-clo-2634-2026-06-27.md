# CLO-2634 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2634](/CLO/issues/CLO-2634)
Parent: [CLO-2633](/CLO/issues/CLO-2633) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation or QA slice is warranted after
[CLO-2632](/CLO/issues/CLO-2632).

The active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
reactive data workflows`. The current code and focused verification still cover
the required capability surface: Google login/session readiness, invitations
across organizations and workspaces, active workspace selection, declarative
direct cross-table sync, grouped rolling computed columns, extensible aggregate
operations, workflow dependency routing, workflow service identity, and batch
backfill/recompute maintenance.

The only adjacent open path remains [CLO-2321](/CLO/issues/CLO-2321), the
standing production OAuth/deployment hardening review lane. Its implementation
and QA children, [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323), are already done, so opening another
OAuth/deployment or backend identity/reactive child here would duplicate
existing routed work.

## Evidence

- [CLO-2634](/CLO/issues/CLO-2634) is the only blocker for
  [CLO-2633](/CLO/issues/CLO-2633).
- [CLO-2632](/CLO/issues/CLO-2632) completed minutes earlier with the same
  technical conclusion and focused verification: no fresh bounded implementation
  or QA slice after [CLO-2630](/CLO/issues/CLO-2630).
- Current issue inspection confirms [CLO-2321](/CLO/issues/CLO-2321) remains
  `in_review`, while [CLO-2322](/CLO/issues/CLO-2322) and
  [CLO-2323](/CLO/issues/CLO-2323) are `done`.
- Source/test inspection still shows:
  - Google OAuth/session/invitation/workspace-selection coverage in
    `src/runtime/worker.ts`, `src/core/persistence/cloudtable-d1-repository.ts`,
    and `testing/cloudtable/suites/runtime/ingress.spec.ts`.
  - Declarative `direct_sync` and `grouped_rollup` authoring contracts in
    `src/core/workflows/authoring.ts`, `src/core/workflows/types.ts`, and
    `testing/cloudtable/suites/workflows/authoring.spec.ts`.
  - Reactive dependency routing and runtime maintenance in
    `src/runtime/workflow-dependency-index.ts`,
    `src/runtime/workflow-runtime.ts`, and
    `src/runtime/aggregate-maintenance.ts`.
  - End-to-end invited-member sync, invited-workspace selection, saved-view
    parity, service identity, and max/average rollup contracts in
    `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  block this identity/reactive workflow goal.

## Verification

Run from the CloudTable workspace on 2026-06-27:

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|cross_org_invited_member_workspace_selection_reactive_contract|invited_member_reactive_read_parity_contract|workflow_service_identity_reactive_maintenance_writes preserve workflow principal metadata|reactive_max_rollup_publish_and_recompute|reactive_average_rollup_publish_and_recompute|workflow_service_identity_reactive_maintenance_requires_explicit_metadata"
```

Result: passed. Three test files passed, with 14 selected tests passing and
182 skipped by the focused filter.

## Recommendation

Close [CLO-2634](/CLO/issues/CLO-2634) as `done`. Do not create another
identity/reactive implementation or QA child from this checkpoint. Let
[CLO-2633](/CLO/issues/CLO-2633) resume through its blocker link, and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review lane.
