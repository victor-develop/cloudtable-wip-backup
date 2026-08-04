# CLO-2193 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2193
Parent: CLO-2192 CloudTable 15-minute project driver
Prior checkpoint: CLO-2191

## Disposition

No fresh bounded implementation issue is warranted from `CLO-2193`.

The current repository state and active issue state still point at the same
source-of-truth lane identified by `CLO-2191`: workflow recipe
authoring/create/publish for `direct_sync` and `grouped_rollup`, including
aggregate operation metadata, publish-on-create, and backfill/recompute route
metadata.

Creating another identity/reactive implementation child now would duplicate the
active workflow recipe lane rather than close a distinct uncovered capability
gap.

## Delta Since CLO-2191

- Parent `CLO-2192` is blocked only by this reconciliation child, `CLO-2193`.
- Active goal state remains `Identity and reactive data workflows`.
- The tracked source/test delta remains limited to:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- That delta still represents:
  - canonical recipe catalog metadata for `direct_sync` and `grouped_rollup`
  - workflow recipe catalog read ingress
  - recipe preview/create ingress
  - publish-on-create support
  - aggregate operation registry exposure for grouped rollups
  - backfill/recompute maintenance route metadata

## Capability Mapping

- Google login, canonical identity/session behavior, invitation acceptance, and
  multi-workspace session switching remain covered by existing runtime ingress
  tests.
- Declarative cross-table sync remains covered by the `direct_sync` recipe and
  `sync_related_field` workflow operator path.
- Grouped rolling computed columns remain covered by the `grouped_rollup`
  recipe, aggregate operation registry metadata, reactive rollup proposal
  preview/create coverage, and aggregate maintenance route metadata.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  and existing sync/aggregate maintenance routes.
- Workflow service identity still fails closed when selected-record workflow
  previews omit explicit service identity metadata.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts testing/cloudtable/suites/runtime/ingress.spec.ts
```

Results:

- `git diff --check` passed.
- Focused Vitest passed: 2 files, 174 tests.

## Recommendation

Close `CLO-2193` as done and unblock parent `CLO-2192`. No duplicate
identity/reactive implementation child should be created unless a future wake
names a concrete failed verification target, product requirement, or
non-duplicative implementation gap outside the current workflow recipe
authoring/create/publish lane.
