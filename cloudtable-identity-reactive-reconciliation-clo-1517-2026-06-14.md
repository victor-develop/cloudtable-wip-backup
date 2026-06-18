# CLO-1517 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-14
Goal: Identity and reactive data workflows

## Summary

`CLO-1517` asked for a CTO reconciliation of the current CloudTable tree against the active capability goal: multi-tenant identity plus declarative reactive workflows.

The current workspace still satisfies that goal strongly enough that this issue should close without creating another implementation child. The live uncommitted changes around aggregate manifests, registry-driven validation, and runtime inspector/catalog surfaces improve extensibility and authoring discoverability rather than exposing a new blocker inside this goal lane.

## What Is Already Implemented

1. Multi-tenant identity ingress is already live and regression-covered.
   - Google identity linkage, session establishment, and workspace hydration are covered in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
   - Workspace membership identity provisioning and readback are covered in the same ingress suite.
   - Cross-organization invited-member workspace selection remains covered in `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.

2. Identity flows are already integrated with reactive runtime behavior.
   - Invitation-backed membership hydration and downstream reactive behavior remain covered by the regression scenarios `invitation_backed_reactive_sync_contract` and `cross_org_invited_member_workspace_selection_reactive_contract`.
   - The current runtime path still covers invited-member saved-view parity and workflow preview surfaces.

3. Declarative reactive workflows are already implemented as runtime behavior.
   - Cross-table sync workflows are covered in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`.
   - Public runtime preview flows still prove workflow proposal preview behavior in `testing/cloudtable/suites/smoke/runtime.spec.ts`.

4. Coordinator-owned reactive maintenance remains fail-closed under explicit workflow service identity.
   - `src/core/workflows/service-identity.ts` rejects missing or malformed explicit workflow service identity metadata.
   - `src/runtime/aggregate-maintenance.ts` and `src/runtime/workflow-runtime.ts` preserve workflow principal metadata and reject invalid service identity state.
   - `testing/cloudtable/suites/runtime/ingress.spec.ts` and `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts` cover both preservation and fail-closed behavior.

5. The newest live changes strengthen the same conclusion instead of opening a new gap.
   - `src/core/aggregates/registry.ts` and `src/core/aggregates/manifest.ts` expose aggregate definitions through manifest metadata rather than a narrow hard-coded seam.
   - `src/core/persistence/cloudtable-d1-repository.ts` validates aggregate definitions against the registry.
   - `src/runtime/workspace-inspector.ts` and `src/runtime/worker.ts` surface aggregate operation metadata to runtime/catalog clients, which improves authoring visibility rather than changing the identity/reactive capability answer.

## Highest-Leverage Remaining Gaps

For the capability goal named in `CLO-1517`, there is no remaining runtime blocker in:

- Google login and session hydration
- organization and workspace membership identity
- invitation-backed reactive behavior
- cross-table sync workflows
- aggregate maintenance and recompute
- workflow service identity enforcement
- registry-backed aggregate extensibility

The remaining work is above this lane, not inside it:

1. Product-surface authoring UX
   - The runtime now exposes more capability than the user-facing authoring flow likely communicates.
   - That is a broader product packaging decision, not a missing core capability inside this goal.

2. Operational scale, observability, and broader prioritization
   - This heartbeat did not reveal a new bounded scale or recovery slice required to satisfy the current goal.

## Recommendation

Do not create another identity/reactive implementation child from `CLO-1517`.

The clean disposition is:

1. Mark `CLO-1517` done.
2. Treat the `Identity and reactive data workflows` goal as satisfied for current engineering purposes.
3. If CloudTable work continues, broaden scope into a new objective such as workflow authoring UX, operational scale, or product packaging instead of reopening the same runtime-capability question.

## Verification Executed In This Heartbeat

- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|provisions and reads workspace membership identity through the worker ingress|rejects manual aggregate-maintenance ingress when the published workflow omits explicit service identity metadata"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "executes value-matched sync maintenance backfill and recompute for matched target rows|executes average_numbers aggregate backfill and recompute for value-matched groups"`

## Disposition

Mark `CLO-1517` done. The current codebase already meets the requested identity/reactive capability bar, and the latest aggregate manifest/catalog work reinforces that conclusion instead of justifying another bounded slice inside this goal.
