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

type WorkflowDependencyIndexRow = {
  alias: string;
  definition_json: string;
  dependency_field_ids_json: string;
  dependency_kind: string;
  source_table_id: string | null;
  status: string;
  target_table_id: string | null;
  trigger_table_id: string | null;
  updated_at: string;
  workflow_version_id: string;
};

type WorkflowBackfillJobRow = {
  attempt_count: number;
  chunk_size: number;
  completed_at: string | null;
  cursor_json: string | null;
  dependency_alias: string;
  dependency_kind: string;
  id: string;
  last_error: string | null;
  operator_actor_principal_id: string | null;
  operator_reason: string | null;
  operator_transition_at: string | null;
  processed_count: number;
  reason: string;
  status: string;
  superseded_by_job_id: string | null;
  updated_at: string;
  workflow_version_id: string;
};

type WorkflowDependencyOperationsBackfillJob = {
  attemptCount: number;
  chunkSize: number;
  completedAt: string | null;
  cursor: Record<string, unknown> | null;
  dependencyAlias: string;
  dependencyKind: string;
  id: string;
  lastError: string | null;
  operatorActorPrincipalId: string | null;
  operatorReason: string | null;
  operatorTransitionAt: string | null;
  processedCount: number;
  reason: string;
  status: string;
  supersededByJobId: string | null;
  updatedAt: string;
  workflowVersionId: string;
};

type WorkflowDependencyOperationsDependency = {
  alias: string;
  definition: Record<string, unknown> | null;
  dependencyFieldIds: string[];
  kind: string;
  sourceTableId: string | null;
  status: string;
  targetTableId: string | null;
  triggerTableId: string | null;
  updatedAt: string;
  workflowVersionId: string;
};

type WorkflowDependencyOperationsSuggestedMaintenanceRequest = {
  input: {
    aggregateAliases?: string[];
    kind: "backfill";
    lookupAliases?: string[];
    reason: string;
    requestId: string;
    syncAliases?: string[];
    workflowId: string;
    workspaceId: string;
  };
  reason: "attention_required_backfill";
  successorToolId:
    | "requestWorkflowAggregateMaintenance"
    | "requestWorkflowLookupMaintenance"
    | "requestWorkflowSyncMaintenance";
  toolId:
    | "prepareWorkflowAggregateMaintenance"
    | "prepareWorkflowLookupMaintenance"
    | "prepareWorkflowSyncMaintenance";
};

const STALE_RUNNING_BACKFILL_JOB_MS = 15 * 60 * 1000;
const INTENTIONALLY_CLOSED_BACKFILL_STATUSES = new Set(["abandoned", "superseded"]);
const TERMINAL_BACKFILL_STATUSES = new Set([
  "abandoned",
  "completed",
  "superseded"
]);

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
    deadLetter: {
      attemptCount: number;
      createdAt: string;
      failureCode: string;
      failureMessage: string;
      id: string;
      queueName: string;
      replayRequest: {
        id: string;
        requestedAt: string;
        requestedBy: string;
      } | null;
    } | null;
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

function parseStringArray(input: string): string[] {
  try {
    const parsed = JSON.parse(input) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function isStaleRunningBackfillJob(job: WorkflowDependencyOperationsBackfillJob): boolean {
  if (job.status !== "running") {
    return false;
  }

  const updatedAtMs = Date.parse(job.updatedAt);
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= STALE_RUNNING_BACKFILL_JOB_MS;
}

function workflowMaintenanceReasonRequestId(
  dependencyKind: "aggregate" | "lookup" | "sync",
  workflowId: string,
  maintenanceKind: "backfill" | "recompute",
  reason: string
): string {
  return `${workflowMaintenanceRequestId(
    dependencyKind,
    workflowId,
    maintenanceKind
  )}:${encodeURIComponent(reason)}`;
}

function summarizeWorkflowDependencyOperations(input: {
  backfillJobs: WorkflowDependencyOperationsBackfillJob[];
  dependencies: WorkflowDependencyOperationsDependency[];
}) {
  const backfillJobsByStatus: Record<string, number> = {};
  const dependenciesByKind: Record<string, number> = {};
  const dependenciesByStatus: Record<string, number> = {};

  for (const dependency of input.dependencies) {
    incrementCount(dependenciesByKind, dependency.kind);
    incrementCount(dependenciesByStatus, dependency.status);
  }

  for (const job of input.backfillJobs) {
    incrementCount(backfillJobsByStatus, job.status);
  }

  const staleRunningBackfillJobs = input.backfillJobs.filter(isStaleRunningBackfillJob);
  const intentionallyClosedBackfillJobs = input.backfillJobs
    .filter((job) => INTENTIONALLY_CLOSED_BACKFILL_STATUSES.has(job.status))
    .map((job) => ({
      dependencyAlias: job.dependencyAlias,
      dependencyKind: job.dependencyKind,
      id: job.id,
      operatorAction: job.status === "superseded" ? "superseded_backfill" : "abandoned_backfill",
      operatorActorPrincipalId: job.operatorActorPrincipalId,
      operatorReason: job.operatorReason,
      operatorTransitionAt: job.operatorTransitionAt,
      reason: job.reason,
      status: job.status,
      supersededByJobId: job.supersededByJobId,
      workflowVersionId: job.workflowVersionId
    }));
  const attentionRequiredBackfillJobs = input.backfillJobs
    .filter(
      (job) =>
        job.status === "failed" || job.lastError != null || isStaleRunningBackfillJob(job)
    )
    .map((job) => ({
      dependencyAlias: job.dependencyAlias,
      dependencyKind: job.dependencyKind,
      id: job.id,
      lastError: job.lastError,
      operatorAction: "retry_backfill",
      reason: job.reason,
      staleRunning: isStaleRunningBackfillJob(job),
      status: job.status,
      workflowVersionId: job.workflowVersionId
    }));
  const pendingBackfillJobCount = input.backfillJobs.filter((job) =>
    ["queued", "running"].includes(job.status)
  ).length;
  const maintenanceState =
    attentionRequiredBackfillJobs.length > 0
      ? "attention_required"
      : pendingBackfillJobCount > 0
        ? "active"
        : input.backfillJobs.length > 0
          ? "complete"
          : "idle";

  return {
    attentionRequiredBackfillJobs,
    backfillJobsByStatus,
    abandonedBackfillJobCount: input.backfillJobs.filter((job) => job.status === "abandoned")
      .length,
    completedBackfillJobCount: input.backfillJobs.filter((job) => job.status === "completed")
      .length,
    dependencyCount: input.dependencies.length,
    dependenciesByKind,
    dependenciesByStatus,
    failedBackfillJobCount: attentionRequiredBackfillJobs.length,
    intentionallyClosedBackfillJobs,
    maintenanceState,
    pendingBackfillJobCount,
    resumableBackfillJobCount: input.backfillJobs.filter((job) => job.cursor != null).length,
    runningBackfillJobCount: input.backfillJobs.filter((job) => job.status === "running").length,
    totalBackfillProcessedCount: input.backfillJobs.reduce(
      (total, job) => total + job.processedCount,
      0
    ),
    staleRunningBackfillJobCount: staleRunningBackfillJobs.length,
    supersededBackfillJobCount: input.backfillJobs.filter((job) => job.status === "superseded")
      .length,
    terminalBackfillJobCount: input.backfillJobs.filter((job) =>
      TERMINAL_BACKFILL_STATUSES.has(job.status)
    ).length,
    totalBackfillJobCount: input.backfillJobs.length
  };
}

function workflowMaintenanceRequestId(
  dependencyKind: "aggregate" | "lookup" | "sync",
  workflowId: string,
  maintenanceKind: "backfill" | "recompute"
): string {
  return `workflow-${dependencyKind}-maintenance:${workflowId}:${maintenanceKind}`;
}

function suggestWorkflowMaintenanceRequests(input: {
  backfillJobs: WorkflowDependencyOperationsBackfillJob[];
  workflowId: string;
  workspaceId: string;
}): WorkflowDependencyOperationsSuggestedMaintenanceRequest[] {
  const aliasesByKindAndReason = new Map<"aggregate" | "lookup" | "sync", Map<string, Set<string>>>();

  for (const job of input.backfillJobs) {
    if (
      (job.status !== "failed" && job.lastError == null && !isStaleRunningBackfillJob(job)) ||
      !["aggregate", "lookup", "sync"].includes(job.dependencyKind)
    ) {
      continue;
    }

    const dependencyKind = job.dependencyKind as "aggregate" | "lookup" | "sync";
    const aliasesByReason =
      aliasesByKindAndReason.get(dependencyKind) ?? new Map<string, Set<string>>();
    const aliases = aliasesByReason.get(job.reason) ?? new Set<string>();
    aliases.add(job.dependencyAlias);
    aliasesByReason.set(job.reason, aliases);
    aliasesByKindAndReason.set(dependencyKind, aliasesByReason);
  }

  const suggestions: WorkflowDependencyOperationsSuggestedMaintenanceRequest[] = [];
  const kinds: Array<"aggregate" | "lookup" | "sync"> = ["aggregate", "lookup", "sync"];

  for (const dependencyKind of kinds) {
    const aliasesByReason = aliasesByKindAndReason.get(dependencyKind);
    if (!aliasesByReason) {
      continue;
    }

    for (const [reason, aliases] of [...aliasesByReason.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      const sortedAliases = [...aliases].sort();
      suggestions.push(
        dependencyKind === "aggregate"
          ? {
              input: {
                aggregateAliases: sortedAliases,
                kind: "backfill",
                reason,
                requestId: workflowMaintenanceReasonRequestId(
                  "aggregate",
                  input.workflowId,
                  "backfill",
                  reason
                ),
                workflowId: input.workflowId,
                workspaceId: input.workspaceId
              },
              reason: "attention_required_backfill",
              successorToolId: "requestWorkflowAggregateMaintenance",
              toolId: "prepareWorkflowAggregateMaintenance"
            }
          : dependencyKind === "lookup"
            ? {
                input: {
                  kind: "backfill",
                  lookupAliases: sortedAliases,
                  reason,
                  requestId: workflowMaintenanceReasonRequestId(
                    "lookup",
                    input.workflowId,
                    "backfill",
                    reason
                  ),
                  workflowId: input.workflowId,
                  workspaceId: input.workspaceId
                },
                reason: "attention_required_backfill",
                successorToolId: "requestWorkflowLookupMaintenance",
                toolId: "prepareWorkflowLookupMaintenance"
              }
          : {
              input: {
                kind: "backfill",
                reason,
                requestId: workflowMaintenanceReasonRequestId(
                  "sync",
                  input.workflowId,
                  "backfill",
                  reason
                ),
                syncAliases: sortedAliases,
                workflowId: input.workflowId,
                workspaceId: input.workspaceId
              },
              reason: "attention_required_backfill",
              successorToolId: "requestWorkflowSyncMaintenance",
              toolId: "prepareWorkflowSyncMaintenance"
            }
      );
    }
  }

  return suggestions;
}

function isWorkflowOperationsAuthorized(snapshot: EffectivePermissionSnapshot): boolean {
  const allowed = new Set(snapshot.commandTypes ?? []);
  return (
    allowed.has("workflow.manual") ||
    allowed.has("workflow.create") ||
    allowed.has("workflow.update") ||
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
        deadLetter: linkedDeadLetter
          ? {
              attemptCount: linkedDeadLetter.deadLetter.attempt_count,
              createdAt: linkedDeadLetter.deadLetter.created_at,
              failureCode: linkedDeadLetter.deadLetter.failure_code,
              failureMessage: linkedDeadLetter.deadLetter.failure_message,
              id: linkedDeadLetter.deadLetter.id,
              queueName: linkedDeadLetter.deadLetter.queue_name,
              replayRequest: linkedDeadLetter.payload.replayRequest ?? null
            }
          : null,
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

export async function readWorkflowDependencyOperations(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<{
  backfillJobs: WorkflowDependencyOperationsBackfillJob[];
  dependencies: WorkflowDependencyOperationsDependency[];
  summary: ReturnType<typeof summarizeWorkflowDependencyOperations>;
  suggestedMaintenanceRequests: WorkflowDependencyOperationsSuggestedMaintenanceRequest[];
  workflowId: string;
}> {
  const [dependencyRows, jobRows] = await Promise.all([
    db
      .prepare(
        `SELECT
           workflow_version_id,
           dependency_kind,
           alias,
           source_table_id,
           target_table_id,
           trigger_table_id,
           dependency_field_ids_json,
           definition_json,
           status,
           updated_at
         FROM workflow_dependency_index
         WHERE workspace_id = ? AND workflow_id = ?
         ORDER BY workflow_version_id ASC, dependency_kind ASC, alias ASC`
      )
      .bind(workspaceId, workflowId)
      .all<WorkflowDependencyIndexRow>(),
    db
      .prepare(
        `SELECT
           id,
           workflow_version_id,
           dependency_kind,
           dependency_alias,
           reason,
           status,
           chunk_size,
           cursor_json,
           processed_count,
           attempt_count,
           last_error,
           operator_reason,
           operator_actor_principal_id,
           operator_transition_at,
           superseded_by_job_id,
           updated_at,
           completed_at
         FROM workflow_backfill_jobs
         WHERE workspace_id = ? AND workflow_id = ?
         ORDER BY updated_at DESC, id ASC`
      )
      .bind(workspaceId, workflowId)
      .all<WorkflowBackfillJobRow>()
  ]);

  const backfillJobs = (jobRows.results ?? []).map((row) => ({
    attemptCount: row.attempt_count,
    chunkSize: row.chunk_size,
    completedAt: row.completed_at,
    cursor: parseJsonRecord(row.cursor_json),
    dependencyAlias: row.dependency_alias,
    dependencyKind: row.dependency_kind,
    id: row.id,
    lastError: row.last_error,
    operatorActorPrincipalId: row.operator_actor_principal_id,
    operatorReason: row.operator_reason,
    operatorTransitionAt: row.operator_transition_at,
    processedCount: row.processed_count,
    reason: row.reason,
    status: row.status,
    supersededByJobId: row.superseded_by_job_id,
    updatedAt: row.updated_at,
    workflowVersionId: row.workflow_version_id
  }));
  const dependencies = (dependencyRows.results ?? []).map((row) => ({
    alias: row.alias,
    definition: parseJsonRecord(row.definition_json),
    dependencyFieldIds: parseStringArray(row.dependency_field_ids_json),
    kind: row.dependency_kind,
    sourceTableId: row.source_table_id,
    status: row.status,
    targetTableId: row.target_table_id,
    triggerTableId: row.trigger_table_id,
    updatedAt: row.updated_at,
    workflowVersionId: row.workflow_version_id
  }));

  return {
    backfillJobs,
    dependencies,
    summary: summarizeWorkflowDependencyOperations({
      backfillJobs,
      dependencies
    }),
    suggestedMaintenanceRequests: suggestWorkflowMaintenanceRequests({
      backfillJobs,
      workflowId,
      workspaceId
    }),
    workflowId
  };
}

export async function requestWorkflowBackfillJobDisposition(
  db: D1Database,
  input: {
    disposition: "abandoned" | "superseded";
    jobId: string;
    operatorPrincipalId: string;
    reason: string;
    supersededByJobId?: string | null;
    workflowId: string;
    workspaceId: string;
  }
): Promise<
  | {
      jobId: string;
      ok: true;
      operatorReason: string;
      status: "abandoned" | "superseded";
      supersededByJobId: string | null;
      workflowId: string;
    }
  | {
      message: string;
      ok: false;
      reason: "backfill_job_not_found" | "backfill_job_terminal" | "invalid_supersede_target";
    }
> {
  if (input.disposition === "superseded" && !input.supersededByJobId) {
    return {
      message: "supersededByJobId is required when superseding a backfill job.",
      ok: false,
      reason: "invalid_supersede_target"
    };
  }

  const row = await db
    .prepare(
      `SELECT status
       FROM workflow_backfill_jobs
       WHERE id = ? AND workspace_id = ? AND workflow_id = ?`
    )
    .bind(input.jobId, input.workspaceId, input.workflowId)
    .first<{ status: string }>();

  if (!row) {
    return {
      message: `Workflow backfill job ${input.jobId} was not found.`,
      ok: false,
      reason: "backfill_job_not_found"
    };
  }

  if (TERMINAL_BACKFILL_STATUSES.has(row.status)) {
    return {
      message: `Workflow backfill job ${input.jobId} is already terminal with status ${row.status}.`,
      ok: false,
      reason: "backfill_job_terminal"
    };
  }

  if (input.disposition === "superseded") {
    const supersedingJob = await db
      .prepare(
        `SELECT id
         FROM workflow_backfill_jobs
         WHERE id = ? AND workspace_id = ? AND workflow_id = ?`
      )
      .bind(input.supersededByJobId, input.workspaceId, input.workflowId)
      .first<{ id: string }>();
    if (!supersedingJob || input.supersededByJobId === input.jobId) {
      return {
        message: `Superseding workflow backfill job ${input.supersededByJobId} was not found.`,
        ok: false,
        reason: "invalid_supersede_target"
      };
    }
  }

  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = ?,
             cursor_json = NULL,
             last_error = NULL,
             operator_reason = ?,
             operator_actor_principal_id = ?,
             operator_transition_at = ?,
             superseded_by_job_id = ?,
             updated_at = ?
         WHERE id = ? AND workspace_id = ? AND workflow_id = ?`
      )
      .bind(
        input.disposition,
        input.reason,
        input.operatorPrincipalId,
        now,
        input.supersededByJobId ?? null,
        now,
        input.jobId,
        input.workspaceId,
        input.workflowId
      )
  ]);

  return {
    jobId: input.jobId,
    ok: true,
    operatorReason: input.reason,
    status: input.disposition,
    supersededByJobId: input.supersededByJobId ?? null,
    workflowId: input.workflowId
  };
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
