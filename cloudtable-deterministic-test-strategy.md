# CloudTable Deterministic Test And Regression Strategy

This document expands the quality architecture outlined in `cloudtable-architecture-plan.md` for CLO-8. It defines the deterministic harness, fixture taxonomy, regression matrix, and CI split required before CloudTable implementation begins.

## 1. Testing Philosophy

CloudTable should test like SQLite, not like a browser app or a distributed system integration testbed.

The implications:

- The primary correctness artifact is a deterministic transcript, not an ephemeral environment.
- Every write path should be explainable as `command -> validated decision -> emitted events -> projection delta -> side-effect intents`.
- Replaying the same fixture with the same seed, clock, and scheduler must produce byte-stable results.
- Failures must be captured as reusable transcripts that can be checked into version control and replayed locally or in CI without Cloudflare account access.
- The default suite should prove semantic correctness. Real Cloudflare primitive tests should only prove adapter wiring and platform assumptions.

## 2. Deterministic Harness Model

### Harness contract

Each deterministic test case runs inside a single harness process with the following injected dependencies:

- `clock`: fixed logical time source with explicit advancement.
- `idGenerator`: deterministic ID stream seeded per test.
- `random`: seeded PRNG exposed to any code path that would otherwise use platform randomness.
- `queueScheduler`: single-threaded scheduler that records enqueue/dequeue order and retry decisions.
- `durableObjectCoordinator`: in-memory coordinator shim that enforces the same command serialization contract as the real Durable Object boundary.
- `blobStore`: fixture-backed R2 shim with deterministic keys and payload reads.
- `eventLedger`: append-only event sink backed by fixture state or test-local D1 snapshot.
- `projectionStore`: rebuilt read models loaded from fixture snapshots and rebuilt in test.

### Required invariants

- No production code path may call wall clock time, UUID generators, or ambient randomness directly.
- Queue handlers must accept an explicit delivery envelope and retry metadata from the harness.
- Durable Object coordination must be exercised through the same command boundary used in production, even when the backing implementation is in-memory.
- Snapshot serialization must use canonical JSON ordering and normalized number/string formatting.
- Any non-deterministic adapter must have a deterministic replacement for the fast suite.

## 3. System Boundaries

### What stays deterministic in the main suite

- Command validation and normalization
- Event envelope generation
- Event append ordering and idempotency checks
- Projection rebuilds
- Permission enforcement and redaction
- Workflow trigger, condition, and action selection
- View filtering, sorting, grouping, pagination cursors, and hidden field behavior
- Queue fan-out decisions and retry classification

### What is simulated

- Durable Objects: emulate serialization, reentrancy restrictions, and per-table coordinator ownership.
- Queues: emulate delivery order, retries, poison-message handling, and dead-letter transitions.
- R2: emulate fixture snapshot reads/writes and object version references.
- D1: use local seeded snapshots or an isolated local database file restored from checked-in fixtures.

### What moves to the nightly smoke suite

- Worker runtime deployment packaging
- Real D1 adapter compatibility and migration bootstrap
- Real Durable Object binding/bootstrap behavior
- Real Queue delivery plumbing
- Real R2 object persistence adapter behavior

Nightly tests should stay narrow. They verify that the deterministic assumptions map to Cloudflare primitives, not semantic correctness already covered by the harness.

## 4. Fixture Taxonomy

Fixtures should be text-first and small enough to review in diffs. Prefer one scenario per directory.

Recommended layout:

```text
fixtures/
  commands/
  replays/
  permissions/
  workflows/
  views/
  invariants/
  failures/
  snapshots/
```

### Fixture parts

- `meta.json`: scenario id, description, seed, logical start time, schema version.
- `seed-state.json`: workspace/app/table schema plus optional record snapshot.
- `command.json`: input command envelope for command-driven tests.
- `expected-events.json`: exact event stream emitted by the command or workflow.
- `expected-projections.json`: expected read-model delta or rebuilt state.
- `expected-side-effects.json`: queue, webhook, notification, or blob intents.
- `expected-result.json`: command response or error contract.
- `notes.md`: human explanation for why this case exists.

### Example command-to-event fixture

```json
{
  "meta": {
    "scenario": "record_update_formula_recalc",
    "seed": 17,
    "logicalTime": "2026-01-15T10:00:00.000Z"
  },
  "command": {
    "type": "update_record",
    "principal": { "type": "user", "id": "usr_alice", "roles": ["editor"] },
    "workspaceId": "ws_demo",
    "tableId": "tbl_tasks",
    "recordId": "rec_001",
    "idempotencyKey": "cmd-001",
    "patch": {
      "status": "done"
    }
  }
}
```

Matching expected event excerpt:

```json
[
  {
    "seq": 44,
    "type": "record.updated",
    "tableId": "tbl_tasks",
    "recordId": "rec_001",
    "actor": "usr_alice",
    "patch": { "status": "done" }
  },
  {
    "seq": 45,
    "type": "formula.recomputed",
    "tableId": "tbl_tasks",
    "recordId": "rec_001",
    "fieldId": "fld_completed_at"
  }
]
```

## 5. Command-To-Event Golden Tests

Each mutating command should have golden coverage for:

- happy path emission
- validation failure before event append
- idempotent retry with identical payload
- idempotency-key reuse with conflicting payload
- permission denied before mutation
- schema-version mismatch
- derived field recalculation
- workflow-trigger side-effect intent creation

Assertions per test:

- exact result contract
- exact ordered events
- exact projection delta
- exact side-effect intents
- no extra writes outside the expected tables/streams

Golden files should be updated intentionally, never auto-accepted in CI.

## 6. Event Replay And Projection Rebuild Tests

Replay tests prove that the event ledger is sufficient to rebuild system state exactly.

### Replay fixture format

- `schema.json`: tables, fields, views, policies, workflow definitions
- `events.jsonl`: canonical event stream in append order
- `expected-materialized-state.json`: rebuilt records, indexes, view outputs, workflow checkpoints
- `expected-audit.json`: summary counts, last sequence, dedupe keys, projection versions

### Replay assertions

- full rebuild from zero matches expected materialized state
- incremental rebuild from a checkpoint matches full rebuild
- rebuilding twice is stable and side-effect free
- historical redactions are preserved where policy demands redacted projections rather than hard deletes
- corrupted or out-of-order event fixtures fail with explicit diagnostic output

## 7. Permission Matrix Strategy

Permission correctness is high risk because CloudTable exposes data through writes, reads, views, workflows, and agent tools.

### Matrix axes

- principal: owner, admin, editor, commenter, viewer, automation actor, agent tool caller
- scope: workspace, app, table, record, field, view
- action: create, update, delete, read, query_view, run_workflow, explain_permissions, replay_events
- field mode: visible, hidden, computed, locked, personally restricted

### Required outcomes

- `allow`: action succeeds with full field visibility
- `redact`: action succeeds but restricted fields are removed or masked
- `deny`: action rejected with stable error code and no side effects

### Matrix design rules

- Prefer table-driven fixtures over bespoke test code.
- Every field-level policy must have both positive and negative cases.
- View tests must verify that hidden-field redaction does not leak through sorts, groups, filters, aggregates, or formula dependencies.
- Workflow tests must verify that automation actors operate under explicit service principals, not implicit owner rights.

## 8. Workflow Transcript Tests

Workflow correctness should be captured as transcripts rather than loose mocks.

Transcript stages:

1. trigger input received
2. workflow candidate selection
3. condition evaluation trace
4. action execution plan
5. emitted events and side-effect intents
6. retry or terminal failure classification

Assertions:

- selected workflow ids are stable
- condition evaluation includes the same operand values and comparator choices on replay
- emitted actions occur in deterministic order
- retried actions do not duplicate domain events when guarded by idempotency keys
- terminal failures produce replayable failure transcripts

## 9. View Determinism Tests

Views must be deterministic because they define application behavior, not just presentation.

Cover at minimum:

- filter predicates over scalar, relation, and computed fields
- stable sort ordering with ties
- grouping bucket membership and empty-group handling
- hidden fields and redacted formulas
- pagination cursor stability after replay
- record visibility changes after permission or schema updates

View assertions should compare:

- visible record ids in order
- projected field payloads after redaction
- grouping metadata
- cursor tokens or logical equivalents

## 10. Failure Transcript Model

Every deterministic failure should produce a transcript artifact that can be promoted into a regression fixture.

Recommended transcript payload:

```json
{
  "scenario": "workflow_retry_permission_denied",
  "seed": 91,
  "logicalTime": "2026-02-01T03:00:00.000Z",
  "command": { "type": "run_workflow", "workflowId": "wf_notify" },
  "timeline": [
    { "phase": "trigger_received", "at": 0 },
    { "phase": "condition_evaluated", "at": 1, "result": true },
    { "phase": "action_denied", "at": 2, "code": "FIELD_PERMISSION_DENIED" }
  ],
  "events": [],
  "sideEffects": [
    { "type": "queue.retry_scheduled", "attempt": 1, "delayMs": 5000 }
  ],
  "error": {
    "code": "FIELD_PERMISSION_DENIED",
    "retryClass": "transient_misconfiguration"
  }
}
```

Promotion rule:

- Any production incident fixed by code or policy change must add either a new deterministic regression fixture or an extension of an existing matrix case.

## 11. CI Layout

### Per-commit suite

Runs on every PR/push and must finish quickly enough to block merges.

- command golden tests
- replay rebuild tests
- permission matrix tests
- workflow transcript tests
- view determinism tests
- invariant/property tests with bounded seeds

### Nightly suite

Runs against real Cloudflare primitives with a narrow scenario set.

- deploy minimal worker package
- bootstrap D1 schema
- exercise one coordinator path through Durable Objects
- exercise one queue-triggered workflow path
- exercise one R2 snapshot round trip

Nightly failures should not require semantic re-debugging first. The deterministic suite should already isolate logic bugs; nightly should isolate adapter or platform drift.

## 12. Regression Matrix

Minimum required regression categories:

- idempotent command replay
- duplicate event append rejection
- out-of-order replay rejection
- schema migration backward compatibility for replay
- permission downgrade causing read redaction
- permission downgrade causing write denial
- workflow retry without double-emit
- workflow operator branching determinism
- view ordering stability after unrelated writes
- formula recomputation after dependent-field update
- snapshot restore followed by event catch-up
- failure transcript reproduction

## 13. First Fixture Set

The first implementation pass should create these fixtures before broad feature work:

1. `record_create_basic`
2. `record_update_with_formula_recompute`
3. `idempotent_retry_same_payload`
4. `idempotency_conflict_different_payload`
5. `permission_redaction_hidden_salary_field`
6. `workflow_trigger_status_change_notification`
7. `view_sort_filter_group_stability`
8. `replay_from_snapshot_plus_tail_events`
9. `queue_retry_without_double_emit`
10. `corrupt_event_stream_detected`

## 14. Exit Criteria For Phase 5

Phase 5 is ready to hand to implementation when:

- the harness contract is frozen
- the fixture directory layout is agreed
- canonical snapshot/event formats are defined
- the regression matrix is mapped to concrete fixture scenarios
- CI and nightly ownership boundaries are explicit
- incident-to-regression promotion rules are documented

At that point engineering can implement the harness without reopening test philosophy debates.
