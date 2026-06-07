# CloudTable MVP Regression Matrix

This matrix maps the deterministic MVP semantic categories from `CLO-33` onto concrete per-commit suites.

## Scenario Map

| Scenario | Semantic area | Primary coverage |
| --- | --- | --- |
| `table_create_basic` | table creation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts` |
| `field_create_basic` | field creation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts` |
| `cell_set_write` | record and cell writes | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden` |
| `workflow_publish_event` | workflow lifecycle commands | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `permission_redaction_and_hidden_reads` | permissioned reads | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/permissions/engine.spec.ts` |
| `view_surface_capabilities` | view queries | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/views/planner.spec.ts` |
| `workflow_action_routes_through_command_envelope` | workflow execution | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/workflows/operator-registry.spec.ts` |
| `agent_tool_preview_and_sanitization` | agent-tool dry runs | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/agent-tools/registry.spec.ts` |
| `shared_idempotency_key_isolated_by_scope` | idempotency and scope isolation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden/command-bus.spec.ts` |

## Command Fixture Corpus

The deterministic command golden corpus now uses real MVP command scenarios instead of scaffold placeholders:

| Fixture | Outcome | Command surface |
| --- | --- | --- |
| `base-create-basic` | accepted | `base.create` |
| `table-create-basic` | accepted | `table.create` |
| `field-create-basic` | accepted | `field.create` |
| `view-create-basic` | accepted | `view.create` |
| `view-update-basic` | accepted | `view.update` |
| `record-create-basic` | accepted | `record.create` |
| `cell-set-write` | accepted | `cell.set` |
| `field-create-invalid-unknown-type` | invalid | `field.create` |
| `cell-set-permission-denied` | denied | `cell.set` |
| `record-create-idempotent-retry` | idempotent | `record.create` |
| `cell-set-idempotency-conflict` | conflict | `cell.set` |

## Guardrail Rules

- The regression matrix suite must stay deterministic and use canonical JSON comparisons only.
- Each scenario should encode a named MVP semantic seam rather than a low-level implementation detail.
- New semantic incidents should extend an existing scenario or add a new row here before the fix is considered complete.
