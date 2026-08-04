# CLO-2332 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-23
Goal: Identity and reactive data workflows
Issue: [CLO-2332](/CLO/issues/CLO-2332)
Parent: [CLO-2331](/CLO/issues/CLO-2331) CloudTable 15-minute project driver

## Disposition

No new bounded implementation issue is warranted from this reconciliation pass.

The current source-of-truth lane already covers the new capability goal:
multi-tenant identity plus declarative reactive workflows. The remaining live
work in the broader goal tree is [CLO-2321](/CLO/issues/CLO-2321), which is in
review on the production OAuth/deployment-hardening plan after its implementation
and QA children completed. Creating another child from [CLO-2332](/CLO/issues/CLO-2332)
would duplicate existing coverage rather than unblock a newly identified gap.

## Evidence

- Current parent [CLO-2331](/CLO/issues/CLO-2331) is blocked only by
  [CLO-2332](/CLO/issues/CLO-2332).
- Recent goal-tree work already completed:
  - [CLO-2320](/CLO/issues/CLO-2320): workflow authoring product surface/API docs.
  - [CLO-2324](/CLO/issues/CLO-2324): workflow recipe authoring UX spec.
  - [CLO-2325](/CLO/issues/CLO-2325): workflow recipe API documentation.
  - [CLO-2326](/CLO/issues/CLO-2326): workflow recipe authoring frontend flow.
  - [CLO-2329](/CLO/issues/CLO-2329): QA review for the recipe authoring runtime flow.
  - [CLO-2330](/CLO/issues/CLO-2330): workflow recipe catalog permission-scope fix.
- Code inspection confirms identity/session/invitation coverage in
  `src/runtime/worker.ts` and related runtime tests:
  - Google OAuth login and callback handling.
  - signed session cookie config and readiness checks.
  - workspace invitation issuance and callback acceptance.
  - multi-membership active workspace selection and session switching.
- Code inspection confirms reactive workflow coverage:
  - `direct_sync` and `grouped_rollup` recipe catalog metadata.
  - preview/create ingress for recipe-authored proposals.
  - optional publish-on-create flow.
  - aggregate operations for count, sum, max, and average.
  - sync and aggregate maintenance routes for backfill/recompute.
- Field-type proposal-hint parity remains intentionally out of scope because it
  does not directly block the current identity/reactive workflow goal.

## Verification

Run on 2026-06-23 against the current workspace:

```bash
git diff --check
npm run typecheck
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|canonical direct-sync recipe authoring contract|canonical grouped-rollup recipe authoring contract|returns workflow recipe authoring metadata through the worker read ingress|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching"
```

Results:

- `git diff --check` passed.
- `npm run typecheck` passed.
- Focused Vitest passed: 2 files passed, 8 tests passed, 169 skipped.

## Recommendation

Close [CLO-2332](/CLO/issues/CLO-2332) as done and unblock
[CLO-2331](/CLO/issues/CLO-2331). Do not create a new implementation child from
this checkpoint unless a future wake identifies a concrete failing verification
target or a non-duplicative product gap beyond the existing recipe authoring,
identity, and OAuth hardening lanes.
