# CLO-2495 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2495](/CLO/issues/CLO-2495)
Parent: [CLO-2494](/CLO/issues/CLO-2494) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-2491](/CLO/issues/CLO-2491).

[CLO-2491](/CLO/issues/CLO-2491) closed on 2026-06-26 with the same code state
and the conclusion that the active priority remains
[CLO-2321](/CLO/issues/CLO-2321) for production OAuth/deployment hardening. This
follow-up reconciliation found no new goal-tree or code evidence that changes
that disposition.

## Evidence

- Active goal remains `d6d73d1d-9a36-4411-a8b3-508859276d79`, `Identity and
  reactive data workflows`.
- The current active issue tree for that goal shows
  [CLO-2494](/CLO/issues/CLO-2494) blocked by this reconciliation issue,
  [CLO-2495](/CLO/issues/CLO-2495). Older drivers remain blocked by
  [CLO-2321](/CLO/issues/CLO-2321), matching the prior CTO disposition.
- Existing source still covers the required capability surface:
  - `src/runtime/worker.ts` exposes Google OAuth/session, invitation,
    membership, workspace switching, and workspace ingress paths.
  - `src/core/workflows/authoring.ts` and `src/core/agent-tools/registry.ts`
    cover declarative `direct_sync` and `grouped_rollup` recipe authoring.
  - `src/runtime/workflow-dependency-index.ts`,
    `src/runtime/workflow-runtime.ts`, `src/runtime/workflow-operations.ts`,
    and `src/runtime/aggregate-maintenance.ts` cover dependency routing,
    cross-table sync, aggregate recomputation, and batch backfill/initialize.
  - `src/core/aggregates/registry.ts` keeps rolling compute extensible through
    registry-backed operations.
- Field-type proposal-hint parity remains out of scope for this reconciliation
  because it does not directly unblock the identity/reactive workflow goal.

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

Close [CLO-2495](/CLO/issues/CLO-2495) as done. Do not create another
identity/reactive implementation child from this checkpoint. Keep
[CLO-2321](/CLO/issues/CLO-2321) as the active existing path for production
OAuth/deployment hardening unless a future driver finds a concrete failing
verification target or a non-duplicative product gap.
