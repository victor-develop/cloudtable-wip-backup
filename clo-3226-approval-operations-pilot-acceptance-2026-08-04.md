# CLO-3226 Approval Operations Pilot Acceptance Evidence

Date: 2026-08-04
Issue: [CLO-3226](/CLO/issues/CLO-3226)
Parent: [CLO-3215](/CLO/issues/CLO-3215)

## Recommendation

No-go for unconstrained pilot launch.

The local CloudTable runtime starts and the scoped acceptance matrix passes most required capability areas, but one invited-user end-to-end workflow authoring regression fails. The failing path is material to the Approval Operations golden journey because invited/multi-persona users must be able to author or execute cross-table approval workflows through the required preview/execute safety boundary.

## Runtime Start Evidence

- Started the Cloudflare Worker locally with `npm run dev -- --port 8788 --local --persist-to "$PAPERCLIP_SCRATCH_DIR/wrangler-state"` after sandboxed Wrangler failed to bind loopback and write its log file.
- Wrangler reported `Ready on http://localhost:8788`.
- `GET http://127.0.0.1:8788/studio` returned `200 OK` with the CloudTable Studio shell.
- `GET http://127.0.0.1:8788/v1/auth/session` returned expected unauthenticated `401 Unauthorized` JSON.
- Captured Chromium desktop screenshot at run scratch path `cloudtable-studio-desktop-clo-3226.png`.

## Acceptance Matrix

Command:

```bash
npm exec vitest -- run testing/cloudtable/suites/runtime/ingress.spec.ts testing/cloudtable/suites/permissions/engine.spec.ts testing/cloudtable/suites/replay/idempotency-replay.spec.ts testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts testing/cloudtable/suites/agent-tools/registry.spec.ts testing/cloudtable/suites/smoke/runtime.spec.ts -t "serves the Studio shell|responsive desktop and mobile Studio layout|issues invitations|prioritizes the invited workspace|persists active workspace selection|keeps invited-member reactive saved-view readback|routes permission-scoped app activity|routes permission-scoped record activity|previews saved-view persona access|direct permission ingress in parity|permission-sanitized agent tool previews|requires explicit approval and matching preview hash|returns idempotent replay details|executes reviewed agent commands|executes a named workflow manual wrapper|drafts, executes, publishes, and reads back reactive rollup|drafts, executes, publishes, and reads back direct cross-table sync|moves a grouped-view record|creates a grouped-view record|surfaces hidden and read-only|enforces permissioned view reads across two tables|projects hidden, read-only, and redacted fields|hides workflow-blocked fields|filters agent tools against visible writable fields|sanitizes hidden field references|strips non-writable record mutation fields|invitation_backed_reactive_sync_contract|cross_org_invited_member_workspace_selection_reactive_contract|invited_member_reactive_read_parity_contract|invited_session_recipe_authoring_reactive_journey|workflow_service_identity_reactive_maintenance_writes|workflow_webhook_retry_backoff_recovery|workflow_dead_letter_replay_eligibility|proves direct cross-table sync workflow proposal preview|proves reactive rollup workflow proposal preview"
```

Result:

- 36 passed
- 1 failed
- 222 skipped by targeted filter
- Duration: 16.72s

Covered acceptance areas:

- Two-plus personas: requester/member-style invited user, owner/admin, ops/agent-like principals through runtime ingress and permissioned view tests.
- Invitation and workspace switching: invitation acceptance, invited workspace prioritization, multi-membership session switching.
- Field-level non-disclosure: hidden, redacted, read-only, workflow-hidden, agent-hidden, and payload sanitization tests.
- Inline operations: grouped-view move/create, record/cell mutation drafts, reviewed command execution.
- Cross-table workflow behavior: direct sync and reactive/grouped rollup proposal, publish, queue, and readback paths.
- Activity audit: permission-scoped app and record activity history ingress.
- Agent preview/execute safety: permission-sanitized previews, explicit approval and matching preview hash requirement, reviewed agent command execution.
- Workflow replay/idempotency: command preview replay details plus webhook retry and dead-letter replay scenarios.
- Browser E2E coverage: Studio shell responsive layout tests plus live local `/studio` Chromium screenshot capture.

## Blocking Finding

Failing test:

`testing/cloudtable/suites/regression/mvp-regression-matrix.spec.ts` scenario `invited_session_recipe_authoring_reactive_journey covers direct sync and grouped rollup through readback`

Failure:

```text
expected 400 to be 200
message: previewHash from a successful workflow recipe preview is required for workflow recipe create.
```

Interpretation:

The runtime now correctly enforces preview/execute safety for workflow recipe creation, but the invited-session end-to-end regression still attempts direct create/publish without a `previewHash`. Acceptance cannot prove the invited-user cross-table workflow journey until this regression is updated to perform preview first and then create with the returned hash, or until a product bug in that preview path is fixed.

## Bounded Backlog

1. High severity: Update/fix the invited-session recipe-authoring reactive regression so it exercises preview-before-create for direct sync and grouped rollup, then verify the full readback journey passes for invited users.
2. Medium severity: Add a named Approval Operations golden scenario wrapper that maps Requests, Approvals, Tasks, and role-scoped activity directly to the generic CloudTable workflow primitives already covered by the runtime tests.
3. Medium severity: Promote the desktop/mobile Studio screenshot path from handoff evidence into a repeatable browser E2E command that saves artifacts under issue-specific output.

## Final Disposition

No-go until item 1 is resolved. With item 1 resolved and rerun clean, the remaining evidence supports a constrained pilot that uses the current local CloudTable Studio/runtime path and treats remote latency/production deployment as separate launch-readiness checks.
