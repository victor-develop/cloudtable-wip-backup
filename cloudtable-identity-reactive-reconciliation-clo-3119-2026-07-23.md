# CLO-3119 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-23 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3119](/CLO/issues/CLO-3119)
Parent: [CLO-3118](/CLO/issues/CLO-3118) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-3117](/CLO/issues/CLO-3117).

[CLO-3118](/CLO/issues/CLO-3118) is blocked only by this reconciliation child.
The repository state and active issue state still match the conclusion from
[CLO-3117](/CLO/issues/CLO-3117): the identity/reactive backend baseline is
represented, and the live continuation remains the existing production hostname,
Cloudflare route authority, and Google OAuth callback configuration path.

## Capability Reconciliation

- Google login remains represented by `/v1/auth/google/login` and
  `/v1/auth/google/callback` in `src/runtime/worker.ts`, including signed state,
  redirect validation, OAuth exchange, canonical user/session handling, and
  invitation/onboarding context propagation.
- Invited users across organizations and organization workspaces remain
  represented by invitation and membership ingress in `src/runtime/worker.ts`,
  identity persistence contracts in `src/core/persistence/types.ts`, D1
  repository support in `src/core/persistence/cloudtable-d1-repository.ts`, and
  schema tables for users, organizations, workspaces, memberships,
  invitations, workspace principals, and sessions in
  `migrations/0001_initial_schema.sql`.
- Cross-table sync remains represented by the `direct_sync` recipe, sync
  dependency metadata/routing, workflow runtime maintenance requests, queue
  consumer handling, and `requestWorkflowSyncMaintenance` ingress/tool paths.
- Rolling computed columns remain represented by the `grouped_rollup` recipe,
  computed `rollup` field configuration, aggregate dependency routing,
  workflow-service scoped computed writes, recompute paths, and publish/manual
  backfill paths.
- Extensible aggregate operations remain registry-backed in
  `src/core/aggregates/registry.ts`, currently exposing `count_records`,
  `sum_numbers`, `max_number`, `min_number`, and `average_numbers`, with
  workflow authoring catalog coverage exposing these operations.
- Batch initialize/backfill remains represented by `workflow_backfill_jobs`,
  queue continuation/disposition handling, dependency operation reads, manual
  aggregate/lookup/sync maintenance requesters, and publish-time aggregate,
  lookup, and sync backfill enqueue paths.
- Completed row-owner, extensible-condition, routed lookup/aggregate/sync
  maintenance, and workflow-service computed-write groundwork remains in place.
  Field-type proposal-hint parity was not reopened because it still does not
  directly unblock this identity/reactive workflow goal.

## Issue State

- Current active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`,
  `Identity and reactive data workflows`.
- [CLO-3118](/CLO/issues/CLO-3118) is blocked by
  [CLO-3119](/CLO/issues/CLO-3119) and can resume when this checkpoint closes.
- [CLO-3117](/CLO/issues/CLO-3117) is `done`.
- [CLO-3068](/CLO/issues/CLO-3068) remains `in_review` and is still the live
  board/operator-input path for production hostname, Cloudflare route
  authority, and Google OAuth client/callback direction.
- [CLO-2647](/CLO/issues/CLO-2647) remains `in_review` and is blocked by
  [CLO-2648](/CLO/issues/CLO-2648); [CLO-2646](/CLO/issues/CLO-2646) remains
  blocked downstream on the same production rollout path.
- [CLO-2930](/CLO/issues/CLO-2930) remains a separate aggregate
  permission-restore remediation lane, blocked by the active
  [CLO-3100](/CLO/issues/CLO-3100) recovery path. It should not be duplicated as
  an identity/reactive backend implementation issue from this checkpoint.
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

Close [CLO-3119](/CLO/issues/CLO-3119) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3118](/CLO/issues/CLO-3118) resume through its first-class blocker link,
while [CLO-3068](/CLO/issues/CLO-3068),
[CLO-2647](/CLO/issues/CLO-2647), [CLO-2648](/CLO/issues/CLO-2648), and
[CLO-2646](/CLO/issues/CLO-2646) carry the production hostname and Google OAuth
callback continuation.
