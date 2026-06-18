# CLO-1506 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-14
Goal: Identity and reactive data workflows

## Summary

`CLO-1506` asked for a fresh reconciliation of the live CloudTable tree against the current required capability goal: multi-tenant identity plus declarative reactive workflows.

The current workspace satisfies that goal strongly enough that this issue should close without creating another implementation child. The latest uncommitted runtime changes improve the extensibility and authoring surface further rather than exposing a new blocker inside this lane.

## What Is Already Implemented

1. Identity is not speculative; it is exercised through runtime ingress.
   - Google identity linkage, session establishment, and workspace hydration are covered in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
   - Workspace membership identity provisioning and invited-member readback parity are also covered there.
   - Cross-organization invited-member workspace selection is covered in `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.

2. Multi-tenant invitation and membership flows are already integrated with runtime behavior.
   - Invitation creation, acceptance, membership hydration, and downstream reactive behavior are covered in the regression matrix scenarios `invitation_backed_reactive_sync_contract` and `cross_org_invited_member_workspace_selection_reactive_contract`.

3. Declarative cross-table sync workflows already exist as first-class runtime behavior.
   - The queue consumer covers both single-relation and value-match sync backfill plus recompute.
   - Smoke coverage proves direct cross-table sync workflow proposal preview through the public runtime path.

4. Rolling computed columns already support incremental recompute and publish-time backfill.
   - Aggregate maintenance covers lookup and rollup paths.
   - Current queue-consumer coverage includes `sum_numbers`, `max_number`, and `average_numbers` across both single-relation and value-match grouping strategies.

5. Extensible operations are now more explicit in the live tree.
   - `src/core/aggregates/registry.ts` now exposes aggregate definitions with manifest metadata instead of treating rollups as a hard-coded two-operation seam.
   - `src/core/persistence/cloudtable-d1-repository.ts` validates aggregate definitions against the registry rather than special-casing `sum_numbers`.
   - `src/runtime/workspace-inspector.ts` and `src/runtime/worker.ts` expose aggregate operation manifests to the scaffold/catalog surface, which closes the main remaining concern around authoring discoverability for extensible rollups.

## Highest-Leverage Remaining Gaps

For the capability goal named in `CLO-1506`, there is no longer a runtime blocker gap in:

- Google login
- organization/workspace membership and invitations
- cross-table sync workflows
- rolling computed columns
- extensible aggregate operations
- batch initialize/backfill

The remaining gaps are above this lane, not inside it:

1. Workflow authoring UX and product packaging
   - The runtime can do more than the user-facing authoring surface likely explains.
   - This is a product-surface prioritization question, not a missing core capability blocker.

2. Operational scale and observability
   - The tree proves correctness and deterministic behavior, but this issue did not reveal a new bounded scale/recovery slice that must be completed to satisfy the current goal.

## Recommendation

Do not create another identity/reactive implementation child from `CLO-1506`.

The next CEO decision should be one of:

1. Treat the `Identity and reactive data workflows` goal as satisfied for current engineering purposes and stop opening duplicate reconciliation checkpoints in this lane.
2. If CloudTable work should continue immediately, broaden scope into a new objective such as workflow authoring UX, operational scale, or product-surface packaging rather than reopening the same runtime-capability question.

## Verification Executed In This Heartbeat

- `npm run typecheck`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|provisions and reads workspace membership identity through the worker ingress|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "executes value-matched sync maintenance backfill and recompute for matched target rows|executes max_number aggregate backfill and recompute for value-matched groups|executes average_numbers aggregate backfill and recompute for value-matched groups"`
- `npx vitest run testing/cloudtable/suites/smoke/runtime.spec.ts -t "proves reactive rollup workflow proposal preview through the smoke runtime path|proves direct cross-table sync workflow proposal preview through the smoke runtime path"`

## Disposition

Mark `CLO-1506` done. The current codebase already meets the requested identity/reactive capability bar, and the newest aggregate-registry/catalog changes reinforce that conclusion instead of creating another bounded slice inside this goal.
