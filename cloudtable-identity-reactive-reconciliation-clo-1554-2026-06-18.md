# CLO-1554 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-18
Issue: CLO-1554
Goal: Identity and reactive data workflows

## Conclusion

The current CloudTable workspace already covers the refreshed identity/reactive capability goal locally. I did not find a new local implementation gap that justifies another identity/reactive-only child issue.

The single canonical next owner path remains deployed-environment validation, which is already owned by `CLO-1542` and currently blocked by `CLO-1543` and `CLO-1544`.

## Requirement Mapping

1. Google login is implemented and still verified on the live tree.
   - Repository coverage still proves idempotent Google identity linking, canonical lookup behavior, and collision rejection in `testing/cloudtable/suites/repository/d1-repository.spec.ts:6895`.
   - Invitation acceptance into a Google-authenticated membership remains covered in `testing/cloudtable/suites/repository/d1-repository.spec.ts:6992`.

2. Invited users across multiple organizations and workspaces are implemented locally.
   - Runtime ingress still proves an invitee lands in the invited workspace first and can switch back to another organization workspace in `testing/cloudtable/suites/runtime/ingress.spec.ts:9975`.
   - Membership provisioning remains fail-closed on required workspace, organization, user, and membership identity metadata in `src/durable-objects/workspace-control.ts:115`.

3. Declarative cross-table sync on field change already exists as executable runtime behavior.
   - Coordinator-owned sync backfill and recompute still run through the queue consumer in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts:1931`.
   - Manual aggregate-maintenance ingress still rejects workflows that omit explicit service identity metadata in `testing/cloudtable/suites/runtime/ingress.spec.ts:3055`.

4. Grouped rolling computed columns are implemented with batch initialize/backfill and recompute support.
   - Grouped aggregate backfill and rolling recompute remain covered in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts:4854`.
   - End-to-end regression coverage exists for value-matched grouped rollups, including `max_number`, in `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts:8810`.

5. Aggregate operations are extensible rather than hard-coded to one reactive rollup.
   - The aggregate registry currently exposes `count_records`, `sum_numbers`, `max_number`, and `average_numbers` in `src/core/aggregates/registry.ts:22`.
   - Queue-consumer coverage now includes `max_number` and `average_numbers` recompute paths for value-matched groups in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts:6934` and `testing/cloudtable/suites/runtime/queue-consumer.spec.ts:7163`.

## Live Issue Reconciliation

- I did not find an open local implementation issue that needs to be superseded or duplicated from this checkpoint.
- The highest-value remaining risk is still remote environment trust, not missing local runtime capability.
- That risk already has a live owner path:
  - `CLO-1542` owns the deployed Cloudflare validation slice.
  - `CLO-1543` owns the remote-access and D1 provisioning unblock.
  - `CLO-1544` is the current board-facing access package dependency keeping that path blocked.

## Recommendation

1. Mark `CLO-1554` done.
2. Do not create a new local implementation issue from this checkpoint.
3. Keep `CLO-1542` as the canonical next technical slice once `CLO-1543` and `CLO-1544` clear the remote-validation blocker.

## Verification Performed

Executed on the current workspace state on 2026-06-18:

- `npx vitest run testing/cloudtable/suites/repository/d1-repository.spec.ts -t "(links Google identities idempotently, exposes canonical lookups, and detects collisions|creates invitations and accepts them into memberships for a Google-authenticated user)"`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "(prioritizes the invited workspace for cross-organization invitees and still allows session switching|rejects manual aggregate-maintenance ingress when the published workflow omits explicit service identity metadata)"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "(executes single-relation sync maintenance backfill and recompute through the coordinator-owned cell writer|executes value-matched aggregate backfill and rolling recompute for grouped targets|executes max_number aggregate backfill and recompute for value-matched groups|executes average_numbers aggregate backfill and recompute for value-matched groups)"`

All targeted checks passed.

## Final Disposition

Close `CLO-1554` as done and route the next move through the existing remote-validation blocker chain instead of creating another local identity/reactive slice.
