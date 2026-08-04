# CLO-2593 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2593](/CLO/issues/CLO-2593)
Parent: [CLO-2592](/CLO/issues/CLO-2592) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation or QA slice exists after
[CLO-2591](/CLO/issues/CLO-2591).

The active goal is still `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
reactive data workflows`. Current source and focused verification continue to
cover the required identity/reactive capability surface: Google login, invited
users across organizations/workspaces, declarative cross-table direct sync,
grouped rolling computed columns with extensible aggregate operations, and
reactive backfill/recompute paths.

The only live non-duplicative lane remains [CLO-2321](/CLO/issues/CLO-2321),
which is `in_review` for production OAuth/deployment hardening. Its concrete
implementation and QA children, [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323), are already `done`.

## Evidence

- [CLO-2591](/CLO/issues/CLO-2591) is `done` and reached the same conclusion for
  the prior driver cycle.
- [CLO-2321](/CLO/issues/CLO-2321) remains `in_review`; its comments record
  completed backend hardening and QA validation, with only the plan/review path
  still pending.
- Current source inspection shows:
  - Google OAuth login/callback, `/readyz` auth readiness, signed sessions,
    active workspace selection, invitation issuance, and workspace membership
    ingress in `src/runtime/worker.ts`.
  - Production redirect-origin policy and auth config validation in
    `src/runtime/worker.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring metadata in
    `src/core/workflows/authoring.ts`.
  - Cross-table `sync_related_field` operator metadata in
    `src/core/workflows/operators.ts`.
  - Registry-backed aggregate operations including `sum_numbers` in
    `src/core/aggregates/registry.ts`.
  - Backfill/recompute request handling in `src/runtime/workflow-runtime.ts` and
    coordinator-owned maintenance in `src/runtime/aggregate-maintenance.ts`.
  - Workflow dependency indexing for reactive sync and aggregate routing in
    `src/runtime/workflow-dependency-index.ts`.
- Field-type proposal-hint parity remains outside this driver because it does
  not directly block identity/reactive workflow progress.

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

Close [CLO-2593](/CLO/issues/CLO-2593) as done. Do not create a new
identity/reactive implementation or QA child from this checkpoint. Let
[CLO-2592](/CLO/issues/CLO-2592) resume with this evidence, and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review path.
