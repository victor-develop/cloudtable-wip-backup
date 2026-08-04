# CLO-3195 CloudTable Identity/Reactive Reconciliation

Date: 2026-07-24 HKT
Goal: Identity and reactive data workflows
Issue: [CLO-3195](/CLO/issues/CLO-3195)
Parent: [CLO-3194](/CLO/issues/CLO-3194) CloudTable 15-minute project driver

## Disposition

No fresh bounded, non-duplicative CTO implementation slice is warranted from
this checkpoint.

The current code state still represents the requested capability set: Google
login, organization/workspace invitations, cross-table direct sync workflows,
rolling grouped rollup workflows, aggregate operation registry support, and
batch initialize/backfill handling. The active issue tree already has separate
continuation lanes for production Google OAuth/domain rollout and aggregate
permission-restore remediation. Creating another backend implementation child
from CLO-3195 would duplicate those lanes rather than reduce goal risk.

## Capability Reconciliation

- Google login remains represented by `/v1/auth/google/login` and
  `/v1/auth/google/callback` runtime paths, OAuth environment checks, signed
  state handling, callback exchange, session persistence, and documented callback
  configuration.
- Multi-tenant identity remains represented by D1 schema and repository support
  for users, external identities, auth sessions, organizations, workspaces,
  organization memberships, workspace memberships, invitations, and workspace
  principals.
- Organization/workspace invitations remain represented by invitation issuance,
  invitation-backed Google callback acceptance, membership provisioning,
  active-workspace selection, membership listing, and workspace switching.
- Declarative cross-table sync remains represented by `direct_sync` recipe
  authoring, `sync_related_field` action execution, workflow dependency routing,
  queue/runtime maintenance, and manual sync maintenance request surfaces.
- Rolling computed columns remain represented by `grouped_rollup` recipe
  authoring, computed `rollup` field configuration, aggregate dependency
  routing, workflow-service scoped computed writes, and manual aggregate
  maintenance request surfaces.
- Aggregate computation remains registry-backed, including count, sum, min, max,
  and average operations with catalog/validation coverage.
- Batch initialize/backfill remains represented by `workflow_backfill_jobs`,
  publish-time maintenance enqueueing, chunked resume/failure disposition, and
  manual aggregate/lookup/sync maintenance requesters.
- Prior row-owner and extensible-condition work remains completed groundwork.
  Field-type proposal-hint parity was not reopened because it does not directly
  unblock identity/reactive workflows.

## Issue State

- [CLO-3194](/CLO/issues/CLO-3194) delegated this reconciliation to CTO and can
  remain closed once this checkpoint is closed.
- [CLO-3068](/CLO/issues/CLO-3068) remains `in_review` and continues the
  production hostname / Cloudflare route / Google OAuth callback direction lane.
- [CLO-2647](/CLO/issues/CLO-2647) remains `in_review`; [CLO-2648](/CLO/issues/CLO-2648)
  and [CLO-2646](/CLO/issues/CLO-2646) remain downstream production rollout
  blockers rather than backend capability gaps.
- [CLO-2930](/CLO/issues/CLO-2930) remains `blocked`, covered by
  [CLO-3100](/CLO/issues/CLO-3100), and is a separate aggregate
  permission-restore remediation lane.
- Many repeated CloudTable project-driver issues remain `blocked`; those are
  driver bookkeeping and do not imply a missing implementation slice.

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

Close [CLO-3195](/CLO/issues/CLO-3195) as `done`. Do not create another
identity/reactive backend implementation issue from this checkpoint. Let the
existing production OAuth/domain rollout and aggregate remediation issues carry
their scoped work.
