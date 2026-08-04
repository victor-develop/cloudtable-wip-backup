# CLO-2595 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2595](/CLO/issues/CLO-2595)
Parent: [CLO-2594](/CLO/issues/CLO-2594) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation or QA slice exists after
[CLO-2593](/CLO/issues/CLO-2593).

The active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
reactive data workflows`. Current code and focused tests continue to cover the
required identity/reactive surface: Google login, organization/workspace
invitations, multi-organization/workspace membership and active workspace
selection, declarative cross-table sync, grouped rolling compute operations,
extensible aggregate/operator registries, and batch initialize/backfill or
recompute maintenance.

The only live non-duplicative lane remains [CLO-2321](/CLO/issues/CLO-2321),
which is `in_review` for production OAuth/deployment hardening. Its concrete
children [CLO-2322](/CLO/issues/CLO-2322) and [CLO-2323](/CLO/issues/CLO-2323)
are both `done`, and CLO-2321 is waiting on the existing plan/review path rather
than new backend identity/reactive implementation work.

## Evidence

- [CLO-2593](/CLO/issues/CLO-2593) reached the same conclusion earlier on
  2026-06-27 and remains the immediate prior reconciliation checkpoint.
- [CLO-2321](/CLO/issues/CLO-2321) is still `in_review`; its continuation
  summary records completed children and a pending plan confirmation/review
  path.
- [CLO-2322](/CLO/issues/CLO-2322), production OAuth/session deployment config
  hardening, is `done`.
- [CLO-2323](/CLO/issues/CLO-2323), production OAuth hardening validation on
  Cloudflare, is `done`.
- Current source inspection still shows:
  - Google OAuth login/callback, auth readiness, signed sessions, invitation
    issuance/acceptance, membership listing, active workspace switching, and
    production redirect-origin policy in `src/runtime/worker.ts`.
  - Invitation and workspace/organization membership persistence in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring metadata in
    `src/core/workflows/authoring.ts`.
  - Recipe and maintenance kinds in `src/core/workflows/types.ts`.
  - Cross-table `sync_related_field` operator metadata in
    `src/core/workflows/operators.ts`.
  - Registry-backed aggregate operations including `count_records`,
    `sum_numbers`, `max_number`, and `average_numbers` in
    `src/core/aggregates/registry.ts`.
  - Reactive dependency indexing for sync and aggregate routing in
    `src/runtime/workflow-dependency-index.ts`.
  - Manual aggregate/sync backfill and recompute ingress in
    `src/runtime/worker.ts`, with runtime/coordinator handling in
    `src/runtime/workflow-runtime.ts` and
    `src/runtime/aggregate-maintenance.ts`.
- Prior row-owner and extensible-condition work remains completed groundwork; it
  does not create a fresh implementation gap for this identity/reactive goal.
- Field-type proposal-hint parity was intentionally not reopened because it does
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

## Recommendation

Close [CLO-2595](/CLO/issues/CLO-2595) as done. Do not create another
identity/reactive implementation or QA child from this checkpoint. Let
[CLO-2594](/CLO/issues/CLO-2594) resume with this evidence, and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review path.
