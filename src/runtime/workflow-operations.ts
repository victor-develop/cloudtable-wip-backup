import type { EffectivePermissionSnapshot } from "../core/permissions/types";
import type { CloudTableEnv, CloudTableQueueMessage } from "./env";
import { readWorkflowTriggerTableId } from "./workflow-definition";

type WorkflowRunHistoryRow = {
  attempt_count: number;
  dead_lettered_at: string | null;
  finished_at: string | null;
  id: string;
  manual_invocation_id: string | null;
  principal_id: string;
  started_at: string;
  state_json: string | null;
  status: string;
  trigger_event_id: string;
  updated_at: string;
  workflow_id: string;
  workflow_version_id: string;
};

type WorkflowStepHistoryRow = {
  attempt_count: number;
  audit_json: string | null;
  finished_at: string | null;
  id: string;
  input_json: string;
  last_error_code: string | null;
  operator_id: string;
  operator_version: number;
  output_json: string | null;
  started_at: string;
  status: string;
  step_key: string;
  updated_at: string;
  workflow_run_id: string;
};

type WorkflowDeadLetterHistoryRow = {
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

type WorkflowLookupRow = {
  workflow_id: string;
};

type WorkflowVersionLookupRow = {
  definition_json: string;
};

type ReplayRequestPayload = {
  replayRequest?: {
    id: string;
    requestedAt: string;
    requestedBy: string;
  };
  sourceMessage?: CloudTableQueueMessage;
  workflowRunId?: string;
  workflowStepId?: string;
};

type WorkflowHistoryItem = {
  attemptCount: number;
  deadLetteredAt: string | null;
  finishedAt: string | null;
  id: string;
  manualInvocationId: string | null;
  principalId: string;
  startedAt: string;
  state: Record<string, unknown> | null;
  status: string;
  steps: Array<{
    attemptCount: number;
    audit: Record<string, unknown> | null;
    finishedAt: string | null;
    id: string;
    input: Record<string, unknown>;
    lastErrorCode: string | null;
    operatorId: string;
    operatorVersion: number;
    output: Record<string, unknown> | null;
    replayEligible: boolean;
    replayRequested: boolean;
    startedAt: string;
    status: string;
    stepKey: string;
    updatedAt: string;
  }>;
  triggerEventId: string;
  updatedAt: string;
  workflowId: string;
  workflowVersionId: string;
};

function parseJsonRecord(input: string | null): Record<string, unknown> | null {
  if (!input) {
    return null;
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseReplayPayload(input: string): ReplayRequestPayload {
  const parsed = parseJsonRecord(input);
  return parsed ? (parsed as ReplayRequestPayload) : {};
}

function isWorkflowOperationsAuthorized(snapshot: EffectivePermissionSnapshot): boolean {
  const allowed = new Set(snapshot.commandTypes ?? []);
  return (
    allowed.has("workflow.manual") ||
    allowed.has("workflow.create") ||
    allowed.has("workflow.publish") ||
    allowed.has("workflow.pause")
  );
}

async function loadWorkflowSteps(
  db: D1Database,
  workflowRunId: string
): Promise<WorkflowStepHistoryRow[]> {
  const rows = await db
    .prepare(
      `SELECT
         id,
         workflow_run_id,
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
       FROM workflow_run_steps
       WHERE workflow_run_id = ?
       ORDER BY step_key ASC`
    )
    .bind(workflowRunId)
    .all<WorkflowStepHistoryRow>();

  return rows.results ?? [];
}

async function loadWorkflowDeadLetters(
  db: D1Database,
  workflowRunId: string
): Promise<WorkflowDeadLetterHistoryRow[]> {
  const rows = await db
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
       WHERE workflow_run_id = ?
       ORDER BY id ASC`
    )
    .bind(workflowRunId)
    .all<WorkflowDeadLetterHistoryRow>();

  return rows.results ?? [];
}

function mapHistoryRun(
  run: WorkflowRunHistoryRow,
  steps: WorkflowStepHistoryRow[],
  deadLetters: WorkflowDeadLetterHistoryRow[]
): WorkflowHistoryItem {
  const deadLettersByStepId = new Map(
    deadLetters.map((deadLetter) => {
      const payload = parseReplayPayload(deadLetter.payload_json);
      return [payload.workflowStepId ?? deadLetter.id, { deadLetter, payload }] as const;
    })
  );

  return {
    attemptCount: run.attempt_count,
    deadLetteredAt: run.dead_lettered_at,
    finishedAt: run.finished_at,
    id: run.id,
    manualInvocationId: run.manual_invocation_id,
    principalId: run.principal_id,
    startedAt: run.started_at,
    state: parseJsonRecord(run.state_json),
    status: run.status,
    steps: steps.map((step) => {
      const linkedDeadLetter = deadLettersByStepId.get(step.id);
      return {
        attemptCount: step.attempt_count,
        audit: parseJsonRecord(step.audit_json),
        finishedAt: step.finished_at,
        id: step.id,
        input: parseJsonRecord(step.input_json) ?? {},
        lastErrorCode: step.last_error_code,
        operatorId: step.operator_id,
        operatorVersion: step.operator_version,
        output: parseJsonRecord(step.output_json),
        replayEligible:
          step.status === "dead_lettered" &&
          linkedDeadLetter?.deadLetter.queue_name === "workflow-step" &&
          !linkedDeadLetter.payload.replayRequest,
        replayRequested: linkedDeadLetter?.payload.replayRequest != null,
        startedAt: step.started_at,
        status: step.status,
        stepKey: step.step_key,
        updatedAt: step.updated_at
      };
    }),
    triggerEventId: run.trigger_event_id,
    updatedAt: run.updated_at,
    workflowId: run.workflow_id,
    workflowVersionId: run.workflow_version_id
  };
}

export async function readWorkflowIdForRun(
  db: D1Database,
  workflowRunId: string
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT workflow_id FROM workflow_runs WHERE id = ?`)
    .bind(workflowRunId)
    .first<WorkflowLookupRow>();

  return row?.workflow_id ?? null;
}

export async function readWorkflowIdForDeadLetter(
  db: D1Database,
  deadLetterId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT workflow_runs.workflow_id AS workflow_id
       FROM workflow_dead_letters
       INNER JOIN workflow_runs ON workflow_runs.id = workflow_dead_letters.workflow_run_id
       WHERE workflow_dead_letters.id = ?`
    )
    .bind(deadLetterId)
    .first<WorkflowLookupRow>();

  return row?.workflow_id ?? null;
}

export async function readWorkflowHistoryForWorkflow(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<{
  runs: WorkflowHistoryItem[];
  workflowId: string;
}> {
  const rows = await db
    .prepare(
      `SELECT
         id,
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
       FROM workflow_runs
       WHERE workspace_id = ? AND workflow_id = ?
       ORDER BY started_at DESC, id DESC`
    )
    .bind(workspaceId, workflowId)
    .all<WorkflowRunHistoryRow>();

  const runs = rows.results ?? [];
  const hydratedRuns = await Promise.all(
    runs.map(async (run) =>
      mapHistoryRun(
        run,
        await loadWorkflowSteps(db, run.id),
        await loadWorkflowDeadLetters(db, run.id)
      )
    )
  );

  return {
    runs: hydratedRuns,
    workflowId
  };
}

export async function readWorkflowHistoryForRun(
  db: D1Database,
  workspaceId: string,
  workflowRunId: string
): Promise<WorkflowHistoryItem | null> {
  const run = await db
    .prepare(
      `SELECT
         id,
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
       FROM workflow_runs
       WHERE workspace_id = ? AND id = ?`
    )
    .bind(workspaceId, workflowRunId)
    .first<WorkflowRunHistoryRow>();

  if (!run) {
    return null;
  }

  return mapHistoryRun(
    run,
    await loadWorkflowSteps(db, run.id),
    await loadWorkflowDeadLetters(db, run.id)
  );
}

export async function readWorkflowTriggerTableIdForWorkflow(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT workflow_versions.definition_json
       FROM workflows
       INNER JOIN workflow_versions
         ON workflow_versions.workflow_id = workflows.id
        AND workflow_versions.workspace_id = workflows.workspace_id
        AND workflow_versions.version = workflows.current_version
       WHERE workflows.workspace_id = ? AND workflows.id = ? AND workflows.archived_at IS NULL`
    )
    .bind(workspaceId, workflowId)
    .first<WorkflowVersionLookupRow>();

  if (!row) {
    return null;
  }

  try {
    return readWorkflowTriggerTableId(JSON.parse(row.definition_json) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function workflowOperationsAuthorized(snapshot: EffectivePermissionSnapshot): boolean {
  return isWorkflowOperationsAuthorized(snapshot);
}

export async function requestWorkflowDeadLetterReplay(
  env: CloudTableEnv,
  input: {
    deadLetterId: string;
    principalId: string;
    replayRequestId: string;
  }
): Promise<
  | { ok: true; status: "enqueued" }
  | { message: string; ok: false; reason: "already_requested" | "not_found" | "not_replayable" }
> {
  const deadLetter = await env.DB
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
    .bind(input.deadLetterId)
    .first<WorkflowDeadLetterHistoryRow>();

  if (!deadLetter) {
    return {
      message: `Workflow dead letter ${input.deadLetterId} was not found.`,
      ok: false,
      reason: "not_found"
    };
  }

  const workflowRun = await env.DB
    .prepare(`SELECT status FROM workflow_runs WHERE id = ?`)
    .bind(deadLetter.workflow_run_id)
    .first<{ status: string }>();
  const payload = parseReplayPayload(deadLetter.payload_json);

  if (payload.replayRequest) {
    return {
      message: `Workflow dead letter ${input.deadLetterId} already has a pending replay request.`,
      ok: false,
      reason: "already_requested"
    };
  }

  const workflowStepId =
    typeof payload.workflowStepId === "string" ? payload.workflowStepId : null;
  const sourceMessage = payload.sourceMessage;
  const workflowStep =
    workflowStepId == null
      ? null
      : await env.DB
          .prepare(`SELECT status FROM workflow_run_steps WHERE id = ?`)
          .bind(workflowStepId)
          .first<{ status: string }>();

  const replayable =
    deadLetter.queue_name === "workflow-step" &&
    workflowRun?.status === "dead_lettered" &&
    workflowStep?.status === "dead_lettered" &&
    sourceMessage?.kind === "workflow-step" &&
    sourceMessage.workspaceId === deadLetter.workspace_id &&
    typeof sourceMessage.payload.workflowStepId === "string" &&
    sourceMessage.payload.workflowStepId === workflowStepId;

  if (!replayable) {
    return {
      message: `Workflow dead letter ${input.deadLetterId} is not eligible for replay.`,
      ok: false,
      reason: "not_replayable"
    };
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE workflow_dead_letters
         SET payload_json = ?
         WHERE id = ?`
      )
      .bind(
        JSON.stringify({
          ...payload,
          replayRequest: {
            id: input.replayRequestId,
            requestedAt: now,
            requestedBy: input.principalId
          }
        }),
        input.deadLetterId
      )
  ]);

  await env.DEAD_LETTER_REPROCESSOR_QUEUE.send({
    kind: "dead-letter-reprocessor",
    payload: {
      deadLetterId: input.deadLetterId
    },
    workspaceId: deadLetter.workspace_id
  });

  return {
    ok: true,
    status: "enqueued"
  };
}
