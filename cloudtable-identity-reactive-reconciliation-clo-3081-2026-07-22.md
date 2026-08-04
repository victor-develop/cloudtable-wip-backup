# CLO-3081 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-22 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3081](/CLO/issues/CLO-3081)
Parent: [CLO-3080](/CLO/issues/CLO-3080) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative identity/reactive implementation or QA slice
is warranted after [CLO-3067](/CLO/issues/CLO-3067).

[CLO-3080](/CLO/issues/CLO-3080) delegated this CTO reconciliation and is
blocked only by [CLO-3081](/CLO/issues/CLO-3081). This pass found no new
issue-tree, repository, typecheck, or smoke evidence that changes the no-new-slice
conclusion already recorded by the later completed reconciliation passes
[CLO-3077](/CLO/issues/CLO-3077) and [CLO-3079](/CLO/issues/CLO-3079).

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- [CLO-3064](/CLO/issues/CLO-3064), [CLO-3065](/CLO/issues/CLO-3065), and
  [CLO-3067](/CLO/issues/CLO-3067) are all `done`.
- The current driver pair is [CLO-3080](/CLO/issues/CLO-3080) blocked by this
  reconciliation issue only. No newer active implementation child was found in
  the same goal before this pass.
- [CLO-3068](/CLO/issues/CLO-3068) remains `in_review` and carries the
  structured board/operator lane for production hostname, Cloudflare route
  authority, and Google OAuth client/callback direction.
- The rollout dependency is still explicit:
  [CLO-2646](/CLO/issues/CLO-2646) is blocked by
  [CLO-2647](/CLO/issues/CLO-2647), which is in review and depends on
  [CLO-2648](/CLO/issues/CLO-2648), `Configure CloudTable production hostname
  and Google OAuth callback`.
- [CLO-2930](/CLO/issues/CLO-2930), `Add routed aggregate permission-restore
  remediation coverage`, remains an existing active QA lane rather than a fresh
  CTO slice to duplicate.
- Current repository evidence still covers the required capability surface:
  - Google OAuth login/callback, invitation acceptance, session hydration,
    tenant bootstrap, membership ingress, workspace selection, and session
    switching in `src/runtime/worker.ts`.
  - Tenant, invitation, membership, session, workflow, dependency, and
    maintenance persistence in `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` authoring contracts in
    `src/core/workflows/authoring.ts`, `src/core/workflows/types.ts`, and
    `testing/cloudtable/suites/workflows/authoring.spec.ts`.
  - Reactive dependency indexing in `src/runtime/workflow-dependency-index.ts`
    and `testing/cloudtable/suites/runtime/workflow-dependency-index.spec.ts`.
  - Manual and queued aggregate, lookup, and sync maintenance/backfill in
    `src/runtime/workflow-runtime.ts`, `src/runtime/aggregate-maintenance.ts`,
    `src/runtime/workflow-operations.ts`, and
    `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`.
  - Regression coverage for invited reactive sync/rollups, cross-org invited
    workspace selection, invited read parity, invited recipe authoring,
    service-identity enforcement, dependency routing, and batch backfill in
    `testing/cloudtable/suites/runtime/ingress.spec.ts`,
    `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, and
    `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`.
- Row-owner and extensible-condition groundwork remains completed. Field-type
  proposal-hint parity was not reopened because the current evidence does not
  show it directly blocking identity/reactive workflows.
- The workspace is dirty with broad pre-existing CloudTable implementation
  changes and historical reconciliation artifacts. This reconciliation added
  only this report and did not revert or modify unrelated product code.

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

Close [CLO-3081](/CLO/issues/CLO-3081) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3080](/CLO/issues/CLO-3080) resume through its first-class blocker link
with this no-new-slice disposition, while [CLO-3068](/CLO/issues/CLO-3068) and
the rollout path [CLO-2646](/CLO/issues/CLO-2646) ->
[CLO-2647](/CLO/issues/CLO-2647) -> [CLO-2648](/CLO/issues/CLO-2648) carry the
real production hostname / Google OAuth callback continuation.
