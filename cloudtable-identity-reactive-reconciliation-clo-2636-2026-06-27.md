# CLO-2636 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2636](/CLO/issues/CLO-2636)
Parent: [CLO-2635](/CLO/issues/CLO-2635) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation or QA slice is warranted after
[CLO-2635](/CLO/issues/CLO-2635).

The active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
reactive data workflows`. Current source and focused verification still cover
the requested capability surface: Google login/session readiness, invitations
across organizations and workspaces, active workspace selection, declarative
direct cross-table sync, grouped rolling computed columns, extensible aggregate
operations, workflow dependency routing, workflow service identity, and batch
backfill/recompute maintenance.

The only adjacent open path remains [CLO-2321](/CLO/issues/CLO-2321), the
standing production OAuth/deployment hardening review lane. Its implementation
and validation children, [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323), are already done. Opening another
OAuth/deployment, identity, or reactive-workflow child from this checkpoint
would duplicate existing routed work.

## Evidence

- [CLO-2635](/CLO/issues/CLO-2635) is blocked only by this reconciliation child,
  [CLO-2636](/CLO/issues/CLO-2636).
- [CLO-2634](/CLO/issues/CLO-2634) and its parent
  [CLO-2633](/CLO/issues/CLO-2633) completed minutes earlier with the same
  technical conclusion and focused verification.
- Active goal issue inspection on 2026-06-27 found:
  - [CLO-2635](/CLO/issues/CLO-2635): `blocked`
  - [CLO-2636](/CLO/issues/CLO-2636): `in_progress`
  - [CLO-2633](/CLO/issues/CLO-2633): `done`
  - [CLO-2634](/CLO/issues/CLO-2634): `done`
  - [CLO-2321](/CLO/issues/CLO-2321): `in_review`
  - [CLO-2322](/CLO/issues/CLO-2322): `done`
  - [CLO-2323](/CLO/issues/CLO-2323): `done`
- Source inspection still shows:
  - Google OAuth/login readiness, signed sessions, invitations, and active
    workspace/session switching in `src/runtime/worker.ts`.
  - Organization/workspace invitation persistence and acceptance in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` authoring contracts in
    `src/core/workflows/authoring.ts` and `src/core/workflows/types.ts`.
  - Reactive dependency routing and maintenance in
    `src/runtime/workflow-dependency-index.ts`,
    `src/runtime/workflow-runtime.ts`, and
    `src/runtime/aggregate-maintenance.ts`.
  - Invited-member sync/read parity, workflow service identity, max rollup, and
    average rollup regression coverage in
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

Close [CLO-2636](/CLO/issues/CLO-2636) as `done`. Do not create another
identity/reactive implementation or QA child from this checkpoint. Let
[CLO-2635](/CLO/issues/CLO-2635) resume through its blocker link, and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review lane.
