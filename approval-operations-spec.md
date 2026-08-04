# Approval Operations Golden Journey and Activation Metrics

Issue: [CLO-3209](/CLO/issues/CLO-3209)  
Child source: [CLO-3216](/CLO/issues/CLO-3216)  
Date: 2026-08-04

## Objective

Ship the first customer-validating CloudTable application: **Requests, Approvals, and Tasks**. The slice must let a pilot workspace invite Requesters, Approvers, and Ops users; submit and approve requests; automatically create execution tasks; complete work; and review a durable audit trail without custom engineering per pilot.

## Personas and Permissions

### Requester

Primary job: submit a request, respond to clarification, and track outcome.

- Can create and edit their own draft Requests.
- Can submit their own Requests.
- Can view their submitted Requests and related Approvals/Tasks only through read-only status summaries.
- Can comment on their own submitted Requests.
- Cannot directly create, edit, or delete Approvals or Tasks.
- Cannot view hidden operational fields, internal notes, approver assignment rules, retry metadata, or integration error payloads.

### Approver

Primary job: review assigned approvals and make auditable decisions.

- Can view Requests linked to Approvals assigned to them.
- Can approve, reject, or request changes on assigned Approvals.
- Can add decision comments and request clarifications.
- Can view Request context needed for decisioning, including requester-visible attachments and submitted fields.
- Cannot edit the Request after submission except through an explicit "request changes" workflow.
- Cannot edit Ops-only task fields, hidden workflow metadata, or another approver's decision.

### Ops

Primary job: fulfill approved work and manage operational execution.

- Can view approved Requests and their Tasks.
- Can edit Task assignee, due date, operational notes, status, priority, and completion evidence.
- Can close Tasks and trigger Request completion when all required Tasks are done.
- Can add internal notes visible only to Ops and admins.
- Cannot override Approval decisions except by reopening with an agent-assisted, confirmed amendment that records history.

### Workspace Admin

Primary job: configure members and inspect history for pilot operations.

- Can invite users and assign one or more roles.
- Can view all records and history.
- Can configure simple routing values used by this slice: default approver, default ops owner, and task template.
- Admin configuration is intentionally minimal for the pilot; no full builder is in scope.

## Golden Journey

1. **Invitation**

   An admin invites users by email and role. Invitees land in a role-specific first view after accepting.

   - Requester first view: "My requests".
   - Approver first view: "Approvals queue".
   - Ops first view: "Ops tasks".
   - Multi-role users can switch role views from the view selector.

2. **Requester Creates Draft**

   The Requester clicks "New request", fills request type, title, description, amount or impact, needed-by date, and attachments, then saves a draft or submits.

   Draft state:

   - Editable by requester.
   - Not visible to approver or ops.
   - Activity records draft creation and edits.

3. **Requester Submits**

   On submit, the Request status changes from `Draft` to `Submitted`. The system creates an Approval record assigned to the configured approver and notifies that approver.

   Submission state:

   - Request fields become read-only to the requester except comments/attachments if allowed by workspace setting.
   - Approval status is `Pending`.
   - Request status is `In review`.
   - Activity records submission and workflow-created Approval.

4. **Approver Decisioning**

   The Approver opens the Approval queue item, reviews the linked Request, and selects one decision:

   - `Approve`: Approval status becomes `Approved`; Request status becomes `Approved`; Ops Tasks are created from the task template.
   - `Reject`: Approval status becomes `Rejected`; Request status becomes `Rejected`; no Ops Tasks are created.
   - `Request changes`: Approval status becomes `Changes requested`; Request status becomes `Needs changes`; Requester is notified and may edit allowed fields.

5. **Requester Revises If Needed**

   For `Needs changes`, the Requester edits allowed request fields and resubmits. The existing Approval is reused and reset to `Pending` with an incremented review round, preserving prior decision history.

6. **Ops Executes**

   When Approval is approved, the system creates one or more Task records linked to the Request and Approval. Ops users work Tasks through `Not started`, `In progress`, `Blocked`, and `Done`.

   - First generated Task owner defaults to configured Ops owner.
   - Ops may reassign tasks and update due dates.
   - Task status changes are reflected on the Request rollup status.

7. **Request Completion**

   When all required Tasks are `Done`, the Request status becomes `Complete`, the Requester is notified, and the completion timestamp is written.

8. **Audit and History Review**

   Every role sees an activity history scoped to their visibility:

   - Requester sees submission, approval outcome, requester-visible comments, task summary status, and completion.
   - Approver sees request submission, decision history, changes requested, resubmissions, and decision comments.
   - Ops sees approval outcome, generated task creation, task updates, completion evidence, and internal ops notes.
   - Admin sees all activity, including hidden fields, workflow retries, agent suggestions, and failure details.

## Core Tables

### Requests Table

Purpose: canonical intake record.

Fields:

| Field | Type | Status | Requester | Approver | Ops | Admin | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Request ID | system id | read-only | visible | visible | visible | visible | Stable record id |
| Title | text | editable in Draft/Needs changes | edit own | read | read | edit | Required |
| Request type | single select | editable in Draft/Needs changes | edit own | read | read | edit | Pilot values: Software access, Purchase, Vendor, Other |
| Description | long text | editable in Draft/Needs changes | edit own | read | read | edit | Required |
| Business justification | long text | editable in Draft/Needs changes | edit own | read | read | edit | Required for Purchase/Vendor |
| Amount | currency | editable in Draft/Needs changes | edit own | read | read | edit | Optional for non-purchase |
| Needed by | date | editable in Draft/Needs changes | edit own | read | read | edit | Optional |
| Attachments | file list | editable in Draft/Needs changes | edit own | read | read | edit | Requester-visible |
| Status | single select | workflow-controlled | read | read | read | edit via admin override only | Values below |
| Requester | user | system | read | read | read | visible | Set on create |
| Current approver | user | workflow | hidden | read | read | edit | Used for routing |
| Approval round | number | workflow | hidden | read | read | visible | Starts at 1 |
| Approved at | datetime | workflow | read if set | read | read | visible | Null until approved |
| Completed at | datetime | workflow | read if set | read | read | visible | Null until complete |
| Internal routing key | text | hidden | hidden | hidden | read | edit | Ops/admin only |
| Workflow run id | text | hidden | hidden | hidden | hidden | visible | Idempotency/debug |
| Last workflow error | long text | hidden | hidden | hidden | hidden | visible | Admin-only troubleshooting |
| Activity history | system relation | read | scoped read | scoped read | scoped read | full read | Rendered timeline |

Status values:

- `Draft`
- `Submitted`
- `In review`
- `Needs changes`
- `Approved`
- `Rejected`
- `In fulfillment`
- `Blocked`
- `Complete`
- `Cancelled`

Sample Request:

| Field | Value |
| --- | --- |
| Request ID | REQ-1007 |
| Title | Figma Enterprise seats for Design Ops |
| Request type | Purchase |
| Description | Add 8 seats for contractors supporting launch work. |
| Business justification | Contractors need access to source files for pilot UX cleanup. |
| Amount | USD 1,920 |
| Needed by | 2026-08-12 |
| Status | In fulfillment |
| Requester | Maya Chen |
| Current approver | Jordan Lee |
| Approval round | 1 |

### Approvals Table

Purpose: auditable decision record for a submitted Request.

Fields:

| Field | Type | Status | Requester | Approver | Ops | Admin | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Approval ID | system id | read-only | visible as summary | visible | visible | visible | Stable record id |
| Request | relation | workflow | read linked summary | read | read | edit | Required |
| Assigned approver | user | workflow/admin | hidden | read | read | edit | Required |
| Status | single select | workflow/approver | read | edit decision action | read | edit override | Values below |
| Decision | single select | approver | read when final | edit once per round | read | edit override | Approved, Rejected, Changes requested |
| Decision comment | long text | approver | read if requester-visible | edit on decision | read | visible | Required for reject/changes |
| Decided at | datetime | workflow | read if set | read | read | visible | Set on decision |
| Review round | number | workflow | read | read | read | visible | Mirrors Request round |
| Prior decision summary | long text | workflow | read | read | read | visible | Preserves prior rounds |
| Agent recommendation | long text | agent | hidden by default | read | hidden | visible | Generated with confirmation boundary |
| Workflow run id | text | hidden | hidden | hidden | hidden | visible | Idempotency/debug |
| Last workflow error | long text | hidden | hidden | hidden | hidden | visible | Admin-only troubleshooting |

Status values:

- `Pending`
- `Approved`
- `Rejected`
- `Changes requested`
- `Superseded`
- `Cancelled`

Sample Approval:

| Field | Value |
| --- | --- |
| Approval ID | APR-2044 |
| Request | REQ-1007 |
| Assigned approver | Jordan Lee |
| Status | Approved |
| Decision | Approved |
| Decision comment | Approved for launch support. |
| Decided at | 2026-08-04 15:18 HKT |
| Review round | 1 |

### Tasks Table

Purpose: operational execution records created after approval.

Fields:

| Field | Type | Status | Requester | Approver | Ops | Admin | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Task ID | system id | read-only | visible as summary | visible as summary | visible | visible | Stable record id |
| Request | relation | workflow | read linked summary | read | read | edit | Required |
| Approval | relation | workflow | hidden | read | read | edit | Required for generated tasks |
| Title | text | workflow/ops | read | read | edit | edit | Generated from template; ops editable |
| Description | long text | workflow/ops | read | read | edit | edit | Operational details |
| Status | single select | ops | read summary | read | edit | edit | Values below |
| Assignee | user | workflow/ops | hidden | read | edit | edit | Default Ops owner |
| Priority | single select | workflow/ops | hidden | read | edit | edit | Low, Normal, High, Urgent |
| Due date | date | workflow/ops | read if requester-visible | read | edit | edit | Defaults from needed-by |
| Completion evidence | long text/file | ops | read when complete | read | edit | edit | Required before Done for configured templates |
| Internal ops notes | long text | ops | hidden | hidden | edit | visible | Ops/admin only |
| Blocker reason | long text | ops | read summary when blocked | read | edit | edit | Required when status Blocked |
| Completed at | datetime | workflow | read if set | read | read | visible | Set on Done |
| Workflow run id | text | hidden | hidden | hidden | hidden | visible | Idempotency/debug |
| Last workflow error | long text | hidden | hidden | hidden | hidden | visible | Admin-only troubleshooting |

Status values:

- `Not started`
- `In progress`
- `Blocked`
- `Done`
- `Cancelled`

Sample Task:

| Field | Value |
| --- | --- |
| Task ID | TASK-3091 |
| Request | REQ-1007 |
| Approval | APR-2044 |
| Title | Provision Figma Enterprise seats |
| Status | In progress |
| Assignee | Priya Shah |
| Priority | High |
| Due date | 2026-08-12 |

## Role-Specific Views and Screen States

### Shared Invitation Screens

- **Invite pending**: email invite link opens account setup with workspace name, invited role, inviter, and accept/decline actions.
- **Expired invite**: explains the invite expired and offers "Request a new invite"; logs `invite_expired_viewed`.
- **Already accepted**: routes to role landing view.
- **Permission denied**: shown when invite role was revoked before acceptance; offers contact-admin message without exposing workspace data.
- **Loading**: skeleton with workspace name if known; no table data flashes before auth resolves.
- **Error**: generic retry state; includes support-safe request id.

### Requester: My Requests

Default columns:

- Request ID
- Title
- Request type
- Status
- Current stage
- Submitted at
- Needed by
- Last updated

Primary actions:

- New request
- Open request
- Duplicate draft
- Add comment
- Resubmit changes when status is `Needs changes`

States:

- **Empty**: no requests; primary action "New request".
- **Draft list**: draft records show editable badge and are visible only to the owner.
- **Submitted/In review**: read-only detail with approver-visible request fields and timeline.
- **Needs changes**: requested changes banner with approver comment; allowed fields become editable; resubmit action visible.
- **Rejected**: final outcome with decision comment and create-new-from-request action.
- **In fulfillment**: task progress summary, not raw Ops-only fields.
- **Complete**: completion timestamp and completion evidence if requester-visible.
- **Loading**: table skeleton; detail pane skeleton preserves layout.
- **Error**: retry and support-safe request id.
- **Permission denied**: displayed if opening another user's Request by URL; no record fields are rendered.

### Approver: Approvals Queue

Default columns:

- Approval ID
- Request title
- Requester
- Amount
- Needed by
- Review round
- Status
- Submitted at

Primary actions:

- Approve
- Reject
- Request changes
- Ask agent to summarize request
- Ask agent to draft clarification

States:

- **Empty**: "No pending approvals"; secondary tab for completed decisions.
- **Pending detail**: linked Request context, requester attachments, prior rounds, and decision controls.
- **Decision validation**: reject and changes-requested require a decision comment.
- **Already decided**: decision controls disabled; decision summary shown.
- **Superseded**: shown if requester resubmitted and an older Approval view is stale.
- **Loading**: queue skeleton; decision controls disabled until record version loads.
- **Error**: retry; no partial decision submission after failed load.
- **Permission denied**: shown if the Approval is not assigned to the user and user is not admin.

### Ops: Ops Tasks

Default columns:

- Task ID
- Title
- Request
- Requester
- Status
- Priority
- Assignee
- Due date
- Last updated

Primary actions:

- Start task
- Mark blocked
- Reassign
- Change due date
- Mark done
- Add internal note
- Ask agent to split task

States:

- **Empty**: "No approved work ready"; no requester drafts or pending approvals are visible.
- **Not started**: start action visible.
- **In progress**: done/block actions visible.
- **Blocked**: blocker reason required and visible as requester-safe summary on Request.
- **Done**: completion evidence and timestamp shown; fields read-only except admin reopen.
- **Cancelled**: visible only to Ops/Admin by default.
- **Loading**: task table skeleton; bulk actions disabled.
- **Error**: retry and support-safe request id.
- **Permission denied**: shown when a Request exists but has not been approved or user lacks Ops role.

### Admin: Configuration and Audit

Pilot configuration:

- Invite member
- Assign roles
- Default approver
- Default ops owner
- Task template name and default task title
- View all activity
- Retry failed workflow

States:

- **No roles configured**: setup checklist blocks request submission until default approver and ops owner exist.
- **Partial configuration**: warning banner on admin view; requester form still visible but submit disabled with clear reason.
- **Workflow failures**: admin-only list of failed workflow runs with retry action.

## Relationships

- One Request has zero or one active Approval per review round.
- One Request may have multiple historical Approvals across rounds; only one Approval can be `Pending` for the current round.
- One approved Approval creates one or more Tasks.
- A Task always belongs to exactly one Request and, for generated tasks, exactly one Approval.
- Activity history events link to the table record that caused the event and may link to created/updated records.

## Status-Triggered Cross-Table Workflows

### Workflow 1: Submit Request

Trigger:

- Request status changes from `Draft` or `Needs changes` to `Submitted`.

Preconditions:

- Required visible fields are valid.
- Request has a requester.
- Default approver exists.

Actions:

- Set Request status to `In review`.
- Set/increment `Approval round`.
- Create Approval if no current-round Approval exists; otherwise reuse the current-round Approval and set it to `Pending`.
- Set Approval assigned approver from routing config.
- Notify assigned Approver.
- Add activity entries: `request.submitted`, `approval.created` or `approval.reset_pending`, `notification.sent`.

Idempotency:

- Workflow key: `request:{requestId}:submit:round:{approvalRound}`.
- Duplicate trigger must not create duplicate current-round Approvals.
- If notification send retries, record one logical notification event with retry attempts nested in admin-only metadata.

Failure handling:

- If approver missing, leave Request in `Submitted`, write `Last workflow error`, notify admin, and show requester "Submitted; routing pending".
- If Approval creation succeeds but notification fails, keep Request `In review`, expose admin retry, and avoid duplicate Approval creation.

### Workflow 2: Approver Requests Changes

Trigger:

- Approval decision action `Request changes`.

Preconditions:

- Approval status is `Pending`.
- Actor is assigned Approver or Admin override.
- Decision comment is present.

Actions:

- Set Approval status to `Changes requested`.
- Set Request status to `Needs changes`.
- Notify Requester.
- Add activity entries: `approval.changes_requested`, `request.needs_changes`, `notification.sent`.

Idempotency:

- Decision action uses record version compare-and-set.
- Retrying the same decision does not append duplicate activity.

Failure handling:

- If Request update fails, keep Approval `Pending` and surface retryable error to Approver.
- If notification fails after status updates, record admin-only failure and allow retry notification.

### Workflow 3: Approver Rejects

Trigger:

- Approval decision action `Reject`.

Preconditions:

- Approval status is `Pending`.
- Decision comment is present.

Actions:

- Set Approval status to `Rejected`.
- Set Request status to `Rejected`.
- Notify Requester.
- Add activity entries: `approval.rejected`, `request.rejected`, `notification.sent`.

Idempotency:

- Decision action uses Approval record version and unique key `approval:{approvalId}:decision:round:{round}`.
- No Tasks are created.

Failure handling:

- If Request update fails, decision remains uncommitted and Approver sees retry.
- If notification fails, statuses remain final and admin can retry notification.

### Workflow 4: Approver Approves

Trigger:

- Approval decision action `Approve`.

Preconditions:

- Approval status is `Pending`.
- Current Request status is `In review`.
- Default ops owner exists.

Actions:

- Set Approval status to `Approved`.
- Set Request status to `Approved`.
- Create Tasks from the pilot task template.
- Set Request status to `In fulfillment` after required Tasks are created.
- Notify Ops owner and Requester.
- Add activity entries: `approval.approved`, `task.created`, `request.in_fulfillment`, `notification.sent`.

Idempotency:

- Workflow key: `approval:{approvalId}:approved:create_tasks`.
- Generated Tasks carry `sourceApprovalId` and `workflowRunId`.
- Duplicate approval processing must not create duplicate Tasks.

Failure handling:

- If task creation fails after Approval is approved, leave Request `Approved`, record `Last workflow error`, notify admin, and show Ops/Admin retry.
- If some Tasks are created before failure, retry creates only missing template tasks by stable template task key.

### Workflow 5: Task Status Rollup

Trigger:

- Any linked Task status changes.

Actions:

- If any required Task is `Blocked`, set Request status to `Blocked`.
- If at least one required Task is `In progress` and none are blocked, set Request status to `In fulfillment`.
- If all required Tasks are `Done`, set Request status to `Complete` and set `Completed at`.
- Notify Requester on `Blocked` and `Complete`.
- Add activity entries: `task.status_changed`, `request.status_rollup`, `notification.sent` where applicable.

Idempotency:

- Rollup computes from current Task set; repeated runs converge to the same Request status.
- Completion notification sends once per transition to `Complete`.

Failure handling:

- If rollup fails, Task update still persists; Request shows last known rollup until retry.
- Admin sees failed workflow run and can retry rollup.

### Workflow 6: Admin Retry Workflow

Trigger:

- Admin clicks retry on a failed workflow run.

Actions:

- Re-execute failed workflow using original idempotency key.
- Append `workflow.retry_started` and either `workflow.retry_succeeded` or `workflow.retry_failed` activity entries.

Boundaries:

- Retry cannot change user-entered decision values.
- Retry cannot create duplicate current-round Approvals or template Tasks.

## Notifications and Invitations

Channels for pilot:

- In-app notification is required.
- Email notification is required for invites and approval assignment.
- Slack or external chat notifications are non-goals for the pilot.

Notification events:

- `invite.sent`
- `invite.accepted`
- `request.submitted`
- `approval.assigned`
- `approval.changes_requested`
- `approval.approved`
- `approval.rejected`
- `task.assigned`
- `task.blocked`
- `request.completed`
- `workflow.failed_admin`

Invitation behavior:

- Admin may invite by email and choose roles: Requester, Approver, Ops, Admin.
- Pending invite can be resent.
- Role changes after invite acceptance apply immediately to views and permissions.
- Invite acceptance creates user membership and logs `member.joined`.

## Agent-Assisted Modification Moments

Agents may assist, but they do not silently mutate business records beyond scoped draft text unless the user confirms.

### Requester Agent Moments

Allowed:

- Improve request title/description/business justification in Draft or Needs changes.
- Suggest missing fields based on request type.
- Summarize changes before resubmission.

Confirmation boundary:

- Agent may draft text into a preview.
- User must confirm "Apply to draft" before fields change.
- User must separately submit or resubmit; applying agent text does not submit.

Activity:

- `agent.suggestion.generated`
- `agent.draft_applied` with changed field names, not full hidden prompt payload.

### Approver Agent Moments

Allowed:

- Summarize request and prior history.
- Identify missing information.
- Draft decision comments for approve/reject/request-changes.

Confirmation boundary:

- Agent cannot click Approve/Reject/Request changes.
- Agent-drafted decision comment must be applied by Approver before decision.
- Decision action requires explicit Approver click and record-version confirmation.

Activity:

- `agent.summary.generated`
- `agent.decision_comment_drafted`
- `approval.decision_submitted`

### Ops Agent Moments

Allowed:

- Suggest task split from an approved Request.
- Draft internal checklist.
- Suggest blocker summary safe for requester.
- Draft completion evidence text.

Confirmation boundary:

- Creating additional Tasks, changing status to `Blocked`, or marking `Done` requires Ops confirmation.
- Agent may update internal draft checklist only after Ops clicks apply.

Activity:

- `agent.task_split_suggested`
- `agent.task_created_after_confirmation`
- `agent.status_change_drafted`
- `task.status_changed`

### Admin Agent Moments

Allowed:

- Explain workflow failure and recommend retry/manual fix.
- Suggest default routing configuration.

Confirmation boundary:

- Role changes, retries, and admin overrides require explicit admin action.

Activity:

- `agent.workflow_failure_summarized`
- `workflow.retry_started`
- `admin.override_applied`

## Activity History Requirements

Each activity entry includes:

- Activity ID
- Timestamp
- Actor type: user, agent, workflow, system
- Actor id
- Action key
- Primary record table and id
- Related record ids
- Before/after status when status changes
- Visibility scope: requester, approver, ops, admin
- Human-readable summary
- Admin-only metadata for workflow run id, retry count, and error id

History ordering:

- Strict timestamp order within a record detail.
- If two workflow events share a timestamp, display deterministic workflow order: trigger, writes, notifications.

History retention:

- No deletion in pilot.
- Hidden field values are not rendered to roles without permission, even inside history.

## Acceptance Scenarios

### Golden Path

1. Admin invites one Requester, one Approver, and one Ops user.
2. Requester accepts invite and lands on empty My Requests.
3. Requester creates and submits a Purchase Request with required fields.
4. System creates one Pending Approval assigned to Approver.
5. Approver approves with a comment.
6. System creates one Ops Task and moves Request to In fulfillment.
7. Ops marks Task In progress, then Done with completion evidence.
8. System moves Request to Complete and notifies Requester.
9. Admin can view complete history across Request, Approval, and Task.

Expected result:

- Exactly one Request, one Approval, and one Task exist for the flow.
- All role views show only permitted fields.
- Activity history contains every status transition and notification.

### Request Changes Round Trip

1. Requester submits a Request.
2. Approver requests changes with a required comment.
3. Requester sees Needs changes and can edit allowed fields.
4. Requester resubmits.
5. Existing current-round Approval is reset to Pending for round 2 or a new round-linked Approval is created according to implementation choice, but only one Pending Approval exists.

Expected result:

- Prior decision history remains visible.
- Duplicate Approvals are not created by resubmission retries.

### Rejection

1. Approver rejects a Pending Approval with a comment.
2. Request status becomes Rejected.
3. Requester is notified.

Expected result:

- No Tasks are created.
- Decision controls are disabled after final decision.

### Permission: Requester Cannot See Other Requests

1. Requester opens a direct URL to another Requester's submitted Request.

Expected result:

- Permission-denied state renders.
- No hidden or partial record data is exposed in HTML, network response, or activity timeline.

### Permission: Approver Cannot Decide Unassigned Approval

1. Approver opens an Approval assigned to another Approver.
2. Approver attempts decision action.

Expected result:

- Detail view is denied unless admin.
- Decision API returns permission error.
- No status or activity mutation occurs.

### Permission: Ops Cannot View Drafts

1. Requester saves a Draft Request.
2. Ops user searches or opens direct URL.

Expected result:

- Draft is not returned in Ops list/search.
- Direct URL shows permission denied.

### Workflow Idempotency: Approve Retry

1. Approver approves a Request.
2. Approval workflow is retried after notification failure.

Expected result:

- Only one set of template Tasks exists.
- Approval remains Approved.
- Request status converges to In fulfillment.
- Activity shows retry without duplicate logical task-created events.

### Workflow Failure: Missing Ops Owner

1. Admin removes default Ops owner.
2. Approver approves a Request.

Expected result:

- Approval does not create orphan Tasks.
- Request remains Approved with admin-only workflow error.
- Admin receives workflow failure notification and can retry after setting Ops owner.

### Agent Boundary: Draft Request Improvement

1. Requester asks agent to improve business justification.
2. Agent produces a preview.
3. Requester cancels.

Expected result:

- Request fields are unchanged.
- Activity records suggestion generated but not applied.

### Agent Boundary: Approver Decision

1. Approver asks agent to draft rejection comment.
2. Approver applies text but does not click Reject.

Expected result:

- Approval remains Pending.
- Activity records comment draft applied if field changes, but no decision event.

### Activity Visibility

1. Ops adds an internal note to a Task.
2. Requester opens Request history.
3. Admin opens Request history.

Expected result:

- Requester does not see internal note content or hidden metadata.
- Admin sees full event and metadata.

## Activation Metrics

### First-Value Event

`approval_ops_first_value` fires when a workspace completes this sequence:

1. At least one Requester, Approver, and Ops role are active members.
2. A Request is submitted.
3. An Approval decision is made.
4. At least one Task is created by workflow.

Rationale: the pilot has proven cross-role, cross-table workflow value before requiring full task completion.

### Activation Threshold

A pilot workspace is activated when, within 14 days of first invite acceptance:

- At least 3 distinct users accept invites across Requester, Approver, and Ops roles.
- At least 5 Requests are submitted.
- At least 3 Requests receive approval decisions.
- At least 2 approved Requests generate Tasks automatically.
- At least 1 Request reaches Complete.
- Median time from Request submit to Approval decision is under 2 business days for decided Requests.

### Funnel Steps

1. `workspace_created`
2. `approval_ops_template_enabled`
3. `role_invite_sent`
4. `role_invite_accepted`
5. `request_draft_created`
6. `request_submitted`
7. `approval_assigned`
8. `approval_opened`
9. `approval_decision_submitted`
10. `task_created_by_workflow`
11. `task_status_changed`
12. `request_completed`
13. `activity_history_opened`
14. `agent_assist_opened`
15. `agent_suggestion_applied`

### Instrumentation Events

Core properties for all events:

- `workspace_id`
- `user_id` when user-triggered
- `actor_type`
- `role_context`
- `record_table`
- `record_id`
- `request_id` when applicable
- `approval_id` when applicable
- `task_id` when applicable
- `workflow_run_id` when applicable
- `source_issue`: `CLO-3216`

Event-specific requirements:

- `role_invite_sent`: invited role list, inviter role, invite channel.
- `role_invite_accepted`: accepted role list, time from send to accept.
- `request_draft_created`: request type.
- `request_submitted`: request type, amount bucket, attachment count, required-field completion.
- `approval_assigned`: approver role, routing source.
- `approval_opened`: queue position, time since assignment.
- `approval_decision_submitted`: decision, review round, time since submission, comment present.
- `task_created_by_workflow`: template key, task count for request, idempotency replay flag.
- `task_status_changed`: from status, to status, role context, time since creation.
- `request_completed`: time from submit to complete, task count, blocked count.
- `activity_history_opened`: role context, source surface.
- `agent_assist_opened`: role context, assist type.
- `agent_suggestion_applied`: assist type, changed field count, confirmation method.
- `workflow_failed`: workflow key, failure stage, retryable flag.
- `workflow_retried`: workflow key, retry count, outcome.

### Pilot Health Dashboard

Required dashboard cards:

- Invite acceptance rate by role.
- Request submissions per workspace per week.
- Approval decision rate and median decision time.
- Workflow task creation success rate.
- Request completion rate.
- Workflow failure count by workflow key.
- Agent assist apply rate by role.
- Permission-denied events by role and surface.

## Non-Goals

- No arbitrary custom table builder changes beyond the three core tables.
- No multi-step approval chains or quorum approvals.
- No conditional branching beyond default approver/default ops owner and pilot task template.
- No external system integrations beyond email/in-app notifications.
- No Slack, Teams, procurement, ticketing, or identity-provider sync integration in this slice.
- No custom formula fields, advanced automations, or customer-authored workflow builder.
- No bulk import/export workflow.
- No mobile-native app; responsive web only.
- No deletion or hard purge of activity history.
- No silent agent execution of approval decisions, role changes, admin overrides, or task completion.
- No analytics warehouse implementation beyond emitting named instrumentation events.

## Engineering Notes

- Enforce permissions server-side; UI hiding is not sufficient.
- Workflow operations should be transactional where possible and idempotent where cross-system notification prevents a single transaction.
- Use record-version checks for decision actions and status transitions.
- Preserve hidden fields from unauthorized API responses, not just rendered views.
- Treat activity history as product surface and audit substrate, not debug logs.
- Prefer deterministic task template keys so approval retry can safely create missing tasks without duplicates.
