# CLO-2189 CloudTable Identity/Reactive Reconciliation

Date: 2026-06-22
Goal: Identity and reactive data workflows
Issue: CLO-2189
Parent: CLO-2188 CloudTable 15-minute project driver
Prior checkpoint: CLO-2183

## Disposition

No new bounded implementation issue is warranted from `CLO-2189`.

This checkpoint reconciled the active CloudTable identity/reactive workflow
goal, open issue state, and repository state after `CLO-2183`. I found no
material state change that opens a fresh non-duplicative implementation slice.
The current source/test delta is still the workflow recipe authoring, read,
preview, create, and optional publish lane for `direct_sync` and
`grouped_rollup`, with existing Google identity, invitation, and session
coverage.

Creating another implementation child now would duplicate the existing workflow
recipe lane rather than close a new uncovered capability gap.

## Evidence Checked

- Active goal remains `Identity and reactive data workflows`.
- Parent `CLO-2188` is blocked only by this reconciliation child, `CLO-2189`.
- Prior checkpoint `CLO-2183` closed with the same no-new-slice conclusion.
- Open goal issue search showed the current driver/reconciliation path plus
  older stranded driver artifacts, not a newer implementation gap requiring a
  fresh child issue.
- Relevant current source delta remains limited to:
  - `src/core/workflows/authoring.ts`
  - `src/core/workflows/types.ts`
  - `src/runtime/worker.ts`
  - `testing/cloudtable/suites/workflows/authoring.spec.ts`
  - `testing/cloudtable/suites/runtime/ingress.spec.ts`
- The workflow recipe catalog exposes `direct_sync` and `grouped_rollup`, fixed
  `field_changed` triggers, `single_relation` and `value_match` match
  strategies, draft/published/paused statuses, maintenance metadata, and
  registry-backed aggregate operation metadata.
- Runtime ingress covers workspace recipe catalog read, table-scoped recipe
  preview, recipe create, and optional publish-on-create.
- Cross-table sync remains represented by the `direct_sync` recipe and
  `sync_related_field` action path.
- Grouped rolling computed columns remain represented by the `grouped_rollup`
  recipe, aggregate operation catalog exposure, computed rollup contracts, and
  aggregate maintenance route metadata.
- Batch initialize/backfill remains represented by recipe maintenance metadata
  and existing sync/aggregate maintenance routes.
- Google login/session, organization/workspace invitation acceptance,
  invite-prioritized workspace selection, and multi-membership session switching
  remain covered by focused runtime ingress tests.
- Row-owner and extensible-condition progress remain completed groundwork and
  do not need reopening for this checkpoint.

## Verification

Run on 2026-06-22 against the current workspace:

```bash
git diff --check
npx vitest run testing/cloudtable/suites/workflows/authoring.spec.ts
npx vitest run testing/cloudtable/suites/runtime/ingress.spec.ts -t "returns workflow recipe authoring metadata|drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress|previews selected-record reactive rollup workflows through direct and agent-tool ingress|fails closed for selected-record workflow previews when service identity metadata is missing|drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress|issues invitations for an authenticated member and accepts them through Google callback|prioritizes the invited workspace for cross-organization invitees and still allows session switching|persists active workspace selection for multi-membership users through session switching"
```

Results:

- `git diff --check` passed.
- `testing/cloudtable/suites/workflows/authoring.spec.ts` passed: 20 tests.
- Focused runtime ingress identity/reactive filter passed: 8 tests, 146 skipped.

## Recommendation

Close `CLO-2189` as done and unblock parent `CLO-2188`. No duplicate
identity/reactive implementation child should be created unless a future wake
names a concrete failed verification target, product requirement, or
non-duplicative implementation gap.
