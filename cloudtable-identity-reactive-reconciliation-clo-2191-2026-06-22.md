# CLO-2191 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2191
Parent: CLO-2190 CloudTable 15-minute project driver
Prior checkpoint: CLO-2187

## Disposition

No new bounded implementation issue is warranted from `CLO-2191`.

This checkpoint reconciled the current CloudTable repository, focused tests,
and active goal-tree state after `CLO-2187`. The material state remains the same
workflow recipe authoring/create/publish lane for `direct_sync` and
`grouped_rollup`, plus existing identity/session/invitation ingress coverage.

Creating another implementation child now would duplicate the active recipe
authoring and runtime ingress work rather than close a new uncovered
identity/reactive capability gap.

## Delta Since CLO-2187

- Parent `CLO-2190` is blocked only by this reconciliation child, `CLO-2191`.
- `CLO-2187` already concluded no fresh non-duplicative implementation issue
  was warranted after `CLO-2183`.
- `CLO-2189` subsequently reached the same no-new-slice conclusion.
- The current tracked source delta is still limited to:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- The local worktree also contains prior untracked reconciliation markdown
  artifacts, plus this `CLO-2191` memo.

## Capability Mapping

- Google login/session and organization/workspace invitation behavior remain
  covered by existing runtime ingress tests for Google callback invitation
  acceptance, invited-workspace prioritization, and session switching.
- Declarative cross-table sync remains represented by the `direct_sync` recipe,
  fixed `field_changed` trigger, and `sync_related_field` action path.
- Grouped rolling computed columns remain represented by the `grouped_rollup`
  recipe, registry-backed aggregate operation metadata, computed rollup
  contracts, and aggregate maintenance route metadata.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  and existing sync/aggregate maintenance routes.
- Row-owner controls, extensible conditions, identity/session ingress, and
  workflow recipe authoring/create/publish remain completed groundwork. Field
  type proposal-hint parity does not directly block this identity/reactive goal.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts
```

Results:

- `git diff --check` passed.
- Direct Vitest passed: 2 files, 174 tests.
- An earlier aggregate `npm test -- --run ...` invocation also passed the
  project semantic suite, but it ran broader than intended because the npm
  scripts forward arguments through nested commands.

## Recommendation

Close `CLO-2191` as done and unblock parent `CLO-2190`. No duplicate
identity/reactive implementation child should be created unless a future wake
names a concrete failed verification target, product requirement, or
non-duplicative implementation gap.
