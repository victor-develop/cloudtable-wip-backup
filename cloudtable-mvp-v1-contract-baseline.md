# CloudTable MVP v1 Contract Baseline

Status: Frozen for implementation planning  
Baseline revision: `mvp-v1-2026-06-04`

This document is the authoritative Phase 1 contract baseline for CloudTable MVP v1. Downstream planning and implementation issues should use this document first, then read the linked extension documents for deeper detail. If any implementation detail conflicts with this document, this baseline wins unless a newer ADR supersedes it.

## 1. Authoritative document set

The MVP v1 baseline consists of:

- `cloudtable-mvp-adr-baseline.md`: accepted Cloudflare stack, write-topology, deferral, and registry decisions.
- `cloudtable-architecture-plan.md`: original system architecture and phased plan, now treated as accepted historical source rather than the active freeze artifact.
- `cloudtable-data-plane-execution-architecture.md`: authoritative backend/data-plane extension for D1, Durable Objects, event commit path, projections, queue fan-out, and permission runtime path.
- `cloudtable-product-contract.md`: authoritative product semantics extension for apps, tables, fields, views, workflow UX, and agent-assisted builder behavior.
- `cloudtable-field-type-registry-contract.md`: authoritative field type registry contract incorporated from CLO-9.
- `cloudtable-field-type-registry-phase1-design.md`: implementation-facing scaffold for the field type registry baseline.
- `cloudtable-deterministic-test-strategy.md`: authoritative deterministic quality architecture extension.

## 2. Baseline freeze rules

- MVP v1 remains event-first: no visible mutation without a committed event.
- Agent tools, workflow actions, and human API callers all use the same command validation and permission model.
- Field-level permissions constrain both visibility and mutation, including filters, grouped moves, workflow context, tool inputs, tool outputs, exports, and event echoes returned to the caller.
- Registries are code-defined and versioned; D1 stores references and bindings, not live executable logic.
- Deferred capabilities and explicit non-goals are not reopened by downstream implementation issues.

## 3. Frozen command and event contract

### 3.1 Write model

- Clients submit typed commands, not direct state patches to storage tables.
- Each accepted write returns a status plus the committed event envelope and optional projection payload.
- Non-idempotent writes require caller-supplied idempotency keys.
- Bulk writes execute in deterministic item order with per-item outcomes.

### 3.2 Required event envelope fields

The MVP v1 event contract freezes these fields as required:

- `eventId`
- `workspaceId`
- `appId`
- `tableId`
- `aggregateType`
- `aggregateId`
- `sequence`
- `schemaVersion`
- `eventType`
- `commandId`
- `idempotencyKey`
- `actor`
- `causation`
- `effectivePermissionsVersion`
- `occurredAt`
- `payload`
- `result`

The following refinements from the execution architecture are also frozen into v1:

- `workspaceSequenceLeaseId`
- `recordRevisionBefore`
- `recordRevisionAfter`
- `redactionApplied`
- `asyncTasks`

### 3.3 Required command outcomes

Accepted command responses must normalize to:

- `accepted`
- `conflict`
- `denied`
- `invalid`

Conflict handling is explicit and stable:

- stale schema state returns `schema_conflict`
- stale record revision returns `record_conflict`
- duplicate idempotency key with different command hash returns `idempotency_mismatch`
- duplicate idempotency key with same command hash returns the stored prior response

### 3.4 Replay boundary

Replay authority is limited to:

- metadata version tables
- event ledger
- optional R2 snapshots/checkpoints

`record_projection` and secondary indexes are rebuildable read optimizations only.

## 4. Frozen field-level permission contract

### 4.1 Scope model

The MVP v1 permission contract includes:

- workspace role
- app role
- table access
- field visibility
- field write access
- view access and layout editing rights
- workflow publish and execute rights
- agent tool access

### 4.2 Field-level rule set

For each field, the baseline recognizes these independently configurable controls:

- `Visible to`
- `Writable by`
- `Redact in views and exports`
- `Available to workflows`
- `Available to agents`

These controls are not cosmetic:

- visible but read-only fields must remain non-writable everywhere
- workflow-visible and agent-visible do not inherit automatically from human visibility
- hidden or unreadable field values must not be inferable through filters, group labels, webhook payloads, workflow context, event response payloads, or tool output

### 4.3 Enforcement points

The permission contract is frozen across these stages:

1. `Ingress`: authenticate principal and build permission context.
2. `Policy engine`: compute or fetch immutable effective permission snapshot.
3. `Coordinator`: re-check snapshot freshness and authorize the exact mutation before event commit.
4. `Projection/query layer`: redact unreadable fields and hide inaccessible rows/views.
5. `Workflow runtime`: execute only under explicit workflow service identity scopes.
6. `Agent tool gateway`: sanitize inputs and outputs to the caller's effective visibility.

### 4.4 Auditability rule

Every accepted mutation must be auditable against the permission snapshot version captured in the event envelope.

## 5. Frozen workflow operator registry contract

### 5.1 Registry model

Workflow operators are code-defined manifests with:

- stable `operator_id`
- `operator_kind` of `trigger`, `condition`, or `action`
- stable `version`
- input and output schemas
- required capabilities
- purity classification
- idempotency mode
- timeout class
- retry class
- deterministic fixture contract

Published workflows persist operator references and configured inputs, not embedded mutable logic.

### 5.2 MVP trigger catalog

- record created
- record updated
- field changed
- scheduled
- manual

### 5.3 MVP condition catalog

- equals
- not equals
- is empty
- is not empty
- text contains
- text starts with
- numeric compare
- date compare
- boolean combine via `all`, `any`, and `not`

### 5.4 MVP action catalog

- create record
- update record
- delete/archive record
- send webhook
- enqueue internal job
- emit notification event

### 5.5 Non-bypass rule

Workflow actions that mutate product state must submit normal commands through the same API/coordinator path. They do not write D1 state directly.

## 6. CLO-9 incorporation: field type registry is part of the baseline

The CLO-9 output is not optional follow-on design. It is part of the MVP v1 contract baseline because:

- command validation depends on field-type normalization and value schemas
- permission behavior depends on field-type-aware redaction and mutation constraints
- view filtering/sorting/grouping depends on field-type capabilities and index projections
- workflow condition compatibility depends on field-type-supported operators
- deterministic fixtures require module-level field-type coverage

The frozen MVP module set is:

- `text.single_line`
- `text.long`
- `number.decimal`
- `boolean.checkbox`
- `select.single`
- `select.multi`
- `date.date`
- `date.datetime`
- `principal.user`
- `relation.record`
- `computed.readonly`
- `status.semantic`

Adding a simple future field type must not require edits to command, permission, workflow, or view engine core.

## 7. Downstream planning guidance

Phase 2 through Phase 5 work must assume the following are already decided:

- Cloudflare primitive selection and deferrals
- event-first mutation and replay boundaries
- field-level permission enforcement stages
- workflow operator manifest model
- field type registry as a first-class dependency

Downstream issues may refine table-by-table DDL, queue payloads, runtime state machines, or UX states, but they must not silently redefine the baseline contracts above.
