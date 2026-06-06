# CloudTable Deterministic Regression Harness Rollout Plan

This document closes Phase 5 from `cloudtable-architecture-plan.md` for CLO-14. It turns the deterministic testing strategy in `cloudtable-deterministic-test-strategy.md` into an implementation rollout sequence with concrete fixture storage, suite boundaries, CI layering, and adoption gates.

## 1. Rollout Objective

Engineering should be able to build CloudTable's high-risk data plane against a fixed regression harness contract instead of inventing test structure feature by feature.

The rollout must guarantee:

- deterministic local and CI execution for semantic correctness
- stable transcript artifacts that survive review and incident-driven regression additions
- narrow nightly coverage for Cloudflare primitive drift
- explicit phase gates before record mutation, workflow, and view complexity expand

## 2. Preconditions And Inputs

This rollout assumes the following inputs are already approved and treated as upstream contracts:

- `cloudtable-data-plane-skeleton-spec.md` for command, event, projection, and idempotency seams
- `cloudtable-workflow-runtime-and-permission-spec.md` for workflow transcript stages and permission outcomes
- `cloudtable-field-type-registry-contract.md` for deterministic field normalization, indexing, redaction, and fixture behavior
- `cloudtable-deterministic-test-strategy.md` for invariant taxonomy and suite philosophy

If any of those contracts change materially, the harness contract must be revised first and the affected fixture categories re-baselined before implementation continues.

## 3. Deliverable Shape

The rollout produces four durable assets in the implementation repo:

- harness runtime package: deterministic clock, ids, PRNG, queue scheduler, Durable Object coordinator shim, D1 snapshot loader, R2/blob shim
- fixture corpus: reviewed text fixtures with canonical expected outputs
- suite runners: command golden, replay, permission matrix, workflow transcript, view determinism, invariant/property, and nightly Cloudflare smoke entry points
- contributor rules: fixture authoring, golden update discipline, and incident-to-regression promotion workflow

## 4. Fixture Storage Shape

Use a text-first layout so failures can be promoted directly into reviewed fixtures:

```text
testing/cloudtable/
  harness/
    runtime/
    adapters/
    serializers/
  fixtures/
    commands/<scenario>/
    replays/<scenario>/
    permissions/<scenario>/
    workflows/<scenario>/
    views/<scenario>/
    invariants/<scenario>/
    failures/<scenario>/
    snapshots/<scenario>/
  suites/
    command-golden/
    replay/
    permissions/
    workflows/
    views/
    invariants/
    nightly-cloudflare/
  docs/
    fixture-authoring.md
    golden-update-policy.md
```

Per-scenario directory contract:

- `meta.json`: scenario id, schema version, seed, logical start time
- `seed-state.json` or `schema.json`: deterministic starting state
- `command.json` or `events.jsonl`: primary input
- `expected-events.json`
- `expected-projections.json`
- `expected-side-effects.json`
- `expected-result.json` when a command response exists
- `notes.md` for human intent and risk being covered

Canonical formatting requirements:

- JSON objects sorted by key
- newline-terminated files
- event streams stored as JSONL when append order matters
- normalized timestamps in UTC ISO-8601 with millisecond precision
- deterministic ids present in fixtures, never generated at assertion time

## 5. Suite Boundaries

The fast deterministic suite owns semantic correctness:

- `command-golden`: command validation, emitted events, idempotency, projection deltas, side-effect intents
- `replay`: full rebuild, checkpoint rebuild, corruption detection, snapshot-plus-tail recovery
- `permissions`: allow/redact/deny matrix across principal, scope, action, and field mode
- `workflows`: trigger selection, condition traces, action planning, retries, and duplicate-suppression semantics
- `views`: filter/sort/group behavior, hidden fields, redacted formulas, cursor stability
- `invariants`: bounded property checks for ordering, append monotonicity, replay stability, and idempotency receipts

The nightly Cloudflare suite owns adapter trust only:

- worker packaging and boot
- D1 migration/bootstrap compatibility
- Durable Object binding/bootstrap behavior
- Queue delivery plumbing
- R2 snapshot round trip

Anything that can be proven with deterministic shims must stay out of the nightly suite.

## 6. Harness Runtime Contract

All fast suites use the same injected runtime contract:

- `clock`: fixed logical time with explicit advancement APIs
- `idGenerator`: seeded deterministic id stream
- `random`: seeded PRNG for every previously ambient random branch
- `queueScheduler`: single-threaded scheduler that records enqueue, dequeue, retry, and dead-letter decisions
- `durableObjectCoordinator`: in-memory coordinator enforcing production command serialization and idempotency boundaries
- `blobStore`: fixture-backed snapshot/object adapter with deterministic keys
- `eventLedger`: append-only event sink using seeded local state and canonical serialization
- `projectionStore`: disposable read-model store rebuilt from deterministic inputs

Non-negotiable implementation rules:

- production code may not call wall clock time, UUID generation, or ambient randomness directly
- queue handlers and workflow actions must accept explicit delivery metadata from the harness
- projection assertions compare canonical serialized output, not ad hoc object equality
- deterministic shims must expose the same failure classes used by production adapters

## 7. Rollout Waves

### Wave 0: Harness foundation

Scope:

- implement canonical serializers
- implement deterministic runtime interfaces
- wire production seams so ambient time/random/id access is impossible in tested paths
- add fixture loader and diff-friendly failure reporter

Exit gate:

- one smoke fixture can run end to end through the harness
- serializer output is byte-stable across repeated local runs
- code review confirms no direct ambient dependency use remains in target seams

### Wave 1: Command golden baseline

Scope:

- land the first ten fixtures defined in `cloudtable-deterministic-test-strategy.md`
- implement command result, event, projection, and side-effect assertions
- enforce intentional golden updates only

Exit gate:

- record create/update/idempotency and basic workflow trigger fixtures pass
- conflicting idempotency and corrupt stream diagnostics are explicit and stable
- fixture authoring guide is present for contributors

### Wave 2: Replay and permission matrix

Scope:

- add replay-from-zero and replay-from-checkpoint runners
- implement table-driven permission matrix execution
- cover redaction leakage risks through sort/filter/group/formula paths

Exit gate:

- replay rebuild and checkpoint rebuild agree for seeded scenarios
- allow/redact/deny outcomes are stable for every MVP principal/action class
- at least one permission downgrade case proves no hidden-field leakage through views

### Wave 3: Workflow and view determinism

Scope:

- implement workflow transcript runner stages
- add duplicate-delivery, retry, and permission-drift scenarios
- add deterministic view scenarios for filter/sort/group/pagination stability

Exit gate:

- workflow transcripts show stable selected workflow ids, operand traces, and retry classes
- no workflow retry can double-emit domain events under the same idempotency key
- view outputs remain stable after unrelated writes and permission changes

### Wave 4: CI split and Cloudflare smoke

Scope:

- wire per-commit deterministic suites
- wire nightly Cloudflare smoke suite
- document incident-to-regression promotion and ownership

Exit gate:

- PR path runs deterministic suites within the agreed merge budget
- nightly failures isolate adapter/platform regressions without reopening semantic debugging
- ownership for failures is explicit: product logic failures go to implementation owners, adapter drift goes to platform owners

## 8. CI Layering Plan

Per-commit requirements:

- run command, replay, permission, workflow, and view suites on every PR
- run bounded invariant/property seeds on every PR
- block merges on any golden diff unless the golden artifact is intentionally updated in the change set

Nightly requirements:

- run the narrow Cloudflare primitive suite after mainline merges
- publish transcript artifacts and adapter logs for any nightly failure
- auto-file a follow-up issue when nightly fails twice consecutively for the same scenario

Recommended budget targets:

- deterministic PR suite: short enough to be a default merge gate
- nightly suite: broad enough to catch platform drift, narrow enough to debug in one sitting

The exact minute budget can be set by engineering once the implementation environment exists, but the split must stay fixed.

## 9. Adoption Rules

Implementation teams should follow these rules from the first data-plane feature onward:

- no mutating feature merges without at least one matching deterministic fixture
- production incidents fixed in code or policy must add a regression fixture in the same change or an explicitly linked follow-up blocker
- new field types must add registry-driven fixture coverage for normalization, indexing, operators, and redaction behavior
- new workflow operators must declare transcript requirements before implementation lands
- nightly-only tests may never be the sole proof of business logic correctness

## 10. Ownership And Review Path

- Quality architecture owns harness contracts, fixture conventions, and CI split policy
- Data-plane implementation owns command/replay fixture additions tied to record and schema semantics
- Workflow implementation owns transcript fixtures for triggers, conditions, actions, and retries
- Platform ownership covers Cloudflare smoke maintenance and adapter drift response

Any proposed harness contract change should be reviewed against all four ownership areas before merge because serializer, fixture, and CI drift will otherwise fragment quickly.

## 11. Done Criteria

This rollout is complete when all of the following are true:

- the runtime contract in Section 6 is implemented without ambient nondeterminism in covered paths
- the first fixture set exists and passes in the fast suite
- replay, permission, workflow, and view runners are wired into the per-commit path
- nightly Cloudflare smoke coverage exists for D1, Durable Objects, Queues, and R2
- fixture authoring and golden update rules are documented for contributors
- incident-to-regression promotion is enforced as a standing rule

At that point the MVP implementation can proceed with a stable regression harness instead of open-ended test design work.
