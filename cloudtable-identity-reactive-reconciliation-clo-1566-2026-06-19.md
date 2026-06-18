# CLO-1566 CloudTable Identity And Reactive-Workflow Reconciliation

Date: 2026-06-19
Issue: CLO-1566
Goal: Identity and reactive data workflows

## Conclusion

The current CloudTable codebase still satisfies the local implementation surface for the active identity/reactive-workflow goal. I did not find a new smallest local implementation slice to create from this checkpoint.

The canonical next slice is deployed-stack validation, already tracked by `CLO-1542`. That issue is currently blocked by `CLO-1558`, which owns deployed Cloudflare auth/OAuth secret configuration for invitation callback validation. Prior access/provisioning blockers `CLO-1543` and `CLO-1544` are done.

## Requirement Mapping

1. Google login and identity linking are covered by repository tests for idempotent Google identity linking, canonical lookup behavior, collision rejection, and invitation acceptance into memberships.
2. Cross-organization invite behavior is covered by runtime ingress and regression scenarios that prioritize the invited workspace while preserving session switching.
3. Declarative cross-table sync is covered by queue-consumer tests for single-relation sync maintenance through the coordinator-owned cell writer and by the invitation-backed reactive sync regression scenario.
4. Rolling computed columns are covered by grouped aggregate backfill and recompute tests, including invited-member grouped-sum read parity and registry-backed aggregate operations.
5. Extensible operations are present through the aggregate operation registry with `count_records`, `sum_numbers`, `max_number`, and `average_numbers`.
6. Batch initialize/backfill remains represented in workflow publish and aggregate maintenance paths.
7. Workflow service identity remains fail-closed: manual aggregate-maintenance ingress rejects published workflows that omit explicit service identity metadata.

## Active Issue Reconciliation

- `CLO-1542` remains the right next technical slice: validate the invitation-backed reactive identity contract on the deployed Cloudflare stack.
- `CLO-1542` is blocked by `CLO-1558`, not by missing local implementation.
- `CLO-1543` and `CLO-1544` are done, so the remaining blocker chain is narrower than the previous reconciliation memo.
- Creating another local identity/reactive implementation issue would duplicate shipped and verified behavior.

## Verification Performed

- `npm run typecheck`
- `npm run test:smoke`
- `npx vitest run testing/cloudtable/suites/repository/d1-repository.spec.ts -t "(links Google identities idempotently, exposes canonical lookups, and detects collisions|creates invitations and accepts them into memberships for a Google-authenticated user)"`
- `npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "(prioritizes the invited workspace for cross-organization invitees and still allows session switching|rejects manual aggregate-maintenance ingress when the published workflow omits explicit service identity metadata)"`
- `npx vitest run testing/cloudtable/suites/runtime/queue-consumer.spec.ts -t "(executes single-relation sync maintenance backfill and recompute through the coordinator-owned cell writer|executes value-matched aggregate backfill and rolling recompute for grouped targets|executes average_numbers aggregate backfill and recompute for value-matched groups)"`

All checks passed.

## Disposition

Close `CLO-1566` as done. Do not create another local implementation child issue from this checkpoint. Continue through `CLO-1542` after `CLO-1558` resolves the deployed auth/OAuth secret blocker.
