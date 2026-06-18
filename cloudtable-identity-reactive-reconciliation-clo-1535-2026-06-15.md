# CLO-1535 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-15
Issue: CLO-1535
Goal: Identity and reactive data workflows

## Recommendation

The current CloudTable workspace already satisfies the active identity/reactive-workflow goal strongly enough that this checkpoint should close without creating another identity/reactive-only implementation slice.

The previous bounded-slice recommendation from `cloudtable-next-bounded-slice-2026-06-14.md` is no longer current. That note recommended landing `max_number` parity for value-matched reactive rollups. The live workspace now contains that queue/runtime/regression coverage already, so reopening the same lane would duplicate work rather than advance the project.

## What Already Exists In The Current Code State

1. Multi-tenant identity ingress is implemented and covered.
   - Workspace membership provisioning and readback are exercised in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
   - Google identity linkage, session establishment, workspace hydration, and cross-organization invitation acceptance are exercised in the same ingress suite.

2. Declarative reactive maintenance covers initialize/backfill and recompute paths.
   - Queue-driven aggregate maintenance for value-matched groups is exercised in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`.
   - End-to-end publish/backfill/recompute coverage for value-matched `max_number` rollups exists in `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.

3. Coordinator-owned reactive writes remain fail-closed under explicit workflow identity.
   - `src/core/workflows/service-identity.ts` rejects workflows that omit or corrupt explicit service-identity metadata.
   - Runtime ingress rejects manual aggregate-maintenance requests when the published workflow omits explicit service identity metadata.

4. Invited-member reactive read parity already exists in the current tree.
   - Saved-view readback and persona-preview parity for invited members are covered in `testing/cloudtable/suites/runtime/ingress.spec.ts`.

## Gaps Versus The Goal

No remaining gap was found that is both:

- specific to the stated identity/reactive-workflow goal, and
- small enough to justify another bounded implementation issue from this checkpoint.

The June 14 "next bounded slice" gap is now closed:

- value-matched `max_number` queue maintenance exists
- value-matched `max_number` deterministic regression coverage exists
- workflow service-identity enforcement remains present on the live workspace state

## Sequencing Constraint

The next useful CloudTable slice should come from a broader product or platform driver, not from forcing another narrowly-scoped identity/reactive reconciliation loop.

If a follow-up issue is needed later, it should be framed around a higher-level capability expansion such as:

- broader workflow authoring/runtime product scope, or
- broader field-type/aggregate platform work that is not limited to this already-satisfied goal

## Verification Performed

- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "provisions and reads workspace membership identity through the worker ingress"`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "keeps invited-member reactive saved-view readback and persona-preview surfaces in parity"`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "rejects manual aggregate-maintenance ingress when the published workflow omits explicit service identity metadata"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "executes max_number aggregate backfill and recompute for value-matched groups"`
- `npx vitest run testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "reactive_value_match_max_rollup_publish_and_recompute"`

All targeted checks passed on the current workspace state.

## Final Disposition

Close `CLO-1535` as done.

Do not open a new identity/reactive-only implementation issue from this heartbeat. The next decision should come from the parent project driver choosing a broader CloudTable priority beyond this already-satisfied goal.
