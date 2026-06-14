import type { EventLedgerRecord } from "../core/events/types";
import { cloneCommandResult } from "../core/commands/transcript";
import type { FieldTypeRegistry, JsonValue } from "../core/field-types/types";
import { createCloudTableD1Repository } from "../core/persistence/cloudtable-d1-repository";
import type { EffectivePermissionSnapshot } from "../core/permissions/types";
import {
  executeWorkflowDefinition,
  matchWorkflowTrigger,
  resolveWorkflowInput
} from "../core/workflows/execution";
import { requireWorkflowServiceIdentityMetadata } from "../core/workflows/service-identity";
import type {
  WorkflowActionBinding,
  WorkflowActionDefinition,
  WorkflowActionExecution,
  WorkflowConditionBinding,
  WorkflowAggregateDefinition,
  WorkflowDefinition,
  WorkflowExecutionResult,
  WorkflowExecutionScope,
  WorkflowFieldValue,
  WorkflowLookupDefinition,
  WorkflowRelatedTableResolver
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
  status?: "draft" | "published" | "paused";
  workflow_id: string;
  workflow_version_id: string;
  workspace_id: string;
};

type WorkflowTestPreviewStatus = "ready" | "rejected";

type WorkflowTestPreview = {
  actions: Array<{
    command?: Record<string, unknown>;
    diagnostics: string[];
    operatorId: string;
    plan: Record<string, unknown>;
    resolvedInput: Record<string, unknown>;
    result?: Record<string, unknown>;
    skipped?: string;
    wouldRun: boolean;
  }>;
  conditions: Array<{
    operatorId: string;
    passed: boolean;
    resolvedInput: Record<string, unknown>;
  }>;
  diagnostics: string[];
  message?: string;
  reason?: string;
  scope?: Record<string, unknown>;
  status: WorkflowTestPreviewStatus;
  trigger: Record<string, unknown>;
  workflowId: string;
  workflowStatus?: "draft" | "published" | "paused";
  workflowVersionId: string | null;
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

function assertReactiveMaintenanceWorkflowServiceIdentity(
  definition: PersistedWorkflowDefinition,
  version: Pick<WorkflowVersionRow, "workflow_id" | "workflow_version_id">
): void {
  requireWorkflowServiceIdentityMetadata(definition, {
    workflowId: version.workflow_id,
    workflowVersionId: version.workflow_version_id
  });
}

function readWorkflowRelatedTableResolvers(
  definition: PersistedWorkflowDefinition
): WorkflowRelatedTableResolver[] {
  const resolvers = definition.metadata?.relatedTableResolvers;
  return Array.isArray(resolvers) ? [...resolvers] : [];
}

function readWorkflowAggregateDefinitions(
  definition: PersistedWorkflowDefinition
): WorkflowAggregateDefinition[] {
  const aggregateDefinitions = definition.metadata?.aggregateDefinitions;
  return Array.isArray(aggregateDefinitions) ? [...aggregateDefinitions] : [];
}

function readWorkflowLookupDefinitions(
  definition: PersistedWorkflowDefinition
): WorkflowLookupDefinition[] {
  const lookupDefinitions = definition.metadata?.lookupDefinitions;
  return Array.isArray(lookupDefinitions) ? [...lookupDefinitions] : [];
}

type AggregateTriggerKind = "backfill" | "recompute";

type AggregateTriggerPayload =
  | {
      kind: "backfill";
      reason: string;
    }
  | {
      changedFieldIds: string[];
      eventId: string | null;
      eventType: string | null;
      kind: "recompute";
      recordId: string | null;
    };

type RoutedAggregateDefinition = {
  alias: string;
  dependencyFieldIds: string[];
  groupingSource: {
    kind: "related_record";
    resolverAlias: string;
    sourceFieldId: string;
  };
  operand?: {
    fieldId: string;
    kind: "source_field";
    valueType: "number";
  };
  operationConfig: Record<string, JsonValue>;
  operationId: string;
  resolver: WorkflowRelatedTableResolver;
  sourceRelationPath: string;
  sourceTableId: string;
  targetFieldId: string;
  targetTableId: string;
};

type RoutedLookupDefinition = {
  alias: string;
  dependencyFieldIds: string[];
  lookupSource: {
    kind: "related_record";
    resolverAlias: string;
    sourceFieldId: string;
  };
  resolver: Extract<WorkflowRelatedTableResolver, { strategy: "single_relation" }>;
  sourceRelationPath: string;
  sourceTableId: string;
  targetFieldId: string;
  valueFieldId: string;
};

type RoutedSyncDefinition = {
  alias: string;
  dependencyFieldIds: string[];
  resolver: WorkflowRelatedTableResolver;
  sourceFieldId: string;
  sourceTableId: string;
  targetFieldId: string;
  targetTableId: string;
};

function deriveAggregateDefinitions(
  definition: PersistedWorkflowDefinition
): RoutedAggregateDefinition[] {
  const sourceTableId =
    typeof definition.metadata?.tableId === "string" ? definition.metadata.tableId : null;
  if (!sourceTableId) {
    return [];
  }

  const resolvers = new Map(
    readWorkflowRelatedTableResolvers(definition).map((resolver) => [resolver.alias, resolver])
  );

  return readWorkflowAggregateDefinitions(definition)
    .map((aggregate) => {
      const resolver = resolvers.get(aggregate.groupingSource.resolverAlias);
      if (!resolver) {
        return null;
      }

      return {
        alias: aggregate.alias,
        dependencyFieldIds: Array.from(
          new Set([
            resolver.sourceFieldId,
            ...(aggregate.operand ? [aggregate.operand.fieldId] : []),
            ...(aggregate.dependencyFieldIds ?? [])
          ])
        ),
        groupingSource: {
          kind: "related_record" as const,
          resolverAlias: aggregate.groupingSource.resolverAlias,
          sourceFieldId: resolver.sourceFieldId
        },
        ...(aggregate.operand ? { operand: aggregate.operand } : {}),
        operationConfig:
          aggregate.operationConfig && isRecord(aggregate.operationConfig)
            ? aggregate.operationConfig
            : {},
        operationId: aggregate.operationId,
        resolver,
        sourceRelationPath: aggregate.sourceRelationPath,
        sourceTableId,
        targetFieldId: aggregate.targetFieldId,
        targetTableId: resolver.targetTableId
      };
    })
    .filter((aggregate): aggregate is RoutedAggregateDefinition => aggregate !== null);
}

function deriveLookupDefinitions(
  definition: PersistedWorkflowDefinition
): RoutedLookupDefinition[] {
  const sourceTableId =
    typeof definition.metadata?.tableId === "string" ? definition.metadata.tableId : null;
  if (!sourceTableId) {
    return [];
  }

  const resolvers = new Map(
    readWorkflowRelatedTableResolvers(definition).map((resolver) => [resolver.alias, resolver])
  );

  return readWorkflowLookupDefinitions(definition)
    .map((lookup) => {
      const resolver = resolvers.get(lookup.lookupSource.resolverAlias);
      if (!resolver || resolver.strategy !== "single_relation") {
        return null;
      }

      return {
        alias: lookup.alias,
        dependencyFieldIds: Array.from(
          new Set([resolver.sourceFieldId, ...(lookup.dependencyFieldIds ?? [])])
        ),
        lookupSource: {
          kind: "related_record" as const,
          resolverAlias: lookup.lookupSource.resolverAlias,
          sourceFieldId: resolver.sourceFieldId
        },
        resolver,
        sourceRelationPath: lookup.sourceRelationPath,
        sourceTableId,
        targetFieldId: lookup.targetFieldId,
        valueFieldId: lookup.valueFieldId
      };
    })
    .filter((lookup): lookup is RoutedLookupDefinition => lookup !== null);
}

function workflowSyncAlias(input: {
  resolverAlias: string;
  sourceFieldId: string;
  targetFieldId: string;
}): string {
  return `${input.resolverAlias}:${input.sourceFieldId}:${input.targetFieldId}`;
}

function deriveSyncDefinitions(
  definition: PersistedWorkflowDefinition
): RoutedSyncDefinition[] {
  const sourceTableId =
    typeof definition.metadata?.tableId === "string" ? definition.metadata.tableId : null;
  if (!sourceTableId) {
    return [];
  }

  const resolvers = new Map(
    readWorkflowRelatedTableResolvers(definition).map((resolver) => [resolver.alias, resolver])
  );

  return definition.actions
    .map((action) => {
      if (action.operatorId !== "sync_related_field") {
        return null;
      }

      const input = isRecord(action.input) ? action.input : null;
      const resolverAlias =
        input && typeof input.resolverAlias === "string" ? input.resolverAlias : null;
      const sourceFieldId =
        input && typeof input.sourceFieldId === "string" ? input.sourceFieldId : null;
      const targetFieldId =
        input && typeof input.targetFieldId === "string" ? input.targetFieldId : null;

      if (!resolverAlias || !sourceFieldId || !targetFieldId) {
        return null;
      }

      const resolver = resolvers.get(resolverAlias);
      if (!resolver) {
        return null;
      }

      return {
        alias: workflowSyncAlias({
          resolverAlias,
          sourceFieldId,
          targetFieldId
        }),
        dependencyFieldIds: Array.from(new Set([resolver.sourceFieldId, sourceFieldId])),
        resolver,
        sourceFieldId,
        sourceTableId,
        targetFieldId,
        targetTableId: resolver.targetTableId
      };
    })
    .filter((sync): sync is RoutedSyncDefinition => sync !== null);
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

function workflowScalarMatchKey(value: unknown): string | null {
  if (typeof value === "string") {
    return `string:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number:${String(value)}`;
  }
  if (typeof value === "boolean") {
    return `boolean:${value ? "true" : "false"}`;
  }

  return null;
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

function readChangedFieldIds(payload: Record<string, unknown>): string[] {
  const changedFieldIds = new Set<string>();

  if (typeof payload.fieldId === "string" && payload.fieldId.length > 0) {
    changedFieldIds.add(payload.fieldId);
  }

  const addObjectKeys = (value: unknown) => {
    if (!isRecord(value)) {
      return;
    }

    for (const key of Object.keys(value)) {
      if (key.length > 0) {
        changedFieldIds.add(key);
      }
    }
  };

  addObjectKeys(payload.cells);
  addObjectKeys(payload.patch);

  if (Array.isArray(payload.fieldIds)) {
    for (const fieldId of payload.fieldIds) {
      if (typeof fieldId === "string" && fieldId.length > 0) {
        changedFieldIds.add(fieldId);
      }
    }
  }

  return [...changedFieldIds];
}

function shouldRouteAggregateForEvent(
  aggregate: RoutedAggregateDefinition,
  event: EventLedgerRecord
): boolean {
  if (event.tableId !== aggregate.sourceTableId) {
    return false;
  }

  const changedFieldIds = readChangedFieldIds(event.payload);
  if (changedFieldIds.length === 0) {
    return true;
  }

  return aggregate.dependencyFieldIds.some((fieldId) => changedFieldIds.includes(fieldId));
}

function shouldRouteLookupForEvent(
  lookup: RoutedLookupDefinition,
  event: EventLedgerRecord
): boolean {
  if (event.tableId !== lookup.sourceTableId) {
    return false;
  }

  const changedFieldIds = readChangedFieldIds(event.payload);
  if (changedFieldIds.length === 0) {
    return true;
  }

  return lookup.dependencyFieldIds.some((fieldId) => changedFieldIds.includes(fieldId));
}

async function enqueueAggregateMaintenanceMessage(
  env: CloudTableEnv,
  input: {
    aggregate: RoutedAggregateDefinition;
    eventId?: string;
    trigger: AggregateTriggerPayload;
    workspaceId: string;
    workflowId: string;
    workflowVersionId: string;
  }
): Promise<void> {
  const { aggregate, eventId, trigger, workflowId, workflowVersionId, workspaceId } = input;

  await env.AGGREGATE_MAINTENANCE_QUEUE.send({
    kind: "aggregate-maintenance",
    ...(eventId ? { eventId } : {}),
    payload: {
      aggregate,
      trigger,
      workflowId,
      workflowVersionId
    },
    workspaceId
  });
}

async function enqueueLookupMaintenanceMessage(
  env: CloudTableEnv,
  input: {
    eventId?: string;
    lookup: RoutedLookupDefinition;
    trigger: AggregateTriggerPayload;
    workspaceId: string;
    workflowId: string;
    workflowVersionId: string;
  }
): Promise<void> {
  const { eventId, lookup, trigger, workflowId, workflowVersionId, workspaceId } = input;

  await env.AGGREGATE_MAINTENANCE_QUEUE.send({
    kind: "aggregate-maintenance",
    ...(eventId ? { eventId } : {}),
    payload: {
      lookup,
      trigger,
      workflowId,
      workflowVersionId
    },
    workspaceId
  });
}

async function enqueueSyncMaintenanceMessage(
  env: CloudTableEnv,
  input: {
    eventId?: string;
    sync: RoutedSyncDefinition;
    trigger: AggregateTriggerPayload;
    workspaceId: string;
    workflowId: string;
    workflowVersionId: string;
  }
): Promise<void> {
  const { eventId, sync, trigger, workflowId, workflowVersionId, workspaceId } = input;

  await env.AGGREGATE_MAINTENANCE_QUEUE.send({
    kind: "aggregate-maintenance",
    ...(eventId ? { eventId } : {}),
    payload: {
      sync,
      trigger,
      workflowId,
      workflowVersionId
    },
    workspaceId
  });
}

export async function requestManualAggregateMaintenance(
  env: CloudTableEnv,
  input: {
    aggregateAliases?: string[];
    changedFieldIds?: string[];
    kind: AggregateTriggerKind;
    principalId: string;
    reason?: string;
    recordId?: string | null;
    requestId: string;
    workflowId: string;
    workspaceId: string;
  }
): Promise<
  | {
      aggregateAliases: string[];
      ok: true;
      status: "enqueued";
      workflowVersionId: string;
    }
  | {
      message: string;
      ok: false;
      reason:
        | "already_requested"
        | "aggregate_alias_not_found"
        | "aggregate_not_configured"
        | "workflow_service_identity_invalid"
        | "workflow_not_found"
        | "workflow_paused";
    }
> {
  const version = await loadPublishedWorkflowVersion(env.DB, input.workspaceId, input.workflowId);
  if (!version) {
    return {
      message: `Workflow ${input.workflowId} was not found.`,
      ok: false,
      reason: "workflow_not_found"
    };
  }

  const definition = parseWorkflowDefinition(version.definition_json);
  if (workflowStatus(definition) !== "published") {
    return {
      message: `Workflow ${input.workflowId} is paused and cannot accept aggregate maintenance requests.`,
      ok: false,
      reason: "workflow_paused"
    };
  }

  const aggregates = deriveAggregateDefinitions(definition);
  if (aggregates.length === 0) {
    return {
      message: `Workflow ${input.workflowId} does not define aggregate maintenance metadata.`,
      ok: false,
      reason: "aggregate_not_configured"
    };
  }

  try {
    assertReactiveMaintenanceWorkflowServiceIdentity(definition, version);
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : "Workflow service identity metadata is invalid.",
      ok: false,
      reason: "workflow_service_identity_invalid"
    };
  }

  const aggregateByAlias = new Map(aggregates.map((aggregate) => [aggregate.alias, aggregate] as const));
  const requestedAliases =
    input.aggregateAliases && input.aggregateAliases.length > 0
      ? Array.from(new Set(input.aggregateAliases))
      : aggregates.map((aggregate) => aggregate.alias);
  const missingAlias = requestedAliases.find((alias) => !aggregateByAlias.has(alias));
  if (missingAlias) {
    return {
      message: `Workflow ${input.workflowId} does not define aggregate alias ${missingAlias}.`,
      ok: false,
      reason: "aggregate_alias_not_found"
    };
  }

  const scopeKey = `workflow.aggregate-maintenance:${input.workspaceId}:${input.workflowId}`;
  const existingReceipt = await env.DB
    .prepare(
      `SELECT id
       FROM idempotency_receipts
       WHERE scope_key = ? AND idempotency_key = ?`
    )
    .bind(scopeKey, input.requestId)
    .first<{ id: string }>();
  if (existingReceipt) {
    return {
      message: `Aggregate maintenance request ${input.requestId} was already accepted for workflow ${input.workflowId}.`,
      ok: false,
      reason: "already_requested"
    };
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO idempotency_receipts (
         id,
         scope_key,
         idempotency_key,
         command_id,
         receipt_json,
         created_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `idem:workflow.aggregate-maintenance:${input.workflowId}:${input.requestId}`,
      scopeKey,
      input.requestId,
      `workflow.aggregate-maintenance:${input.workflowId}:${input.requestId}`,
      JSON.stringify({
        aggregateAliases: requestedAliases,
        kind: input.kind,
        requestedAt: now,
        requestedBy: input.principalId,
        workflowId: input.workflowId
      }),
      now,
      null
    )
  ]);

  const trigger: AggregateTriggerPayload =
    input.kind === "backfill"
      ? {
          kind: "backfill",
          reason: input.reason ?? "manual"
        }
      : {
          changedFieldIds: input.changedFieldIds ?? [],
          eventId: `manual-aggregate-recompute:${input.requestId}`,
          eventType: "workflow.aggregate.manual_recompute",
          kind: "recompute",
          recordId: input.recordId ?? null
        };

  for (const alias of requestedAliases) {
    await enqueueAggregateMaintenanceMessage(env, {
      aggregate: aggregateByAlias.get(alias)!,
      eventId: trigger.kind === "recompute" ? trigger.eventId ?? undefined : undefined,
      trigger,
      workflowId: version.workflow_id,
      workflowVersionId: version.workflow_version_id,
      workspaceId: input.workspaceId
    });
  }

  return {
    aggregateAliases: requestedAliases,
    ok: true,
    status: "enqueued",
    workflowVersionId: version.workflow_version_id
  };
}

export async function requestManualSyncMaintenance(
  env: CloudTableEnv,
  input: {
    changedFieldIds?: string[];
    kind: AggregateTriggerKind;
    principalId: string;
    reason?: string;
    recordId?: string | null;
    requestId: string;
    syncAliases?: string[];
    workflowId: string;
    workspaceId: string;
  }
): Promise<
  | {
      ok: true;
      status: "enqueued";
      syncAliases: string[];
      workflowVersionId: string;
    }
  | {
      message: string;
      ok: false;
      reason:
        | "already_requested"
        | "sync_alias_not_found"
        | "sync_not_configured"
        | "workflow_service_identity_invalid"
        | "workflow_not_found"
        | "workflow_paused";
    }
> {
  const version = await loadPublishedWorkflowVersion(env.DB, input.workspaceId, input.workflowId);
  if (!version) {
    return {
      message: `Workflow ${input.workflowId} was not found.`,
      ok: false,
      reason: "workflow_not_found"
    };
  }

  const definition = parseWorkflowDefinition(version.definition_json);
  if (workflowStatus(definition) !== "published") {
    return {
      message: `Workflow ${input.workflowId} is paused and cannot accept sync maintenance requests.`,
      ok: false,
      reason: "workflow_paused"
    };
  }

  const syncDefinitions = deriveSyncDefinitions(definition);
  if (syncDefinitions.length === 0) {
    return {
      message: `Workflow ${input.workflowId} does not define sync maintenance metadata.`,
      ok: false,
      reason: "sync_not_configured"
    };
  }

  try {
    assertReactiveMaintenanceWorkflowServiceIdentity(definition, version);
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : "Workflow service identity metadata is invalid.",
      ok: false,
      reason: "workflow_service_identity_invalid"
    };
  }

  const syncByAlias = new Map(syncDefinitions.map((sync) => [sync.alias, sync] as const));
  const requestedAliases =
    input.syncAliases && input.syncAliases.length > 0
      ? Array.from(new Set(input.syncAliases))
      : syncDefinitions.map((sync) => sync.alias);
  const missingAlias = requestedAliases.find((alias) => !syncByAlias.has(alias));
  if (missingAlias) {
    return {
      message: `Workflow ${input.workflowId} does not define sync alias ${missingAlias}.`,
      ok: false,
      reason: "sync_alias_not_found"
    };
  }

  const scopeKey = `workflow.sync-maintenance:${input.workspaceId}:${input.workflowId}`;
  const existingReceipt = await env.DB
    .prepare(
      `SELECT id
       FROM idempotency_receipts
       WHERE scope_key = ? AND idempotency_key = ?`
    )
    .bind(scopeKey, input.requestId)
    .first<{ id: string }>();
  if (existingReceipt) {
    return {
      message: `Sync maintenance request ${input.requestId} was already accepted for workflow ${input.workflowId}.`,
      ok: false,
      reason: "already_requested"
    };
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO idempotency_receipts (
         id,
         scope_key,
         idempotency_key,
         command_id,
         receipt_json,
         created_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      `idem:workflow.sync-maintenance:${input.workflowId}:${input.requestId}`,
      scopeKey,
      input.requestId,
      `workflow.sync-maintenance:${input.workflowId}:${input.requestId}`,
      JSON.stringify({
        kind: input.kind,
        requestedAt: now,
        requestedBy: input.principalId,
        syncAliases: requestedAliases,
        workflowId: input.workflowId
      }),
      now,
      null
    )
  ]);

  const trigger: AggregateTriggerPayload =
    input.kind === "backfill"
      ? {
          kind: "backfill",
          reason: input.reason ?? "manual"
        }
      : {
          changedFieldIds: input.changedFieldIds ?? [],
          eventId: `manual-sync-recompute:${input.requestId}`,
          eventType: "workflow.sync.manual_recompute",
          kind: "recompute",
          recordId: input.recordId ?? null
        };

  for (const alias of requestedAliases) {
    await enqueueSyncMaintenanceMessage(env, {
      eventId: trigger.kind === "recompute" ? trigger.eventId ?? undefined : undefined,
      sync: syncByAlias.get(alias)!,
      trigger,
      workflowId: version.workflow_id,
      workflowVersionId: version.workflow_version_id,
      workspaceId: input.workspaceId
    });
  }

  return {
    ok: true,
    status: "enqueued",
    syncAliases: requestedAliases,
    workflowVersionId: version.workflow_version_id
  };
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

async function loadPublishedWorkflowVersion(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<WorkflowVersionRow | null> {
  return db
    .prepare(
      `SELECT
         workflow_versions.workspace_id AS workspace_id,
         workflow_versions.id AS workflow_version_id,
         workflow_versions.workflow_id AS workflow_id,
         workflow_versions.definition_json AS definition_json
       FROM workflow_versions
       INNER JOIN workflows
         ON workflows.workspace_id = workflow_versions.workspace_id
        AND workflows.id = workflow_versions.workflow_id
       WHERE workflow_versions.workspace_id = ?
         AND workflow_versions.workflow_id = ?
         AND workflow_versions.published_at IS NOT NULL
         AND workflows.archived_at IS NULL
       ORDER BY workflow_versions.version DESC
       LIMIT 1`
    )
    .bind(workspaceId, workflowId)
    .first<WorkflowVersionRow>();
}

async function loadCurrentWorkflowVersion(
  db: D1Database,
  workspaceId: string,
  workflowId: string
): Promise<WorkflowVersionRow | null> {
  return db
    .prepare(
      `SELECT
         workflow_versions.workspace_id AS workspace_id,
         workflow_versions.id AS workflow_version_id,
         workflow_versions.workflow_id AS workflow_id,
         workflow_versions.definition_json AS definition_json,
         CASE
           WHEN json_extract(workflow_versions.definition_json, '$.metadata.status') IN ('draft', 'published', 'paused')
             THEN json_extract(workflow_versions.definition_json, '$.metadata.status')
           ELSE 'published'
         END AS status
       FROM workflow_versions
       INNER JOIN workflows
         ON workflows.workspace_id = workflow_versions.workspace_id
        AND workflows.id = workflow_versions.workflow_id
        AND workflows.current_version = workflow_versions.version
       WHERE workflow_versions.workspace_id = ?
         AND workflow_versions.workflow_id = ?
         AND workflows.archived_at IS NULL
       LIMIT 1`
    )
    .bind(workspaceId, workflowId)
    .first<WorkflowVersionRow>();
}

function resolvePreviewTriggerFieldIds(workflow: WorkflowDefinition): string[] {
  if (Array.isArray(workflow.trigger.match?.fieldIds)) {
    return workflow.trigger.match.fieldIds.filter(
      (fieldId): fieldId is string => typeof fieldId === "string" && fieldId.length > 0
    );
  }

  if (
    typeof workflow.trigger.match?.fieldId === "string" &&
    workflow.trigger.match.fieldId.length > 0
  ) {
    return [workflow.trigger.match.fieldId];
  }

  return [];
}

function serializeWorkflowFieldContext(
  runtime: CloudTableRuntime,
  row: NonNullable<WorkflowExecutionScope["row"]> | undefined,
  snapshot: NonNullable<EffectivePermissionSnapshot | undefined>
): Record<string, unknown> | null {
  if (!row) {
    return null;
  }

  const fieldEntries = Object.entries(row.fields);
  const projection = runtime.permissionEngine.projectFields(
    fieldEntries.map(([_, field]) => ({
      fieldId: field.fieldId,
      fieldType: field.fieldType ?? "",
      value: field.value
    })),
    "workflow-step",
    snapshot
  );

  return {
    diagnostics: projection.diagnostics,
    fields: fieldEntries.map(([fieldKey, field]) => ({
      fieldId: field.fieldId,
      fieldKey,
      fieldType: field.fieldType ?? "",
      readState: projection.states[field.fieldId] ?? "visible",
      value: Object.prototype.hasOwnProperty.call(projection.fields, field.fieldId)
        ? projection.fields[field.fieldId]
        : null
    })),
    hiddenFieldIds: projection.hiddenFieldIds,
    recordId: row.recordId,
    redactedFieldIds: projection.redactedFieldIds
  };
}

function summarizeWorkflowActionPlan(
  definition: PersistedWorkflowDefinition,
  action: WorkflowActionBinding,
  resolvedInput: Record<string, unknown>,
  scope: WorkflowExecutionScope
): Record<string, unknown> {
  if (action.operatorId === "sync_related_field") {
    const resolverAlias =
      typeof resolvedInput.resolverAlias === "string" ? resolvedInput.resolverAlias : null;
    const sourceFieldId =
      typeof resolvedInput.sourceFieldId === "string" ? resolvedInput.sourceFieldId : null;
    const targetFieldId =
      typeof resolvedInput.targetFieldId === "string" ? resolvedInput.targetFieldId : null;
    const sync = deriveSyncDefinitions(definition).find(
      (candidate) =>
        candidate.alias ===
        workflowSyncAlias({
          resolverAlias: resolverAlias ?? "",
          sourceFieldId: sourceFieldId ?? "",
          targetFieldId: targetFieldId ?? ""
        })
    );

    return {
      alias: sync?.alias ?? null,
      kind: "sync_related_field",
      resolverAlias,
      sourceFieldId,
      sourceRecordId: scope.row?.recordId ?? null,
      targetFieldId,
      targetRecordIds:
        resolverAlias && scope.relatedTables?.[resolverAlias]
          ? scope.relatedTables[resolverAlias].recordIds ?? []
          : []
    };
  }

  if (action.operatorId === "set_cell") {
    const targetFieldId =
      typeof resolvedInput.fieldId === "string" ? resolvedInput.fieldId : null;
    const aggregate = deriveAggregateDefinitions(definition).find(
      (candidate) => candidate.targetFieldId === targetFieldId
    );

    return {
      aggregateAlias: aggregate?.alias ?? null,
      kind: aggregate ? "reactive_rollup" : "command",
      operationId: aggregate?.operationId ?? null,
      targetFieldId,
      targetRecordId:
        typeof resolvedInput.recordId === "string" ? resolvedInput.recordId : null,
      targetTableId:
        typeof resolvedInput.tableId === "string" ? resolvedInput.tableId : null
    };
  }

  return {
    kind: "command",
    operatorId: action.operatorId
  };
}

function rejectedWorkflowTestPreview(
  input: {
    diagnostics?: string[];
    message: string;
    reason: string;
    trigger?: Record<string, unknown>;
    workflowId: string;
    workflowStatus?: "draft" | "published" | "paused";
    workflowVersionId?: string | null;
  }
): WorkflowTestPreview {
  return {
    actions: [],
    conditions: [],
    diagnostics: input.diagnostics ?? [],
    message: input.message,
    reason: input.reason,
    status: "rejected",
    trigger: input.trigger ?? {},
    workflowId: input.workflowId,
    workflowStatus: input.workflowStatus,
    workflowVersionId: input.workflowVersionId ?? null
  };
}

export async function previewWorkflowTestRun(
  env: CloudTableEnv,
  input: {
    recordId: string;
    selectedFieldId?: string;
    workflowId: string;
    workspaceId: string;
  }
): Promise<WorkflowTestPreview> {
  const version = await loadCurrentWorkflowVersion(env.DB, input.workspaceId, input.workflowId);
  if (!version) {
    return rejectedWorkflowTestPreview({
      message: `Workflow ${input.workflowId} was not found.`,
      reason: "workflow_not_found",
      workflowId: input.workflowId
    });
  }

  let definition: PersistedWorkflowDefinition;
  try {
    definition = parseWorkflowDefinition(version.definition_json);
  } catch {
    return rejectedWorkflowTestPreview({
      message: `Workflow ${input.workflowId} version ${version.workflow_version_id} has malformed definition JSON.`,
      reason: "workflow_definition_invalid",
      workflowId: input.workflowId,
      workflowStatus: version.status,
      workflowVersionId: version.workflow_version_id
    });
  }

  let workflowIdentity;
  try {
    workflowIdentity = requireWorkflowServiceIdentityMetadata(definition, {
      workflowId: input.workflowId,
      workflowVersionId: version.workflow_version_id
    });
  } catch (error) {
    return rejectedWorkflowTestPreview({
      message: error instanceof Error ? error.message : "Workflow service identity metadata is invalid.",
      reason: "workflow_service_identity_invalid",
      workflowId: input.workflowId,
      workflowStatus: workflowStatus(definition),
      workflowVersionId: version.workflow_version_id
    });
  }

  const workflowSnapshot =
    (await readLatestPermissionSnapshotForScope(env.DB, {
      permissionScopeHash: workflowIdentity.scopeHash,
      principalId: workflowIdentity.principalId,
      workspaceId: input.workspaceId
    })) ??
    (await readPermissionSnapshot(env.DB, {
      permissionScopeHash: workflowIdentity.scopeHash,
      policyRevision: workflowIdentity.policyRevision,
      principalId: workflowIdentity.principalId,
      workspaceId: input.workspaceId
    }));
  if (!workflowSnapshot) {
    return rejectedWorkflowTestPreview({
      message: `Workflow ${input.workflowId} could not resolve a permission snapshot for service identity ${workflowIdentity.principalId}.`,
      reason: "workflow_permission_snapshot_unresolved",
      workflowId: input.workflowId,
      workflowStatus: workflowStatus(definition),
      workflowVersionId: version.workflow_version_id
    });
  }

  const runtime = createRuntimeWithSnapshot(env, workflowSnapshot);
  const workflow = {
    ...definition,
    principal: {
      policyRevision: workflowSnapshot.policyRevision,
      principalId: workflowSnapshot.principalId,
      schemaEpoch: workflowSnapshot.schemaEpoch,
      scopeHash: workflowSnapshot.scopeHash
    }
  } satisfies WorkflowDefinition;
  const triggerOperator = runtime.workflowOperatorRegistry.require(workflow.trigger.operatorId);
  if (triggerOperator.kind !== "trigger") {
    return rejectedWorkflowTestPreview({
      message: `Workflow ${input.workflowId} trigger ${workflow.trigger.operatorId} is invalid.`,
      reason: "workflow_trigger_invalid",
      workflowId: input.workflowId,
      workflowStatus: workflowStatus(definition),
      workflowVersionId: version.workflow_version_id
    });
  }

  const triggerTableId =
    typeof workflow.trigger.match?.tableId === "string" ? workflow.trigger.match.tableId : null;
  if (!triggerTableId) {
    return rejectedWorkflowTestPreview({
      message: `Workflow ${input.workflowId} does not define a trigger table for selected-record preview.`,
      reason: "workflow_trigger_table_missing",
      workflowId: input.workflowId,
      workflowStatus: workflowStatus(definition),
      workflowVersionId: version.workflow_version_id
    });
  }

  const triggerFieldIds = resolvePreviewTriggerFieldIds(workflow);
  if (
    input.selectedFieldId &&
    triggerFieldIds.length > 0 &&
    !triggerFieldIds.includes(input.selectedFieldId)
  ) {
    return rejectedWorkflowTestPreview({
      message: `Field ${input.selectedFieldId} is not part of workflow ${input.workflowId}'s reactive trigger set.`,
      reason: "selected_field_not_triggerable",
      trigger: {
        selectedFieldId: input.selectedFieldId,
        triggerFieldIds
      },
      workflowId: input.workflowId,
      workflowStatus: workflowStatus(definition),
      workflowVersionId: version.workflow_version_id
    });
  }

  const row = await loadRecordContext(
    env.DB,
    runtime.fieldTypeRegistry,
    input.workspaceId,
    triggerTableId,
    input.recordId
  );
  if (!row) {
    return rejectedWorkflowTestPreview({
      message: `Record ${input.recordId} was not found on trigger table ${triggerTableId}.`,
      reason: "record_not_found",
      trigger: {
        recordId: input.recordId,
        tableId: triggerTableId
      },
      workflowId: input.workflowId,
      workflowStatus: workflowStatus(definition),
      workflowVersionId: version.workflow_version_id
    });
  }

  const selectedFieldId = input.selectedFieldId ?? triggerFieldIds[0] ?? null;
  const selectedField = selectedFieldId
    ? Object.values(row.fields).find((field) => field.fieldId === selectedFieldId)
    : undefined;
  const eventType = triggerOperator.triggerEventTypes[0] ?? "workflow.preview";
  const previewEvent: EventLedgerRecord = {
    commandId: `cmd:workflow-test-preview:${version.workflow_version_id}:${input.recordId}`,
    commandType: "workflow.preview",
    createdAt: new Date(0).toISOString(),
    eventId: `evt:workflow-test-preview:${version.workflow_version_id}:${input.recordId}`,
    eventType,
    metadata: {
      actor: {
        mode: "workflow",
        principalId: workflowSnapshot.principalId
      },
      permissionScopeHash: workflowSnapshot.scopeHash,
      permissionsVersion: workflowSnapshot.policyRevision,
      schemaEpoch: workflowSnapshot.schemaEpoch,
      selectedRecordPreview: true,
      scope: "workflow"
    },
    payload: {
      changedFieldIds: triggerFieldIds,
      ...(selectedFieldId ? { fieldId: selectedFieldId } : {}),
      ...(selectedField?.fieldType ? { fieldType: selectedField.fieldType } : {}),
      recordId: input.recordId
    },
    tableId: triggerTableId,
    workspaceId: input.workspaceId
  };

  const scope = await buildExecutionScope(
    env.DB,
    runtime.fieldTypeRegistry,
    workflow,
    `preview:${version.workflow_version_id}:${input.recordId}`,
    previewEvent
  );
  const execution = await executeWorkflowDefinition(
    workflow,
    scope,
    runtime.workflowOperatorRegistry,
    {
      execute(command) {
        return runtime.commandBus.dryRun(command);
      }
    }
  );

  const conditions = workflow.conditions.map((condition, index) => {
    const evaluated =
      execution.matchedTrigger && index < execution.conditionResults.length
        ? execution.conditionResults[index]
        : null;
    return {
      operatorId: condition.operatorId,
      passed: evaluated?.passed ?? false,
      resolvedInput:
        (evaluated?.resolvedInput as Record<string, unknown> | undefined) ??
        resolveWorkflowInput(condition.input, scope)
    };
  });

  const shouldRunActions =
    execution.matchedTrigger &&
    !("skippedReason" in execution && execution.skippedReason === "conditions_failed");
  const actions = workflow.actions.map((action, index) => {
    const resolvedInput = resolveWorkflowInput(action.input, scope);
    const executed =
      execution.matchedTrigger && index < execution.executedActions.length
        ? execution.executedActions[index]
        : null;

    return {
      ...(executed
        ? {
            command: executed.command as unknown as Record<string, unknown>,
            result: executed.result as unknown as Record<string, unknown>,
            ...(executed.skipped ? { skipped: executed.skipped } : {})
          }
        : {}),
      diagnostics: executed?.result.diagnostics ?? [],
      operatorId: action.operatorId,
      plan: summarizeWorkflowActionPlan(definition, action, resolvedInput, scope),
      resolvedInput,
      wouldRun: shouldRunActions && executed?.skipped !== "loop_guard"
    };
  });

  const rowContext = serializeWorkflowFieldContext(runtime, scope.row, workflowSnapshot);
  const relatedTables = Object.fromEntries(
    Object.entries(scope.relatedTables ?? {}).map(([alias, related]) => [
      alias,
      {
        recordIds: related.recordIds ?? [],
        row: serializeWorkflowFieldContext(runtime, related.row, workflowSnapshot),
        tableId: related.tableId
      }
    ])
  );
  const diagnostics = Array.from(
    new Set([
      ...(rowContext?.diagnostics as string[] | undefined ?? []),
      ...Object.values(relatedTables).flatMap((entry) =>
        Array.isArray((entry as { row?: { diagnostics?: string[] } }).row?.diagnostics)
          ? (entry as { row?: { diagnostics?: string[] } }).row?.diagnostics ?? []
          : []
      ),
      ...conditions.flatMap((condition) => (condition.passed ? [] : [`condition_failed:${condition.operatorId}`])),
      ...actions.flatMap((action) => action.diagnostics)
    ])
  );

  return {
    actions,
    conditions,
    diagnostics,
    scope: {
      relatedTables,
      row: rowContext
    },
    status: "ready",
    trigger: {
      eventType,
      matched: execution.matchedTrigger,
      recordId: input.recordId,
      selectedFieldId,
      tableId: triggerTableId,
      triggerFieldIds
    },
    workflowId: input.workflowId,
    workflowStatus: workflowStatus(definition),
    workflowVersionId: version.workflow_version_id
  };
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

  const runtime = createRuntime(env);
  const scope = await buildExecutionScope(
    env.DB,
    runtime.fieldTypeRegistry,
    definition,
    workflowRunId,
    event
  );
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
  fieldTypeRegistry: FieldTypeRegistry,
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

  const fields: Record<string, WorkflowFieldValue> = {};
  const canonicalBindings: Record<string, WorkflowFieldValue> = {};

  for (const cell of cells.results ?? []) {
    const parsed = JSON.parse(cell.value_json) as { raw?: unknown } | null;
    const fieldConfig = JSON.parse(cell.config_json) as JsonValue;
    const value: WorkflowFieldValue = {
      fieldId: cell.field_id,
      fieldType: cell.field_type,
      value: parsed?.raw
    };
    fields[cell.field_key] = value;

    const definition = fieldTypeRegistry.get(cell.field_type);
    if (!definition) {
      continue;
    }

    for (const alias of definition.getWorkflowBindingAliases({
      fieldConfig,
      fieldType: cell.field_type
    })) {
      if (alias.isCanonical !== true || !alias.binding.startsWith("row.")) {
        continue;
      }

      canonicalBindings[alias.binding.slice("row.".length)] = value;
    }
  }

  return {
    fields,
    ...canonicalBindings,
    recordId: record.record_id
  };
}

async function loadRelatedTableContexts(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  workspaceId: string,
  row: NonNullable<WorkflowExecutionScope["row"]>,
  resolvers: readonly WorkflowRelatedTableResolver[]
): Promise<WorkflowExecutionScope["relatedTables"]> {
  if (resolvers.length === 0) {
    return undefined;
  }

  const contexts: NonNullable<WorkflowExecutionScope["relatedTables"]> = {};
  const rowFields = Object.values(row.fields);

  for (const resolver of resolvers) {
    const sourceCell = rowFields.find((field) => field.fieldId === resolver.sourceFieldId);
    const relatedRecordIds =
      resolver.strategy === "single_relation"
        ? Array.isArray(sourceCell?.value)
          ? sourceCell.value.filter(
              (recordId): recordId is string =>
                typeof recordId === "string" && recordId.length > 0
            )
          : []
        : [];
    let matchedRecordIds: string[] = [];

    if (resolver.strategy === "value_match") {
      const matchKey = workflowScalarMatchKey(sourceCell?.value);
      if (matchKey) {
        const targetRows = await db
          .prepare(
            `SELECT
               records.id AS record_id,
               cell_current.value_json AS value_json
             FROM records
             LEFT JOIN cell_current
               ON cell_current.workspace_id = records.workspace_id
              AND cell_current.table_id = records.table_id
              AND cell_current.record_id = records.id
              AND cell_current.field_id = ?
             WHERE records.workspace_id = ?
               AND records.table_id = ?
               AND records.archived_at IS NULL
             ORDER BY records.id ASC`
          )
          .bind(resolver.targetFieldId, workspaceId, resolver.targetTableId)
          .all<{ record_id: string; value_json: string | null }>();

        matchedRecordIds = (targetRows.results ?? [])
          .filter((targetRow) => {
            const value = parseJsonRecord(targetRow.value_json).raw;
            return workflowScalarMatchKey(value) === matchKey;
          })
          .map((targetRow) => targetRow.record_id);
      }
    }

    const candidateRecordIds =
      resolver.strategy === "single_relation" ? relatedRecordIds : matchedRecordIds;
    const relatedRow =
      candidateRecordIds.length === 1
        ? await loadRecordContext(
            db,
            fieldTypeRegistry,
            workspaceId,
            resolver.targetTableId,
            candidateRecordIds[0]!
          )
        : undefined;

    contexts[resolver.alias] = {
      recordIds: candidateRecordIds,
      ...(relatedRow ? { row: relatedRow } : {}),
      tableId: resolver.targetTableId
    };
  }

  return Object.keys(contexts).length > 0 ? contexts : undefined;
}

async function buildExecutionScope(
  db: D1Database,
  fieldTypeRegistry: FieldTypeRegistry,
  workflow: PersistedWorkflowDefinition,
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
      ? await loadRecordContext(db, fieldTypeRegistry, event.workspaceId, tableId, recordId)
      : undefined;
  const relatedTables = row
    ? await loadRelatedTableContexts(
        db,
        fieldTypeRegistry,
        event.workspaceId,
        row,
        readWorkflowRelatedTableResolvers(workflow)
      )
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
    ...(relatedTables ? { relatedTables } : {}),
    ...(row ? { row } : {}),
    ...(tableId ? { table: { row, tableId } } : {}),
    workflow: {
      triggerEventId: event.eventId,
      workflowId: workflow.workflowId,
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
      runtime.fieldTypeRegistry,
      definition,
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
    runtime.fieldTypeRegistry,
    workflow,
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

  await routeAggregateMaintenanceFromEvent(env, message.workspaceId, eventId);
}

async function routeAggregateMaintenanceFromEvent(
  env: CloudTableEnv,
  workspaceId: string,
  eventId: string
): Promise<void> {
  const event = await loadEvent(env.DB, workspaceId, eventId);
  if (!event) {
    return;
  }

  if (event.eventType === "workflow.published") {
    await enqueueAggregateBackfillForPublishedWorkflow(env, event);
    await enqueueLookupBackfillForPublishedWorkflow(env, event);
    await enqueueSyncBackfillForPublishedWorkflow(env, event);
    return;
  }

  if (
    event.eventType !== "record.created" &&
    event.eventType !== "record.updated" &&
    event.eventType !== "record.archived" &&
    event.eventType !== "cell.set"
  ) {
    return;
  }

  const versions = await loadWorkflowVersions(env.DB, workspaceId);
  for (const version of versions) {
    const definition = parseWorkflowDefinition(version.definition_json);
    if (workflowStatus(definition) !== "published") {
      continue;
    }
    const aggregates = deriveAggregateDefinitions(definition);
    const lookups = deriveLookupDefinitions(definition);
    if (aggregates.length > 0 || lookups.length > 0) {
      assertReactiveMaintenanceWorkflowServiceIdentity(definition, version);
    }

    for (const aggregate of aggregates) {
      if (!shouldRouteAggregateForEvent(aggregate, event)) {
        continue;
      }

      await enqueueAggregateMaintenanceMessage(env, {
        aggregate,
        eventId: event.eventId,
        trigger: {
          changedFieldIds: readChangedFieldIds(event.payload),
          eventId: event.eventId,
          eventType: event.eventType,
          kind: "recompute",
          recordId: typeof event.payload.recordId === "string" ? event.payload.recordId : null
        },
        workflowId: version.workflow_id,
        workflowVersionId: version.workflow_version_id,
        workspaceId
      });
    }

    for (const lookup of lookups) {
      if (!shouldRouteLookupForEvent(lookup, event)) {
        continue;
      }

      await enqueueLookupMaintenanceMessage(env, {
        eventId: event.eventId,
        lookup,
        trigger: {
          changedFieldIds: readChangedFieldIds(event.payload),
          eventId: event.eventId,
          eventType: event.eventType,
          kind: "recompute",
          recordId: typeof event.payload.recordId === "string" ? event.payload.recordId : null
        },
        workflowId: version.workflow_id,
        workflowVersionId: version.workflow_version_id,
        workspaceId
      });
    }
  }
}

async function enqueueAggregateBackfillForPublishedWorkflow(
  env: CloudTableEnv,
  event: EventLedgerRecord
): Promise<void> {
  const workflowId =
    typeof event.payload.workflowId === "string" ? event.payload.workflowId : null;
  if (!workflowId) {
    return;
  }

  const version = await loadPublishedWorkflowVersion(env.DB, event.workspaceId, workflowId);
  if (!version) {
    return;
  }

  const definition = parseWorkflowDefinition(version.definition_json);
  if (workflowStatus(definition) !== "published") {
    return;
  }
  assertReactiveMaintenanceWorkflowServiceIdentity(definition, version);

  for (const aggregate of deriveAggregateDefinitions(definition)) {
    await enqueueAggregateMaintenanceMessage(env, {
      aggregate,
      eventId: event.eventId,
      trigger: {
        kind: "backfill",
        reason: "workflow_published"
      },
      workflowId: version.workflow_id,
      workflowVersionId: version.workflow_version_id,
      workspaceId: event.workspaceId
    });
  }
}

async function enqueueLookupBackfillForPublishedWorkflow(
  env: CloudTableEnv,
  event: EventLedgerRecord
): Promise<void> {
  const workflowId =
    typeof event.payload.workflowId === "string" ? event.payload.workflowId : null;
  if (!workflowId) {
    return;
  }

  const version = await loadPublishedWorkflowVersion(env.DB, event.workspaceId, workflowId);
  if (!version) {
    return;
  }

  const definition = parseWorkflowDefinition(version.definition_json);
  if (workflowStatus(definition) !== "published") {
    return;
  }
  assertReactiveMaintenanceWorkflowServiceIdentity(definition, version);

  for (const lookup of deriveLookupDefinitions(definition)) {
    await enqueueLookupMaintenanceMessage(env, {
      eventId: event.eventId,
      lookup,
      trigger: {
        kind: "backfill",
        reason: "workflow_published"
      },
      workflowId: version.workflow_id,
      workflowVersionId: version.workflow_version_id,
      workspaceId: event.workspaceId
    });
  }
}

async function enqueueSyncBackfillForPublishedWorkflow(
  env: CloudTableEnv,
  event: EventLedgerRecord
): Promise<void> {
  const workflowId =
    typeof event.payload.workflowId === "string" ? event.payload.workflowId : null;
  if (!workflowId) {
    return;
  }

  const version = await loadPublishedWorkflowVersion(env.DB, event.workspaceId, workflowId);
  if (!version) {
    return;
  }

  const definition = parseWorkflowDefinition(version.definition_json);
  if (workflowStatus(definition) !== "published") {
    return;
  }

  const syncDefinitions = deriveSyncDefinitions(definition);
  if (syncDefinitions.length === 0) {
    return;
  }
  assertReactiveMaintenanceWorkflowServiceIdentity(definition, version);

  for (const sync of syncDefinitions) {
    await enqueueSyncMaintenanceMessage(env, {
      eventId: event.eventId,
      sync,
      trigger: {
        kind: "backfill",
        reason: "workflow_published"
      },
      workflowId: version.workflow_id,
      workflowVersionId: version.workflow_version_id,
      workspaceId: event.workspaceId
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
