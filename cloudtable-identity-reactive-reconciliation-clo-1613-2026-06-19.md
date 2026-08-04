# CLO-1613 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-19
Issue: CLO-1613
Parent driver: CLO-1612
Goal: Identity and reactive data workflows

## Conclusion

No new bounded implementation slice is warranted.

The current CloudTable repo and active issue tree still support the CLO-1611 disposition: the identity/reactive runtime capability is covered, and CLO-1509 remains the canonical workflow-authoring product-surface continuation for non-JSON direct sync and grouped rollup recipe configuration.

## Requirement Mapping

1. Google login remains covered by runtime auth ingress in `src/runtime/worker.ts`, including `/v1/auth/google/login`, `/v1/auth/google/callback`, and `/v1/auth/session`, plus existing ingress coverage for linking a Google identity, establishing a session, and hydrating workspace ingress without a supplied `principalId`.
2. Invited users across organizations and workspaces remain covered by invitation and session-selection ingress, with tests for invited-workspace prioritization, session switching, and invited-member reactive saved-view/persona-preview parity.
3. Declarative cross-table sync on field change remains represented by `sync_related_field` workflow metadata, sync maintenance routing, queue-consumer backfill/recompute tests, and workflow proposal preview coverage.
4. Grouped rolling computed columns remain represented by aggregate maintenance and grouped aggregate backfill/recompute tests, including value-matched grouped targets.
5. Extensible rolling operations remain represented by the aggregate operation registry, including `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
6. Batch initialize/backfill remains represented by workflow publish maintenance fanout and explicit aggregate/sync backfill request paths.

## Active Issue Reconciliation

- CLO-1611 is done and already reconciled the latest runtime capability baseline against CLO-1509 as the authoring/product-surface continuation.
- CLO-1509 is still `in_review` and still directly covers the author-facing product surface for configuring and publishing the direct sync and grouped rollup recipes without raw JSON editing.
- CLO-1612 is blocked only by this reconciliation child, so closing CLO-1613 should unblock that driver with a no-duplicate-work disposition.
- The only untracked local files I found before this memo were prior reconciliation memos from other CLO issues; I left them untouched.
- The latest tracked commit after the earlier baseline is broad backup/archive churn plus already-covered runtime/test additions. I found no new repo or issue-tree signal that exposes a smaller missing backend/runtime identity-reactive slice.

## Verification

- Inspected Paperclip issue state for CLO-1611, CLO-1612, CLO-1613, and CLO-1509.
- Inspected current repo markers for auth/session ingress, invitation/session behavior, aggregate operation registry, aggregate/sync maintenance routing, and targeted runtime/queue-consumer test coverage.
- `npm run typecheck` passed.

## Disposition

Close CLO-1613 as done. Do not create another identity/reactive runtime implementation issue from CLO-1612. Keep CLO-1509 as the existing bounded authoring/product-surface lane if the board wants that product slice resumed.
