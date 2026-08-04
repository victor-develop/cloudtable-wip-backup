# CLO-2575 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2575](/CLO/issues/CLO-2575)
Parent: [CLO-2574](/CLO/issues/CLO-2574) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice exists after the latest
driver loop.

[CLO-2574](/CLO/issues/CLO-2574) is blocked only by this reconciliation child,
and the current issue state still points to the same live lane:
[CLO-2321](/CLO/issues/CLO-2321) remains `in_review` for production
OAuth/deployment hardening, while [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323) are `done`.

Creating another implementation issue from this checkpoint would duplicate
existing identity, workflow-authoring, dependency-routing, maintenance, or
OAuth hardening work.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- Current issue state checked during this heartbeat:
  - [CLO-2574](/CLO/issues/CLO-2574) is `blocked` by
    [CLO-2575](/CLO/issues/CLO-2575).
  - [CLO-2321](/CLO/issues/CLO-2321) is `in_review`.
  - [CLO-2322](/CLO/issues/CLO-2322) and [CLO-2323](/CLO/issues/CLO-2323) are
    `done`.
- Current source inspection shows:
  - Google OAuth login/callback, signed sessions, tenant listing, invitation
    issuance/acceptance, workspace membership checks, active workspace
    selection, and session switching in `src/runtime/worker.ts`.
  - Invitation, auth-session, organization-membership, and workspace-membership
    persistence in `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring in
    `src/core/workflows/authoring.ts`, with recipe types and maintenance kinds
    in `src/core/workflows/types.ts`.
  - Cross-table `sync_related_field` operator metadata in
    `src/core/workflows/operators.ts`.
  - Reactive dependency routing for aggregate, lookup, sync, trigger, and
    resolver entries in `src/runtime/workflow-dependency-index.ts`.
  - Direct sync and aggregate maintenance/backfill/recompute ingress in
    `src/runtime/worker.ts`, with runtime handling in
    `src/runtime/workflow-runtime.ts`, `src/runtime/workflow-operations.ts`, and
    coordinator-owned writes in `src/runtime/aggregate-maintenance.ts`.
  - Registry-backed rolling compute operations in
    `src/core/aggregates/registry.ts`: `count_records`, `sum_numbers`,
    `max_number`, and `average_numbers`.
- Field-type proposal-hint parity remains outside this driver because it does
  not directly block the identity/reactive workflow capability target.

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

```bash
git diff --check
```

Result: passed.

## Recommendation

Close [CLO-2575](/CLO/issues/CLO-2575) as done. Do not create a new
identity/reactive implementation child from this checkpoint. Let
[CLO-2574](/CLO/issues/CLO-2574) resume with this evidence, and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review path.
