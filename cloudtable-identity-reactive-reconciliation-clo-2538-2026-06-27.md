# CLO-2538 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2538](/CLO/issues/CLO-2538)
Parent: [CLO-2537](/CLO/issues/CLO-2537) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice exists after
[CLO-2535](/CLO/issues/CLO-2535).

The current codebase still satisfies the active identity/reactive workflow
capability target in the parent driver, and the active issue state has not
introduced a new engineering gap. [CLO-2321](/CLO/issues/CLO-2321) remains the
existing production OAuth/deployment hardening review path. Its continuation
summary records [CLO-2322](/CLO/issues/CLO-2322) and
[CLO-2323](/CLO/issues/CLO-2323) complete, with only the review/confirmation
path still pending.

Creating another implementation child from this checkpoint would duplicate the
existing hardening/review lane rather than produce a bounded new slice.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- [CLO-2537](/CLO/issues/CLO-2537) is blocked only by this child,
  [CLO-2538](/CLO/issues/CLO-2538).
- [CLO-2321](/CLO/issues/CLO-2321) is still `in_review`; its continuation
  summary says [CLO-2322](/CLO/issues/CLO-2322) backend hardening and
  [CLO-2323](/CLO/issues/CLO-2323) QA validation are done.
- Current source inspection shows:
  - Google OAuth callback, signed sessions, tenant bootstrap, invitation
    issuance/acceptance, and active workspace selection in
    `src/runtime/worker.ts`.
  - Workspace membership and invitation persistence in
    `src/core/persistence/cloudtable-d1-repository.ts`.
  - Declarative `direct_sync` and `grouped_rollup` recipe authoring in
    `src/core/workflows/authoring.ts` and recipe types in
    `src/core/workflows/types.ts`.
  - Reactive dependency indexing/routing for aggregate, lookup, and sync
    dependencies in `src/runtime/workflow-dependency-index.ts`.
  - Direct sync and aggregate maintenance request paths, with explicit workflow
    service identity validation, in `src/runtime/workflow-runtime.ts`.
  - Coordinator-owned aggregate, lookup, and sync maintenance writes plus
    backfill/recompute idempotency in `src/runtime/aggregate-maintenance.ts`.
  - Focused tests cover identity login/hydration, invitations, cross-org
    workspace switching, direct sync, grouped rollup, invited-member read parity,
    dependency routing, service identity on maintenance writes, and batch
    backfill.
- Field-type proposal-hint parity still does not directly block the
  identity/reactive workflow capability target and should not be duplicated
  under this driver.

## Verification

Run from the CloudTable workspace on 2026-06-27:

```bash
npm run typecheck
```

Result: passed.

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity|links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|invitation_backed_reactive_sync_contract|invitation_backed_reactive_rollup_contract|invited_member_reactive_read_parity_contract|reactive_rollup_batch_backfill|workflow_service_identity_reactive_maintenance_writes"
```

Result: passed. Three test files passed, with 13 selected tests passing and
183 tests skipped by the focused filter.

## Recommendation

Close [CLO-2538](/CLO/issues/CLO-2538) as done. Do not create a new
identity/reactive implementation child from this checkpoint. Let
[CLO-2537](/CLO/issues/CLO-2537) auto-resume with this evidence, and keep
[CLO-2321](/CLO/issues/CLO-2321) as the existing production OAuth/deployment
hardening review path.
