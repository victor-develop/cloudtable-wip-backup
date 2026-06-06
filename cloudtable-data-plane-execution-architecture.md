# CloudTable Data Plane and Execution Architecture

## 1. Scope and Design Goals

This document refines the CloudTable MVP plan into implementation-ready backend decisions for the data plane and execution path. The design optimizes for:

- strict auditability of every mutation
- deterministic replay and regression testing
- field-level permission enforcement across all execution surfaces
- operational simplicity on Cloudflare primitives
- correctness-first write serialization for schema and record mutations

The architecture assumes the Phase 1 product/architecture contract from CLO-2 is accepted and treats this document as the backend execution baseline for Phase 2 and Phase 4 work.

## 2. System Topology

### Runtime roles

- `API Worker`: public HTTP ingress, authn/authz, request validation, read queries, command submission, tool gateway.
- `Workspace Control Durable Object`: serializes workspace-scoped mutations and coordinates workspace sequence allocation.
- `Table Coordinator Durable Object`: serializes record and view mutations per table, enforces optimistic concurrency, deduplicates idempotent commands, commits events.
- `Queues`: asynchronous fan-out for workflow dispatch, notification delivery, index maintenance, and retry/dead-letter handling.
- `D1`: source of truth for metadata, current-state projections, event ledger index, idempotency receipts, execution state.
- `R2`: durable storage for event archives, export bundles, deterministic fixture packs, and large replay snapshots.

### Coordination boundaries

- Schema, policy, workflow-definition, and app-level mutations route through `Workspace Control DO`.
- Record writes, bulk row updates, and view-local ordering changes route through `Table Coordinator DO`.
- Read paths do not enter Durable Objects unless a strongly consistent read-after-write guarantee is explicitly required.

## 3. D1 Physical Schema Strategy

### 3.1 Metadata tables

These tables are normalized and updated through append-only events plus current-state projections:

- `workspaces`
- `workspace_principals`
- `apps`
- `tables`
- `table_schema_versions`
- `fields`
- `views`
- `view_schema_versions`
- `permission_policies`
- `permission_policy_bindings`
- `permission_snapshots`
- `workflows`
- `workflow_versions`
- `workflow_operator_refs`

Key rules:

- Every mutable metadata table includes `workspace_id`, `created_at`, `updated_at`, `archived_at`, `last_event_id`, and `last_schema_version` where relevant.
- Human-stable ordering fields such as field order and view order are stored as dense integers and always rewritten by the coordinator inside a single logical mutation.
- Historical metadata revisions are not tracked by in-place row snapshots. History lives in the event ledger plus version tables such as `table_schema_versions`, `view_schema_versions`, and `workflow_versions`.

### 3.2 Record and cell storage

Use a split model between stable row identity, current cell state, and disposable read projections.

#### Canonical tables

- `records`
  - `id`
  - `workspace_id`
  - `app_id`
  - `table_id`
  - `record_key`
  - `record_revision`
  - `created_by`
  - `created_at`
  - `archived_at`
  - `last_event_id`

- `cell_current`
  - `workspace_id`
  - `table_id`
  - `record_id`
  - `field_id`
  - `value_type`
  - `value_json`
  - `text_value`
  - `number_value`
  - `bool_value`
  - `datetime_value`
  - `reference_value`
  - `display_value`
  - `value_hash`
  - `cell_revision`
  - `last_event_id`
  - primary key: `(record_id, field_id)`

- `record_projection`
  - `workspace_id`
  - `table_id`
  - `record_id`
  - `projection_version`
  - `field_values_json`
  - `search_text`
  - `last_event_id`

Rationale:

- `cell_current` is the canonical current-state surface for mutation conflict checks and per-field reads.
- `record_projection` is an optimized, rebuildable row blob used by view queries and agent/query responses. It must never be the only recoverable state.
- Typed helper columns in `cell_current` support common comparisons without introducing one table per field type.

Field type registry implications:

- `value_json` is the recoverable canonical value for every field type.
- Typed helper columns are derived by each field type module through a shared `toIndex` contract.
- Display values, search text, validation, redaction, defaulting, and workflow operator compatibility are field-type module responsibilities.
- The implementation-facing module boundaries and registry scaffold are defined in `cloudtable-field-type-registry-phase1-design.md`.
- The storage layer should not branch on business field types except for low-level primitive index classes.
- New field types should not require new canonical record tables.

### 3.3 Secondary index tables

Because CloudTable fields are dynamic, secondary indexes are explicit projections rather than implicit SQL indexes on arbitrary user columns.

- `field_index_definitions`
  - one row per indexed field or compound view sort/index need
- `field_index_entries`
  - `workspace_id`
  - `table_id`
  - `field_id`
  - `record_id`
  - `sort_text`
  - `sort_number`
  - `sort_datetime`
  - `sort_bool`
  - `is_null`
  - `last_event_id`

The queue-driven index maintainer updates these tables after event commit. View queries may fall back to direct `cell_current` scans until an index is warm.

### 3.4 Event and idempotency tables

- `event_ledger`
  - `event_id`
  - `workspace_id`
  - `app_id`
  - `table_id`
  - `aggregate_type`
  - `aggregate_id`
  - `workspace_sequence`
  - `table_sequence`
  - `schema_version`
  - `event_type`
  - `command_id`
  - `idempotency_key`
  - `actor_json`
  - `causation_json`
  - `permissions_version`
  - `payload_json`
  - `result_json`
  - `occurred_at`

- `idempotency_receipts`
  - `workspace_id`
  - `scope_key`
  - `idempotency_key`
  - `command_hash`
  - `first_event_id`
  - `response_json`
  - `expires_at`
  - unique key: `(scope_key, idempotency_key)`

- `queue_outbox`
  - durable handoff rows created in the same transaction as event commit

`scope_key` is usually `table:{table_id}` for record writes and `workspace:{workspace_id}` for schema/workflow writes. Reusing an idempotency key with a different command hash is a hard error.

### 3.5 Workflow execution tables

- `workflow_runs`
- `workflow_run_steps`
- `workflow_run_idempotency`
- `workflow_dead_letters`

These tables store execution state, not product-facing source of truth. The source of truth for business mutations emitted by workflows remains the event ledger.

## 4. Durable Object Topology

### 4.1 Workspace Control Durable Object

One instance per workspace.

Responsibilities:

- serialize schema mutations
- serialize policy and workflow-definition changes
- allocate monotonic workspace sequence ranges to table coordinators
- maintain authoritative current `schema_epoch`
- gate destructive operations such as field archive or table archive
- validate cross-table invariants for relation fields

This object must remain small and metadata-focused. It is not in the hot path for ordinary record writes after sequence ranges are leased.

### 4.2 Table Coordinator Durable Object

One instance per `(workspace_id, table_id)`.

Responsibilities:

- accept record mutation commands
- enforce table-local write serialization
- validate caller-supplied expected record revisions
- verify current schema epoch against the workspace control plane
- deduplicate idempotent commands within table scope
- assign table-local sequence and consume workspace-sequence leases
- persist event, state updates, and outbox rows in one D1 transaction

### 4.3 Sequence allocation

Do not force every record write through a single workspace object for sequence assignment.

Decision:

- `Workspace Control DO` leases workspace sequence ranges to each `Table Coordinator DO`, for example blocks of 256 or 1024 sequence numbers.
- Each committed table event consumes one workspace sequence and one table-local sequence.
- If a coordinator exhausts its lease, it requests a new range before the next commit.

This keeps a globally ordered workspace ledger without introducing a workspace-wide single-write bottleneck.

### 4.4 Conflict handling

Conflicts are explicit command outcomes, not hidden retries.

- stale `schema_version` or `schema_epoch`: reject with `409 schema_conflict`
- stale `record_revision`: reject with `409 record_conflict`
- duplicate `idempotency_key` with same hash: return stored prior response
- duplicate `idempotency_key` with different hash: reject with `409 idempotency_mismatch`
- cross-table referential validation failure: reject before commit

Bulk commands execute item-by-item inside the table coordinator with deterministic ordering and per-item outcomes. MVP should cap bulk size to keep DO execution bounded.

## 5. Write Path and Event Commit Model

### 5.1 Command lifecycle

1. API Worker authenticates principal and resolves workspace/app/table scope.
2. API Worker validates command shape and basic permission claim.
3. API Worker resolves a current permission snapshot id for the acting principal.
4. API Worker routes the command to `Workspace Control DO` or `Table Coordinator DO`.
5. Coordinator re-checks schema epoch, revision preconditions, and permission snapshot freshness.
6. Coordinator writes:
   - `event_ledger`
   - current-state mutations
   - `idempotency_receipts`
   - `queue_outbox`
7. Coordinator returns accepted event envelope and optional projection delta.
8. Queue publisher drains `queue_outbox` into Cloudflare Queues.

### 5.2 Transaction rule

Every mutation that changes visible product state must write its event ledger row, projection updates, and outbox rows in one D1 transaction. If queue publish fails after commit, the outbox replayer is responsible for eventual delivery.

### 5.3 Replay boundaries

Replay uses:

- metadata version tables
- `event_ledger`
- optional R2 snapshots as acceleration points

Replay does not depend on `record_projection` or `field_index_entries`. Those are disposable rebuild targets.

## 6. Projection and Query Strategy

### 6.1 Read models

Use three read surfaces:

- `metadata projection`: schemas, views, workflows, and policies
- `record projection`: fast row-shaped reads for record detail and agent output
- `index projection`: view filtering/sorting/grouping acceleration

### 6.2 View query execution

View queries compile into a constrained query plan:

1. resolve visible fields and permission mask
2. choose best index plan from `field_index_entries`
3. fetch candidate `record_id`s
4. join to `record_projection`
5. apply final permission redaction and residual filters
6. return deterministic order with continuation cursor

MVP should not attempt an arbitrary SQL planner. The planner only understands the supported filter/sort/group operators from the product contract.

### 6.3 Consistency model

- After a successful write, direct record fetch by id should reflect the committed mutation immediately.
- View queries may be slightly stale if index maintenance is asynchronous, but must never show unauthorized fields or impossible partially committed state.
- When view freshness matters, the API may force a projection rebuild for the touched record ids before responding, but not for full-table secondary indexes.

## 7. Queue Fan-Out Architecture

### 7.1 Queue roles

Use distinct logical consumers even if backed by a small number of Cloudflare Queues:

- `event-fanout`: consumes committed events from the outbox
- `workflow-dispatch`: starts eligible workflow runs
- `projection-maintenance`: refreshes `record_projection` and `field_index_entries` if not done inline
- `notifications`: webhooks, internal notifications, downstream integrations
- `dead-letter-reprocessor`: controlled replay path for failed async work

### 7.2 Fan-out responsibilities

For each committed event, `event-fanout` decides whether to:

- enqueue workflow trigger evaluation
- enqueue index updates for affected fields
- enqueue notification/webhook delivery
- append batched analytics or audit archive jobs
- materialize R2 checkpoint/archive work on a low-priority schedule

### 7.3 Retry model

- Transient consumer failure: exponential backoff with bounded attempts.
- Deterministic invalid payload or permission issue: no retry, send to dead letter.
- Dead letters are stored in D1 with payload checksum, failure class, first failure time, and replay eligibility.

Only the initial event commit path is allowed to mutate product state synchronously. Async consumers must emit new commands or projections, not silent side mutations.

## 8. Permission Enforcement Path

### 8.1 Enforcement stages

- `Ingress`: authenticate principal, resolve teams/service accounts, build permission context.
- `Policy engine`: compute or fetch effective permission snapshot version.
- `Coordinator`: re-validate snapshot version and enforce field/table/workflow scope before commit.
- `Projection layer`: redact unreadable fields and hidden records from query results.
- `Workflow runtime`: execute under workflow service principal with explicit granted scopes only.
- `Agent tool gateway`: sanitize tool inputs and outputs against the caller's field visibility.

### 8.2 Snapshot strategy

Permission evaluation is expensive and must be auditable. Use immutable `permission_snapshots` keyed by:

- `workspace_id`
- `principal_id`
- `policy_revision`
- `scope_hash`

Event envelopes store `permissions_version`, allowing future audits to answer why a command was allowed.

### 8.3 Non-bypass rules

- Event payloads must not include raw unreadable values when returned to a caller lacking field access.
- Workflow triggers must provide redacted context unless the workflow principal has the required read scope.
- Agent tools such as `query_view` and `explain_permissions` must use the same policy engine and redaction path as the public API.

## 9. Workflow Operator Registry

### 9.1 Registry source of truth

Operator implementations are code-defined manifests deployed with the worker. D1 stores references and workflow bindings, not executable definitions.

Reason:

- operators need code-level versioning and deterministic test fixtures
- allowing mutable operator logic in D1 would weaken replay guarantees

### 9.2 Manifest shape

Each operator manifest should declare:

- `operator_id`
- `operator_kind`: `trigger`, `condition`, or `action`
- `version`
- `input_schema_json`
- `output_schema_json`
- `required_capabilities`
- `purity`: `pure` or `impure`
- `idempotency_mode`
- `timeout_class`
- `retry_class`
- `test_fixture_contract`

Workflow definitions persist only `operator_id`, `operator_version`, and configured inputs. Published workflows are immutable references to a workflow version plus operator versions.

### 9.3 Execution rule

Workflow actions that change product state do so by submitting normal commands back through the API/coordinator path. They do not mutate D1 tables directly.

## 10. API Route Outline

### Command routes

- `POST /v1/workspaces`
- `POST /v1/apps`
- `POST /v1/tables`
- `POST /v1/tables/:tableId/fields`
- `PATCH /v1/tables/:tableId/fields/:fieldId`
- `POST /v1/tables/:tableId/records`
- `PATCH /v1/tables/:tableId/records/:recordId`
- `POST /v1/tables/:tableId/records:bulkPatch`
- `POST /v1/views`
- `PATCH /v1/views/:viewId`
- `POST /v1/workflows`
- `POST /v1/workflows/:workflowId/publish`
- `POST /v1/tools/:toolName/invoke`

### Query routes

- `GET /v1/tables/:tableId/records/:recordId`
- `POST /v1/views/:viewId/query`
- `GET /v1/workflows/:workflowId`
- `GET /v1/events/:eventId`
- `POST /v1/events/replay`
- `POST /v1/permissions/explain`

### Envelope refinements

The base event envelope from CLO-2 stands, with these additions:

- `workspaceSequenceLeaseId`: useful for debugging coordinator lease ownership
- `recordRevisionBefore` and `recordRevisionAfter` for record-changing events
- `redactionApplied`: whether response payload was sanitized for caller visibility
- `asyncTasks`: list of queue work items emitted from the same transaction

Commands should return:

- accepted `event`
- `status`: `accepted`, `conflict`, `denied`, or `invalid`
- optional `projection`
- optional `conflicts` array for bulk operations

## 11. Deterministic Testing Implications

This design should be tested with:

- golden command-to-event tests per route
- replay tests from `event_ledger` into empty D1 state
- sequence-lease tests for workspace/table ordering guarantees
- idempotency collision tests
- permission redaction matrix tests across API, workflow, and tool surfaces
- queue/outbox recovery tests where publish fails after commit
- workflow registry compatibility tests across operator versions

The harness should stub Durable Objects and Queue delivery deterministically while exercising real SQL against per-test D1 fixtures.

## 12. Open Questions

- Should relation-field integrity be synchronous for all cross-table references in MVP, or should some high-fanout relation maintenance become async with temporary pending state?
- Do we need inline `record_projection` updates on every write, or can some low-priority fields rely on queue-driven rebuild without harming UX?
- What is the acceptable maximum bulk mutation size before a single Table Coordinator invocation becomes operationally risky on Workers?

## 13. Recommended Follow-Ons

1. Convert this document into D1 migration specs and table-by-table DDL.
2. Define the exact permission snapshot schema and invalidation rules.
3. Define the queue contracts and dead-letter operational playbook.
4. Produce the workflow runtime state-machine spec against this operator-registry model.
