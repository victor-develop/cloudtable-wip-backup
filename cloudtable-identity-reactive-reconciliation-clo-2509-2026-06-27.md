# CLO-2509 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2509](/CLO/issues/CLO-2509)
Parent: [CLO-2508](/CLO/issues/CLO-2508) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-2507](/CLO/issues/CLO-2507).

The current active goal tree still shows the identity/reactive backend
capability surface represented in code and tests. The only active milestone path
for the goal remains [CLO-2321](/CLO/issues/CLO-2321), which is `in_review`
because its plan confirmation card is still pending. Its implementation and QA
children, [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323), are already done, so opening another
implementation issue from this checkpoint would duplicate that review path.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- [CLO-2509](/CLO/issues/CLO-2509) blocks the current driver
  [CLO-2508](/CLO/issues/CLO-2508); no new child issue is needed for the goal
  tree after this reconciliation.
- [CLO-2321](/CLO/issues/CLO-2321) still has a pending
  `request_confirmation` interaction, `Accept CloudTable OAuth/deployment
  hardening plan`, with `continuationPolicy: wake_assignee`.
- Google login, session establishment, invitation issuance/acceptance,
  cross-organization workspace selection, and active workspace switching remain
  covered by `src/runtime/worker.ts` and
  `src/core/persistence/cloudtable-d1-repository.ts`.
- Declarative `direct_sync` and `grouped_rollup` authoring remain covered by
  `src/core/workflows/authoring.ts`, `src/core/agent-tools/registry.ts`, and
  `src/core/workflows/operators.ts`.
- Runtime reactive propagation remains covered by
  `src/runtime/workflow-dependency-index.ts`, `src/runtime/workflow-runtime.ts`,
  `src/runtime/workflow-operations.ts`, and
  `src/runtime/aggregate-maintenance.ts`, including changed-field routing,
  sync recompute, aggregate recompute, and manual `backfill` initialization.
- Extensible rolling operations remain represented by
  `src/core/aggregates/registry.ts` and the aggregate operation metadata used by
  computed rollup field config and workflow aggregate definitions.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity is still out of scope because it does not
  directly block this identity/reactive workflow goal.

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

## Recommendation

Close [CLO-2509](/CLO/issues/CLO-2509) as done. Do not create another
identity/reactive implementation issue from this checkpoint. Keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing review path for the production
OAuth/deployment hardening plan confirmation unless a future driver finds a
concrete failing verification target or non-duplicative product gap.
