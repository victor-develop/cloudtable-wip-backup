# CLO-1496 CloudTable Identity And Reactive-Workflow Reconciliation

## Summary

`CLO-1496` asked for a reconciliation of the current CloudTable codebase and goal tree against the active capability target:

- Google login
- users invited into multiple organizations and workspaces
- declarative cross-table sync workflows
- rolling computed columns with extensible operators
- reactive computations that also support batch initialize/backfill

The current workspace already satisfies that target strongly enough that no new identity/reactive-only implementation slice should be created from this issue.

## What is already complete and reusable

1. Multi-tenant identity ingress is implemented and regression-covered.
   - Workspace membership identity provisioning and readback exist in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
   - Google identity linkage, session establishment, and workspace hydration exist in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
   - Cross-organization invitees are routed into the invited workspace while still allowing session switching across memberships.

2. Declarative reactive workflows exist as executable runtime behavior, not just schema intent.
   - Cross-table sync is implemented through the workflow operator/runtime path, including matched-row maintenance and coordinator-owned writes.
   - Queue-driven workflow publish backfill and incremental recompute are covered in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`.

3. Rolling computed columns are backed by an extensible aggregate contract.
   - Aggregate operations are registry-backed in `src/core/aggregates/registry.ts`.
   - The current tree covers `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
   - Runtime publish-time backfill and rolling recompute are implemented through the aggregate-maintenance path.

4. Batch initialize/backfill already exists for the reactive maintenance lane.
   - Workflow publish emits maintenance envelopes for backfill.
   - Runtime maintenance consumes both `backfill` and ongoing `recompute` triggers.
   - Explicit workflow service identity requirements remain fail-closed during coordinator-owned maintenance writes.

## Highest-risk gaps versus the active goal

No first-class implementation gap remains inside the stated identity/reactive capability goal.

The remaining risks are broader than this goal lane:

- future operator breadth beyond the currently implemented aggregate set
- scale/performance behavior for larger reactive workloads
- UX/product shaping for workflow authoring and inspection

Those are valid future priorities, but they are not blockers to the current goal and they do not justify another narrowly scoped identity/reactive reconciliation or cleanup issue.

## Recommended next slice

No new identity/reactive-only slice is recommended.

The smallest honest recommendation is to treat this capability goal as satisfied for current engineering purposes and let a broader CloudTable product or platform driver choose the next slice. If follow-up work is opened later, it should expand scope beyond this already-covered lane instead of reopening the same reconciliation question.

## Goal-tree implication

`CLO-1496` should not create child implementation issues under the active `Identity and reactive data workflows` goal. This issue is best used as closure evidence for the goal lane, not as a source of another duplicate successor.

## Verification executed

- `npm run typecheck`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "executes value-matched sync maintenance backfill and recompute for matched target rows"`
- `npx vitest run testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "reactive_value_match_max_rollup_publish_and_recompute"`
- `npx vitest run testing/cloudtable/suites/smoke/runtime.spec.ts -t "proves reactive rollup workflow proposal preview through the smoke runtime path"`

## Disposition

Mark `CLO-1496` done. Use this memo to support closing the current identity/reactive-goal checkpoint without creating another bounded implementation follow-up.
