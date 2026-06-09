# CloudTable MVP Regression Matrix

This matrix maps the deterministic MVP semantic categories from `CLO-33` onto concrete per-commit suites.

## Scenario Map

| Scenario | Semantic area | Primary coverage |
| --- | --- | --- |
| `table_create_basic` | table creation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts` |
| `field_create_basic` | field creation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts` |
| `field_permission_configuration` | field permissions | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_config` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden` |
| `field_validation_rejects_invalid_value` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden` |
| `field_validation_rejects_invalid_select_config` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_status_config` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_boolean_config` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_date_config` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_principal_config` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_relation_config` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_computed_config` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_select_value` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_status_value` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_boolean_value` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_date_value` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_datetime_value` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_principal_value` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_invalid_relation_value` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `field_validation_rejects_wrong_table_relation_reference` | hardened field validation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/repository/d1-repository.spec.ts` |
| `cell_set_write` | record and cell writes | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden` |
| `workflow_publish_event` | workflow lifecycle commands | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `workflow_manual_event` | workflow lifecycle commands | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `workflow_webhook_enqueue_delivery` | workflow action delivery commands | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `workflow_internal_job_enqueue_event` | workflow action delivery commands | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `workflow_notification_emit_event` | workflow action delivery commands | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `workflow_scheduled_dispatch_payload_determinism` | scheduled workflow delivery recovery | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `workflow_webhook_retry_backoff_recovery` | bounded webhook retry and recovery | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `workflow_dead_letter_replay_eligibility` | dead-letter replay eligibility and idempotency | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/runtime/queue-consumer.spec.ts` |
| `outbox_publish_failure_scheduled_drain` | post-commit outbox drain recovery | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/smoke/runtime.spec.ts` |
| `permission_redaction_and_hidden_reads` | permissioned reads | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/permissions/engine.spec.ts` |
| `permission_explanation_direct_ingress_parity` | permission explanation parity | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `permission_persona_preview_direct_ingress_parity` | permission persona preview parity | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `grouped_view_move_affordance` | grouped view action affordances | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `activity_history_surfaces_and_cursors` | activity-history reads | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts`, `testing/cloudtable/suites/repository/d1-repository.spec.ts` |
| `view_surface_capabilities` | view queries | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/views/planner.spec.ts` |
| `workflow_action_routes_through_command_envelope` | workflow execution | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/workflows/operator-registry.spec.ts` |
| `agent_tool_preview_and_sanitization` | agent-tool dry runs and app/schema authoring preview parity | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/agent-tools/registry.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `command_execute_ingress_contract` | explicit command execution ingress | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `agent_tool_execute_and_manual_wrapper` | audited agent-tool execution and workflow manual wrapper | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/runtime/ingress.spec.ts` |
| `shared_idempotency_key_isolated_by_scope` | idempotency and scope isolation | `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`, `testing/cloudtable/suites/command-golden/command-bus.spec.ts` |

## Command Fixture Corpus

The deterministic command golden corpus now uses real MVP command scenarios instead of scaffold placeholders:

| Fixture | Outcome | Command surface |
| --- | --- | --- |
| `base-create-basic` | accepted | `base.create` |
| `table-create-basic` | accepted | `table.create` |
| `field-create-basic` | accepted | `field.create` |
| `field-permission-configure-basic` | accepted | `field.permission.configure` |
| `field-create-invalid-number-config` | invalid | `field.create` |
| `field-create-invalid-select-config` | invalid | `field.create` |
| `field-create-invalid-status-config` | invalid | `field.create` |
| `field-create-invalid-boolean-config` | invalid | `field.create` |
| `field-create-invalid-date-config` | invalid | `field.create` |
| `field-create-invalid-principal-config` | invalid | `field.create` |
| `field-create-invalid-relation-config` | invalid | `field.create` |
| `field-create-invalid-computed-config` | invalid | `field.create` |
| `view-create-basic` | accepted | `view.create` |
| `view-update-basic` | accepted | `view.update` |
| `workflow-manual-basic` | accepted | `workflow.manual` |
| `workflow-webhook-enqueue-basic` | accepted | `workflow.webhook.enqueue` |
| `workflow-job-enqueue-basic` | accepted | `job.enqueue` |
| `workflow-job-enqueue-invalid-payload` | invalid | `job.enqueue` |
| `workflow-notification-emit-basic` | accepted | `notification.emit` |
| `workflow-notification-emit-invalid-payload` | invalid | `notification.emit` |
| `record-create-basic` | accepted | `record.create` |
| `cell-set-write` | accepted | `cell.set` |
| `cell-set-invalid-number-value` | invalid | `cell.set` |
| `cell-set-invalid-select-multi-value` | invalid | `cell.set` |
| `cell-set-invalid-status-value` | invalid | `cell.set` |
| `cell-set-invalid-boolean-value` | invalid | `cell.set` |
| `cell-set-invalid-date-value` | invalid | `cell.set` |
| `cell-set-invalid-datetime-value` | invalid | `cell.set` |
| `cell-set-invalid-principal-value` | invalid | `cell.set` |
| `cell-set-invalid-relation-value` | invalid | `cell.set` |
| `field-create-invalid-unknown-type` | invalid | `field.create` |
| `cell-set-permission-denied` | denied | `cell.set` |
| `record-create-idempotent-retry` | idempotent | `record.create` |
| `cell-set-idempotency-conflict` | conflict | `cell.set` |

## Guardrail Rules

- The regression matrix suite must stay deterministic and use canonical JSON comparisons only.
- Each scenario should encode a named MVP semantic seam rather than a low-level implementation detail.
- Delivery-recovery seams are first-class MVP contracts: scheduled dispatch payload identity, webhook retry/backoff state, dead-letter replay eligibility/idempotency, and scheduled outbox draining must remain deterministic across commits.
- Built-in text/select/status modules now sit inside the hardened field-type contract boundary: `text.single_line`, `text.long`, `select.single`, `select.multi`, and `status.semantic` must keep explicit schemas plus deterministic config/value validation alongside the remaining hardened modules.
- New semantic incidents should extend an existing scenario or add a new row here before the fix is considered complete.
