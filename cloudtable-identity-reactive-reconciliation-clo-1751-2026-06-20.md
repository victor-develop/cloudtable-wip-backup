# CloudTable Identity/Reactive Reconciliation - CLO-1751

Date: 2026-06-20
Goal: Identity and reactive data workflows
Issue: CLO-1751

## CTO Assessment

The current CloudTable codebase satisfies the active identity/reactive workflow capability goal strongly enough to close this reconciliation issue without creating new implementation child issues.

The required capability is present across the code and verified by targeted tests:

- Google login and session hydration exist in the worker ingress path and are covered by runtime ingress tests.
- Users invited into organizations/workspaces and cross-organization invited workspace selection are covered by runtime and regression tests.
- Declarative cross-table sync supports both relation-based and value-match routing, with coordinator-owned maintenance writes.
- Rolling computed columns are backed by an aggregate operation registry with `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- Reactive computations support publish-time backfill and later recompute triggers.
- Maintenance writes fail closed under explicit workflow service identity metadata.
- The authoring/scaffold surface exposes aggregate operation manifests and reactive rollup proposal/readback paths.

## Code Evidence

- `src/runtime/worker.ts` exposes Google auth ingress and runtime scaffold metadata, including aggregate operation manifests.
- `src/core/aggregates/registry.ts` provides the aggregate operation registry and built-in operation set.
- `src/runtime/workflow-runtime.ts` resolves related-table workflow context through both `single_relation` and `value_match` strategies.
- `src/core/workflows/operators.ts` executes `sync_fields` actions against resolved related records.
- `src/runtime/aggregate-maintenance.ts` loads explicit workflow service identity metadata, dispatches coordinator-owned `cell.set` commands, and handles both sync and aggregate maintenance.
- `testing/cloudtable/suites/runtime/ingress.spec.ts` covers workspace membership identity, Google identity linkage, invited-member read parity, and reactive rollup authoring/readback.
- `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` covers value-matched sync maintenance, aggregate backfill/recompute, and malformed workflow service identity failure behavior.
- `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts` covers cross-organization invited-member reactive behavior and value-match max rollup publish/recompute.
- `testing/cloudtable/suites/smoke/runtime.spec.ts` covers reactive rollup workflow proposal preview through the smoke runtime path.

## Goal Tree Disposition

The active goal tree currently has CLO-1751 as the only live child under the identity/reactive workflow capability goal. The older implementation issues for this lane are complete, including identity foundation, Google auth, invitation flow, cross-table sync, aggregate registry/backfill, row-owner groundwork, and later reconciliation passes.

No new bounded implementation child issue is warranted from this reconciliation. The goal tree maintenance recommendation is to stop creating identity/reactive-only reconciliation or implementation children unless a new product driver broadens scope beyond the current goal. The next useful planning move is at a higher product/platform priority, not another forced slice under this goal.

## Verification

Passed:

```bash
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "links a Google identity by email|provisions and reads workspace membership identity|keeps invited-member reactive saved-view readback|drafts, executes, publishes, and reads back reactive rollup workflow proposals"
npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "executes value-matched sync maintenance backfill and recompute|executes max_number aggregate backfill and recompute for value-matched groups|retries aggregate maintenance and preserves product state when workflow service identity metadata is malformed"
npx vitest run testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "cross_org_invited_member_workspace_selection_reactive_contract|reactive_value_match_max_rollup_publish_and_recompute"
npx vitest run testing/cloudtable/suites/smoke/runtime.spec.ts -t "proves reactive rollup workflow proposal preview through the smoke runtime path"
npm run typecheck
```

Results:

- runtime ingress: 4 passed
- queue consumer: 3 passed
- regression matrix: 2 passed
- smoke runtime: 1 passed
- typecheck: passed

## Delegation Decision

No child issues created.

Reason: the required capability goal is already implemented and verified at the bounded level requested by this issue. Creating another implementation child would duplicate completed work rather than close a concrete gap.
