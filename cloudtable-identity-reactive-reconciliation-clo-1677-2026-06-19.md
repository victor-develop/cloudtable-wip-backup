# CLO-1677 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-19
Issue: CLO-1677
Parent driver: CLO-1676
Goal: Identity and reactive data workflows

## Conclusion

No new bounded implementation slice is warranted from CLO-1677.

Unlike CLO-1675, the current tracked tree does contain a material delta after
the prior baseline: commit `c6b1082 chore: backup cloudtable wip` adds source,
test, regression-doc, and Cloudflare config changes in the CloudTable
identity/reactive area. I reconciled those changes against the required
capability goal and found that they strengthen already-planned/reactive
workflow surfaces rather than exposing a new gap.

The post-CLO-1675 delta adds registry-backed aggregate operation metadata,
new `max_number` and `average_numbers` aggregate operations, catalog exposure
for aggregate operation manifests, workflow proposal support for computed
lookup maintenance, and additional queue/ingress/regression/smoke coverage for
lookup and rollup authoring. That is aligned with, and partly advances, the
canonical workflow-authoring/product-surface lane tracked by CLO-1509. Creating
another implementation child from CLO-1677 would duplicate that lane rather
than address a distinct backend/runtime hole.

## Requirement Mapping

1. Google login remains covered by the existing Google OAuth login/callback
   ingress, signed callback state, external identity linking, session
   establishment, and workspace hydration paths. The post-CLO-1675 delta does
   not weaken or replace that path.
2. Invited users across multiple organizations and organization workspaces
   remain covered by invitation acceptance, canonical user binding, membership
   identity provisioning, session workspace selection, saved-view parity, and
   persona-preview parity tests.
3. Declarative cross-table sync on field change remains covered by the
   `field_changed` trigger, `sync_related_field` authoring/operator path,
   publish-time sync backfill routing, and queue recompute coverage. The new
   computed lookup proposal path adds another declarative maintenance surface
   for single-relation lookup fields.
4. Grouped rolling computed columns remain covered by computed rollup config,
   `single_relation` and `value_match` grouping strategies, aggregate
   maintenance routing, and coordinator-owned computed writes.
5. Extensible rolling operations are stronger than the CLO-1675 baseline:
   aggregate operation definitions now include manifests, operand metadata,
   config schemas, `get`/`has` registry access, and registered
   `count_records`, `sum_numbers`, `max_number`, and `average_numbers`
   operations.
6. Batch initialize/backfill remains covered by workflow publish fanout,
   manual aggregate/sync maintenance ingress using `backfill`, and event-driven
   `recompute`. The new tests specifically cover backfill and recompute for
   max/average rollups across single-relation and value-match groups.

## Evidence Checked

- Baseline: CLO-1675 concluded no new implementation slice was warranted from
  the previous tree and named CLO-1509 as the canonical product-surface lane.
- Tracked delta after the baseline: `git diff --name-only f1574ed..HEAD -- src
  testing migrations package.json package-lock.json tsconfig.json
  vitest.config.ts wrangler.jsonc README.md` shows CloudTable source/test/docs
  changes, not just reconciliation artifacts.
- Source delta:
  - `src/core/aggregates/registry.ts` adds `max_number`,
    `average_numbers`, operation manifests, and registry lookup helpers.
  - `src/core/field-types/modules.ts` validates rollup operations through the
    aggregate operation registry instead of a hard-coded count/sum pair.
  - `src/core/persistence/cloudtable-d1-repository.ts` validates workflow
    aggregate definitions against the same registry and operation config rules.
  - `src/runtime/bootstrap.ts`, `src/runtime/worker.ts`, and
    `src/runtime/workspace-inspector.ts` expose aggregate operation manifests
    through runtime catalog surfaces.
  - `src/core/agent-tools/registry.ts` adds `lookupFieldIds` proposal support
    for computed lookup maintenance using `set_cell` workflow actions and
    related-table resolver metadata.
- Test/doc delta:
  - Field validation covers registry-backed computed rollup operation ids.
  - Agent-tool tests cover aggregate catalog exposure and lookup workflow
    proposal generation.
  - Runtime ingress tests cover aggregate operation catalog readback and lookup
    field contracts.
  - Queue-consumer and regression tests cover max/average aggregate backfill and
    recompute for single-relation and value-match groups.
  - Smoke tests cover lookup, rollup, and cross-table sync workflow proposal
    preview through runtime ingress.
- Active issue state still shows CLO-1509 `in_review` as the existing
  workflow-authoring slice. CLO-1676 is blocked by this reconciliation, and no
  separate active CloudTable issue introduces a distinct identity/reactive gap
  that CLO-1677 should split off.

## Verification

Commands run for this reconciliation:

- `git status --short`
- `git log --oneline -12`
- `git show --stat --oneline --name-status f1574ed..HEAD`
- `git diff --name-only f1574ed..HEAD -- src testing migrations package.json package-lock.json tsconfig.json vitest.config.ts wrangler.jsonc README.md`
- Paperclip active issue query for statuses `todo,in_progress,in_review,blocked`
  filtered for CloudTable/identity/reactive/workflow terms
- `rg` searches over `src`, `testing/cloudtable/suites`, and
  `testing/cloudtable/docs` for aggregate catalog, `max_number`,
  `average_numbers`, lookup proposals, reactive rollups, invited-member parity,
  and workflow service identity evidence
- `npx vitest run testing/cloudtable/suites/field-types/validation.spec.ts`
- `npx vitest run testing/cloudtable/suites/agent-tools/registry.spec.ts -t "(inspectWorkspace|lookup maintenance actions|reactive rollup workflow proposal)"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "(max_number aggregate|average_numbers aggregate)"`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "(aggregateOperations|computed lookup field contracts|lookup workflow proposal|reactive saved-view readback|reactive rollup workflow proposals)"`
- `npx vitest run testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts -t "(reactive_max_rollup_publish_and_recompute|reactive_average_rollup_publish_and_recompute|reactive_value_match_max_rollup_publish_and_recompute|invited_member_reactive_read_parity_contract|workflow_service_identity_reactive_maintenance_writes)"`
- `npx vitest run testing/cloudtable/suites/smoke/runtime.spec.ts -t "(lookup workflow proposal preview|reactive rollup workflow proposal preview|cross-table sync workflow proposal preview)"`

One initial validation command used an over-narrow `-t "computed rollup"`
filter and skipped all tests; I reran the full validation spec successfully.

## Disposition

Close CLO-1677 as done. No child implementation issue should be created from
CLO-1677 on this evidence. CLO-1676 can unblock/close using this reconciliation,
and CLO-1509 remains the canonical workflow-authoring/product-surface
continuation if that review lane resumes.
