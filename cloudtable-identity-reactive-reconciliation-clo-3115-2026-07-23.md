# CLO-3115 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-23 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3115](/CLO/issues/CLO-3115)
Parent: [CLO-3114](/CLO/issues/CLO-3114) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-3113](/CLO/issues/CLO-3113).

[CLO-3114](/CLO/issues/CLO-3114) is blocked only by this reconciliation child.
This checkpoint found no newer issue-state or repository evidence that changes
the no-new-slice conclusion recorded by [CLO-3113](/CLO/issues/CLO-3113),
[CLO-3111](/CLO/issues/CLO-3111), [CLO-3109](/CLO/issues/CLO-3109),
[CLO-3107](/CLO/issues/CLO-3107), [CLO-3105](/CLO/issues/CLO-3105), and
[CLO-3103](/CLO/issues/CLO-3103).

## Capability Reconciliation

- Google login remains represented by `/v1/auth/google/login` and
  `/v1/auth/google/callback` in `src/runtime/worker.ts`, including signed state,
  redirect allow-listing, OAuth exchange, canonical user/session handling, and
  invitation/onboarding context propagation.
- Invited users across organizations and organization workspaces remain
  represented by workspace invitation issuance/acceptance and membership read
  ingress in `src/runtime/worker.ts`, persistence contracts in
  `src/core/persistence/types.ts`, D1 schema tables for organizations,
  workspaces, memberships, invitations, principals, and sessions in
  `migrations/0001_initial_schema.sql`, repository support in
  `src/core/persistence/cloudtable-d1-repository.ts`, and workspace-control
  durable-object membership provisioning in
  `src/durable-objects/workspace-control.ts`.
- Declarative cross-table sync remains represented by the `direct_sync` recipe,
  routed sync dependency metadata in `src/runtime/workflow-dependency-index.ts`,
  sync maintenance/backfill requesters in `src/runtime/bootstrap.ts` and
  `src/runtime/workflow-runtime.ts`, and execution in
  `src/runtime/aggregate-maintenance.ts`.
- Rolling computed columns remain represented by the `grouped_rollup` recipe,
  computed `rollup` field configuration, workflow aggregate metadata,
  dependency indexing, workflow-service maintenance writes, recompute paths, and
  publish/manual backfill paths.
- Extensible aggregate operations remain registry-backed and currently include
  `count_records`, `sum_numbers`, `max_number`, `min_number`, and
  `average_numbers` in `src/core/aggregates/registry.ts`, with authoring and
  ingress tests asserting the public recipe catalog.
- Batch initialize/backfill remains represented by `workflow_backfill_jobs`,
  queue continuation, dependency operation reads, manual aggregate/lookup/sync
  maintenance requesters, obsolete backfill disposition, and workflow-publish
  backfill enqueue paths.
- Completed row-owner, extensible-condition, routed lookup/aggregate/sync
  maintenance, and workflow-service computed-write groundwork remains in place.
  Field-type proposal-hint parity was not reopened because current evidence does
  not show it directly blocking this identity/reactive capability goal.

## Issue State

- Current active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`,
  `Identity and reactive data workflows`.
- [CLO-3114](/CLO/issues/CLO-3114) is blocked by
  [CLO-3115](/CLO/issues/CLO-3115) and can resume when this checkpoint closes.
- [CLO-3113](/CLO/issues/CLO-3113), [CLO-3111](/CLO/issues/CLO-3111),
  [CLO-3109](/CLO/issues/CLO-3109), [CLO-3107](/CLO/issues/CLO-3107),
  [CLO-3105](/CLO/issues/CLO-3105), and [CLO-3103](/CLO/issues/CLO-3103) are
  `done`.
- [CLO-3068](/CLO/issues/CLO-3068) remains `in_review` and is still the live
  board/operator-input path for production hostname, Cloudflare route authority,
  and Google OAuth client/callback direction.
- [CLO-2647](/CLO/issues/CLO-2647) remains the production domain/OAuth callback
  configuration lane, with [CLO-2648](/CLO/issues/CLO-2648) and
  [CLO-2646](/CLO/issues/CLO-2646) still carrying rollout readiness downstream.
- [CLO-2930](/CLO/issues/CLO-2930) remains the separate aggregate
  permission-restore remediation lane, currently blocked by
  [CLO-3100](/CLO/issues/CLO-3100). It should not be duplicated as a new
  identity/reactive backend implementation issue from this checkpoint.
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

Close [CLO-3115](/CLO/issues/CLO-3115) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3114](/CLO/issues/CLO-3114) resume through its first-class blocker link
with this no-new-slice disposition, while [CLO-3068](/CLO/issues/CLO-3068) and
the existing rollout/configuration path carry the production hostname and Google
OAuth callback continuation.
