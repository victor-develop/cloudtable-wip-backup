# CLO-3105 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-23 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3105](/CLO/issues/CLO-3105)
Parent: [CLO-3104](/CLO/issues/CLO-3104) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-3104](/CLO/issues/CLO-3104).

The current code state still matches the same-day baseline from
[CLO-3103](/CLO/issues/CLO-3103): identity and reactive workflow runtime
surfaces are present, and the remaining first-class continuation is production
hostname / Google OAuth rollout configuration through [CLO-3068](/CLO/issues/CLO-3068),
[CLO-2647](/CLO/issues/CLO-2647), [CLO-2648](/CLO/issues/CLO-2648), and
[CLO-2646](/CLO/issues/CLO-2646).

## Capability Reconciliation

- Google login is represented by the Google auth login/callback flow in
  `src/runtime/worker.ts`, with required OAuth/session environment checks and
  callback documentation in `README.md`.
- Invited users across organizations and organization workspaces are
  represented by invitation issuance/acceptance, tenant bootstrap, organization
  membership, workspace membership, session hydration, active workspace
  selection, tenant listing, membership listing, and workspace switching in
  `src/runtime/worker.ts`, backed by persistence contracts in
  `src/core/persistence/types.ts` and D1 schema/repository support in
  `migrations/0001_initial_schema.sql` and
  `src/core/persistence/cloudtable-d1-repository.ts`.
- Declarative cross-table sync is represented by routed `sync` dependency
  metadata in `src/runtime/workflow-dependency-index.ts`, sync maintenance
  execution in `src/runtime/aggregate-maintenance.ts`, and agent-tool
  maintenance request surfaces in `src/core/agent-tools`.
- Rolling computed columns are represented by computed `rollup` field config,
  routed aggregate definitions, registry-backed operations, and aggregate
  maintenance writes through workflow-service identity.
- Reactive computations support batch initialize/backfill through
  `workflow_backfill_jobs`, chunked backfill progress/completion/failure paths,
  queue continuation, workflow dependency operations reads, and manual
  aggregate/lookup/sync maintenance requesters.
- Completed groundwork around row ownership, extensible conditions, routed
  lookup/aggregate maintenance, and workflow-service computed-write behavior
  remains in place. Field-type proposal-hint parity was not reopened because it
  does not directly block this identity/reactive capability goal.

## Issue State

- [CLO-3104](/CLO/issues/CLO-3104) is blocked by this reconciliation child and
  can resume once this issue is closed.
- [CLO-3068](/CLO/issues/CLO-3068) is `in_review` and remains the live
  driver/operator path for production hostname, route authority, and Google
  OAuth callback direction.
- [CLO-2647](/CLO/issues/CLO-2647) is `in_review`; [CLO-2648](/CLO/issues/CLO-2648)
  and [CLO-2646](/CLO/issues/CLO-2646) are `blocked` rollout/configuration
  continuations rather than new backend implementation gaps.
- [CLO-2930](/CLO/issues/CLO-2930) remains a separate aggregate
  permission-restore remediation lane and should not be duplicated here.

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

Close [CLO-3105](/CLO/issues/CLO-3105) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3104](/CLO/issues/CLO-3104) resume through its first-class blocker link,
while the existing production rollout/configuration path carries the remaining
OAuth hostname/callback work.
