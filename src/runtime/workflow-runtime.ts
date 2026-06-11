import type { EventLedgerRecord } from "../core/events/types";
import { cloneCommandResult } from "../core/commands/transcript";
import type { JsonValue } from "../core/field-types/types";
import { createCloudTableD1Repository } from "../core/persistence/cloudtable-d1-repository";
import { findRowOwnerField } from "../core/ownership/row-owner";
import {
  executeWorkflowDefinition,
  matchWorkflowTrigger,
  resolveWorkflowInput
} from "../core/workflows/execution";
import type {
  WorkflowActionBinding,
  WorkflowActionDefinition,
  WorkflowActionExecution,
  WorkflowDefinition,
  WorkflowExecutionResult,
  WorkflowExecutionScope,
  WorkflowFieldValue
} from "../core/workflows/types";
import { createRuntime, createRuntimeWithSnapshot } from "./bootstrap";
import type { CloudTableRuntime } from "./bootstrap";
import type {
  CloudTableEnv,
  CloudTableQueueMessage,
  WorkflowStepRetryClass,
  WorkflowStepRetryMetadata
} from "./env";
import {
  readLatestPermissionSnapshotForScope,
  readPermissionSnapshot
} from "./permission-snapshot";
import { shouldEnqueueProjectionMaintenance } from "./projection-maintenance";
import { publishOutboxEntries } from "./queue-publisher";
import { workflowStatus } from "./workflow-definition";

type WorkflowVersionRow = {
  definition_json: string;
  workflow_id: string;
  workflow_version_id: string;
  workspace_id: string;
};

type WorkflowRunRow = {
  id: string;
  manual_invocation_id: string | null;
  principal_id: string;
  state_json: string;
  status: string;
  trigger_event_id: string;
  workflow_id: string;
  workflow_version_id: string;
};

type WorkflowStepRow = {
  attempt_count: number;
  audit_json: string;
  id: string;
  input_json: string;
  operator_id: string;
  status: string;
  step_key: string;
  workflow_run_id: string;
};

type WorkflowRetryPolicy = {
  baseDelaySeconds: number;
  maxAttempts: number;
  retryClass: WorkflowStepRetryClass;
};

type WorkflowDeadLetterRow = {
  attempt_count: number;
  created_at: string;
  failure_code: string;
  failure_message: string;
  id: string;
  payload_json: string;
  queue_name: string;
  workflow_run_id: string;
  workspace_id: string;
};

type EventRow = {
  aggregate_id: string | null;
  command_id: string;
  created_at: string;
  event_id: string;
  event_type: string;
  metadata_json: string;
  payload_json: string;
  table_id: string | null;
  workspace_id: string;
};

type FieldCellRow = {
  config_json: string;
  field_id: string;
  field_key: string;
  field_type: string;
  value_json: string;
};

type RecordRow = {
  record_id: string;
};

type PersistedWorkflowDefinition = WorkflowDefinition & {
  metadata?: {
    status?: "draft" | "published" | "paused";
  };
  principal?: {
    policyRevision?: number;
    principalId: string;
    schemaEpoch?: number;
    scopeHash?: string;
  };
};

function parseWorkflowDefinition(input: string): PersistedWorkflowDefinition {
  return JSON.parse(input) as PersistedWorkflowDefinition;
}

function parseJsonRecord(input: string | null): Record<string, unknown> {
  if (!input) {
    return {};
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }

  return {};
}

type ScheduledTriggerConfig =
  | {
      cadenceMinutes: number;
    }
  | null;

type ScheduledDispatchContext = {
  cadenceMinutes: number;
  scheduleWindowEnd: string;
  scheduleWindowStart: string;
  scheduledAt: string;
};

function stepIdForRun(workflowRunId: string): string {
  return `${workflowRunId}:step:0`;
}

function deadLetterIdForStep(workflowStepId: string): string {
  return `wdl:${workflowStepId}`;
}

function workflowRunIdForEvent(workflowId: string, eventId: string): string {
  return `wfr:${workflowId}:${eventId}`;
}

function workflowRunIdForManualInvocation(
  workflowId: string,
  manualInvocationId: string
): string {
  return `wfr:${workflowId}:manual:${manualInvocationId}`;
}

function workflowRunIdForSchedule(
  workflowId: string,
  workflowVersionId: string,
  scheduleWindowStart: string
): string {
  return `wfr:${workflowId}:schedule:${workflowVersionId}:${scheduleWindowStart}`;
}

function workflowCommandId(workflowRunId: string, stepKey: string): string {
  return `${workflowRunId}:${stepKey}`;
}

function scheduledEventIdForWorkflowVersion(
  workflowVersionId: string,
  scheduleWindowStart: string
): string {
  return `evt:${workflowVersionId}:schedule:${scheduleWindowStart}`;
}

function scheduledCommandIdForWorkflowVersion(
  workflowVersionId: string,
  scheduleWindowStart: string
): string {
  return `cmd:${workflowVersionId}:schedule:${scheduleWindowStart}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readScheduledTriggerConfig(
  definition: PersistedWorkflowDefinition
): ScheduledTriggerConfig {
  if (definition.trigger.operatorId !== "scheduled") {
    return null;
  }

  const match = isRecord(definition.trigger.match)
    ? (definition.trigger.match as Record<string, unknown>)
    : null;
  const schedule = match && isRecord(match.schedule) ? match.schedule : null;
  const cadenceMinutes = schedule?.cadenceMinutes;

  if (
    typeof cadenceMinutes !== "number" ||
    !Number.isInteger(cadenceMinutes) ||
    cadenceMinutes <= 0
  ) {
    return null;
  }

  return {
    cadenceMinutes
  };
}

function normalizeScheduledTimeMs(scheduledTime: number): number {
  return scheduledTime - (scheduledTime % 60_000);
}

function buildScheduledDispatchContext(
  scheduledTime: number,
  cadenceMinutes: number
): ScheduledDispatchContext {
  const scheduleWindowEndMs = normalizeScheduledTimeMs(scheduledTime);
  const scheduleWindowStartMs = scheduleWindowEndMs - cadenceMinutes * 60_000;
  return {
    cadenceMinutes,
    scheduleWindowEnd: new Date(scheduleWindowEndMs).toISOString(),
    scheduleWindowStart: new Date(scheduleWindowStartMs).toISOString(),
    scheduledAt: new Date(scheduleWindowEndMs).toISOString()
  };
}

function isScheduledWorkflowDue(
  scheduledTime: number,
  cadenceMinutes: number
): boolean {
  const minuteWindow = Math.floor(normalizeScheduledTimeMs(scheduledTime) / 60_000);
  return minuteWindow % cadenceMinutes === 0;
}

function toEventRecord(row: EventRow): EventLedgerRecord {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;

  return {
    aggregateId: row.aggregate_id,
    commandId: row.command_id,
    commandType:
      typeof metadata.commandType === "string" ? metadata.commandType : row.event_type,
    createdAt: row.created_at,
    eventId: row.event_id,
    eventType: row.event_type,
    metadata,
    payload,
    tableId: row.table_id,
    workspaceId: row.workspace_id
  };
}

async function loadEvent(
  db: D1Database,
  workspaceId: string,
  eventId: string
): Promise<EventLedgerRecord | null> {
  const row = await db
    .prepare(
      `SELECT
         event_id,
         workspace_id,
         table_id,
         event_type,
         command_id,
         aggregate_id,
         payload_json,
         metadata_json,
         created_at
       FROM event_ledger
       WHERE workspace_id = ? AND event_id = ?`
    )
    .bind(workspaceId, eventId)
    .first<EventRow>();

  return row ? toEventRecord(row) : null;
}

async function loadWorkflowVersions(
  db: D1Database,
  workspaceId?: string
): Promise<WorkflowVersionRow[]> {
  const rows =
    workspaceId == null
      ? await db
          .prepare(
            `SELECT
               published.workspace_id AS workspace_id,
               published.id AS workflow_version_id,
               published.workflow_id AS workflow_id,
               published.definition_json AS definition_json
             FROM (
               SELECT workflow_versions.workspace_id,
                      workflow_versions.workflow_id,
                      MAX(workflow_versions.version) AS version
               FROM workflow_versions
               WHERE workflow_versions.published_at IS NOT NULL
               GROUP BY workflow_versions.workspace_id, workflow_versions.workflow_id
             ) latest
             INNER JOIN workflow_versions published
               ON published.workspace_id = latest.workspace_id
              AND published.workflow_id = latest.workflow_id
              AND published.version = latest.version
             INNER JOIN workflows
               ON workflows.id = published.workflow_id
              AND workflows.workspace_id = published.workspace_id
             WHERE workflows.archived_at IS NULL`
          )
          .bind()
          .all<WorkflowVersionRow>()
      : await db
          .prepare(
            `SELECT
               published.workspace_id AS workspace_id,
               published.id AS workflow_version_id,
               published.workflow_id AS workflow_id,
               published.definition_json AS definition_json
             FROM (
               SELECT workflow_versions.workspace_id,
                      workflow_versions.workflow_id,
                      MAX(workflow_versions.version) AS version
               FROM workflow_versions
               WHERE workflow_versions.workspace_id = ?
                 AND workflow_versions.published_at IS NOT NULL
               GROUP BY workflow_versions.workspace_id, workflow_versions.workflow_id
             ) latest
             INNER JOIN workflow_versions published
               ON published.workspace_id = latest.workspace_id
              AND published.workflow_id = latest.workflow_id
              AND published.version = latest.version
             INNER JOIN workflows
               ON workflows.id = published.workflow_id
              AND workflows.workspace_id = published.workspace_id
             WHERE workflows.archived_at IS NULL`
          )
          .bind(workspaceId)
          .all<WorkflowVersionRow>();

  return rows.results ?? [];
}

async function nextWorkspaceSequence(
  db: D1Database,
  workspaceId: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(workspace_sequence), 0) + 1 AS next_workspace_sequence
       FROM event_ledger
       WHERE workspace_id = ?`
    )
    .bind(workspaceId)
    .first<{ next_workspace_sequence: number }>();

  return row?.next_workspace_sequence ?? 1;
}

async function persistScheduledTriggerEvent(
  db: D1Database,
  workspaceId: string,
  definition: PersistedWorkflowDefinition,
  workflowVersionId: string,
  context: ScheduledDispatchContext
): Promise<string> {
  const eventId = scheduledEventIdForWorkflowVersion(
    workflowVersionId,
    context.scheduleWindowStart
  );
  const existingEvent = await loadEvent(db, workspaceId, eventId);
  if (existingEvent) {
    return existingEvent.eventId;
  }

  const createdAt = context.scheduledAt;
  const workspaceSequence = await nextWorkspaceSequence(db, workspaceId);
  await db.batch([
    db
      .prepare(
        `INSERT INTO event_ledger (
           event_id,
           workspace_id,
           table_id,
           event_type,
           command_id,
           aggregate_id,
           workspace_sequence,
           table_sequence,
           payload_json,
           metadata_json,
           created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .bind(
        eventId,
        workspaceId,
        "workflow.scheduled",
        scheduledCommandIdForWorkflowVersion(workflowVersionId, context.scheduleWindowStart),
        definition.workflowId,
        workspaceSequence,
        JSON.stringify({
          cadenceMinutes: context.cadenceMinutes,
          scheduleWindowEnd: context.scheduleWindowEnd,
          scheduleWindowStart: context.scheduleWindowStart,
          scheduledAt: context.scheduledAt,
          workflowId: definition.workflowId,
          workflowVersionId
        }),
        JSON.stringify({
          actor: {
            mode: "workflow",
            principalId: definition.principal?.principalId ?? definition.workflowId
          },
          aggregateType: "workflow",
          commandType: "workflow.scheduled",
          permissionScopeHash: definition.principal?.scopeHash ?? null,
          permissionsVersion: definition.principal?.policyRevision ?? null,
          schemaEpoch: definition.principal?.schemaEpoch ?? null,
          scope: "workflow"
        }),
        createdAt
      )
  ]);

  return eventId;
}

async function persistWorkflowRunAndStep(
  env: CloudTableEnv,
  input: {
    action: WorkflowActionBinding;
    event: EventLedgerRecord;
    state: Record<string, unknown>;
    version: WorkflowVersionRow;
    workflowRunId: string;
  }
): Promise<void> {
  const runtime = createRuntime(env);
  const operator = runtime.workflowOperatorRegistry.require(input.action.operatorId);
  if (operator.kind !== "action") {
    return;
  }

  const now = new Date().toISOString();
  const workflowStepId = stepIdForRun(input.workflowRunId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workflow_runs (
         id,
         workspace_id,
         workflow_id,
         workflow_version_id,
         trigger_event_id,
         manual_invocation_id,
         principal_id,
         status,
         attempt_count,
         started_at,
         updated_at,
         finished_at,
         dead_lettered_at,
         state_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, ?)`
    ).bind(
      input.workflowRunId,
      input.event.workspaceId,
      input.version.workflow_id,
      input.version.workflow_version_id,
      input.event.eventId,
      input.state.manualInvocationId ?? null,
      input.state.principalId ?? input.version.workflow_id,
      "queued",
      now,
      now,
      JSON.stringify(input.state)
    ),
    env.DB.prepare(
      `INSERT INTO workflow_run_steps (
         id,
         workflow_run_id,
         workspace_id,
         step_key,
         operator_id,
         operator_version,
         status,
         attempt_count,
         input_json,
         output_json,
         audit_json,
         last_error_code,
         started_at,
         updated_at,
         finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, NULL, ?, ?, NULL)`
    ).bind(
      workflowStepId,
      input.workflowRunId,
      input.event.workspaceId,
      "action:0",
      input.action.operatorId,
      operator.version,
      "queued",
      JSON.stringify(input.action.input),
      JSON.stringify(input.state),
      now,
      now
    )
  ]);

  await env.WORKFLOW_STEP_QUEUE.send({
    kind: "workflow-step",
    payload: {
      workflowStepId
    },
    workflowRunId: input.workflowRunId,
    workspaceId: input.event.workspaceId
  });
}

async function processScheduledWorkflowDispatchMessage(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  const workflowVersionId =
    typeof message.payload.workflowVersionId === "string"
      ? message.payload.workflowVersionId
      : null;
  const scheduleWindowStart =
    typeof message.payload.scheduleWindowStart === "string"
      ? message.payload.scheduleWindowStart
      : null;
  const scheduleWindowEnd =
    typeof message.payload.scheduleWindowEnd === "string"
      ? message.payload.scheduleWindowEnd
      : null;
  const scheduledAt =
    typeof message.payload.scheduledAt === "string" ? message.payload.scheduledAt : null;
  const cadenceMinutes =
    typeof message.payload.cadenceMinutes === "number" &&
    Number.isInteger(message.payload.cadenceMinutes) &&
    message.payload.cadenceMinutes > 0
      ? message.payload.cadenceMinutes
      : null;

  if (!workflowVersionId || !scheduleWindowStart || !scheduleWindowEnd || !scheduledAt || !cadenceMinutes) {
    return;
  }

  const version = await env.DB
    .prepare(
      `SELECT
         workflow_versions.workspace_id AS workspace_id,
         workflow_versions.id AS workflow_version_id,
         workflow_versions.workflow_id AS workflow_id,
         workflow_versions.definition_json AS definition_json
       FROM workflow_versions
       INNER JOIN workflows
         ON workflows.id = workflow_versions.workflow_id
        AND workflows.workspace_id = workflow_versions.workspace_id
       WHERE workflow_versions.workspace_id = ?
         AND workflow_versions.id = ?
         AND workflow_versions.published_at IS NOT NULL
         AND workflows.archived_at IS NULL`
    )
    .bind(message.workspaceId, workflowVersionId)
    .first<WorkflowVersionRow>();
  if (!version) {
    return;
  }

  const definition = parseWorkflowDefinition(version.definition_json);
  if (workflowStatus(definition) !== "published") {
    return;
  }

  const scheduledTrigger = readScheduledTriggerConfig(definition);
  if (!scheduledTrigger || scheduledTrigger.cadenceMinutes !== cadenceMinutes) {
    return;
  }

  const workflowRunId = workflowRunIdForSchedule(
    definition.workflowId,
    workflowVersionId,
    scheduleWindowStart
  );
  const existingRun = await loadWorkflowRun(env.DB, workflowRunId);
  if (existingRun || definition.actions.length === 0) {
    return;
  }

  const eventId = await persistScheduledTriggerEvent(env.DB, message.workspaceId, definition, workflowVersionId, {
    cadenceMinutes,
    scheduleWindowEnd,
    scheduleWindowStart,
    scheduledAt
  });
  const event = await loadEvent(env.DB, message.workspaceId, eventId);
  if (!event) {
    return;
  }

  const scope = await buildExecutionScope(env.DB, definition.workflowId, workflowRunId, event);
  const runtime = createRuntime(env);
  const trigger = runtime.workflowOperatorRegistry.require(definition.trigger.operatorId);
  if (trigger.kind !== "trigger" || !matchWorkflowTrigger(trigger, definition.trigger, scope)) {
    return;
  }

  await persistWorkflowRunAndStep(env, {
    action: definition.actions[0]!,
    event,
    state: {
      cadenceMinutes,
      principalId: definition.principal?.principalId ?? definition.workflowId,
      scheduleWindowEnd,
      scheduleWindowStart,
      scheduledAt,
      triggerEventId: event.eventId
    },
    version,
    workflowRunId
  });
}

export async function enqueueScheduledWorkflowDispatches(
  env: CloudTableEnv,
  scheduledTime: number
): Promise<void> {
  const workflows = await loadWorkflowVersions(env.DB);
  for (const version of workflows) {
    const definition = parseWorkflowDefinition(version.definition_json);
    if (workflowStatus(definition) !== "published") {
      continue;
    }

    const scheduledTrigger = readScheduledTriggerConfig(definition);
    if (!scheduledTrigger || !isScheduledWorkflowDue(scheduledTime, scheduledTrigger.cadenceMinutes)) {
      continue;
    }

    const schedule = buildScheduledDispatchContext(
      scheduledTime,
      scheduledTrigger.cadenceMinutes
    );
    await env.WORKFLOW_DISPATCH_QUEUE.send({
      kind: "workflow-dispatch",
      payload: {
        cadenceMinutes: schedule.cadenceMinutes,
        scheduleWindowEnd: schedule.scheduleWindowEnd,
        scheduleWindowStart: schedule.scheduleWindowStart,
        scheduledAt: schedule.scheduledAt,
        triggerKind: "scheduled",
        workflowId: version.workflow_id,
        workflowVersionId: version.workflow_version_id
      },
      workspaceId: version.workspace_id
    });
  }
}

async function loadWorkflowRun(
  db: D1Database,
  workflowRunId: string
): Promise<WorkflowRunRow | null> {
  return db
    .prepare(
      `SELECT
         id,
         workflow_id,
         workflow_version_id,
         trigger_event_id,
         manual_invocation_id,
         principal_id,
         state_json,
         status
       FROM workflow_runs
       WHERE id = ?`
    )
    .bind(workflowRunId)
    .first<WorkflowRunRow>();
}

async function loadWorkflowStep(
  db: D1Database,
  workflowStepId: string
): Promise<WorkflowStepRow | null> {
  return db
    .prepare(
      `SELECT
         id,
         workflow_run_id,
         step_key,
         operator_id,
         status,
         attempt_count,
         audit_json,
         input_json
       FROM workflow_run_steps
       WHERE id = ?`
    )
    .bind(workflowStepId)
    .first<WorkflowStepRow>();
}

async function loadWorkflowDeadLetter(
  db: D1Database,
  deadLetterId: string
): Promise<WorkflowDeadLetterRow | null> {
  return db
    .prepare(
      `SELECT
         id,
         workflow_run_id,
         workspace_id,
         queue_name,
         payload_json,
         failure_code,
         failure_message,
         attempt_count,
         created_at
       FROM workflow_dead_letters
       WHERE id = ?`
    )
    .bind(deadLetterId)
    .first<WorkflowDeadLetterRow>();
}

function isReplayableWorkflowFailure(
  result: WorkflowExecutionResult,
  actionResult: WorkflowActionExecution
): boolean {
  return (
    result.matchedTrigger &&
    !actionResult.skipped &&
    !actionResult.result.accepted &&
    actionResult.result.permission.allowed
  );
}

function workflowRetryPolicyForFailure(
  action: WorkflowActionDefinition,
  actionResult: WorkflowActionExecution
): WorkflowRetryPolicy | null {
  if (
    actionResult.skipped ||
    actionResult.result.accepted ||
    !actionResult.result.permission.allowed
  ) {
    return null;
  }

  const diagnostic = actionResult.result.diagnostics[0] ?? "";
  if (action.retryClass === "network") {
    if (
      diagnostic === "workflow_webhook_network_error" ||
      diagnostic === "workflow_webhook_http_429" ||
      /^workflow_webhook_http_5\d{2}$/.test(diagnostic)
    ) {
      return {
        baseDelaySeconds: 30,
        maxAttempts: 8,
        retryClass: "network"
      };
    }

    return null;
  }

  if (action.retryClass === "standard" && diagnostic.startsWith("transient_")) {
    return {
      baseDelaySeconds: 5,
      maxAttempts: 5,
      retryClass: "standard"
    };
  }

  return null;
}

function nextWorkflowRetryMetadata(
  policy: WorkflowRetryPolicy,
  currentAttempt: number,
  now: Date
): WorkflowStepRetryMetadata | null {
  if (currentAttempt >= policy.maxAttempts) {
    return null;
  }

  const delaySeconds = Math.max(
    1,
    Math.min(policy.baseDelaySeconds * 2 ** Math.max(currentAttempt - 1, 0), 60 * 60)
  );
  return {
    attempt: currentAttempt + 1,
    delaySeconds,
    maxAttempts: policy.maxAttempts,
    nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
    retryClass: policy.retryClass
  };
}

function recordRetryState(
  base: string | null,
  input: {
    diagnostic: string;
    retry: WorkflowStepRetryMetadata;
  }
): string {
  const parsed = parseJsonRecord(base);
  return JSON.stringify({
    ...parsed,
    retry: {
      attempt: input.retry.attempt,
      delaySeconds: input.retry.delaySeconds,
      lastErrorCode: input.diagnostic,
      maxAttempts: input.retry.maxAttempts,
      nextAttemptAt: input.retry.nextAttemptAt,
      retryClass: input.retry.retryClass
    }
  });
}

function clearRetryState(base: string | null): string {
  const parsed = parseJsonRecord(base);
  if (!("retry" in parsed)) {
    return JSON.stringify(parsed);
  }

  const { retry: _retry, ...rest } = parsed;
  return JSON.stringify(rest);
}

function asWebhookHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return headers;
  }

  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue === "string") {
      headers.set(key, headerValue);
    }
  }

  return headers;
}

function webhookRequestBody(
  method: string,
  payload: Record<string, unknown>,
  headers: Headers
): BodyInit | null {
  if (method === "GET" || method === "HEAD") {
    return null;
  }

  const body = payload.body;
  if (typeof body === "string") {
    if (!headers.has("content-type")) {
      headers.set("content-type", "text/plain; charset=utf-8");
    }
    return body;
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return JSON.stringify(body ?? null);
}

function webhookFailureResult(
  result: Awaited<ReturnType<CloudTableRuntime["commandBus"]["execute"]>>,
  diagnostic: string
) {
  const failed = cloneCommandResult(result);
  failed.accepted = false;
  failed.status = "rejected";
  failed.diagnostics = [diagnostic];
  return failed;
}

async function executeWorkflowActionCommand(
  runtime: CloudTableRuntime,
  command: Parameters<CloudTableRuntime["commandBus"]["execute"]>[0]
): Promise<Awaited<ReturnType<CloudTableRuntime["commandBus"]["execute"]>>> {
  const result = await runtime.commandBus.execute(command);
  if (command.commandType !== "workflow.webhook.enqueue") {
    return result;
  }

  if (!result.permission.allowed) {
    return result;
  }

  if (!result.accepted && !result.diagnostics.includes("idempotent_replay")) {
    return result;
  }

  const destination =
    typeof command.payload.destination === "string" ? command.payload.destination : null;
  if (!destination) {
    return webhookFailureResult(result, "workflow_webhook_destination_missing");
  }

  const method =
    typeof command.payload.method === "string" && command.payload.method.length > 0
      ? command.payload.method.toUpperCase()
      : "POST";
  const headers = asWebhookHeaders(command.payload.headers);
  headers.set("idempotency-key", command.idempotencyKey);
  headers.set("x-cloudtable-command-id", command.commandId);
  if (typeof command.payload.workflowRunId === "string") {
    headers.set("x-cloudtable-workflow-run-id", command.payload.workflowRunId);
  }
  if (typeof command.payload.workflowStepId === "string") {
    headers.set("x-cloudtable-workflow-step-id", command.payload.workflowStepId);
  }
  if (typeof command.payload.triggerEventId === "string") {
    headers.set("x-cloudtable-trigger-event-id", command.payload.triggerEventId);
  }

  try {
    const response = await fetch(destination, {
      body: webhookRequestBody(method, command.payload, headers),
      headers,
      method
    });
    if (!response.ok) {
      return webhookFailureResult(result, `workflow_webhook_http_${response.status}`);
    }
  } catch {
    return webhookFailureResult(result, "workflow_webhook_network_error");
  }

  return result;
}

async function persistWorkflowDeadLetter(
  db: D1Database,
  input: {
    failureCode: string;
    failureMessage: string;
    message: CloudTableQueueMessage;
    workflowRunId: string;
    workflowStepAttemptCount: number;
    workflowStepId: string;
  }
): Promise<void> {
  const deadLetterId = deadLetterIdForStep(input.workflowStepId);
  const persistedPayload = JSON.stringify({
    sourceMessage: input.message,
    workflowRunId: input.workflowRunId,
    workflowStepId: input.workflowStepId
  });
  const existing = await loadWorkflowDeadLetter(db, deadLetterId);

  if (existing) {
    await db.batch([
      db
        .prepare(
          `UPDATE workflow_dead_letters
           SET
             queue_name = ?,
             payload_json = ?,
             failure_code = ?,
             failure_message = ?,
             attempt_count = ?
           WHERE id = ?`
        )
        .bind(
          input.message.kind,
          persistedPayload,
          input.failureCode,
          input.failureMessage,
          input.workflowStepAttemptCount,
          deadLetterId
        )
    ]);
    return;
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO workflow_dead_letters (
           id,
           workflow_run_id,
           workspace_id,
           queue_name,
           payload_json,
           failure_code,
           failure_message,
           attempt_count,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        deadLetterId,
        input.workflowRunId,
        input.message.workspaceId,
        input.message.kind,
        persistedPayload,
        input.failureCode,
        input.failureMessage,
        input.workflowStepAttemptCount,
        new Date().toISOString()
      )
  ]);
}

async function loadRecordContext(
  db: D1Database,
  workspaceId: string,
  tableId: string,
  recordId: string
): Promise<WorkflowExecutionScope["row"]> {
  const record = await db
    .prepare(
      `SELECT id AS record_id
       FROM records
       WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
    )
    .bind(workspaceId, tableId, recordId)
    .first<RecordRow>();

  if (!record) {
    return undefined;
  }

  const cells = await db
    .prepare(
      `SELECT
         fields.id AS field_id,
         fields.field_key AS field_key,
         fields.field_type AS field_type,
         fields.config_json AS config_json,
         cell_current.value_json AS value_json
       FROM cell_current
       INNER JOIN fields
         ON fields.id = cell_current.field_id
       WHERE cell_current.workspace_id = ?
         AND cell_current.table_id = ?
         AND cell_current.record_id = ?
         AND fields.archived_at IS NULL
       ORDER BY
         CASE WHEN fields.field_order IS NULL THEN 0 ELSE 1 END ASC,
         CASE WHEN fields.field_order IS NULL THEN fields.created_at ELSE NULL END ASC,
         CASE WHEN fields.field_order IS NULL THEN fields.id ELSE NULL END ASC,
         fields.field_order ASC,
         fields.id ASC`
    )
    .bind(workspaceId, tableId, recordId)
    .all<FieldCellRow>();

  const fields = Object.fromEntries(
    (cells.results ?? []).map((cell) => {
      const parsed = JSON.parse(cell.value_json) as { raw?: unknown } | null;
      const value: WorkflowFieldValue = {
        fieldId: cell.field_id,
        fieldType: cell.field_type,
        value: parsed?.raw
      };
      return [cell.field_key, value];
    })
  );
  const rowOwnerField = findRowOwnerField(
    (cells.results ?? []).map((cell) => ({
      config: JSON.parse(cell.config_json) as JsonValue,
      fieldId: cell.field_id,
      fieldKey: cell.field_key,
      fieldType: cell.field_type
    }))
  );

  return {
    fields,
    ...(rowOwnerField ? { owner: fields[rowOwnerField.fieldKey] } : {}),
    recordId: record.record_id
  };
}

async function buildExecutionScope(
  db: D1Database,
  workflowId: string,
  workflowRunId: string,
  event: EventLedgerRecord
): Promise<WorkflowExecutionScope> {
  const tableId = event.tableId ?? undefined;
  const recordId =
    typeof event.payload.recordId === "string" ? event.payload.recordId : undefined;
  const fieldId =
    typeof event.payload.fieldId === "string" ? event.payload.fieldId : undefined;
  const fieldType =
    typeof event.payload.fieldType === "string" ? event.payload.fieldType : undefined;
  const row =
    tableId && recordId
      ? await loadRecordContext(db, event.workspaceId, tableId, recordId)
      : undefined;
  const cell =
    tableId && recordId && fieldId
      ? {
          fieldId,
          fieldType: fieldType ?? "",
          recordId,
          tableId,
          value: row?.fields
            ? Object.values(row.fields).find((candidate) => candidate.fieldId === fieldId)?.value
            : undefined
        }
      : undefined;

  return {
    ...(cell ? { cell } : {}),
    event,
    ...(row ? { row } : {}),
    ...(tableId ? { table: { row, tableId } } : {}),
    workflow: {
      triggerEventId: event.eventId,
      workflowId,
      workflowRunId
    }
  };
}

export async function fanOutWorkflowRunsForEvent(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  const eventId =
    typeof message.eventId === "string"
      ? message.eventId
      : typeof message.payload.eventId === "string"
        ? message.payload.eventId
        : null;
  if (!eventId) {
    return;
  }

  const event = await loadEvent(env.DB, message.workspaceId, eventId);
  if (!event) {
    return;
  }

  const workflows = await loadWorkflowVersions(env.DB, message.workspaceId);
  const manualWorkflowId =
    event.eventType === "workflow.manual" && typeof event.payload.workflowId === "string"
      ? event.payload.workflowId
      : null;
  const manualInvocationId =
    event.eventType === "workflow.manual" &&
    typeof event.payload.manualInvocationId === "string" &&
    event.payload.manualInvocationId.length > 0
      ? event.payload.manualInvocationId
      : null;

  for (const version of workflows) {
    const definition = parseWorkflowDefinition(version.definition_json);
    if (workflowStatus(definition) !== "published") {
      continue;
    }
    if (manualWorkflowId && definition.workflowId !== manualWorkflowId) {
      continue;
    }
    const runtime = createRuntime(env);
    const trigger = runtime.workflowOperatorRegistry.require(definition.trigger.operatorId);
    if (trigger.kind !== "trigger") {
      continue;
    }

    const workflowRunId =
      manualWorkflowId && manualInvocationId
        ? workflowRunIdForManualInvocation(definition.workflowId, manualInvocationId)
        : workflowRunIdForEvent(definition.workflowId, event.eventId);
    const scope = await buildExecutionScope(
      env.DB,
      definition.workflowId,
      workflowRunId,
      event
    );
    if (definition.actions.length === 0) {
      continue;
    }

    if (!matchWorkflowTrigger(trigger, definition.trigger, scope)) {
      continue;
    }

    const existingRun = await loadWorkflowRun(env.DB, workflowRunId);
    if (existingRun) {
      continue;
    }

    await persistWorkflowRunAndStep(env, {
      action: definition.actions[0]!,
      event,
      state: {
        ...(manualWorkflowId ? { manualInvocationId } : {}),
        principalId: definition.principal?.principalId ?? definition.workflowId,
        triggerEventId: event.eventId
      },
      version,
      workflowRunId
    });
  }
}

export async function executeWorkflowDispatchStep(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  const workflowRunId =
    typeof message.workflowRunId === "string" ? message.workflowRunId : null;
  const workflowStepId =
    typeof message.payload.workflowStepId === "string"
      ? message.payload.workflowStepId
      : null;
  if (!workflowRunId || !workflowStepId) {
    return;
  }

  const workflowRun = await loadWorkflowRun(env.DB, workflowRunId);
  const workflowStep = await loadWorkflowStep(env.DB, workflowStepId);
  if (!workflowRun || !workflowStep) {
    return;
  }

  if (
    workflowStep.status === "completed" ||
    workflowStep.status === "failed" ||
    workflowStep.status === "dead_lettered"
  ) {
    return;
  }

  if (message.retry) {
    const notBefore = Date.parse(message.retry.nextAttemptAt);
    const remainingSeconds = Math.ceil((notBefore - Date.now()) / 1000);
    if (Number.isFinite(notBefore) && remainingSeconds > 0) {
      await env.WORKFLOW_STEP_QUEUE.send(message, {
        delaySeconds: remainingSeconds
      });
      return;
    }
  }

  const version = await env.DB
    .prepare(
      `SELECT definition_json
       FROM workflow_versions
       WHERE workspace_id = ? AND id = ?`
    )
    .bind(message.workspaceId, workflowRun.workflow_version_id)
    .first<{ definition_json: string }>();
  if (!version) {
    return;
  }

  const triggerEvent = await loadEvent(env.DB, message.workspaceId, workflowRun.trigger_event_id);
  if (!triggerEvent) {
    return;
  }

  const workflow = parseWorkflowDefinition(version.definition_json);
  const firstAction = workflow.actions[0];
  if (!firstAction) {
    return;
  }

  const workflowPrincipalId = workflow.principal?.principalId ?? workflowRun.principal_id;
  const snapshot =
    (await readLatestPermissionSnapshotForScope(env.DB, {
      permissionScopeHash: workflow.principal?.scopeHash ?? null,
      principalId: workflowPrincipalId,
      workspaceId: message.workspaceId
    })) ??
    (await readPermissionSnapshot(env.DB, {
      permissionScopeHash: workflow.principal?.scopeHash ?? null,
      policyRevision: workflow.principal?.policyRevision ?? null,
      principalId: workflowPrincipalId,
      workspaceId: message.workspaceId
    }));
  const runtime = createRuntimeWithSnapshot(env, snapshot);
  const actionOperator = runtime.workflowOperatorRegistry.require(firstAction.operatorId);
  if (actionOperator.kind !== "action") {
    return;
  }
  const workflowWithResolvedPrincipal =
    snapshot && workflow.principal
      ? {
          ...workflow,
          principal: {
            ...workflow.principal,
            policyRevision: snapshot.policyRevision,
            principalId: snapshot.principalId,
            schemaEpoch: snapshot.schemaEpoch,
            scopeHash: snapshot.scopeHash
          }
        }
      : workflow;

  const scope = await buildExecutionScope(
    env.DB,
    workflow.workflowId,
    workflowRunId,
    triggerEvent
  );
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workflow_runs
       SET status = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ?`
    ).bind("running", now, workflowRunId),
    env.DB.prepare(
      `UPDATE workflow_run_steps
       SET status = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ?`
    ).bind("running", now, workflowStepId)
  ]);

  const result = await executeWorkflowDefinition(
    {
      ...workflowWithResolvedPrincipal,
      actions: [firstAction]
    },
    scope,
    runtime.workflowOperatorRegistry,
    {
      execute(command) {
        return executeWorkflowActionCommand(runtime, command);
      }
    }
  );
  const actionResult = result.matchedTrigger ? result.executedActions[0] : null;

  if (
    actionResult &&
    actionResult.result.accepted &&
    actionResult.result.events[0]?.eventId &&
    !actionResult.result.diagnostics.includes("idempotent_replay")
  ) {
    const repository = createCloudTableD1Repository(env.DB, runtime.fieldTypeRegistry);
    await publishOutboxEntries(
      env,
      repository,
      await repository.listOutboxEntriesForEvent(actionResult.result.events[0].eventId)
    );
  }

  const currentAttempt = workflowStep.attempt_count + 1;
  const retryPolicy =
    actionResult == null ? null : workflowRetryPolicyForFailure(actionOperator, actionResult);
  const terminalTime = new Date();
  const terminalTimestamp = terminalTime.toISOString();
  const diagnostics =
    actionResult?.result.diagnostics[0] ??
    (result.matchedTrigger ? "workflow_action_failed" : "workflow_trigger_miss");
  const nextRetry =
    retryPolicy && actionResult && isReplayableWorkflowFailure(result, actionResult)
      ? nextWorkflowRetryMetadata(retryPolicy, currentAttempt, terminalTime)
      : null;

  if (nextRetry) {
    const retryMessage: CloudTableQueueMessage = {
      ...message,
      retry: nextRetry
    };

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workflow_runs
         SET status = ?, updated_at = ?, state_json = ?
         WHERE id = ?`
      ).bind(
        "waiting_retry",
        terminalTimestamp,
        recordRetryState(workflowRun.state_json, {
          diagnostic: diagnostics,
          retry: nextRetry
        }),
        workflowRunId
      ),
      env.DB.prepare(
        `UPDATE workflow_run_steps
         SET
           status = ?,
           output_json = ?,
           audit_json = ?,
           last_error_code = ?,
           updated_at = ?,
           finished_at = NULL
         WHERE id = ?`
      ).bind(
        "retryable_failed",
        JSON.stringify(actionResult?.result ?? result),
        recordRetryState(workflowStep.audit_json, {
          diagnostic: diagnostics,
          retry: nextRetry
        }),
        diagnostics,
        terminalTimestamp,
        workflowStepId
      )
    ]);

    await env.WORKFLOW_STEP_QUEUE.send(retryMessage, {
      delaySeconds: nextRetry.delaySeconds
    });
    return;
  }

  const terminalStatus =
    actionResult && actionResult.result.accepted && !actionResult.skipped
      ? "completed"
      : actionResult && isReplayableWorkflowFailure(result, actionResult)
        ? "dead_lettered"
        : "failed";

  if (terminalStatus === "dead_lettered") {
    await persistWorkflowDeadLetter(env.DB, {
      failureCode: diagnostics,
      failureMessage: diagnostics,
      message,
      workflowRunId,
      workflowStepAttemptCount: currentAttempt,
      workflowStepId
    });
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workflow_runs
       SET status = ?, updated_at = ?, finished_at = ?, dead_lettered_at = ?, state_json = ?
       WHERE id = ?`
    ).bind(
      terminalStatus,
      terminalTimestamp,
      terminalTimestamp,
      terminalStatus === "dead_lettered" ? terminalTimestamp : null,
      clearRetryState(workflowRun.state_json),
      workflowRunId
    ),
    env.DB.prepare(
      `UPDATE workflow_run_steps
       SET
         status = ?,
         output_json = ?,
         audit_json = ?,
         last_error_code = ?,
         updated_at = ?,
         finished_at = ?
       WHERE id = ?`
    ).bind(
      terminalStatus,
      JSON.stringify(actionResult?.result ?? result),
      clearRetryState(workflowStep.audit_json),
      terminalStatus === "completed" ? null : diagnostics,
      terminalTimestamp,
      terminalTimestamp,
      workflowStepId
    )
  ]);
}

export async function processEventFanoutMessage(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  const eventId =
    typeof message.eventId === "string"
      ? message.eventId
      : typeof message.payload.eventId === "string"
        ? message.payload.eventId
        : null;
  if (!eventId) {
    return;
  }

  await env.WORKFLOW_DISPATCH_QUEUE.send({
    kind: "workflow-dispatch",
    eventId,
    payload: {
      eventId
    },
    workspaceId: message.workspaceId
  });

  if (await shouldEnqueueProjectionMaintenance(env.DB, message.workspaceId, eventId)) {
    await env.PROJECTION_MAINTENANCE_QUEUE.send({
      kind: "projection-maintenance",
      eventId,
      payload: {
        eventId
      },
      workspaceId: message.workspaceId
    });
  }
}

export async function processDeadLetterReprocessorMessage(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  const deadLetterId =
    typeof message.payload.deadLetterId === "string" ? message.payload.deadLetterId : null;
  if (!deadLetterId) {
    return;
  }

  const deadLetter = await loadWorkflowDeadLetter(env.DB, deadLetterId);
  if (!deadLetter) {
    return;
  }

  const payload = JSON.parse(deadLetter.payload_json) as {
    sourceMessage?: CloudTableQueueMessage;
    workflowStepId?: string;
  };
  const workflowStepId =
    typeof payload.workflowStepId === "string" ? payload.workflowStepId : null;
  const sourceMessage = payload.sourceMessage;

  if (
    !workflowStepId ||
    !sourceMessage ||
    sourceMessage.kind !== "workflow-step" ||
    sourceMessage.workspaceId !== deadLetter.workspace_id
  ) {
    return;
  }

  const workflowRun = await loadWorkflowRun(env.DB, deadLetter.workflow_run_id);
  const workflowStep = await loadWorkflowStep(env.DB, workflowStepId);
  if (!workflowRun || !workflowStep) {
    return;
  }

  if (workflowRun.status !== "dead_lettered" || workflowStep.status !== "dead_lettered") {
    return;
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workflow_runs
       SET status = ?, updated_at = ?, finished_at = NULL, dead_lettered_at = NULL, state_json = ?
       WHERE id = ?`
    ).bind("queued", now, clearRetryState(workflowRun.state_json), workflowRun.id),
    env.DB.prepare(
      `UPDATE workflow_run_steps
       SET
         status = ?,
         output_json = NULL,
         audit_json = ?,
         last_error_code = NULL,
         updated_at = ?,
         finished_at = NULL
       WHERE id = ?`
    ).bind("queued", clearRetryState(workflowStep.audit_json), now, workflowStep.id)
  ]);

  const { retry: _retry, ...replayMessage } = sourceMessage;
  await env.WORKFLOW_STEP_QUEUE.send(replayMessage);
}

export async function processWorkflowDispatchMessage(
  env: CloudTableEnv,
  message: CloudTableQueueMessage
): Promise<void> {
  if (message.payload.triggerKind === "scheduled") {
    await processScheduledWorkflowDispatchMessage(env, message);
    return;
  }

  await fanOutWorkflowRunsForEvent(env, message);
}
export const processWorkflowStepMessage = executeWorkflowDispatchStep;
