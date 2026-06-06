# CloudTable Workflow Runtime and Permission Enforcement Spec

Status: Phase 4 runtime spec  
Issue: `CLO-13`  
Depends on: `cloudtable-product-contract.md`, `cloudtable-data-plane-execution-architecture.md`, `cloudtable-data-plane-skeleton-spec.md`, `cloudtable-field-type-registry-contract.md`

## 1. Purpose

This document turns the approved CloudTable execution architecture into an implementation-ready runtime contract for:

- workflow dispatch and queue fan-out
- permission rechecks across every execution surface
- failure, retry, idempotency, and dead-letter handling
- replay safety and read-after-write consistency boundaries

This document does not add product features or reopen MVP field, view, or API semantics. It specifies how the already-approved model executes safely.

## 2. Runtime Invariants

These rules are mandatory:

- No workflow action may mutate product state except by submitting a normal CloudTable command.
- Every state-changing command must pass the same permission engine at ingress and again at the owning coordinator.
- Async consumers may derive projections or start workflow work, but they may not silently patch canonical product tables.
- Workflow steps must be restart-safe. A crash or duplicate delivery must not produce duplicate visible mutations.
- Read paths may lag on disposable projections, but they may not expose unauthorized data or impossible intermediate state.
- Replay of the event ledger plus immutable metadata versions must be sufficient to reconstruct the durable product state.

## 3. Execution Components

### 3.1 Public and coordination surfaces

- `API Worker`
  - authenticates caller
  - resolves workspace, app, table, view, workflow, and tool scope
  - loads permission snapshot or requests one from policy evaluation
  - routes write commands to the owning Durable Object
  - serves read queries from projections with final redaction

- `Workspace Control DO`
  - owns schema, policy, workflow-definition, and cross-table integrity mutations
  - owns workflow publish and pause transitions
  - allocates workspace sequence leases
  - stamps workflow-definition revision and policy revision

- `Table Coordinator DO`
  - owns record mutations and view-local row-order mutations
  - rechecks schema epoch and permission freshness
  - persists event, state updates, idempotency receipt, and outbox rows atomically

### 3.2 Async execution surfaces

- `event-fanout` consumer
  - reads committed outbox entries
  - computes which downstream queue contracts apply for the event

- `workflow-dispatch` consumer
  - evaluates trigger eligibility for published workflows
  - creates `workflow_runs` rows idempotently
  - schedules runnable steps

- `workflow-step` consumer
  - executes one workflow step attempt at a time
  - records step result and emits follow-on commands or notifications

- `projection-maintenance` consumer
  - rebuilds `record_projection`, `field_index_entries`, and other disposable projections

- `dead-letter-reprocessor` consumer
  - replays only eligible failed async items under operator control

## 4. Queue Contracts and Fan-Out Path

### 4.1 Outbox contract

Every accepted mutation that should trigger async work writes one or more `queue_outbox` rows in the same D1 transaction as:

- `event_ledger`
- canonical state updates
- `idempotency_receipts`

Each outbox row must include:

- `outbox_id`
- `workspace_id`
- `event_id`
- `event_type`
- `aggregate_type`
- `aggregate_id`
- `delivery_topic`
- `payload_json`
- `delivery_key`
- `attempt_count`
- `next_attempt_at`
- `created_at`

`delivery_key` is the async idempotency boundary. Duplicate publishing of the same outbox row must not create duplicate downstream work.

### 4.2 Fan-out decision table

`event-fanout` applies this routing contract:

- schema, policy, or workflow-definition events
  - refresh metadata projections
  - invalidate relevant permission snapshot caches
  - do not start record workflows directly

- record mutation events
  - enqueue workflow trigger evaluation
  - enqueue projection and index maintenance for affected records and fields
  - enqueue notification and webhook work if configured

- workflow lifecycle events
  - enqueue workflow-definition cache refresh
  - cancel or suppress future dispatch for paused workflow versions

- replay-originated events
  - may rebuild projections
  - must not emit external notifications unless replay is explicitly marked as side-effect-enabled

### 4.3 Delivery ordering

- Ordering is strict only within an aggregate contract, not globally across all queues.
- `event-fanout` must preserve workspace sequence in its own durable checkpointing.
- `workflow-dispatch` only needs deterministic per-trigger ordering within the same workflow key and source aggregate.
- `projection-maintenance` may batch records and fields, but it must reject stale work whose `last_event_id` is older than current projection state.

## 5. Workflow Runtime State Model

### 5.1 Workflow run identity

Each run is uniquely identified by:

- `workflow_run_id`
- `workspace_id`
- `workflow_version_id`
- `trigger_event_id` or `manual_invocation_id`
- `run_key`

`run_key` must be deterministic:

- event-triggered run: `workflow:{workflow_version_id}:event:{event_id}`
- scheduled run: `workflow:{workflow_version_id}:schedule:{window_start}`
- manual run: `workflow:{workflow_version_id}:manual:{request_id}`

Unique constraint on `run_key` prevents duplicate runs from duplicate queue delivery.

### 5.2 Workflow run states

`workflow_runs.status`:

- `pending`
- `ready`
- `running`
- `waiting_retry`
- `succeeded`
- `failed`
- `dead_lettered`
- `cancelled`

State transition rules:

1. `pending` after dispatch creates the run shell and persists normalized trigger context.
2. `ready` once trigger and top-level conditions are fully evaluated.
3. `running` while a step attempt is active.
4. `waiting_retry` only for retryable step failures with a scheduled next attempt.
5. `succeeded` after the last step commits its terminal success result.
6. `failed` for deterministic non-retryable failure that should stay visible in history.
7. `dead_lettered` when retry budget or operator policy requires operational intervention.
8. `cancelled` when the workflow version is paused or superseded before execution proceeds.

### 5.3 Workflow step states

`workflow_run_steps.status`:

- `queued`
- `running`
- `succeeded`
- `retryable_failed`
- `failed`
- `skipped`
- `cancelled`

Each step row stores:

- `step_key`
- `operator_id`
- `operator_version`
- `input_hash`
- `attempt_count`
- `max_attempts`
- `next_attempt_at`
- `last_error_code`
- `last_error_json`
- `emitted_command_id`
- `emitted_event_id`

## 6. Trigger Evaluation and Dispatch Rules

### 6.1 Event-triggered workflows

For each committed event:

1. `workflow-dispatch` loads published workflows in the same app whose trigger type matches `event_type`.
2. It filters candidates by workflow status, trigger field references, and app/table scope.
3. It materializes a normalized trigger context from:
   - event envelope
   - redacted current record projection if the trigger needs record values
   - workflow-definition constants
4. It creates a `workflow_runs` row idempotently by `run_key`.
5. It evaluates top-level trigger conditions under the workflow principal.
6. If conditions pass, it marks the first step `queued` and schedules `workflow-step`.

If the workflow principal lacks permission to read a referenced field, the condition is evaluated against a redacted or absent value per field-type permission behavior. Missing authorized access is a deterministic workflow-definition error, not a transient runtime error.

### 6.2 Scheduled workflows

Scheduled workflows do not bypass the same runtime tables. A scheduler emits a synthetic trigger command that creates a normal `workflow_runs` row with:

- schedule window start and end
- workflow-definition revision
- workflow service principal

The scheduler itself must be idempotent by `(workflow_version_id, schedule_window_start)`.

### 6.3 Manual workflows

Manual runs are normal API commands:

1. caller must have `workflow.execute`
2. ingress resolves a manual invocation input payload
3. runtime creates a `workflow_runs` row with `manual_invocation_id`
4. subsequent step execution follows the same queue path

## 7. Permission Enforcement Path

### 7.1 Single permission model

Every surface uses one policy engine and one snapshot representation:

- public API
- view queries
- workflow trigger evaluation
- workflow actions
- agent tools
- permission explanation tooling

No surface may implement separate local permission shortcuts that can diverge from the canonical decision path.

### 7.2 Snapshot inputs

A permission snapshot is keyed by:

- `workspace_id`
- `principal_id`
- `policy_revision`
- `scope_hash`
- `schema_epoch`

`scope_hash` must cover the concrete objects involved in evaluation, such as:

- app id
- table id
- view id
- field set
- workflow id
- tool name

The snapshot body stores the evaluated allow-list outcome, not only the source policy ids, so audits can explain what was allowed.

### 7.3 Enforcement checkpoints

### Ingress

- authenticate actor
- resolve principal kind: human, service account, workflow principal, or agent session
- resolve initial scope
- reject obviously unauthorized commands before coordinator routing
- attach `permissions_version` and `permission_scope_hash` to the command envelope

### Coordinator

- reload current policy revision and schema epoch
- reject stale `permissions_version`
- re-evaluate high-risk checks that depend on current record state, such as field-level writes and relation target visibility
- reject commit if current state no longer matches ingress assumptions

### Projection layer

- apply row visibility first
- then field-level redaction
- then action-level capability flags such as `canEdit` or `canTriggerWorkflow`
- never derive counts, grouped labels, or filter echoes from unreadable field values

### Workflow runtime

- trigger evaluation runs as the workflow service principal
- action execution runs as the workflow service principal plus the workflow-definition scope grant
- workflow principal may be narrower than the builder who published the workflow
- workflow step must re-resolve permissions before each emitted command

### Agent tool gateway

- user identity remains the root actor
- agent actions are not independent principals
- mutating tools require command preview and idempotency key assignment
- tool inputs are sanitized before execution if they include unreadable field references
- tool outputs are redacted after execution using the same view and record redaction path as normal API reads

### 7.4 Permission drift behavior

If policy or schema changes after ingress but before async execution:

- synchronous command path: coordinator rejects with `409 permission_stale` or `409 schema_conflict`
- workflow dispatch: run transitions to `failed` with reason `workflow_scope_stale` if required trigger data is no longer authorized
- workflow step execution: step may retry only if drift is due to temporarily unavailable snapshot materialization; actual permission revocation is terminal and non-retryable

## 8. Step Execution Rules

### 8.1 Pure conditions and computed inputs

Pure operators:

- must not emit commands
- must be deterministic against the normalized input context and approved read model
- may be recomputed during retry without side effects

If a pure condition depends on record data, it must include the record projection version or `last_event_id` used for evaluation in the step audit row.

### 8.2 Impure actions

Impure actions fall into two categories:

- internal command actions
  - create/update/archive record
  - enqueue internal job
  - emit notification event

- external side effects
  - send webhook

Internal command actions must:

1. construct a normal CloudTable command envelope
2. assign workflow-specific `command_id` and idempotency key
3. submit through the same API or coordinator command contract
4. persist resulting `event_id` on the step row

External side effects must:

- execute only after the workflow step reaches a committed execution point
- use a side-effect delivery key derived from `workflow_run_step_id`
- be safe for duplicate delivery or explicitly dead-letter on provider ambiguity

### 8.3 Step idempotency

Each step attempt is scoped by:

- `workflow_run_id`
- `step_key`
- `input_hash`

Rules:

- duplicate delivery of the same queued step must reload the step row and continue rather than starting a second attempt
- same step with same `input_hash` reuses the existing idempotency record
- changed `input_hash` after resume requires an explicit new step revision and audit entry

## 9. Failure and Retry Contract

### 9.1 Failure classes

- `transient_runtime`
  - queue delivery issue
  - worker crash
  - provider timeout
  - temporary D1 or Durable Object unavailability

- `transient_dependency`
  - temporary webhook provider failure
  - temporary permission snapshot backfill lag

- `deterministic_definition`
  - unknown operator version
  - invalid workflow configuration
  - unsupported field/operator pairing

- `deterministic_permission`
  - workflow principal lacks required scope
  - trigger or action references unreadable/unwritable field

- `deterministic_state`
  - referenced record archived
  - relation target missing
  - record revision precondition failed for a workflow action

### 9.2 Retry matrix

- `transient_runtime`
  - retry with exponential backoff
  - default attempts: 5

- `transient_dependency`
  - retry with slower exponential backoff
  - default attempts: 8

- `deterministic_definition`
  - no retry
  - mark run `failed` or `dead_lettered` based on operator policy

- `deterministic_permission`
  - no retry
  - mark run `failed`

- `deterministic_state`
  - default no retry
  - specific operators may opt into one bounded retry if the state can converge, such as waiting for an immediately preceding projection rebuild

### 9.3 Dead-letter requirements

`workflow_dead_letters` stores:

- dead-letter id
- source queue topic
- source delivery key
- workflow run id or outbox id
- payload checksum
- failure class
- first failure time
- last failure time
- total attempts
- replay eligibility
- operator notes

Replay rules:

- replay must create a new operational attempt row linked to the dead letter
- replay may not mutate the original event ledger
- replay of external side effects requires explicit human opt-in when prior provider acknowledgement is ambiguous

## 10. Replay Safety

### 10.1 Product-state replay

The canonical replay source is:

- immutable metadata version tables
- `event_ledger`

Replay rebuilds:

- current metadata rows
- `records`
- `cell_current`
- disposable projections and indexes

Replay does not need to reconstruct `workflow_runs` to restore product state. Workflow execution history is operational metadata.

### 10.2 Workflow-history replay

Workflow runtime tables are retained for audit and debugging, but they are not the source of truth for business mutations. If workflow history needs repair:

- original emitted events remain authoritative
- runtime rows may be rebuilt into a best-effort audit timeline
- external side effects remain non-replayable by default

### 10.3 Replay-origin marker

Any replay-emitted command or derived maintenance task must carry a `causation.source` value such as:

- `replay_projection`
- `replay_audit`
- `recovery_reprocessor`

This prevents accidental webhook, notification, or workflow-trigger loops during recovery.

## 11. View Query Path and Consistency Boundaries

### 11.1 Record fetch after write

After a command commits successfully:

- `GET /records/:id` must read from canonical state or an inline-updated `record_projection`
- response must include the just-committed `last_event_id` and reflect the new `record_revision`

This is the strong read-after-write path for direct record access.

### 11.2 View query after write

View queries are allowed to be projection-stale, but must obey:

- no row may appear that violates already-committed permission or archival state
- no field value may reflect a partial mutation
- unreadable fields may not influence user-visible grouped labels, chips, or echoed filter values

To enforce this:

- row visibility must be checked against canonical record metadata before returning a projected row
- stale projection rows with `last_event_id` older than the required canonical threshold for touched records must be refreshed inline or omitted until rebuilt

### 11.3 Consistency modes

Expose two implementation modes internally:

- `record_strong`
  - canonical record fetch
  - used for write responses, record detail, workflow precondition checks

- `view_eventual`
  - projection and index backed
  - used for ordinary grids and grouped views

MVP should not promise globally strong read-after-write for whole-view ordering or grouping. It should promise that direct record reads are current and list views converge quickly without leaking incorrect data.

## 12. Operational Acceptance Checklist

The implementation derived from this spec is not complete unless it proves:

- duplicate queue delivery does not duplicate workflow runs or visible mutations
- workflow actions fail closed on permission revocation
- dead-letter rows capture non-retryable failures with replay metadata
- direct record reads reflect committed writes immediately
- stale view projections never widen access or show impossible mixed revisions
- replay can rebuild canonical product state without `workflow_runs`, `record_projection`, or index tables
- agent tools and public API produce the same redacted output for the same principal and scope

## 13. Recommended Build Order

1. Add workflow runtime D1 tables and unique constraints for run keys, step keys, and dead-letter delivery keys.
2. Define queue payload schemas for `event-fanout`, `workflow-dispatch`, `workflow-step`, `projection-maintenance`, and `dead-letter-reprocessor`.
3. Implement the permission snapshot contract and stale-snapshot rejection path.
4. Implement workflow dispatch idempotency and step-attempt state transitions.
5. Add consistency guards for direct record fetch and stale projection omission.
6. Build deterministic tests for retry, permission drift, duplicate delivery, and replay suppression of external side effects.
