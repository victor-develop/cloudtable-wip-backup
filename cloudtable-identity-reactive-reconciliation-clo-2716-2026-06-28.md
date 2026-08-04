# CLO-2716 CloudTable identity/reactive workflow reconciliation

Date: 2026-06-28
Issue: CLO-2716
Parent: CLO-2715
Goal: Identity and reactive data workflows

## Scope

Reconciled the current CloudTable codebase against the active capability goal: multi-tenant identity plus declarative reactive data workflows. I did not change product code; the current tree already contains substantial implementation work and the right action was to identify the remaining smallest slices.

The parent goal tree currently has only this reconciliation child under CLO-2715. There are no implementation children yet for the current identity/reactive workflow goal.

## Current State

### Identity and tenancy

- `migrations/0001_initial_schema.sql` now has the expected tenant identity foundation: `users`, `external_identities`, `auth_sessions`, `organizations`, `workspaces.organization_id`, `organization_memberships`, `workspace_memberships`, `invitations`, and `workspace_principals`.
- `src/runtime/worker.ts` exposes Google login/callback, invitation issuance/acceptance, session hydration, tenant listing, workspace membership listing, and session workspace selection.
- Google login supports existing external identity lookup, email-linked canonical users, invite acceptance, tenant bootstrap onboarding, conflict detection when an external identity belongs to another user, secure session cookies, and redirect allow-listing.
- Session-authenticated command ingress can hydrate the workspace principal when a request omits `principalId`, keeping the existing command/permission path intact.

Representative tests already present:

- Repository identity provisioning, Google external identity linking, and invitation acceptance in `testing/cloudtable/suites/repository/d1-repository.spec.ts`.
- Runtime Google callback, invitation acceptance, cross-organization invite/session switching, tenant bootstrap, session principal hydration, admin-only membership/invitation APIs, and redirect validation in `testing/cloudtable/suites/runtime/ingress.spec.ts`.

### Workflow authoring and reactive data

- Workflow types now include related table resolvers, aggregate definitions, lookup definitions, dependency fields, and `sync_related_field` action metadata.
- Authoring surfaces support recipe preview/create for `direct_sync` and `grouped_rollup` through `src/runtime/worker.ts` and `src/core/workflows/authoring.ts`.
- `src/core/aggregates/registry.ts` has extensible aggregate operations: `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
- `src/runtime/workflow-dependency-index.ts` derives and persists trigger, resolver, aggregate, lookup, and sync dependencies into `workflow_dependency_index`.
- `src/runtime/workflow-runtime.ts` routes source events through the dependency index and queues aggregate, lookup, and sync maintenance. It also queues publish-time backfill maintenance.
- `src/runtime/aggregate-maintenance.ts` executes aggregate, lookup, and sync maintenance through coordinator-owned `cell.set`, using workflow service identity metadata and idempotent command keys.
- `workflow_backfill_jobs` exists and is updated from queued to running/completed for backfill maintenance. It is currently an observational/idempotency state table, not a resumable chunk scheduler.

Representative tests already present:

- Workflow operator and authoring tests for principal aliases, proposal drafting, lookup metadata, grouped rollup metadata, and cross-table sync metadata.
- Runtime ingress tests for workflow recipe create/publish, dependency inspection, backfill queue creation, Google-session-authored direct sync recipe creation, invited-user grouped rollup mutation, and view readback.
- Runtime queue consumer tests for single-relation and value-matched sync maintenance, numeric aggregate recompute/backfill, lookup maintenance, dependency routing, service identity validation, and dead-letter behavior.

## Gap Assessment

The code state is ahead of the parent goal decomposition. The requested use cases are no longer purely design work:

- Google login: implemented and tested at repository/runtime level.
- Users invited into different organizations/workspaces: implemented and tested, including active workspace selection and switching.
- Cross-table sync from Table A field 1 to Table B field 2: implemented through `direct_sync` recipe metadata plus maintenance execution.
- Rolling computed columns with sum grouped by a source field matching a target field/relation: implemented through `grouped_rollup`, aggregate metadata, `sum_numbers`, dependency routing, and maintenance execution.
- Extensible rolling compute operations: operation registry exists with multiple operations and manifest exposure.
- Batch initialize/backfill: implemented for publish-time/manual backfill as queued maintenance with job observability. The next product-grade slice is resumable/chunked backfill using the existing job cursor fields.

## Recommended Next Slices

1. Backend Architect: make backfill resumable/chunked.
   - Scope: turn `workflow_backfill_jobs.cursor_json`, `chunk_size`, and `processed_count` into a real chunked processor for aggregate, lookup, and sync backfills.
   - Dependencies: current maintenance executor and dependency index are in place.
   - Tests: add runtime queue-consumer tests proving multi-chunk progress, resume after partial failure, idempotent duplicate messages, and final completed state. Verify with `npm run typecheck` and `npm run test:runtime`.

2. Quality Architect: promote the identity plus reactive workflow journey into a stable regression/smoke guard.
   - Scope: add or consolidate a deterministic regression scenario that starts from Google/invitation session auth, creates/publishes a direct sync and grouped rollup recipe, triggers recompute, runs backfill, and reads the permissioned view output.
   - Dependencies: existing runtime ingress and queue-consumer coverage.
   - Tests: verify with `npm run test:runtime`, `npm run test:regression`, and `npm run test:smoke`.

3. Product Architect: document the workflow recipe contract for operators.
   - Scope: produce concise product/API docs for `direct_sync`, `grouped_rollup`, aggregate operation IDs, dependency inspection, and manual maintenance endpoints.
   - Dependencies: current worker endpoints and authoring metadata.
   - Tests: documentation review against current route names and request/response shapes; no code test required unless examples are executable.

## Verification Run

- `npm run typecheck`: pass
- `npm run test:workflows`: pass, 31 tests
- `npm run test:runtime`: pass, 203 tests
- `npm run test:smoke`: pass, 19 tests
- Mistaken command: `npm run test:runtime -- --runInBand` failed because Vitest does not support the Jest `--runInBand` option; rerun without that flag passed.

