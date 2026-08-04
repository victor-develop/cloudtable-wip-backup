# CLO-2651 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-28
Goal: Identity and reactive data workflows
Issue: [CLO-2651](/CLO/issues/CLO-2651)
Parent: [CLO-2650](/CLO/issues/CLO-2650) CloudTable 15-minute project driver

## Disposition

No new backend identity/reactive implementation slice is warranted from this
checkpoint.

The current codebase already covers the active goal surface: Google login,
invited users across organizations and workspaces, active workspace selection,
declarative cross-table sync, grouped rolling computed columns, extensible
aggregate operations, workflow dependency routing, workflow service identity,
and manual batch backfill/recompute.

The only open adjacent path is operational production hostname/OAuth callback
configuration, not architecture reconciliation:

- [CLO-2647](/CLO/issues/CLO-2647) is blocked on production domain and Google
  OAuth callback origin readiness.
- [CLO-2648](/CLO/issues/CLO-2648) is blocked on the same concrete operator
  action: point the intended hostname at the deployed Worker and register the
  exact Google OAuth callback URL.

This blocker should not be treated as a reason to reopen backend identity,
workflow recipe, rolling aggregate, backfill, or deterministic E2E work.

## Goal-Tree Mapping

- Google identity, orgs, workspace invitations: implemented by the Google OAuth
  login/callback/session selection and invitation ingress in
  `src/runtime/worker.ts`, with persistence support in
  `src/core/persistence/cloudtable-d1-repository.ts`; the goal tree shows
  [CLO-2410](/CLO/issues/CLO-2410) done for self-service Google onboarding and
  tenant admin APIs.
- Cross-table reactive sync actions: implemented through `direct_sync` recipe
  authoring, workflow dependency routing, sync maintenance ingress, and
  coordinator-owned maintenance writes in `src/runtime/worker.ts`,
  `src/core/workflows/authoring.ts`, `src/runtime/workflow-dependency-index.ts`,
  and `src/runtime/aggregate-maintenance.ts`.
- Rolling computed columns and aggregate registry: implemented through
  `grouped_rollup`, `WorkflowAggregateDefinition`, dependency indexing, and the
  aggregate registry in `src/core/aggregates/registry.ts`, currently including
  `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- Batch initialize/backfill: implemented by manual aggregate and sync
  maintenance endpoints accepting `backfill` and `recompute`, plus publish-time
  backfill and queue consumer maintenance paths; [CLO-2411](/CLO/issues/CLO-2411)
  is done for workflow dependency graph and batch backfill orchestration.
- Deterministic E2E coverage: covered by workflow authoring, runtime ingress,
  queue consumer, and regression matrix suites, including invited-member
  reactive sync/read parity, rollup backfill/recompute, max/average aggregate
  variants, and workflow service identity fail-closed behavior.

Prior row-owner and extensible-condition work remains completed groundwork.
Field-type proposal-hint parity was not reopened because it does not directly
block this identity/reactive workflow goal.

## Evidence

- Current goal issue inspection found [CLO-2651](/CLO/issues/CLO-2651) as the
  only active reconciliation child. Recent reconciliation checkpoints
  [CLO-2636](/CLO/issues/CLO-2636) and [CLO-2638](/CLO/issues/CLO-2638) are
  done, and production OAuth hardening [CLO-2321](/CLO/issues/CLO-2321) is done.
- Production hostname/OAuth rollout remains separately blocked on
  [CLO-2647](/CLO/issues/CLO-2647) and [CLO-2648](/CLO/issues/CLO-2648); that
  path requires CEO/operator DNS and Google OAuth callback configuration.
- Source inspection on 2026-06-28 confirmed:
  - `/v1/auth/google/login`, `/v1/auth/google/callback`, `/v1/auth/session`,
    `/v1/auth/session/selection`, `/v1/tenants`, workspace invitation, and
    workspace membership ingress in `src/runtime/worker.ts`.
  - `direct_sync` and `grouped_rollup` recipe type handling and workflow
    metadata catalog exposure in `src/runtime/worker.ts` and
    `src/core/workflows/authoring.ts`.
  - Aggregate operation registry entries for `count_records`, `sum_numbers`,
    `max_number`, and `average_numbers` in
    `src/core/aggregates/registry.ts`.
  - Workflow dependency routing for aggregate, lookup, sync, trigger, and
    resolver dependencies in `src/runtime/workflow-dependency-index.ts`.
  - Manual `aggregate-maintenance` and `sync-maintenance` endpoints accepting
    `backfill` and `recompute` in `src/runtime/worker.ts`.
  - Workflow service identity enforcement for reactive maintenance in
    `src/runtime/workflow-runtime.ts` and `src/runtime/aggregate-maintenance.ts`.
- Test inspection found targeted coverage in
  `testing/cloudtable/suites/runtime/ingress.spec.ts` and
  `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts` for
  invitation-backed reactive sync, active workspace switching, authoring
  metadata, rollup backfill/recompute, max/average operations, and service
  identity fail-closed behavior.

## Verification

Run from the CloudTable workspace on 2026-06-28:

```bash
npm run typecheck
```

Result: passed.

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|invited_member_reactive_read_parity_contract|reactive_rollup_batch_backfill|workflow_service_identity_reactive_maintenance_writes|reactive_max_rollup_publish_and_recompute|reactive_average_rollup_publish_and_recompute|workflow_service_identity_reactive_maintenance_requires_explicit_metadata"
```

Result: passed. Three test files passed, with 16 selected tests passing and
180 skipped by the focused filter.

## Recommendation

Close [CLO-2651](/CLO/issues/CLO-2651) as `done`.

Do not create another backend implementation child for identity/reactive
workflows from this checkpoint. If CEO/CTO wants a next bounded slice anyway,
the smallest non-duplicative slice is operational, not architectural:

Title: Complete CloudTable production hostname and Google OAuth callback rollout

Acceptance criteria:

- Confirm the intended production hostname.
- Point that hostname at the deployed Cloudflare Worker.
- Register the exact Google OAuth callback URL for that hostname.
- If the hostname changes, update `GOOGLE_OAUTH_REDIRECT_URI`, redeploy, and
  verify live `/readyz` plus Google auth start redirect origin.

Verification target:

- `npm run typecheck`
- `npm run test:smoke`
- Live `/readyz` on the production hostname

Blocker owner/action: CEO/operator must provide or apply DNS/Cloudflare route
and Google Cloud Console OAuth callback configuration. This is already tracked
by [CLO-2647](/CLO/issues/CLO-2647) and [CLO-2648](/CLO/issues/CLO-2648), so no
new child issue is needed from [CLO-2651](/CLO/issues/CLO-2651).
