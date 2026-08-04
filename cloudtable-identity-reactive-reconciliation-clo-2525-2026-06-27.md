# CLO-2525 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2525](/CLO/issues/CLO-2525)
Parent: [CLO-2524](/CLO/issues/CLO-2524) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-2521](/CLO/issues/CLO-2521).

The current codebase and active issue state still match the previous driver
conclusion: the required identity/reactive capability surface is represented in
source and focused tests, while [CLO-2321](/CLO/issues/CLO-2321) remains the
existing `in_review` OAuth/deployment hardening confirmation path. Its
implementation and QA children, [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323), are already done, so opening a new
identity/reactive implementation child from this checkpoint would duplicate the
same review lane.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- [CLO-2525](/CLO/issues/CLO-2525) is the only blocker for current parent driver
  [CLO-2524](/CLO/issues/CLO-2524).
- Recent checkpoints [CLO-2475](/CLO/issues/CLO-2475),
  [CLO-2495](/CLO/issues/CLO-2495), [CLO-2507](/CLO/issues/CLO-2507),
  [CLO-2509](/CLO/issues/CLO-2509), and [CLO-2521](/CLO/issues/CLO-2521) all
  reached the same no-new-gap disposition after the same focused verification.
- Current source inspection still shows:
  - Google OAuth login/callback, signed sessions, invitation issuance and
    acceptance, memberships, and workspace switching in `src/runtime/worker.ts`.
  - Tenant/workspace membership persistence in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring in
    `src/core/workflows/authoring.ts` and `src/core/agent-tools/registry.ts`.
  - Cross-table `sync_related_field` operator metadata in
    `src/core/workflows/operators.ts`.
  - Reactive dependency routing, workflow execution, sync recompute, aggregate
    recompute, and batch `backfill` maintenance in
    `src/runtime/workflow-dependency-index.ts`,
    `src/runtime/workflow-runtime.ts`, `src/runtime/workflow-operations.ts`,
    and `src/runtime/aggregate-maintenance.ts`.
  - Extensible rolling compute operations through
    `src/core/aggregates/registry.ts`, with computed rollup field validation in
    `src/core/field-types/modules.ts`.
- Field-type proposal-hint parity remains out of scope for this checkpoint
  because it does not directly block the identity/reactive workflow goal.

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

Close [CLO-2525](/CLO/issues/CLO-2525) as done. Do not create another
identity/reactive implementation issue from this checkpoint. Keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing OAuth/deployment hardening
review path unless a future driver finds a concrete failing verification target
or a non-duplicative product gap.
