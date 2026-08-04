# CLO-1574 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-19
Issue: CLO-1574
Goal: Identity and reactive data workflows

## Conclusion

The current CloudTable code state continues to satisfy the identity/reactive runtime capability goal. I do not recommend creating another identity/reactive runtime implementation child issue from this driver.

The one bounded successor lane that remains relevant to "workflow authors can configure" is already represented by `CLO-1509`, the workflow-authoring product-surface slice for sync and rollup recipes. It should remain the canonical authoring/product-surface continuation rather than duplicating work under `CLO-1574`.

## Requirement Mapping

1. Google login and identity linking are covered by repository tests for idempotent Google identity linking, canonical lookup behavior, collision rejection, and invitation acceptance into memberships.
2. Invited users across organizations and workspaces are covered by runtime ingress tests for invited-workspace prioritization, session switching, and invited-member reactive read parity.
3. Cross-table sync is covered by queue-consumer tests for single-relation sync maintenance through the coordinator-owned cell writer, plus sync backfill routing on workflow publish.
4. Rolling computed columns are covered by grouped aggregate backfill and recompute tests, including value-matched grouped targets.
5. Rolling operations are extensible through the aggregate operation registry, currently including `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
6. Batch initialize/backfill is represented in workflow publish and aggregate/sync maintenance paths.
7. Workflow service identity remains fail-closed: runtime ingress rejects published workflows that omit explicit service identity metadata.

## Active Issue Reconciliation

- `CLO-1542` and `CLO-1558` are done, so the prior deployed validation and OAuth configuration path is no longer a live blocker.
- `CLO-1554` is an older duplicate reconciliation issue that was left blocked only because parent-driver write access failed; its own memo concluded the local goal was covered and named the then-live remote validation lane, which has since completed.
- Current driver `CLO-1573` is blocked only by `CLO-1574`; closing this reconciliation unblocks that driver.
- `CLO-1509` remains the existing workflow-authoring product-surface lane for non-JSON authoring of direct sync and grouped rollup recipes. It is in review with a pending interaction about repo/workspace targeting, so it is the live path if the board wants product-surface implementation rather than runtime capability validation.

## Verification Performed

Commands run on this workspace for this reconciliation:

- `npm run typecheck`
- `npm run test:smoke`
- `npx vitest run testing/cloudtable/suites/repository/d1-repository.spec.ts -t "(links Google identities idempotently, exposes canonical lookups, and detects collisions|creates invitations and accepts them into memberships for a Google-authenticated user)"`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "(prioritizes the invited workspace for cross-organization invitees and still allows session switching|rejects manual aggregate-maintenance ingress when the published workflow omits explicit service identity metadata|keeps invited-member reactive saved-view readback and persona-preview surfaces in parity)"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "(executes single-relation sync maintenance backfill and recompute through the coordinator-owned cell writer|executes value-matched aggregate backfill and rolling recompute for grouped targets|executes average_numbers aggregate backfill and recompute for value-matched groups)"`

All checks passed.

## Disposition

Close `CLO-1574` as done. Do not create a new runtime identity/reactive child issue. Keep `CLO-1509` as the existing bounded product-surface continuation for author-facing sync and rollup recipe configuration if that lane is resumed.
