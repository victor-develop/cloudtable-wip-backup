# CloudTable Data Plane Skeleton Specification

Status: Phase 2 implementation-ready skeleton  
Issue: `CLO-11`  
Baseline inputs: `cloudtable-mvp-v1-contract-baseline.md`, `cloudtable-mvp-adr-baseline.md`, `cloudtable-data-plane-execution-architecture.md`

## 1. Purpose

This document converts the frozen MVP v1 backend baseline into the minimum implementation skeleton engineering should build before higher-level runtime features.

It is intentionally narrower than the broader execution architecture document. Its job is to lock down:

- the D1 package layout
- which tables are authoritative versus rebuildable
- which Durable Object owns each write path
- where projection rebuilds start and stop
- how the first migration/build slice should sequence rollout

This document does not reopen product semantics, API surface, or field-type contract decisions already frozen in the MVP v1 baseline.

## 2. Hard Invariants

These rules are implementation constraints, not suggestions:

- No visible mutation is committed unless its `event_ledger` row commits in the same D1 transaction.
- `record_projection` and index tables are never the sole recoverable state for product data.
- Schema, policy, workflow-definition, and cross-table integrity writes are owned by the `Workspace Control DO`.
- Record and view-local row-order writes are owned by the `Table Coordinator DO`.
- Idempotency is enforced at the same scope as the write coordinator that owns the command.
- Queue consumers may rebuild projections or dispatch follow-on work, but they must not silently mutate product state outside the command/event path.

## 3. D1 Schema Packages

The schema is organized into packages so migrations and ownership stay explicit. Each package below names:

- `Authority`: whether the package is canonical source of truth, audit-critical derived state, or rebuildable projection
- `Write owner`: which runtime component is allowed to mutate it
- `Replay role`: whether replay depends on it

### 3.1 Metadata package

Tables:

- `workspaces`
- `workspace_principals`
- `apps`
- `tables`
- `table_schema_versions`
- `fields`
- `views`
- `view_schema_versions`

Package rules:

- Authority: canonical
- Write owner: `Workspace Control DO`
- Replay role: required
- Every mutable row carries `workspace_id`, `created_at`, `updated_at`, `archived_at`, `last_event_id`
- `tables`, `fields`, and `views` also carry the current schema-version pointer used by record coordinators for stale-schema detection

Required keys and constraints:

- `workspaces.id`, `apps.id`, `tables.id`, `fields.id`, `views.id` are immutable ids
- `apps` unique on `(workspace_id, slug)`
- `tables` unique on `(workspace_id, app_id, slug)`
- `fields` unique on `(workspace_id, table_id, field_key)`
- `views` unique on `(workspace_id, table_id, view_key)`
- `table_schema_versions` unique on `(workspace_id, table_id, schema_version)`
- `view_schema_versions` unique on `(workspace_id, view_id, schema_version)`

Implementation note:

- `table_schema_versions` and `view_schema_versions` are append-only version rows. Current-state tables point at the latest accepted version; replay rebuilds current rows from these tables plus events.

### 3.2 Policy package

Tables:

- `permission_policies`
- `permission_policy_bindings`
- `permission_snapshots`

Package rules:

- Authority: `permission_policies` and `permission_policy_bindings` are canonical; `permission_snapshots` are audit-critical derived state
- Write owner: `Workspace Control DO` for policies and bindings; policy engine under `Workspace Control DO` authority for snapshots
- Replay role: replay requires policies and bindings; snapshots are retained so accepted events can be audited against the exact evaluated version

Required keys and constraints:

- `permission_policies` unique on `(workspace_id, policy_key, revision)`
- `permission_policy_bindings` unique on `(workspace_id, binding_key, revision)`
- `permission_snapshots` unique on `(workspace_id, principal_id, policy_revision, scope_hash)`

Implementation note:

- `permission_snapshots` are immutable once written. They may be backfilled from canonical policy inputs, but they are not disposable like record projections because event audit refers to their version directly.

### 3.3 Workflow-definition package

Tables:

- `workflows`
- `workflow_versions`
- `workflow_operator_refs`

Package rules:

- Authority: canonical
- Write owner: `Workspace Control DO`
- Replay role: required for workflow-definition replay and publish history

Required keys and constraints:

- `workflows` unique on `(workspace_id, workflow_key)`
- `workflow_versions` unique on `(workspace_id, workflow_id, version)`
- `workflow_operator_refs` unique on `(workspace_id, workflow_version_id, operator_slot_key)`

Implementation note:

- D1 stores immutable published references to operator ids and versions. Operator logic remains code-defined.

### 3.4 Record-state package

Tables:

- `records`
- `cell_current`

Package rules:

- Authority: canonical
- Write owner: `Table Coordinator DO`
- Replay role: optional acceleration only; replay can reconstruct this package from metadata plus `event_ledger`

Required keys and constraints:

- `records` unique on `(workspace_id, table_id, record_key)`
- `records` carries `record_revision`, `created_at`, `archived_at`, `last_event_id`
- `cell_current` primary key `(record_id, field_id)`
- `cell_current` carries `value_type`, `value_version`, `value_json`, typed helper columns, `display_value`, `search_text`, `value_hash`, `cell_revision`, `last_event_id`

Implementation note:

- `value_json` is the canonical cell value. Helper columns are deterministic derivatives from the field-type registry contract and may be regenerated.

### 3.5 View and query projection package

Tables:

- `record_projection`
- `field_index_definitions`
- `field_index_entries`
- `view_row_order_overrides`

Package rules:

- Authority: rebuildable projection
- Write owner: `Table Coordinator DO` may update `record_projection` inline for the touched record; queue consumers may rebuild all tables in this package
- Replay role: not required

Required keys and constraints:

- `record_projection` primary key `(workspace_id, table_id, record_id)`
- `field_index_definitions` unique on `(workspace_id, table_id, index_key)`
- `field_index_entries` primary key `(workspace_id, table_id, field_id, record_id)`
- `view_row_order_overrides` primary key `(workspace_id, view_id, record_id)`

Implementation note:

- `view_row_order_overrides` is projection state, not canonical state. It exists only for view-local ordering semantics that can be reproduced by replaying the relevant accepted events.

### 3.6 Event, idempotency, and outbox package

Tables:

- `event_ledger`
- `idempotency_receipts`
- `queue_outbox`
- `workspace_sequence_leases`

Package rules:

- Authority: `event_ledger` and `idempotency_receipts` are canonical; `queue_outbox` is canonical until drained; `workspace_sequence_leases` is coordinator-support state
- Write owner: `Workspace Control DO` for workspace-scoped commands, `Table Coordinator DO` for table-scoped commands
- Replay role: `event_ledger` is required; `idempotency_receipts` are required for duplicate suppression semantics; `queue_outbox` is not replay input but is required for failure recovery after commit

Required keys and constraints:

- `event_ledger` unique on `event_id`
- `event_ledger` unique on `(workspace_id, workspace_sequence)`
- `event_ledger` unique on `(workspace_id, table_id, table_sequence)` when `table_id` is non-null
- `idempotency_receipts` unique on `(scope_key, idempotency_key)`
- `queue_outbox` unique on `outbox_id`
- `workspace_sequence_leases` unique on `lease_id`

Implementation note:

- `workspace_sequence_leases` is intentionally persisted. Lease state must survive worker/process restarts so a table coordinator can reason about exhausted, active, or abandoned ranges without inventing sequence gaps at runtime.

### 3.7 Workflow execution package

Tables:

- `workflow_runs`
- `workflow_run_steps`
- `workflow_run_idempotency`
- `workflow_dead_letters`

Package rules:

- Authority: execution-state canonical, but not product-state canonical
- Write owner: workflow queue consumers and workflow runtime workers
- Replay role: not required for product-state replay; required for operational workflow recovery

Implementation note:

- This package is part of the Phase 2 skeleton because migrations must reserve the table family now, even if the first build slice only uses a subset.

## 4. Durable Object Ownership Topology

### 4.1 Workspace Control DO

One instance per `workspace_id`.

Owned command families:

- workspace creation and archive
- app creation and archive
- table creation, field creation, field archive, and schema publish
- view definition creation/update/archive
- permission policy changes
- workflow-definition draft and publish changes
- cross-table relation validation
- workspace-sequence lease allocation

Owned state:

- current `schema_epoch`
- latest policy revision
- latest workflow-definition revision
- active workspace-sequence lease head

Topology rule:

- This object owns anything that can invalidate table-local write assumptions across more than one table or redefine command meaning.

### 4.2 Table Coordinator DO

One instance per `(workspace_id, table_id)`.

Owned command families:

- create, patch, archive, restore record
- deterministic bulk record patch
- view-local row reorder affecting records in that table

Owned state:

- table-local sequence head
- cached current schema epoch for the table
- active workspace-sequence lease currently being consumed

Topology rule:

- The table coordinator is the only synchronous writer for `records`, `cell_current`, table-scoped `idempotency_receipts`, table-scoped `queue_outbox`, and table-scoped `event_ledger` rows.

### 4.3 Ownership map by package

- Metadata package: `Workspace Control DO`
- Policy package: `Workspace Control DO`
- Workflow-definition package: `Workspace Control DO`
- Record-state package: `Table Coordinator DO`
- View/query projection package: `Table Coordinator DO` inline for touched rows, otherwise projection queue consumers
- Event/idempotency/outbox package: same coordinator that accepted the command
- Workflow execution package: workflow runtime workers

## 5. Transaction Skeleton

Every accepted command executes one of two transaction shapes.

### 5.1 Workspace-scoped mutation transaction

Writes, in one D1 transaction:

- one `event_ledger` row
- metadata/package state changes
- optional `permission_snapshots` created as part of the same accepted change
- one `idempotency_receipts` row when the command is idempotent
- zero or more `queue_outbox` rows

### 5.2 Table-scoped mutation transaction

Writes, in one D1 transaction:

- one `event_ledger` row
- one `records` row create/update/archive or revision bump
- affected `cell_current` rows
- optional single-record `record_projection` refresh
- one `idempotency_receipts` row when required
- zero or more `queue_outbox` rows

Rule:

- If the coordinator cannot complete every write above, it returns `invalid`, `denied`, or `conflict`; it does not partially mutate state.

## 6. Projection Model and Rebuild Boundaries

### 6.1 Authoritative replay boundary

The minimum replay authority for product state is:

- metadata package current rows plus version rows
- policy package canonical rows
- workflow-definition package canonical rows
- `event_ledger`
- optional R2 checkpoint artifacts

Rebuilding from this boundary must be sufficient to repopulate:

- `records`
- `cell_current`
- `record_projection`
- `field_index_entries`
- `view_row_order_overrides`

### 6.2 Rebuildable packages

These tables are disposable and may be dropped and recomputed:

- `record_projection`
- `field_index_entries`
- `view_row_order_overrides`

These tables are not disposable:

- `event_ledger`
- `idempotency_receipts`
- canonical metadata rows
- canonical policy/workflow-definition rows
- `permission_snapshots`

### 6.3 Inline versus async rebuild rule

For the first build slice:

- direct record fetch after write must be served from updated `records` and `cell_current`
- `record_projection` should be refreshed inline for the touched record id only
- secondary indexes may lag and be rebuilt asynchronously from committed events
- a stale view query may omit a just-written row temporarily, but it must never show partially committed or unauthorized data

This boundary keeps the first slice correct without forcing full synchronous index maintenance in the hot path.

## 7. First Build Slice

The first implementation slice should ship the smallest end-to-end correct path, not the full final topology.

### 7.1 Slice A: foundation migrations

Create:

- metadata package
- policy package
- record-state package
- event/idempotency/outbox package
- workflow-definition tables as empty reserved scaffolding

Do not wait for:

- full workflow runtime
- full secondary index planner
- dead-letter tooling beyond table creation

### 7.2 Slice B: workspace write path

Implement:

- `Workspace Control DO`
- schema epoch management
- workspace-sequence lease allocation
- app/table/field/view creation path
- permission policy revision path

Acceptance bar:

- table metadata can be created with committed events and stable schema versions

### 7.3 Slice C: record write path

Implement:

- `Table Coordinator DO`
- record create/update/archive commands
- optimistic `record_revision` checks
- idempotency receipt enforcement
- inline `record_projection` update for touched rows
- outbox persistence

Acceptance bar:

- a single-table record write can commit event, canonical row state, and replay-safe idempotency in one transaction

### 7.4 Slice D: projection maintenance

Implement:

- queue-driven `field_index_entries` rebuild
- outbox drain and retry path
- record-projection rebuild job

Acceptance bar:

- rebuild jobs can reconstruct disposable query surfaces from canonical state plus events

## 8. Migration Sequencing

Migration order matters because foreign keys and coordinators depend on stable ids before record writes begin.

1. Create metadata package tables and workspace/app/table/field/view uniqueness constraints.
2. Create policy package tables, including immutable snapshot keys.
3. Create event/idempotency/outbox package tables, including workspace and table sequence uniqueness.
4. Create record-state package tables.
5. Create rebuildable projection package tables.
6. Create workflow-definition package tables.
7. Create workflow execution package tables.

Operational rule:

- Do not deploy record-write handlers until steps 1 through 5 are complete in the same environment.

## 9. Rollout Risks For The First Slice

### 9.1 Schema epoch drift

Risk:

- a table coordinator writes against stale field definitions after a workspace-scoped schema change

Mitigation:

- every table-scoped write carries caller-seen schema version and the coordinator revalidates against the `Workspace Control DO` before commit

### 9.2 Sequence lease loss or duplication

Risk:

- a coordinator restart or duplicate message causes reuse of a workspace-sequence range

Mitigation:

- persist `workspace_sequence_leases` in D1 and treat lease ownership plus exhaustion as durable state, not in-memory cache

### 9.3 Projection drift

Risk:

- `record_projection` or `field_index_entries` diverge from canonical cells

Mitigation:

- keep `cell_current` canonical, keep projection packages rebuildable, and expose a targeted rebuild path per table

### 9.4 Idempotency scope mistakes

Risk:

- the same idempotency key is reused across incompatible scopes and either collides incorrectly or bypasses duplicate suppression

Mitigation:

- freeze `scope_key` formats as `workspace:{workspace_id}` for workspace writes and `table:{table_id}` for table writes; reject hash mismatch as a contract error

### 9.5 Premature async dependence

Risk:

- the first slice becomes dependent on queue consumers for correctness instead of only freshness

Mitigation:

- direct record reads use canonical row state; only secondary indexes and non-critical projection maintenance are async in the first slice

## 10. Engineering Handoff

Implementation derived from this skeleton should create follow-on work in this order:

1. D1 migration DDL for the seven schema packages
2. `Workspace Control DO` command and lease state machine
3. `Table Coordinator DO` transaction path for record writes
4. projection rebuild jobs and outbox drain workers
5. workflow execution tables and runtime once the record path is stable

If a follow-on task proposes a storage table or write path that does not fit one of the packages or ownership rules above, that proposal is changing architecture and should be treated as an ADR update rather than implementation detail.
