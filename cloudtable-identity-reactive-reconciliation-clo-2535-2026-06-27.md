# CLO-2535 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2535](/CLO/issues/CLO-2535)
Parent: [CLO-2534](/CLO/issues/CLO-2534) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted from this
checkpoint.

The current codebase and active issue state still match the recent CTO
reconciliation chain. The identity/reactive workflow capability surface is
present in source and focused regression coverage, and the only material
production-readiness path remains [CLO-2321](/CLO/issues/CLO-2321), which is
already `in_review` with a real pending plan confirmation path. Its backend and
QA child issues, [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323), are recorded complete in the CLO-2321
continuation summary.

Opening another implementation child under the identity/reactive goal would
duplicate that existing review lane rather than create a bounded new slice.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- [CLO-2535](/CLO/issues/CLO-2535) is the only active blocker for current parent
  driver [CLO-2534](/CLO/issues/CLO-2534).
- [CLO-2321](/CLO/issues/CLO-2321) remains `in_review`; its continuation summary
  says both child issues are complete and the remaining path is reviewer/board
  plan confirmation.
- Current source inspection shows:
  - Google OAuth login/callback, signed sessions, invitation issuance and
    acceptance, tenant listing, memberships, and active workspace switching in
    `src/runtime/worker.ts`.
  - Tenant/workspace membership persistence and invitation acceptance in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring in
    `src/core/workflows/authoring.ts` and workflow recipe types in
    `src/core/workflows/types.ts`.
  - Cross-table `sync_related_field` runtime execution and maintenance/backfill
    routing in `src/runtime/workflow-runtime.ts`.
  - Dependency routing and operation status readback in
    `src/runtime/workflow-dependency-index.ts` and
    `src/runtime/workflow-operations.ts`.
  - Grouped rollup aggregate backfill/recompute maintenance in
    `src/runtime/aggregate-maintenance.ts`.
  - Regression coverage for invitation-backed reactive sync,
    invitation-backed reactive rollup, manual sync/aggregate backfill ingress,
    and recipe authoring/readback in the focused suites below.
- Field-type proposal-hint parity remains out of scope because it does not
  directly block identity or reactive workflow capability.

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

Close [CLO-2535](/CLO/issues/CLO-2535) as done. Do not create another
identity/reactive implementation child from this checkpoint. Keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing OAuth/deployment hardening
review path unless a future driver finds a concrete failing verification target
or a non-duplicative product gap.
