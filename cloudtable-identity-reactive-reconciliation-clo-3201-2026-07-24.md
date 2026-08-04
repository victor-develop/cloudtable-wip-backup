# CLO-3201 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-24 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3201](/CLO/issues/CLO-3201)
Parent: [CLO-3199](/CLO/issues/CLO-3199) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted from this
checkpoint.

The current CloudTable code state still represents the requested
multi-tenant identity and declarative reactive workflow capability set. The
remaining active lanes are production rollout/review and the separate aggregate
permission-restore remediation path; creating another backend implementation
child from this checkpoint would duplicate those lanes rather than reduce goal
risk.

## Code Reconciliation

- Google login remains implemented through `/v1/auth/google/login` and
  `/v1/auth/google/callback`, signed state, Google token/userinfo exchange,
  redirect sanitization, session cookie persistence, and runtime auth config
  checks in `src/runtime/worker.ts`.
- Multi-tenant identity remains backed by schema and repository support for
  users, external identities, auth sessions, organizations, workspaces,
  organization memberships, workspace memberships, invitations, and workspace
  principals.
- Organization/workspace invitations remain represented by invitation issuance
  ingress, invitation-token Google callback acceptance, membership
  provisioning, active-workspace selection, tenant listing, workspace
  switching, and membership read paths.
- Permissioned views and field-level permissions remain represented by
  permission snapshot resolution, table/schema/workflow/view metadata
  guardrails, projection redaction/hidden-field handling, command ingress
  authorization, and agent-tool filtering.
- Declarative cross-table sync remains represented by the `direct_sync` recipe
  path, `sync_related_field` action metadata/execution, workflow dependency
  index storage/routing, queue/runtime maintenance, and manual
  `requestWorkflowSyncMaintenance` surfaces.
- Rolling computed columns remain represented by the `grouped_rollup` recipe
  path, computed `rollup` field metadata, routed aggregate definitions,
  workflow service identity writes to `computed.readonly` fields, and manual
  `requestWorkflowAggregateMaintenance` surfaces.
- Aggregate computation remains registry-backed for `count_records`,
  `sum_numbers`, `max_number`, `min_number`, and `average_numbers`, preserving
  the intended extensible operation model.
- Batch initialize/backfill remains represented by `workflow_backfill_jobs`,
  publish/manual maintenance enqueueing, chunk cursors, running/completed/failed
  state transitions, continuation enqueueing, and operator disposition ingress.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  unblock identity/reactive workflows.

## Goal/Issue State

- [CLO-3199](/CLO/issues/CLO-3199) delegated this reconciliation and can resume
  when [CLO-3201](/CLO/issues/CLO-3201) closes.
- [CLO-3068](/CLO/issues/CLO-3068) is still `in_review` and covers the
  production hostname / Cloudflare route / Google OAuth callback direction lane.
- [CLO-2647](/CLO/issues/CLO-2647) is still `in_review`; [CLO-2648](/CLO/issues/CLO-2648)
  and [CLO-2646](/CLO/issues/CLO-2646) remain production rollout blockers.
- [CLO-2930](/CLO/issues/CLO-2930) remains `blocked`, covered by
  [CLO-3100](/CLO/issues/CLO-3100), and is a separate aggregate
  permission-restore remediation lane.
- The worktree remains dirty with broad pre-existing CloudTable product changes
  and historical reconciliation artifacts. This checkpoint added only this
  report.

## Verification

```bash
npm run --silent typecheck
```

Result: passed.

```bash
npm run --silent test:smoke
```

Result: passed. Two smoke files passed, with 20 tests passing.

## Recommendation

Close [CLO-3201](/CLO/issues/CLO-3201) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let the
existing production OAuth/domain rollout and aggregate remediation issues carry
their scoped work.
