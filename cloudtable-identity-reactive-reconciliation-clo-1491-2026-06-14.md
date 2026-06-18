# CLO-1491 CloudTable Identity And Declarative Reactive-Workflow Reconciliation

## Canonical disposition

The updated `CLO-1490` target is satisfied by the current CloudTable workspace.

No successor implementation issue should be opened from this reconciliation heartbeat. The correct continuation is to treat this goal lane as complete and let broader product or platform priorities choose the next slice.

## Evidence against the updated target

1. Multi-tenant identity, Google login, and invited-user workspace hydration are implemented in the runtime and covered by ingress tests.
   - Workspace membership identity provisioning and readback are covered in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
   - Invitation issuance, Google callback acceptance, session creation, and workspace hydration are covered in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
   - Cross-organization invitees are routed to the invited workspace first while still retaining session switching across memberships in `testing/cloudtable/suites/runtime/ingress.spec.ts`.
   - Direct Google login for an existing user without an explicit `principalId` request path is covered in `testing/cloudtable/suites/runtime/ingress.spec.ts`.

2. Declarative cross-table sync exists as executable workflow behavior, not just authoring intent.
   - The `sync_related_field` workflow action is registered in `src/core/workflows/operators.ts`.
   - Coordinator-owned sync maintenance is executed in `src/runtime/aggregate-maintenance.ts` for both `single_relation` and `value_match` related-table resolvers.
   - Workflow-publish backfill routing for sync-enabled workflows is covered in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`.
   - End-to-end invited-member and cross-organization reactive sync contracts are covered in `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.

3. Rolling computed columns use an extensible contract with runtime-backed aggregate operations.
   - `computed.readonly` supports lookup and rollup configuration through the shared field-type registry in `src/core/field-types/modules.ts`.
   - Aggregate operations are registry-backed in `src/core/aggregates/registry.ts`, including `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
   - Runtime recompute and publish-time backfill for grouped rollups are implemented in `src/runtime/aggregate-maintenance.ts`.
   - End-to-end regression coverage exists for `max_number`, `average_numbers`, and `value_match` rollups in `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.

4. Batch initialize/backfill for reactive computations is implemented for both sync and computed maintenance lanes.
   - Workflow publish emits `backfill` maintenance envelopes for sync and aggregate-enabled workflows in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`.
   - Maintenance handlers consume both `backfill` and rolling `recompute` triggers in `src/runtime/aggregate-maintenance.ts`.
   - Coordinator-owned writes preserve explicit workflow service identity requirements during maintenance, with regression coverage in `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`.

## Why the earlier supersession no longer changes the outcome

The broader target in `CLO-1490` asked for evidence beyond basic identity and a single reactive rollup path. The current tree now covers the widened surface:

- invited users across organizations and workspaces
- Google login and session hydration
- declarative cross-table sync
- registry-backed rolling computed operations
- publish-time backfill plus incremental recompute

That removes the last concrete reason to create another identity/reactive-only implementation slice under this goal.

## Verification executed for this reconciliation

- `npm run typecheck`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "prioritizes the invited workspace for cross-organization invitees and still allows session switching"`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "executes value-matched sync maintenance backfill and recompute for matched target rows"`
- `npx vitest run testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "reactive_value_match_max_rollup_publish_and_recompute"`

## Closeout

Mark `CLO-1491` done and use this memo as the single canonical technical disposition for the updated identity/reactive-workflow goal.
