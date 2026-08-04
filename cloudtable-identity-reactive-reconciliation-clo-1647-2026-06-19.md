# CLO-1647 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-19
Issue: CLO-1647
Parent driver: CLO-1646
Goal: Identity and reactive data workflows

## Conclusion

No new bounded implementation slice is warranted from CLO-1647.

The current CloudTable repo and active issue tree still satisfy the identity/reactive capability baseline. The latest named lineage, CLO-1643, CLO-1641, and CLO-1639, already closed with the same finding after typecheck and smoke verification. I found no material repo or issue-tree change that creates a distinct backend/runtime gap.

CLO-1509 remains the canonical workflow-authoring/product-surface lane for configuring direct sync and grouped rollup recipes without raw JSON editing. It is still in review with a continuation path, so creating another identity/reactive implementation issue here would duplicate that lane.

## Requirement Mapping

1. Google login remains covered by the Google OAuth login/callback/session ingress in `src/runtime/worker.ts`, including external identity lookup, invitation-token handling, canonical user resolution, external identity linking, and session creation.
2. Invited users entering organizations and workspaces remain covered by invitation acceptance and workspace-session selection behavior, with regression coverage for invitation-backed reactive sync and cross-organization invited-member workspace selection.
3. Declarative cross-table sync remains covered by `sync_related_field` metadata and the sync-maintenance route in `src/runtime/aggregate-maintenance.ts`, including deterministic command identities for backfill and recompute writes.
4. Rolling grouped computed columns remain covered by aggregate maintenance for grouped targets, including single-relation grouped sums and value-match grouped rollups.
5. Aggregate and rollup operations remain extensible through `src/core/aggregates/registry.ts`, which registers `count_records`, `sum_numbers`, `max_number`, and `average_numbers` as operation definitions rather than one-off branches.
6. Reactive computations still support batch initialize/backfill through workflow publish fanout, manual aggregate/sync maintenance ingress, and queue-consumer maintenance paths using `backfill` and `recompute` triggers.
7. Workflow service identity remains fail-closed for coordinator-owned reactive maintenance. The maintenance runtime loads explicit workflow service identity metadata and applies it to coordinator-owned cell writes; missing metadata is covered by runtime and regression tests.

## Active Issue Reconciliation

- CLO-1647 blocks CLO-1646 and is the only current reconciliation child in this handoff.
- CLO-1643 is done. Its continuation summary records `npm run typecheck` and `npm run test:smoke` passing, with no new implementation issue warranted.
- CLO-1641 is done with the same no-new-gap disposition against CLO-1639.
- CLO-1639 is done with the same no-new-gap disposition against the earlier baseline.
- CLO-1509 is still `in_review` and remains the existing product-surface continuation. Its state is not evidence of a missing runtime identity/reactive capability.
- Prior row-owner, extensible-condition, aggregate-registry, and reactive maintenance work remains preserved in the current tree; I did not find a regression that would justify reopening those lanes.

## Verification

Commands run for this reconciliation:

- `npm run typecheck`
- `npm run test:smoke`

Both checks passed. Smoke covered 2 files and 19 tests.

## Disposition

Close CLO-1647 as done. Do not create a new bounded identity/reactive runtime implementation issue from CLO-1646. Let CLO-1646 unblock with the same disposition: the runtime capability goal remains satisfied, and CLO-1509 is the only existing authoring/product-surface continuation if that lane resumes.
