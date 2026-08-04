# CLO-2475 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-27
Goal: Identity and reactive data workflows
Issue: [CLO-2475](/CLO/issues/CLO-2475)
Parent: [CLO-2474](/CLO/issues/CLO-2474) CloudTable 15-minute project driver

## Disposition

No fresh bounded implementation slice is warranted from this reconciliation pass.

The current code already covers the required goal surface: multi-tenant Google
identity, organization/workspace invitations and session switching, declarative
cross-table sync recipes, grouped rolling computed columns backed by an
extensible aggregate operation registry, and batch initialize/backfill routes
for reactive maintenance.

## Active Tree State

- [CLO-2474](/CLO/issues/CLO-2474) is blocked only by this reconciliation issue,
  [CLO-2475](/CLO/issues/CLO-2475).
- [CLO-2475](/CLO/issues/CLO-2475) has no child issues and no unresolved blockers.
- Closing [CLO-2475](/CLO/issues/CLO-2475) unblocks the driver without creating
  duplicate implementation work.

## Evidence

Identity and tenancy:

- `src/runtime/worker.ts` exposes Google OAuth login/callback, signed session
  cookies, auth readiness validation, invitation issuance, invitation acceptance,
  session readback, tenant/workspace membership listing, and active workspace
  selection.
- Runtime coverage includes invited-member acceptance, cross-organization
  invitees, active workspace persistence, explicit tenant bootstrap, Google
  identity linkage, and session-hydrated workspace ingress.

Reactive workflow authoring and execution:

- `src/core/workflows/authoring.ts` advertises `direct_sync` and
  `grouped_rollup` recipe types, their required inputs, publish routes, and
  `backfill`/`recompute` maintenance routes.
- `src/core/agent-tools/registry.ts` builds validated proposal templates for
  cross-table sync and grouped rollups from schema metadata, including relation
  and value-match strategies.
- `src/core/workflows/operators.ts` includes the `sync_related_field` action.
- `src/runtime/workflow-dependency-index.ts` derives trigger, resolver, sync,
  lookup, and aggregate dependency entries from published workflow metadata.
- `src/runtime/workflow-runtime.ts` and `src/runtime/aggregate-maintenance.ts`
  route reactive dependencies and maintenance messages for sync, lookup, and
  aggregate recomputation/backfill.

Extensible rolling compute:

- `src/core/aggregates/registry.ts` provides a registry-backed aggregate surface
  with `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- `src/core/field-types/modules.ts` validates computed rollup configuration
  against the aggregate operation registry, so adding operations is a registry
  extension rather than a bespoke workflow branch.

Out of scope:

- Field-type proposal-hint parity remains intentionally out of scope for this
  goal because it does not directly block identity or reactive workflow
  capability.

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

Close [CLO-2475](/CLO/issues/CLO-2475) as done. Do not create a new child issue
from this checkpoint unless a future driver wake finds a concrete failing
verification target or a non-duplicative gap beyond the current identity,
recipe-authoring, dependency-index, and maintenance lanes.
