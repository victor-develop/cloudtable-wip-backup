import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentToolRegistry } from "../../../../src/core/agent-tools/registry";
import type { CommandBus } from "../../../../src/core/commands/command-bus";
import { createCommandBus } from "../../../../src/core/commands/command-bus";
import type { CommandEnvelope, CommandResult } from "../../../../src/core/commands/types";
import { scopeKeyForCommand } from "../../../../src/core/commands/transcript";
import { createEventLedger } from "../../../../src/core/events/event-ledger";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";
import { createViewPlanner } from "../../../../src/core/views/planner";
import { executeWorkflowAction } from "../../../../src/core/workflows/execution";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import type {
  WorkflowActionDefinition,
  WorkflowActionExecutor
} from "../../../../src/core/workflows/types";
import { TableCoordinatorDurableObject } from "../../../../src/durable-objects/table-coordinator";
import { WorkspaceControlDurableObject } from "../../../../src/durable-objects/workspace-control";
import { handleQueueBatch } from "../../../../src/queues/consumer";
import type { CloudTableEnv, CloudTableQueueMessage } from "../../../../src/runtime/env";
import {
  readAppActivityHistory,
  readRecordActivityHistory,
  readTableActivityHistory,
  readWorkspaceActivityHistory
} from "../../../../src/runtime/activity-history-read";
import { readViewQuery } from "../../../../src/runtime/view-query-read";
import { handleFetch, handleScheduled } from "../../../../src/runtime/worker";
import { InMemoryEventLedger } from "../../harness/runtime/in-memory-event-ledger";
import {
  insertField,
  insertRecord,
  seedAppAndTable,
  seedWorkspace,
  SqliteD1Database
} from "../../harness/runtime/sqlite-d1";
import { toCanonicalJson } from "../../harness/serializers/canonical-json";

const logicalTime = "2026-06-06T00:00:00.000Z";
const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();
const runtimeGlobal = globalThis as typeof globalThis & { crypto: Crypto };

const snapshot: EffectivePermissionSnapshot = {
  snapshotId: "snap_matrix_001",
  workspaceId: "ws_demo",
  principalId: "usr_alice",
  policyRevision: 7,
  schemaEpoch: 3,
  scopeHash: "scope:table:tbl_tasks",
  commandTypes: ["cell.set", "field.create", "table.create"],
  fields: {
    title: {
      agent: true,
      fieldId: "title",
      fieldType: "text.single_line",
      read: "visible",
      workflow: true,
      write: true
    },
    salary: {
      agent: false,
      fieldId: "salary",
      fieldType: "number.decimal",
      read: "hidden",
      workflow: false,
      write: false
    },
    customer_note: {
      agent: false,
      fieldId: "customer_note",
      fieldType: "text.long",
      read: "redacted",
      workflow: true,
      write: true
    },
    internal_note: {
      agent: true,
      fieldId: "internal_note",
      fieldType: "text.long",
      read: "visible",
      workflow: false,
      write: true
    },
    health_score: {
      agent: true,
      fieldId: "health_score",
      fieldType: "computed.readonly",
      read: "visible",
      workflow: true,
      write: false
    }
  }
};

const permissionFields = [
  {
    fieldId: "title",
    fieldType: "text.single_line",
    value: "Q3 Renewal"
  },
  {
    fieldId: "salary",
    fieldType: "number.decimal",
    value: "120000"
  },
  {
    fieldId: "customer_note",
    fieldType: "text.long",
    value: "VIP renewal risk"
  },
  {
    fieldId: "internal_note",
    fieldType: "text.long",
    value: "Only humans should see this in workflow steps"
  }
] as const;

const registryFields = permissionFields.map(({ fieldId, fieldType }) => ({
  fieldId,
  fieldType
}));

type StoredValue = unknown;

class RuntimeFakeDurableObjectStorage {
  private readonly store = new Map<string, StoredValue>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
}

class RuntimeFakeDurableObjectState {
  readonly storage = new RuntimeFakeDurableObjectStorage();

  constructor(private readonly name: string) {}

  get id(): { toString(): string } {
    return {
      toString: () => this.name
    };
  }
}

class RuntimeFakeQueue {
  readonly sent: CloudTableQueueMessage[] = [];
  readonly sends: Array<{ message: CloudTableQueueMessage; options?: QueueSendOptions }> = [];
  private remainingFailures = 0;

  failNext(count = 1): void {
    this.remainingFailures = Math.max(this.remainingFailures, count);
  }

  async send(message: CloudTableQueueMessage, options?: QueueSendOptions): Promise<void> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("Simulated queue publish failure.");
    }

    this.sent.push(message);
    this.sends.push({ message, options });
  }
}

class RuntimeFakeNamespace {
  private readonly instances = new Map<string, DurableObject>();

  constructor(private readonly build: (name: string) => DurableObject) {}

  idFromName(name: string): DurableObjectId {
    return {
      equals(other: DurableObjectId) {
        return other.toString() === name;
      },
      name,
      toString() {
        return name;
      }
    } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const name = id.toString();
    let instance = this.instances.get(name);
    if (!instance) {
      instance = this.build(name);
      this.instances.set(name, instance);
    }

    return {
      fetch: (request: Request) => instance.fetch(request)
    } as DurableObjectStub;
  }
}

function createHarness(overrides?: {
  snapshot?: EffectivePermissionSnapshot;
  idFactory?: (prefix: string) => string;
}) {
  const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
    snapshot: overrides?.snapshot
  });
  const eventLedger = new InMemoryEventLedger(logicalTime);
  const commandBus = createCommandBus({
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    workflowOperatorRegistry,
    idFactory:
      overrides?.idFactory ??
      ((prefix) => `${prefix}_0001`),
    now() {
      return logicalTime;
    }
  });

  return {
    commandBus,
    eventLedger,
    permissionEngine
  };
}

function buildAcceptedResult(commandId: string): CommandResult {
  return {
    accepted: true,
    diagnostics: [],
    events: [],
    permission: {
      allowed: true,
      reasons: []
    },
    replayProjection: {
      acceptedCommandIds: [commandId],
      lastLogicalTime: logicalTime,
      receiptCount: 1,
      receipts: []
    },
    sideEffects: [],
    status: "accepted"
  };
}

function requireAction(id: string): WorkflowActionDefinition {
  const definition = workflowOperatorRegistry.require(id);
  if (definition.kind !== "action") {
    throw new Error(`Expected workflow action for ${id}`);
  }

  return definition;
}

function insertActivityEvent(
  db: SqliteD1Database,
  input: {
    actor: {
      mode: string;
      principalId: string;
    };
    aggregateId?: string | null;
    aggregateType?: string | null;
    commandId: string;
    commandType: string;
    createdAt: string;
    eventId: string;
    eventType: string;
    payload?: Record<string, unknown>;
    tableId: string;
    tableSequence: number;
    workspaceId?: string;
    workspaceSequence: number;
  }
): void {
  db.inner
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.eventId,
      input.workspaceId ?? "ws_1",
      input.tableId,
      input.eventType,
      input.commandId,
      input.aggregateId ?? null,
      input.workspaceSequence,
      input.tableSequence,
      JSON.stringify(input.payload ?? {}),
      JSON.stringify({
        actor: input.actor,
        aggregateType: input.aggregateType ?? null,
        commandType: input.commandType,
        scope: "table"
      }),
      input.createdAt
    );
}

function insertScheduledWorkflowDefinition(
  db: SqliteD1Database,
  input: {
    cadenceMinutes: number;
    workflowId: string;
  }
): void {
  db.inner
    .prepare(
      `INSERT INTO workflows (
         id,
         workspace_id,
         workflow_key,
         name,
         current_version,
         created_at,
         updated_at,
         archived_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workflowId,
      "ws_demo",
      `${input.workflowId}-key`,
      input.workflowId,
      1,
      logicalTime,
      logicalTime,
      null,
      null
    );

  db.inner
    .prepare(
      `INSERT INTO workflow_versions (
         id,
         workspace_id,
         workflow_id,
         version,
         definition_json,
         published_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `${input.workflowId}:v1`,
      "ws_demo",
      input.workflowId,
      1,
      JSON.stringify({
        workflowId: input.workflowId,
        metadata: {
          status: "published"
        },
        trigger: {
          operatorId: "scheduled",
          match: {
            schedule: {
              cadenceMinutes: input.cadenceMinutes
            }
          }
        },
        conditions: [],
        actions: [
          {
            operatorId: "emit_notification_event",
            input: {
              channel: "ops",
              message: input.workflowId
            }
          }
        ]
      }),
      logicalTime,
      null
    );
}

function createRuntimeRouteBody(overrides: Partial<CommandEnvelope> = {}): Partial<CommandEnvelope> {
  return {
    actor: {
      mode: "user",
      principalId: "usr_owner"
    },
    commandId: "cmd_1",
    idempotencyKey: "idem_1",
    payload: {},
    workspaceId: "ws_1",
    ...overrides
  };
}

function createRuntimeCommand(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    actor: {
      mode: "user",
      principalId: "principal_1"
    },
    commandId: "cmd_1",
    commandType: "record.create",
    idempotencyKey: "idem_1",
    payload: {
      recordId: "rec_1"
    },
    scope: "table",
    tableId: "tbl_1",
    workspaceId: "ws_1",
    ...overrides
  };
}

function createRuntimeEnv(): {
  db: SqliteD1Database;
  deadLetterQueue: RuntimeFakeQueue;
  env: CloudTableEnv;
  eventFanoutQueue: RuntimeFakeQueue;
  projectionQueue: RuntimeFakeQueue;
  workflowDispatchQueue: RuntimeFakeQueue;
  workflowStepQueue: RuntimeFakeQueue;
} {
  const db = new SqliteD1Database();
  seedWorkspace(db, "ws_1");
  seedAppAndTable(db, {
    workspaceId: "ws_1",
    tableId: "tbl_1"
  });

  const eventFanoutQueue = new RuntimeFakeQueue();
  const workflowDispatchQueue = new RuntimeFakeQueue();
  const workflowStepQueue = new RuntimeFakeQueue();
  const projectionQueue = new RuntimeFakeQueue();
  const deadLetterQueue = new RuntimeFakeQueue();

  let env!: CloudTableEnv;
  const workspaceNamespace = new RuntimeFakeNamespace(
    (name) =>
      new WorkspaceControlDurableObject(
        new RuntimeFakeDurableObjectState(name) as unknown as DurableObjectState,
        env
      ) as unknown as DurableObject
  );
  const tableNamespace = new RuntimeFakeNamespace(
    (name) =>
      new TableCoordinatorDurableObject(
        new RuntimeFakeDurableObjectState(name) as unknown as DurableObjectState,
        env
      ) as unknown as DurableObject
  );

  env = {
    ARTIFACTS_BUCKET: {} as R2Bucket,
    DB: db as unknown as D1Database,
    DEAD_LETTER_REPROCESSOR_QUEUE: deadLetterQueue as unknown as Queue<CloudTableQueueMessage>,
    EVENT_FANOUT_QUEUE: eventFanoutQueue as unknown as Queue<CloudTableQueueMessage>,
    PROJECTION_MAINTENANCE_QUEUE: projectionQueue as unknown as Queue<CloudTableQueueMessage>,
    TABLE_COORDINATOR_DO: tableNamespace as unknown as DurableObjectNamespace,
    WORKFLOW_DISPATCH_QUEUE:
      workflowDispatchQueue as unknown as Queue<CloudTableQueueMessage>,
    WORKFLOW_STEP_QUEUE: workflowStepQueue as unknown as Queue<CloudTableQueueMessage>,
    WORKSPACE_CONTROL_DO: workspaceNamespace as unknown as DurableObjectNamespace
  };

  return {
    db,
    deadLetterQueue,
    env,
    eventFanoutQueue,
    projectionQueue,
    workflowDispatchQueue,
    workflowStepQueue
  };
}

function createRuntimeBatch(
  messages: CloudTableQueueMessage[]
): {
  batch: {
    messages: Array<{
      ack(): void;
      body: CloudTableQueueMessage;
      retry(): void;
    }>;
  };
} {
  return {
    batch: {
      messages: messages.map((body) => ({
        ack() {},
        body,
        retry() {
          throw new Error(`Unexpected retry for ${body.kind}`);
        }
      }))
    }
  };
}

function createRuntimeScheduledController(scheduledTime: number): ScheduledController {
  return {
    cron: "* * * * *",
    noRetry() {},
    scheduledTime
  } as ScheduledController;
}

function insertRuntimeRecordProjection(db: SqliteD1Database): void {
  insertRecord(db, {
    recordId: "rec_1",
    recordKey: "record-1",
    tableId: "tbl_1"
  });

  db.inner
    .prepare(
      `INSERT INTO record_projection (
         workspace_id,
         table_id,
         record_id,
         projection_json,
         search_document,
         projection_version,
         last_event_id,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "ws_1",
      "tbl_1",
      "rec_1",
      JSON.stringify({
        fields: {
          owner: null,
          source: null,
          status: null
        }
      }),
      "",
      1,
      "evt_seed_record_projection",
      "2026-06-06T00:00:00.000Z"
    );
}

function insertRuntimeCellCurrent(
  db: SqliteD1Database,
  input: {
    fieldId: string;
    fieldType: string;
    recordId: string;
    tableId: string;
    value: unknown;
  }
): void {
  db.inner
    .prepare(
      `INSERT INTO cell_current (
         record_id,
         field_id,
         workspace_id,
         table_id,
         value_type,
         value_version,
         value_json,
         text_value,
         number_value,
         bool_value,
         datetime_value,
         reference_value,
         display_value,
         search_text,
         value_hash,
         cell_revision,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.recordId,
      input.fieldId,
      "ws_1",
      input.tableId,
      input.fieldType,
      1,
      JSON.stringify({
        isEmpty:
          input.value == null ||
          input.value === "" ||
          (Array.isArray(input.value) && input.value.length === 0),
        raw: input.value,
        valueType: input.fieldType,
        version: 1
      }),
      typeof input.value === "string" ? input.value : null,
      input.fieldType === "number.decimal" && input.value != null ? Number(input.value) : null,
      typeof input.value === "boolean" ? Number(input.value) : null,
      null,
      null,
      input.value == null ? "" : String(input.value),
      input.value == null ? "" : String(input.value).toLowerCase(),
      JSON.stringify(input.value ?? null),
      1,
      `evt_seed_${input.recordId}_${input.fieldId}`
    );
}

function insertRuntimePermissionSnapshot(
  db: SqliteD1Database,
  input: {
    commandTypes?: string[];
    fields?: Record<string, unknown>;
    policyRevision?: number;
    principalId?: string;
    scopeHash?: string;
    snapshotId?: string;
    workflow?: boolean;
    write?: boolean;
  } = {}
): void {
  const policyRevision = input.policyRevision ?? 7;
  const scopeHash = input.scopeHash ?? "scope:wf:status-sync";
  const principalId = input.principalId ?? "wf_service";
  const workflow = input.workflow ?? true;
  const write = input.write ?? true;
  const snapshotId = input.snapshotId ?? `snap_${principalId}_${policyRevision}`;

  db.inner
    .prepare(
      `INSERT INTO permission_snapshots (
         id,
         workspace_id,
         principal_id,
         policy_revision,
         scope_hash,
         snapshot_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      snapshotId,
      "ws_1",
      principalId,
      policyRevision,
      scopeHash,
      JSON.stringify({
        snapshotId,
        workspaceId: "ws_1",
        principalId,
        policyRevision,
        schemaEpoch: 0,
        scopeHash,
        commandTypes: input.commandTypes ?? ["cell.set"],
        fields:
          input.fields ?? {
            fld_status: {
              agent: false,
              fieldId: "fld_status",
              fieldType: "text.single_line",
              read: "visible",
              workflow,
              write
            }
          }
      }),
      "2026-06-06T00:00:00.000Z"
    );
}

function insertRuntimeWorkflowDefinition(
  db: SqliteD1Database,
  input: {
    actions?: Array<Record<string, unknown>>;
    conditions?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
    principal?: Record<string, unknown>;
    publishedAt?: string | null;
    trigger?: Record<string, unknown>;
    workflowId?: string;
    workflowKey?: string;
    workflowName?: string;
    workflowVersionId?: string;
  } = {}
): void {
  const workflowId = input.workflowId ?? "wf_status_sync";

  db.inner
    .prepare(
      `INSERT INTO workflows (
         id,
         workspace_id,
         workflow_key,
         name,
         current_version,
         created_at,
         updated_at,
         archived_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      workflowId,
      "ws_1",
      input.workflowKey ?? "status-sync",
      input.workflowName ?? "Status Sync",
      1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
    );

  db.inner
    .prepare(
      `INSERT INTO workflow_versions (
         id,
         workspace_id,
         workflow_id,
         version,
         definition_json,
         published_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workflowVersionId ?? `${workflowId}:v1`,
      "ws_1",
      workflowId,
      1,
      JSON.stringify({
        workflowId,
        principal:
          input.principal ?? {
            principalId: "wf_service",
            policyRevision: 7,
            schemaEpoch: 0,
            scopeHash: "scope:wf:status-sync"
          },
        trigger:
          input.trigger ?? {
            operatorId: "field_changed",
            match: {
              fieldId: "fld_source",
              fromWorkflow: false,
              tableId: "tbl_1"
            }
          },
        conditions: input.conditions ?? [],
        ...(input.metadata ? { metadata: input.metadata } : {}),
        actions:
          input.actions ?? [
            {
              operatorId: "set_cell",
              input: {
                fieldId: "fld_status",
                fieldType: "text.single_line",
                recordId: {
                  path: "row.recordId"
                },
                tableId: {
                  path: "table.tableId"
                },
                value: "processed"
              }
            }
          ]
      }),
      input.publishedAt ?? "2026-06-06T00:00:00.000Z",
      null
    );
}

function insertRuntimeWorkflow(
  db: SqliteD1Database,
  input: {
    definition?: Record<string, unknown>;
    name: string;
    publishedAt?: string | null;
    workflowId: string;
    workflowKey: string;
    workspaceId?: string;
  }
): void {
  const workspaceId = input.workspaceId ?? "ws_1";

  db.inner
    .prepare(
      `INSERT INTO workflows (
        id,
        workspace_id,
        workflow_key,
        name,
        current_version,
        created_at,
        updated_at,
        archived_at,
        last_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workflowId,
      workspaceId,
      input.workflowKey,
      input.name,
      1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
    );

  db.inner
    .prepare(
      `INSERT INTO workflow_versions (
        id,
        workspace_id,
        workflow_id,
        version,
        definition_json,
        published_at,
        last_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `${input.workflowId}:v1`,
      workspaceId,
      input.workflowId,
      1,
      JSON.stringify(
        input.definition ?? {
          trigger: {
            match: {
              tableId: "tbl_1"
            }
          }
        }
      ),
      input.publishedAt ?? null,
      null
    );
}

function insertRuntimeWorkflowRun(
  db: SqliteD1Database,
  input: {
    attemptCount?: number;
    deadLetteredAt?: string | null;
    finishedAt?: string | null;
    manualInvocationId?: string | null;
    principalId?: string;
    startedAt?: string;
    state?: Record<string, unknown>;
    status: string;
    triggerEventId?: string;
    updatedAt?: string;
    workflowId: string;
    workflowRunId: string;
    workflowVersionId?: string;
    workspaceId?: string;
  }
): void {
  const workspaceId = input.workspaceId ?? "ws_1";

  db.inner
    .prepare(
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workflowRunId,
      workspaceId,
      input.workflowId,
      input.workflowVersionId ?? `${input.workflowId}:v1`,
      input.triggerEventId ?? "evt_workflow_trigger_1",
      input.manualInvocationId ?? null,
      input.principalId ?? "wf_service",
      input.status,
      input.attemptCount ?? 1,
      input.startedAt ?? "2026-06-06T00:10:00.000Z",
      input.updatedAt ?? "2026-06-06T00:12:00.000Z",
      input.finishedAt ?? "2026-06-06T00:12:00.000Z",
      input.deadLetteredAt ?? null,
      JSON.stringify(input.state ?? {})
    );
}

function insertRuntimeWorkflowRunStep(
  db: SqliteD1Database,
  input: {
    attemptCount?: number;
    audit?: Record<string, unknown>;
    finishedAt?: string | null;
    inputPayload?: Record<string, unknown>;
    lastErrorCode?: string | null;
    operatorId?: string;
    operatorVersion?: number;
    output?: Record<string, unknown> | null;
    startedAt?: string;
    status: string;
    stepId: string;
    stepKey?: string;
    updatedAt?: string;
    workflowRunId: string;
    workspaceId?: string;
  }
): void {
  db.inner
    .prepare(
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.stepId,
      input.workflowRunId,
      input.workspaceId ?? "ws_1",
      input.stepKey ?? "action:0",
      input.operatorId ?? "set_cell",
      input.operatorVersion ?? 1,
      input.status,
      input.attemptCount ?? 1,
      JSON.stringify(input.inputPayload ?? { fieldId: "fld_status", value: "processed" }),
      input.output === undefined ? null : JSON.stringify(input.output),
      JSON.stringify(input.audit ?? {}),
      input.lastErrorCode ?? null,
      input.startedAt ?? "2026-06-06T00:10:00.000Z",
      input.updatedAt ?? "2026-06-06T00:12:00.000Z",
      input.finishedAt ?? "2026-06-06T00:12:00.000Z"
    );
}

function insertRuntimeWorkflowDeadLetter(
  db: SqliteD1Database,
  input: {
    attemptCount?: number;
    createdAt?: string;
    failureCode?: string;
    failureMessage?: string;
    payload?: Record<string, unknown>;
    queueName?: string;
    workflowRunId: string;
    workflowStepId: string;
    workspaceId?: string;
  }
): void {
  const workspaceId = input.workspaceId ?? "ws_1";

  db.inner
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
    .run(
      `wdl:${input.workflowStepId}`,
      input.workflowRunId,
      workspaceId,
      input.queueName ?? "workflow-step",
      JSON.stringify(
        input.payload ?? {
          sourceMessage: {
            kind: "workflow-step",
            payload: {
              workflowStepId: input.workflowStepId
            },
            workflowRunId: input.workflowRunId,
            workspaceId
          },
          workflowRunId: input.workflowRunId,
          workflowStepId: input.workflowStepId
        }
      ),
      input.failureCode ?? "record_not_found:rec_missing",
      input.failureMessage ?? "record_not_found:rec_missing",
      input.attemptCount ?? 1,
      input.createdAt ?? "2026-06-06T00:12:00.000Z"
    );
}

function setRuntimeFieldPrincipalPermission(
  db: SqliteD1Database,
  input: {
    fieldId: string;
    permission: {
      agent: boolean;
      read: "visible" | "redacted" | "hidden";
      workflow: boolean;
      write: boolean;
    };
    principalId: string;
    workspaceId?: string;
  }
): void {
  const row = db.inner
    .prepare(`SELECT config_json FROM fields WHERE workspace_id = ? AND id = ?`)
    .get(input.workspaceId ?? "ws_1", input.fieldId) as {
    config_json: string;
  };
  const config = JSON.parse(row.config_json) as {
    permissionsByPrincipal?: Record<string, unknown>;
  };

  db.inner
    .prepare(`UPDATE fields SET config_json = ? WHERE workspace_id = ? AND id = ?`)
    .run(
      JSON.stringify({
        ...config,
        permissionsByPrincipal: {
          ...((config.permissionsByPrincipal as Record<string, unknown> | undefined) ?? {}),
          [input.principalId]: input.permission
        }
      }),
      input.workspaceId ?? "ws_1",
      input.fieldId
    );
}

describe("cloudtable MVP regression matrix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("covers the deterministic MVP semantic seams with stable snapshots", async () => {
    const matrix: Array<Record<string, unknown>> = [];

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["table.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_table_create_001",
        commandType: "table.create",
        idempotencyKey: "idem_table_create_001",
        payload: {
          appId: "app_ops",
          baseId: "base_ops",
          name: "Tasks",
          slug: "tasks",
          tableId: "tbl_tasks"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "table_creation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "table_create_basic"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_001",
        payload: {
          fieldId: "status",
          fieldKey: "status",
          fieldType: "text.single_line",
          label: "Status"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_creation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_create_basic"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_invalid_config_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_invalid_config_001",
        payload: {
          config: {
            display: "weird",
            precision: -1
          },
          fieldId: "score",
          fieldKey: "score",
          fieldType: "number.decimal",
          label: "Score"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_validation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_validation_rejects_invalid_config"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_invalid_select_config_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_invalid_select_config_001",
        payload: {
          config: {
            options: [
              {
                extra: true,
                id: 42,
                label: "Ready"
              },
              {
                id: "ready",
                label: ""
              },
              {
                id: "ready",
                label: "Duplicate"
              }
            ]
          },
          fieldId: "stage",
          fieldKey: "stage",
          fieldType: "select.single",
          label: "Stage"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_validation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_validation_rejects_invalid_select_config"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_invalid_status_config_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_invalid_status_config_001",
        payload: {
          config: {
            options: [
              {
                id: "todo",
                label: "Todo"
              },
              {
                id: "doing",
                label: "Doing",
                semantic: "moving"
              }
            ]
          },
          fieldId: "status",
          fieldKey: "status",
          fieldType: "status.semantic",
          label: "Status"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_validation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_validation_rejects_invalid_status_config"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_invalid_boolean_config_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_invalid_boolean_config_001",
        payload: {
          config: {
            unexpected: true
          },
          fieldId: "done",
          fieldKey: "done",
          fieldType: "boolean.checkbox",
          label: "Done"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_validation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_validation_rejects_invalid_boolean_config"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_invalid_date_config_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_invalid_date_config_001",
        payload: {
          config: {
            timezone: "UTC"
          },
          fieldId: "due_date",
          fieldKey: "dueDate",
          fieldType: "date.date",
          label: "Due Date"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_validation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_validation_rejects_invalid_date_config"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_invalid_principal_config_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_invalid_principal_config_001",
        payload: {
          config: {
            allowedRoleIds: ["admin", "admin", ""]
          },
          fieldId: "assignee",
          fieldKey: "assignee",
          fieldType: "principal.user",
          label: "Assignee"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_validation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_validation_rejects_invalid_principal_config"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_invalid_relation_config_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_invalid_relation_config_001",
        payload: {
          config: {
            allowMultiple: "yes"
          },
          fieldId: "related_task",
          fieldKey: "relatedTask",
          fieldType: "relation.record",
          label: "Related Task"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_validation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_validation_rejects_invalid_relation_config"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.create"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_create_invalid_computed_config_001",
        commandType: "field.create",
        idempotencyKey: "idem_field_create_invalid_computed_config_001",
        payload: {
          config: {
            dependsOnFieldIds: ["fld_title", "fld_title"],
            expression: ""
          },
          fieldId: "health_score",
          fieldKey: "healthScore",
          fieldType: "computed.readonly",
          label: "Health Score"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_validation",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_validation_rejects_invalid_computed_config"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_001",
        payload: {
          fieldId: "title",
          recordId: "rec_001",
          value: "Renewal committed"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "record_and_cell_writes",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "cell_set_write"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertField(db, {
        config: {
          precision: 2
        },
        fieldId: "fld_score",
        fieldKey: "score",
        fieldType: "number.decimal",
        label: "Score",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_invalid_number_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_invalid_number_001",
        payload: {
          fieldId: "fld_score",
          recordId: "rec_001",
          value: "4.567"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_invalid_value"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertField(db, {
        config: {
          options: [
            { id: "alpha", label: "Alpha" },
            { id: "beta", label: "Beta" }
          ]
        },
        fieldId: "fld_tags",
        fieldKey: "tags",
        fieldType: "select.multi",
        label: "Tags",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_invalid_select_multi_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_invalid_select_multi_001",
        payload: {
          fieldId: "fld_tags",
          recordId: "rec_001",
          value: ["alpha", "missing"]
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_invalid_select_value"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertField(db, {
        config: {
          options: [{ id: "todo", label: "Todo", semantic: "todo" }]
        },
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic",
        label: "Status",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_invalid_status_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_invalid_status_001",
        payload: {
          fieldId: "fld_status",
          recordId: "rec_001",
          value: "missing"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_invalid_status_value"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertField(db, {
        fieldId: "fld_done",
        fieldKey: "done",
        fieldType: "boolean.checkbox",
        label: "Done",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_invalid_boolean_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_invalid_boolean_001",
        payload: {
          fieldId: "fld_done",
          recordId: "rec_001",
          value: "maybe"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_invalid_boolean_value"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertField(db, {
        fieldId: "fld_due_date",
        fieldKey: "dueDate",
        fieldType: "date.date",
        label: "Due Date",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_invalid_date_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_invalid_date_001",
        payload: {
          fieldId: "fld_due_date",
          recordId: "rec_001",
          value: "2026-02-30"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_invalid_date_value"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertField(db, {
        fieldId: "fld_due_at",
        fieldKey: "dueAt",
        fieldType: "date.datetime",
        label: "Due At",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_invalid_datetime_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_invalid_datetime_001",
        payload: {
          fieldId: "fld_due_at",
          recordId: "rec_001",
          value: "2026-06-06T00:00:00"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_invalid_datetime_value"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertField(db, {
        fieldId: "fld_assignee",
        fieldKey: "assignee",
        fieldType: "principal.user",
        label: "Assignee",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_invalid_principal_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_invalid_principal_001",
        payload: {
          fieldId: "fld_assignee",
          recordId: "rec_001",
          value: ["user_1", "user_1"]
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_invalid_principal_value"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertField(db, {
        config: {
          allowMultiple: false,
          targetTableId: "tbl_related"
        },
        fieldId: "fld_related_task",
        fieldKey: "relatedTask",
        fieldType: "relation.record",
        label: "Related Task",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_invalid_relation_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_invalid_relation_001",
        payload: {
          fieldId: "fld_related_task",
          recordId: "rec_001",
          value: ["rec_1", "rec_2"]
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_invalid_relation_value"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_demo");
      seedAppAndTable(db, {
        appId: "app_ops",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      db.inner
        .prepare(
          `INSERT INTO tables (
            id,
            workspace_id,
            app_id,
            slug,
            name,
            schema_epoch,
            current_schema_version,
            created_at,
            updated_at,
            archived_at,
            last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "tbl_related",
          "ws_demo",
          "app_ops",
          "related-tasks",
          "Related Tasks",
          0,
          1,
          logicalTime,
          logicalTime,
          null,
          null
        );
      insertField(db, {
        config: {
          allowMultiple: true,
          targetTableId: "tbl_related"
        },
        fieldId: "fld_related_task",
        fieldKey: "relatedTask",
        fieldType: "relation.record",
        label: "Related Task",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_001",
        recordKey: "record-1",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });
      insertRecord(db, {
        recordId: "rec_other_table",
        recordKey: "other-table-record",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      });

      const commandBus = createCommandBus({
        eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
        fieldTypeRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return logicalTime;
        },
        permissionEngine: createPermissionEngine(fieldTypeRegistry, {
          snapshot
        }),
        workflowOperatorRegistry
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_cell_set_wrong_table_relation_001",
        commandType: "cell.set",
        idempotencyKey: "idem_cell_set_wrong_table_relation_001",
        payload: {
          fieldId: "fld_related_task",
          recordId: "rec_001",
          value: ["rec_other_table"]
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const actual = await commandBus.execute(command);
      const eventRows = await db
        .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
        .bind()
        .all<{ event_id: string }>();
      const receiptRows = await db
        .prepare(`SELECT idempotency_key FROM idempotency_receipts ORDER BY idempotency_key ASC`)
        .bind()
        .all<{ idempotency_key: string }>();
      const projectionRows = await db
        .prepare(`SELECT record_id FROM record_projection ORDER BY record_id ASC`)
        .bind()
        .all<{ record_id: string }>();

      matrix.push({
        actual,
        category: "field_validation",
        persisted: {
          eventIds: eventRows.results.map((row) => row.event_id),
          projectionRecordIds: projectionRows.results.map((row) => row.record_id),
          receiptKeys: receiptRows.results.map((row) => row.idempotency_key)
        },
        scenario: "field_validation_rejects_wrong_table_relation_reference"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["field.permission.configure"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_field_permission_001",
        commandType: "field.permission.configure",
        idempotencyKey: "idem_field_permission_001",
        payload: {
          fieldId: "title",
          policy: {
            agent: false,
            read: "redacted",
            workflow: true,
            write: false
          },
          principalId: "usr_member"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workspace",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "field_permissions",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "field_permission_configuration"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: [
            "workflow.create",
            "workflow.update",
            "workflow.publish",
            "workflow.pause",
            "workflow.manual",
            "workflow.webhook.enqueue"
          ]
        }
      });
      const updateCommand: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_workflow_update_001",
        commandType: "workflow.update",
        idempotencyKey: "idem_workflow_update_001",
        payload: {
          definition: {
            actions: [
              {
                input: {
                  value: "follow-up"
                },
                operatorId: "set_cell"
              }
            ],
            conditions: [],
            metadata: {
              status: "draft",
              tableId: "tbl_tasks"
            },
            trigger: {
              match: {
                tableId: "tbl_tasks"
              },
              operatorId: "record_updated"
            },
            workflowId: "wf_follow_up"
          },
          name: "Follow Up Draft",
          tableId: "tbl_tasks",
          workflowId: "wf_follow_up"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(updateCommand),
        category: "workflow_lifecycle",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(updateCommand)),
        scenario: "workflow_update_event"
      });

      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_workflow_publish_001",
        commandType: "workflow.publish",
        idempotencyKey: "idem_workflow_publish_001",
        payload: {
          workflowId: "wf_follow_up"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "workflow_lifecycle",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "workflow_publish_event"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["workflow.manual"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_workflow_manual_001",
        commandType: "workflow.manual",
        idempotencyKey: "idem_workflow_manual_001",
        payload: {
          input: {
            recordId: "rec_001",
            source: "button"
          },
          manualInvocationId: "manual_run_001",
          workflowId: "wf_follow_up"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "workflow_execution",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "workflow_manual_event"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["workflow.webhook.enqueue"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "workflow",
          principalId: "wf_follow_up"
        },
        commandId: "cmd_workflow_webhook_001",
        commandType: "workflow.webhook.enqueue",
        idempotencyKey: "idem_workflow_webhook_001",
        payload: {
          body: {
            event: "record.updated",
            recordId: "rec_001"
          },
          destination: "https://example.test/hooks/cloudtable",
          headers: {
            "x-cloudtable-workflow": "wf_follow_up"
          },
          method: "POST",
          triggerEventId: "evt_record_updated_001",
          workflowId: "wf_follow_up",
          workflowRunId: "wfr_001",
          workflowStepId: "step_send_webhook_001"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "workflow_execution",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "workflow_webhook_enqueue_delivery"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          principalId: "wf_follow_up",
          commandTypes: ["job.enqueue"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "workflow",
          principalId: "wf_follow_up"
        },
        commandId: "cmd_workflow_job_enqueue_001",
        commandType: "job.enqueue",
        idempotencyKey: "idem_workflow_job_enqueue_001",
        payload: {
          args: {
            recordId: "rec_001"
          },
          jobType: "projection.rebuild",
          triggerEventId: "evt_record_updated_001",
          workflowId: "wf_follow_up",
          workflowRunId: "wfr_001",
          workflowStepId: "step_enqueue_internal_job_001"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "workflow_execution",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "workflow_internal_job_enqueue_event"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          principalId: "wf_follow_up",
          commandTypes: ["notification.emit"]
        }
      });
      const command: CommandEnvelope = {
        actor: {
          mode: "workflow",
          principalId: "wf_follow_up"
        },
        commandId: "cmd_workflow_notification_emit_001",
        commandType: "notification.emit",
        idempotencyKey: "idem_workflow_notification_emit_001",
        payload: {
          channel: "activity",
          details: {
            recordId: "rec_001"
          },
          message: "Workflow step completed.",
          triggerEventId: "evt_record_updated_001",
          workflowId: "wf_follow_up",
          workflowRunId: "wfr_001",
          workflowStepId: "step_emit_notification_event_001"
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        workspaceId: "ws_demo"
      };

      matrix.push({
        actual: await commandBus.execute(command),
        category: "workflow_execution",
        receipts: eventLedger.snapshotReceipts(scopeKeyForCommand(command)),
        scenario: "workflow_notification_emit_event"
      });
    }

    {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(logicalTime));
      let randomUuidCounter = 201;
      vi.spyOn(runtimeGlobal.crypto, "randomUUID").mockImplementation(() => {
        const suffix = String(randomUuidCounter++).padStart(12, "0");
        return `00000000-0000-4000-8000-${suffix}`;
      });

      const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } =
        createRuntimeEnv();

      insertField(db, {
        fieldId: "fld_source",
        fieldKey: "source",
        fieldType: "text.single_line",
        label: "Source",
        tableId: "tbl_1"
      });
      insertField(db, {
        config: {
          options: [
            { id: "open", label: "Open", semantic: "todo" },
            { id: "qualified", label: "Qualified", semantic: "done" }
          ]
        },
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic",
        label: "Status",
        tableId: "tbl_1"
      });
      insertRuntimeRecordProjection(db);
      insertRuntimeCellCurrent(db, {
        fieldId: "fld_status",
        fieldType: "status.semantic",
        recordId: "rec_1",
        tableId: "tbl_1",
        value: "open"
      });
      insertRuntimePermissionSnapshot(db, {
        commandTypes: ["notification.emit"]
      });
      insertRuntimeWorkflowDefinition(db, {
        actions: [
          {
            operatorId: "emit_notification_event",
            input: {
              channel: "activity",
              details: {
                recordStatus: {
                  path: "row.fields.status.value"
                },
                recordId: {
                  path: "row.recordId"
                }
              },
              message: "Status workflow step completed."
            }
          }
        ],
        conditions: [
          {
            operatorId: "equals",
            input: {
              left: {
                path: "row.fields.status.value"
              },
              right: "open"
            }
          }
        ]
      });

      const response = await handleFetch(
        new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            actor: {
              mode: "user",
              principalId: "usr_owner"
            },
            commandId: "cmd_trigger_owner_delivery_matrix_1",
            idempotencyKey: "idem_trigger_owner_delivery_matrix_1",
            payload: {
              fieldType: "text.single_line",
              value: "crm"
            },
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );

      await handleQueueBatch(
        createRuntimeBatch([eventFanoutQueue.sent[0]!]).batch as never,
        env,
        {} as ExecutionContext
      );
      await handleQueueBatch(
        createRuntimeBatch([workflowDispatchQueue.sent[0]!]).batch as never,
        env,
        {} as ExecutionContext
      );
      await handleQueueBatch(
        createRuntimeBatch([workflowStepQueue.sent[0]!]).batch as never,
        env,
        {} as ExecutionContext
      );

      const workflowRun = db.inner
        .prepare(
          `SELECT id, status
           FROM workflow_runs
           ORDER BY id ASC
           LIMIT 1`
        )
        .get() as { id: string; status: string };
      const workflowStep = db.inner
        .prepare(
          `SELECT status, last_error_code
           FROM workflow_run_steps
           ORDER BY id ASC
           LIMIT 1`
        )
        .get() as { last_error_code: string | null; status: string };
      const notificationCommand = db.inner
        .prepare(
          `SELECT payload_json
           FROM event_ledger
           WHERE command_id = ?`
        )
        .get(`${workflowRun.id}:action:0`) as { payload_json: string };

      matrix.push({
        actual: {
          notificationCommand: JSON.parse(notificationCommand.payload_json) as Record<string, unknown>,
          response: {
            body: (await response.json()) as Record<string, unknown>,
            status: response.status
          },
          workflowRun,
          workflowStep
        },
        category: "workflow_execution",
        scenario: "workflow_field_binding_notification_delivery"
      });
    }

    {
      const { db, env } = createRuntimeEnv();

      insertField(db, {
        config: {
          rowOwner: true
        },
        fieldId: "fld_owner",
        fieldKey: "owner",
        fieldType: "principal.user",
        label: "Owner",
        tableId: "tbl_1"
      });
      insertField(db, {
        fieldId: "fld_assignee",
        fieldKey: "assignee",
        fieldType: "principal.user",
        label: "Assignee",
        tableId: "tbl_1"
      });
      insertField(db, {
        config: {
          options: [
            { id: "open", label: "Open", semantic: "todo" },
            { id: "qualified", label: "Qualified", semantic: "done" }
          ]
        },
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic",
        label: "Status",
        tableId: "tbl_1"
      });
      insertField(db, {
        fieldId: "fld_title",
        fieldKey: "title",
        fieldType: "text.single_line",
        label: "Title",
        tableId: "tbl_1"
      });

      insertRecord(db, {
        recordId: "rec_owner_matrix_1",
        recordKey: "owner-matrix-1",
        tableId: "tbl_1"
      });
      insertRecord(db, {
        recordId: "rec_owner_matrix_2",
        recordKey: "owner-matrix-2",
        tableId: "tbl_1"
      });
      db.inner
        .prepare(
          `INSERT INTO record_projection (
            workspace_id,
            table_id,
            record_id,
            projection_json,
            search_document,
            projection_version,
            last_event_id,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "ws_1",
          "tbl_1",
          "rec_owner_matrix_1",
          JSON.stringify({
            fields: {
              assignee: ["usr_delegate"],
              owner: ["usr_owner"],
              status: "open",
              title: "Owned by owner"
            }
          }),
          "",
          1,
          "evt_projection_rec_owner_matrix_1",
          logicalTime
        );
      db.inner
        .prepare(
          `INSERT INTO record_projection (
            workspace_id,
            table_id,
            record_id,
            projection_json,
            search_document,
            projection_version,
            last_event_id,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "ws_1",
          "tbl_1",
          "rec_owner_matrix_2",
          JSON.stringify({
            fields: {
              assignee: ["usr_owner"],
              owner: ["usr_member"],
              status: "qualified",
              title: "Owned by member"
            }
          }),
          "",
          1,
          "evt_projection_rec_owner_matrix_2",
          logicalTime
        );
      db.inner
        .prepare(
          `INSERT INTO field_index_entries (
            workspace_id,
            table_id,
            field_id,
            record_id,
            index_value_text,
            index_value_number,
            index_value_datetime,
            index_value_bool,
            last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "ws_1",
          "tbl_1",
          "fld_owner",
          "rec_owner_matrix_1",
          "usr_owner",
          null,
          null,
          null,
          "evt_index_rec_owner_matrix_1_fld_owner"
        );
      db.inner
        .prepare(
          `INSERT INTO field_index_entries (
            workspace_id,
            table_id,
            field_id,
            record_id,
            index_value_text,
            index_value_number,
            index_value_datetime,
            index_value_bool,
            last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "ws_1",
          "tbl_1",
          "fld_owner",
          "rec_owner_matrix_2",
          "usr_member",
          null,
          null,
          null,
          "evt_index_rec_owner_matrix_2_fld_owner"
        );
      db.inner
        .prepare(
          `INSERT INTO views (
            id,
            workspace_id,
            table_id,
            view_key,
            name,
            current_schema_version,
            created_at,
            updated_at,
            archived_at,
            last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "view_owner_matrix",
          "ws_1",
          "tbl_1",
          "owner-matrix",
          "Owner Matrix",
          1,
          logicalTime,
          logicalTime,
          null,
          null
        );
      db.inner
        .prepare(
          `INSERT INTO view_schema_versions (
            id,
            workspace_id,
            view_id,
            schema_version,
            schema_json,
            created_at,
            created_by_principal_id,
            last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "view_owner_matrix:v1",
          "ws_1",
          "view_owner_matrix",
          1,
          JSON.stringify({
            filterFieldIds: ["fld_owner"],
            filters: [
              {
                fieldId: "fld_owner",
                operatorId: "equals",
                value: "usr_owner"
              }
            ],
            groupByFieldId: null,
            showEmptyGroups: false,
            sortFieldIds: ["fld_title"],
            sorts: [
              {
                fieldId: "fld_title",
                mode: "ascending"
              }
            ],
            visibleFieldIds: ["fld_title", "fld_owner", "fld_status"]
          }),
          logicalTime,
          "usr_owner",
          null
        );
      insertRuntimeWorkflowDefinition(db, {
        conditions: [
          {
            operatorId: "is_not_empty",
            input: {
              fieldId: {
                path: "row.owner.fieldId"
              },
              fieldType: {
                path: "row.owner.fieldType"
              },
              value: {
                path: "row.owner.value"
              }
            }
          },
          {
            operatorId: "equals",
            input: {
              fieldId: {
                path: "row.fields.status.fieldId"
              },
              fieldType: {
                path: "row.fields.status.fieldType"
              },
              left: {
                path: "row.fields.status.value"
              },
              right: "open"
            }
          }
        ],
        metadata: {
          status: "paused"
        },
        trigger: {
          operatorId: "manual",
          match: {
            tableId: "tbl_1"
          }
        },
        workflowId: "wf_owner_matrix",
        workflowKey: "owner-matrix",
        workflowName: "Owner Matrix"
      });
      insertRuntimePermissionSnapshot(db, {
        commandTypes: ["workflow.publish"],
        fields: {
          fld_assignee: {
            agent: true,
            fieldId: "fld_assignee",
            fieldType: "principal.user",
            read: "visible",
            workflow: true,
            write: true
          },
          fld_owner: {
            agent: true,
            fieldId: "fld_owner",
            fieldType: "principal.user",
            read: "visible",
            workflow: true,
            write: true
          },
          fld_status: {
            agent: true,
            fieldId: "fld_status",
            fieldType: "status.semantic",
            read: "visible",
            workflow: true,
            write: true
          },
          fld_title: {
            agent: true,
            fieldId: "fld_title",
            fieldType: "text.single_line",
            read: "visible",
            workflow: true,
            write: true
          }
        },
        policyRevision: 44,
        principalId: "usr_owner_matrix",
        scopeHash: "scope:table:tbl_1",
        snapshotId: "snap_owner_matrix_table"
      });
      insertRuntimePermissionSnapshot(db, {
        commandTypes: ["workflow.publish"],
        fields: {},
        policyRevision: 45,
        principalId: "ops_owner_matrix",
        scopeHash: "scope:workspace",
        snapshotId: "snap_owner_matrix_workspace"
      });
      insertRuntimePermissionSnapshot(db, {
        fields: {
          fld_owner: {
            agent: true,
            fieldId: "fld_owner",
            fieldType: "principal.user",
            read: "visible",
            workflow: true,
            write: true
          },
          fld_status: {
            agent: true,
            fieldId: "fld_status",
            fieldType: "status.semantic",
            read: "visible",
            workflow: true,
            write: true
          },
          fld_title: {
            agent: true,
            fieldId: "fld_title",
            fieldType: "text.single_line",
            read: "visible",
            workflow: true,
            write: true
          }
        },
        policyRevision: 46,
        principalId: "usr_owner",
        scopeHash: "scope:view:view_owner_matrix",
        snapshotId: "snap_owner_matrix_view"
      });

      const schemaResponse = await handleFetch(
        new Request(
          "https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_owner_matrix&permissionScopeHash=scope:table:tbl_1&policyRevision=44"
        ),
        env,
        {} as ExecutionContext
      );
      const workflowResponse = await handleFetch(
        new Request(
          "https://example.test/v1/workflows/wf_owner_matrix/definition?workspaceId=ws_1&principalId=usr_owner_matrix&permissionScopeHash=scope:table:tbl_1&policyRevision=44"
        ),
        env,
        {} as ExecutionContext
      );
      const workspaceResponse = await handleFetch(
        new Request("https://example.test/v1/agent-tools/preview", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            input: {
              include: ["tables"],
              workspaceId: "ws_1"
            },
            permissionScopeHash: "scope:workspace",
            policyRevision: 45,
            principalId: "ops_owner_matrix",
            toolId: "inspectWorkspace",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );
      const viewQueryResponse = await handleFetch(
        new Request(
          "https://example.test/v1/tables/tbl_1/views/view_owner_matrix?workspaceId=ws_1&principalId=usr_owner&permissionScopeHash=scope:view:view_owner_matrix&policyRevision=46"
        ),
        env,
        {} as ExecutionContext
      );
      const viewAgentQueryResponse = await handleFetch(
        new Request("https://example.test/v1/agent-tools/preview", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            input: {
              tableId: "tbl_1",
              viewId: "view_owner_matrix"
            },
            permissionScopeHash: "scope:view:view_owner_matrix",
            policyRevision: 46,
            principalId: "usr_owner",
            toolId: "queryView",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );
      const viewDefinitionResponse = await handleFetch(
        new Request(
          "https://example.test/v1/tables/tbl_1/views/view_owner_matrix/definition?workspaceId=ws_1&principalId=usr_owner&permissionScopeHash=scope:view:view_owner_matrix&policyRevision=46"
        ),
        env,
        {} as ExecutionContext
      );
      const viewAgentDefinitionResponse = await handleFetch(
        new Request("https://example.test/v1/agent-tools/preview", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            input: {
              tableId: "tbl_1",
              viewId: "view_owner_matrix"
            },
            permissionScopeHash: "scope:view:view_owner_matrix",
            policyRevision: 46,
            principalId: "usr_owner",
            toolId: "inspectViewDefinition",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );

      const schemaBody = (await schemaResponse.json()) as {
        view: Record<string, unknown>;
        workflow: {
          bindings: Record<string, unknown>;
        };
      };
      const workflowBody = (await workflowResponse.json()) as {
        conditionMetadata: unknown[];
        workflow: {
          bindings: Record<string, unknown>;
        };
      };
      const workspaceBody = (await workspaceResponse.json()) as {
        output: {
          workspace: {
            tables: Array<Record<string, unknown>>;
          };
        };
      };
      const viewQueryBody = (await viewQueryResponse.json()) as Record<string, unknown>;
      const viewAgentQueryBody = (await viewAgentQueryResponse.json()) as {
        output: Record<string, unknown>;
      };
      const viewDefinitionBody = (await viewDefinitionResponse.json()) as Record<string, unknown>;
      const viewAgentDefinitionBody = (await viewAgentDefinitionResponse.json()) as {
        output: Record<string, unknown>;
      };

      matrix.push({
        actual: {
          schema: {
            view: schemaBody.view,
            workflowBindings: schemaBody.workflow.bindings
          },
          statuses: {
            schema: schemaResponse.status,
            viewAgentDefinition: viewAgentDefinitionResponse.status,
            viewAgentQuery: viewAgentQueryResponse.status,
            viewDefinition: viewDefinitionResponse.status,
            viewQuery: viewQueryResponse.status,
            workflow: workflowResponse.status,
            workspace: workspaceResponse.status
          },
          viewDefinition: viewDefinitionBody,
          viewDefinitionAgent: viewAgentDefinitionBody.output,
          viewQuery: viewQueryBody,
          viewQueryAgent: viewAgentQueryBody.output,
          workflowDefinition: {
            conditionMetadata: workflowBody.conditionMetadata,
            workflowBindings: workflowBody.workflow.bindings
          },
          workspaceTable:
            workspaceBody.output.workspace.tables.find((table) => table.tableId === "tbl_1") ?? null
        },
        category: "metadata_parity",
        scenario: "owner_metadata_parity_across_schema_workspace_workflow_and_views"
      });
    }

    {
      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot
      });

      matrix.push({
        actual: {
          directRead: permissionEngine.projectFields(
            permissionFields,
            "direct-record-read"
          ),
          viewRead: permissionEngine.projectFields(permissionFields, "view-query"),
          workflowRead: permissionEngine.projectFields(permissionFields, "workflow-step")
        },
        category: "permissioned_reads",
        scenario: "permission_redaction_and_hidden_reads"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_1");
      seedAppAndTable(db, {
        appId: "app_1",
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      db.inner
        .prepare(
          `INSERT INTO apps (
            id,
            workspace_id,
            slug,
            name,
            created_at,
            updated_at,
            archived_at,
            last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "app_2",
          "ws_1",
          "app-2",
          "App 2",
          "2026-06-06T00:00:00.000Z",
          "2026-06-06T00:00:00.000Z",
          null,
          null
        );
      db.inner
        .prepare(
          `INSERT INTO tables (
            id,
            workspace_id,
            app_id,
            slug,
            name,
            schema_epoch,
            current_schema_version,
            created_at,
            updated_at,
            archived_at,
            last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "tbl_2",
          "ws_1",
          "app_2",
          "table-2",
          "Table 2",
          0,
          1,
          "2026-06-06T00:00:00.000Z",
          "2026-06-06T00:00:00.000Z",
          null,
          null
        );
      insertField(db, {
        fieldId: "fld_title",
        fieldKey: "title",
        fieldType: "text.single_line",
        label: "Title",
        tableId: "tbl_1"
      });
      insertRecord(db, {
        recordId: "rec_1",
        recordKey: "record-1",
        tableId: "tbl_1"
      });
      insertRecord(db, {
        recordId: "rec_2",
        recordKey: "record-2",
        tableId: "tbl_2"
      });
      insertActivityEvent(db, {
        actor: {
          mode: "user",
          principalId: "usr_bob"
        },
        commandId: "cmd_other_app_001",
        commandType: "record.create",
        createdAt: "2026-06-06T00:01:00.000Z",
        eventId: "evt_activity_001",
        eventType: "record.created",
        payload: {
          recordId: "rec_2"
        },
        tableId: "tbl_2",
        tableSequence: 1,
        workspaceSequence: 1
      });
      insertActivityEvent(db, {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        aggregateId: "fld_title",
        aggregateType: "field",
        commandId: "cmd_field_001",
        commandType: "field.create",
        createdAt: "2026-06-06T00:02:00.000Z",
        eventId: "evt_activity_002",
        eventType: "field.created",
        tableId: "tbl_1",
        tableSequence: 1,
        workspaceSequence: 2
      });
      insertActivityEvent(db, {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_record_001",
        commandType: "record.create",
        createdAt: "2026-06-06T00:03:00.000Z",
        eventId: "evt_activity_003",
        eventType: "record.created",
        payload: {
          recordId: "rec_1"
        },
        tableId: "tbl_1",
        tableSequence: 2,
        workspaceSequence: 3
      });
      insertActivityEvent(db, {
        actor: {
          mode: "agent",
          principalId: "agt_sync"
        },
        commandId: "cmd_cell_001",
        commandType: "cell.set",
        createdAt: "2026-06-06T00:04:00.000Z",
        eventId: "evt_activity_004",
        eventType: "cell.set",
        payload: {
          fieldId: "fld_title",
          recordId: "rec_1",
          value: "Escalated by agent"
        },
        tableId: "tbl_1",
        tableSequence: 3,
        workspaceSequence: 4
      });
      insertActivityEvent(db, {
        actor: {
          mode: "workflow",
          principalId: "wf_pipeline"
        },
        aggregateId: "wf_pipeline",
        aggregateType: "workflow",
        commandId: "cmd_workflow_001",
        commandType: "workflow.publish",
        createdAt: "2026-06-06T00:05:00.000Z",
        eventId: "evt_activity_005",
        eventType: "workflow.published",
        tableId: "tbl_1",
        tableSequence: 4,
        workspaceSequence: 5
      });

      const tableFirst = await readTableActivityHistory(db as unknown as D1Database, {
        limit: 2,
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      const tableSecond = await readTableActivityHistory(db as unknown as D1Database, {
        beforeTableSequence: tableFirst.nextBeforeTableSequence,
        limit: 2,
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      const recordFirst = await readRecordActivityHistory(db as unknown as D1Database, {
        limit: 1,
        recordId: "rec_1",
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      const recordSecond = await readRecordActivityHistory(db as unknown as D1Database, {
        beforeTableSequence: recordFirst.nextBeforeTableSequence,
        limit: 2,
        recordId: "rec_1",
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      const workspaceFirst = await readWorkspaceActivityHistory(db as unknown as D1Database, {
        limit: 2,
        workspaceId: "ws_1"
      });
      const workspaceSecond = await readWorkspaceActivityHistory(db as unknown as D1Database, {
        beforeWorkspaceSequence: workspaceFirst.nextBeforeWorkspaceSequence,
        limit: 2,
        workspaceId: "ws_1"
      });
      const appFirst = await readAppActivityHistory(db as unknown as D1Database, {
        appId: "app_1",
        limit: 2,
        workspaceId: "ws_1"
      });
      const appSecond = await readAppActivityHistory(db as unknown as D1Database, {
        appId: "app_1",
        beforeWorkspaceSequence: appFirst.nextBeforeWorkspaceSequence,
        limit: 2,
        workspaceId: "ws_1"
      });

      matrix.push({
        actual: {
          app: {
            first: appFirst,
            second: appSecond
          },
          record: {
            first: recordFirst,
            second: recordSecond
          },
          table: {
            first: tableFirst,
            second: tableSecond
          },
          workspace: {
            first: workspaceFirst,
            second: workspaceSecond
          }
        },
        category: "activity_history_reads",
        scenario: "activity_history_surfaces_and_cursors"
      });
    }

    {
      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot
      });
      const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);

      matrix.push({
        actual: {
          field: viewPlanner.describeField("text.single_line"),
          planner: viewPlanner.describe()
        },
        category: "view_queries",
        scenario: "view_surface_capabilities"
      });
    }

    {
      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot
      });
      const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
      const candidateRows = [
        {
          fields: [
            {
              fieldId: "title",
              fieldType: "text.single_line",
              value: "Gamma"
            },
            {
              fieldId: "health_score",
              fieldType: "computed.readonly",
              value: "20"
            }
          ],
          recordId: "rec_003",
          recordKey: "record-3"
        },
        {
          fields: [
            {
              fieldId: "title",
              fieldType: "text.single_line",
              value: "Alpha"
            },
            {
              fieldId: "health_score",
              fieldType: "computed.readonly",
              value: "10"
            }
          ],
          recordId: "rec_001",
          recordKey: "record-1"
        },
        {
          fields: [
            {
              fieldId: "title",
              fieldType: "text.single_line",
              value: ""
            },
            {
              fieldId: "health_score",
              fieldType: "computed.readonly",
              value: "5"
            }
          ],
          recordId: "rec_002",
          recordKey: "record-2"
        }
      ];
      const visibleRows = candidateRows
        .filter((row) => viewPlanner.rowMatchesFilters(row.fields, ["title"]))
        .sort((left, right) => {
          const comparison = viewPlanner.compareRows(
            left.fields,
            right.fields,
            ["health_score"]
          );
          if (comparison !== 0) {
            return comparison;
          }

          return left.recordKey.localeCompare(right.recordKey);
        });

      matrix.push({
        actual: {
          orderedRecordIds: visibleRows.map((row) => row.recordId)
        },
        category: "view_queries",
        scenario: "view_filter_and_sort_execution"
      });
    }

    {
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_1");
      seedAppAndTable(db, {
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      insertField(db, {
        fieldId: "fld_name",
        fieldKey: "name",
        fieldType: "text.single_line",
        label: "Name",
        tableId: "tbl_1"
      });
      insertField(db, {
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic",
        label: "Status",
        tableId: "tbl_1"
      });
      db.inner
        .prepare(
          `INSERT INTO records (
            id, workspace_id, table_id, record_key, record_revision, created_at, updated_at, archived_at, last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "rec_1",
          "ws_1",
          "tbl_1",
          "record-1",
          1,
          logicalTime,
          logicalTime,
          null,
          null
        );
      db.inner
        .prepare(
          `INSERT INTO record_projection (
            workspace_id, table_id, record_id, projection_json, search_document, projection_version, last_event_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "ws_1",
          "tbl_1",
          "rec_1",
          JSON.stringify({
            fields: {
              name: "Alpha",
              status: "active"
            }
          }),
          "",
          1,
          "evt_rec_1",
          logicalTime
        );
      db.inner
        .prepare(
          `INSERT INTO views (
            id, workspace_id, table_id, view_key, name, current_schema_version, created_at, updated_at, archived_at, last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "view_grouped",
          "ws_1",
          "tbl_1",
          "grouped",
          "Grouped",
          1,
          logicalTime,
          logicalTime,
          null,
          null
        );
      db.inner
        .prepare(
          `INSERT INTO view_schema_versions (
            id, workspace_id, view_id, schema_version, schema_json, created_at, created_by_principal_id, last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "view_grouped:v1",
          "ws_1",
          "view_grouped",
          1,
          JSON.stringify({
            filterFieldIds: [],
            filters: [],
            groupByFieldId: "fld_status",
            showEmptyGroups: false,
            sortFieldIds: [],
            sorts: [],
            visibleFieldIds: ["fld_name"]
          }),
          logicalTime,
          "usr_alice",
          null
        );
      db.inner
        .prepare(
          `INSERT INTO permission_snapshots (
            id, workspace_id, principal_id, policy_revision, scope_hash, snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "psnap_grouped",
          "ws_1",
          "usr_alice",
          7,
          "scope:view:view_grouped",
          JSON.stringify({
            fields: {
              fld_name: {
                agent: true,
                fieldId: "fld_name",
                fieldType: "text.single_line",
                read: "visible",
                workflow: true,
                write: true
              },
              fld_status: {
                agent: true,
                fieldId: "fld_status",
                fieldType: "status.semantic",
                read: "visible",
                workflow: true,
                write: true
              }
            },
            policyRevision: 7,
            principalId: "usr_alice",
            schemaEpoch: 0,
            scopeHash: "scope:view:view_grouped",
            snapshotId: "psnap_grouped",
            workspaceId: "ws_1"
          }),
          logicalTime
        );

      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot: {
          fields: {
            fld_name: {
              agent: true,
              fieldId: "fld_name",
              fieldType: "text.single_line",
              read: "visible",
              workflow: true,
              write: true
            },
            fld_status: {
              agent: true,
              fieldId: "fld_status",
              fieldType: "status.semantic",
              read: "visible",
              workflow: true,
              write: true
            }
          },
          policyRevision: 7,
          principalId: "usr_alice",
          schemaEpoch: 0,
          scopeHash: "scope:view:view_grouped",
          snapshotId: "psnap_grouped",
          workspaceId: "ws_1"
        }
      });
      const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
      const view = await readViewQuery(
        db as unknown as D1Database,
        fieldTypeRegistry,
        viewPlanner,
        workflowOperatorRegistry,
        {
          permissionScopeHash: "scope:view:view_grouped",
          policyRevision: 7,
          principalId: "usr_alice",
          tableId: "tbl_1",
          viewId: "view_grouped",
          workspaceId: "ws_1"
        }
      );

      matrix.push({
        actual: {
          groupMove: view?.view.actions?.groupMove ?? null
        },
        category: "view_queries",
        scenario: "grouped_view_move_affordance"
      });
    }

    {
      const logicalTime = "2026-01-02T00:00:00.000Z";
      const db = new SqliteD1Database();
      seedWorkspace(db, "ws_1");
      seedAppAndTable(db, {
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      insertField(db, {
        fieldId: "fld_name",
        fieldKey: "name",
        fieldType: "text.single_line",
        label: "Name",
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      insertField(db, {
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic",
        label: "Status",
        tableId: "tbl_1",
        workspaceId: "ws_1"
      });
      db.inner
        .prepare(
          `INSERT INTO views (
            id, workspace_id, table_id, view_key, name, current_schema_version, created_at, updated_at, archived_at, last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "view_grouped_create",
          "ws_1",
          "tbl_1",
          "grouped-create",
          "Grouped Create",
          1,
          logicalTime,
          logicalTime,
          null,
          null
        );
      db.inner
        .prepare(
          `INSERT INTO view_schema_versions (
            id, workspace_id, view_id, schema_version, schema_json, created_at, created_by_principal_id, last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "view_grouped_create:v1",
          "ws_1",
          "view_grouped_create",
          1,
          JSON.stringify({
            filterFieldIds: [],
            filters: [],
            groupByFieldId: "fld_status",
            showEmptyGroups: false,
            sortFieldIds: [],
            sorts: [],
            visibleFieldIds: ["fld_name"]
          }),
          logicalTime,
          "usr_alice",
          null
        );
      db.inner
        .prepare(
          `INSERT INTO permission_snapshots (
            id, workspace_id, principal_id, policy_revision, scope_hash, snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "psnap_grouped_create",
          "ws_1",
          "usr_alice",
          8,
          "scope:view:view_grouped_create",
          JSON.stringify({
            fields: {
              fld_name: {
                agent: true,
                fieldId: "fld_name",
                fieldType: "text.single_line",
                read: "visible",
                workflow: true,
                write: true
              },
              fld_status: {
                agent: true,
                fieldId: "fld_status",
                fieldType: "status.semantic",
                read: "visible",
                workflow: true,
                write: true
              }
            },
            policyRevision: 8,
            principalId: "usr_alice",
            schemaEpoch: 0,
            scopeHash: "scope:view:view_grouped_create",
            snapshotId: "psnap_grouped_create",
            workspaceId: "ws_1"
          }),
          logicalTime
        );

      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot: {
          fields: {
            fld_name: {
              agent: true,
              fieldId: "fld_name",
              fieldType: "text.single_line",
              read: "visible",
              workflow: true,
              write: true
            },
            fld_status: {
              agent: true,
              fieldId: "fld_status",
              fieldType: "status.semantic",
              read: "visible",
              workflow: true,
              write: true
            }
          },
          policyRevision: 8,
          principalId: "usr_alice",
          schemaEpoch: 0,
          scopeHash: "scope:view:view_grouped_create",
          snapshotId: "psnap_grouped_create",
          workspaceId: "ws_1"
        }
      });
      const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
      const view = await readViewQuery(
        db as unknown as D1Database,
        fieldTypeRegistry,
        viewPlanner,
        workflowOperatorRegistry,
        {
          permissionScopeHash: "scope:view:view_grouped_create",
          policyRevision: 8,
          principalId: "usr_alice",
          tableId: "tbl_1",
          viewId: "view_grouped_create",
          workspaceId: "ws_1"
        }
      );

      matrix.push({
        actual: {
          createRecord: view?.view.actions?.createRecord ?? null
        },
        category: "view_queries",
        scenario: "grouped_view_create_affordance"
      });
    }

    {
      const action = requireAction("update_record");
      const seenCommands: CommandEnvelope[] = [];
      const executor: WorkflowActionExecutor = {
        async execute(command) {
          seenCommands.push(command);
          return buildAcceptedResult(command.commandId);
        }
      };

      const result = await executeWorkflowAction(
        action,
        {
          patch: {
            title: "Workflow patched title"
          },
          recordId: "rec_001"
        },
        {
          actor: {
            mode: "workflow",
            principalId: "wf_service"
          },
          commandId: "cmd_workflow_001",
          idempotencyKey: "wf-step-001",
          payload: {
            workflowRunId: "run_001",
            workflowStepId: "step_001"
          },
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          workspaceId: "ws_demo"
        },
        executor
      );

      matrix.push({
        actual: {
          result,
          seenCommands
        },
        category: "workflow_execution",
        scenario: "workflow_action_routes_through_command_envelope"
      });
    }

    {
      const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
        snapshot
      });
      const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
      const commandBus = {
        execute() {
          throw new Error("not used in regression matrix");
        },
        dryRun() {
          throw new Error("not used in regression matrix");
        },
        normalizeFieldValue() {
          throw new Error("not used in regression matrix");
        }
      } as CommandBus;
      const agentToolRegistry = createAgentToolRegistry({
        activityHistoryReader: {
          read(input) {
            if ("appId" in input) {
              return {
                appId: input.appId,
                entries: [],
                page: {
                  limit: input.limit ?? 25,
                  nextBeforeWorkspaceSequence: null
                },
                workspaceId: input.workspaceId
              };
            }

            if (!("tableId" in input)) {
              return {
                entries: [],
                page: {
                  limit: input.limit ?? 25,
                  nextBeforeWorkspaceSequence: null
                },
                workspaceId: input.workspaceId
              };
            }

            return {
              entries: [],
              page: {
                limit: 25,
                nextBeforeTableSequence: null
              },
              tableId: "tbl_matrix",
              workspaceId: "ws_matrix"
            };
          }
        },
        permissionPersonaPreviewReader: {
          read() {
            return {
              actions: {
                allowedMutatingToolIds: [],
                allowedToolIds: [],
                blockedMutatingToolIds: [],
                blockedToolIds: [],
                tools: []
              },
              fields: [],
              principalId: snapshot.principalId,
              rows: [],
              view: {
                configuredVisibleFieldIds: [],
                filters: [],
                groupByFieldId: null,
                sortFieldIds: [],
                surfaces: {
                  agentTool: {
                    hiddenFieldIds: [],
                    readOnlyFieldIds: [],
                    redactedFieldIds: [],
                    visibleFieldIds: [],
                    writableFieldIds: []
                  },
                  commandIngress: {
                    hiddenFieldIds: [],
                    readOnlyFieldIds: [],
                    redactedFieldIds: [],
                    visibleFieldIds: [],
                    writableFieldIds: []
                  },
                  viewQuery: {
                    hiddenFieldIds: [],
                    readOnlyFieldIds: [],
                    redactedFieldIds: [],
                    visibleFieldIds: [],
                    writableFieldIds: []
                  },
                  workflowStep: {
                    hiddenFieldIds: [],
                    readOnlyFieldIds: [],
                    redactedFieldIds: [],
                    visibleFieldIds: [],
                    writableFieldIds: []
                  }
                },
                viewId: "view_matrix",
                viewKey: "matrix",
                viewName: "Matrix View",
                viewQuery: {
                  allowed: true,
                  blockedFieldIds: [],
                  diagnostics: [],
                  tableId: "tbl_matrix",
                  viewId: "view_matrix",
                  viewKey: "matrix",
                  viewName: "Matrix View",
                  visibleFieldIds: []
                },
                viewSchemaVersion: 1
              },
              workspaceId: snapshot.workspaceId
            };
          }
        },
        appInspector: {
          inspect() {
            return {
              appId: "app_matrix",
              createdAt: logicalTime,
              name: "Matrix",
              slug: "matrix",
              tableCount: 1,
              tableIds: ["tbl_tasks"],
              updatedAt: logicalTime,
              workspaceId: "ws_demo"
            };
          }
        },
        workflowDefinitionInspector: {
          read() {
            return {
              currentVersion: 1,
              definition: {
                actions: [],
                conditions: [],
                trigger: {
                  match: {
                    tableId: "tbl_matrix"
                  },
                  operatorId: "manual"
                },
                workflowId: "wf_matrix"
              },
              effectiveVersion: 1,
              publishedAt: null,
              status: "draft",
              triggerTableId: "tbl_matrix",
              workflowId: "wf_matrix",
              workflowKey: "matrix",
              workflowName: "Matrix Workflow",
              workflowVersionId: "wf_matrix:v1",
              workspaceId: "ws_matrix"
            };
          }
        },
        tableSchemaInspector: {
          read() {
            return {
              appId: "app_matrix",
              fields: [
                {
                  config: {},
                  fieldId: "title",
                  fieldKey: "title",
                  fieldType: "text.single_line",
                  fieldTypeVersion: 1,
                  label: "Title"
                }
              ],
              schemaEpoch: snapshot.schemaEpoch,
              tableId: "tbl_tasks",
              tableName: "Tasks",
              tableSchemaVersion: 1,
              tableSlug: "tasks",
              workflow: {
                bindings: {
                  "row.fields.title": {
                    binding: "row.fields.title",
                    fieldId: "title",
                    fieldKey: "title",
                    fieldType: "text.single_line",
                    proposalHints: [
                      {
                        operatorId: "is_empty",
                        matchFieldPhrases: ["without {field}", "{field} missing"],
                        matchPhrases: ["missing", "empty", "blank", "not set", "unset"]
                      },
                      {
                        operatorId: "is_not_empty",
                        matchPhrases: ["present", "populated", "filled", "has value", "is set", "set"]
                      }
                    ],
                    supportedOperatorIds: ["equals", "not_equals", "is_empty", "is_not_empty"],
                    supportedOperators: [],
                    template: {
                      fieldIdPath: "row.fields.title.fieldId",
                      fieldTypePath: "row.fields.title.fieldType",
                      valuePath: "row.fields.title.value"
                    }
                  }
                }
              },
              workspaceId: "ws_demo"
            };
          }
        },
        viewDefinitionInspector: {
          read() {
            return null;
          }
        },
        commandBus,
        permissionEngine,
        recordInspector: {
          read() {
            return null;
          }
        },
        viewPlanner,
        viewQueryReader: {
          read() {
            return null;
          }
        },
        workflowHistoryReader: {
          read() {
            return {
              runs: [
                {
                  id: "wfr_matrix_001",
                  status: "dead_lettered"
                }
              ],
              workflowId: "wf_matrix"
            };
          }
        },
        workflowRunReader: {
          read() {
            return {
              id: "wfr_matrix_001",
              status: "dead_lettered",
              workflowId: "wf_matrix"
            };
          }
        },
        workflowDeadLetterReplayRequester: {
          requestReplay(input) {
            return {
              deadLetterId: input.deadLetterId,
              replayRequestId:
                input.replayRequestId ?? `dead-letter-replay:${input.deadLetterId}`,
              status: "enqueued" as const
            };
          }
        },
        workflowOperatorRegistry,
        workspaceInspector: {
          async inspect() {
            return {
              apps: [],
              catalog: {
                agentTools: [],
                fieldTypes: [],
                workflowOperators: []
              },
              tables: [],
              views: [],
              workflows: [],
              workspaceId: "ws_demo"
            };
          }
        }
      });
      const createFieldDraft = await agentToolRegistry.invoke({
        input: {
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          },
          commandId: "cmd_agent_field_001",
          fieldId: "status",
          fieldType: "single_select",
          idempotencyKey: "idem_agent_field_001",
          name: "Status",
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          workspaceId: "ws_demo"
        },
        toolId: "createField"
      });
      const updateFieldDraft = await agentToolRegistry.invoke({
        input: {
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          },
          commandId: "cmd_agent_field_update_001",
          config: {
            display: "currency",
            integerOnly: true
          },
          fieldId: "title",
          idempotencyKey: "idem_agent_field_update_001",
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          workspaceId: "ws_demo"
        },
        toolId: "updateField"
      });
      const createRecordDraft = await agentToolRegistry.invoke({
        input: {
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          },
          cells: {
            customer_note: "hidden",
            title: "Q3 Renewal"
          },
          commandId: "cmd_agent_record_001",
          idempotencyKey: "idem_agent_record_001",
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          recordId: "rec_matrix_001",
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          workspaceId: "ws_demo"
        },
        toolId: "createRecord"
      });
      const updateRecordDraft = await agentToolRegistry.invoke({
        input: {
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          },
          commandId: "cmd_agent_record_update_001",
          idempotencyKey: "idem_agent_record_update_001",
          patch: {
            customer_note: "hidden",
            title: "Q3 Renewal Updated"
          },
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          recordId: "rec_matrix_001",
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          workspaceId: "ws_demo"
        },
        toolId: "updateRecord"
      });
      const archiveRecordDraft = await agentToolRegistry.invoke({
        input: {
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          },
          commandId: "cmd_agent_record_archive_001",
          idempotencyKey: "idem_agent_record_archive_001",
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          recordId: "rec_matrix_001",
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          workspaceId: "ws_demo"
        },
        toolId: "archiveRecord"
      });
      const updateCellDraft = await agentToolRegistry.invoke({
        input: {
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          },
          commandId: "cmd_agent_cell_001",
          fieldId: "title",
          idempotencyKey: "idem_agent_cell_001",
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          recordId: "rec_matrix_001",
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          value: "Renewal Won",
          workspaceId: "ws_demo"
        },
        toolId: "updateCell"
      });
      const workflowHistory = await agentToolRegistry.invoke({
        input: {
          workflowId: "wf_matrix",
          workspaceId: "ws_demo"
        },
        toolId: "readWorkflowHistory"
      });
      const workflowRunDetail = await agentToolRegistry.invoke({
        input: {
          workflowRunId: "wfr_matrix_001",
          workspaceId: "ws_demo"
        },
        toolId: "readWorkflowRunDetail"
      });
      const workspaceActivity = await agentToolRegistry.invoke({
        input: {
          limit: 5,
          workspaceId: "ws_demo"
        },
        toolId: "readWorkspaceActivityHistory"
      });
      const appActivity = await agentToolRegistry.invoke({
        input: {
          appId: "app_matrix",
          limit: 5,
          workspaceId: "ws_demo"
        },
        toolId: "readAppActivityHistory"
      });
      const workflowProposalDraft = await agentToolRegistry.invoke({
        input: {
          actionIds: ["update_record"],
          actor: {
            mode: "agent",
            principalId: "usr_alice"
          },
          businessRule: "Notify sales ops when the title is set.",
          commandId: "cmd_agent_workflow_001",
          fieldIds: ["title"],
          idempotencyKey: "idem_agent_workflow_001",
          name: "Title set follow-up",
          permissionScopeHash: snapshot.scopeHash,
          permissionsVersion: snapshot.policyRevision,
          schemaEpoch: snapshot.schemaEpoch,
          tableId: "tbl_tasks",
          triggerId: "field_changed",
          workflowId: "wf_title_set",
          workspaceId: "ws_demo"
        },
        toolId: "proposeWorkflow"
      });

      matrix.push({
        actual: {
          accessible: agentToolRegistry.listAccessible(registryFields, snapshot),
          appActivity,
          archiveRecordDraft,
          createFieldDraft,
          createRecordDraft,
          dryRunTool: agentToolRegistry.require("dryRunCommand"),
          sanitizedInput: agentToolRegistry.sanitizeInput(
            "dryRunCommand",
            {
              fieldIds: ["title", "customer_note"],
              updates: [
                {
                  fieldId: "customer_note",
                  value: "hidden"
                },
                {
                  fieldId: "title",
                  value: "visible"
                }
              ],
              viewId: "view_open"
            },
            registryFields,
            snapshot
          ),
          sanitizedRecordPatch: agentToolRegistry.sanitizeInput(
            "updateRecord",
            {
              patch: {
                customer_note: "hidden",
                title: "Q3 Renewal Updated"
              },
              recordId: "rec_matrix_001",
              tableId: "tbl_tasks"
            },
            registryFields,
            snapshot
          ),
          sanitizedFieldUpdate: agentToolRegistry.sanitizeInput(
            "updateField",
            {
              config: {
                display: "currency",
                integerOnly: true
              },
              fieldId: "customer_note",
              tableId: "tbl_tasks"
            },
            registryFields,
            snapshot
          ),
          sanitizedOutput: agentToolRegistry.sanitizeOutput(
            "dryRunCommand",
            {
              impactedFieldIds: ["title", "customer_note"],
              records: [
                {
                  fields: {
                    customer_note: "secret",
                    title: "Q3 Renewal"
                  },
                  recordId: "rec_1"
                }
              ]
            },
            registryFields,
            snapshot
          ),
          updateFieldDraft,
          updateRecordDraft,
          updateCellDraft,
          workflowProposalDraft,
          workspaceActivity,
          workflowHistory,
          workflowRunDetail
        },
        category: "agent_tool_dry_runs",
        scenario: "agent_tool_preview_and_sanitization"
      });
    }

    {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(logicalTime));
      let randomUuidCounter = 1;
      vi.spyOn(runtimeGlobal.crypto, "randomUUID").mockImplementation(() => {
        const suffix = String(randomUuidCounter++).padStart(12, "0");
        return `00000000-0000-4000-8000-${suffix}`;
      });

      const { db, env, eventFanoutQueue, projectionQueue, workflowDispatchQueue, workflowStepQueue } =
        createRuntimeEnv();

      insertField(db, {
        fieldId: "fld_title",
        fieldKey: "title",
        fieldType: "text.single_line",
        label: "Title",
        tableId: "tbl_1"
      });
      insertField(db, {
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic",
        label: "Status",
        tableId: "tbl_1"
      });
      setRuntimeFieldPrincipalPermission(db, {
        fieldId: "fld_title",
        permission: {
          agent: true,
          read: "visible",
          workflow: true,
          write: true
        },
        principalId: "usr_member"
      });
      setRuntimeFieldPrincipalPermission(db, {
        fieldId: "fld_status",
        permission: {
          agent: true,
          read: "visible",
          workflow: true,
          write: true
        },
        principalId: "usr_member"
      });

      const accepted = await handleFetch(
        new Request("https://example.test/v1/commands/execute", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            actor: {
              mode: "user",
              principalId: "usr_member"
            },
            commandId: "cmd_execute_public_view",
            commandType: "view.create",
            idempotencyKey: "idem_execute_public_view",
            payload: {
              filterFieldIds: [],
              sortFieldIds: ["fld_status"],
              viewId: "view_execute_public",
              viewName: "Execute Public View",
              visibleFieldIds: ["fld_title", "fld_status"]
            },
            scope: "workspace",
            tableId: "tbl_1",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );
      const acceptedBody = (await accepted.json()) as Record<string, unknown>;
      const acceptedEventLedgerCount = db.inner
        .prepare(`SELECT COUNT(*) AS count FROM event_ledger WHERE command_id = ?`)
        .get("cmd_execute_public_view") as {
        count: number;
      };

      const fanoutAfterAccepted = eventFanoutQueue.sent.length;
      const projectionAfterAccepted = projectionQueue.sent.length;
      const workflowDispatchAfterAccepted = workflowDispatchQueue.sent.length;
      const workflowStepAfterAccepted = workflowStepQueue.sent.length;

      const rejected = await handleFetch(
        new Request("https://example.test/v1/commands/execute", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            actor: {
              mode: "user",
              principalId: "usr_limited"
            },
            commandId: "cmd_execute_invalid",
            commandType: "record.update",
            idempotencyKey: "idem_execute_invalid",
            payload: {
              patch: [],
              recordId: "rec_execute_invalid"
            },
            scope: "table",
            tableId: "tbl_1",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );
      const rejectedBody = (await rejected.json()) as Record<string, unknown>;
      const rejectedEventLedgerCount = db.inner
        .prepare(`SELECT COUNT(*) AS count FROM event_ledger WHERE command_id = ?`)
        .get("cmd_execute_invalid") as {
        count: number;
      };

      matrix.push({
        actual: {
          accepted: {
            body: acceptedBody,
            status: accepted.status
          },
          acceptedEventLedgerCount,
          acceptedQueues: {
            eventFanout: eventFanoutQueue.sent.slice(0, fanoutAfterAccepted),
            projection: projectionQueue.sent.slice(0, projectionAfterAccepted),
            workflowDispatch: workflowDispatchQueue.sent.slice(0, workflowDispatchAfterAccepted),
            workflowStep: workflowStepQueue.sent.slice(0, workflowStepAfterAccepted)
          },
          rejected: {
            body: rejectedBody,
            status: rejected.status
          },
          rejectedEventLedgerCount,
          rejectedQueues: {
            eventFanout: eventFanoutQueue.sent.slice(fanoutAfterAccepted),
            projection: projectionQueue.sent.slice(projectionAfterAccepted),
            workflowDispatch: workflowDispatchQueue.sent.slice(workflowDispatchAfterAccepted),
            workflowStep: workflowStepQueue.sent.slice(workflowStepAfterAccepted)
          }
        },
        category: "execution_ingress",
        scenario: "command_execute_ingress_contract"
      });
    }

    {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(logicalTime));
      let randomUuidCounter = 101;
      vi.spyOn(runtimeGlobal.crypto, "randomUUID").mockImplementation(() => {
        const suffix = String(randomUuidCounter++).padStart(12, "0");
        return `00000000-0000-4000-8000-${suffix}`;
      });

      const { db, env, eventFanoutQueue, workflowDispatchQueue } = createRuntimeEnv();

      insertField(db, {
        fieldId: "fld_title",
        fieldKey: "title",
        fieldType: "text.single_line",
        label: "Title",
        tableId: "tbl_1"
      });
      insertField(db, {
        fieldId: "fld_customer_note",
        fieldKey: "customer_note",
        fieldType: "text.long",
        label: "Customer Note",
        tableId: "tbl_1"
      });
      insertField(db, {
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "text.single_line",
        label: "Status",
        tableId: "tbl_1"
      });
      setRuntimeFieldPrincipalPermission(db, {
        fieldId: "fld_customer_note",
        permission: {
          agent: false,
          read: "hidden",
          workflow: false,
          write: false
        },
        principalId: "agt_assist"
      });
      setRuntimeFieldPrincipalPermission(db, {
        fieldId: "fld_status",
        permission: {
          agent: true,
          read: "visible",
          workflow: true,
          write: true
        },
        principalId: "agt_assist"
      });
      setRuntimeFieldPrincipalPermission(db, {
        fieldId: "fld_title",
        permission: {
          agent: true,
          read: "visible",
          workflow: true,
          write: true
        },
        principalId: "agt_assist"
      });

      const executeCommand = await handleFetch(
        new Request("https://example.test/v1/agent-tools/execute", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            input: {
              command: {
                actor: {
                  mode: "user",
                  principalId: "usr_wrong"
                },
                commandId: "cmd_execute_view",
                commandType: "view.create",
                idempotencyKey: "idem_execute_view",
                payload: {
                  filterFieldIds: ["fld_customer_note"],
                  sortFieldIds: ["fld_status"],
                  viewId: "view_public",
                  viewName: "Public Pipeline",
                  visibleFieldIds: ["fld_title", "fld_customer_note", "fld_status"]
                },
                permissionScopeHash: "scope:wrong",
                permissionsVersion: 999,
                schemaEpoch: 999,
                scope: "workspace",
                tableId: "tbl_1",
                workspaceId: "ws_other"
              }
            },
            principalId: "agt_assist",
            toolId: "executeCommand",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );
      const executeCommandBody = (await executeCommand.json()) as {
        output: {
          command: {
            commandId: string;
          };
        };
      } & Record<string, unknown>;
      const executeCommandMetadata = db.inner
        .prepare(`SELECT metadata_json FROM event_ledger WHERE command_id = ?`)
        .get(executeCommandBody.output.command.commandId) as {
        metadata_json: string;
      };

      insertRecord(db, {
        recordId: "rec_1",
        recordKey: "record-1",
        tableId: "tbl_1"
      });
      insertRuntimeWorkflow(db, {
        definition: {
          actions: [
            {
              input: {
                fieldId: "fld_status",
                fieldType: "text.single_line",
                recordId: "rec_1",
                tableId: "tbl_1",
                value: "manual"
              },
              operatorId: "set_cell"
            }
          ],
          conditions: [],
          principal: {
            policyRevision: 7,
            principalId: "wf_service",
            schemaEpoch: 0,
            scopeHash: "scope:wf:agent-execute"
          },
          trigger: {
            match: {
              tableId: "tbl_1"
            },
            operatorId: "manual"
          },
          workflowId: "wf_agent_execute"
        },
        name: "Agent Execute",
        publishedAt: "2026-06-06T00:00:00.000Z",
        workflowId: "wf_agent_execute",
        workflowKey: "agent-execute"
      });
      insertRuntimePermissionSnapshot(db, {
        snapshotId: "snap_agent_execute_manual",
        principalId: "agt_assist",
        policyRevision: 41,
        scopeHash: "scope:table:tbl_1",
        commandTypes: ["workflow.manual"],
        fields: {}
      });
      insertRuntimePermissionSnapshot(db, {
        snapshotId: "snap_agent_execute_workflow",
        principalId: "wf_service",
        policyRevision: 7,
        scopeHash: "scope:wf:agent-execute",
        commandTypes: ["cell.set"],
        fields: {
          fld_status: {
            agent: false,
            fieldId: "fld_status",
            fieldType: "text.single_line",
            read: "visible",
            workflow: true,
            write: true
          }
        }
      });

      const manualPreview = await handleFetch(
        new Request("https://example.test/v1/agent-tools/preview", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            input: {
              input: {
                trigger: "button"
              },
              manualInvocationId: "manual_agent_execute_1",
              tableId: "tbl_1",
              workflowId: "wf_agent_execute"
            },
            principalId: "agt_assist",
            toolId: "runWorkflow",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );
      const manualPreviewBody = (await manualPreview.json()) as {
        output: {
          command: CommandEnvelope;
        };
      } & Record<string, unknown>;

      const manualExecute = await handleFetch(
        new Request("https://example.test/v1/agent-tools/execute", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            input: {
              command: manualPreviewBody.output.command
            },
            principalId: "agt_assist",
            toolId: "executeCommand",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );
      const manualExecuteBody = (await manualExecute.json()) as {
        output: {
          command: {
            commandId: string;
          };
        };
      } & Record<string, unknown>;
      const manualExecuteMetadata = db.inner
        .prepare(`SELECT metadata_json FROM event_ledger WHERE command_id = ?`)
        .get(manualExecuteBody.output.command.commandId) as {
        metadata_json: string;
      };

      matrix.push({
        actual: {
          executeCommand: {
            body: executeCommandBody,
            metadata: JSON.parse(executeCommandMetadata.metadata_json),
            status: executeCommand.status
          },
          manualWrapper: {
            execute: {
              body: manualExecuteBody,
              metadata: JSON.parse(manualExecuteMetadata.metadata_json),
              status: manualExecute.status
            },
            preview: {
              body: manualPreviewBody,
              status: manualPreview.status
            }
          },
          queues: {
            eventFanout: eventFanoutQueue.sent,
            workflowDispatch: workflowDispatchQueue.sent
          }
        },
        category: "agent_tool_execution",
        scenario: "agent_tool_execute_and_manual_wrapper"
      });
    }

    {
      const { commandBus, eventLedger } = createHarness({
        snapshot: {
          ...snapshot,
          commandTypes: ["record.update"]
        }
      });

      const tableCommand: CommandEnvelope = {
        actor: {
          mode: "user",
          principalId: "usr_alice"
        },
        commandId: "cmd_scope_table_001",
        commandType: "records.upsert",
        idempotencyKey: "idem_shared_001",
        payload: {
          patch: {
            title: "From direct user write"
          }
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "table",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };
      const workflowCommand: CommandEnvelope = {
        actor: {
          mode: "workflow",
          principalId: "usr_alice"
        },
        commandId: "cmd_scope_workflow_001",
        commandType: "records.upsert",
        idempotencyKey: "idem_shared_001",
        payload: {
          patch: {
            title: "From workflow write"
          }
        },
        permissionScopeHash: snapshot.scopeHash,
        permissionsVersion: snapshot.policyRevision,
        schemaEpoch: snapshot.schemaEpoch,
        scope: "workflow",
        tableId: "tbl_tasks",
        workspaceId: "ws_demo"
      };

      const tableResult = await commandBus.execute(tableCommand);
      const workflowResult = await commandBus.execute(workflowCommand);

      matrix.push({
        actual: {
          receiptsByScope: {
            table: eventLedger.snapshotReceipts(scopeKeyForCommand(tableCommand)),
            workflow: eventLedger.snapshotReceipts(scopeKeyForCommand(workflowCommand))
          },
          table: tableResult,
          workflow: workflowResult
        },
        category: "unsupported_command_rejection",
        scenario: "unsupported_commands_reject_without_receipts"
      });
    }

    expect(toCanonicalJson(matrix)).toMatchSnapshot();
  });

  it("scenario: workflow_scheduled_dispatch_payload_determinism keeps scheduled dispatch payloads byte-stable for the same scheduler tick", async () => {
    const db = new SqliteD1Database();
    seedWorkspace(db, "ws_demo");
    seedAppAndTable(db, {
      workspaceId: "ws_demo",
      tableId: "tbl_demo"
    });
    insertScheduledWorkflowDefinition(db, {
      cadenceMinutes: 5,
      workflowId: "wf_schedule_matrix"
    });

    const sent: CloudTableQueueMessage[] = [];
    const env = {
      DB: db as unknown as D1Database,
      WORKFLOW_DISPATCH_QUEUE: {
        async send(message: CloudTableQueueMessage) {
          sent.push(message);
        }
      }
    } as unknown as CloudTableEnv;

    const controller = {
      cron: "* * * * *",
      noRetry() {},
      scheduledTime: Date.parse("2026-06-06T00:10:00.000Z")
    } as ScheduledController;

    await handleScheduled(controller, env, {} as ExecutionContext);
    await handleScheduled(controller, env, {} as ExecutionContext);

    expect(toCanonicalJson(sent)).toBe(
      toCanonicalJson([
        {
          kind: "workflow-dispatch",
          payload: {
            cadenceMinutes: 5,
            scheduleWindowEnd: "2026-06-06T00:10:00.000Z",
            scheduleWindowStart: "2026-06-06T00:05:00.000Z",
            scheduledAt: "2026-06-06T00:10:00.000Z",
            triggerKind: "scheduled",
            workflowId: "wf_schedule_matrix",
            workflowVersionId: "wf_schedule_matrix:v1"
          },
          workspaceId: "ws_demo"
        },
        {
          kind: "workflow-dispatch",
          payload: {
            cadenceMinutes: 5,
            scheduleWindowEnd: "2026-06-06T00:10:00.000Z",
            scheduleWindowStart: "2026-06-06T00:05:00.000Z",
            scheduledAt: "2026-06-06T00:10:00.000Z",
            triggerKind: "scheduled",
            workflowId: "wf_schedule_matrix",
            workflowVersionId: "wf_schedule_matrix:v1"
          },
          workspaceId: "ws_demo"
        }
      ])
    );
  });

  it("scenario: workflow_webhook_retry_backoff_recovery keeps retry state bounded and duplicate replays idempotent", async () => {
    const {
      db,
      env,
      eventFanoutQueue,
      workflowDispatchQueue,
      workflowStepQueue
    } = createRuntimeEnv();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T00:00:00.000Z"));

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("upstream unavailable", {
          status: 503
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204
        })
      );

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertRuntimeRecordProjection(db);
    insertRuntimePermissionSnapshot(db, {
      commandTypes: ["workflow.webhook.enqueue"]
    });
    insertRuntimeWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "send_webhook",
          input: {
            body: {
              event: "record.updated"
            },
            destination: "https://example.test/hooks/cloudtable"
          }
        }
      ]
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRuntimeRouteBody({
            commandId: "cmd_trigger_webhook_retry_1",
            idempotencyKey: "idem_trigger_webhook_retry_1",
            payload: {
              fieldType: "text.single_line",
              value: "crm"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    await handleQueueBatch(
      createRuntimeBatch([eventFanoutQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );
    await handleQueueBatch(
      createRuntimeBatch([workflowDispatchQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );
    await handleQueueBatch(
      createRuntimeBatch([workflowStepQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const retryingRun = await db
      .prepare(`SELECT status, state_json FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ state_json: string; status: string }>();
    const retryingStep = await db
      .prepare(
        `SELECT status, last_error_code, audit_json
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ audit_json: string; last_error_code: string | null; status: string }>();

    expect(retryingRun?.status).toBe("waiting_retry");
    expect(retryingStep).toMatchObject({
      last_error_code: "workflow_webhook_http_503",
      status: "retryable_failed"
    });
    expect(workflowStepQueue.sends[1]?.options?.delaySeconds).toBe(30);

    const retryMessage = workflowStepQueue.sent[1]!;
    expect(retryMessage.retry).toMatchObject({
      attempt: 2,
      delaySeconds: 30,
      maxAttempts: 8,
      retryClass: "network"
    });

    const runState = JSON.parse(retryingRun?.state_json ?? "{}") as {
      retry?: { nextAttemptAt?: string };
    };
    const stepAudit = JSON.parse(retryingStep?.audit_json ?? "{}") as {
      retry?: { nextAttemptAt?: string };
    };
    expect(runState.retry?.nextAttemptAt).toBe(retryMessage.retry?.nextAttemptAt);
    expect(stepAudit.retry?.nextAttemptAt).toBe(retryMessage.retry?.nextAttemptAt);

    vi.setSystemTime(new Date(retryMessage.retry!.nextAttemptAt));
    await handleQueueBatch(createRuntimeBatch([retryMessage]).batch as never, env, {} as ExecutionContext);

    const completedRun = await db
      .prepare(`SELECT status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ status: string }>();
    expect(completedRun?.status).toBe("completed");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await handleQueueBatch(createRuntimeBatch([retryMessage]).batch as never, env, {} as ExecutionContext);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("scenario: workflow_dead_letter_replay_eligibility only replays eligible dead letters once", async () => {
    const { db, deadLetterQueue, env } = createRuntimeEnv();

    insertRuntimeWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_replay"
      },
      name: "Replay",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_replay",
      workflowKey: "replay"
    });
    insertRuntimePermissionSnapshot(db, {
      snapshotId: "snap_workflow_replay_operator",
      principalId: "ops_2",
      policyRevision: 23,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.pause"],
      fields: {}
    });
    insertRuntimeWorkflowRun(db, {
      deadLetteredAt: "2026-06-06T00:12:00.000Z",
      status: "dead_lettered",
      workflowId: "wf_replay",
      workflowRunId: "wfr_replay_1"
    });
    insertRuntimeWorkflowRunStep(db, {
      lastErrorCode: "record_not_found:rec_missing",
      status: "dead_lettered",
      stepId: "wfr_replay_1:step:0",
      workflowRunId: "wfr_replay_1"
    });
    insertRuntimeWorkflowDeadLetter(db, {
      workflowRunId: "wfr_replay_1",
      workflowStepId: "wfr_replay_1:step:0"
    });
    insertRuntimeWorkflowRun(db, {
      status: "completed",
      workflowId: "wf_replay",
      workflowRunId: "wfr_replay_2"
    });
    insertRuntimeWorkflowRunStep(db, {
      status: "completed",
      stepId: "wfr_replay_2:step:0",
      workflowRunId: "wfr_replay_2"
    });
    insertRuntimeWorkflowDeadLetter(db, {
      workflowRunId: "wfr_replay_2",
      workflowStepId: "wfr_replay_2:step:0"
    });
    insertRuntimeWorkflowRun(db, {
      deadLetteredAt: "2026-06-06T00:15:00.000Z",
      status: "dead_lettered",
      workflowId: "wf_replay",
      workflowRunId: "wfr_replay_3"
    });
    insertRuntimeWorkflowRunStep(db, {
      lastErrorCode: "record_not_found:rec_missing",
      status: "dead_lettered",
      stepId: "wfr_replay_3:step:0",
      workflowRunId: "wfr_replay_3"
    });
    insertRuntimeWorkflowDeadLetter(db, {
      workflowRunId: "wfr_replay_3",
      workflowStepId: "wfr_replay_3:step:0"
    });
    insertRuntimePermissionSnapshot(db, {
      snapshotId: "snap_workflow_replay_denied",
      principalId: "ops_denied",
      policyRevision: 24,
      scopeHash: "scope:table:tbl_1",
      commandTypes: [],
      fields: {}
    });

    const firstReplay = await handleFetch(
      new Request("https://example.test/v1/workflow-dead-letters/wdl:wfr_replay_1:step:0/replay", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          principalId: "ops_2",
          workspaceId: "ws_1",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 23,
          replayRequestId: "replay-1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(firstReplay.status).toBe(202);
    expect(deadLetterQueue.sent).toHaveLength(1);

    const secondReplay = await handleFetch(
      new Request("https://example.test/v1/workflow-dead-letters/wdl:wfr_replay_1:step:0/replay", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          principalId: "ops_2",
          workspaceId: "ws_1",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 23,
          replayRequestId: "replay-1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(secondReplay.status).toBe(409);
    expect(deadLetterQueue.sent).toHaveLength(1);

    const ineligibleReplay = await handleFetch(
      new Request("https://example.test/v1/workflow-dead-letters/wdl:wfr_replay_2:step:0/replay", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          principalId: "ops_2",
          workspaceId: "ws_1",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 23,
          replayRequestId: "replay-2"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(ineligibleReplay.status).toBe(400);
    expect(deadLetterQueue.sent).toHaveLength(1);

    const toolRunDetail = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowRunId: "wfr_replay_3"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 23,
          principalId: "ops_2",
          toolId: "readWorkflowRunDetail",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolRunDetail.status).toBe(200);
    const toolRunDetailBody = (await toolRunDetail.json()) as {
      output: {
        kind: string;
        run: {
          steps: Array<{
            deadLetter: {
              id: string;
            } | null;
          }>;
        };
      };
    };
    expect(toolRunDetailBody.output).toMatchObject({
      kind: "workflow-run-detail",
      run: {
        steps: [
          {
            deadLetter: {
              id: "wdl:wfr_replay_3:step:0"
            }
          }
        ]
      }
    });

    const toolPreview = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_3:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 23,
          principalId: "ops_2",
          toolId: "prepareWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolPreview.status).toBe(200);

    const toolExecute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_3:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 23,
          principalId: "ops_2",
          toolId: "requestWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolExecute.status).toBe(200);
    expect(deadLetterQueue.sent).toHaveLength(2);

    const toolDuplicate = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_3:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 23,
          principalId: "ops_2",
          toolId: "requestWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolDuplicate.status).toBe(409);
    expect(deadLetterQueue.sent).toHaveLength(2);

    const toolIneligible = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_2:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 23,
          principalId: "ops_2",
          toolId: "requestWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolIneligible.status).toBe(400);

    const toolUnauthorized = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_3:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 24,
          principalId: "ops_denied",
          toolId: "requestWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolUnauthorized.status).toBe(403);
  });

  it("keeps direct permission explanation ingress aligned with the explainPermissions tool", async () => {
    const { db, env } = createRuntimeEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_secret_note",
      fieldKey: "secret_note",
      fieldType: "text.long",
      label: "Secret Note",
      tableId: "tbl_1"
    });
    db.inner
      .prepare(
        `INSERT INTO views (
          id, workspace_id, table_id, view_key, name, current_schema_version, created_at, updated_at, archived_at, last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "view_private",
        "ws_1",
        "tbl_1",
        "private",
        "Private Queue",
        1,
        logicalTime,
        logicalTime,
        null,
        null
      );
    db.inner
      .prepare(
        `INSERT INTO view_schema_versions (
          id, workspace_id, view_id, schema_version, schema_json, created_at, created_by_principal_id, last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "view_private:v1",
        "ws_1",
        "view_private",
        1,
        JSON.stringify({
          filterFieldIds: [],
          filters: [],
          groupByFieldId: null,
          showEmptyGroups: false,
          sortFieldIds: [],
          sorts: [],
          visibleFieldIds: ["fld_title"]
        }),
        logicalTime,
        "agt_reviewer",
        null
      );
    insertRuntimePermissionSnapshot(db, {
      fields: {
        fld_secret_note: {
          agent: false,
          fieldId: "fld_secret_note",
          fieldType: "text.long",
          read: "hidden",
          workflow: false,
          write: false
        },
        fld_title: {
          agent: true,
          fieldId: "fld_title",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      },
      policyRevision: 14,
      principalId: "agt_reviewer",
      scopeHash: "scope:view:view_private",
      snapshotId: "snap_view_private_1"
    });

    const directResponse = await handleFetch(
      new Request("https://example.test/v1/permissions/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          fieldId: "fld_secret_note",
          permissionScopeHash: "scope:view:view_private",
          policyRevision: 14,
          principalId: "agt_reviewer",
          surfaces: ["view-query", "agent-tool"],
          tableId: "tbl_1",
          viewId: "view_private",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(directResponse.status).toBe(200);

    const toolResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            fieldId: "fld_secret_note",
            surfaces: ["view-query", "agent-tool"],
            tableId: "tbl_1",
            viewId: "view_private"
          },
          permissionScopeHash: "scope:view:view_private",
          policyRevision: 14,
          principalId: "agt_reviewer",
          toolId: "explainPermissions",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as {
      explanation: Record<string, unknown>;
      permissionScope: Record<string, unknown>;
    };
    const toolBody = (await toolResponse.json()) as {
      output: {
        explanation: Record<string, unknown>;
      };
      permissionScope: Record<string, unknown>;
    };

    expect(directBody).toEqual({
      explanation: toolBody.output.explanation,
      permissionScope: toolBody.permissionScope
    });
  });

  it("keeps direct permission persona preview ingress aligned with the previewPermissionPersona tool", async () => {
    const { db, env } = createRuntimeEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_salary",
      fieldKey: "salary",
      fieldType: "number.decimal",
      label: "Salary",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_customer_note",
      fieldKey: "customer_note",
      fieldType: "text.long",
      label: "Customer Note",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_internal_note",
      fieldKey: "internal_note",
      fieldType: "text.long",
      label: "Internal Note",
      tableId: "tbl_1"
    });
    insertRecord(db, {
      recordId: "rec_001",
      recordKey: "acme",
      tableId: "tbl_1"
    });
    db.inner
      .prepare(
        `INSERT INTO record_projection (
           workspace_id,
           table_id,
           record_id,
           projection_json,
           search_document,
           projection_version,
           last_event_id,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "ws_1",
        "tbl_1",
        "rec_001",
        JSON.stringify({
          fields: {
            customer_note: "vip",
            internal_note: "audit only",
            salary: 125000,
            title: "Acme"
          }
        }),
        "",
        1,
        "evt_seed_record_projection_private_queue",
        logicalTime
      );
    db.inner
      .prepare(
        `INSERT INTO views (
          id, workspace_id, table_id, view_key, name, current_schema_version, created_at, updated_at, archived_at, last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "view_private",
        "ws_1",
        "tbl_1",
        "private",
        "Private Queue",
        1,
        logicalTime,
        logicalTime,
        null,
        null
      );
    db.inner
      .prepare(
        `INSERT INTO view_schema_versions (
          id, workspace_id, view_id, schema_version, schema_json, created_at, created_by_principal_id, last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "view_private:v1",
        "ws_1",
        "view_private",
        1,
        JSON.stringify({
          filterFieldIds: ["fld_customer_note"],
          filters: [
            {
              fieldId: "fld_customer_note",
              operatorId: "equals",
              value: "vip"
            }
          ],
          groupByFieldId: null,
          showEmptyGroups: false,
          sortFieldIds: [],
          sorts: [],
          visibleFieldIds: ["fld_title", "fld_salary", "fld_customer_note"]
        }),
        logicalTime,
        "agt_reviewer",
        null
      );
    insertRuntimePermissionSnapshot(db, {
      fields: {
        fld_customer_note: {
          agent: false,
          fieldId: "fld_customer_note",
          fieldType: "text.long",
          read: "hidden",
          workflow: false,
          write: false
        },
        fld_internal_note: {
          agent: true,
          fieldId: "fld_internal_note",
          fieldType: "text.long",
          read: "visible",
          workflow: true,
          write: false
        },
        fld_salary: {
          agent: true,
          fieldId: "fld_salary",
          fieldType: "number.decimal",
          read: "redacted",
          workflow: true,
          write: false
        },
        fld_title: {
          agent: true,
          fieldId: "fld_title",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      },
      policyRevision: 22,
      principalId: "agt_reviewer",
      scopeHash: "scope:view:view_private",
      snapshotId: "snap_view_private_1"
    });

    const directResponse = await handleFetch(
      new Request("https://example.test/v1/permissions/persona-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          permissionScopeHash: "scope:view:view_private",
          policyRevision: 22,
          principalId: "agt_reviewer",
          tableId: "tbl_1",
          viewId: "view_private",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(directResponse.status).toBe(200);

    const toolResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1",
            viewId: "view_private"
          },
          permissionScopeHash: "scope:view:view_private",
          policyRevision: 22,
          principalId: "agt_reviewer",
          toolId: "previewPermissionPersona",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as {
      permissionScope: Record<string, unknown>;
      preview: Record<string, unknown> | null;
    };
    const toolBody = (await toolResponse.json()) as {
      output: {
        preview: Record<string, unknown> | null;
      };
      permissionScope: Record<string, unknown>;
    };

    expect(directBody).toEqual({
      permissionScope: toolBody.permissionScope,
      preview: toolBody.output.preview
    });
  });

  it("scenario: outbox_publish_failure_scheduled_drain preserves accepted writes until the scheduler drains the outbox", async () => {
    const { db, env, eventFanoutQueue } = createRuntimeEnv();
    eventFanoutQueue.failNext();

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(createRuntimeCommand())
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      result: { accepted: boolean; events: Array<{ eventId: string }> };
    };
    expect(body.result.accepted).toBe(true);
    expect(eventFanoutQueue.sent).toEqual([]);

    const failedOutbox = db.inner
      .prepare(
        `SELECT available_at, delivered_at, delivery_attempts
         FROM queue_outbox
         WHERE event_id = ?`
      )
      .get(body.result.events[0]!.eventId) as {
      available_at: string;
      delivered_at: string | null;
      delivery_attempts: number;
    };
    expect(failedOutbox.delivered_at).toBeNull();
    expect(failedOutbox.delivery_attempts).toBe(1);

    await handleScheduled(
      createRuntimeScheduledController(Date.parse(failedOutbox.available_at) + 1_000),
      env,
      {} as ExecutionContext
    );

    expect(eventFanoutQueue.sent).toHaveLength(1);
    expect(eventFanoutQueue.sent[0]).toMatchObject({
      eventId: body.result.events[0]!.eventId,
      kind: "event-fanout",
      workspaceId: "ws_1"
    });

    const drainedOutbox = db.inner
      .prepare(
        `SELECT delivered_at, delivery_attempts
         FROM queue_outbox
         WHERE event_id = ?`
      )
      .get(body.result.events[0]!.eventId) as {
      delivered_at: string | null;
      delivery_attempts: number;
    };
    expect(drainedOutbox.delivery_attempts).toBe(2);
    expect(drainedOutbox.delivered_at).not.toBeNull();
  });
});
