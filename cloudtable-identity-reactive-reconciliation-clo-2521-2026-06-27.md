# CLO-2521 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2521](/CLO/issues/CLO-2521)
Parent: [CLO-2520](/CLO/issues/CLO-2520) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation issue is warranted after
[CLO-2519](/CLO/issues/CLO-2519).

[CLO-2519](/CLO/issues/CLO-2519) already reconciled the current code and active
goal state, verified the identity/reactive test surface, and closed with the
same active path: [CLO-2321](/CLO/issues/CLO-2321) remains `in_review` for the
production OAuth/deployment hardening plan confirmation. Its implementation and
QA children are complete, so a new backend identity/reactive child from this
checkpoint would duplicate that review lane.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- [CLO-2521](/CLO/issues/CLO-2521) is the only blocker for parent driver
  [CLO-2520](/CLO/issues/CLO-2520).
- [CLO-2321](/CLO/issues/CLO-2321) is still `in_review` with a pending
  confirmation path for OAuth/deployment hardening; [CLO-2322](/CLO/issues/CLO-2322)
  and [CLO-2323](/CLO/issues/CLO-2323) are recorded complete in the continuation
  summary.
- Current source inspection still shows the required capability surface:
  - Google OAuth login/callback, session handling, invitations, memberships, and
    workspace switching in `src/runtime/worker.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe metadata and proposal
    authoring in `src/core/workflows/authoring.ts` and
    `src/core/agent-tools/registry.ts`.
  - Runtime dependency routing, workflow operations, reactive execution, and
    aggregate backfill/recompute in `src/runtime/workflow-dependency-index.ts`,
    `src/runtime/workflow-operations.ts`, `src/runtime/workflow-runtime.ts`, and
    `src/runtime/aggregate-maintenance.ts`.
  - Extensible rolling compute operators through
    `src/core/aggregates/registry.ts`.
- Field-type proposal-hint parity remains out of scope for this reconciliation
  because it does not directly block identity or reactive workflow capability.

## Verification

Run from the CloudTable workspace on 2026-06-27:

```bash
npm run typecheck
```

Result: passed.

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|reactive_rollup_batch_backfill"
```

Result: passed. Three test files passed, with 11 selected tests passing and 185
tests skipped by the focused filter.

```bash
git diff --check
```

Result: passed.

## Recommendation

Close [CLO-2521](/CLO/issues/CLO-2521) as done. Do not create another
identity/reactive implementation issue from this checkpoint. Keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing OAuth/deployment hardening
review path unless a future driver finds a concrete failing verification target
or a non-duplicative product gap.
