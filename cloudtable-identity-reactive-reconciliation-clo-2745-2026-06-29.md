# CLO-2745 CloudTable identity/reactive workflow reconciliation

Date: 2026-06-29
Issue: CLO-2745
Parent: CLO-2744
Goal: Identity and reactive data workflows

## Disposition

No new child implementation issue is warranted from this reconciliation pass.

The current code state already covers the active capability goal: Google login,
workspace invitations across organizations/workspaces, session-backed workspace
membership hydration, declarative direct sync recipes, grouped rollup recipes,
extensible aggregate operations, workflow dependency routing, coordinator-owned
reactive writes under explicit workflow service identity, manual/publish
backfill, and resumable chunked aggregate backfill state.

The prior recommended backend slice from CLO-2716, resumable/chunked backfill,
is no longer just a recommendation in this workspace. `workflow_backfill_jobs`
now has `chunk_size`, `cursor_json`, and `processed_count` wired through runtime
maintenance, and the queue consumer suite includes a cursor resume test.

## Code-State Findings

- Identity and tenancy are represented in `migrations/0001_initial_schema.sql`
  by users, external identities, auth sessions, organizations, workspaces,
  organization memberships, workspace memberships, invitations, and workspace
  principals.
- Google OAuth, invitation issue/accept, tenant/workspace membership readback,
  active workspace selection, and session principal hydration are implemented in
  `src/runtime/worker.ts`.
- Direct sync and grouped rollup recipe authoring metadata are exposed through
  `src/core/workflows/authoring.ts`, `src/core/workflows/types.ts`, and worker
  recipe routes.
- Reactive dependency indexing covers triggers, resolvers, aggregates, lookups,
  and sync dependencies in `src/runtime/workflow-dependency-index.ts`.
- Reactive execution routes through `src/runtime/workflow-runtime.ts` and
  `src/runtime/aggregate-maintenance.ts`, including coordinator-owned cell
  writes with workflow service identity metadata.
- Backfill has progressed beyond observational job rows: aggregate maintenance
  now loads chunk-sized record windows, persists cursor/progress, and completes
  jobs when the final chunk is processed.

## Goal-Tree Findings

The active goal tree contains this reconciliation issue plus operational
production rollout blockers:

- CLO-2646, CLO-2647, and CLO-2648 remain blocked on production hostname,
  Cloudflare route/DNS, and Google OAuth callback configuration.
- Those blockers are operational launch readiness items, not missing backend
  identity/reactive workflow implementation.
- Historical driver issues remain blocked/in_review noise and do not expose a
  smaller new implementation slice.

## Verification

Run from the CloudTable workspace on 2026-06-29:

```bash
npm run typecheck
```

Result: passed.

```bash
npm run test:smoke
```

Result: passed, 19 tests.

```bash
npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "resumes aggregate backfill jobs from cursor_json across chunks"
```

Result: passed, 1 selected test.

```bash
npx vitest run testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "invited_session_recipe_authoring_reactive_journey"
```

Result: passed, 1 selected test.

```bash
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId|issues invitations for an authenticated member and accepts them through Google callback|creates direct sync workflow recipes through Google session auth"
```

Result: passed, 2 selected tests. The third alternation is stale wording for
logic now covered inside the Google session hydration test.

## Recommendation

Close CLO-2745 as done. Do not create another identity/reactive child issue from
this pass. If the board wants continued movement under the same capability
goal, the next live path is already tracked by CLO-2646/CLO-2647/CLO-2648:
CEO/operator must provide or apply the production hostname, Cloudflare route/DNS,
and Google OAuth callback configuration.
