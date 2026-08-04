# CLO-1651 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-19
Issue: CLO-1651
Parent driver: CLO-1650
Goal: Identity and reactive data workflows

## Conclusion

No new bounded implementation slice is warranted from CLO-1651.

I reconciled the current CloudTable repo and active issue tree against the latest completed CTO baseline from CLO-1649, CLO-1647, CLO-1643, and CLO-1641. I found no material repo or issue-tree change since CLO-1649 that creates a distinct identity/reactive runtime gap.

CLO-1509 remains the canonical workflow-authoring/product-surface lane for configurable cross-table sync and grouped rollup recipes if that work resumes. Creating another implementation issue from CLO-1650 would duplicate that lane rather than address a newly discovered backend/runtime capability gap.

## Requirement Mapping

1. Google login remains covered by `src/runtime/worker.ts`, including Google login and callback ingress, signed OAuth state, external Google identity lookup, canonical user resolution, identity-link collision protection, and signed auth session creation.
2. Invited organization/workspace membership remains covered by invitation issuance and acceptance, workspace membership resolution, session hydration, and explicit active-workspace selection in `src/runtime/worker.ts`.
3. Declarative cross-table sync remains covered by the `sync_related_field` workflow operator in `src/core/workflows/operators.ts`, workflow metadata normalization, sync maintenance runtime, and manual sync backfill ingress.
4. Grouped rolling computed columns remain covered by computed rollup field contracts, aggregate metadata normalization, aggregate maintenance routing, and grouped target recompute behavior for `single_relation` and `value_match` strategies.
5. Rollup operations remain extensible through `src/core/aggregates/registry.ts`, which registers `count_records`, `sum_numbers`, `max_number`, and `average_numbers` as operation definitions rather than hard-coding a single sum path.
6. Batch initialize/backfill remains covered by workflow publish fanout plus manual aggregate/sync maintenance ingress and queue-consumer maintenance messages using `backfill` and `recompute` triggers.
7. Coordinator-owned reactive writes remain guarded by explicit workflow service identity metadata in `src/core/workflows/service-identity.ts`; missing or invalid metadata fails closed.

## Active Issue Reconciliation

- CLO-1651 is the only active child under CLO-1650 in the identity/reactive goal tree.
- CLO-1650 is blocked on this reconciliation child.
- CLO-1649 and CLO-1647 are completed baseline memos with the same no-new-gap finding and passing typecheck/smoke verification.
- Older active driver/reconciliation entries under the same goal are blocked historical lanes, not new implementation work.
- CLO-1509 is still the non-duplicate author-facing product-surface continuation if it resumes. Its existence does not indicate a new runtime baseline gap.

## Verification

Commands run for this reconciliation:

- `npm run typecheck`
- `npm run test:smoke`

Both checks passed. Smoke covered 2 files and 19 tests.

## Disposition

Close CLO-1651 as done. Do not create another bounded identity/reactive implementation issue from CLO-1650. Let CLO-1650 unblock with the same disposition: the runtime capability baseline remains satisfied, and CLO-1509 is the existing product-surface continuation if that lane resumes.
