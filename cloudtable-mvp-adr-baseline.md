# CloudTable MVP v1 ADR Baseline

Status: Accepted for MVP v1 baseline  
Baseline freeze date: 2026-06-04  
Source decision acceptance date: 2026-06-03

This document freezes the CloudTable MVP v1 architecture decisions that downstream implementation-planning issues must treat as authoritative. Later changes must be recorded as explicit ADR updates rather than inferred from implementation.

## ADR-001: Cloudflare runtime stack for MVP v1

### Status

Accepted

### Decision

CloudTable MVP v1 uses:

- `Workers` for HTTP API ingress, authn/authz, request validation, command submission, read queries, and agent-tool endpoints.
- `D1` as the primary relational system of record for metadata, current-state cells/projections, permission snapshots, workflow definitions, event ledger, idempotency receipts, and execution state.
- `Durable Objects` as write coordinators for ordered schema and record mutations, idempotency enforcement, and deterministic event sequencing.
- `Queues` for asynchronous fan-out, workflow dispatch, index maintenance, notification delivery, and dead-letter replay.
- `R2` for export bundles, event archives, replay checkpoints, fixture packs, and large artifacts.

### Why

- The product model is relational and audit-heavy, so D1 is a better MVP fit than opaque blobs or custom storage layers.
- Durable Objects provide the single-writer boundary needed for deterministic command acceptance without making Workers stateful.
- Queues keep correctness in the synchronous commit path while moving fan-out and retries into a separate recovery model.
- R2 is the correct low-cost store for durable large artifacts that are not latency-critical.

### Consequences

- Every product-state mutation must commit through the command/event path before any queue-driven side effects run.
- Coordinators own concurrency and idempotency behavior; async workers do not mutate product state silently.
- Replayability and auditability take precedence over peak write throughput in MVP.

## ADR-002: Write coordination topology and event-first mutation rule

### Status

Accepted

### Decision

- Workspace-scoped schema, policy, workflow-definition, and cross-table integrity mutations route through one `Workspace Control Durable Object` per workspace.
- Table-local record and view mutations route through one `Table Coordinator Durable Object` per `(workspace_id, table_id)`.
- Every visible state mutation must write its event ledger row, state updates, idempotency receipt, and queue outbox rows in one D1 transaction.
- Workspace-global event ordering is preserved by leasing workspace-sequence ranges from the workspace coordinator to table coordinators.

### Why

- This preserves a globally auditable event stream without forcing every write through one hot object.
- It keeps conflict handling explicit and deterministic.
- It allows replay to rebuild state from metadata versions plus the event ledger.

### Consequences

- `record_projection` and secondary indexes are disposable rebuild targets, not canonical state.
- Conflict outcomes such as schema mismatch, record revision mismatch, and idempotency mismatch are part of the public contract.
- Bulk commands must remain bounded and deterministic item-by-item.

## ADR-003: Explicit deferrals and non-source-of-truth exclusions

### Status

Accepted

### Decision

The following are explicitly deferred or constrained out of the MVP v1 core path:

- `KV` is not a source of truth. It may only be used later for proven small cache hints or short-lived capability caches.
- `Workflows` as a Cloudflare platform primitive are deferred from the core automation/runtime path. CloudTable workflows are implemented through the product workflow registry plus queue-driven execution.
- Realtime collaborative editing, arbitrary spreadsheet formulas, plugin marketplace behavior, cross-workspace automations, rich binary processing pipelines, and a full page-builder surface remain out of MVP scope.

### Why

- Each deferred item introduces extra hidden consistency or product-surface complexity that is not required to ship the first correct, auditable version.
- The MVP must minimize the number of distributed state modes and long-running execution models.

### Consequences

- New proposals that pull KV or Cloudflare Workflows into the core path require a new ADR.
- Product requests that expand beyond the frozen MVP scope must be treated as post-baseline change requests, not Phase 1 clarifications.

## ADR-004: Code-defined registries for field types and workflow operators

### Status

Accepted

### Decision

- Field types are code-defined modules registered behind a shared field type registry contract.
- Workflow triggers, conditions, and actions are code-defined operator manifests with stable ids, versions, schemas, and deterministic fixture requirements.
- D1 stores references, bindings, versions, and published workflow definitions, but not mutable executable logic.

### Why

- Deterministic replay and auditability require stable versioned behavior that is deployed with code, not edited live in data.
- This avoids field-type and operator branching from spreading through command, permission, view, and workflow engine cores.

### Consequences

- CLO-9 is incorporated into the MVP v1 baseline as a required dependency of the command, permission, workflow, and view contracts.
- Adding a simple field type or workflow operator must not require changing engine core logic beyond registration and fixture coverage.
