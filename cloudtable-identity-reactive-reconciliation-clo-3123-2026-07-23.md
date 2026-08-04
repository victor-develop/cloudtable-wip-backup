# CLO-3123 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-23 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3123](/CLO/issues/CLO-3123)
Parent: [CLO-3122](/CLO/issues/CLO-3122) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative implementation slice is warranted after
[CLO-3121](/CLO/issues/CLO-3121).

[CLO-3121](/CLO/issues/CLO-3121) is now `done`. The current codebase still
represents the identity/reactive workflow capability set, and the issue tree
still has first-class continuation lanes for production OAuth/domain rollout and
the separate aggregate remediation recovery path. Creating another backend slice
from this checkpoint would duplicate existing lanes rather than advance the
active goal.

## Capability Reconciliation

- Google login remains represented by the runtime Google OAuth login/callback
  path and session persistence, including callback exchange and authenticated
  session resolution.
- Multi-tenant identity remains represented by schema support for users,
  external identities, auth sessions, organizations, workspaces, organization
  memberships, workspace memberships, invitations, and workspace principals.
- Invites into organizations and workspaces remain represented by invitation
  ingress and repository persistence/readback, plus session tenant selection and
  membership listing for user workspace context.
- Cross-table sync remains represented by `direct_sync` recipe authoring,
  `sync_related_field` actions, dependency-index derivation for sync routes,
  queue/runtime maintenance, and `requestWorkflowSyncMaintenance`.
- Rolling computed columns remain represented by `grouped_rollup` recipes,
  aggregate dependency derivation, computed-field maintenance writes, queue
  continuation, and `requestWorkflowAggregateMaintenance`.
- Rolling compute remains extensible through the aggregate operation registry,
  currently covering `count_records`, `sum_numbers`, `max_number`,
  `min_number`, and `average_numbers`.
- Batch initialize/backfill remains represented by `workflow_backfill_jobs`,
  publish-time maintenance enqueueing, chunking/resume state, and manual
  aggregate/lookup/sync maintenance requesters.
- Prior row-owner and extensible-condition work remains treated as completed
  groundwork; this checkpoint did not reopen it.

## Issue State

- [CLO-3122](/CLO/issues/CLO-3122) is blocked by this checkpoint,
  [CLO-3123](/CLO/issues/CLO-3123), and can resume when this issue closes.
- [CLO-3068](/CLO/issues/CLO-3068) remains `in_review` and continues the
  production hostname / Cloudflare route / Google OAuth callback lane.
- [CLO-2647](/CLO/issues/CLO-2647) remains `in_review`; [CLO-2648](/CLO/issues/CLO-2648)
  and [CLO-2646](/CLO/issues/CLO-2646) remain the downstream production rollout
  blockers.
- [CLO-2930](/CLO/issues/CLO-2930) remains `blocked`, covered by
  [CLO-3100](/CLO/issues/CLO-3100), and is a recovery/remediation lane rather
  than a new identity/reactive capability implementation gap.
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

Close [CLO-3123](/CLO/issues/CLO-3123) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let
[CLO-3122](/CLO/issues/CLO-3122) resume through its first-class blocker link,
while the production OAuth/domain and aggregate remediation lanes continue under
their existing issues.
