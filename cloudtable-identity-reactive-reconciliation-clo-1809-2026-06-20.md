# CloudTable Identity/Reactive Reconciliation - CLO-1809

Date: 2026-06-20
Goal: Identity and reactive data workflows
Issue: CLO-1809

## CTO Assessment

No new bounded implementation, QA, product, or design child is warranted from
this checkpoint.

CLO-1805 remains the current technical baseline. The tracked source delta is
still the same five-file workflow recipe authoring/runtime ingress slice, and
there are no new commits in this workspace since the CLO-1805 checkpoint window.

## Current Code State

Tracked diff remains limited to:

- `src/core/workflows/authoring.ts`
- `src/core/workflows/types.ts`
- `src/runtime/worker.ts`
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
- `testing/cloudtable/suites/workflows/authoring.spec.ts`

`git diff --stat` reports:

```text
5 files changed, 450 insertions(+), 26 deletions(-)
```

The diff continues to expose:

- workflow recipe authoring catalog metadata for `direct_sync` and
  `grouped_rollup`
- `field_changed` as the fixed trigger for both recipes
- `single_relation` and `value_match` matching strategies
- recipe preview ingress at `/v1/tables/{tableId}/workflow-recipes/preview`
- maintenance routes for sync and aggregate backfill/recompute
- aggregate operations `count_records`, `sum_numbers`, `max_number`, and
  `average_numbers`

## Capability Mapping

- Google login and canonical CloudTable user linking remain represented by the
  runtime auth callback/session ingress.
- Invited users across organizations and workspaces remain covered by existing
  membership/session selection and invited-member reactive readback tests.
- Declarative cross-table sync remains represented by the `direct_sync` recipe,
  the `sync_related_field` operator, and sync maintenance routing.
- Grouped rolling computed columns remain represented by the `grouped_rollup`
  recipe, `set_cell`, aggregate operation manifests, and aggregate maintenance
  routing.
- Extensible operations remain available through the aggregate operation
  registry.
- Batch initialize/backfill remains explicit in recipe metadata as `backfill`
  and `recompute` maintenance kinds.

## Active Goal Tree

The active goal query still includes historical blocked routine-driver noise.
The relevant live path is `CLO-1808` blocked by this reconciliation checkpoint,
`CLO-1809`. I found no new active implementation lane that changes the
identity/reactive capability picture.

## Verification

Passed:

```bash
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts -t "canonical .* recipe authoring contract"
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "workflow recipe authoring metadata|reactive rollup workflow proposals|direct sync workflow proposals"
```

Results:

- Workflow authoring: 2 passed, 18 skipped.
- Runtime ingress: 2 passed, 152 skipped.

## Route

Close `CLO-1809` as done and unblock `CLO-1808`. Do not create a duplicate
identity/reactive implementation child from this checkpoint. The next useful
work remains landing or reviewing the existing workflow recipe authoring diff,
or choosing a broader CloudTable product/platform priority outside this
reconciliation loop.
