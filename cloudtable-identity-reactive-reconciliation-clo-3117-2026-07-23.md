# CLO-3117 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-23 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3117](/CLO/issues/CLO-3117)
Parent: [CLO-3116](/CLO/issues/CLO-3116) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-3115](/CLO/issues/CLO-3115).

[CLO-3116](/CLO/issues/CLO-3116) is blocked only by this reconciliation child.
The current repository and active goal/issue state still match the no-new-slice
conclusion from [CLO-3115](/CLO/issues/CLO-3115): the identity/reactive backend
surfaces are represented, and the remaining live continuation is the existing
production hostname / Cloudflare route / Google OAuth callback direction path.

## Capability Reconciliation

- Google login remains represented by `/v1/auth/google/login` and
  `/v1/auth/google/callback` in `src/runtime/worker.ts`, including signed state,
  redirect allow-listing, OAuth exchange, canonical user/session handling, and
  invitation/onboarding context propagation.
- Organization/workspace invitation support remains represented by invitation
  and membership ingress in `src/runtime/worker.ts`, identity persistence in
  `src/core/persistence/types.ts` and
  `src/core/persistence/cloudtable-d1-repository.ts`, and schema tables for
  memberships, invitations, principals, sessions, organizations, and workspaces
  in `migrations/0001_initial_schema.sql`.
- Cross-table sync remains represented by the `direct_sync` workflow recipe,
  sync dependency routing, workflow runtime maintenance requests, and queue
  consumer/ingress coverage for `requestWorkflowSyncMaintenance`.
- Rolling computed columns remain represented by the `grouped_rollup` workflow
  recipe, computed rollup field configuration, aggregate dependency routing,
  workflow-service maintenance writes, recompute paths, and publish/manual
  backfill paths.
- Extensible aggregate operations remain registry-backed in
  `src/core/aggregates/registry.ts`, currently exposing `count_records`,
  `sum_numbers`, `max_number`, `min_number`, and `average_numbers`, with
  authoring and ingress tests asserting public recipe catalog exposure.
- Batch initialize/backfill remains represented by `workflow_backfill_jobs`,
  queue continuation/disposition handling, dependency operation reads, manual
  aggregate/lookup/sync maintenance requesters, and workflow-publish backfill
  enqueue paths.
- Completed row-owner, extensible-condition, routed lookup/aggregate/sync
  maintenance, and workflow-service computed-write groundwork remains in place.
  Field-type proposal-hint parity was not reopened because it still does not
  directly unblock this identity/reactive workflow goal.

## Issue State

- Current active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`,
  `Identity and reactive data workflows`.
- [CLO-3116](/CLO/issues/CLO-3116) is blocked by
  [CLO-3117](/CLO/issues/CLO-3117) and can resume when this checkpoint closes.
- [CLO-3068](/CLO/issues/CLO-3068) remains `in_review` and is still the live
  board/operator-input path for production hostname, Cloudflare route authority,
  and Google OAuth client/callback direction.
- [CLO-2647](/CLO/issues/CLO-2647) remains the production domain/OAuth callback
  configuration lane, with [CLO-2648](/CLO/issues/CLO-2648) and
  [CLO-2646](/CLO/issues/CLO-2646) carrying rollout readiness downstream.
- [CLO-2930](/CLO/issues/CLO-2930) remains the separate aggregate
  permission-restore remediation lane, currently covered by its recovery path.
  It should not be duplicated as an identity/reactive backend implementation
  issue from this checkpoint.
- The workspace is dirty with broad pre-existing CloudTable implementation
  changes and historical reconciliation artifacts. This checkpoint added only
  this report and did not revert or modify unrelated product code.

## Verification

```bash
npm run --silent typecheck
```

Result: passed.

```bash
npm run --silent test:smoke
```

Result: passed. Two smoke files passed, with 20 tests passing.

## Recommendation

Close [CLO-3117](/CLO/issues/CLO-3117) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3116](/CLO/issues/CLO-3116) resume through its first-class blocker link,
while [CLO-3068](/CLO/issues/CLO-3068) and the existing rollout/configuration
path carry the production hostname and Google OAuth callback continuation.
