# CloudTable Architecture and MVP Build Plan

## 1. Product Frame

CloudTable is a Cloudflare-native smart-table platform: an Airtable-like relational spreadsheet/database with first-class events, workflows, views, and agent-callable operations.

### MVP boundary

- Multi-tenant workspaces with apps, tables, fields, records, views, and automations.
- Strong relational metadata model with append-only domain events for every mutating operation.
- Field-level read/write permissions enforced in API, workflow execution, and agent tools.
- A practical workflow engine with typed triggers, conditions, and actions.
- Views that are sufficient for real applications: grid, filtered/sorted subsets, hidden fields, grouped rows, saved permissions.
- Agent-callable tools that map to the same event-first contract as humans and APIs.
- Deterministic local and CI testing with replayable fixtures and event transcripts.

### Explicit non-goals for MVP

- Realtime collaborative cell editing with sub-second conflict-free shared cursors.
- Arbitrary spreadsheet formulas beyond a constrained computed-field subset.
- Public marketplace/plugin ecosystem.
- Cross-workspace automation federation.
- Rich binary asset processing pipelines.
- Full visual app builder / page designer.
- Complex long-running BPMN-style workflow orchestration.

## 2. Cloudflare Stack Decision Record

### Chosen default stack

- `Workers`: public API surface, authn/authz, request validation, event command handling, agent-tool endpoints.
- `D1`: primary relational system of record for tenant metadata, schemas, records, views, permissions, workflow definitions, event ledger index.
- `Durable Objects`: per-workspace or per-table coordination for ordered writes, schema mutation serialization, idempotency, and deterministic event sequencing.
- `Queues`: asynchronous event fan-out for notifications, secondary indexes, workflow dispatch, analytics, and retryable background work.
- `R2`: large snapshots, export bundles, fixture packs, workflow artifacts, attachments, and event-log archives.

### Explicitly limited or deferred

- `KV`: not used as source of truth. MVP use only for small edge-cache data such as signed capability cache or short-lived config hints if proven necessary.
- `Workflows`: defer for MVP core automation. Revisit only for long-running human-in-loop or multi-step recovery flows after the trigger/action model stabilizes.

### Rationale

- D1 gives a simple, inspectable relational model that matches Airtable-like metadata and record storage better than fully custom object blobs.
- Durable Objects compensate for D1’s weak point under concurrent, ordered mutations by making event numbering and schema changes single-writer where needed.
- Queues separate correctness from latency. User writes commit synchronously; expensive fan-out happens asynchronously from the committed event stream.
- R2 keeps snapshots and deterministic test fixtures cheap and portable.
- Avoiding KV and Workflows on the critical path reduces hidden consistency modes in MVP.

## 3. Core Domain Model

### Primary entities

- `Workspace`: tenant boundary, billing boundary, global principals, default policies.
- `Principal`: user, service account, agent, workflow runtime identity.
- `App`: product-facing container for related tables, views, workflows, and tools.
- `Table`: logical collection with schema versioning and ordering rules.
- `Field`: typed column definition with validation, defaulting, computed behavior, visibility, and permission overlays.
- `Record`: row identity plus stable metadata; current values are derived from latest visible cells or materialized projections.
- `Cell`: typed value at `(record_id, field_id)` with source, revision, and visibility semantics.
- `View`: saved projection over a table with filters, sorts, groups, hidden fields, layout, and scoped permissions.
- `PermissionPolicy`: rules granting actions at workspace/app/table/field/view/workflow scope.
- `Event`: append-only fact representing every mutation and major system action.
- `Workflow`: versioned automation definition bound to trigger source, condition tree, action pipeline, and execution policy.
- `Trigger`: event subscription or scheduled source normalized into workflow input.
- `Condition`: typed predicate node compiled from an operator registry.
- `Action`: typed side effect or command node compiled from an action registry.
- `AgentTool`: capability wrapper exposing safe operations to AI agents via the same command/event contracts.

### Field type extensibility

Field types are registered capabilities, not scattered conditionals. The command engine, view planner, permission engine, workflow engine, and agent tools should call a shared field type registry for normalization, validation, display rendering, indexing, supported operators, redaction behavior, and deterministic fixtures.

The dedicated contract lives in `cloudtable-field-type-registry-contract.md`, and the implementation-ready scaffold lives in `cloudtable-field-type-registry-phase1-design.md`. Adding a simple field type should require a new field type module plus tests, not edits to core command/workflow/permission/view engine logic.

### Storage shape

- Metadata tables in D1 for workspaces, apps, tables, fields, views, policies, workflows, and tool definitions.
- Record and cell state stored relationally, but every mutating state change must reference its originating event id.
- Event ledger stored append-only with monotonic sequence per workspace and per table for replay/debugging.
- Materialized projections allowed for reads, but projections are disposable and rebuildable from events plus schema state.

### Key invariants

- No state mutation without a corresponding event.
- Schema mutations are serialized through a coordinator.
- Permission decisions are versioned and auditable against the event that used them.
- Agent tools and workflows cannot bypass normal command validation.

## 4. Event-First API Design

### API principle

Clients submit commands; the platform validates, authorizes, commits an event, and returns both the accepted event envelope and the resulting materialized state projection when useful.

### Core command families

- Workspace/app lifecycle: create, update, archive.
- Table/field schema: create table, add field, alter field, reorder fields, archive field.
- Record mutation: create record, patch record, bulk patch records, delete/archive record.
- View lifecycle: create/update/delete view, reorder fields, update filter/sort/group rules.
- Permissions: grant/revoke/replace policy sets.
- Workflows: create/update/publish/pause workflow, replay workflow against fixtures.
- Agent tools: invoke safe tool operations with explicit acting principal and scope.

### Event envelope

```json
{
  "eventId": "evt_01J...",
  "workspaceId": "ws_...",
  "appId": "app_...",
  "tableId": "tbl_...",
  "aggregateType": "record",
  "aggregateId": "rec_...",
  "sequence": 1842,
  "schemaVersion": 17,
  "eventType": "record.updated",
  "commandId": "cmd_...",
  "idempotencyKey": "client-supplied-key",
  "actor": {
    "principalType": "user",
    "principalId": "usr_...",
    "sessionId": "ses_..."
  },
  "causation": {
    "source": "api",
    "requestId": "req_...",
    "triggerEventId": null,
    "workflowRunId": null,
    "agentRunId": null
  },
  "effectivePermissionsVersion": "perm_v42",
  "occurredAt": "2026-06-03T00:00:00.000Z",
  "payload": {},
  "result": {
    "projectionVersion": "proj_...",
    "changedFieldIds": ["fld_status"]
  }
}
```

### API consequences

- Reads can be state-oriented, but writes are event-oriented.
- Bulk mutations become batches of commands with deterministic per-item outcomes and emitted events.
- Idempotency keys are mandatory for non-idempotent writes and workflow actions.
- Webhooks, queues, and internal workers all consume the same envelope.

## 5. Field-Level Permission Model

### Permission layers

- Workspace-level: tenant admin, billing admin, automation admin.
- App-level: app editor, app viewer.
- Table-level: table editor, table viewer, record creator.
- Field-level: read, write, redact, formula-source, workflow-visible, agent-visible.
- View-level: can open, can edit layout, can edit records through view.
- Workflow/tool-level: can publish, can execute, can impersonate service principal.

### Policy representation

- Policies are allow-list rules with explicit scope and action sets.
- Deny-like behavior is represented by omission plus redaction overlays at field/view level.
- Policies resolve against principals, teams, and service accounts.
- Effective permission snapshots are versioned so event audit can state exactly which policy set allowed the action.

### Enforcement points

- API ingress: reject unauthorized commands before coordination.
- Durable Object coordinator: re-check effective permission snapshot before committing event.
- Read projection layer: redact fields not readable by caller.
- Workflow runtime: execute under workflow service principal constrained by workflow policy.
- Agent-tool gateway: tools declare required scopes; gateway strips inaccessible fields from inputs and outputs.

### Important rule

Field-level permissions must constrain both visibility and mutation. A user who can edit a record but not a field cannot infer that field through filters, workflow context, tool outputs, or event payload echoes.

## 6. Workflow Extensibility Model

### Workflow structure

- `Trigger` produces normalized input context.
- `Condition tree` evaluates pure predicates against normalized context and current projections.
- `Action pipeline` emits commands or external side effects.
- `Execution policy` controls retries, idempotency, timeouts, dead-letter handling, and permission identity.

### Registry approach

- Conditions and actions are registered operators with stable ids and typed JSON schemas.
- Each operator declares:
  - input schema
  - referenced capabilities
  - pure vs impure behavior
  - deterministic test fixture requirements
  - retry and idempotency semantics

### MVP trigger set

- Record created
- Record updated
- Field changed
- Scheduled trigger
- Manual trigger

### MVP condition operators

- Field equals / not equals
- Numeric compare
- String contains / starts with
- Is empty / not empty
- Boolean combine (`all`, `any`, `not`)

### MVP action operators

- Create record
- Update record
- Delete/archive record
- Send webhook
- Enqueue internal job
- Emit notification event

### Extensibility rule

New operators plug into the registry, not the workflow engine core. The engine only knows how to validate, schedule, and execute typed operators.

## 7. View Model

### MVP view types

- Grid view
- Filtered grid
- Grouped grid

### View definition

- Base table reference
- Visible field set and field order
- Filter AST
- Sort list
- Grouping config
- Row pinning or manual ordering metadata
- View-level permission overlays

### Permission behavior

- A view cannot expand access beyond underlying table/field permissions.
- Views can narrow visibility further by hiding fields or records.
- Editing through a view is allowed only if the principal can both edit the record and write each touched field.
- View definitions are versioned so shared application behavior is reproducible.

### Why this is enough for real apps

This model supports operational dashboards, scoped team backlogs, approval queues, and customer-specific worklists without requiring a full no-code page builder in MVP.

## 8. Agent-Callable Tools

### Tool design principles

- Tools are thin, named wrappers over platform commands and queries.
- Every tool invocation carries acting principal, target scope, idempotency key, and audit linkage to agent run id.
- Tools return redacted projections according to the same permission engine.

### Initial tool set

- `create_record`
- `update_record`
- `query_view`
- `create_view`
- `run_workflow`
- `explain_permissions`
- `replay_events`

### Safety model

- No raw SQL-like tool surface.
- No bypass path around command validation or policy checks.
- Tool contracts should be small, typed, and deterministic enough for agent retries.

## 9. Deterministic Testing Strategy

### Testing thesis

CloudTable should test like SQLite: deterministic, transcript-driven, and regression-heavy. Correctness depends more on replayability and invariant coverage than on large end-to-end environments.

### Core test layers

- Command-to-event golden tests: input command + fixture state => exact event envelope and projection delta.
- Event replay tests: event log => exact rebuilt materialized state.
- Permission matrix tests: principal x scope x action x field => allow/redact/deny outcome.
- Workflow transcript tests: trigger input => condition path => emitted actions/events.
- View determinism tests: same data + same view definition => same record order/visibility.
- Property/invariant tests for schema changes, idempotency, and coordinator sequencing.

### Determinism requirements

- Injectable clock, random seed, ids, and queue scheduler.
- Stable JSON normalization for snapshots and envelopes.
- Fixtures stored as text or JSON in version control.
- Queue consumers run in single-threaded deterministic harness mode for CI replay.
- Failure transcripts preserved for exact reproduction.

### Cloudflare-specific harness strategy

- Local worker runtime plus mocked Durable Object coordinator boundaries.
- D1 fixture snapshots loaded per test case.
- Queue and R2 adapters replaced with deterministic in-memory or fixture-backed shims for most tests.
- A smaller nightly suite can hit real Cloudflare primitives, but regression trust comes from the deterministic harness.

## 10. First Five Implementation Phases

### Phase 1: Architecture freeze and contracts

- Owner: CTO
- Deliverables: ADR set, command/event contract, permission model contract, operator registry contract.
- Required addition: field type registry contract covering schemas, normalization, indexing, operator compatibility, permission behavior, migrations, and deterministic fixtures.
- Exit criteria: plan approved; document revisions frozen for MVP v1.

### Phase 2: Data plane skeleton

- Owner: Backend Architect
- Deliverables: D1 schema spec, Durable Object coordination topology, event ledger model, projection model, idempotency design.
- Depends on: Phase 1

### Phase 3: Product semantics spec

- Owner: Product Architect
- Deliverables: record/view UX contract, field type catalog, permission personas, workflow authoring UX states, agent-tool product surface.
- Depends on: Phase 1

### Phase 4: Execution and correctness architecture

- Owner: Backend Architect
- Deliverables: workflow runtime spec, queue fan-out design, view query model, permission enforcement path, failure/retry model.
- Depends on: Phases 2 and 3

### Phase 5: Deterministic test architecture

- Owner: Quality Architect
- Deliverables: transcript harness spec, fixture taxonomy, regression suite plan, invariant matrix, Cloudflare-local test boundary.
- Depends on: Phases 2 and 4

## 11. Follow-Up Architecture Tasks

- Product semantics and UX contract completed in `cloudtable-product-contract.md` from [CLO-6](/CLO/issues/CLO-6).
- Data plane and execution architecture completed in `cloudtable-data-plane-execution-architecture.md` from [CLO-7](/CLO/issues/CLO-7).
- Deterministic regression and replay strategy completed in `cloudtable-deterministic-test-strategy.md` from [CLO-8](/CLO/issues/CLO-8).
- Deterministic regression harness rollout plan completed in `cloudtable-deterministic-regression-harness-rollout-plan.md` from [CLO-14](/CLO/issues/CLO-14).

## 12. Integrated Outcomes From Child Architecture Work

The child architecture work closes the remaining design gaps in the parent plan:

- Product layer: the MVP now has explicit personas, user journeys, view semantics, field-type behavior, and agent-assisted builder constraints.
- Backend layer: the data plane is now specified down to D1 table families, Durable Object ownership boundaries, sequence leasing, idempotency receipts, queue outbox handling, and replay-safe projections.
- Quality layer: the deterministic harness, fixture taxonomy, permission matrix, transcript format, CI split, and rollout gates are now specified tightly enough to drive implementation without inventing test philosophy later.

Together, these outputs turn the parent plan from a directional architecture into an implementation-ready architecture baseline for MVP Phase 2 through Phase 5.

## 13. Key Risks and Tradeoffs

- Per-table coordination via Durable Objects improves correctness but can cap write throughput. MVP should optimize for consistency and debuggability over maximum parallelism.
- Event-first writes raise implementation complexity but are necessary for workflows, audit, replay, and agent safety.
- D1 as source of truth is simpler than bespoke distributed storage, but schema and projection discipline must be strict to avoid read/write drift.
- Avoiding Workflows in MVP reduces moving parts, but some future long-running automations may later justify it.

## 14. Recommended Next Actions

1. Treat this document plus the three completed child architecture artifacts as the MVP architecture baseline.
2. Use the combined architecture set to create implementation subtasks for Phase 2 through Phase 5.
3. Keep any later architecture changes as explicit ADR-style updates rather than implicit implementation drift.
