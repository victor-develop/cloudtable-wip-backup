# CLO-1653 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-19
Issue: CLO-1653
Parent driver: CLO-1652
Goal: Identity and reactive data workflows

## Conclusion

No new bounded implementation slice is warranted from CLO-1653.

I reconciled the current CloudTable repo and active issue tree against the latest evidence chain from CLO-1651, CLO-1649, and CLO-1647. I found no material tracked repo change since CLO-1651 and no material issue-tree change that creates a distinct identity/reactive backend or runtime gap.

CLO-1509 remains the live canonical workflow-authoring/product-surface lane for configurable cross-table sync and grouped rollup recipes if that work resumes. Creating another implementation issue from CLO-1652 would duplicate that lane rather than address a newly discovered capability gap.

## Requirement Mapping

1. Google login remains covered by `src/runtime/worker.ts`, including Google OAuth login/callback ingress, external identity lookup, canonical user resolution, identity-link collision protection, and signed auth session creation.
2. Invited users entering different organizations and organization workspaces remain covered by invitation issuance and acceptance, workspace membership resolution, session hydration, and active-workspace selection in `src/runtime/worker.ts`.
3. Declarative cross-table sync remains covered by the `sync_related_field` workflow operator in `src/core/workflows/operators.ts`, workflow metadata normalization, sync maintenance runtime, and manual sync backfill ingress.
4. Rolling grouped computed columns remain covered by computed rollup contracts, aggregate metadata normalization, aggregate maintenance routing, and grouped target recompute behavior for `single_relation` and `value_match` strategies.
5. Aggregate and rollup operations remain extensible through `src/core/aggregates/registry.ts`, which registers operations such as `count_records`, `sum_numbers`, `max_number`, and `average_numbers` as definitions rather than one-off runtime branches.
6. Reactive computations still support batch initialize/backfill through workflow publish fanout, manual aggregate/sync maintenance ingress, and queue-consumer maintenance messages using `backfill` and `recompute` triggers.
7. Coordinator-owned reactive writes remain guarded by explicit workflow service identity metadata in `src/core/workflows/service-identity.ts`; missing or invalid metadata fails closed.

## Active Issue Reconciliation

- CLO-1653 is the active child blocker for CLO-1652.
- CLO-1651 is done and recorded the same no-new-gap finding after typecheck and smoke verification.
- CLO-1649 and CLO-1647 are completed baseline memos with the same capability mapping and no-new-slice disposition.
- CLO-1509 is still `in_review` and remains the non-duplicate continuation lane for the author-facing workflow configuration/product surface.
- The broader identity/reactive goal tree still contains many blocked historical driver/review issues; I did not find a new active implementation issue or repository change that supersedes CLO-1651.
- The current worktree has no tracked diff in `src/`, `testing/`, or project configuration files; only reconciliation markdown artifacts are untracked.

## Verification

Commands run for this reconciliation:

- `npm run typecheck`
- `npm run test:smoke`

Both checks passed. Smoke covered 2 files and 19 tests.

## Disposition

Close CLO-1653 as done. Do not create another bounded identity/reactive implementation issue from CLO-1652. Let CLO-1652 unblock with the same disposition: the runtime capability baseline remains satisfied, and CLO-1509 is the existing product-surface continuation if that lane resumes.
