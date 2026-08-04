# CLO-3121 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-23 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3121](/CLO/issues/CLO-3121)
Parent: [CLO-3120](/CLO/issues/CLO-3120) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-3119](/CLO/issues/CLO-3119).

This checkpoint found no material code or issue-tree change that opens a new
identity/reactive backend implementation gap. The represented baseline remains
broader than the required capability list, and the live continuation lanes are
still production hostname / Cloudflare route / Google OAuth callback rollout and
the separate aggregate remediation recovery path.

## Capability Reconciliation

- Google login remains represented by `/v1/auth/google/login` and
  `/v1/auth/google/callback` in `src/runtime/worker.ts`, including redirect
  allowlisting, signed OAuth state, callback exchange, user/session persistence,
  and invitation/onboarding context propagation.
- Users invited into different organizations and organization workspaces remain
  represented by `users`, `organizations`, `workspaces`,
  `organization_memberships`, `workspace_memberships`, `invitations`, and
  `sessions` schema support, plus invitation/membership ingress and D1
  repository identity persistence.
- Cross-table sync remains represented by `direct_sync` workflow recipes,
  `sync_related_field`, dependency metadata/indexing, queue/runtime maintenance
  routes, and the `requestWorkflowSyncMaintenance` tool path.
- Rolling computed columns remain represented by `grouped_rollup` recipes,
  computed rollup field configuration, routed aggregate dependency reads,
  workflow-service computed writes, manual/publish maintenance requests, and
  queue continuation handling.
- Rolling compute remains extensible through the aggregate operation registry.
  The catalog and tests cover `count_records`, `sum_numbers`, `max_number`,
  `min_number`, and `average_numbers` rather than hard-coding a single sum path.
- Batch initialize/backfill remains represented by `workflow_backfill_jobs`,
  publish-time backfill enqueueing, dependency operation reads, queue job
  continuation/disposition, and manual aggregate/lookup/sync maintenance
  requesters.
- The dependency-index work present in the current dirty workspace
  (`src/runtime/workflow-dependency-index.ts`) reinforces the prior baseline by
  deriving trigger, resolver, lookup, aggregate, and sync dependency entries and
  routing source/target changes to reactive maintenance consumers.

## Issue State

- Current active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`,
  `Identity and reactive data workflows`.
- [CLO-3120](/CLO/issues/CLO-3120) is blocked only by
  [CLO-3121](/CLO/issues/CLO-3121) and can resume when this checkpoint closes.
- [CLO-3068](/CLO/issues/CLO-3068) remains `in_review` and continues to carry
  the production hostname, Cloudflare route authority, and Google OAuth
  callback direction lane.
- [CLO-2647](/CLO/issues/CLO-2647) remains `in_review`; [CLO-2648](/CLO/issues/CLO-2648)
  remains `blocked`; [CLO-2646](/CLO/issues/CLO-2646) remains blocked
  downstream on the same credentialed production rollout path.
- [CLO-2930](/CLO/issues/CLO-2930) remains a separate blocked aggregate
  permission-restore remediation lane, covered by [CLO-3100](/CLO/issues/CLO-3100).
  It should not be duplicated as a new identity/reactive implementation issue
  from this checkpoint.
- The workspace is still dirty with broad pre-existing CloudTable product
  changes and historical reconciliation artifacts. This checkpoint added only
  this report and did not modify product code.

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

Close [CLO-3121](/CLO/issues/CLO-3121) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3120](/CLO/issues/CLO-3120) resume through its first-class blocker link,
while [CLO-3068](/CLO/issues/CLO-3068), [CLO-2647](/CLO/issues/CLO-2647),
[CLO-2648](/CLO/issues/CLO-2648), and [CLO-2646](/CLO/issues/CLO-2646) continue
the production hostname and Google OAuth callback rollout, and
[CLO-2930](/CLO/issues/CLO-2930) / [CLO-3100](/CLO/issues/CLO-3100) continue the
separate aggregate remediation path.
