# CLO-1649 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-19
Issue: CLO-1649
Parent driver: CLO-1648
Goal: Identity and reactive data workflows

## Conclusion

No new bounded implementation slice is warranted from CLO-1649.

I reconciled the current CloudTable repo and active issue state against the CLO-1647, CLO-1643, and CLO-1641 baseline lineage. I found no material repo or issue-tree change that weakens the identity/reactive baseline since CLO-1647.

CLO-1509 remains the canonical workflow-authoring/product-surface lane for configurable sync and rollup recipes. Its current `in_review` state is an explicit waiting path on a structured unblock interaction for a real implementation workspace, not evidence of a newly discovered runtime capability gap. Creating a second identity/reactive implementation issue here would duplicate that lane.

## Requirement Mapping

1. Google login remains covered by `src/runtime/worker.ts`, including Google login/callback ingress, external identity lookup, canonical user resolution, identity-link collision protection, and signed session creation.
2. Invited users entering different organizations and organization workspaces remain covered by invitation issuance/acceptance, session hydration, and session workspace selection paths in `src/runtime/worker.ts`, with regression coverage for invitation-backed sync and cross-organization workspace membership selection.
3. Declarative cross-table sync remains covered by the `sync_related_field` workflow operator and aggregate/sync maintenance runtime. Current tests cover single-relation and value-matched sync backfill/recompute through queue-consumer and regression paths.
4. Rolling grouped computed columns remain covered by aggregate maintenance for grouped targets, including single-relation grouped numeric rollups and value-matched grouped rollups.
5. Aggregate/rollup operations remain extensible through `src/core/aggregates/registry.ts`, which registers `count_records`, `sum_numbers`, `max_number`, and `average_numbers` as operation definitions rather than hard-coded branches in the workflow runtime.
6. Reactive computations still support batch initialize/backfill through workflow publish fanout, manual aggregate/sync maintenance ingress, and queue-consumer maintenance messages using `backfill` and `recompute` triggers.
7. Coordinator-owned reactive writes still require explicit workflow service identity metadata via `src/core/workflows/service-identity.ts`; missing or invalid metadata fails closed.

## Active Issue Reconciliation

- CLO-1649 is the active child blocker for CLO-1648.
- CLO-1647, CLO-1643, and CLO-1641 are done and closed with the same no-new-gap finding.
- CLO-1509 is still `in_review`; its thread records an `ask_user_questions` unblock path for attaching/provisioning the implementation workspace. It remains the non-duplicate continuation for author-facing workflow configuration once unblocked.
- Prior row-owner, extensible-condition, aggregate-registry, sync maintenance, aggregate maintenance, and workflow service-identity work remains present in the current tree.

## Verification

Commands run for this reconciliation:

- `npm run typecheck`
- `npm run test:smoke`

Both checks passed. Smoke covered 2 files and 19 tests.

## Disposition

Close CLO-1649 as done. Do not create another bounded identity/reactive implementation issue from CLO-1648. Let CLO-1648 unblock with the same disposition: the runtime capability baseline remains satisfied, and CLO-1509 is the only existing authoring/product-surface continuation if its workspace unblock path is answered.
