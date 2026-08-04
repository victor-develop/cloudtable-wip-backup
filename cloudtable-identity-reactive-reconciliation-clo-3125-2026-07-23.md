# CLO-3125 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-23 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3125](/CLO/issues/CLO-3125)
Parent: [CLO-3124](/CLO/issues/CLO-3124) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-3123](/CLO/issues/CLO-3123).

The current codebase and active issue state still match the post-CLO-3123
checkpoint: the required identity and declarative reactive workflow surfaces are
represented, and the remaining live work is already tracked through existing
continuation lanes. Creating another backend implementation child from this
checkpoint would duplicate those lanes rather than move the active goal forward.

## Capability Reconciliation

- Google login remains represented by `/v1/auth/google/login` and
  `/v1/auth/google/callback` in `src/runtime/worker.ts`, including signed state,
  redirect URI handling, OAuth exchange, canonical user/session persistence, and
  onboarding or invitation context propagation.
- Multi-tenant identity remains represented by D1 schema support for users,
  external identities, auth sessions, organizations, workspaces, organization
  memberships, workspace memberships, invitations, and workspace principals.
- Organization/workspace invitations remain represented by invitation issuance,
  invitation-backed Google callback acceptance, membership provisioning,
  tenant/session selection, membership listing, and workspace switching paths.
- Cross-table sync remains represented by `direct_sync` recipe authoring,
  `sync_related_field` actions, dependency-index routing, queue/runtime
  maintenance, and `requestWorkflowSyncMaintenance`.
- Rolling computed columns remain represented by `grouped_rollup` recipes,
  computed `rollup` field configuration, aggregate dependency routing,
  workflow-service scoped maintenance writes, queue continuation, and
  `requestWorkflowAggregateMaintenance`.
- Extensible aggregate operations remain registry-backed, currently covering
  `count_records`, `sum_numbers`, `max_number`, `min_number`, and
  `average_numbers`, with catalog and validation coverage.
- Batch initialize/backfill remains represented by `workflow_backfill_jobs`,
  publish-time maintenance enqueueing, chunk/resume disposition handling, and
  manual aggregate/lookup/sync maintenance requesters.
- Current regression coverage also includes invited-user reactive scenarios,
  direct sync recipe authoring, grouped rollup recipe authoring, and average
  rollup recompute/backfill cases. Prior row-owner and extensible-condition work
  remains completed groundwork and was not reopened.

## Issue State

- [CLO-3124](/CLO/issues/CLO-3124) is blocked by this checkpoint,
  [CLO-3125](/CLO/issues/CLO-3125), and can resume through the first-class
  blocker link when this issue closes.
- [CLO-3068](/CLO/issues/CLO-3068) remains `in_review` and continues the
  production hostname / Cloudflare route / Google OAuth callback direction lane.
- [CLO-2647](/CLO/issues/CLO-2647) remains `in_review`; [CLO-2648](/CLO/issues/CLO-2648)
  and [CLO-2646](/CLO/issues/CLO-2646) remain downstream production rollout
  lanes. [CLO-2648](/CLO/issues/CLO-2648) still needs operator attention.
- [CLO-2930](/CLO/issues/CLO-2930) remains `blocked` and covered by
  [CLO-3100](/CLO/issues/CLO-3100), which has an active recovery action. This
  is a separate aggregate permission-restore remediation lane, not a reason to
  create another identity/reactive backend implementation issue.
- The workspace remains dirty with broad pre-existing CloudTable product
  changes and historical checkpoint artifacts. This checkpoint added only this
  report and did not modify product code.

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

Close [CLO-3125](/CLO/issues/CLO-3125) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3124](/CLO/issues/CLO-3124) resume through its first-class blocker link,
while production OAuth/domain rollout and aggregate remediation continue under
their existing issues.
