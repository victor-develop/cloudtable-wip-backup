# CloudTable Next Bounded Slice After Registry-Backed Aggregate Expansion

Date: 2026-06-14
Issue: CLO-1447
Goal: Identity and reactive data workflows

## Recommendation

The next bounded slice should be:

**Land `max_number` parity for value-matched reactive rollups.**

This means extending the newly-expanded aggregate operation surface into the remaining grouping-strategy gap for `max_number`, not adding more aggregate IDs or reopening broader workflow/product work.

## Why This Slice

The current worktree already pushes aggregate expansion broadly:

- registry-backed aggregate operations now include `count_records`, `sum_numbers`, `max_number`, and `average_numbers`
- runtime, repository, worker/catalog, agent-tool, smoke, and regression surfaces all moved in the current diff
- end-to-end regression scenarios now exist for `max_number` and `average_numbers` in the single-relation path

The clearest remaining asymmetry is grouping-strategy parity:

- `sum_numbers` has value-matched aggregate coverage in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`
- `average_numbers` also has value-matched aggregate coverage in `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`
- `max_number` appears only in single-relation aggregate scenarios across the current runtime/regression expansion

That makes `max_number` the smallest high-signal follow-up. It stays on the same reactive rollup seam, exercises a different resolver path, and avoids broadening into new product areas.

## Evidence From The Current Workspace

- `testing/cloudtable/suites/runtime/queue-consumer.spec.ts`
  - has `executes numeric aggregate backfill and recompute for value-matched groups` using `sum_numbers`
  - has `executes average_numbers aggregate backfill and recompute for value-matched groups`
  - has `executes max_number aggregate backfill and recompute for single-relation groups`
- `testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts`
  - includes `reactive_max_rollup_publish_and_recompute`
  - includes `reactive_average_rollup_publish_and_recompute`
  - both are single-relation scenarios
- `testing/cloudtable/suites/runtime/ingress.spec.ts`
  - reactive rollup proposal/publish/readback ingress coverage is still centered on `sum_numbers`

## Proposed Acceptance Shape

Keep the follow-up narrow:

1. Add queue-consumer coverage for `max_number` with `value_match` grouping.
2. Add one deterministic regression scenario proving publish/backfill/recompute for the same seam.
3. Only add ingress coverage if the implementation needs a request-shape or authoring-path fix to support the scenario cleanly.

## Why Not A Broader Slice

Do not expand this next slice into:

- more aggregate operations such as `min`, `median`, or percentiles
- full authoring UX parity for every new numeric aggregate
- remote Cloudflare validation
- broader invited-member or identity work

Those are valid later follow-ups, but they are less bounded than closing the resolver-strategy gap for a newly-added aggregate operation.
